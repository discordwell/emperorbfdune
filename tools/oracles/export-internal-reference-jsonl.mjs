#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateMissionOracleDataset } from './lib/reference-compare.mjs';
import { writeJsonLines } from './lib/reference-jsonl.mjs';
import { rowsFromMissionOracleDataset } from './lib/reference-jsonl-compare.mjs';

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
    'Usage: node tools/oracles/export-internal-reference-jsonl.mjs ' +
    '[--oracle <tok_mission_oracle.v1.json>] [--scripts all|fast] ' +
    '[--output <capture.jsonl>] [--compact] [--no-final]',
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compactRow(row) {
  return {
    s: row.scriptId,
    t: row.tick,
    mt: row.maxTick,
    fc: row.frameCount,
    fh: row.frameHash,
    ih: row.intHash,
    oh: row.objHash,
    ph: row.posHash,
    rh: row.relHash,
    eh: row.eventHash,
    dh: row.dispatchHash,
  };
}

const repoRoot = process.cwd();
const oracleFile = argValue(
  '--oracle',
  path.join(repoRoot, 'tests/campaign/tok/oracles/tok_mission_oracle.v1.json'),
);
const scripts = argValue('--scripts', 'fast');
const outputFile = argValue(
  '--output',
  path.join(repoRoot, 'tools/oracles/reference/tok_capture_internal.jsonl'),
);
const compact = hasFlag('--compact');
const includeFinal = !hasFlag('--no-final');

if (!['all', 'fast'].includes(scripts)) {
  usage();
  console.error(`--scripts must be all|fast, got ${scripts}`);
  process.exit(2);
}

if (!fs.existsSync(oracleFile)) {
  usage();
  console.error(`Oracle file not found: ${oracleFile}`);
  process.exit(2);
}

const dataset = readJson(oracleFile);
const validation = validateMissionOracleDataset(dataset, 'oracle');
if (!validation.valid) {
  console.error('[export-jsonl] Oracle schema validation failed.');
  for (const err of validation.errors) {
    console.error(`[export-jsonl] ${err}`);
  }
  process.exit(2);
}

const rows = rowsFromMissionOracleDataset(dataset, {
  scripts,
  includeFinal,
});
const outRows = compact ? rows.map(compactRow) : rows;
writeJsonLines(outputFile, outRows);

console.log(
  `[export-jsonl] Wrote ${outRows.length} rows (${scripts}, includeFinal=${String(includeFinal)}, compact=${String(compact)}): ${outputFile}`,
);
