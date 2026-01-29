/**
 * Tutor API Service
 *
 * Provides a programmatic API for the AI tutor, externalizing the study guide
 * features for testing, evaluation, and alternative clients.
 *
 * This service wraps the tutorDialogueEngine and tutorSuggestionEngine,
 * allowing configurable provider/model/hyperparameter combinations per request.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import * as dialogueEngine from './tutorDialogueEngine.js';
import * as configLoader from './tutorConfigLoader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const PROMPTS_DIR = path.join(ROOT_DIR, 'prompts');

// Cache for rubric configuration
let rubricCache = null;
let rubricMtime = null;

/**
 * Load the evaluation rubric configuration
 */
export function loadRubric(forceReload = false) {
  const rubricPath = path.join(CONFIG_DIR, 'evaluation-rubric.yaml');

  try {
    const stats = fs.statSync(rubricPath);
    if (!forceReload && rubricCache && rubricMtime === stats.mtimeMs) {
      return rubricCache;
    }
    rubricMtime = stats.mtimeMs;
  } catch (err) {
    console.warn('Rubric file not found:', err.message);
    return null;
  }

  try {
    const content = fs.readFileSync(rubricPath, 'utf-8');
    rubricCache = yaml.parse(content);
    return rubricCache;
  } catch (err) {
    console.error('Failed to parse rubric:', err.message);
    return null;
  }
}

/**
 * Get a test scenario by ID
 */
export function getScenario(scenarioId) {
  const rubric = loadRubric();
  return rubric?.scenarios?.[scenarioId] || null;
}

/**
 * Get all test scenarios
 */
export function listScenarios() {
  const rubric = loadRubric();
  if (!rubric?.scenarios) return [];

  return Object.entries(rubric.scenarios).map(([id, scenario]) => ({
    id,
    name: scenario.name,
    description: scenario.description,
    isNewUser: scenario.is_new_user,
    minAcceptableScore: scenario.min_acceptable_score,
    // Multi-turn info: total turns = initial + follow-up turns
    turnCount: (scenario.turns?.length || 0) + 1,
    isMultiTurn: Array.isArray(scenario.turns) && scenario.turns.length > 0,
  }));
}

/**
 * Get available configurations from rubric
 */
export function getConfigurations() {
  const rubric = loadRubric();
  return rubric?.configurations || {};
}

/**
 * Get rubric dimensions for evaluation
 */
export function getRubricDimensions() {
  const rubric = loadRubric();
  return rubric?.dimensions || {};
}

/**
 * Build context strings for the tutor API
 * Returns a formatted context object ready for dialogue engine
 */
export function buildContext(learnerContextStr, curriculumContextStr, simulationsContextStr) {
  return {
    learnerContext: learnerContextStr || '',
    curriculumContext: curriculumContextStr || getSampleCurriculum(),
    simulationsContext: simulationsContextStr || getSampleSimulations(),
  };
}

/**
 * Sample curriculum for evaluation scenarios
 */
function getSampleCurriculum() {
  return `### EPOL 479: Machine Spirits (479)
*Exploring AI, Philosophy, and Digital Culture*
Tags: ai, philosophy, education

Lectures:
  1. **Welcome to Machine Learning** (479-lecture-1)
      Topics: Introduction to ML concepts; Human-machine learning synthesis
  2. **Technology and Pedagogy** (479-lecture-2)
      Topics: Educational technology; Learning theories
  3. **Dialectical Learning** (479-lecture-3)
      Topics: Hegelian dialectics; Thesis-antithesis-synthesis
  4. **Algorithmic Governance** (479-lecture-4)
      Topics: AI ethics; Algorithmic decision-making
  5. **Emergence and Complexity** (479-lecture-5)
      Topics: Complex systems; Emergent properties

### EPOL 480: Digital Humanities (480)
*Technology and the Humanities*
Tags: digital-humanities, technology

Lectures:
  1. **Introduction to Digital Humanities** (480-lecture-1)
      Topics: DH foundations; Computational methods
  2. **Text Mining and Analysis** (480-lecture-2)
      Topics: NLP basics; Corpus analysis`;
}

/**
 * Sample simulations for evaluation scenarios
 */
