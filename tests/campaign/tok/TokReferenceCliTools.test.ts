import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSignalFromRow } from '../../../tools/oracles/lib/reference-jsonl.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const CHECK_PROGRESS = path.join(ROOT, 'tools/oracles/check-capture-progress.mjs');
const GENERATE_HEADER = path.join(ROOT, 'tools/oracles/generate-hook-manifest-header.mjs');
const COMPARE_JSONL = path.join(ROOT, 'tools/oracles/compare-reference-jsonl.mjs');
const EXPORT_JSONL = path.join(ROOT, 'tools/oracles/export-internal-reference-jsonl.mjs');
const WORKFLOW = path.join(ROOT, 'tools/oracles/external-capture-workflow.mjs');

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

  it('supports side+object id canonicalization during JSONL compare', () => {
    const dir = tempDir();
    const expectedOracleFile = path.join(dir, 'tok_mission_oracle.v1.json');
    const referenceFile = path.join(dir, 'capture.jsonl');
    const reportFile = path.join(dir, 'compare.report.json');
    const diffFile = path.join(dir, 'compare.diff.json');

    const canonicalRow = {
      scriptId: 'A',
      tick: 0,
      intVars: [0, 1],
      objVars: [1],
      posVars: [],
      nextSideId: 4,
      relationships: [{ a: 2, b: 3, rel: 'enemy' }],
      eventFlags: [
        'obj_attacks_side:1:3',
        'obj_constructed:3:1',
        'obj_delivered_side:2:1',
        'side_attacks:2:3',
      ],
      dispatch: {
        sideColors: [
          { side: 2, color: 1 },
          { side: 3, color: 2 },
        ],
      },
    };
    const signal = buildSignalFromRow(canonicalRow);

    writeJsonFile(expectedOracleFile, {
      schemaVersion: 1,
      generator: 'test',
      generatedAt: '2026-02-22T00:00:00.000Z',
      seed: 9001,
      defaultMaxTick: 80,
      headerMaxTick: 8,
      checkpointStride: 20,
      fastScripts: ['A'],
      missions: {
        A: {
          scriptId: 'A',
          maxTick: 0,
          frameCount: 1,
          checkpoints: [signal],
          final: signal,
        },
      },
    });

    writeJsonl(referenceFile, [
      {
        scriptId: 'A',
        tick: 0,
        intVars: [0, 1],
        objVars: [500],
        posVars: [],
        nextSideId: 12,
        relationships: [{ a: 10, b: 11, rel: 'enemy' }],
        eventFlags: [
          'obj_attacks_side:500:11',
          'obj_constructed:11:500',
          'obj_delivered_side:10:500',
          'side_attacks:10:11',
        ],
        dispatch: {
          sideColors: [
            { side: 11, color: 2 },
            { side: 10, color: 1 },
          ],
        },
      },
    ]);

    const mismatch = spawnSync(
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
    expect(mismatch.status).toBe(1);

    const match = spawnSync(
      process.execPath,
      [
        COMPARE_JSONL,
        '--reference', referenceFile,
        '--expected-oracle', expectedOracleFile,
        '--scripts', 'fast',
        '--strict',
        '--require-all-expected-rows',
        '--min-coverage', '1',
        '--canonicalize-object-ids',
        '--canonicalize-side-ids',
        '--report-out', reportFile,
        '--diff-out', diffFile,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(match.status).toBe(0);
    expect(match.stdout).toContain('Reference JSONL matches expected oracle rows.');
    expect(fs.existsSync(diffFile)).toBe(false);
  });

  it('exports internal mission oracle dataset to reference-style JSONL rows', () => {
    const dir = tempDir();
    const oracleFile = path.join(dir, 'tok_mission_oracle.v1.json');
    const outputFile = path.join(dir, 'capture.internal.jsonl');

    writeJsonFile(oracleFile, {
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

    const out = execFileSync(
      process.execPath,
      [EXPORT_JSONL, '--oracle', oracleFile, '--scripts', 'fast', '--output', outputFile],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(out).toContain('[export-jsonl] Wrote 2 rows');

    const lines = fs.readFileSync(outputFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const row0 = JSON.parse(lines[0]);
    expect(row0.scriptId).toBe('ATP1D1FRFail');
    expect(row0.tick).toBe(0);
    expect(row0.frameHash).toBe('a'.repeat(64));
  });

  it('builds external capture tranche plan with workflow prepare/status', () => {
    const dir = tempDir();
    const oracleFile = path.join(dir, 'tok_mission_oracle.v1.json');
    const manifestFile = path.join(dir, 'tok_capture_manifest.v1.json');
    const headerFile = path.join(dir, 'tok_capture_manifest.generated.h');
    const captureFile = path.join(dir, 'tok_capture_merged.jsonl');
    const planFile = path.join(dir, 'reference_capture_plan.report.json');

    const rowA0 = {
      scriptId: 'A',
      tick: 0,
      intVars: [1],
      objVars: [],
      posVars: [],
      nextSideId: 2,
      relationships: [],
      eventFlags: [],
      dispatch: {},
    };
    const rowA1 = { ...rowA0, tick: 1, intVars: [2] };
    const rowB0 = { ...rowA0, scriptId: 'B', tick: 0, intVars: [3] };
    const rowB1 = { ...rowA0, scriptId: 'B', tick: 1, intVars: [4] };

    writeJsonFile(oracleFile, {
      schemaVersion: 1,
      generator: 'test',
      generatedAt: '2026-02-22T00:00:00.000Z',
      seed: 9001,
      defaultMaxTick: 80,
      headerMaxTick: 8,
      checkpointStride: 20,
      fastScripts: ['A'],
      missions: {
        A: {
          scriptId: 'A',
          maxTick: 1,
          frameCount: 2,
          checkpoints: [buildSignalFromRow(rowA0), buildSignalFromRow(rowA1)],
          final: buildSignalFromRow(rowA1),
        },
        B: {
          scriptId: 'B',
          maxTick: 1,
          frameCount: 2,
          checkpoints: [buildSignalFromRow(rowB0), buildSignalFromRow(rowB1)],
          final: buildSignalFromRow(rowB1),
        },
      },
    });

    const prep = spawnSync(
      process.execPath,
      [
        WORKFLOW,
        'prepare',
        '--oracle', oracleFile,
        '--manifest', manifestFile,
        '--header', headerFile,
        '--capture', captureFile,
        '--plan-out', planFile,
        '--scripts', 'all',
        '--batch-missions', '1',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(prep.status).toBe(0);
    expect(fs.existsSync(manifestFile)).toBe(true);
    expect(fs.existsSync(headerFile)).toBe(true);
    const prepPlan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    expect(prepPlan.completeMissionCount).toBe(0);
    expect(prepPlan.nextTranche.missionCount).toBe(1);

    writeJsonl(captureFile, [rowA0, rowA1, rowB0, rowB1]);
    const status = spawnSync(
      process.execPath,
      [
        WORKFLOW,
        'status',
        '--manifest', manifestFile,
        '--capture', captureFile,
        '--plan-out', planFile,
        '--strict',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(status.status).toBe(0);
    const statusPlan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    expect(statusPlan.completeMissionCount).toBe(2);
    expect(statusPlan.nextTranche).toBeNull();
  });

  it('runs workflow finalize strict and emits normalized reference dataset', () => {
    const dir = tempDir();
    const oracleFile = path.join(dir, 'tok_mission_oracle.v1.json');
    const captureFile = path.join(dir, 'tok_capture_merged.jsonl');
    const manifestFile = path.join(dir, 'tok_capture_manifest.v1.json');
    const referenceFile = path.join(dir, 'tok_mission_oracle.reference.v1.json');
    const finalizeReport = path.join(dir, 'reference_finalize.report.json');

    const rowA0 = {
      scriptId: 'A',
      tick: 0,
      maxTick: 1,
      frameCount: 2,
      intVars: [1],
      objVars: [],
      posVars: [],
      nextSideId: 2,
      relationships: [],
      eventFlags: [],
      dispatch: {},
    };
    const rowA1 = { ...rowA0, tick: 1, intVars: [2] };
    const rowB0 = { ...rowA0, scriptId: 'B', tick: 0, intVars: [3] };
    const rowB1 = { ...rowA0, scriptId: 'B', tick: 1, intVars: [4] };

    writeJsonFile(oracleFile, {
      schemaVersion: 1,
      generator: 'test',
      generatedAt: '2026-02-22T00:00:00.000Z',
      seed: 9001,
      defaultMaxTick: 80,
      headerMaxTick: 8,
      checkpointStride: 20,
      fastScripts: ['A'],
      missions: {
        A: {
          scriptId: 'A',
          maxTick: 1,
          frameCount: 2,
          checkpoints: [buildSignalFromRow(rowA0), buildSignalFromRow(rowA1)],
          final: buildSignalFromRow(rowA1),
        },
        B: {
          scriptId: 'B',
          maxTick: 1,
          frameCount: 2,
          checkpoints: [buildSignalFromRow(rowB0), buildSignalFromRow(rowB1)],
          final: buildSignalFromRow(rowB1),
        },
      },
    });
    writeJsonl(captureFile, [rowA0, rowA1, rowB0, rowB1]);

    const run = spawnSync(
      process.execPath,
      [
        WORKFLOW,
        'finalize',
        '--oracle', oracleFile,
        '--manifest', manifestFile,
        '--capture', captureFile,
        '--reference', referenceFile,
        '--finalize-report', finalizeReport,
        '--scripts', 'all',
        '--strict',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    expect(fs.existsSync(referenceFile)).toBe(true);
    const report = JSON.parse(fs.readFileSync(finalizeReport, 'utf8'));
    expect(report.status).toBe('ok');
    expect(report.datasetCompare.diff).toBeNull();
    expect(report.rowCompare.diff).toBeNull();
  });
});
