#!/usr/bin/env node
/**
 * Generate tok-manifest.json — maps lowercase basenames to actual filenames.
 * Used by MissionScriptLoader for case-insensitive .tok lookup.
 *
 * Usage: node tools/generate-tok-manifest.js
 */
import { readdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

const TOK_DIR = join(import.meta.dirname, '..', 'assets', 'data', 'missions', 'tok');
const OUT_PATH = join(TOK_DIR, 'tok-manifest.json');

const files = readdirSync(TOK_DIR).filter(f => f.endsWith('.tok'));
const manifest = {};

for (const file of files) {
  const base = basename(file, '.tok');
  const key = base.toLowerCase();
  if (manifest[key]) {
    console.warn(`Duplicate lowercase key: ${key} -> ${manifest[key]} vs ${base}`);
  }
  manifest[key] = base;
}

writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Generated tok-manifest.json with ${Object.keys(manifest).length} entries`);
