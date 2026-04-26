# Changelog

All notable changes to `@machinespirits/tutor-core` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.3] — 2026-04-26

### Fixed

- **`shouldConsolidateToUnconscious` parsed SQLite `created_at` as local time, silently breaking consolidation on non-UTC hosts.** SQLite's `CURRENT_TIMESTAMP` writes `YYYY-MM-DD HH:MM:SS` with no timezone marker (UTC). JavaScript's `Date` constructor parses unmarked strings as *local* time, so on any non-UTC host the parsed `created_at` ended up offset into the future relative to `Date.now()`, `age` went negative, and `age < minAge` returned `true` — silently skipping consolidation forever. Fix appends `Z` to unmarked timestamps before parsing. ([7174e28](https://github.com/machinespirits/tutor-core/commit/7174e28))

  Surfaced by the eval repo's A7 Phase 2 longitudinal study (machinespirits-eval), where `recognition_moments` rows accumulated correctly during dialogue but `writing_pads.unconscious_state.permanentTraces` stayed empty across all 8 sessions — even with `minAge: 0` passed to `runBackgroundMaintenance`. After the fix, calling `runBackgroundMaintenance(learnerId, { consolidation: { minAge: 0, requireTransformative: false } })` correctly settles all eligible moments to `unconscious`.

### Known issues (unchanged from 0.5.2)

- **`recognitionOrchestrator.processDialogueResult` is not called from `tutorDialogueEngine.runDialogue`.** The orchestrator is the integration point that records dialogue thoughts to `conscious_state.workingThoughts` and triggers the per-turn memory cycle that promotes patterns to preconscious and queries unconscious context. Without it being invoked from the dialogue engine, the conscious layer stays empty and `autoPromotePatterns` (which reads from `conscious_state.workingThoughts`) finds nothing to promote.

  Consumers that want full pad-layer population during dialogue must invoke the orchestrator themselves. The eval repo (machinespirits-eval) calls `runBackgroundMaintenance` at session boundaries with `minAge: 0` as a workaround for cross-session recognition_moment consolidation — see `services/evaluationRunner.js` `runSingleTest`. A future tutor-core version should wire the orchestrator into `tutorDialogueEngine.runDialogue` directly so production deployments don't need to know about this integration gap.

## [0.5.2] — earlier

Prior history not retroactively captured. See `git log` for commit-level detail.
