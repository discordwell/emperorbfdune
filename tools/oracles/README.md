# Behavior Oracles

This folder contains the pipeline for cross-implementation behavior checks.

## Internal deterministic oracles

- Mission oracle fixture: `tests/campaign/tok/oracles/tok_mission_oracle.v1.json`
- Branch scenario fixture: `tests/campaign/tok/oracles/tok_branch_oracle.v1.json`

Regenerate:

```bash
npm run oracle:update
```

Verify:

```bash
npm run oracle:fast
npm run oracle:full
```

## External reference import

Place a normalized reference file at:

`tools/oracles/reference/tok_mission_oracle.reference.v1.json`

End-to-end workflow driver:

```bash
npm run oracle:reference:workflow:prepare
npm run oracle:reference:workflow:status
npm run oracle:reference:workflow:finalize
```

Detailed tranche plan/runbook:

- `tools/oracles/reference/EXTERNAL_CAPTURE_PLAN.md`

### 1) Build capture manifest

```bash
npm run oracle:reference:manifest
```

This writes `tools/oracles/reference/tok_capture_manifest.v1.json` with expected missions, max ticks, and checkpoint ticks.

Optional C/C++ hook helper header:

```bash
npm run oracle:reference:hook-header
```

See `tools/oracles/reference/HOOK_INTEGRATION_GUIDE.md` for runtime hook integration.

### 2) Extract hook lines from game logs (optional)

If your hook logs prefixed JSON frames (for example `TOKTRACE {...}`):

```bash
npm run oracle:reference:extract -- \
  --input /path/to/game.log \
  --output /path/to/capture_part1.jsonl \
  --prefix TOKTRACE
```

Trace line format is documented in `tools/oracles/reference/TRACE_FORMAT.md`.

Optional internal baseline export (for pipeline self-check):

```bash
npm run oracle:reference:export-internal
```

### 3) Merge capture shards (optional)

```bash
npm run oracle:reference:merge -- \
  --inputs /path/to/captures \
  --output tools/oracles/reference/tok_capture_merged.jsonl \
  --report-out artifacts/oracle-diffs/reference_merge.report.json
```

### 4) Validate raw JSONL coverage

```bash
npm run oracle:reference:validate -- \
  --input tools/oracles/reference/tok_capture_merged.jsonl \
  --require-all-missions \
  --require-expected-max-tick \
  --require-manifest-checkpoints \
  --report-out artifacts/oracle-diffs/reference_jsonl_validation.report.json
```

Optional progress report:

```bash
npm run oracle:reference:progress -- \
  --input tools/oracles/reference/tok_capture_merged.jsonl \
  --strict \
  --report-out artifacts/oracle-diffs/reference_capture_progress.report.json
```

### 5) Normalize JSONL -> oracle dataset

```bash
node tools/oracles/normalize-reference-jsonl.mjs \
  --input tools/oracles/reference/tok_capture_merged.jsonl \
  --output tools/oracles/reference/tok_mission_oracle.reference.v1.json \
  --report-out artifacts/oracle-diffs/reference_normalize.report.json
```

### 6) Compare reference vs internal

```bash
npm run oracle:reference:compare
```

The compare command now emits:

- `artifacts/oracle-diffs/reference_vs_internal.report.json` (always)
- `artifacts/oracle-diffs/reference_vs_internal.diff.json` (only on mismatch)

For CI-hard failure on mismatches with required full-corpus reference coverage:

```bash
npm run oracle:reference:strict
```

Advanced flags:

- `--require-reference`: fail if the reference file is missing
- `--require-all-missions`: fail if mission sets differ
- `--min-coverage <0..1>`: require minimum reference mission coverage

### 7) Replay runtime against external reference

This step replays the current interpreter and compares checkpoint hashes against the external reference:

```bash
npm run oracle:reference:runtime
```

Strict full-corpus mode (fails if the reference file is missing):

```bash
npm run oracle:reference:runtime:strict
```

Optional env flags:

- `TOK_REFERENCE_REQUIRE=1`: fail when reference file is missing
- `TOK_REFERENCE_FULL=1`: replay all missions present in the reference dataset
- `TOK_REFERENCE_MAX_MISSIONS=<N>`: cap mission count for local debug runs

### 8) Compare raw reference JSONL rows against internal oracle hashes

This step compares captured JSONL rows directly (script+tick hash signals) against rows derived from `tests/campaign/tok/oracles/tok_mission_oracle.v1.json`.

Fast mode:

```bash
npm run oracle:reference:jsonl-compare
```

Strict full-corpus gate:

```bash
npm run oracle:reference:jsonl-strict
```

If your hook rows contain raw object IDs in payload fields (`objVars`, `eventFlags`, `dispatch`), add `--canonicalize-object-ids` to compare after mission-local ID normalization.

If your hook rows also use side IDs that differ from internal runtime IDs, add `--canonicalize-side-ids` (or use both flags together):

```bash
npm run oracle:reference:jsonl-compare:canon-ids
```

Quick self-check (internal export + strict compare):

```bash
npm run oracle:reference:jsonl-selfcheck
```
