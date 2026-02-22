#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateMissionOracleDataset } from './lib/reference-compare.mjs';
import {
  canonicalizeReferenceRowsObjectIds,
  readJsonLines,
  writeJsonFile,
} from './lib/reference-jsonl.mjs';
import {
  compareReferenceSignalRows,
  rowsFromMissionOracleDataset,
} from './lib/reference-jsonl-compare.mjs';

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function usage() {
  console.log(
    'Usage: node tools/oracles/compare-reference-jsonl.mjs ' +
    '--reference <capture.jsonl> [--expected-oracle <tok_mission_oracle.v1.json>] ' +
    '[--scripts all|fast] [--min-coverage <0..1>] [--strict] ' +
    '[--require-reference] [--require-all-expected-rows] [--canonicalize-object-ids] ' +
    '[--report-out <report.json>] [--diff-out <diff.json>]',
  );
}

const repoRoot = process.cwd();
const referenceFile = argValue(
  '--reference',
  path.join(repoRoot, 'tools/oracles/reference/tok_capture_merged.jsonl'),
);
const expectedOracleFile = argValue(
  '--expected-oracle',
  path.join(repoRoot, 'tests/campaign/tok/oracles/tok_mission_oracle.v1.json'),
);
const scripts = argValue('--scripts', 'fast');
const minCoverage = Number(argValue('--min-coverage', '0'));
const strict = hasFlag('--strict');
const requireReference = hasFlag('--require-reference');
const requireAllExpectedRows = hasFlag('--require-all-expected-rows');
const canonicalizeObjectIds = hasFlag('--canonicalize-object-ids');
const reportOut = argValue(
  '--report-out',
  path.join(repoRoot, 'artifacts/oracle-diffs/reference_jsonl_vs_internal.report.json'),
);
const diffOut = argValue(
  '--diff-out',
  path.join(repoRoot, 'artifacts/oracle-diffs/reference_jsonl_vs_internal.diff.json'),
);

if (!['all', 'fast'].includes(scripts)) {
  usage();
  console.error(`--scripts must be all|fast, got: ${scripts}`);
  process.exit(2);
}

if (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) {
  usage();
  console.error(`--min-coverage must be in [0,1], got: ${String(minCoverage)}`);
  process.exit(2);
}

if (!fs.existsSync(expectedOracleFile)) {
  console.error(`[oracle-jsonl] Missing expected oracle file: ${expectedOracleFile}`);
  process.exit(2);
}

const expectedOracle = readJson(expectedOracleFile);
const expectedValidation = validateMissionOracleDataset(expectedOracle, 'expected');
if (!expectedValidation.valid) {
  writeJsonFile(reportOut, {
    status: 'invalid-expected-oracle',
    expectedOracleFile,
    referenceFile,
    errors: expectedValidation.errors,
  });
  console.error('[oracle-jsonl] Expected oracle schema validation failed.');
  process.exit(2);
}

if (!fs.existsSync(referenceFile)) {
  writeJsonFile(reportOut, {
    status: 'missing-reference-jsonl',
    expectedOracleFile,
    referenceFile,
    scripts,
    strict,
    requireReference,
  });
  if (strict || requireReference) {
    console.error(`[oracle-jsonl] Missing reference JSONL: ${referenceFile}`);
    process.exit(2);
  }
  console.log(`[oracle-jsonl] No reference JSONL found at ${referenceFile}; skipping compare.`);
  process.exit(0);
}

const referenceRows = readJsonLines(referenceFile);
const compareRows = canonicalizeObjectIds
  ? canonicalizeReferenceRowsObjectIds(referenceRows)
  : referenceRows;
const expectedRows = rowsFromMissionOracleDataset(expectedOracle, {
  scripts,
  includeFinal: true,
});
const result = compareReferenceSignalRows(compareRows, expectedRows, {
  requireAllExpectedRows,
  minCoverage,
});

const report = {
  status: result.diff ? 'mismatch' : 'match',
  referenceFile,
  expectedOracleFile,
  scripts,
  strict,
  requireReference,
  requireAllExpectedRows,
  canonicalizeObjectIds,
  minCoverage,
  ...result,
};
writeJsonFile(reportOut, report);

if (result.diff) {
  writeJsonFile(diffOut, result.diff);
  console.error(`[oracle-jsonl] Reference JSONL mismatch: ${result.diff.path}`);
  if (strict) process.exit(1);
  process.exit(0);
}

if (fs.existsSync(diffOut)) fs.unlinkSync(diffOut);
console.log('[oracle-jsonl] Reference JSONL matches expected oracle rows.');
