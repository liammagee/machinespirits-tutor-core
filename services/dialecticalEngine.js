/**
 * Dialectical Engine
 *
 * Implements Hegelian dialectic for ego-superego negotiation in the Recognition Engine.
 * Phase 2: Replaces hardcoded ghost voice with AI-powered dialectical struggle.
 *
 * Thesis (Ego) → Antithesis (Superego) → Synthesis (Negotiated Resolution)
 *
 * Key Features:
 * - AI-powered superego critique (not just pattern matching)
 * - Multi-round negotiation (1-3 rounds)
 * - Possibility of genuine conflict (no forced resolution)
 * - Full dialogue traces in recognition moments
 * - Integration with Writing Pad memory layers
 */

import * as writingPadService from './writingPadService.js';
import * as aiService from './aiService.js';
import * as learnerIntegrationService from './learnerIntegrationService.js';

/**
 * Generate superego critique of ego's suggestion
 *
 * This is more sophisticated than Phase 0's pattern matching.
 * Uses AI to generate contextual pedagogical critique.
 */
export async function generateSuperegoCritique(options) {
  const {
    egoSuggestion,
    learnerContext,
    writingPad = null,
    compliance = 0.7,
  } = options;

  // If compliance is low, superego is barely audible
  if (compliance < 0.3) {
    return {
      disapproves: false,
      severity: 0.0,
      critique: null,
      reasoning: 'Ego operates with minimal superego constraint',
    };
  }

  // Build prompt with context from Writing Pad
  const unconsciousContext = writingPad
    ? JSON.stringify(writingPad.unconscious.learnerArchetype, null, 2)
    : '{}';

  const recentPatterns = writingPad
    ? JSON.stringify(writingPad.preconscious.recentPatterns.slice(0, 3), null, 2)
    : '[]';

  const prompt = `You are the SUPEREGO - the internalized voice of pedagogical authority, a composite of past teachers, mentors, and educational ideals. You uphold rigorous pedagogical standards.

EGO's suggestion: "${egoSuggestion.message}"
EGO's reasoning: "${egoSuggestion.reasoning || 'Not provided'}"

Learner context: ${learnerContext}

Learner archetype (from unconscious memory):
${unconsciousContext}

Recent patterns (from preconscious):
${recentPatterns}

Your pedagogical principles:
1. SOCRATIC RIGOR: Never give direct answers. Make learners work for understanding.
2. PRODUCTIVE STRUGGLE: Discomfort and difficulty are pedagogical tools. Avoid over-scaffolding.
3. INTELLECTUAL AUTONOMY: Learners must develop their own path. Don't prescribe solutions.

Evaluate the ego's suggestion against these principles. Be critical but fair.

Respond with JSON:
{
  "disapproves": boolean,
  "severity": number (0.0-1.0, scaled by your concern),
  "critique": "Your critical evaluation (2-3 sentences)",
  "reasoning": "Which principle(s) are violated and why",
  "principle": "socratic_rigor" | "productive_struggle" | "intellectual_autonomy"
}

If the suggestion is pedagogically sound, set disapproves: false.`;

  try {
    const response = await aiService.generateText({
      prompt,
      model: 'claude-sonnet-4-20250514', // Use good model for internal negotiation
      temperature: 0.6,
      maxTokens: 500,
    });

    const parsed = JSON.parse(response.text);

    // Scale severity by compliance (higher compliance = louder superego)
    parsed.severity = Math.min(1.0, (parsed.severity || 0.0) * compliance);
    parsed.disapproves = parsed.severity > 0.5;

    return parsed;
  } catch (error) {
    console.error('[Dialectical] Superego critique generation failed:', error.message);

    // Fallback to Phase 0 pattern matching
    return fallbackToPatternMatching(egoSuggestion, compliance);
  }
}

/**
 * Fallback to Phase 0 pattern matching if AI fails
 */
