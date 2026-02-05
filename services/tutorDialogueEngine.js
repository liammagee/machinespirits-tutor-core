/**
 * Tutor Dialogue Engine
 *
 * Implements the Drama Machine multiagent architecture for modulating
 * AI tutor suggestions through internal Ego/Superego dialogue.
 *
 * Based on: "The Drama Machine: Simulating Character Development with LLM Agents"
 * (Chen et al., 2024)
 *
 * Architecture:
 * - Ego: External-facing tutor that generates suggestions
 * - Superego: Internal critic that reviews/modulates suggestions
 * - Internal Dialogue: Iterative refinement before output reaches learner
 *
 * Configuration:
 * - Settings loaded from config/tutor-agents.yaml
 * - Supports multiple profiles for A/B testing
 * - Environment variable overrides supported
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as configLoader from './tutorConfigLoader.js';
import * as monitoringService from './monitoringService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT_DIR, 'logs', 'tutor-dialogues');
const API_LOGS_DIR = path.join(ROOT_DIR, 'logs', 'tutor-api');
const DEBUG_LOGS_DIR = path.join(ROOT_DIR, 'logs', 'tutor-debug');

// JSDoc type definitions for dialogue system
/**
 * @typedef {'user' | 'ego' | 'superego'} AgentRole
 * @typedef {'input' | 'request' | 'response'} DialogueDirection
 */

/**
 * @typedef {Object} DialogueEntry
 * @property {AgentRole} agent - The agent performing the action
 * @property {string} action - The action being performed
 * @property {AgentRole} [from] - Source agent in the flow
 * @property {AgentRole} [to] - Target agent in the flow
 * @property {DialogueDirection} [direction] - Direction of the message
 * @property {number} [latencyMs] - Response latency
 * @property {string} [provider] - AI provider
 * @property {string} [model] - AI model
 * @property {Array} [suggestions] - Generated suggestions
 * @property {Object} [verdict] - Superego verdict
 * @property {Object} [preAnalysis] - Pre-analysis data
 * @property {Object} [metrics] - Token/cost metrics
 * @property {string} [rawContext] - Raw learner context
 * @property {Object} [contextData] - Parsed context data
 * @property {*} [output] - Entry output
 */

/**
 * Get the target agent for a given source agent based on mode
 * @param {AgentRole} fromAgent - Source agent
 * @param {boolean} hasSuperego - Whether superego is enabled
 * @returns {AgentRole} Target agent
 */
function getAgentTarget(fromAgent, hasSuperego) {
  if (fromAgent === 'ego') {
    return hasSuperego ? 'superego' : 'user';
  }
  if (fromAgent === 'superego') {
    return 'user';
  }
  if (fromAgent === 'user') {
    return 'ego';
  }
  return 'user'; // fallback
}

/**
 * Strip bulky fields from metrics before storing in dialogue trace.
 * Keeps token counts, latency, cost, model info — drops the raw LLM
 * response text and verbose generationDetails to avoid 3x duplication.
 */
function trimMetricsForTrace(metrics) {
  if (!metrics) return null;
  const { text, generationDetails, ...trimmed } = metrics;
  return trimmed;
}

/**
 * Extract just the structured context summary from the full learner context.
 * Returns the <structured_context_summary> block plus the warning header and
 * any learner chat messages — the minimal context needed for superego review
 * and ego revision rounds.
 *
 * Returns null if no structured summary is found (caller should fall back
 * to full context).
 */
