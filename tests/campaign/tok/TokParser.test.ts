import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTokFile } from '../../../src/campaign/scripting/tok/TokParser';
import { buildStringTable } from '../../../src/campaign/scripting/tok/TokStringTable';
import { astToText, countTokSegments, normalizeTokText } from './astToText';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const TOK_DIR = path.join(ROOT, 'assets/data/missions/tok');
const DECOMPILED_DIR = path.join(ROOT, 'decompiled_missions');

const STRING_TABLE = buildStringTable(null as any);

function readTok(name: string): { bytes: Buffer; buffer: ArrayBuffer } {
  const fullPath = path.join(TOK_DIR, `${name}.tok`);
  const bytes = fs.readFileSync(fullPath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { bytes, buffer };
}

function readDecompiled(name: string): string {
  return fs.readFileSync(path.join(DECOMPILED_DIR, `${name}.txt`), 'utf8');
}

function topLevelIfCount(scriptText: string): number {
  return scriptText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('if '))
    .length;
}

function compareMissionRoundTrip(name: string, expectedSize: number): void {
  const { bytes, buffer } = readTok(name);
  expect(bytes.byteLength).toBe(expectedSize);

  const parsed = parseTokFile(buffer);
  const actual = normalizeTokText(astToText(
    parsed,
    {
      fileName: `${name}.tok`,
      fileSize: bytes.byteLength,
      segmentCount: countTokSegments(buffer),
      varSlotCount: parsed.varSlotCount,
    },
    STRING_TABLE,
  ));

  const expected = normalizeTokText(readDecompiled(name));
  expect(actual).toBe(expected);
}

describe('TokParser round-trip references', () => {
  it('uses a 128-entry TOK string table (0-127)', () => {
    expect(STRING_TABLE).toHaveLength(128);
  });

  it('round-trips ATP1D1FRFail.tok (minimal script)', () => {
    compareMissionRoundTrip('ATP1D1FRFail', 82);
  });

  it('round-trips ATP1D1FR.tok (typical early mission)', () => {
    compareMissionRoundTrip('ATP1D1FR', 1817);
  });

  it('round-trips ATP1D3SA.tok (complex mission)', () => {
    compareMissionRoundTrip('ATP1D3SA', 2771);
  });
});

describe('TokParser mission corpus smoke', () => {
  it('parses all mission .tok files and matches top-level block counts', () => {
    const files = fs.readdirSync(TOK_DIR)
      .filter((f) => f.endsWith('.tok'))
      .sort((a, b) => a.localeCompare(b));

    expect(files.length).toBe(229);

    for (const file of files) {
      const mission = file.replace(/\.tok$/i, '');
      const fullPath = path.join(TOK_DIR, file);
      const bytes = fs.readFileSync(fullPath);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

      const parsed = parseTokFile(buffer);
      expect(Array.isArray(parsed.program)).toBe(true);

      if (mission === 'header') {
        expect(parsed.program.length).toBe(0);
        continue;
      }

      const txtPath = path.join(DECOMPILED_DIR, `${mission}.txt`);
      if (!fs.existsSync(txtPath)) {
        // Only expected for header.tok in this corpus.
        expect(mission).toBe('header');
        continue;
      }

      const decompiled = fs.readFileSync(txtPath, 'utf8');
      const expectedTopLevelBlocks = topLevelIfCount(decompiled);

      if (expectedTopLevelBlocks === 0) {
        expect(parsed.program.length).toBe(0);
      } else {
        expect(parsed.program.length).toBeGreaterThan(0);
      }

      expect(parsed.program.length).toBe(expectedTopLevelBlocks);
    }
  });
});