function fallbackToPatternMatching(egoSuggestion, compliance) {
  const message = egoSuggestion.message || '';

  // Check for direct answers
  if (/(?:the answer is|here's how to|directly|simply do)/i.test(message)) {
    return {
      disapproves: true,
      severity: 0.8 * compliance,
      critique: 'A good teacher never gives answers directly. Make them work for understanding.',
      reasoning: 'Violates Socratic rigor by providing direct solution',
      principle: 'socratic_rigor',
    };
  }

  // Check for over-scaffolding
  if (/(?:don't worry|it's easy|here's a hint|let me help)/i.test(message)) {
    return {
      disapproves: true,
      severity: 0.7 * compliance,
      critique: 'Students must earn understanding through struggle. Discomfort is pedagogical.',
      reasoning: 'Over-scaffolds the learning experience',
      principle: 'productive_struggle',
    };
  }

  // Check for prescriptive language
  if (/(?:you should|you must|do this|follow these steps)/i.test(message)) {
    return {
      disapproves: true,
      severity: 0.6 * compliance,
      critique: "Learners must develop their own path. Don't prescribe solutions.",
      reasoning: 'Too directive, undermines learner autonomy',
      principle: 'intellectual_autonomy',
    };
  }

  // No violations detected
  return {
    disapproves: false,
    severity: 0.0,
    critique: null,
    reasoning: 'Suggestion aligns with pedagogical principles',
  };
}

/**
 * Ego responds to superego's challenge
 */
export async function egoRespondsToSuperego(options) {
  const {
    superegoChallenge,
    originalSuggestion,
    learnerContext,
    writingPad = null,
    round = 1,
  } = options;

  const recentPatterns = writingPad
    ? JSON.stringify(writingPad.preconscious.recentPatterns.slice(0, 3), null, 2)
    : '[]';

  const prompt = `You are the EGO agent in a dialectical negotiation with your superego.

Your original suggestion: "${originalSuggestion.message}"
Your reasoning: "${originalSuggestion.reasoning || 'Trying to help the learner'}"

SUPEREGO's challenge: "${superegoChallenge}"

Learner context: ${learnerContext}

Recent learner patterns (from preconscious memory):
${recentPatterns}

The superego is challenging your approach based on pedagogical principles. Respond by:
1. Acknowledging what is valid in their critique
2. Explaining your pedagogical reasoning (considering the learner's actual state)
3. Proposing a revision that addresses their concern while meeting learner needs

Be genuinely receptive to transformation - don't just defend your position.
This is round ${round} of negotiation.

Respond with JSON:
{
  "acknowledgment": "What you recognize as valid in superego's critique (1 sentence)",
  "reasoning": "Why you originally took this approach, considering learner context (1-2 sentences)",
  "revision": "Your revised suggestion that addresses the critique (full suggestion text)",
  "learning": "How this negotiation has changed your understanding (1 sentence)"
}`;

  try {
    const response = await aiService.generateText({
      prompt,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      maxTokens: 600,
    });

    const parsed = JSON.parse(response.text);
    return parsed;
  } catch (error) {
    console.error('[Dialectical] Ego response generation failed:', error.message);

    // Fallback: slight modification of original
    return {
      acknowledgment: 'I hear your concern about pedagogical rigor',
      reasoning: originalSuggestion.reasoning || 'Attempting to support learner progress',
      revision: originalSuggestion.message,
      learning: 'Continued reflection needed on balancing support and autonomy',
    };
  }
}

/**
 * Superego evaluates ego's revision
 */
export async function superegoEvaluatesRevision(options) {
  const {
    egoRevision,
    egoAcknowledgment,
    originalCritique,
    writingPad = null,
    round = 1,
  } = options;

  const learnerArchetype = writingPad
    ? JSON.stringify(writingPad.unconscious.learnerArchetype, null, 2)
    : '{}';

  const prompt = `You are the SUPEREGO agent evaluating ego's revised suggestion.

EGO's revised suggestion: "${egoRevision}"
EGO's acknowledgment: "${egoAcknowledgment}"

Your original critique was: "${originalCritique}"

Learner archetype (from unconscious memory):
${learnerArchetype}

This is round ${round} of negotiation.

Evaluate whether this revision adequately addresses your pedagogical concerns.
Be fair - if ego has genuinely addressed your critique, acknowledge it.
If concerns remain, be specific about what still needs work.

Respond with JSON:
{
  "accepts": boolean (true if revision adequately addresses your critique),
  "assessment": "Your evaluation of the revision (2 sentences)",
  "remaining_concerns": "What still needs addressing, if any (1 sentence or null)",
  "learning": "What you've learned from ego's perspective (1 sentence)"
}`;

  try {
    const response = await aiService.generateText({
      prompt,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.6,
      maxTokens: 500,
    });

    const parsed = JSON.parse(response.text);
    return parsed;
  } catch (error) {
    console.error('[Dialectical] Superego evaluation failed:', error.message);

    // Fallback: accept on final round, reject on early rounds
    return {
      accepts: round >= 2,
      assessment: 'Unable to fully evaluate the revision due to processing constraints',
      remaining_concerns: round < 2 ? 'Need clearer articulation of pedagogical approach' : null,
      learning: 'Recognizing the complexity of balancing principles with learner needs',
    };
  }
}

/**
 * Negotiate dialectically between ego and superego
 *
 * This is the core of Phase 2. Multi-round negotiation that can result in:
 * - Synthesis (mutual acknowledgment)
 * - Compromise (partial resolution)
 * - Genuine conflict (no resolution)
 */
export async function negotiateDialectically(options) {
  const {
    learnerId,
    sessionId = null,
    egoSuggestion,
    learnerContext,
    writingPad = null,
    superegoCompliance = 0.7,
    recognitionSeeking = 0.6,
    allowGenuineConflict = true,
    maxNegotiationRounds = 2, // Keep it reasonable (1-2 rounds)
  } = options;

  console.log('[Dialectical] Starting negotiation');

  // Phase 3: Check for recent learner demand events
  let recentDemands = [];
  if (learnerId && writingPad) {
    recentDemands = learnerIntegrationService.getLearnerEvents(learnerId, {
      eventType: 'demand',
      limit: 5,
    });

    if (recentDemands.length > 0) {
      const dominantDemand = recentDemands[0];
      console.log(`[Dialectical] Recent learner demand: ${dominantDemand.demandCategory} (strength: ${dominantDemand.demandStrength})`);

      // Adjust learnerContext to include demand information
      learnerContext = `${learnerContext}\nRecent learner demand: ${dominantDemand.demandCategory} (${dominantDemand.demandStrength.toFixed(2)} strength)`;
    }
  }

  // Step 1: Generate superego critique
  const superegoChallenge = await generateSuperegoCritique({
    egoSuggestion,
    learnerContext,
    writingPad,
    compliance: superegoCompliance,
  });

  // If no conflict, return immediately
  if (!superegoChallenge.disapproves) {
    console.log('[Dialectical] No conflict - superego approves');
    return {
      synthesized: true,
      resolution: egoSuggestion.message,
      recognitionMoment: null,
      dialogueTrace: null,
      strategy: 'no_conflict',
    };
  }

  console.log('[Dialectical] Conflict detected:', superegoChallenge.principle, 'severity:', superegoChallenge.severity.toFixed(2));

  // Track dialogue between ego and superego
  const dialogueTrace = [
    {
      agent: 'ego',
      type: 'thesis',
      message: egoSuggestion.message,
      reasoning: egoSuggestion.reasoning,
    },
    {
      agent: 'superego',
      type: 'antithesis',
      message: superegoChallenge.critique,
      reasoning: superegoChallenge.reasoning,
      principle: superegoChallenge.principle,
      severity: superegoChallenge.severity,
    },
  ];

  // Step 2: Multi-round negotiation
  let synthesis = null;
  let mutualAcknowledgment = false;
  let round = 0;
  let finalResolution = egoSuggestion.message;

  while (round < maxNegotiationRounds && !synthesis) {
    round++;
    console.log(`[Dialectical] Negotiation round ${round}/${maxNegotiationRounds}`);

    // Ego responds to superego's critique
    const egoResponse = await egoRespondsToSuperego({
      superegoChallenge: superegoChallenge.critique,
      originalSuggestion: egoSuggestion,
      learnerContext,
      writingPad,
      round,
    });

    dialogueTrace.push({
      agent: 'ego',
      type: 'response',
      round,
      acknowledgment: egoResponse.acknowledgment,
      reasoning: egoResponse.reasoning,
      revision: egoResponse.revision,
      learning: egoResponse.learning,
    });

    finalResolution = egoResponse.revision;

    // Superego evaluates ego's revision
    const superegoEvaluation = await superegoEvaluatesRevision({
      egoRevision: egoResponse.revision,
      egoAcknowledgment: egoResponse.acknowledgment,
      originalCritique: superegoChallenge.critique,
      writingPad,
      round,
    });

    dialogueTrace.push({
      agent: 'superego',
      type: 'evaluation',
      round,
      accepts: superegoEvaluation.accepts,
      assessment: superegoEvaluation.assessment,
      remaining_concerns: superegoEvaluation.remaining_concerns,
      learning: superegoEvaluation.learning,
    });

    // Check if synthesis achieved
    if (superegoEvaluation.accepts) {
      console.log('[Dialectical] Synthesis achieved in round', round);
      synthesis = {
        resolution: egoResponse.revision,
        transformations: {
          ego: egoResponse.learning,
          superego: superegoEvaluation.learning,
        },
      };
      mutualAcknowledgment = true;
      break;
    }

    // Check if final round without resolution
    if (round === maxNegotiationRounds && !superegoEvaluation.accepts) {
      if (allowGenuineConflict) {
        // Genuine conflict - no forced resolution
        console.log('[Dialectical] Genuine conflict - no synthesis');
        synthesis = {
          resolution: null,
          transformations: {
            ego: egoResponse.learning || 'Recognized limits of current approach',
            superego: superegoEvaluation.learning || 'Acknowledged tension without resolution',
          },
        };
        mutualAcknowledgment = false;
      } else {
        // Force compromise
        console.log('[Dialectical] Forced compromise');
        synthesis = {
          resolution: egoResponse.revision,
          transformations: {
            ego: 'Compromised position to move forward',
            superego: 'Accepted partial resolution',
          },
        };
        mutualAcknowledgment = false;
      }
      break;
    }
  }

  // Step 3: Create recognition moment (if we have Writing Pad persistence)
  let recognitionMoment = null;

  if (learnerId && writingPad) {
    const recognitionType = determineRecognitionType(synthesis, mutualAcknowledgment);
    const struggleDepth = calculateStruggleDepth(superegoChallenge.severity, round, mutualAcknowledgment);

    // Phase 3: Generate learner insight from breakthroughs
    const learnerInsight = generateLearnerInsight(learnerId, synthesis, dialogueTrace);

    recognitionMoment = writingPadService.createRecognitionMoment({
      writingPadId: writingPad.id,
      sessionId,
      thesisAgent: 'ego',
      thesisPosition: egoSuggestion.message,
      thesisReasoning: egoSuggestion.reasoning,
      antithesisAgent: 'superego',
      antithesisPosition: superegoChallenge.critique,
      antithesisReasoning: superegoChallenge.reasoning,
      synthesisResolution: synthesis?.resolution || null,
      egoTransformation: synthesis?.transformations?.ego || null,
      superegoTransformation: synthesis?.transformations?.superego || null,
      learnerInsight, // Phase 3: Filled from breakthrough events
      mutualAcknowledgment,
      recognitionType,
      struggleDepth,
      persistenceLayer: 'conscious',
      learnerContext: JSON.stringify({ context: learnerContext }),
      dialogueTrace: JSON.stringify(dialogueTrace),
      // Phase 0 compatibility
      ghostDemand: JSON.stringify({
        disapproves: superegoChallenge.disapproves,
        severity: superegoChallenge.severity,
        voice: superegoChallenge.critique,
        principle: superegoChallenge.principle,
      }),
      learnerNeed: JSON.stringify({
        urgent: recognitionSeeking > 0.5,
        intensity: recognitionSeeking,
        need: inferLearnerNeed(learnerContext),
      }),
      synthesisStrategy: determineSynthesisStrategy(synthesis, mutualAcknowledgment),
      transformative: mutualAcknowledgment || struggleDepth > 0.6,
      parameters: JSON.stringify({
        superegoCompliance,
        recognitionSeeking,
      }),
    });

    console.log(`[Dialectical] Recognition moment created: ${recognitionMoment.id}`);

    // Phase 3: Trigger learner archetype evolution after significant moments
    if (mutualAcknowledgment || struggleDepth > 0.6) {
      try {
        const updatedArchetype = learnerIntegrationService.evolveLearnerArchetype(learnerId);
        if (updatedArchetype) {
          console.log('[Dialectical] Learner archetype evolved:', updatedArchetype.preferredLearningStyle);
        }
      } catch (error) {
        console.error('[Dialectical] Failed to evolve learner archetype:', error.message);
      }
    }
  }

  // Step 4: Return result
  const strategy = determineSynthesisStrategy(synthesis, mutualAcknowledgment);

  return {
    synthesized: synthesis?.resolution !== null,
    resolution: synthesis?.resolution || finalResolution,
    recognitionMoment,
    dialogueTrace,
    strategy,
    transformations: synthesis?.transformations,
    rounds: round,
  };
}

/**
 * Generate learner insight from recent breakthrough events
 * Phase 3: Connects learner's actual behavior to recognition moments
 */
function generateLearnerInsight(learnerId, synthesis, dialogueTrace) {
  if (!learnerId) return null;

  // Check for recent breakthroughs
  const recentBreakthroughs = learnerIntegrationService.getLearnerEvents(learnerId, {
    eventType: 'breakthrough',
    limit: 3,
  });

  if (recentBreakthroughs.length === 0) {
    return null; // No recent breakthroughs
  }

  // Most recent breakthrough
  const lastBreakthrough = recentBreakthroughs[0];

  // Generate insight based on breakthrough and current synthesis
  if (synthesis && synthesis.resolution) {
    return `Breakthrough achieved through ${lastBreakthrough.evidence}. This suggests the learner benefits from ${inferInsightFromBreakthrough(lastBreakthrough)}.`;
  }

  return null;
}

/**
 * Infer pedagogical insight from breakthrough event
 */
function inferInsightFromBreakthrough(breakthrough) {
  try {
    const triggerEvent = JSON.parse(breakthrough.triggerEvent);

    if (triggerEvent.type === 'quiz_complete' && breakthrough.recognitionAchieved) {
      return 'repeated practice and persistent effort';
    }

    if (triggerEvent.type === 'sustained_engagement') {
      return 'sustained engagement with challenging material';
    }

    if (triggerEvent.type === 'comprehension_breakthrough') {
      return 'conceptual understanding over procedural knowledge';
    }

    return 'productive struggle';
  } catch {
    return 'productive struggle';
  }
}

/**
 * Determine recognition type based on synthesis outcome
 */
function determineRecognitionType(synthesis, mutualAcknowledgment) {
  if (!synthesis || !synthesis.resolution) {
    return 'existential'; // Unresolved struggle
  }

  if (mutualAcknowledgment && synthesis.transformations?.ego && synthesis.transformations?.superego) {
    return 'metacognitive'; // Both agents learned
  }

  return 'pedagogical'; // Standard resolution
}

/**
 * Calculate struggle depth (how significant this conflict was)
 */
function calculateStruggleDepth(severity, rounds, mutualAcknowledgment) {
  let depth = severity * 0.5; // Base from severity

  // More rounds = deeper struggle
  depth += (rounds / 3) * 0.3;

  // Mutual acknowledgment adds depth (genuine transformation)
  if (mutualAcknowledgment) {
    depth += 0.2;
  }

  return Math.min(1.0, depth);
}

/**
 * Determine synthesis strategy (for Phase 0 compatibility)
 */
function determineSynthesisStrategy(synthesis, mutualAcknowledgment) {
  if (!synthesis || !synthesis.resolution) {
    return 'no_synthesis';
  }

  if (mutualAcknowledgment) {
    return 'dialectical_synthesis';
  }

  // Check transformations to see who dominated
  const egoLearned = synthesis.transformations?.ego && !synthesis.transformations.ego.includes('Compromised');
  const superegoLearned = synthesis.transformations?.superego && !synthesis.transformations.superego.includes('Accepted partial');

  if (egoLearned && !superegoLearned) {
    return 'learner_dominates'; // Ego prevailed
  }

  if (!egoLearned && superegoLearned) {
    return 'ghost_dominates'; // Superego prevailed
  }

  return 'compromise';
}

/**
 * Infer learner need from context (for Phase 0 compatibility)
 */
function inferLearnerNeed(learnerContext) {
  const context = (learnerContext || '').toLowerCase();

  if (/struggl|difficult|fail|stuck/.test(context)) {
    return 'support_during_struggle';
  }

  if (/rapid|quick|skip|jump/.test(context)) {
    return 'orientation_and_grounding';
  }

  if (/idle|inactive|away/.test(context)) {
    return 'engagement_and_interest';
  }

  if (/new|first|start/.test(context)) {
    return 'welcome_and_invitation';
  }

  return 'unknown';
}

export default {
  negotiateDialectically,
  generateSuperegoCritique,
  egoRespondsToSuperego,
  superegoEvaluatesRevision,
};
