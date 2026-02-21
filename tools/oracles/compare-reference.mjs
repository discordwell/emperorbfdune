#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  compareMissionOracleDatasets,
  validateMissionOracleDataset,
} from './lib/reference-compare.mjs';

function argValue(flag, fallback) {
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

function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, value) {
  ensureDirFor(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const repoRoot = process.cwd();
const internalFile = argValue(
  '--internal',
  path.join(repoRoot, 'tests/campaign/tok/oracles/tok_mission_oracle.v1.json'),
);
const referenceFile = argValue(
  '--reference',
  path.join(repoRoot, 'tools/oracles/reference/tok_mission_oracle.reference.v1.json'),
);
const diffOut = argValue(
  '--diff-out',
  path.join(repoRoot, 'artifacts/oracle-diffs/reference_vs_internal.diff.json'),
);
const reportOut = argValue(
  '--report-out',
  path.join(repoRoot, 'artifacts/oracle-diffs/reference_vs_internal.report.json'),
);
const strict = hasFlag('--strict');
const requireReference = hasFlag('--require-reference');
const requireAllMissions = hasFlag('--require-all-missions');
const minCoverage = Number(argValue('--min-coverage', '0'));

if (!fs.existsSync(internalFile)) {
  console.error(`[oracle] Missing internal oracle file: ${internalFile}`);
  process.exit(2);
}

const internal = readJson(internalFile);
const internalValidation = validateMissionOracleDataset(internal, 'internal');
if (!internalValidation.valid) {
  writeJson(reportOut, {
    status: 'invalid-internal',
    internalFile,
    referenceFile,
    strict,
    errors: internalValidation.errors,
  });
  console.error('[oracle] Internal oracle schema validation failed.');
  process.exit(2);
}

if (!fs.existsSync(referenceFile)) {
  writeJson(reportOut, {
    status: 'missing-reference',
    internalFile,
    referenceFile,
    strict,
    requireReference,
  });
  if (strict && requireReference) {
    console.error(`[oracle] Missing reference oracle file: ${referenceFile}`);
    process.exit(2);
  }
  console.log(`[oracle] No reference oracle found at ${referenceFile}; skipping external compare.`);
  process.exit(0);
}

const reference = readJson(referenceFile);
const referenceValidation = validateMissionOracleDataset(reference, 'reference');
if (!referenceValidation.valid) {
  writeJson(reportOut, {
    status: 'invalid-reference',
    internalFile,
    referenceFile,
    strict,
    errors: referenceValidation.errors,
  });
  console.error('[oracle] Reference oracle schema validation failed.');
  process.exit(2);
}

if (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) {
  console.error(`[oracle] --min-coverage must be in [0, 1], got ${String(minCoverage)}`);
  process.exit(2);
}

const result = compareMissionOracleDatasets(reference, internal, {
  requireAllMissions,
  minCoverage,
});

const report = {
  status: result.diff ? 'mismatch' : 'match',
  strict,
  requireReference,
  requireAllMissions,
  minCoverage,
  internalFile,
  referenceFile,
  referenceMissionCount: Object.keys(reference.missions).length,
  internalMissionCount: Object.keys(internal.missions).length,
  comparedMissionCount: result.comparedMissionIds.length,
  coverage: result.coverage,
  missingInInternal: result.missingInInternal,
  missingInReference: result.missingInReference,
  diff: result.diff,
};
writeJson(reportOut, report);

if (result.diff) {
  writeJson(diffOut, result.diff);
  console.error('[oracle] Reference mismatch detected.');
  console.error(`[oracle] First diff path: ${result.diff.path}`);
  if (strict) process.exit(1);
  process.exit(0);
}

if (fs.existsSync(diffOut)) fs.unlinkSync(diffOut);
console.log('[oracle] Reference oracle matches internal oracle.');
