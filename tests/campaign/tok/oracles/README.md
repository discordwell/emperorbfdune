# Tok Behavior Oracle Tiers

## Tier 1: VM/Dispatch checkpoint oracle

Source: `TokMissionOracle.test.ts`

Signals per checkpoint:

- Full frame hash (tok vars, relationships, event flags, dispatch state)
- Component hashes for `intVars`, `objVars`, `posVars`, relationships, events, dispatch

Scope:

- Fast matrix on PR/push (`fastScripts` in fixture)
- Full 229-script corpus in nightly/full runs

## Tier 2: Branch scenario oracle

Source: `TokBranchOracle.test.ts`

Scenarios:

- Startup cash one-shot behavior
- Wave progression thresholds and guards
- Save/restore guard continuity
- House start mission matrix
- `unit:attacked` event bridge semantics
- ATTutorial save/restore final-state parity

## Tier 3: External reference oracle pipeline

Runtime parity test:

- `tests/campaign/tok/TokReferenceRuntimeOracle.test.ts`

Tools:

- `tools/oracles/normalize-reference-jsonl.mjs`
- `tools/oracles/compare-reference.mjs`
- `tools/oracles/build-capture-manifest.mjs`
- `tools/oracles/extract-reference-log-lines.mjs`
- `tools/oracles/merge-reference-jsonl.mjs`
- `tools/oracles/validate-reference-jsonl.mjs`
- `tools/oracles/check-capture-progress.mjs`

Purpose:

- Ingest original-game traces
- Normalize to mission-oracle schema
- Diff against internal oracle with first-diff artifact output
- Replay current interpreter against external checkpoint captures
- Enforce optional strict gates: required reference file, full mission-set match, and coverage thresholds

## Tier 4: ECS simulation-hash oracle

Source: `TokSimulationHashOracle.test.ts`

Signals:

- Canonical ECS simulation hash checkpoints at fixed intervals for representative missions
- Fast matrix on PR and full matrix in nightly/full runs
