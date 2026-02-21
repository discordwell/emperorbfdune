#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCaptureManifestFromOracleDataset,
  writeJsonFile,
} from './lib/reference-jsonl.mjs';

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function usage() {
  console.log(
    'Usage: node tools/oracles/build-capture-manifest.mjs ' +
    '[--oracle <tok_mission_oracle.v1.json>] [--scripts all|fast] [--output <manifest.json>]',
  );
}

const repoRoot = process.cwd();
const oracleFile = argValue(
  '--oracle',
  path.join(repoRoot, 'tests/campaign/tok/oracles/tok_mission_oracle.v1.json'),
);
const scripts = argValue('--scripts', 'all');
const outputFile = argValue(
  '--output',
  path.join(repoRoot, 'tools/oracles/reference/tok_capture_manifest.v1.json'),
);

if (scripts !== 'all' && scripts !== 'fast') {
  usage();
  process.exit(2);
}

if (!fs.existsSync(oracleFile)) {
  console.error(`Missing oracle file: ${oracleFile}`);
  process.exit(2);
}

const oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8'));
const manifest = buildCaptureManifestFromOracleDataset(oracle, { scripts });
writeJsonFile(outputFile, manifest);

console.log(`Wrote capture manifest (${manifest.missionCount} missions): ${outputFile}`);
