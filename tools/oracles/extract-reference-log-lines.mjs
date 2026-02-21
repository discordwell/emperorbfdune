#!/usr/bin/env node
import fs from 'node:fs';
import {
  parseJsonLine,
  writeJsonLines,
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
    'Usage: node tools/oracles/extract-reference-log-lines.mjs ' +
    '--input <game.log> --output <capture.jsonl> [--prefix TOKTRACE] [--strict]',
  );
}

const inputFile = argValue('--input');
const outputFile = argValue('--output');
const prefix = argValue('--prefix', 'TOKTRACE');
const strict = hasFlag('--strict');

if (!inputFile || !outputFile) {
  usage();
  process.exit(2);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Input file not found: ${inputFile}`);
  process.exit(2);
}

const lines = fs.readFileSync(inputFile, 'utf8').split(/\r?\n/);
const rows = [];
let parseErrors = 0;
let seenPrefix = 0;

for (let i = 0; i < lines.length; i++) {
  const lineNo = i + 1;
  const line = lines[i];
  if (!line.trim()) continue;

  let candidate = null;
  if (prefix) {
    const idx = line.indexOf(prefix);
    if (idx === -1) continue;
    seenPrefix++;
    candidate = line.slice(idx + prefix.length).trim();
    if (candidate.startsWith(':')) candidate = candidate.slice(1).trim();
  } else {
    candidate = line.trim();
  }

  if (!candidate.startsWith('{')) continue;
  try {
    rows.push(parseJsonLine(candidate, lineNo, inputFile));
  } catch (err) {
    parseErrors++;
    if (strict) {
      console.error(String(err));
      process.exit(2);
    }
  }
}

writeJsonLines(outputFile, rows);
console.log(
  `Extracted ${rows.length} JSON rows from ${inputFile}` +
  ` (prefix matches=${seenPrefix}, parseErrors=${parseErrors})`,
);
