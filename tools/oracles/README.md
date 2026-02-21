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

### 1) Build capture manifest

```bash
npm run oracle:reference:manifest
```

This writes `tools/oracles/reference/tok_capture_manifest.v1.json` with expected missions, max ticks, and checkpoint ticks.

### 2) Extract hook lines from game logs (optional)

If your hook logs prefixed JSON frames (for example `TOKTRACE {...}`):

```bash
npm run oracle:reference:extract -- \
  --input /path/to/game.log \
  --output /path/to/capture_part1.jsonl \
  --prefix TOKTRACE
```

Trace line format is documented in `tools/oracles/reference/TRACE_FORMAT.md`.

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
  --report-out artifacts/oracle-diffs/reference_jsonl_validation.report.json
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