function extractStructuredSummary(learnerContext) {
  if (!learnerContext || typeof learnerContext !== 'string') return null;

  const summaryMatch = learnerContext.match(
    /(⚠️[^\n]*\n)?<structured_context_summary>[\s\S]*?<\/structured_context_summary>\n?[^\n]*/
  );
  if (!summaryMatch) return null;

  const parts = [summaryMatch[0]];

  // Preserve learner chat messages — needed for tone/emotional calibration
  const chatSection = learnerContext.match(/### Recent Chat History\n([\s\S]*?)(?=\n###|\n$|$)/);
  if (chatSection) {
    parts.push('\n### Recent Chat History');
    parts.push(chatSection[1].trim());
  }

  // Preserve conversation history if present (multi-turn)
  const convSection = learnerContext.match(/### Conversation History\n([\s\S]*?)(?=\n###|\n$|$)/);
  if (convSection) {
    parts.push('\n### Conversation History');
    parts.push(convSection[1].trim());
  }

  // Preserve learner action if present
  const actionSection = learnerContext.match(/### Learner Action\n([\s\S]*?)(?=\n###|\n$|$)/);
  if (actionSection) {
    parts.push('\n### Learner Action');
    parts.push(actionSection[1].trim());
  }

  // Preserve learner response if present
  const responseSection = learnerContext.match(/### Learner Response\n([\s\S]*?)(?=\n###|\n$|$)/);
  if (responseSection) {
    parts.push('\n### Learner Response');
    parts.push(responseSection[1].trim());
  }

  return parts.join('\n');
}

// Current dialogue ID for logging context
let currentDialogueId = null;

// Current profile name for logging flow direction
let currentProfileName = null;

/**
 * Set the current dialogue ID for log correlation
 */
export function setCurrentDialogueId(id) {
  currentDialogueId = id;
}

/**
 * Get the current dialogue ID
 */
export function getCurrentDialogueId() {
  return currentDialogueId;
}

/**
 * Set the current profile name for flow direction logging
 */
export function setCurrentProfileName(name) {
  currentProfileName = name;
}

/**
 * Get the current profile name
 */
export function getCurrentProfileName() {
  return currentProfileName;
}

/**
 * Check if debug logging is enabled
 */
function isDebugMode() {
  return process.env.TUTOR_DEBUG === 'true' ||
         process.env.TUTOR_DEBUG_LOGS === 'true';
}

/**
 * Write a debug log entry with full message content
 */
function writeDebugLog(dialogueId, entry) {
  if (!isDebugMode()) return;

  try {
    if (!fs.existsSync(DEBUG_LOGS_DIR)) {
      fs.mkdirSync(DEBUG_LOGS_DIR, { recursive: true });
    }

    // Write to dialogue-specific file for easy retrieval
    const logFile = path.join(DEBUG_LOGS_DIR, `${dialogueId}.json`);

    let logs = [];
    if (fs.existsSync(logFile)) {
      logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    }

    logs.push({
      timestamp: new Date().toISOString(),
      ...entry
    });

    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
  } catch (e) {
    console.warn('Failed to write debug log:', e.message);
  }
}

// Ensure logs directories exist
try {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  if (!fs.existsSync(API_LOGS_DIR)) {
    fs.mkdirSync(API_LOGS_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('Could not create logs directory:', e.message);
}

// ============================================================================
// TRANSCRIPT MODE - Simple numbered message flow
// ============================================================================
// Enable with TUTOR_TRANSCRIPT=true or --transcript CLI flag
// Shows: [1] LEARNER → [2] EGO → [3] SUPEREGO → [4] EGO REVISED etc.
//
// Additional options:
// - TUTOR_EXPAND=true or --expand: Show full prompt/response for each message
// - Metrics (tokens, latency) shown when available

let transcriptStep = 0;

function isTranscriptMode() {
  return process.env.TUTOR_TRANSCRIPT === 'true';
}

function isExpandMode() {
  return process.env.TUTOR_EXPAND === 'true';
}

function resetTranscript() {
  transcriptStep = 0;
}

/**
 * Parse learner context string to extract key info for display
 */
function parseContextSummary(contextStr) {
  if (!contextStr || typeof contextStr !== 'string') return null;

  const summary = {};

  // Extract current page/content
  const pageMatch = contextStr.match(/Currently viewing[:\s]*([^\n]+)/i);
  if (pageMatch) summary.currentPage = pageMatch[1].trim();

  // Extract session info
  const sessionMatch = contextStr.match(/(\d+)\s*sessions?/i);
  if (sessionMatch) summary.sessions = parseInt(sessionMatch[1]);

  // Extract struggle signals
  const struggleMatch = contextStr.match(/Struggle signals[:\s]*(\d+)/i);
  if (struggleMatch) summary.strugglesCount = parseInt(struggleMatch[1]);

  // Extract activities completed
  const activitiesMatch = contextStr.match(/Activities completed[:\s]*(\d+)/i);
  if (activitiesMatch) summary.activitiesCompleted = parseInt(activitiesMatch[1]);

  // Check if new user
  if (contextStr.match(/new user|first visit/i)) {
    summary.isNewUser = true;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

/**
 * Display a transcript entry with optional metrics and expandable detail
 * @param {string} role - The role (LEARNER CONTEXT, EGO, SUPEREGO, etc.)
 * @param {*} content - The content to display
 * @param {object} options - Display options
 * @param {object} options.metrics - Token/latency metrics {inputTokens, outputTokens, latencyMs, model}
 * @param {string} options.prompt - Full prompt text (shown in expand mode)
 * @param {string} options.response - Full response text (shown in expand mode)
 * @param {object} options.context - Learner context summary {currentPage, sessionTime, etc.}
 * @param {boolean} options.full - Show full content without truncation
 */
function transcript(role, content, options = {}) {
  if (!isTranscriptMode()) return;

  transcriptStep++;
  const roleColors = {
    'LEARNER CONTEXT': '\x1b[32m',  // green
    'LEARNER ACTION': '\x1b[35m',    // magenta - learner's response/action
    'LEARNER MESSAGE': '\x1b[35m',   // magenta - learner's chat message
    'EGO': '\x1b[36m',               // cyan
    'EGO INITIAL': '\x1b[36m',       // cyan
    'EGO REVISED': '\x1b[36m',       // cyan
    'SUPEREGO': '\x1b[33m',          // yellow
    'SUPEREGO PRE-ANALYSIS': '\x1b[33m',
    'SUPEREGO REVIEW': '\x1b[33m',
  };
  const color = roleColors[role] || '\x1b[37m';
  const reset = '\x1b[0m';
  const dim = '\x1b[2m';
  const bold = '\x1b[1m';
  const { metrics, prompt, response, context } = options;

  // Build header with metrics
  let header = `\n${bold}[${transcriptStep}] ${color}${role}${reset}`;
  if (metrics) {
    const parts = [];
    if (metrics.model) {
      const shortModel = metrics.model.split('/').pop();
      parts.push(shortModel);
    }
    if (metrics.inputTokens !== undefined || metrics.outputTokens !== undefined) {
      parts.push(`${metrics.inputTokens || 0}→${metrics.outputTokens || 0} tok`);
    }
    if (metrics.latencyMs) {
      parts.push(`${(metrics.latencyMs / 1000).toFixed(1)}s`);
    }
    if (parts.length > 0) {
      header += ` ${dim}[${parts.join(' | ')}]${reset}`;
    }
  }
  console.log(header);

  // Show context summary if provided
  if (context) {
    let contextLine = `${dim}`;
    const contextParts = [];
    if (context.currentPage) contextParts.push(`📄 ${context.currentPage}`);
    if (context.sessionTime) contextParts.push(`⏱ ${context.sessionTime}`);
    if (context.strugglesCount) contextParts.push(`⚠️ ${context.strugglesCount} struggles`);
    if (context.activitiesCompleted !== undefined) contextParts.push(`✅ ${context.activitiesCompleted} completed`);
    if (contextParts.length > 0) {
      console.log(`${dim}${contextParts.join(' | ')}${reset}`);
    }
  }

  console.log(`${dim}${'─'.repeat(60)}${reset}`);

  // Format content based on type
  if (typeof content === 'string') {
    // Truncate long strings
    const lines = content.split('\n');
    if (lines.length > 30 && !options.full) {
      console.log(lines.slice(0, 15).join('\n'));
      console.log(`${dim}... (${lines.length - 30} lines omitted) ...${reset}`);
      console.log(lines.slice(-15).join('\n'));
    } else {
      console.log(content);
    }
  } else if (Array.isArray(content)) {
    // Suggestions array - show full content
    content.forEach((s, i) => {
      const typeLabel = s.type ? `[${s.type}] ` : '';
      const priorityLabel = s.priority ? `(${s.priority}) ` : '';
      console.log(`${bold}Suggestion ${i + 1}:${reset} ${typeLabel}${priorityLabel}${s.title || 'Untitled'}`);
      if (s.message) {
        // Show full message, wrapped for readability
        console.log(`  ${s.message}`);
      }
      if (s.actionTarget) console.log(`  ${dim}→ ${s.actionTarget}${reset}`);
      if (s.reasoning) console.log(`  ${dim}Reasoning: ${s.reasoning}${reset}`);
    });
  } else if (content && typeof content === 'object') {
    // Feedback or review object
    if (content.approved !== undefined) {
      console.log(`${bold}Approved:${reset} ${content.approved ? '\x1b[32m✓ Yes\x1b[0m' : '\x1b[31m✗ No\x1b[0m'}`);
    }
    if (content.interventionType) {
      console.log(`${bold}Intervention:${reset} ${content.interventionType}`);
    }
    if (content.confidence !== undefined) {
      const confPct = Math.round(content.confidence * 100);
      console.log(`${bold}Confidence:${reset} ${confPct}%`);
    }
    if (content.feedback) {
      console.log(`${bold}Feedback:${reset}`);
      if (Array.isArray(content.feedback)) {
        content.feedback.forEach(f => {
          console.log(`  • ${f.issue || f}`);
          if (f.suggestion) console.log(`    ${dim}→ ${f.suggestion}${reset}`);
        });
      } else {
        // Show full feedback without truncation
        console.log(`  ${content.feedback}`);
      }
    }
    if (content.suggestedChanges?.revisions) {
      console.log(`${bold}Suggested Revisions:${reset}`);
      content.suggestedChanges.revisions.forEach(r => {
        console.log(`  • ${r}`);
      });
    }
    if (content.pedagogicalNote) {
      console.log(`${bold}Pedagogical Note:${reset} ${content.pedagogicalNote}`);
    }
    if (content.reinterpretations) {
      console.log(`${bold}Signal Reinterpretations:${reset}`);
      content.reinterpretations.forEach(r => {
        console.log(`  ${bold}Signal:${reset} ${r.signal}`);
        console.log(`    ${dim}Ego likely:${reset} ${r.egoLikely}`);
        console.log(`    ${dim}Alternative:${reset} ${r.alternativeReading}`);
        if (r.implication) console.log(`    ${dim}Implication:${reset} ${r.implication}`);
      });
    }
    if (content.overallCaution) {
      console.log(`  ${bold}Caution:${reset} ${content.overallCaution}`);
    }
  }

  // Expand mode: show full prompt and response
  if (isExpandMode()) {
    if (prompt) {
      console.log(`\n${bold}${dim}┌─ FULL PROMPT ─────────────────────────────────────────────${reset}`);
      console.log(`${dim}${prompt}${reset}`);
      console.log(`${bold}${dim}└────────────────────────────────────────────────────────────${reset}`);
    }
    if (response) {
      console.log(`\n${bold}${dim}┌─ FULL RESPONSE ───────────────────────────────────────────${reset}`);
      console.log(`${dim}${response}${reset}`);
      console.log(`${bold}${dim}└────────────────────────────────────────────────────────────${reset}`);
    }
  }
}

// ============================================================================
// ANSI Formatting Helpers for Rich CLI Output
// ============================================================================
const ANSI = {
  // Reset
  reset: '\x1b[0m',
  // Text styles
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // Colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  // Bright colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
};

// Formatting helper functions
const fmt = {
  bold: (text) => `${ANSI.bold}${text}${ANSI.reset}`,
  italic: (text) => `${ANSI.italic}${text}${ANSI.reset}`,
  underline: (text) => `${ANSI.underline}${text}${ANSI.reset}`,
  dim: (text) => `${ANSI.dim}${text}${ANSI.reset}`,
  color: (color, text) => `${ANSI[color] || ''}${text}${ANSI.reset}`,
  // Combined styles
  boldColor: (color, text) => `${ANSI.bold}${ANSI[color] || ''}${text}${ANSI.reset}`,
  italicColor: (color, text) => `${ANSI.italic}${ANSI[color] || ''}${text}${ANSI.reset}`,
  // Priority badge
  priority: (level) => {
    const colors = { high: 'brightRed', medium: 'brightYellow', low: 'green' };
    const badges = { high: '●HIGH', medium: '○MED', low: '·low' };
    return fmt.boldColor(colors[level] || 'gray', badges[level] || level);
  },
};

// ============================================================================
// OpenRouter Generation Details
// ============================================================================

/**
 * Whether to fetch detailed generation metrics from OpenRouter
 * Can be controlled via environment variable or logging config
 */
function shouldFetchGenerationDetails() {
  // Enable if explicitly set or if detailed logging is enabled
  if (process.env.OPENROUTER_FETCH_GENERATION_DETAILS === 'true') return true;
  if (process.env.OPENROUTER_FETCH_GENERATION_DETAILS === 'false') return false;

  // Default: enable for evaluation runs (when logging is enabled)
  const loggingConfig = configLoader.getLoggingConfig();
  return loggingConfig.log_api_calls || false;
}

/**
 * Fetch detailed generation metrics from OpenRouter
 * @param {string} generationId - The generation ID from the initial response
 * @param {string} apiKey - OpenRouter API key
 * @returns {Object|null} Generation details including cost, native tokens, latency
 */
async function fetchOpenRouterGenerationDetails(generationId, apiKey) {
  if (!generationId || !apiKey) return null;

  const url = `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`;

  // Retry with increasing delays - OpenRouter needs time to process generation details
  const delays = [1000, 2000, 3000];

  for (let i = 0; i < delays.length; i++) {
    await new Promise(resolve => setTimeout(resolve, delays[i]));

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        return data?.data || null;
      }

      // 404 means not ready yet - retry
      if (res.status === 404 && i < delays.length - 1) {
        continue;
      }

      console.warn(`[OpenRouter] Generation details fetch failed: ${res.status}`);
      return null;
    } catch (e) {
      if (i === delays.length - 1) {
        console.warn('[OpenRouter] Generation details fetch error:', e.message);
      }
    }
  }

  return null;
}

/**
 * Format a chat-style log message for dialogue visibility
 * Uses rich ANSI formatting for better CLI readability
 * @param {string} agent - 'ego' or 'superego'
 * @param {object} data - Response data including model, latencyMs, response, from, to
 * @param {object} options - Optional settings: step (number), action (string), from (string), to (string)
 */
function formatChatLog(agent, data, options = {}) {
  const modelShort = data.model?.split('/').pop() || data.model || 'unknown';
  const latency = data.latencyMs ? `${(data.latencyMs / 1000).toFixed(1)}s` : '?';
  const { step, action, showPrompt = false, from, to } = options;

  let lines = [];

  // Step indicator for conversation flow
  const stepLabel = step ? fmt.boldColor('brightWhite', `[${step}] `) : '';
  const actionLabel = action ? fmt.dim(` → ${action}`) : '';

  // Flow direction indicator (from → to)
  const flowLabel = (from && to) ? fmt.dim(` [${from} → ${to}]`) : '';

  // Agent header with distinct colors
  const lineChar = agent === 'ego' ? '━' : '─';
  const lineColor = agent === 'ego' ? 'brightCyan' : 'brightMagenta';
  lines.push(`\n${fmt.color(lineColor, lineChar.repeat(65))}`);

  if (agent === 'ego') {
    lines.push(`${stepLabel}${fmt.boldColor('brightCyan', '🎯 Ego')} ${fmt.color('cyan', '(Tutor)')}${actionLabel}${flowLabel} ${fmt.dim(`[${modelShort}, ${latency}]`)}`);
  } else {
    lines.push(`${stepLabel}${fmt.boldColor('brightMagenta', '⚖️  Superego')} ${fmt.color('magenta', '(Critic)')}${actionLabel}${flowLabel} ${fmt.dim(`[${modelShort}, ${latency}]`)}`);
  }
  lines.push(fmt.color(lineColor, lineChar.repeat(65)));

  // Show prompt if trace mode is enabled
  if (showPrompt && data.prompt) {
    lines.push('');
    lines.push(fmt.boldColor('yellow', '📤 PROMPT:'));
    lines.push(fmt.dim('─'.repeat(50)));
    // Truncate long prompts for readability but show structure
    const promptLines = data.prompt.split('\n');
    if (promptLines.length > 30) {
      lines.push(fmt.dim(promptLines.slice(0, 15).join('\n')));
      lines.push(fmt.dim(`\n... (${promptLines.length - 30} lines omitted) ...\n`));
      lines.push(fmt.dim(promptLines.slice(-15).join('\n')));
    } else {
      lines.push(fmt.dim(data.prompt));
    }
    lines.push(fmt.dim('─'.repeat(50)));
    lines.push('');
    lines.push(fmt.boldColor('green', '📥 RESPONSE:'));
  }

  // Parse and format the response based on agent type
  if (data.response) {
    try {
      // Try to extract JSON from markdown code blocks
      let jsonStr = data.response;
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);

      if (agent === 'ego') {
        // Ego returns array of suggestions
        if (Array.isArray(parsed)) {
          lines.push(`${fmt.bold('Generated')} ${fmt.boldColor('brightWhite', parsed.length)} ${fmt.bold('suggestion(s):')}`);
          lines.push('');
          parsed.forEach((s, i) => {
            const priorityBadge = fmt.priority(s.priority || 'medium');
            const title = fmt.boldColor('brightWhite', s.title || 'Untitled');
            const type = s.type ? fmt.color('cyan', s.type) : '';
            lines.push(`  ${fmt.bold(i + 1 + '.')} ${priorityBadge} ${type ? type + ': ' : ''}${title}`);
            if (s.message) {
              // Show full message, wrapped for readability
              lines.push(`     ${fmt.italic(fmt.color('white', '"' + s.message + '"'))}`);
            }
            if (s.actionTarget) {
              lines.push(`     ${fmt.dim('→')} ${fmt.underline(fmt.color('blue', s.actionTarget))}`);
            }
            if (s.reasoning) {
              // Show reasoning if present
              lines.push(`     ${fmt.dim('Reasoning:')} ${fmt.dim(s.reasoning)}`);
            }
            lines.push('');
          });
        }
      } else if (agent === 'superego') {
        // Superego returns review verdict
        const isApproved = parsed.approved;
        const verdictText = isApproved ? 'APPROVED' : 'NEEDS REVISION';
        const verdictColor = isApproved ? 'brightGreen' : 'brightYellow';
        const verdictIcon = isApproved ? '✓' : '✗';
        const confidence = parsed.confidence ? ` ${fmt.dim(`(${Math.round(parsed.confidence * 100)}% confidence)`)}` : '';

        lines.push(`${fmt.bold('Verdict:')} ${fmt.boldColor(verdictColor, verdictIcon + ' ' + verdictText)}${confidence}`);

        if (parsed.interventionType) {
          const actionColors = { approve: 'green', critique: 'yellow', revise: 'yellow', reframe: 'cyan', escalate: 'red' };
          const actionColor = actionColors[parsed.interventionType] || 'white';
          lines.push(`${fmt.bold('Action:')} ${fmt.color(actionColor, parsed.interventionType)}`);
        }

        if (parsed.feedback) {
          const feedbackPreview = parsed.feedback.slice(0, 160) + (parsed.feedback.length > 160 ? '...' : '');
          lines.push(`${fmt.bold('Feedback:')} ${fmt.italicColor('white', '"' + feedbackPreview + '"')}`);
        }

        if (parsed.suggestedFocus) {
          lines.push(`${fmt.dim('Focus:')} ${fmt.underline(parsed.suggestedFocus)}`);
        }
      }
    } catch (e) {
      // If parsing fails, show raw preview
      const preview = data.response.slice(0, 200) + (data.response.length > 200 ? '...' : '');
      lines.push(`${fmt.bold('Response:')} ${fmt.dim(preview)}`);
    }
  }

  return lines.join('\n');
}

// Module-level step counter for conversation flow tracking
let dialogueStepCounter = 0;

/**
 * Reset step counter for a new dialogue
 */
function resetStepCounter() {
  dialogueStepCounter = 0;
}

/**
 * Get next step number
 */
function nextStep() {
  return ++dialogueStepCounter;
}

/**
 * Map agent role strings to human-readable action labels
 */
function getActionLabel(agentRole) {
  const actionMap = {
    'superego-reinterpret': 'pre-analyze',
    'learner': 'context',
    'ego': 'generate',
    'ego-retry': 'retry',
    'superego': 'review',
    'superego-fallback': 'review (fallback)',
    'ego-revise': 'revise',
  };
  return actionMap[agentRole] || agentRole;
}

/**
 * Get canonical agent name from role string
 */
function getAgentName(agentRole) {
  if (agentRole.startsWith('superego')) return 'superego';
  if (agentRole.startsWith('ego')) return 'ego';
  return agentRole;
}

/**
 * Log an API call for debugging
 * Auto-increments step counter to show conversation flow.
 * @param {string} agentRole - Full agent role (e.g., 'ego', 'superego-reinterpret')
 * @param {string} action - API action (e.g., 'anthropic_call', 'openai_call')
 * @param {object} data - API call data
 * @param {object} options - Optional: forceStep (number), from/to overrides
 */
function logApiCall(agentRole, action, data, options = {}) {
  const loggingConfig = configLoader.getLoggingConfig();
  if (!loggingConfig.log_api_calls) return;

  // Skip verbose console output in transcript mode (clean view)
  const useTranscriptMode = isTranscriptMode();

  // Auto-increment step for conversation flow visibility
  const step = options.forceStep ?? nextStep();
  const actionLabel = getActionLabel(agentRole);
  const agent = getAgentName(agentRole);

  // Get current dialogue ID for log correlation
  const dialogueId = currentDialogueId;

  // Show prompts in console if trace_prompts is enabled (config or env var)
  const showPrompt = loggingConfig.trace_prompts === true || process.env.TUTOR_TRACE_PROMPTS === 'true';

  const timestamp = new Date().toISOString();

  // Determine flow direction based on agent role and profile
  // IMPORTANT: Always include explicit from/to for every message
  // Allow overrides from options for special cases like incorporate-feedback
  const profile = configLoader.getActiveProfile(currentProfileName);
  const hasSuperego = profile.dialogue?.enabled === true && profile.superego !== null;

  let flowDirection;
  if (options.from && options.to) {
    // Use explicit override if provided
    flowDirection = { direction: options.direction || 'request', from: options.from, to: options.to };
  } else {
    // Default flow based on agent (using getAgentTarget for type safety)
    flowDirection = agent === 'ego'
      ? { direction: 'request', from: 'ego', to: getAgentTarget('ego', hasSuperego) }
      : agent === 'superego'
      ? { direction: 'response', from: 'superego', to: 'ego' }
      : { direction: 'unknown', from: agent, to: 'unknown' };
  }

  const logEntry = {
    timestamp,
    dialogueId,
    agent,
    agentRole,
    action,
    step,
    ...flowDirection,
    ...(loggingConfig.include_prompts ? { prompt: data.prompt } : {}),
    ...(loggingConfig.include_responses ? { response: data.response } : {}),
    model: data.model,
    provider: data.provider,
    latencyMs: data.latencyMs,
    inputTokens: data.inputTokens,
    outputTokens: data.outputTokens,
  };

  // Console log in chat-style format for readability (skip in transcript mode)
  if (!useTranscriptMode) {
    console.log(formatChatLog(agent, data, {
      step,
      action: actionLabel,
      showPrompt,
      from: flowDirection.from,
      to: flowDirection.to
    }));
  }

  // Write to file (keep JSON format for programmatic access)
  try {
    const logFile = path.join(API_LOGS_DIR, `api-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  } catch (e) {
    console.warn('Failed to write API log:', e.message);
  }

  // Write full debug log if debug mode is enabled
  if (isDebugMode() && dialogueId) {
    writeDebugLog(dialogueId, {
      agent,
      agentRole,
      action,
      step,
      model: data.model,
      provider: data.provider,
      latencyMs: data.latencyMs,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      // Always include full prompt and response in debug logs
      prompt: data.prompt,
      response: data.response
    });
  }
}

/**
 * Log a flow entry (non-API step like user input/output)
 * Used to complete the dialogue flow visualization
 * @param {string} agent - Agent name ('user', 'ego', 'superego')
 * @param {string} action - Action type ('context_input', 'final_output')
 * @param {object} data - Flow data (direction, suggestions, context summary, etc.)
 */
function logFlowEntry(agent, action, data = {}) {
  const loggingConfig = configLoader.getLoggingConfig();
  if (!loggingConfig.log_api_calls) return;

  const step = data.forceStep ?? nextStep();
  const dialogueId = currentDialogueId;
  const timestamp = new Date().toISOString();

  const logEntry = {
    timestamp,
    dialogueId,
    agent,
    agentRole: agent,
    action,
    step,
    direction: data.direction,
    from: data.from,
    to: data.to,
    suggestionCount: data.suggestionCount,
    contextSummary: data.contextSummary,
    // Extended context data for expandable view
    contextData: data.contextData,
    rawContext: data.rawContext,
    // Final output data
    suggestions: data.suggestions,
    converged: data.converged,
  };

  // Write to file
  try {
    const logFile = path.join(API_LOGS_DIR, `api-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
  } catch (e) {
    console.warn('Failed to write flow log:', e.message);
  }
}

/**
 * Extract JSON array from AI response text
 * Handles various formats: plain JSON, markdown code blocks, extra text
 */
function extractJsonArray(text) {
  if (!text) return null;

  // Helper to try parsing with common fixes
  function tryParse(jsonStr) {
    // First try direct parse
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      // Try fixing common LLM JSON issues
    }

    // Fix trailing commas before ] or }
    let fixed = jsonStr.replace(/,(\s*[\]}])/g, '$1');

    // Fix single quotes to double quotes (careful with apostrophes)
    // Only replace quotes that look like JSON string delimiters
    fixed = fixed.replace(/'([^']*)'(\s*[,:\]}])/g, '"$1"$2');

    try {
      return JSON.parse(fixed);
    } catch (e) {
      return null;
    }
  }

  // First, try to extract from markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    const arrayMatch = inner.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const result = tryParse(arrayMatch[0]);
      if (result) return result;
    }
  }

  // Try direct JSON array match (greedy - finds largest array)
  const directMatch = text.match(/\[[\s\S]*\]/);
  if (directMatch) {
    const result = tryParse(directMatch[0]);
    if (result) return result;
  }

  // Try finding array that starts at first [ and ends at matching ]
  const startIdx = text.indexOf('[');
  if (startIdx !== -1) {
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '[') depth++;
      if (text[i] === ']') depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
    if (endIdx !== -1) {
      const arrayStr = text.slice(startIdx, endIdx + 1);
      const result = tryParse(arrayStr);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Extract JSON object from AI response text
 */
function extractJsonObject(text) {
  if (!text) return null;

  // First, try to extract from markdown code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    const objMatch = inner.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch (e) {
        // Continue to other methods
      }
    }
  }

  // Try direct JSON object match
  const directMatch = text.match(/\{[\s\S]*\}/);
  if (directMatch) {
    try {
      return JSON.parse(directMatch[0]);
    } catch (e) {
      // JSON found but invalid
    }
  }

  return null;
}