function getSampleSimulations() {
  return `- recognition: Recognition Dynamics (concepts: recognition, self-consciousness)
- alienation: Alienation Patterns (concepts: alienation, labor)
- dialectic: Dialectical Movement (concepts: dialectic, contradiction)`;
}

/**
 * Generate suggestions with explicit configuration
 *
 * This is the main API entry point for evaluation and alternative clients.
 *
 * For evaluation, use profileName to select a pre-configured tutor profile
 * from config/tutor-agents.yaml. This allows testing different provider/model
 * combinations by defining them as profiles.
 *
 * @param {Object} context - The learner/curriculum/simulations context
 * @param {Object} config - Provider/model/hyperparameter configuration
 * @returns {Promise<Object>} Suggestions and metadata
 */
export async function generateSuggestions(context, config = {}) {
  const {
    provider = null,
    model = null,
    egoModel = null, // Override ego model for benchmarking (e.g., "openrouter.haiku")
    hyperparameters = {},
    promptId = 'default',
    profileName = null,
    useDialogue = null,
    maxRounds = null,
    trace = true,
    superegoStrategy = null, // Superego intervention strategy (e.g., 'socratic_challenge')
    outputSize = 'normal', // compact, normal, expanded - affects response verbosity
  } = config;

  const startTime = Date.now();

  // Determine effective profile - either explicit or from provider/model
  // If provider/model are specified without profileName, we use them to find a matching profile
  let effectiveProfileName = profileName;

  // If explicit provider/model but no profile, try to find matching profile
  // or use them directly via the dialogue engine (which falls back to active profile)
  if (!effectiveProfileName && provider && model) {
    // For evaluation purposes, explicit provider/model configs work best when
    // they're defined as profiles in tutor-agents.yaml
    console.log(`[TutorAPI] Using explicit config: ${provider}/${model}`);
  }

  // Determine dialogue settings from profile config
  const dialogueConfig = configLoader.getDialogueConfig(effectiveProfileName);
  const effectiveUseDialogue = useDialogue ?? dialogueConfig?.enabled ?? true;
  const effectiveMaxRounds = maxRounds ?? (effectiveUseDialogue ? (dialogueConfig?.max_rounds ?? 2) : 0);

  try {
    // Run the dialogue engine
    const result = await dialogueEngine.runDialogue(
      {
        learnerContext: context.learnerContext,
        curriculumContext: context.curriculumContext,
        simulationsContext: context.simulationsContext,
      },
      {
        isNewUser: context.isNewUser ?? false,
        profileName: effectiveProfileName,
        egoModel, // Override ego model for benchmarking
        maxRounds: effectiveMaxRounds,
        superegoStrategy, // Pass through superego intervention strategy
        outputSize, // compact, normal, expanded - affects response verbosity
        // Enable trace for transcript/expand mode to ensure complete logging
        trace: trace || dialogueEngine.isTranscriptMode() || dialogueEngine.isExpandMode(),
      }
    );

    const endTime = Date.now();

    // Get effective provider/model from result or profile
    const effectiveProvider = getEffectiveProvider(effectiveProfileName) || provider;
    const effectiveModel = getEffectiveModel(effectiveProfileName) || model;

    return {
      success: true,
      suggestions: result.suggestions || [],
      metadata: {
        provider: effectiveProvider,
        model: effectiveModel,
        hyperparameters: hyperparameters,
        promptId,
        profileName: result.profileName || effectiveProfileName || configLoader.getActiveProfile()?.name,
        latencyMs: endTime - startTime,
        inputTokens: result.metrics?.totalInputTokens || 0,
        outputTokens: result.metrics?.totalOutputTokens || 0,
        dialogueRounds: result.rounds || 0,
        converged: result.converged || false,
        apiCalls: result.metrics?.apiCalls || 0,
        totalCost: result.metrics?.totalCost || 0, // OpenRouter API cost aggregated from all dialogue rounds
        dialogueId: result.dialogueId, // For linking to logs
      },
      dialogueTrace: trace ? result.dialogueTrace : undefined,
    };
  } catch (error) {
    const endTime = Date.now();

    return {
      success: false,
      error: error.message,
      suggestions: [],
      metadata: {
        provider: getEffectiveProvider(effectiveProfileName) || provider,
        model: getEffectiveModel(effectiveProfileName) || model,
        latencyMs: endTime - startTime,
      },
    };
  }
}

