#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildCaptureProgress } from './lib/capture-progress.mjs';
import { readJsonLines, writeJsonFile } from './lib/reference-jsonl.mjs';

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
    'Usage: node tools/oracles/check-capture-progress.mjs ' +
    '--input <capture.jsonl> [--manifest <tok_capture_manifest.v1.json>] [--report-out <report.json>] [--strict]',
  );
}

const repoRoot = process.cwd();
const inputFile = argValue('--input');
const manifestFile = argValue(
  '--manifest',
  path.join(repoRoot, 'tools/oracles/reference/tok_capture_manifest.v1.json'),
);
const reportOut = argValue(
  '--report-out',
  path.join(repoRoot, 'artifacts/oracle-diffs/reference_capture_progress.report.json'),
);
const strict = hasFlag('--strict');

if (!inputFile) {
  usage();
  process.exit(2);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Input file not found: ${inputFile}`);
  process.exit(2);
}

if (!fs.existsSync(manifestFile)) {
  console.error(`Manifest file not found: ${manifestFile}`);
  process.exit(2);
}

const rows = readJsonLines(inputFile);
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const progress = buildCaptureProgress(rows, manifest);

const report = {
  inputFile,
  manifestFile,
  strict,
  ...progress,
};
if (reportOut) {
  writeJsonFile(reportOut, report);
}

const summary = [
  `missions ${progress.completeMissionCount}/${progress.missionCount}`,
  `missionCoverage=${progress.missionCoverage.toFixed(4)}`,
  `checkpoints ${progress.capturedCheckpoints}/${progress.requiredCheckpoints}`,
  `checkpointCoverage=${progress.checkpointCoverage.toFixed(4)}`,
  `unexpectedMissions=${progress.unexpectedMissions.length}`,
];
console.log(`[progress] ${summary.join(' | ')}`);

const incomplete = progress.missions
  .filter((m) => !m.complete)
  .sort((a, b) => a.completion - b.completion || a.scriptId.localeCompare(b.scriptId))
  .slice(0, 10);
for (const mission of incomplete) {
  console.log(
    `[progress] missing ${mission.scriptId}: ` +
    `${mission.capturedCheckpoints}/${mission.requiredCheckpoints} checkpoints` +
    ` (missing ticks: ${mission.missingTicks.slice(0, 8).join(',')}${mission.missingTicks.length > 8 ? ',...' : ''})`,
  );
}

if (strict && (progress.completeMissionCount !== progress.missionCount || progress.unexpectedMissions.length > 0)) {
  process.exit(1);
}
