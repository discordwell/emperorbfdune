#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  mergeRows,
  readJsonLines,
  writeJsonFile,
  writeJsonLines,
} from './lib/reference-jsonl.mjs';

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function usage() {
  console.log(
    'Usage: node tools/oracles/merge-reference-jsonl.mjs ' +
    '--inputs <a.jsonl,b.jsonl|dir> --output <merged.jsonl> [--report-out <report.json>] [--strict-conflicts]',
  );
}

function collectInputFiles(spec) {
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return [];

  const files = [];
  for (const part of parts) {
    if (!fs.existsSync(part)) {
      throw new Error(`Input does not exist: ${part}`);
    }
    const stat = fs.statSync(part);
    if (stat.isDirectory()) {
      const names = fs.readdirSync(part)
        .filter((name) => name.toLowerCase().endsWith('.jsonl'))
        .sort((a, b) => a.localeCompare(b));
      for (const name of names) files.push(path.join(part, name));
      continue;
    }
    files.push(part);
  }
  return files;
}

const inputsSpec = argValue('--inputs');
const outputFile = argValue('--output');
const reportOut = argValue('--report-out');
const strictConflicts = process.argv.includes('--strict-conflicts');
const prefer = argValue('--prefer', 'last');

if (!inputsSpec || !outputFile) {
  usage();
  process.exit(2);
}

if (prefer !== 'first' && prefer !== 'last') {
  console.error(`--prefer must be 'first' or 'last', got ${JSON.stringify(prefer)}`);
  process.exit(2);
}

let inputFiles;
try {
  inputFiles = collectInputFiles(inputsSpec);
} catch (err) {
  console.error(String(err));
  process.exit(2);
}

if (inputFiles.length === 0) {
  console.error('No input .jsonl files found.');
  process.exit(2);
}

const rows = [];
for (const file of inputFiles) {
  rows.push(...readJsonLines(file));
}

let merged;
try {
  merged = mergeRows(rows, {
    prefer,
    strictConflicts,
  });
} catch (err) {
  console.error(`[merge] ${String(err)}`);
  process.exit(2);
}

writeJsonLines(outputFile, merged.rows);

const report = {
  inputFiles,
  inputFileCount: inputFiles.length,
  inputRows: rows.length,
  outputRows: merged.rows.length,
  prefer,
  strictConflicts,
  conflicts: merged.conflicts.length,
};
if (reportOut) {
  writeJsonFile(reportOut, report);
}

console.log(
  `Merged ${rows.length} rows from ${inputFiles.length} files into ${merged.rows.length} rows (${merged.conflicts.length} conflicts): ${outputFile}`,
);
