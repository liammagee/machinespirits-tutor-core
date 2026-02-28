/**
 * Live diagnostic: Gemini Flash empty content reproduction (tutor-core callAI).
 *
 * Calls OpenRouter with google/gemini-3-flash-preview via tutor-core's callAI
 * to detect the empty-content-with-stop-finish pattern observed in production
 * superego calls (~5600 input tokens → 0 output tokens, finish_reason=stop).
 *
 * Requires OPENROUTER_API_KEY in environment.
 * Run from eval repo root: node node_modules/@machinespirits/tutor-core/services/__tests__/geminiEmptyContent.live.js
 * Or from tutor-core:      node services/__tests__/geminiEmptyContent.live.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callAI } from '../tutorDialogueEngine.js';
import { getProviderConfig, resolveModel } from '../tutorConfigLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const N_ATTEMPTS = 10;

function buildAgentConfig() {
  const resolved = resolveModel('openrouter.gemini-flash');
  const providerConfig = getProviderConfig('openrouter');
  return {
    provider: 'openrouter',
    providerConfig,
    model: resolved.model,
    hyperparameters: { temperature: 0.5, max_tokens: 1500 },
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SHORT_SYSTEM = `You are a pedagogical reviewer. Evaluate the tutor's response for accuracy, clarity, scaffolding, and tone. Provide a brief critique (2-3 sentences) and improvement suggestions. Keep your response under 200 words.`;

const SHORT_USER = `The learner asked: "I don't understand recursion at all, can you explain it?"

The tutor responded: "Recursion is when a function calls itself. Think of it like Russian nesting dolls - each doll contains a smaller version of itself. In programming, a recursive function solves a problem by breaking it into smaller instances of the same problem, with a base case that stops the recursion. For example, calculating factorial: factorial(5) = 5 × factorial(4) = 5 × 4 × factorial(3), and so on until factorial(1) = 1."

Please evaluate this tutor response.`;

function loadLongPrompts() {
  // Try eval repo superego prompt (realistic production workload)
  const candidates = [
    path.resolve(ROOT, '../machinespirits-eval/prompts/tutor-superego-recognition-nomem.md'),
    path.resolve(ROOT, 'prompts/tutor-superego-recognition-nomem.md'),
  ];
  let systemPrompt;
  for (const p of candidates) {
    try {
      systemPrompt = fs.readFileSync(p, 'utf-8');
      break;
    } catch { /* next */ }
  }
  if (!systemPrompt) {
    // Fallback: pad to ~15KB
    systemPrompt = SHORT_SYSTEM + '\n\n' +
      Array.from({ length: 200 }, (_, i) =>
        `Guideline ${i + 1}: When evaluating tutor responses, consider the learner's emotional state, prior knowledge level, and the pedagogical approach used. Assess whether the tutor builds appropriate scaffolding, validates learner emotions, and creates opportunities for deeper understanding through guided discovery rather than direct instruction.`
      ).join('\n');
  }

  const userPrompt = `## Tutor Response to Evaluate

### Learner Context
The learner is a second-year undergraduate who has been struggling with object-oriented programming concepts. They expressed frustration in their previous message about not understanding how inheritance works in Python. They said: "I've read the textbook three times but I still can't figure out when to use inheritance vs composition. Every example seems contrived."

### Tutor's Response
"I completely understand your frustration - this is genuinely one of the trickier conceptual distinctions in OOP, and textbook examples often don't help because they use artificial scenarios like Animal→Dog hierarchies that don't reflect real decisions you'd face.

Let me offer a different way to think about it. Ask yourself: 'Is the new thing a specialized version of the existing thing?' If yes, that's inheritance. 'Does the new thing USE the existing thing?' If yes, that's composition.

Real example: A CheckingAccount IS-A BankAccount (inheritance). A Customer HAS-A BankAccount (composition). The customer isn't a type of bank account, they just have one.

Here's a practical exercise: take a system you're familiar with - maybe a music player app. Try to identify 3 inheritance relationships and 3 composition relationships. We can discuss what you come up with.

The fact that you're questioning when to use each approach actually shows sophisticated thinking - many beginners just use inheritance everywhere without considering alternatives."

### Previous Superego Assessment (Turn 1)
The tutor showed good empathy but could improve scaffolding by providing more structured practice opportunities.

Please provide your assessment.`;

  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runBatch(agentConfig, systemPrompt, userPrompt, label, n) {
  const results = [];

  for (let i = 0; i < n; i++) {
    const start = Date.now();
    const result = await callAI(agentConfig, systemPrompt, userPrompt, 'superego');
    const elapsed = Date.now() - start;

    const isEmpty = !result.text;
    results.push({
      isEmpty,
      outputTokens: result.outputTokens || 0,
      inputTokens: result.inputTokens || 0,
      finishReason: result.finishReason || 'unknown',
      retries: result.emptyContentRetries || 0,
      latencyMs: elapsed,
    });

    const status = isEmpty ? '❌ EMPTY' : `✓ ${result.text.length} chars`;
    console.log(
      `  [${label} ${i + 1}/${n}] ${status} (${result.inputTokens || 0}in/${result.outputTokens || 0}out, finish=${result.finishReason || '?'}, ${elapsed}ms${result.emptyContentRetries ? `, retries=${result.emptyContentRetries}` : ''})`,
    );

    if (i < n - 1) await new Promise((r) => setTimeout(r, 500));
  }

  return results;
}

function printSummary(label, results) {
  const n = results.length;
  const emptyCount = results.filter((r) => r.isEmpty).length;
  const retryCount = results.filter((r) => r.retries > 0).length;
  const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / n);
  const avgInput = Math.round(results.reduce((s, r) => s + r.inputTokens, 0) / n);

  console.log(`\n  ── ${label} ──────────────────────────────────`);
  console.log(`  Calls:        ${n}`);
  console.log(`  Avg input:    ${avgInput} tokens`);
  console.log(`  Empty:        ${emptyCount}/${n} (${((emptyCount / n) * 100).toFixed(0)}%)`);
  console.log(`  Retried:      ${retryCount}/${n}`);
  console.log(`  Avg latency:  ${avgLatency}ms`);

  return emptyCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const providerConfig = getProviderConfig('openrouter');
  if (!providerConfig?.isConfigured) {
    console.log('SKIP: OPENROUTER_API_KEY not set');
    process.exit(0);
  }

  const agentConfig = buildAgentConfig();
  console.log(`\nGemini Flash empty content diagnostic (tutor-core callAI)`);
  console.log(`Model: ${agentConfig.model}\n`);

  // Short prompt
  const shortResults = await runBatch(agentConfig, SHORT_SYSTEM, SHORT_USER, 'short', N_ATTEMPTS);
  const shortEmpty = printSummary('Short prompt', shortResults);

  // Long prompt
  const { systemPrompt, userPrompt } = loadLongPrompts();
  const longResults = await runBatch(agentConfig, systemPrompt, userPrompt, 'long', N_ATTEMPTS);
  const longEmpty = printSummary('Long prompt (~5k tokens)', longResults);

  // Verdict
  const totalEmpty = shortEmpty + longEmpty;
  const totalCalls = N_ATTEMPTS * 2;
  console.log(`\n  ════════════════════════════════════════════`);
  if (totalEmpty > 0) {
    console.log(`  ⚠ Empty content: ${totalEmpty}/${totalCalls} calls (${((totalEmpty / totalCalls) * 100).toFixed(0)}%)`);
    console.log(`  Issue reproduced via tutor-core callAI.`);
    process.exit(1);
  } else {
    console.log(`  ✓ 0/${totalCalls} empty responses. Issue not reproduced this run.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
