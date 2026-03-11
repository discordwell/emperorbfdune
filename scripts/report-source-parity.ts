#!/usr/bin/env npx tsx
/**
 * CLI Entry Point — Source Truth Parity Report
 *
 * Loads rules.txt via both the raw parser AND RulesParser, compares every field,
 * and outputs JSON + markdown reports to test-results/parity/.
 *
 * Usage:
 *   npx tsx scripts/report-source-parity.ts          # Report only
 *   npx tsx scripts/report-source-parity.ts --strict  # Exit 1 on any mismatch
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runComparison, type ParityReport } from './parity/sourceTruth';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RULES_PATH = path.resolve(__dirname, '../extracted/MODEL0001/rules.txt');
const OUTPUT_DIR = path.resolve(__dirname, '../test-results/parity');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function generateMarkdown(report: ParityReport): string {
  const lines: string[] = [];
  lines.push('# Source Parity Report');
  lines.push('');
  lines.push(`Generated: ${report.timestamp}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total fields | ${report.totalFields} |`);
  lines.push(`| Matches | ${report.matches} |`);
  lines.push(`| Mismatches | ${report.mismatches} |`);
  lines.push(`| Derived values | ${report.derived} |`);
  lines.push(`| Defaults applied | ${report.defaultApplied} |`);
  lines.push(`| Intentional divergences | ${report.intentionalDivergences} |`);
  lines.push('');

  // Mismatches section
  const mismatches = report.fields.filter(f => f.status === 'mismatch');
  if (mismatches.length > 0) {
    lines.push('## Mismatches');
    lines.push('');
    lines.push('| Category | Entity | Field | Raw | Parsed | Note |');
    lines.push('|----------|--------|-------|-----|--------|------|');
    for (const f of mismatches) {
      lines.push(`| ${f.category} | ${f.entityName} | ${f.field} | ${f.rawValue ?? '(none)'} | ${f.parsedValue ?? '(none)'} | ${f.note ?? ''} |`);
    }
    lines.push('');
  }

  // Intentional divergences
  const divergences = report.fields.filter(f => f.status === 'intentional_divergence');
  if (divergences.length > 0) {
    lines.push('## Intentional Divergences');
    lines.push('');
    for (const f of divergences) {
      lines.push(`- **${f.category}.${f.field}**: ${f.note}`);
    }
    lines.push('');
  }

  // Derived values
  const derived = report.fields.filter(f => f.status === 'derived');
  if (derived.length > 0) {
    lines.push('## Derived Values');
    lines.push('');
    lines.push('| Category | Entity | Field | Value | Note |');
    lines.push('|----------|--------|-------|-------|------|');
    for (const f of derived) {
      lines.push(`| ${f.category} | ${f.entityName} | ${f.field} | ${f.parsedValue} | ${f.note ?? ''} |`);
    }
    lines.push('');
  }

  // Per-category summary
  lines.push('## Per-Category Breakdown');
  lines.push('');
  const categories = [...new Set(report.fields.map(f => f.category))];
  lines.push('| Category | Total | Match | Mismatch | Derived | Default |');
  lines.push('|----------|-------|-------|----------|---------|---------|');
  for (const cat of categories) {
    const catFields = report.fields.filter(f => f.category === cat);
    const m = catFields.filter(f => f.status === 'match').length;
    const mm = catFields.filter(f => f.status === 'mismatch').length;
    const d = catFields.filter(f => f.status === 'derived').length;
    const da = catFields.filter(f => f.status === 'default_applied').length;
    lines.push(`| ${cat} | ${catFields.length} | ${m} | ${mm} | ${d} | ${da} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// Main
const strict = process.argv.includes('--strict');

console.log('Loading rules.txt...');
const rulesText = fs.readFileSync(RULES_PATH, 'utf-8');

console.log('Running source truth comparison...');
const report = runComparison(rulesText);

ensureDir(OUTPUT_DIR);

// Write JSON report
const jsonPath = path.join(OUTPUT_DIR, 'source-parity-report.json');
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
console.log(`JSON report: ${jsonPath}`);

// Write markdown report
const mdPath = path.join(OUTPUT_DIR, 'source-parity-report.md');
fs.writeFileSync(mdPath, generateMarkdown(report));
console.log(`Markdown report: ${mdPath}`);

// Console summary
console.log('');
console.log('=== Source Parity Summary ===');
console.log(`Total fields:  ${report.totalFields}`);
console.log(`Matches:       ${report.matches}`);
console.log(`Mismatches:    ${report.mismatches}`);
console.log(`Derived:       ${report.derived}`);
console.log(`Defaults:      ${report.defaultApplied}`);
console.log(`Divergences:   ${report.intentionalDivergences}`);

if (report.mismatches > 0) {
  console.log('');
  console.log('MISMATCHES:');
  for (const f of report.fields.filter(f => f.status === 'mismatch')) {
    console.log(`  ${f.category}/${f.entityName}.${f.field}: raw=${f.rawValue} parsed=${f.parsedValue}`);
  }
}

if (strict && report.mismatches > 0) {
  console.error(`\nSTRICT MODE: ${report.mismatches} mismatch(es) found — exiting with code 1`);
  process.exit(1);
} else {
  console.log('\nDone.');
}