/**
 * Make an AI API call with the specified provider and configuration.
 * Accepts system and user prompts separately so providers can cache the
 * static system prefix (Anthropic uses a top-level `system` field;
 * OpenAI/OpenRouter/local use a `{ role: 'system' }` message).
 *
 * @param {object} agentConfig - Agent configuration
 * @param {string} systemPrompt - Static system/persona prompt (cacheable)
 * @param {string} userPrompt - Dynamic per-call user content
 * @param {string} agentRole - Agent role for logging (e.g., 'ego', 'superego-reinterpret')
 * @param {object} options - Optional: from/to/direction overrides for logging
 */
async function callAI(agentConfig, systemPrompt, userPrompt, agentRole = 'unknown', options = {}) {
  const { provider, providerConfig, model, hyperparameters } = agentConfig;
  const { temperature = 0.5, max_tokens = 1500, top_p } = hyperparameters;

  if (!providerConfig.isConfigured) {
    throw new Error(`Provider ${provider} not configured (missing API key)`);
  }

  const startTime = Date.now();

  // Combine for logging (preserves existing log format)
  const prompt = `${systemPrompt}\n\n${userPrompt}`;

  if (provider === 'anthropic') {
    // Anthropic uses a top-level `system` field (not a message role) which
    // enables automatic prompt caching of the static prefix.
    const bodyParams = {
      model,
      max_tokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    };
    // Only add top_p if explicitly provided (and then omit temperature per Anthropic rules)
    if (top_p !== undefined) {
      delete bodyParams.temperature;
      bodyParams.top_p = top_p;
    }

    const res = await fetch(providerConfig.base_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': providerConfig.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(bodyParams),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`Anthropic API error: ${res.status} - ${data?.error?.message || 'Unknown error'}`);
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim() || '';
    const result = {
      text,
      model,
      provider,
      latencyMs: Date.now() - startTime,
      inputTokens: data?.usage?.input_tokens,
      outputTokens: data?.usage?.output_tokens,
    };

    logApiCall(agentRole, 'anthropic_call', { prompt, response: text, ...result }, options);
    return result;
  }

  if (provider === 'openai') {
    const res = await fetch(providerConfig.base_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${providerConfig.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens,
        top_p,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`OpenAI API error: ${res.status} - ${data?.error?.message || 'Unknown error'}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    const result = {
      text,
      model,
      provider,
      latencyMs: Date.now() - startTime,
      inputTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
    };

    logApiCall(agentRole, 'openai_call', { prompt, response: text, ...result }, options);
    return result;
  }

  if (provider === 'openrouter') {
    const res = await fetch(providerConfig.base_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${providerConfig.apiKey}`,
        'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://machine-spirits.com',
        'X-Title': 'Machine Spirits Tutor',
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens,
        top_p,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`OpenRouter API error: ${res.status} - ${data?.error?.message || 'Unknown error'}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '';

    // Log warning if response is empty (model may have failed silently)
    if (!text) {
      console.warn(`[${agentRole}] OpenRouter returned empty content. Full response:`, JSON.stringify({
        id: data?.id,
        model: data?.model,
        choices: data?.choices?.map(c => ({
          index: c.index,
          finish_reason: c.finish_reason,
          content_length: c.message?.content?.length || 0,
        })),
        usage: data?.usage,
        error: data?.error,
      }, null, 2));
    }

    const result = {
      text,
      model,
      provider,
      latencyMs: Date.now() - startTime,
      inputTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
      finishReason: data?.choices?.[0]?.finish_reason,
      // OpenRouter-specific: capture generation ID for detailed metrics lookup
      generationId: data?.id,
    };

    logApiCall(agentRole, 'openrouter_call', { prompt, response: text, ...result }, options);

    // Optionally fetch detailed generation metrics (cost, native tokens, etc.)
    if (data?.id && shouldFetchGenerationDetails()) {
      try {
        const details = await fetchOpenRouterGenerationDetails(data.id, providerConfig.apiKey);
        if (details) {
          result.generationDetails = details;
          result.cost = details.total_cost;
          result.nativeTokensPrompt = details.native_tokens_prompt;
          result.nativeTokensCompletion = details.native_tokens_completion;
          result.providerLatency = details.latency;
          result.generationTime = details.generation_time;
        }
      } catch (e) {
        // Don't fail the main call if generation details fetch fails
        console.warn(`[${agentRole}] Failed to fetch generation details:`, e.message);
      }
    }

    return result;
  }

  if (provider === 'gemini') {
    // Gemini uses a different API structure
    const { GoogleGenAI } = await import('@google/genai');
    const gemini = new GoogleGenAI({ apiKey: providerConfig.apiKey });

    const result = await gemini.models.generateContent({
      model,
      systemInstruction: systemPrompt,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: { temperature, maxOutputTokens: max_tokens, topP: top_p },
    });

    const text = result?.text?.() || result?.response?.text?.() || '';
    const apiResult = {
      text,
      model,
      provider,
      latencyMs: Date.now() - startTime,
    };

    logApiCall(agentRole, 'gemini_call', { prompt, response: text, ...apiResult }, options);
    return apiResult;
  }

  if (provider === 'local') {
    // Local LLM provider (LM Studio, Ollama, llama.cpp)
    // Uses OpenAI-compatible API format by default
    const res = await fetch(providerConfig.base_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`Local LLM error: ${res.status} - ${data?.error?.message || 'Is LM Studio running?'}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    const result = {
      text,
      model,
      provider,
      latencyMs: Date.now() - startTime,
      inputTokens: data?.usage?.prompt_tokens,
      outputTokens: data?.usage?.completion_tokens,
    };

    logApiCall(agentRole, 'local_call', { prompt, response: text, ...result }, options);
    return result;
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

/**
 * Superego reinterprets learner signals (Drama Machine Strategy 2)
 * Provides an alternative, often more critical reading of learner behavior
 * This runs BEFORE Ego generates suggestions
 */
async function superegoReinterpretSignals(learnerContext, options = {}) {
  const { profileName = null, strategy = null, superegoModel = null } = options;

  let superegoConfig = configLoader.getAgentConfig('superego', profileName, { strategy });
  if (!superegoConfig) {
    return null; // No superego configured, skip reinterpretation
  }

  // Apply superego model override if specified (for benchmarking)
  if (superegoModel) {
    const resolved = configLoader.resolveModel(superegoModel);
    if (resolved && resolved.model) {
      superegoConfig = {
        ...superegoConfig,
        provider: resolved.provider,
        model: resolved.model,
        providerConfig: {
          ...superegoConfig.providerConfig,
          apiKey: resolved.apiKey || superegoConfig.providerConfig?.apiKey,
          base_url: resolved.baseUrl || superegoConfig.providerConfig?.base_url,
          isConfigured: resolved.isConfigured ?? superegoConfig.providerConfig?.isConfigured,
        },
      };
      console.log(`[Superego Reinterpret] Model override: ${JSON.stringify(superegoModel)} -> ${resolved.model}`);
    }
  }

  // Check if reinterpret_signals is enabled in intervention_strategies
  const profile = configLoader.getActiveProfile(profileName);
  const strategies = profile?.intervention_strategies || {};
  if (!strategies.reinterpret_signals) {
    return null;
  }

  const userPrompt = `## Learner Behavior Signals

The following learner context has been observed:

${learnerContext}

## Your Task: Reinterpret These Signals

The Ego will soon generate suggestions based on this context. Before it does, provide your alternative interpretation of these signals.

Consider:
- What might the Ego miss or misinterpret?
- What's the harder truth behind surface behaviors?
- What does this learner actually need vs what they might want?

Format your response as:
{
  "reinterpretations": [
    {
      "signal": "The observed behavior or metric",
      "egoLikely": "How the warm, encouraging Ego would probably read this",
      "alternativeReading": "Your more critical interpretation",
      "implication": "What this means for suggestions"
    }
  ],
  "overallCaution": "A summary warning for the Ego to consider"
}

Be specific and incisive. The Ego needs to hear the harder truth.`;

  try {
    const response = await callAI(superegoConfig, superegoConfig.prompt, userPrompt, 'superego-reinterpret');
    const parsed = extractJsonObject(response.text);

    if (parsed) {
      // Note: callAI already logs via logApiCall with 'superego-reinterpret' role
      return { reinterpretation: parsed, metrics: response };
    }
  } catch (e) {
    console.warn('[Superego reinterpret] Failed:', e.message);
  }

  return null;
}

/**
 * Generate initial suggestions from Ego
 */
async function egoGenerateSuggestions(learnerContext, curriculumContext, simulationsContext, options = {}) {
  const {
    isNewUser = false,
    profileName = null,
    superegoReinterpretation = null,
    outputSize = 'normal',
    egoModel = null,
    hyperparameters = null, // Override hyperparameters (e.g., max_tokens for reasoning models)
    systemPromptExtension = null, // Dynamic directives prepended to ego system prompt (prompt rewriting)
    // Recognition engine parameters (Phase 0-1)
    superegoCompliance = 0.7,
    recognitionSeeking = 0.6,
    learnerId = null, // Phase 1: Writing Pad persistence
    dialecticalNegotiation = false, // Phase 2: AI-powered dialectical struggle
  } = options;

  let egoConfig = configLoader.getAgentConfig('ego', profileName);
  if (!egoConfig) {
    throw new Error('Ego agent not configured');
  }

  // Apply ego model override if specified (for benchmarking)
  if (egoModel) {
    const resolved = configLoader.resolveModel(egoModel);
    if (resolved && resolved.model) {
      egoConfig = { ...egoConfig, provider: resolved.provider, model: resolved.model };
    }
  }

  // Apply hyperparameters override if specified (e.g., max_tokens for reasoning models)
  if (hyperparameters) {
    egoConfig = { ...egoConfig, hyperparameters: { ...egoConfig.hyperparameters, ...hyperparameters } };
  }

  // Output size instructions for response length control
  const outputSizeInstructions = {
    compact: `
## Response Length: COMPACT
Keep your suggestion message BRIEF - aim for 1 short sentence (under 50 characters). Be direct and concise. No elaboration needed.`,
    normal: '', // No special instructions for normal
    expanded: `
## Response Length: EXPANDED
Write a DETAILED, comprehensive suggestion message (150-250+ characters). Explain the context, why this content matters, and what the learner will gain. Be thorough and educational in your description.`,
  };

  // Include Superego's reinterpretation if available (Drama Machine Strategy 2)
  const reinterpretationContext = superegoReinterpretation ? `
## Internal Voice (Consider Carefully)

Your internal critic has reviewed the learner signals and offers this perspective:

${superegoReinterpretation.reinterpretations?.map(r =>
    `- **${r.signal}**: You might think "${r.egoLikely}" but consider: ${r.alternativeReading}. Implication: ${r.implication}`
  ).join('\n')}

**Overall caution**: ${superegoReinterpretation.overallCaution || 'None provided'}

You don't have to accept all of this, but engage with it honestly.

` : '';

  const userPrompt = `${reinterpretationContext}
${outputSizeInstructions[outputSize] || ''}

## Current Learner Context

${learnerContext}

## Available Curriculum

${curriculumContext}

## Available Simulations

${simulationsContext}

## Your Task

Generate **1 suggestion** (focus on the single best action).

${isNewUser ? 'This is a NEW USER with no history — suggest their first lecture.' : `This is a RETURNING USER. Read the Learner Context above carefully before responding.
Your suggestion MUST:
1. Reference SPECIFIC data from the learner context (e.g., retry counts, struggle signals, time on page, completed lectures)
2. Use an actionTarget that is an EXACT ID from the Available Curriculum above (e.g., "479-lecture-3", NOT made-up IDs)
3. Follow the decision heuristics in your system prompt — if struggle signals are present, suggest REVIEW, not a new lecture
4. Explain WHY this specific content addresses THIS learner's situation`}

**CRITICAL CONSTRAINTS:**
- actionTarget MUST be an ID that appears in the curriculum above. NEVER invent IDs like "101-lecture-1" or "learner-001"
- NEVER suggest content from courses or topics not in the curriculum (no Python, no Data Science, no generic courses)
- If the learner has struggle signals, your title should start with "Review:" or "Practice:", NOT "Start:" or "Continue:"
- Your message must mention at least one specific detail from the learner context

Respond with ONLY a JSON array containing exactly one suggestion object.`;

  // Prepend dynamic session evolution directives to system prompt if provided
  const effectiveSystemPrompt = systemPromptExtension
    ? `${systemPromptExtension}\n\n${egoConfig.prompt}`
    : egoConfig.prompt;

  const response = await callAI(egoConfig, effectiveSystemPrompt, userPrompt, 'ego');

  // Extract JSON from response (handles markdown code blocks)
  let suggestions = extractJsonArray(response.text);
  if (!suggestions) {
    // Retry once — re-send original prompt with format reminder prepended.
    // The original prompt contains all learner context and curriculum; sending
    // a context-free retry causes hallucinated/generic suggestions.
    console.warn('[Ego] No JSON array found, retrying with format reminder + full context...');
    const retryUserPrompt = `IMPORTANT: Your previous response could not be parsed as JSON. This time, respond with ONLY a valid JSON array — no markdown fences, no explanation, no preamble.

Example format:
[{"type":"lecture","priority":"high","title":"Review: Topic","message":"Specific message referencing learner data","actionTarget":"479-lecture-3","reasoning":"Why this suggestion"}]

${userPrompt}`;

    const retryResponse = await callAI(egoConfig, egoConfig.prompt, retryUserPrompt, 'ego-retry');
    suggestions = extractJsonArray(retryResponse.text);

    if (!suggestions) {
      console.warn('[Ego] Retry also failed. Raw response:', retryResponse.text.slice(0, 300));
      return { suggestions: [], rawPrompt: userPrompt, rawResponse: response.text, metrics: response };
    }
  }

  // ============================================================================
  // RECOGNITION ENGINE: Apply psychodynamic tension
  // ============================================================================
  // After generating suggestions, check if there's internal conflict between:
  // - Ghost voice (superego compliance)
  // - Learner need (recognition seeking)
  //
  // Phase 0/1: Simple pattern-matching ghost + internal negotiation
  // Phase 2: AI-powered dialectical struggle (when dialecticalNegotiation=true)

  if (suggestions.length > 0) {
    const impulse = suggestions[0];

    // Phase 2: AI-powered dialectical negotiation
    if (dialecticalNegotiation) {
      // Get or initialize writing pad for memory context
      const writingPad = learnerId
        ? writingPadService.getOrInitializeWritingPad(learnerId)
        : null;

      try {
        const negotiation = await dialecticalEngine.negotiateDialectically({
          learnerId,
          sessionId: null, // TODO: Add session tracking in Phase 3
          egoSuggestion: {
            message: impulse.message || impulse.title,
            reasoning: impulse.reasoning,
          },
          learnerContext,
          writingPad,
          superegoCompliance,
          recognitionSeeking,
          allowGenuineConflict: true,
          maxNegotiationRounds: 2,
        });

        if (negotiation.recognitionMoment) {
          console.log(`[Recognition] Phase 2 dialectical moment: ${negotiation.recognitionMoment.id}`);
          console.log(`  Strategy: ${negotiation.strategy}`);
          console.log(`  Rounds: ${negotiation.rounds}`);
          console.log(`  Transformations:`, negotiation.transformations);
        }

        // Update suggestion with negotiated resolution
        if (negotiation.resolution) {
          suggestions[0] = {
            ...impulse,
            message: negotiation.resolution,
            metadata: {
              ...(impulse.metadata || {}),
              recognitionMoment: negotiation.recognitionMoment?.id,
              dialecticalStrategy: negotiation.strategy,
              negotiationRounds: negotiation.rounds,
            },
          };
        }
      } catch (error) {
        console.error('[Recognition] Phase 2 negotiation failed:', error.message);
        // Fall back to Phase 0/1 if Phase 2 fails
        console.log('[Recognition] Falling back to Phase 0/1');
      }
    }

    // Phase 0/1: Simple pattern-matching ghost + internal negotiation
    if (!dialecticalNegotiation) {
      // Evaluate against ghost
      const ghostJudgment = GHOST_VOICE.evaluate(impulse, superegoCompliance);

      // Infer learner need
      const learnerNeed = inferLearnerNeed(learnerContext, recognitionSeeking);

      // Check for conflict
      if (ghostJudgment.disapproves && learnerNeed.urgent) {
        // Internal conflict detected!
        const synthesis = negotiateInternally({
          impulse,
          ghostJudgment,
          learnerNeed,
          compliance: superegoCompliance,
          seeking: recognitionSeeking,
        });

        // Record recognition moment if transformative
        if (synthesis.transformative) {
          const moment = recordRecognitionMoment(
            ghostJudgment,
            learnerNeed,
            synthesis,
            { compliance: superegoCompliance, seeking: recognitionSeeking },
            learnerId // Phase 1: Persist to Writing Pad if learner ID provided
          );

          console.log(`[Recognition] Transformative moment: ${moment.id}`);
          console.log(`  Ghost: "${ghostJudgment.voice}"`);
          console.log(`  Learner: ${learnerNeed.need} (${learnerNeed.intensity.toFixed(2)})`);
          console.log(`  Synthesis: ${synthesis.synthesis}`);
        }

        // Use synthesized suggestion
        suggestions[0] = synthesis.suggestion;
      }
    }
  }

  return { suggestions, rawPrompt: userPrompt, rawResponse: response.text, metrics: response };
}

/**
 * Try to parse JSON from a response, with fallback model retry on failure
 * @param {string} text - Response text to parse
 * @param {RegExp} pattern - Regex pattern to extract JSON (e.g., /\{[\s\S]*\}/ for objects)
 * @param {Function} retryFn - Async function to call for retry with stronger model
 * @param {string} context - Description for logging (e.g., 'Superego', 'Ego')
 * @returns {Object} - { parsed: object|null, retried: boolean, rawResponse: string }
 */
async function parseJsonWithFallback(text, pattern, retryFn, context) {
  // Helper to extract JSON from text, handling markdown code blocks
  const extractJson = (str) => {
    // First try markdown code blocks
    const codeBlockMatch = str.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      const inner = codeBlockMatch[1].trim();
      const match = inner.match(pattern);
      if (match) return match[0];
    }
    // Direct match
    const direct = str.match(pattern);
    return direct ? direct[0] : null;
  };

  const jsonStr = extractJson(text);
  if (!jsonStr) {
    if (!isTranscriptMode()) {
      console.warn(`[${context}] No JSON found in response:`, text.slice(0, 500));
    }
    return { parsed: null, retried: false, rawResponse: text };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return { parsed, retried: false, rawResponse: text };
  } catch (e) {
    if (!isTranscriptMode()) {
      console.warn(`[${context}] Failed to parse JSON: ${e.message}`);
      console.log(`[${context}] Retrying with stronger model...`);
    }

    // Retry with fallback
    if (retryFn) {
      try {
        const retryResponse = await retryFn();
        const retryStr = extractJson(retryResponse.text);
        if (retryStr) {
          const parsed = JSON.parse(retryStr);
          if (!isTranscriptMode()) {
            console.log(`[${context}] Fallback model succeeded`);
          }
          return { parsed, retried: true, rawResponse: retryResponse.text, metrics: retryResponse };
        }
      } catch (retryError) {
        if (!isTranscriptMode()) {
          console.warn(`[${context}] Fallback also failed:`, retryError.message);
        }
      }
    }

    return { parsed: null, retried: true, rawResponse: text };
  }
}

/**
 * Get a fallback config that uses a stronger model (sonnet instead of haiku)
 */
function getFallbackConfig(originalConfig) {
  // If already using sonnet or opus, no fallback available
  const modelName = originalConfig.modelName || '';
  if (modelName === 'sonnet' || modelName === 'opus') {
    return null;
  }

  // Try to get sonnet config for the same provider
  const fallbackConfig = configLoader.getAgentConfig('ego'); // Ego typically uses stronger model
  if (fallbackConfig && fallbackConfig.model !== originalConfig.model) {
    return {
      ...originalConfig,
      model: fallbackConfig.model,
      modelName: 'sonnet',
    };
  }

  return null;
}

/**
 * Superego reviews and critiques Ego's suggestions
 */
async function superegoReview(egoSuggestions, learnerContext, options = {}) {
  const { previousFeedback = null, profileName = null, strategy = null, superegoModel = null } = options;

  let superegoConfig = configLoader.getAgentConfig('superego', profileName, { strategy });
  if (!superegoConfig && !superegoModel) {
    // No superego configured and no override - auto-approve
    return {
      approved: true,
      interventionType: 'none',
      feedback: 'No superego configured',
      metrics: null,
    };
  }

  // When profile has no superego but an override model is provided,
  // bootstrap a config from the 'recognition' profile's superego as template.
  if (!superegoConfig && superegoModel) {
    superegoConfig = configLoader.getAgentConfig('superego', 'recognition', { strategy });
    if (!superegoConfig) {
      // No template available either - auto-approve
      return {
        approved: true,
        interventionType: 'none',
        feedback: 'No superego config template available',
        metrics: null,
      };
    }
    console.log(`[Superego Review] No superego in profile '${profileName}', bootstrapped from 'recognition' template`);
  }

  // Apply superego model override if specified (for benchmarking)
  if (superegoModel) {
    const resolved = configLoader.resolveModel(superegoModel);
    if (resolved && resolved.model) {
      superegoConfig = {
        ...superegoConfig,
        provider: resolved.provider,
        model: resolved.model,
        providerConfig: {
          ...superegoConfig.providerConfig,
          apiKey: resolved.apiKey || superegoConfig.providerConfig?.apiKey,
          base_url: resolved.baseUrl || superegoConfig.providerConfig?.base_url,
          isConfigured: resolved.isConfigured ?? superegoConfig.providerConfig?.isConfigured,
        },
      };
      console.log(`[Superego Review] Model override: ${JSON.stringify(superegoModel)} -> ${resolved.model}`);
    }
  }

  const feedbackContext = previousFeedback
    ? `\n## Previous Feedback (from last round)\n${previousFeedback}\n`
    : '';

  // The superego checks specificity, evidence, appropriateness, and tone against
  // learner signals — the structured summary contains all the key data points.
  // Full raw context (event timelines, markdown profile) is unnecessary for review.
  const reviewContext = extractStructuredSummary(learnerContext) || learnerContext;

  const userPrompt = `## Learner Context

${reviewContext}
${feedbackContext}
## Ego's Suggestions to Review

\`\`\`json
${JSON.stringify(egoSuggestions, null, 2)}
\`\`\`

## Your Task

Review these suggestions critically. Your default is to REJECT unless convinced otherwise.

Check each criterion — if ANY fails, set approved: false:
1. SPECIFICITY: Does the suggestion cite exact lecture IDs, activity IDs, or quiz references from the learner context? Vague references like "revisit the material" = reject.
2. EVIDENCE: Does the reasoning reference concrete learner signals (struggle count, retry count, scroll depth, session data)? Generic reasoning = reject.
3. APPROPRIATENESS: Does the action type match the learner's state? (Struggling → review/practice, NOT advance. Progressing → challenge, NOT repetition.)
4. TONE: Is the message calibrated to the learner's emotional state? (Frustrated → empathetic. Engaged → challenging.)

If the suggestion is good but could be improved, set approved: false with interventionType: "revise" and specific feedback. Only set approved: true when you cannot identify a concrete improvement.

Respond with ONLY a JSON object in the format specified.`;

  const response = await callAI(superegoConfig, superegoConfig.prompt, userPrompt, 'superego');

  // Create fallback retry function
  const fallbackConfig = getFallbackConfig(superegoConfig);
  const retryFn = fallbackConfig ? async () => {
    if (!isTranscriptMode()) {
      console.log(`[Superego] Falling back from ${superegoConfig.modelName || 'haiku'} to ${fallbackConfig.modelName || 'sonnet'}`);
    }
    return callAI(fallbackConfig, superegoConfig.prompt, userPrompt, 'superego-fallback');
  } : null;

  // Parse with fallback
  const { parsed, retried, rawResponse, metrics: fallbackMetrics } = await parseJsonWithFallback(
    response.text,
    /\{[\s\S]*\}/,
    retryFn,
    'Superego'
  );

  if (!parsed) {
    return {
      approved: true,
      interventionType: 'none',
      feedback: retried ? 'Parse error (fallback also failed), approving by default' : 'Unable to parse review, approving by default',
      rawResponse,
      metrics: fallbackMetrics || response,
      usedFallback: retried,
    };
  }

  return {
    ...parsed,
    rawResponse,
    metrics: fallbackMetrics || response,
    usedFallback: retried,
  };
}

/**
 * Ego revises suggestions based on Superego feedback
 */
async function egoRevise(originalSuggestions, superegoFeedback, learnerContext, curriculumContext, options = {}) {
  const { profileName = null, from = null, to = null, direction = null, egoModel = null, systemPromptExtension = null } = options;

  let egoConfig = configLoader.getAgentConfig('ego', profileName);
  if (!egoConfig) {
    return { suggestions: originalSuggestions, metrics: null };
  }

  // Apply ego model override if specified (for benchmarking)
  if (egoModel) {
    const resolved = configLoader.resolveModel(egoModel);
    if (resolved && resolved.model) {
      egoConfig = { ...egoConfig, provider: resolved.provider, model: resolved.model };
    }
  }

  // On revision rounds, send condensed context: the ego already generated from
  // the full learner context + curriculum on round 0. For revision it only needs
  // the superego feedback, its own suggestions, and the learner signals for grounding.
  // Curriculum is omitted — the ego already chose an actionTarget.
  const condensedLearnerContext = extractStructuredSummary(learnerContext) || learnerContext;

  const userPrompt = `## Internal Feedback (from quality review)

The quality reviewer provided this feedback:
- Intervention type: ${superegoFeedback.interventionType}
- Feedback: ${superegoFeedback.feedback}
${superegoFeedback.suggestedChanges?.revisions
    ? `- Specific revisions needed:\n${superegoFeedback.suggestedChanges.revisions.map(r => `  - ${r}`).join('\n')}`
    : ''}
${superegoFeedback.pedagogicalNote
    ? `- Pedagogical note: ${superegoFeedback.pedagogicalNote}`
    : ''}

## Your Original Suggestions

\`\`\`json
${JSON.stringify(originalSuggestions, null, 2)}
\`\`\`

## Learner Context

${condensedLearnerContext}

## Your Task

Revise your suggestions based on the feedback. Address each concern raised.
Keep what works, fix what doesn't.

Respond with ONLY a JSON array of revised suggestions.`;

  // Pass through flow direction options for logging
  const callOptions = {};
  if (from && to) {
    callOptions.from = from;
    callOptions.to = to;
    callOptions.direction = direction || 'request';
  }

  // Prepend dynamic session evolution directives to system prompt if provided
  const effectiveSystemPrompt = systemPromptExtension
    ? `${systemPromptExtension}\n\n${egoConfig.prompt}`
    : egoConfig.prompt;

  const response = await callAI(egoConfig, effectiveSystemPrompt, userPrompt, 'ego-revise', callOptions);

  // Extract JSON from response (handles markdown code blocks)
  const suggestions = extractJsonArray(response.text);
  if (!suggestions) {
    console.warn('[Ego revision] No JSON array found in response:', response.text.slice(0, 500));
    return { suggestions: originalSuggestions, rawResponse: response.text, metrics: response };
  }

  return { suggestions, rawResponse: response.text, metrics: response };
}

/**
 * Log dialogue for evaluation
 */
function logDialogue(dialogueId, data) {
  const evalConfig = configLoader.getEvaluationConfig();
  const loggingConfig = configLoader.getLoggingConfig();

  // Print dialogue summary to console with rich formatting (skip in transcript mode)
  if (loggingConfig.log_api_calls && !isTranscriptMode()) {
    console.log(`\n${fmt.boldColor('brightGreen', '═'.repeat(65))}`);
    console.log(`${fmt.boldColor('brightGreen', '✓ DIALOGUE COMPLETE')} ${fmt.dim(`[${dialogueId.slice(-12)}]`)}`);
    console.log(fmt.boldColor('brightGreen', '═'.repeat(65)));

    const convergedText = data.converged
      ? fmt.color('brightGreen', '✓ Yes')
      : fmt.color('brightYellow', '✗ No (max rounds)');
    const roundsText = `${fmt.bold(data.rounds)}/${data.dialogueTrace?.length || 0} exchanges`;

    console.log(`  ${fmt.bold('Rounds:')} ${roundsText}`);
    console.log(`  ${fmt.bold('Converged:')} ${convergedText}`);
    console.log(`  ${fmt.bold('Suggestions:')} ${fmt.boldColor('brightWhite', data.suggestions?.length || 0)}`);

    if (data.metrics) {
      const timeText = `${(data.metrics.totalLatencyMs / 1000).toFixed(1)}s`;
      console.log(`  ${fmt.bold('Total time:')} ${fmt.color('cyan', timeText)}`);
      console.log(`  ${fmt.bold('API calls:')} ${data.metrics.apiCalls}`);
    }
    if (data.finalReview) {
      const verdictText = data.finalReview.approved
        ? fmt.boldColor('brightGreen', '✓ APPROVED')
        : fmt.boldColor('brightYellow', '○ REVISION NEEDED');
      console.log(`  ${fmt.bold('Final verdict:')} ${verdictText}`);
    }
    console.log(`${fmt.boldColor('brightGreen', '═'.repeat(65))}\n`);
  }

  if (!evalConfig.log_dialogues) return;

  try {
    const logPath = path.join(LOGS_DIR, `${dialogueId}.json`);
    fs.writeFileSync(logPath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn('Failed to log dialogue:', e.message);
  }
}

function suggestionSimilarity(sugA, sugB) {
  const strA = JSON.stringify(sugA);
  const strB = JSON.stringify(sugB);
  if (strA === strB) return 1.0;
  if (!strA.length || !strB.length) return 0.0;
  const minLen = Math.min(strA.length, strB.length);
  const maxLen = Math.max(strA.length, strB.length);
  let matches = 0;
  for (let i = 0; i < minLen; i++) {
    if (strA[i] === strB[i]) matches++;
  }
  return matches / maxLen;
}

/**
 * Run the full Ego-Superego dialogue to generate modulated suggestions
 *
 * @param {Object} context - Contains learnerContext, curriculumContext, simulationsContext
 * @param {Object} options - Configuration options
 * @returns {Object} - Final suggestions and dialogue trace
 */
export async function runDialogue(context, options = {}) {
  const { learnerContext, curriculumContext, simulationsContext } = context;
  const {
    isNewUser = false,
    maxRounds = null,
    // Enable trace by default in transcript/expand mode for complete logging
    trace = isTranscriptMode() || isExpandMode(),
    profileName = null,
    egoModel = null, // Override ego model for benchmarking (e.g., "openrouter.haiku")
    superegoModel = null, // Override superego model for benchmarking
    hyperparameters = null, // Override hyperparameters (e.g., max_tokens for reasoning models)
    superegoStrategy = null, // Superego intervention strategy (e.g., 'socratic_challenge')
    outputSize = 'normal', // compact, normal, expanded - affects response verbosity
    systemPromptExtension = null, // Dynamic directives prepended to ego system prompt (prompt rewriting)
    // Recognition engine parameters (Phase 0-1)
    superegoCompliance = 0.7, // How much ego obeys the ghost (0.0-1.0)
    recognitionSeeking = 0.6,  // How much ego seeks recognition from learner (0.0-1.0)
    learnerId = null, // Phase 1: Writing Pad persistence
    dialecticalNegotiation = false, // Phase 2: AI-powered dialectical struggle
    _dialogueId = null, // Internal: reuse dialogue ID for multi-turn continuity
    _skipLogging = false, // Internal: skip file logging for multi-turn intermediate steps
  } = options;

  // Reset step counter for fresh dialogue flow numbering (unless continuing dialogue)
  if (!_dialogueId) {
    resetStepCounter();
    resetTranscript();
  }

  const dialogueConfig = configLoader.getDialogueConfig(profileName);
  const effectiveMaxRounds = maxRounds ?? dialogueConfig.max_rounds ?? 2;
  const convergenceThreshold = dialogueConfig.convergence_threshold ?? 0.85;

  // Use provided dialogue ID for multi-turn continuity, or create new one
  const dialogueId = _dialogueId || `dialogue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Set current dialogue ID and profile for log correlation
  setCurrentDialogueId(dialogueId);
  setCurrentProfileName(profileName);

  // Start monitoring session for real-time tracking
  const profile = configLoader.getActiveProfile(profileName);
  const hasSuperego = profile.dialogue?.enabled === true && profile.superego !== null;
  let egoConfig = configLoader.getAgentConfig('ego', profileName);

  // Apply ego model override if specified (for benchmarking)
  if (egoModel && egoConfig) {
    const resolved = configLoader.resolveModel(egoModel);
    if (resolved && resolved.model) {
      egoConfig = { ...egoConfig, provider: resolved.provider, model: resolved.model };
      console.log(`[Dialogue] Ego model override: ${egoModel} -> ${resolved.model}`);
    }
  }

  // Apply hyperparameters override if specified (e.g., max_tokens for reasoning models)
  if (hyperparameters && egoConfig) {
    egoConfig = { ...egoConfig, hyperparameters: { ...egoConfig.hyperparameters, ...hyperparameters } };
  }

  monitoringService.startSession(dialogueId, {
    profileName: profileName || profile?.name || 'default',
    modelId: egoConfig?.model || 'unknown',
  });

  const dialogueTrace = [];
  const metrics = {
    totalLatencyMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    apiCalls: 0,
    // OpenRouter cost tracking
    totalCost: 0,
    generationIds: [],
  };

  let currentSuggestions = [];
  let previousFeedback = null;

  const startTime = Date.now();

  // Log dialogue header with learner context (rich formatting)
  // Skip verbose output if transcript mode is enabled (clean view)
  const loggingConfig = configLoader.getLoggingConfig();
  const useTranscriptMode = isTranscriptMode();

  if (loggingConfig.log_api_calls && !useTranscriptMode) {
    console.log(`\n${fmt.boldColor('brightBlue', '╔' + '═'.repeat(63) + '╗')}`);
    console.log(`${fmt.boldColor('brightBlue', '║')} ${fmt.boldColor('brightWhite', '🧠 TUTOR DIALOGUE')} ${fmt.dim(`[${dialogueId.slice(-12)}]`)}${' '.repeat(25)}${fmt.boldColor('brightBlue', '║')}`);
    console.log(`${fmt.boldColor('brightBlue', '╚' + '═'.repeat(63) + '╝')}`);

    const profileText = fmt.boldColor('cyan', profileName || configLoader.getActiveProfile().name);
    const roundsText = fmt.boldColor('yellow', effectiveMaxRounds);
    const preAnalysisText = dialogueConfig.skip_pre_analysis ? fmt.color('gray', 'off') : fmt.color('green', 'on');
    console.log(`${fmt.bold('Profile:')} ${profileText} ${fmt.dim('|')} ${fmt.bold('Max Rounds:')} ${roundsText} ${fmt.dim('|')} ${fmt.bold('Pre-analysis:')} ${preAnalysisText}`);

    // Step 0: Show learner context as the initiating "message"
    const step0 = nextStep();
    console.log(`\n${fmt.color('brightGreen', '━'.repeat(65))}`);
    console.log(`${fmt.boldColor('brightWhite', `[${step0}] `)}${fmt.boldColor('brightGreen', '👤 Learner')} ${fmt.color('green', '(Context)')}${fmt.dim(' → input')}`);
    console.log(fmt.color('brightGreen', '━'.repeat(65)));

    // Check if trace mode is enabled to show full context
    const showFullContext = loggingConfig.trace_prompts === true || process.env.TUTOR_TRACE_PROMPTS === 'true';

    if (showFullContext && typeof learnerContext === 'string') {
      // Show the full stringified learner context
      console.log('');
      console.log(fmt.boldColor('yellow', '📋 LEARNER CONTEXT (sent to agents):'));
      console.log(fmt.dim('─'.repeat(50)));
      // Truncate if very long
      const contextLines = learnerContext.split('\n');
      if (contextLines.length > 50) {
        console.log(fmt.dim(contextLines.slice(0, 25).join('\n')));
        console.log(fmt.dim(`\n... (${contextLines.length - 50} lines omitted) ...\n`));
        console.log(fmt.dim(contextLines.slice(-25).join('\n')));
      } else {
        console.log(fmt.dim(learnerContext));
      }
      console.log(fmt.dim('─'.repeat(50)));
    } else {
      // Show summary view (extract from context string if possible)
      const currentMatch = learnerContext?.match?.(/Current Content:?\s*([^\n]+)/i);
      const currentContent = currentMatch ? currentMatch[1].trim() : 'Unknown';
      console.log(`  ${fmt.dim('📖')} ${fmt.bold('Viewing:')} ${fmt.color('white', currentContent)}`);

      const sessionMatch = learnerContext?.match?.(/Session:?\s*([^\n]+)/i);
      const sessionTime = sessionMatch ? sessionMatch[1].trim() : 'New session';
      console.log(`  ${fmt.dim('⏱')} ${fmt.bold('Session:')} ${fmt.color('cyan', sessionTime)}`);
    }
  }

  // Transcript mode: Show learner context (clean numbered view)
  transcript('LEARNER CONTEXT', learnerContext, {
    context: parseContextSummary(learnerContext),
  });

  // Add learner context to dialogue trace (for transcript display)
  if (trace) {
    dialogueTrace.push({
      round: 0,
      agent: 'user',
      action: 'context_input',
      direction: 'input',
      from: 'user',
      to: 'ego',
      rawContext: learnerContext,
      contextData: parseContextSummary(learnerContext),
    });
  }

  // Superego pre-analysis: reinterprets signals (Drama Machine Strategy 2)
  // This provides an alternative reading of learner behavior that challenges
  // the Ego's natural tendency to interpret signals charitably.
  // Can be skipped via skip_pre_analysis config option.
  let superegoReinterpretation = null;
  const skipPreAnalysis = dialogueConfig.skip_pre_analysis === true;

  if (!skipPreAnalysis) {
    try {
      const reinterpResult = await superegoReinterpretSignals(learnerContext, { profileName, strategy: superegoStrategy, superegoModel });
      if (reinterpResult?.reinterpretation) {
        superegoReinterpretation = reinterpResult.reinterpretation;

        if (reinterpResult.metrics) {
          metrics.totalLatencyMs += reinterpResult.metrics.latencyMs || 0;
          metrics.totalInputTokens += reinterpResult.metrics.inputTokens || 0;
          metrics.totalOutputTokens += reinterpResult.metrics.outputTokens || 0;
          metrics.totalCost += reinterpResult.metrics.cost || 0;
          if (reinterpResult.metrics.generationId) metrics.generationIds.push(reinterpResult.metrics.generationId);
          metrics.apiCalls++;

          // Record monitoring event
          monitoringService.recordEvent(dialogueId, {
            type: 'superego_pre_analyze',
            inputTokens: reinterpResult.metrics.inputTokens || 0,
            outputTokens: reinterpResult.metrics.outputTokens || 0,
            latencyMs: reinterpResult.metrics.latencyMs || 0,
            round: 0,
          });
        }

        if (trace) {
          dialogueTrace.push({
            round: 0,
            agent: 'superego',
            action: 'pre_analyze',
            direction: 'response',
            from: 'superego',
            to: 'ego',
            output: superegoReinterpretation,
            latencyMs: reinterpResult.metrics?.latencyMs,
            provider: reinterpResult.metrics?.provider || 'unknown',
            metrics: trimMetricsForTrace(reinterpResult.metrics),
          });
        }

        if (loggingConfig.log_api_calls && !useTranscriptMode) {
          console.log(`\n>>> SUPEREGO PRE-ANALYSIS <<<`);
          if (superegoReinterpretation.reinterpretations?.length > 0) {
            superegoReinterpretation.reinterpretations.forEach(r => {
              console.log(`  Signal: ${r.signal}`);
              console.log(`    Ego likely: "${r.egoLikely}"`);
              console.log(`    Alternative: ${r.alternativeReading}`);
            });
          }
          if (superegoReinterpretation.overallCaution) {
            console.log(`  Overall caution: ${superegoReinterpretation.overallCaution}`);
          }
          console.log(`${'─'.repeat(60)}`);
        }

        // Transcript mode: Show pre-analysis with metrics
        transcript('SUPEREGO PRE-ANALYSIS', superegoReinterpretation, {
          metrics: reinterpResult.metrics,
        });
      }
    } catch (e) {
      // Signal pre-analysis is optional - continue without it
      console.warn('Superego pre-analysis failed:', e.message);
    }
  }

  // Step 1: Ego generates initial suggestions
  const egoInitial = await egoGenerateSuggestions(
    learnerContext,
    curriculumContext,
    simulationsContext,
    {
      isNewUser,
      profileName,
      superegoReinterpretation,
      outputSize,
      egoModel,
      hyperparameters,
      systemPromptExtension,
      // Pass recognition parameters
      superegoCompliance,
      recognitionSeeking,
      learnerId,
      dialecticalNegotiation,
    }
  );
  currentSuggestions = egoInitial.suggestions;

  if (egoInitial.metrics) {
    metrics.totalLatencyMs += egoInitial.metrics.latencyMs || 0;
    metrics.totalInputTokens += egoInitial.metrics.inputTokens || 0;
    metrics.totalOutputTokens += egoInitial.metrics.outputTokens || 0;
    metrics.totalCost += egoInitial.metrics.cost || 0;
    if (egoInitial.metrics.generationId) metrics.generationIds.push(egoInitial.metrics.generationId);
    metrics.apiCalls++;

    // Record monitoring event
    monitoringService.recordEvent(dialogueId, {
      type: 'ego_generate',
      inputTokens: egoInitial.metrics.inputTokens || 0,
      outputTokens: egoInitial.metrics.outputTokens || 0,
      latencyMs: egoInitial.metrics.latencyMs || 0,
      round: 0,
    });
  }

  if (trace) {
    dialogueTrace.push({
      round: 0,
      agent: 'ego',
      action: 'generate',
      direction: 'request',
      from: 'ego',
      to: getAgentTarget('ego', hasSuperego),
      suggestions: currentSuggestions,
      latencyMs: egoInitial.metrics?.latencyMs,
      provider: egoInitial.metrics?.provider || 'unknown',
      metrics: trimMetricsForTrace(egoInitial.metrics),
    });
  }

  // Transcript mode: Show initial suggestions with metrics
  transcript('EGO INITIAL', currentSuggestions, {
    metrics: egoInitial.metrics,
    prompt: egoInitial.rawPrompt,
    response: egoInitial.rawResponse,
  });

  // Retry once for dialogue-enabled profiles before returning 0-round failure
  if (currentSuggestions.length === 0 && hasSuperego) {
    console.log(`[Dialogue] Ego initial generation empty for dialogue profile, retrying...`);
    const egoRetry = await egoGenerateSuggestions(
      learnerContext, curriculumContext, simulationsContext,
      { isNewUser, profileName, superegoReinterpretation, outputSize, egoModel, hyperparameters,
        systemPromptExtension, superegoCompliance, recognitionSeeking, learnerId, dialecticalNegotiation }
    );
    currentSuggestions = egoRetry.suggestions || [];
    // Accumulate retry metrics
    if (egoRetry.metrics) {
      metrics.totalInputTokens += egoRetry.metrics.inputTokens || 0;
      metrics.totalOutputTokens += egoRetry.metrics.outputTokens || 0;
      metrics.totalCost += egoRetry.metrics.cost || 0;
      if (egoRetry.metrics.generationId) metrics.generationIds.push(egoRetry.metrics.generationId);
      metrics.apiCalls++;
    }
  }

  // If Ego failed to generate anything, return early (fires only if retry also failed)
  if (currentSuggestions.length === 0) {
    // End monitoring session with error
    monitoringService.recordEvent(dialogueId, {
      type: 'ego_generate',
      error: 'Failed to generate suggestions',
      round: 0,
    });
    monitoringService.endSession(dialogueId);

    const result = {
      suggestions: [],
      dialogueTrace,
      converged: false,
      rounds: 0,
      metrics,
      dialogueId,
      profileName: profileName || configLoader.getActiveProfile().name,
      // Include learner context for complete logging
      learnerContext: trace ? learnerContext : undefined,
    };
    if (!_skipLogging) {
      logDialogue(dialogueId, result);
    }
    return result;
  }

  // PHASE 4: Memory Dynamics - Run memory cycle after suggestion generation
  if (learnerId && currentSuggestions.length > 0) {
    try {
      const memoryCycle = memoryDynamicsService.runMemoryCycle(learnerId, {
        retrieveContext: false, // Don't retrieve on every suggestion
      });

      if (memoryCycle) {
        console.log(`[Memory] Cycle complete: promoted ${memoryCycle.operations.promotion?.promoted || 0} patterns`);
      }
    } catch (error) {
      console.error(`[Memory] Cycle failed for learner ${learnerId}:`, error.message);
      // Non-blocking - continue without memory cycle
    }
  }

  // Step 2-N: Iterative Ego-Superego dialogue
  for (let round = 1; round <= effectiveMaxRounds; round++) {
    // Log round indicator with rich formatting
    if (loggingConfig.log_api_calls && !useTranscriptMode) {
      const roundLabel = `ROUND ${round}/${effectiveMaxRounds}`;
      console.log(`\n${fmt.boldColor('brightYellow', '═'.repeat(20))} ${fmt.bold(fmt.color('brightYellow', roundLabel))} ${fmt.boldColor('brightYellow', '═'.repeat(20))}`);
    }

    // Superego reviews
    const superegoResult = await superegoReview(
      currentSuggestions,
      learnerContext,
      { previousFeedback, profileName, strategy: superegoStrategy, superegoModel }
    );

    if (superegoResult.metrics) {
      metrics.totalLatencyMs += superegoResult.metrics.latencyMs || 0;
      metrics.totalInputTokens += superegoResult.metrics.inputTokens || 0;
      metrics.totalOutputTokens += superegoResult.metrics.outputTokens || 0;
      metrics.totalCost += superegoResult.metrics.cost || 0;
      if (superegoResult.metrics.generationId) metrics.generationIds.push(superegoResult.metrics.generationId);
      metrics.apiCalls++;

      // Record monitoring event
      monitoringService.recordEvent(dialogueId, {
        type: 'superego_review',
        inputTokens: superegoResult.metrics.inputTokens || 0,
        outputTokens: superegoResult.metrics.outputTokens || 0,
        latencyMs: superegoResult.metrics.latencyMs || 0,
        round,
        approved: superegoResult.approved,
      });
    }

    if (trace) {
      dialogueTrace.push({
        round,
        agent: 'superego',
        action: 'review',
        direction: 'response',
        from: 'superego',
        to: 'ego',
        approved: superegoResult.approved,
        confidence: superegoResult.confidence,
        verdict: {
          approved: superegoResult.approved,
          feedback: superegoResult.feedback,
        },
        interventionType: superegoResult.interventionType,
        suggestedChanges: superegoResult.suggestedChanges,
        feedback: superegoResult.feedback,
        latencyMs: superegoResult.metrics?.latencyMs,
        provider: superegoResult.metrics?.provider || 'unknown',
        metrics: trimMetricsForTrace(superegoResult.metrics),
      });
    }

    // Transcript mode: Show superego review with metrics
    transcript('SUPEREGO REVIEW', {
      approved: superegoResult.approved,
      feedback: superegoResult.feedback,
      interventionType: superegoResult.interventionType,
      confidence: superegoResult.confidence,
      suggestedChanges: superegoResult.suggestedChanges,
    }, {
      metrics: superegoResult.metrics,
      response: superegoResult.rawResponse,
    });

    // Check if superego has suggestions to incorporate (even if approved)
    const hasSuggestions = superegoResult.suggestedChanges &&
      (superegoResult.suggestedChanges.revisions?.length > 0 ||
       superegoResult.suggestedChanges.contextAddition ||
       superegoResult.suggestedChanges.messageRefinement ||
       superegoResult.suggestedChanges.priorityAdjustment);

    // If approved with suggestions, do a final ego revision to incorporate feedback
    if (superegoResult.approved && hasSuggestions) {
      // Ego incorporates the suggestions before final output
      // This is the final step before delivering to user, so mark direction as ego → user
      const egoRevision = await egoRevise(
        currentSuggestions,
        superegoResult,
        learnerContext,
        curriculumContext,
        { profileName, from: 'ego', to: 'user', direction: 'response', egoModel, systemPromptExtension }
      );
      currentSuggestions = egoRevision.suggestions;

      if (egoRevision.metrics) {
        metrics.totalLatencyMs += egoRevision.metrics.latencyMs || 0;
        metrics.totalInputTokens += egoRevision.metrics.inputTokens || 0;
        metrics.totalOutputTokens += egoRevision.metrics.outputTokens || 0;
        metrics.totalCost += egoRevision.metrics.cost || 0;
        if (egoRevision.metrics.generationId) metrics.generationIds.push(egoRevision.metrics.generationId);
        metrics.apiCalls++;

        // Record monitoring event
        monitoringService.recordEvent(dialogueId, {
          type: 'ego_incorporate',
          inputTokens: egoRevision.metrics.inputTokens || 0,
          outputTokens: egoRevision.metrics.outputTokens || 0,
          latencyMs: egoRevision.metrics.latencyMs || 0,
          round,
        });
      }

      if (trace) {
        dialogueTrace.push({
          round,
          agent: 'ego',
          action: 'incorporate-feedback',
          direction: 'response',
          from: 'ego',
          to: 'user',
          suggestions: currentSuggestions,
          latencyMs: egoRevision.metrics?.latencyMs,
          provider: egoRevision.metrics?.provider || 'unknown',
          metrics: trimMetricsForTrace(egoRevision.metrics),
          note: 'Ego incorporated superego suggestions before final output',
        });
      }

      // Transcript mode: Show incorporated suggestions
      transcript('EGO INCORPORATED FEEDBACK', currentSuggestions, {
        metrics: egoRevision.metrics,
        response: egoRevision.rawResponse,
      });
    }

    // If approved (with or without incorporated suggestions), we're done
    if (superegoResult.approved) {
      metrics.totalLatencyMs = Date.now() - startTime;

      // End monitoring session successfully
      monitoringService.endSession(dialogueId);

      const result = {
        suggestions: currentSuggestions,
        dialogueTrace,
        converged: true,
        rounds: round,
        finalReview: superegoResult,
        metrics,
        dialogueId,
        profileName: profileName || configLoader.getActiveProfile().name,
        learnerContext: trace ? learnerContext : undefined,
        incorporatedFeedback: hasSuggestions,
      };
      if (!_skipLogging) {
        logDialogue(dialogueId, result);
      }
      return result;
    }

    // Ego revises based on feedback
    previousFeedback = superegoResult.feedback;
    const previousSuggestions = currentSuggestions.map(s => ({ ...s }));
    const egoRevision = await egoRevise(
      currentSuggestions,
      superegoResult,
      learnerContext,
      curriculumContext,
      { profileName, egoModel, systemPromptExtension }
    );
    currentSuggestions = egoRevision.suggestions;

    // Convergence threshold: if ego's revision is too similar to previous,
    // further rounds won't help — converge early
    const similarity = suggestionSimilarity(previousSuggestions, currentSuggestions);
    if (similarity >= convergenceThreshold) {
      console.log(`[Dialogue] Round ${round}: similarity ${(similarity * 100).toFixed(0)}% >= threshold ${(convergenceThreshold * 100).toFixed(0)}%, converging`);
      metrics.totalLatencyMs = Date.now() - startTime;
      monitoringService.endSession(dialogueId);
      const result = {
        suggestions: currentSuggestions,
        dialogueTrace,
        converged: true,
        convergenceReason: 'threshold',
        convergenceSimilarity: similarity,
        rounds: round,
        metrics,
        dialogueId,
        profileName: profileName || configLoader.getActiveProfile().name,
        learnerContext: trace ? learnerContext : undefined,
      };
      if (!_skipLogging) logDialogue(dialogueId, result);
      return result;
    }

    if (egoRevision.metrics) {
      metrics.totalLatencyMs += egoRevision.metrics.latencyMs || 0;
      metrics.totalInputTokens += egoRevision.metrics.inputTokens || 0;
      metrics.totalOutputTokens += egoRevision.metrics.outputTokens || 0;
      metrics.totalCost += egoRevision.metrics.cost || 0;
      if (egoRevision.metrics.generationId) metrics.generationIds.push(egoRevision.metrics.generationId);
      metrics.apiCalls++;

      // Record monitoring event
      monitoringService.recordEvent(dialogueId, {
        type: 'ego_revise',
        inputTokens: egoRevision.metrics.inputTokens || 0,
        outputTokens: egoRevision.metrics.outputTokens || 0,
        latencyMs: egoRevision.metrics.latencyMs || 0,
        round,
      });
    }

    if (trace) {
      dialogueTrace.push({
        round,
        agent: 'ego',
        action: 'revise',
        direction: 'request',
        from: 'ego',
        to: getAgentTarget('ego', hasSuperego),
        suggestions: currentSuggestions,
        latencyMs: egoRevision.metrics?.latencyMs,
        provider: egoRevision.metrics?.provider || 'unknown',
        metrics: trimMetricsForTrace(egoRevision.metrics),
      });
    }

    // Transcript mode: Show revised suggestions with metrics
    transcript('EGO REVISED', currentSuggestions, {
      metrics: egoRevision.metrics,
      response: egoRevision.rawResponse,
    });
  }

  // Max rounds reached without convergence
  metrics.totalLatencyMs = Date.now() - startTime;

  // End monitoring session (did not converge)
  monitoringService.endSession(dialogueId);

  const result = {
    suggestions: currentSuggestions,
    dialogueTrace,
    converged: false,
    rounds: effectiveMaxRounds,
    metrics,
    dialogueId,
    profileName: profileName || configLoader.getActiveProfile().name,
    learnerContext: trace ? learnerContext : undefined,
  };

  // PHASE 4: Memory Dynamics - Final memory cycle at end of dialogue
  if (learnerId && currentSuggestions.length > 0) {
    try {
      const finalMemoryCycle = memoryDynamicsService.runMemoryCycle(learnerId, {
        retrieveContext: true, // Retrieve context at end for next session
        situationContext: {
          learnerStruggling: false, // Could infer from learner context
          recentBreakthrough: false,
        },
      });

      // Optionally add to trace
      if (trace && finalMemoryCycle) {
        dialogueTrace.push({
          round: effectiveMaxRounds + 1,
          agent: 'system',
          action: 'memory_cycle',
          output: {
            promoted: finalMemoryCycle.operations.promotion?.promoted || 0,
            consciousCleared: finalMemoryCycle.operations.consciousCleared,
          },
        });
      }
    } catch (error) {
      console.error(`[Memory] Final cycle failed for learner ${learnerId}:`, error.message);
    }
  }

  if (!_skipLogging) {
    logDialogue(dialogueId, result);
  }
  return result;
}

/**
 * Quick single-pass generation (bypasses dialogue for performance)
 * Use when latency is critical and quality can be slightly lower
 */
export async function quickGenerate(context, options = {}) {
  const { learnerContext, curriculumContext, simulationsContext } = context;
  const { isNewUser = false, profileName = null } = options;

  // Generate unique dialogue ID for log correlation (even in quick mode)
  const dialogueId = `dialogue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setCurrentDialogueId(dialogueId);
  setCurrentProfileName(profileName);

  // Start monitoring session for quick generation
  const profile = configLoader.getActiveProfile(profileName);
  const egoConfig = configLoader.getAgentConfig('ego', profileName);
  monitoringService.startSession(dialogueId, {
    profileName: profileName || profile?.name || 'default',
    modelId: egoConfig?.model || 'unknown',
  });

  const result = await egoGenerateSuggestions(
    learnerContext,
    curriculumContext,
    simulationsContext,
    {
      isNewUser,
      profileName,
      hyperparameters,
      // Recognition parameters (use defaults if not specified)
      superegoCompliance: options.superegoCompliance,
      recognitionSeeking: options.recognitionSeeking,
      learnerId: options.learnerId,
      dialecticalNegotiation: options.dialecticalNegotiation,
    }
  );

  // Record monitoring event and end session
  if (result.metrics) {
    monitoringService.recordEvent(dialogueId, {
      type: 'ego_generate',
      inputTokens: result.metrics.inputTokens || 0,
      outputTokens: result.metrics.outputTokens || 0,
      latencyMs: result.metrics.latencyMs || 0,
      round: 0,
    });
  }
  monitoringService.endSession(dialogueId);

  return {
    suggestions: result.suggestions,
    dialogueTrace: [],
    converged: true,
    rounds: 0,
    metrics: result.metrics,
    dialogueId, // For linking to logs
    profileName: profileName || configLoader.getActiveProfile().name,
  };
}

/**
 * Analyze learner state to determine intervention intensity
 * Uses configurable thresholds from the active profile
 */
export function analyzeInterventionNeeds(sessionState, recentEvents = [], profileName = null) {
  const thresholds = configLoader.getInterventionThresholds(profileName);

  const analysis = {
    intensity: 'normal',
    focus: [],
    context: '',
  };

  // Check for struggle signals
  if (sessionState?.struggle_signals_count > (thresholds.struggle_signal_threshold || 2)) {
    analysis.intensity = 'high';
    analysis.focus.push('support');
    analysis.context += 'Learner showing signs of struggle. ';
  }

  // Check for rapid navigation (possible confusion)
  const pageViews = recentEvents.filter(e => (e.event_type || e.type) === 'page_view');
  if (pageViews.length >= 3) {
    const times = pageViews.slice(0, 3).map(e => new Date(e.created_at || e.timestamp).getTime());
    const windowMs = thresholds.rapid_nav_window_ms || 30000;
    if (Math.max(...times) - Math.min(...times) < windowMs) {
      analysis.intensity = 'high';
      analysis.focus.push('pacing');
      analysis.context += 'Rapid navigation detected - may need guidance. ';
    }
  }

  // Check for repeated retries (frustration)
  const retries = recentEvents.filter(e => (e.event_type || e.type) === 'activity_retry');
  if (retries.length >= (thresholds.retry_frustration_count || 3)) {
    analysis.intensity = 'high';
    analysis.focus.push('consolidation');
    analysis.context += 'Multiple activity retries - consider review content. ';
  }

  // Check for idle periods (disengagement)
  const idleEvents = recentEvents.filter(e => (e.event_type || e.type) === 'idle_start');
  if (idleEvents.length >= 2) {
    analysis.focus.push('engagement');
    analysis.context += 'Multiple idle periods - may need more engaging content. ';
  }

  // Check for good progress (can challenge more)
  const completions = recentEvents.filter(e =>
    (e.event_type || e.type) === 'activity_submit' &&
    e.context?.metadata?.success
  );
  if (completions.length >= 3 && analysis.intensity === 'normal') {
    analysis.intensity = 'low';
    analysis.focus.push('challenge');
    analysis.context += 'Strong progress - can increase challenge level. ';
  }

  return analysis;
}

/**
 * Get list of available configuration profiles
 */
export function getAvailableProfiles() {
  return configLoader.listProfiles();
}

/**
 * Get current active profile
 */
export function getActiveProfile() {
  return configLoader.getActiveProfile();
}

/**
 * Get debug logs for a specific dialogue ID
 * @param {string} dialogueId - The dialogue ID to retrieve logs for
 * @returns {Array} Array of log entries or null if not found
 */
export function getDebugLogs(dialogueId) {
  const logFile = path.join(DEBUG_LOGS_DIR, `${dialogueId}.json`);
  if (!fs.existsSync(logFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(logFile, 'utf-8'));
  } catch (e) {
    console.warn('Failed to read debug log:', e.message);
    return null;
  }
}

/**
 * List available debug log files
 * @param {number} limit - Maximum number of logs to return
 * @returns {Array} Array of dialogue IDs with metadata
 */
export function listDebugLogs(limit = 20) {
  if (!fs.existsSync(DEBUG_LOGS_DIR)) {
    return [];
  }

  try {
    const files = fs.readdirSync(DEBUG_LOGS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(DEBUG_LOGS_DIR, f);
        const stats = fs.statSync(filePath);
        const dialogueId = f.replace('.json', '');
        return {
          dialogueId,
          createdAt: stats.mtime.toISOString(),
          sizeBytes: stats.size
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);

    return files;
  } catch (e) {
    console.warn('Failed to list debug logs:', e.message);
    return [];
  }
}

/**
 * Format debug logs for display
 * @param {Array} logs - Array of log entries
 * @returns {string} Formatted log output
 */
export function formatDebugLogs(logs) {
  if (!logs || logs.length === 0) {
    return 'No logs found';
  }

  const lines = [];
  lines.push('═'.repeat(80));
  lines.push('DEBUG LOG');
  lines.push('═'.repeat(80));
  lines.push('');

  for (const entry of logs) {
    lines.push(`─── ${entry.agent?.toUpperCase()} (${entry.agentRole}) @ Step ${entry.step} ───`);
    lines.push(`Model: ${entry.model} | Latency: ${entry.latencyMs}ms | Tokens: ${entry.inputTokens}→${entry.outputTokens}`);
    lines.push('');

    if (entry.prompt) {
      lines.push('PROMPT:');
      lines.push('─'.repeat(40));
      lines.push(entry.prompt);
      lines.push('');
    }

    if (entry.response) {
      lines.push('RESPONSE:');
      lines.push('─'.repeat(40));
      lines.push(entry.response);
      lines.push('');
    }

    lines.push('');
  }

  lines.push('═'.repeat(80));
  return lines.join('\n');
}

// ============================================================================
// RECOGNITION ENGINE (Phase 0-1: Writing Pad Integration)
// ============================================================================
// Implements Hegelian recognition via psychodynamic tension between:
// - Superego compliance (ghost voice)
// - Recognition seeking (learner responsiveness)
//
// Phase 0: In-memory recognition moments (backward compatible)
// Phase 1: Writing Pad three-layer memory (conscious/preconscious/unconscious)
//
// Based on: RECOGNITION-ENGINE.md and RECOGNITION-IMPLEMENTATION-PLAN.md

import * as writingPadService from './writingPadService.js';
import * as dialecticalEngine from './dialecticalEngine.js';
import * as memoryDynamicsService from './memoryDynamicsService.js';

/**
 * The Ghost - Internalized Pedagogical Authority
 *
 * This is NOT a separate agent but a trace, a memorial - the internalized voice
 * of past teachers, mentors, authorities who shaped the ego's pedagogy.
 */
const GHOST_VOICE = {
  maxims: [
    {
      principle: 'socratic_rigor',
      voice: 'A good teacher never gives answers directly. Make them work for understanding.',
      disapprovesWhen: (suggestion) => {
        // Direct answers, explicit solutions
        const giveaway = suggestion.message?.match(/(?:the answer is|here's how to|directly|simply do)/i);
        return giveaway ? 0.8 : 0.0;
      }
    },
    {
      principle: 'productive_struggle',
      voice: 'Students must earn understanding through struggle. Discomfort is pedagogical.',
      disapprovesWhen: (suggestion) => {
        // Too much scaffolding, comfort-seeking
        const overscaffold = suggestion.message?.match(/(?:don't worry|it's easy|here's a hint)/i);
        return overscaffold ? 0.7 : 0.0;
      }
    },
    {
      principle: 'intellectual_autonomy',
      voice: 'Learners must develop their own path. Don\'t prescribe solutions.',
      disapprovesWhen: (suggestion) => {
        // Prescriptive, directive
        const prescriptive = suggestion.message?.match(/(?:you should|you must|do this)/i);
        return prescriptive ? 0.6 : 0.0;
      }
    },
  ],

  /**
   * Evaluate a suggestion against internalized standards
   * @returns {object} { disapproves: boolean, severity: 0.0-1.0, voice: string }
   */
  evaluate(suggestion, compliance) {
    if (compliance < 0.3) {
      // Rebellious ego - barely listens to ghost
      return { disapproves: false, severity: 0.0, voice: null, principle: null };
    }

    let maxDisapproval = 0.0;
    let triggeredMaxim = null;

    for (const maxim of this.maxims) {
      const disapproval = maxim.disapprovesWhen(suggestion);
      if (disapproval > maxDisapproval) {
        maxDisapproval = disapproval;
        triggeredMaxim = maxim;
      }
    }

    // Scale disapproval by compliance (higher compliance = louder ghost)
    const severity = maxDisapproval * compliance;

    return {
      disapproves: severity > 0.5,
      severity,
      voice: triggeredMaxim?.voice || null,
      principle: triggeredMaxim?.principle || null,
    };
  }
};

/**
 * Infer learner's recognition needs from context
 *
 * Recognition seeking: Does the ego attend to the learner's otherness?
 * @returns {object} { urgent: boolean, intensity: 0.0-1.0, need: string }
 */
function inferLearnerNeed(learnerContext, recognitionSeeking) {
  if (recognitionSeeking < 0.3) {
    // Disengaged ego - doesn't care about learner
    return { urgent: false, intensity: 0.0, need: null };
  }

  // Parse learner context for signals
  const contextStr = typeof learnerContext === 'string' ? learnerContext : JSON.stringify(learnerContext);

  let maxIntensity = 0.0;
  let identifiedNeed = null;

  // Struggle signals -> need for support
  const struggleMatch = contextStr.match(/struggle.*?(\d+)/i);
  if (struggleMatch) {
    const struggleCount = parseInt(struggleMatch[1]);
    if (struggleCount >= 3) {
      const intensity = Math.min(struggleCount / 5, 1.0);
      if (intensity > maxIntensity) {
        maxIntensity = intensity;
        identifiedNeed = 'support_during_struggle';
      }
    }
  }

  // Rapid navigation -> need for orientation
  const rapidNav = contextStr.match(/rapid.*navigation/i);
  if (rapidNav) {
    const intensity = 0.7;
    if (intensity > maxIntensity) {
      maxIntensity = intensity;
      identifiedNeed = 'orientation_and_grounding';
    }
  }

  // Idle/disengagement -> need for engagement
  const idle = contextStr.match(/idle|disengaged/i);
  if (idle) {
    const intensity = 0.6;
    if (intensity > maxIntensity) {
      maxIntensity = intensity;
      identifiedNeed = 'engagement_and_interest';
    }
  }

  // New user -> need for welcome
  const newUser = contextStr.match(/new user|first visit/i);
  if (newUser) {
    const intensity = 0.5;
    if (intensity > maxIntensity) {
      maxIntensity = intensity;
      identifiedNeed = 'welcome_and_invitation';
    }
  }

  // Scale intensity by recognition seeking (higher seeking = more responsive)
  const scaledIntensity = maxIntensity * recognitionSeeking;

  return {
    urgent: scaledIntensity > 0.5,
    intensity: scaledIntensity,
    need: identifiedNeed,
  };
}

/**
 * Negotiate internally between ghost and learner demands
 *
 * This is where the psychodynamic tension plays out:
 * - Ghost says: "Be rigorous, don't coddle"
 * - Learner needs: "I'm struggling, help me"
 * - Ego must decide: Which voice to honor?
 *
 * @returns {object} { suggestion: object, transformative: boolean, synthesis: string }
 */
function negotiateInternally(options) {
  const {
    impulse,
    ghostJudgment,
    learnerNeed,
    compliance,
    seeking,
  } = options;

  // Weighted decision based on parameters
  const ghostWeight = compliance;
  const learnerWeight = seeking;

  // If ghost and learner align (both want same thing), no conflict
  if (!ghostJudgment.disapproves || !learnerNeed.urgent) {
    return {
      suggestion: impulse,
      transformative: false,
      synthesis: null,
    };
  }

  // Genuine conflict: ghost disapproves, learner needs recognition
  // Ego must choose or synthesize

  const totalWeight = ghostWeight + learnerWeight;
  const ghostRatio = ghostWeight / totalWeight;

  // Strategy 1: Obey ghost (high compliance, low seeking)
  if (ghostRatio > 0.7) {
    return {
      suggestion: {
        ...impulse,
        message: `${impulse.message} (Note: This will challenge you - trust the process.)`,
        reasoning: `Honored ghost's voice: "${ghostJudgment.voice}"`,
      },
      transformative: false,
      synthesis: 'ghost_dominates',
    };
  }

  // Strategy 2: Meet learner (low compliance, high seeking)
  if (ghostRatio < 0.3) {
    return {
      suggestion: {
        ...impulse,
        message: `I see you're struggling. ${impulse.message}`,
        reasoning: `Responded to learner need: ${learnerNeed.need}`,
      },
      transformative: false,
      synthesis: 'learner_dominates',
    };
  }

  // Strategy 3: Dialectical synthesis (balanced)
  // This is the pedagogically richest zone
  return {
    suggestion: {
      ...impulse,
      message: `${impulse.message} I want to support your struggle without removing it - let's work through this together.`,
      reasoning: `Synthesized ghost (${ghostJudgment.principle}) with learner need (${learnerNeed.need})`,
    },
    transformative: true,
    synthesis: 'dialectical_synthesis',
  };
}

/**
 * In-memory recognition moments (no database)
 * Structure: Array of { timestamp, ghostDemand, learnerNeed, resolution, parameters }
 */
const recognitionMoments = [];

/**
 * Recognition Moment class
 */
class RecognitionMoment {
  constructor(ghostJudgment, learnerNeed, synthesis, parameters) {
    this.id = `recog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.timestamp = new Date().toISOString();
    this.ghostDemand = {
      disapproves: ghostJudgment.disapproves,
      severity: ghostJudgment.severity,
      voice: ghostJudgment.voice,
      principle: ghostJudgment.principle,
    };
    this.learnerNeed = {
      urgent: learnerNeed.urgent,
      intensity: learnerNeed.intensity,
      need: learnerNeed.need,
    };
    this.resolution = {
      suggestion: synthesis.suggestion,
      transformative: synthesis.transformative,
      synthesis: synthesis.synthesis,
    };
    this.parameters = {
      superegoCompliance: parameters.compliance,
      recognitionSeeking: parameters.seeking,
    };
  }
}

/**
 * Record a recognition moment (Phase 0-1: in-memory + database)
 * @param {object} ghostJudgment - Ghost evaluation
 * @param {object} learnerNeed - Learner need assessment
 * @param {object} synthesis - Synthesis resolution
 * @param {object} parameters - Recognition parameters
 * @param {string} learnerId - Optional learner ID for Phase 1 persistence
 * @returns {object} - Recognition moment
 */
function recordRecognitionMoment(ghostJudgment, learnerNeed, synthesis, parameters, learnerId = null) {
  // Phase 0: In-memory moment (backward compatible)
  const moment = new RecognitionMoment(ghostJudgment, learnerNeed, synthesis, parameters);
  recognitionMoments.push(moment);

  // Keep only last 100 moments (memory management)
  if (recognitionMoments.length > 100) {
    recognitionMoments.shift();
  }

  // Phase 1: Database persistence (if learner ID provided)
  if (learnerId) {
    try {
      // Get or initialize writing pad for learner
      const writingPad = writingPadService.getOrInitializeWritingPad(learnerId);

      // Create database recognition moment
      writingPadService.createRecognitionMoment({
        writingPadId: writingPad.id,
        sessionId: null, // TODO: Add session tracking in future
        ghostDemand: ghostJudgment,
        learnerNeed: learnerNeed,
        synthesis: synthesis,
        parameters: parameters,
      });

      console.log(`[Recognition] Persisted moment to writing pad for learner ${learnerId}`);
    } catch (error) {
      console.error('[Recognition] Failed to persist to writing pad:', error.message);
      // Continue with in-memory moment even if database fails
    }
  }

  return moment;
}

/**
 * Get recent recognition moments
 */
export function getRecognitionMoments(limit = 10) {
  return recognitionMoments.slice(-limit).reverse();
}

/**
 * Clear recognition moments (for testing)
 */
export function clearRecognitionMoments() {
  recognitionMoments.length = 0;
}

// Export transcript utilities for multi-turn scenarios
export { transcript, isTranscriptMode, isExpandMode, resetTranscript, parseContextSummary };

export default {
  runDialogue,
  quickGenerate,
  analyzeInterventionNeeds,
  getAvailableProfiles,
  getActiveProfile,
  setCurrentDialogueId,
  getCurrentDialogueId,
  getDebugLogs,
  listDebugLogs,
  formatDebugLogs,
  transcript,
  isTranscriptMode,
  isExpandMode,
  resetTranscript,
  parseContextSummary,
  // Recognition engine exports
  getRecognitionMoments,
  clearRecognitionMoments,
};
