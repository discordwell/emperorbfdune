#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  buildMissionOracleDatasetFromRows,
  mergeRows,
  readJsonLines,
  validateReferenceRows,
  writeJsonFile,
} from './lib/reference-jsonl.mjs';

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function usage() {
  console.log(
    'Usage: node tools/oracles/normalize-reference-jsonl.mjs ' +
    '--input <file.jsonl> --output <file.json> [--report-out <report.json>] [--strict-conflicts]',
  );
}

const inputFile = argValue('--input');
const outputFile = argValue('--output');
const reportOut = argValue('--report-out');
const stride = Number(argValue('--stride', '20'));
const seed = Number(argValue('--seed', '9001'));
const defaultMaxTick = Number(argValue('--default-max-tick', '80'));
const headerMaxTick = Number(argValue('--header-max-tick', '8'));
const strictConflicts = process.argv.includes('--strict-conflicts');
const requireTickZero = !process.argv.includes('--allow-missing-tick-zero');

if (!inputFile || !outputFile) {
  usage();
  process.exit(2);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Input file not found: ${inputFile}`);
  process.exit(2);
}

if (!Number.isFinite(stride) || stride <= 0) {
  console.error(`--stride must be a positive number, got ${String(stride)}`);
  process.exit(2);
}

const rawRows = readJsonLines(inputFile);
const merged = mergeRows(rawRows, {
  prefer: 'last',
  strictConflicts,
});

const validate = validateReferenceRows(merged.rows, {
  requireTickZero,
});
const report = {
  inputFile,
  outputFile,
  strictConflicts,
  requireTickZero,
  merge: {
    inputRows: rawRows.length,
    mergedRows: merged.rows.length,
    conflicts: merged.conflicts.length,
  },
  validate,
};

if (reportOut) {
  writeJsonFile(reportOut, report);
}

if (!validate.ok) {
  for (const err of validate.errors) console.error(`[normalize] ${err}`);
  process.exit(2);
}

if (validate.warnings.length > 0) {
  for (const warning of validate.warnings) {
    console.warn(`[normalize] ${warning}`);
  }
}

const out = buildMissionOracleDatasetFromRows(merged.rows, {
  checkpointStride: stride,
  seed,
  defaultMaxTick,
  headerMaxTick,
});

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`Wrote normalized reference oracle: ${outputFile}`);
