#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCaptureProgress,
} from './lib/capture-progress.mjs';
import {
  readJsonLines,
  validateReferenceRows,
  writeJsonFile,
} from './lib/reference-jsonl.mjs';

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function usage() {
  console.log(
    'Usage: node tools/oracles/validate-reference-jsonl.mjs ' +
    '--input <capture.jsonl> [--expected-oracle <tok_mission_oracle.v1.json>] ' +
    '[--manifest <tok_capture_manifest.v1.json>] [--report-out <report.json>] ' +
    '[--require-all-missions] [--require-expected-max-tick] [--require-manifest-checkpoints]',
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const repoRoot = process.cwd();
const inputFile = argValue('--input');
const expectedOracle = argValue(
  '--expected-oracle',
  path.join(repoRoot, 'tests/campaign/tok/oracles/tok_mission_oracle.v1.json'),
);
const manifestFile = argValue(
  '--manifest',
  path.join(repoRoot, 'tools/oracles/reference/tok_capture_manifest.v1.json'),
);
const reportOut = argValue(
  '--report-out',
  path.join(repoRoot, 'artifacts/oracle-diffs/reference_jsonl_validation.report.json'),
);

const requireAllMissions = hasFlag('--require-all-missions');
const requireExpectedMaxTick = hasFlag('--require-expected-max-tick');
const requireTickZero = !hasFlag('--allow-missing-tick-zero');
const strict = hasFlag('--strict');
const requireManifestCheckpoints = hasFlag('--require-manifest-checkpoints');

if (!inputFile) {
  usage();
  process.exit(2);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Input file not found: ${inputFile}`);
  process.exit(2);
}

let expectedMissionMax = {};
if (expectedOracle && fs.existsSync(expectedOracle)) {
  const expected = readJson(expectedOracle);
  expectedMissionMax = Object.fromEntries(
    Object.entries(expected.missions ?? {}).map(([scriptId, mission]) => [scriptId, mission.maxTick]),
  );
} else if (requireAllMissions || requireExpectedMaxTick) {
  console.error(`Expected oracle file not found: ${expectedOracle}`);
  process.exit(2);
}

const rows = readJsonLines(inputFile);
const result = validateReferenceRows(rows, {
  expectedMissionMax,
  requireAllMissions,
  requireExpectedMaxTick,
  requireTickZero,
});

const report = {
  inputFile,
  expectedOracle: fs.existsSync(expectedOracle) ? expectedOracle : null,
  strict,
  requireAllMissions,
  requireExpectedMaxTick,
  requireTickZero,
  requireManifestCheckpoints,
  ...result,
};

if (requireManifestCheckpoints) {
  if (!manifestFile || !fs.existsSync(manifestFile)) {
    console.error(`Manifest file not found: ${manifestFile}`);
    process.exit(2);
  }
  const manifest = readJson(manifestFile);
  const progress = buildCaptureProgress(rows, manifest);
  report.manifestFile = manifestFile;
  report.manifestCheckpointCoverage = progress.checkpointCoverage;
  report.manifestMissionCoverage = progress.missionCoverage;
  report.manifestIncompleteMissions = progress.missions
    .filter((m) => !m.complete)
    .map((m) => m.scriptId);

  if (progress.missions.some((m) => !m.complete)) {
    result.ok = false;
    result.errors.push('Manifest checkpoint coverage incomplete');
  }
}

if (reportOut) {
  writeJsonFile(reportOut, report);
}

if (result.warnings.length > 0) {
  for (const warning of result.warnings) {
    console.warn(`[validate] ${warning}`);
  }
}

if (!result.ok) {
  for (const error of result.errors) {
    console.error(`[validate] ${error}`);
  }
  process.exit(2);
}

if (strict && result.warnings.length > 0) {
  process.exit(1);
}

console.log(`Reference JSONL validation passed (${rows.length} rows, coverage=${result.coverage.toFixed(4)}).`);
