import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const CHECK_PROGRESS = path.join(ROOT, 'tools/oracles/check-capture-progress.mjs');
const GENERATE_HEADER = path.join(ROOT, 'tools/oracles/generate-hook-manifest-header.mjs');
const COMPARE_JSONL = path.join(ROOT, 'tools/oracles/compare-reference-jsonl.mjs');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tok-oracle-cli-'));
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${text}\n`, 'utf8');
}

describe('Tok reference CLI tools', () => {
  it('generates hook header from capture manifest', () => {
    const dir = tempDir();
    const manifestFile = path.join(dir, 'manifest.json');
    const outputFile = path.join(dir, 'tok_capture_manifest.generated.h');

    writeJsonFile(manifestFile, {
      schemaVersion: 1,
      generator: 'test',
      missions: [
        { scriptId: 'ATP1D1FRFail', maxTick: 80, frameCount: 81, checkpointTicks: [0, 20, 40, 60, 80] },
        { scriptId: 'header', maxTick: 8, frameCount: 9, checkpointTicks: [0, 8] },
      ],
    });

    const out = execFileSync(
      process.execPath,
      [GENERATE_HEADER, '--manifest', manifestFile, '--output', outputFile],
      { cwd: ROOT, encoding: 'utf8' },
    );

    expect(out).toContain('Wrote hook manifest header (2 missions):');
    const header = fs.readFileSync(outputFile, 'utf8');
    expect(header).toContain('static const int TOK_CAPTURE_CHECKPOINTS_000[] = { 0, 20, 40, 60, 80 };');
    expect(header).toContain('static const int TOK_CAPTURE_CHECKPOINTS_001[] = { 0, 8 };');
    expect(header).toContain('{ "ATP1D1FRFail", 80, 81, 5, TOK_CAPTURE_CHECKPOINTS_000 },');
    expect(header).toContain('static const int TOK_CAPTURE_MISSION_COUNT = 2;');
  });

  it('reports partial capture progress and fails strict mode until complete', () => {
    const dir = tempDir();
    const manifestFile = path.join(dir, 'manifest.json');
    const captureFile = path.join(dir, 'capture.jsonl');
    const reportFile = path.join(dir, 'report.json');

    writeJsonFile(manifestFile, {
      schemaVersion: 1,
      generator: 'test',
      missions: [
        { scriptId: 'A', maxTick: 40, frameCount: 41, checkpointTicks: [0, 20, 40] },
        { scriptId: 'B', maxTick: 8, frameCount: 9, checkpointTicks: [0, 8] },
      ],
    });

    writeJsonl(captureFile, [
      { scriptId: 'A', tick: 0 },
      { scriptId: 'A', tick: 20 },
      { scriptId: 'B', tick: 0 },
      { scriptId: 'B', tick: 8 },
    ]);

    const out = execFileSync(
      process.execPath,
      [CHECK_PROGRESS, '--input', captureFile, '--manifest', manifestFile, '--report-out', reportFile],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(out).toContain('[progress] missions 1/2');

    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    expect(report.completeMissionCount).toBe(1);
    expect(report.missionCoverage).toBe(0.5);
    expect(report.requiredCheckpoints).toBe(5);
    expect(report.capturedCheckpoints).toBe(4);

    const strictRun = spawnSync(
      process.execPath,
      [CHECK_PROGRESS, '--input', captureFile, '--manifest', manifestFile, '--strict'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(strictRun.status).toBe(1);
  });

  it('passes strict capture progress when all checkpoints are present', () => {
    const dir = tempDir();
    const manifestFile = path.join(dir, 'manifest.json');
    const captureFile = path.join(dir, 'capture.jsonl');

    writeJsonFile(manifestFile, {
      schemaVersion: 1,
      generator: 'test',
      missions: [
        { scriptId: 'A', maxTick: 40, frameCount: 41, checkpointTicks: [0, 20, 40] },
        { scriptId: 'B', maxTick: 8, frameCount: 9, checkpointTicks: [0, 8] },
      ],
    });

    writeJsonl(captureFile, [
      { scriptId: 'A', tick: 0 },
      { scriptId: 'A', tick: 20 },
      { scriptId: 'A', tick: 40 },
      { scriptId: 'B', tick: 0 },
      { scriptId: 'B', tick: 8 },
    ]);

    const strictRun = spawnSync(
      process.execPath,
      [CHECK_PROGRESS, '--input', captureFile, '--manifest', manifestFile, '--strict'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(strictRun.status).toBe(0);
    expect(strictRun.stdout).toContain('[progress] missions 2/2');
  });

  it('compares reference JSONL rows against expected mission oracle rows', () => {
    const dir = tempDir();
    const expectedOracleFile = path.join(dir, 'tok_mission_oracle.v1.json');
    const referenceFile = path.join(dir, 'capture.jsonl');
    const reportFile = path.join(dir, 'compare.report.json');
    const diffFile = path.join(dir, 'compare.diff.json');

    writeJsonFile(expectedOracleFile, {
      schemaVersion: 1,
      generator: 'test',
      generatedAt: '2026-02-22T00:00:00.000Z',
      seed: 9001,
      defaultMaxTick: 80,
      headerMaxTick: 8,
      checkpointStride: 20,
      fastScripts: ['ATP1D1FRFail'],
      missions: {
        ATP1D1FRFail: {
          scriptId: 'ATP1D1FRFail',
          maxTick: 80,
          frameCount: 81,
          checkpoints: [
            {
              tick: 0,
              frameHash: 'a'.repeat(64),
              intHash: 'b'.repeat(64),
              objHash: 'c'.repeat(64),
              posHash: 'd'.repeat(64),
              relHash: 'e'.repeat(64),
              eventHash: 'f'.repeat(64),
              dispatchHash: '1'.repeat(64),
            },
            {
              tick: 80,
              frameHash: '2'.repeat(64),
              intHash: '3'.repeat(64),
              objHash: '4'.repeat(64),
              posHash: '5'.repeat(64),
              relHash: '6'.repeat(64),
              eventHash: '7'.repeat(64),
              dispatchHash: '8'.repeat(64),
            },
          ],
          final: {
            tick: 80,
            frameHash: '2'.repeat(64),
            intHash: '3'.repeat(64),
            objHash: '4'.repeat(64),
            posHash: '5'.repeat(64),
            relHash: '6'.repeat(64),
            eventHash: '7'.repeat(64),
            dispatchHash: '8'.repeat(64),
          },
        },
      },
    });

    writeJsonl(referenceFile, [
      {
        scriptId: 'ATP1D1FRFail',
        tick: 0,
        frameHash: 'a'.repeat(64),
        intHash: 'b'.repeat(64),
        objHash: 'c'.repeat(64),
        posHash: 'd'.repeat(64),
        relHash: 'e'.repeat(64),
        eventHash: 'f'.repeat(64),
        dispatchHash: '1'.repeat(64),
      },
      {
        scriptId: 'ATP1D1FRFail',
        tick: 80,
        frameHash: '2'.repeat(64),
        intHash: '3'.repeat(64),
        objHash: '4'.repeat(64),
        posHash: '5'.repeat(64),
        relHash: '6'.repeat(64),
        eventHash: '7'.repeat(64),
        dispatchHash: '8'.repeat(64),
      },
    ]);

    const okRun = spawnSync(
      process.execPath,
      [
        COMPARE_JSONL,
        '--reference', referenceFile,
        '--expected-oracle', expectedOracleFile,
        '--scripts', 'fast',
        '--strict',
        '--require-all-expected-rows',
        '--min-coverage', '1',
        '--report-out', reportFile,
        '--diff-out', diffFile,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(okRun.status).toBe(0);
    expect(okRun.stdout).toContain('Reference JSONL matches expected oracle rows.');
    expect(fs.existsSync(diffFile)).toBe(false);

    writeJsonl(referenceFile, [
      {
        scriptId: 'ATP1D1FRFail',
        tick: 0,
        frameHash: 'a'.repeat(64),
        intHash: '0'.repeat(64),
        objHash: 'c'.repeat(64),
        posHash: 'd'.repeat(64),
        relHash: 'e'.repeat(64),
        eventHash: 'f'.repeat(64),
        dispatchHash: '1'.repeat(64),
      },
    ]);

    const badRun = spawnSync(
      process.execPath,
      [
        COMPARE_JSONL,
        '--reference', referenceFile,
        '--expected-oracle', expectedOracleFile,
        '--scripts', 'fast',
        '--strict',
        '--require-all-expected-rows',
        '--min-coverage', '1',
        '--report-out', reportFile,
        '--diff-out', diffFile,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(badRun.status).toBe(1);
    expect(badRun.stderr).toContain('Reference JSONL mismatch');
    expect(fs.existsSync(diffFile)).toBe(true);
  });
});
