# External Capture Plan

This is the execution plan for building a full external `.tok` capture dataset and gating parity against the current interpreter.

## Objective

Produce:

- `tools/oracles/reference/tok_capture_merged.jsonl`
- `tools/oracles/reference/tok_mission_oracle.reference.v1.json`

Then pass strict checks:

- `npm run oracle:reference:jsonl-strict`
- `npm run oracle:reference:strict`
- `npm run oracle:reference:runtime:strict`

## Phase 1: Prepare Capture Inputs

1. Generate mission/checkpoint manifest and hook header:

```bash
npm run oracle:reference:workflow:prepare
```

Artifacts:

- `tools/oracles/reference/tok_capture_manifest.v1.json`
- `tools/oracles/reference/tok_capture_manifest.generated.h`
- `artifacts/oracle-diffs/reference_capture_plan.report.json`

## Phase 2: Capture In Tranches

1. Run the original runtime hook and emit `TOKTRACE` JSON lines.
2. Extract and merge JSONL capture shards:

```bash
npm run oracle:reference:extract -- --input /path/to/game.log --output /path/to/captures/part_001.jsonl --prefix TOKTRACE
npm run oracle:reference:merge -- --inputs /path/to/captures --output tools/oracles/reference/tok_capture_merged.jsonl
```

3. Recompute progress and get the next tranche:

```bash
npm run oracle:reference:workflow:status
```

Loop Phase 2 until:

- `completeMissionCount == missionCount`
- checkpoint coverage is `1.0`

## Phase 3: Finalize + Gate

Finalize normalized reference dataset and strict data parity:

```bash
npm run oracle:reference:workflow:finalize
```

Then run strict gates:

```bash
npm run oracle:reference:jsonl-strict
npm run oracle:reference:strict
npm run oracle:reference:runtime:strict
```

## Exit Criteria

All are true:

- External capture manifest coverage complete.
- No validation errors in capture rows.
- No dataset diff (`reference` vs `internal`).
- No row-level strict diff (with canonicalized object+side IDs as needed).
- Runtime strict parity passes across full reference mission set.