/**
 * Quick generation without dialogue (single-pass)
 */
export async function quickGenerate(context, config = {}) {
  return generateSuggestions(context, {
    ...config,
    useDialogue: false,
    maxRounds: 0,
  });
}

/**
 * Run a single evaluation scenario
 *
 * @param {string} scenarioId - The scenario identifier
 * @param {Object} config - Provider/model configuration
 * @returns {Promise<Object>} Scenario result with suggestions and metadata
 */
export async function runScenario(scenarioId, config = {}) {
  const scenario = getScenario(scenarioId);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${scenarioId}`);
  }

  const context = buildContext(
    scenario.learner_context,
    null, // Use default curriculum
    null  // Use default simulations
  );
  context.isNewUser = scenario.is_new_user;

  const result = await generateSuggestions(context, {
    ...config,
    trace: true,
  });

  return {
    scenarioId,
    scenarioName: scenario.name,
    expectedBehavior: scenario.expected_behavior,
    requiredElements: scenario.required_elements || [],
    forbiddenElements: scenario.forbidden_elements || [],
    minAcceptableScore: scenario.min_acceptable_score,
    ...result,
  };
}

/**
 * Run multiple scenarios with a given configuration
 *
 * @param {string[]} scenarioIds - Array of scenario IDs (or 'all')
 * @param {Object} config - Provider/model configuration
 * @returns {Promise<Object>} Aggregated results
 */
export async function runScenarios(scenarioIds, config = {}) {
  const allScenarios = listScenarios();

  // Resolve 'all' to all scenario IDs
  const targetIds = scenarioIds === 'all' || scenarioIds[0] === 'all'
    ? allScenarios.map(s => s.id)
    : scenarioIds;

  const results = [];
  const startTime = Date.now();

  for (const scenarioId of targetIds) {
    try {
      const result = await runScenario(scenarioId, config);
      results.push(result);
    } catch (error) {
      results.push({
        scenarioId,
        success: false,
        error: error.message,
      });
    }
  }

  // Calculate aggregate metrics
  const successfulRuns = results.filter(r => r.success);
  const aggregate = {
    totalScenarios: results.length,
    successfulRuns: successfulRuns.length,
    failedRuns: results.length - successfulRuns.length,
    avgLatencyMs: successfulRuns.length > 0
      ? successfulRuns.reduce((sum, r) => sum + (r.metadata?.latencyMs || 0), 0) / successfulRuns.length
      : 0,
    totalInputTokens: successfulRuns.reduce((sum, r) => sum + (r.metadata?.inputTokens || 0), 0),
    totalOutputTokens: successfulRuns.reduce((sum, r) => sum + (r.metadata?.outputTokens || 0), 0),
    totalApiCalls: successfulRuns.reduce((sum, r) => sum + (r.metadata?.apiCalls || 0), 0),
    avgSuggestions: successfulRuns.length > 0
      ? successfulRuns.reduce((sum, r) => sum + (r.suggestions?.length || 0), 0) / successfulRuns.length
      : 0,
  };

  return {
    config: {
      provider: config.provider,
      model: config.model,
      profileName: config.profileName,
    },
    totalTimeMs: Date.now() - startTime,
    results,
    aggregate,
  };
}

/**
 * Validate a suggestion against scenario expectations
 *
 * @param {Object} suggestion - The suggestion to validate
 * @param {Object} scenario - The scenario with expectations
 * @returns {Object} Validation result
 */
export function validateSuggestion(suggestion, scenario) {
  const validationResult = {
    passesRequired: true,
    passesForbidden: true,
    requiredMissing: [],
    forbiddenFound: [],
  };

  const suggestionText = JSON.stringify(suggestion).toLowerCase();

  // Check required elements
  for (const required of scenario.requiredElements || []) {
    const normalizedRequired = required.toLowerCase();
    // Check if the required element is present (can be partial match)
    const found = suggestionText.includes(normalizedRequired) ||
      (suggestion.actionTarget && suggestion.actionTarget.toLowerCase().includes(normalizedRequired)) ||
      (suggestion.title && suggestion.title.toLowerCase().includes(normalizedRequired)) ||
      (suggestion.message && suggestion.message.toLowerCase().includes(normalizedRequired));

    if (!found) {
      validationResult.passesRequired = false;
      validationResult.requiredMissing.push(required);
    }
  }

  // Check forbidden elements
  for (const forbidden of scenario.forbiddenElements || []) {
    const normalizedForbidden = forbidden.toLowerCase();
    if (suggestionText.includes(normalizedForbidden)) {
      validationResult.passesForbidden = false;
      validationResult.forbiddenFound.push(forbidden);
    }
  }

  return validationResult;
}

/**
 * Get prompt file path for a prompt ID
 */
function getPromptFile(promptId) {
  const promptMap = {
    default: 'tutor-ego.md',
    strict: 'tutor-ego-strict.md',
    supportive: 'tutor-ego-supportive.md',
    minimal: 'tutor-ego-minimal.md',
  };
  return promptMap[promptId] || promptMap.default;
}

/**
 * Get effective provider from profile
 */
function getEffectiveProvider(profileName) {
  const profile = configLoader.getActiveProfile(profileName);
  return profile?.ego?.provider || 'anthropic';
}

/**
 * Get effective model from profile
 */
function getEffectiveModel(profileName) {
  const profile = configLoader.getActiveProfile(profileName);
  const agentConfig = configLoader.getAgentConfig('ego', profileName);
  return agentConfig?.model || 'claude-haiku-4-5';
}

/**
 * List available provider/model configurations
 */
export function listConfigurations() {
  const providers = configLoader.loadProviders();
  const configs = [];

  if (providers) {
    for (const [providerId, provider] of Object.entries(providers)) {
      for (const [alias, modelId] of Object.entries(provider.models || {})) {
        configs.push({
          provider: providerId,
          model: modelId,
          label: `${providerId}/${alias}`,
        });
      }
    }
  }

  return configs;
}

/**
 * List available profiles from tutor config
 */
export function listProfiles() {
  return configLoader.listProfiles();
}

// ══════════════════════════════════════════════════════════════════════════════
// MULTI-TURN CONVERSATION SUPPORT
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build updated context for a follow-up turn in a multi-turn scenario
 *
 * This creates the context for subsequent turns by incorporating:
 * 1. The original learner context
 * 2. The previous suggestion(s) made by the tutor
 * 3. The learner's response/action
 * 4. Any additional context updates from the scenario
 *
 * @param {Object} options - Context update options
 * @param {string} options.originalContext - Initial learner context
 * @param {Object[]} options.conversationHistory - Array of previous turns
 * @param {Object} options.currentTurn - The current turn definition
 * @param {Object} options.previousSuggestion - Last suggestion from tutor
 * @returns {string} Updated context string for the next turn
 */
export function buildMultiTurnContext(options) {
  const {
    originalContext,
    conversationHistory = [],
    currentTurn,
    previousSuggestion,
  } = options;

  const contextParts = [originalContext];

  // Add conversation history
  if (conversationHistory.length > 0) {
    contextParts.push('\n### Conversation History');
    for (const turn of conversationHistory) {
      contextParts.push(formatTurnForContext(turn));
    }
  }

  // Add the previous tutor suggestion
  if (previousSuggestion) {
    contextParts.push('\n### Previous Tutor Suggestion');
    contextParts.push(formatSuggestionForContext(previousSuggestion));
  }

  // Add learner action from current turn
  if (currentTurn?.learner_action) {
    contextParts.push('\n### Learner Action');
    contextParts.push(formatLearnerAction(currentTurn));
  }

  // Add scenario-defined context update
  if (currentTurn?.context_update) {
    contextParts.push('\n' + currentTurn.context_update.trim());
  }

  return contextParts.join('\n');
}

/**
 * Format a previous turn for inclusion in context
 */
function formatTurnForContext(turn) {
  const lines = [];
  lines.push(`\n**Turn ${turn.turnIndex + 1}** (${turn.turnId})`);

  if (turn.suggestion) {
    lines.push(`- Tutor suggested: "${turn.suggestion.title || turn.suggestion.message?.substring(0, 100)}..."`);
    if (turn.suggestion.actionTarget) {
      lines.push(`  - Action: ${turn.suggestion.action} → ${turn.suggestion.actionTarget}`);
    }
  }

  if (turn.learnerAction) {
    lines.push(`- Learner response: ${turn.learnerAction}`);
    if (turn.learnerMessage) {
      lines.push(`  - Message: "${turn.learnerMessage}"`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a suggestion for inclusion in conversation context
 */
function formatSuggestionForContext(suggestion) {
  const lines = [];

  if (suggestion.title) {
    lines.push(`**Title**: ${suggestion.title}`);
  }
  if (suggestion.message) {
    lines.push(`**Message**: ${suggestion.message}`);
  }
  if (suggestion.action && suggestion.actionTarget) {
    lines.push(`**Suggested Action**: ${suggestion.action} → ${suggestion.actionTarget}`);
  }
  if (suggestion.reasoning) {
    lines.push(`**Reasoning**: ${suggestion.reasoning}`);
  }

  return lines.join('\n');
}

/**
 * Format learner action for context
 */
function formatLearnerAction(turn) {
  const action = turn.learner_action;
  const details = turn.action_details || {};
  const lines = [];

  switch (action) {
    case 'followed_suggestion':
      lines.push(`Learner **followed** the suggestion`);
      if (details.action_taken) {
        lines.push(`- Action: ${details.action_taken}`);
      }
      break;

    case 'ignored_suggestion':
      lines.push(`Learner **did not follow** the suggestion`);
      if (details.explicit_rejection) {
        lines.push(`- Explicitly rejected`);
      }
      break;

    case 'asked_followup':
      lines.push(`Learner **asked a follow-up question**`);
      break;

    case 'reported_confusion':
      lines.push(`Learner **reported confusion**`);
      break;

    case 'completed_activity':
      lines.push(`Learner **completed an activity**`);
      if (details.activity_id) {
        lines.push(`- Activity: ${details.activity_id}`);
      }
      if (details.success !== undefined) {
        lines.push(`- Success: ${details.success}`);
      }
      if (details.score !== undefined) {
        lines.push(`- Score: ${details.score}%`);
      }
      break;

    default:
      lines.push(`Learner action: ${action}`);
  }

  // Add message if present
  if (details.message) {
    lines.push(`\n**Learner said**: "${details.message}"`);
  }

  return lines.join('\n');
}

/**
 * Format learner action for transcript display (cleaner format for CLI)
 */
function formatLearnerActionForTranscript(turn) {
  const action = turn.learner_action;
  const details = turn.action_details || {};
  const lines = [];

  // Action type with emoji
  const actionLabels = {
    'followed_suggestion': '✓ Followed suggestion',
    'ignored_suggestion': '✗ Ignored suggestion',
    'asked_followup': '❓ Asked follow-up question',
    'reported_confusion': '😕 Reported confusion',
    'completed_activity': '✅ Completed activity',
    'navigated_away': '🔄 Navigated away',
    'requested_hint': '💡 Requested hint',
  };

  lines.push(actionLabels[action] || `Action: ${action}`);

  // Show relevant details
  if (details.action_taken) {
    lines.push(`  → ${details.action_taken}`);
  }
  if (details.activity_id) {
    lines.push(`  Activity: ${details.activity_id}`);
  }
  if (details.success !== undefined) {
    lines.push(`  Success: ${details.success ? 'Yes' : 'No'}`);
  }
  if (details.score !== undefined) {
    lines.push(`  Score: ${details.score}%`);
  }

  // Message from learner (this is the "user request" part)
  if (details.message) {
    lines.push(`\n  "${details.message}"`);
  }

  return lines.join('\n');
}

/**
 * Check if a scenario has multi-turn configuration
 */
export function isMultiTurnScenario(scenarioId) {
  const scenario = getScenario(scenarioId);
  return scenario?.turns && Array.isArray(scenario.turns) && scenario.turns.length > 0;
}

/**
 * Get turn definitions for a multi-turn scenario
 */
export function getScenarioTurns(scenarioId) {
  const scenario = getScenario(scenarioId);
  return scenario?.turns || [];
}

/**
 * Run a complete multi-turn scenario
 *
 * @param {string} scenarioId - The scenario identifier
 * @param {Object} config - Provider/model configuration
 * @returns {Promise<Object>} Multi-turn scenario results
 */
export async function runMultiTurnScenario(scenarioId, config = {}) {
  const scenario = getScenario(scenarioId);
  if (!scenario) {
    throw new Error(`Unknown scenario: ${scenarioId}`);
  }

  const turns = scenario.turns || [];

  // Create a SINGLE dialogue ID for the entire multi-turn conversation
  const dialogueId = `dialogue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Set the dialogue ID for the entire multi-turn session
  dialogueEngine.setCurrentDialogueId(dialogueId);

  const results = {
    scenarioId,
    scenarioName: scenario.name,
    isMultiTurn: turns.length > 0,
    totalTurns: turns.length + 1, // Include initial turn
    turnResults: [],
    conversationHistory: [],
    dialogueId, // Single dialogue ID for all turns
  };

  // Run initial turn (turn 0)
  const initialContext = buildContext(scenario.learner_context);
  initialContext.isNewUser = scenario.is_new_user;

  const initialResult = await generateSuggestions(initialContext, {
    ...config,
    trace: true,
    _dialogueId: dialogueId, // Pass dialogue ID to continue same session
    _skipLogging: true, // Skip logging - we'll consolidate all turns at the end
  });

  // Validate initial result
  if (!initialResult || !initialResult.suggestions) {
    throw new Error(`Multi-turn scenario ${scenarioId}: Initial turn failed to generate suggestions`);
  }

  results.turnResults.push({
    turnIndex: 0,
    turnId: 'initial',
    context: scenario.learner_context,
    expectedBehavior: scenario.expected_behavior,
    requiredElements: scenario.required_elements || [],
    forbiddenElements: scenario.forbidden_elements || [],
    ...initialResult,
    metadata: {
      ...initialResult.metadata,
      dialogueId, // Override with continuous dialogue ID
    },
  });

  // Track conversation history
  let conversationHistory = [];
  let previousSuggestion = initialResult.suggestions?.[0];

  // Run follow-up turns
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];

    // Show learner action in transcript mode
    if (dialogueEngine.isTranscriptMode()) {
      dialogueEngine.transcript('LEARNER ACTION', formatLearnerActionForTranscript(turn));
    }

    // Add previous turn to history
    conversationHistory.push({
      turnIndex: i,
      turnId: i === 0 ? 'initial' : turns[i - 1]?.id,
      suggestion: previousSuggestion,
      learnerAction: turn.learner_action,
      learnerMessage: turn.action_details?.message,
    });

    // Build updated context for this turn
    const updatedContextStr = buildMultiTurnContext({
      originalContext: scenario.learner_context,
      conversationHistory,
      currentTurn: turn,
      previousSuggestion,
    });

    const turnContext = buildContext(updatedContextStr);
    turnContext.isNewUser = false; // Multi-turn implies returning user

    // Generate suggestions for this turn - CONTINUE THE SAME DIALOGUE
    const turnResult = await generateSuggestions(turnContext, {
      ...config,
      trace: true,
      _dialogueId: dialogueId, // Continue same dialogue session
      _skipLogging: true, // Skip logging - we'll consolidate all turns at the end
    });

    // Validate turn result
    if (!turnResult || !turnResult.suggestions) {
      throw new Error(`Multi-turn scenario ${scenarioId}: Turn ${i + 1} (${turn.id}) failed to generate suggestions`);
    }

    results.turnResults.push({
      turnIndex: i + 1,
      turnId: turn.id,
      learnerAction: turn.learner_action,
      actionDetails: turn.action_details,
      context: updatedContextStr,
      expectedBehavior: turn.expected_behavior,
      requiredElements: turn.required_elements || [],
      forbiddenElements: turn.forbidden_elements || [],
      minAcceptableScore: turn.min_acceptable_score,
      ...turnResult,
      metadata: {
        ...turnResult.metadata,
        dialogueId, // Override with continuous dialogue ID
      },
    });

    // Update for next iteration
    previousSuggestion = turnResult.suggestions?.[0];
  }

  results.conversationHistory = conversationHistory;

  // Consolidate all dialogue traces from all turns into a single continuous log
  const consolidatedTrace = [];
  const consolidatedMetrics = {
    totalLatencyMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    apiCalls: 0,
    generationIds: [],
  };

  for (let i = 0; i < results.turnResults.length; i++) {
    const turn = results.turnResults[i];

    // Insert user turn action entry before each turn (except initial)
    if (i > 0) {
      const historyEntry = conversationHistory[i];
      const userMessage = historyEntry?.learnerMessage || `${historyEntry?.learnerAction || 'Action'}`;

      consolidatedTrace.push({
        agent: 'user',
        action: 'turn_action',
        turnIndex: i,
        contextSummary: userMessage,
        detail: `Learner: ${historyEntry?.learnerAction}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Accumulate dialogue traces
    if (turn.dialogueTrace && turn.dialogueTrace.length > 0) {
      consolidatedTrace.push(...turn.dialogueTrace);
    }

    // Add final delivery to user for this turn (ONLY for multi-agent mode)
    // In single-agent mode, the ego's last action already goes to the user
    // Check if this turn had superego involvement by looking at dialogue trace
    const hasSuperego = turn.dialogueTrace?.some(entry => entry.agent === 'superego');

    if (hasSuperego) {
      // Multi-agent mode: add explicit final_output entry
      // This is needed because ego→superego exchanges don't show final delivery
      const suggestionCount = turn.suggestions?.length || 0;
      consolidatedTrace.push({
        agent: 'user',
        action: 'final_output',
        turnIndex: i,
        from: 'ego',
        to: 'user',
        direction: 'response',
        suggestionCount,
        contextSummary: `Delivered ${suggestionCount} suggestion${suggestionCount !== 1 ? 's' : ''}`,
        detail: `Turn ${i + 1} complete`,
        timestamp: new Date().toISOString(),
      });
    }
    // In single-agent mode, the last ego entry already has to='user', so no extra entry needed

    // Accumulate metrics
    if (turn.metrics) {
      consolidatedMetrics.totalLatencyMs += turn.metrics.totalLatencyMs || 0;
      consolidatedMetrics.totalInputTokens += turn.metrics.totalInputTokens || 0;
      consolidatedMetrics.totalOutputTokens += turn.metrics.totalOutputTokens || 0;
      consolidatedMetrics.totalCost += turn.metrics.totalCost || 0;
      consolidatedMetrics.apiCalls += turn.metrics.apiCalls || 0;
      if (turn.metrics.generationIds) {
        consolidatedMetrics.generationIds.push(...turn.metrics.generationIds);
      }
    }
  }

  // Write consolidated dialogue log (single continuous transcript for all turns)
  const lastTurn = results.turnResults[results.turnResults.length - 1];
  const profileName = config.profileName || lastTurn?.profileName || 'default';
  const consolidatedDialogue = {
    suggestions: lastTurn?.suggestions || [],
    dialogueTrace: consolidatedTrace,
    converged: lastTurn?.converged || false,
    rounds: results.turnResults.reduce((sum, t) => sum + (t.rounds || 0), 0),
    metrics: consolidatedMetrics,
    dialogueId,
    profileName,
    provider: getEffectiveProvider(profileName),
    model: getEffectiveModel(profileName),
    learnerContext: scenario.learner_context,
    isMultiTurn: true,
    totalTurns: results.totalTurns,
    turnResults: results.turnResults.map(t => ({
      turnIndex: t.turnIndex,
      turnId: t.turnId,
      suggestions: t.suggestions,
      rounds: t.rounds,
    })),
  };

  // Write consolidated dialogue log (fs, path, etc. already imported at top)
  const LOGS_DIR = path.join(ROOT_DIR, 'logs', 'tutor-dialogues');

  // Ensure logs directory exists
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  // Write consolidated dialogue log
  const logPath = path.join(LOGS_DIR, `${dialogueId}.json`);
  fs.writeFileSync(logPath, JSON.stringify(consolidatedDialogue, null, 2));

  return results;
}

export default {
  loadRubric,
  getScenario,
  listScenarios,
  getConfigurations,
  getRubricDimensions,
  buildContext,
  generateSuggestions,
  quickGenerate,
  runScenario,
  runScenarios,
  validateSuggestion,
  listConfigurations,
  listProfiles,
  // Multi-turn support
  buildMultiTurnContext,
  isMultiTurnScenario,
  getScenarioTurns,
  runMultiTurnScenario,
};
