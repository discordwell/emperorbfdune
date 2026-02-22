import { describe, expect, it } from 'vitest';

import {
  compareReferenceSignalRows,
  rowsFromMissionOracleDataset,
} from '../../../tools/oracles/lib/reference-jsonl-compare.mjs';

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function signal(tick: number, seed: string) {
  return {
    tick,
    frameHash: hex(`${seed}0`),
    intHash: hex(`${seed}1`),
    objHash: hex(`${seed}2`),
    posHash: hex(`${seed}3`),
    relHash: hex(`${seed}4`),
    eventHash: hex(`${seed}5`),
    dispatchHash: hex(`${seed}6`),
  };
}

function dataset() {
  return {
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
        checkpoints: [signal(0, 'a'), signal(80, 'b')],
        final: signal(80, 'b'),
      },
      ATP1D1FR: {
        scriptId: 'ATP1D1FR',
        maxTick: 80,
        frameCount: 81,
        checkpoints: [signal(0, 'c'), signal(80, 'd')],
        final: signal(80, 'd'),
      },
    },
  };
}

describe('Tok reference JSONL compare core', () => {
  it('builds expected rows from mission oracle and compares exact match', () => {
    const expectedRows = rowsFromMissionOracleDataset(dataset(), { scripts: 'fast' });
    const referenceRows = expectedRows.map((row) => ({ ...row }));
    const result = compareReferenceSignalRows(referenceRows, expectedRows, {
      requireAllExpectedRows: true,
      minCoverage: 1,
    });

    expect(result.diff).toBeNull();
    expect(result.coverage).toBe(1);
    expect(result.missingInReference).toEqual([]);
  });

  it('detects signal mismatch at script+tick', () => {
    const expectedRows = rowsFromMissionOracleDataset(dataset(), { scripts: 'fast' });
    const referenceRows = expectedRows.map((row) => ({ ...row }));
    referenceRows[0] = { ...referenceRows[0], intHash: hex('f') };

    const result = compareReferenceSignalRows(referenceRows, expectedRows, {
      requireAllExpectedRows: true,
      minCoverage: 1,
    });

    expect(result.diff).not.toBeNull();
    expect(result.diff?.path.startsWith('$.missions.ATP1D1FRFail[tick=0].intHash')).toBe(true);
  });

  it('enforces coverage and required expected rows', () => {
    const expectedRows = rowsFromMissionOracleDataset(dataset(), { scripts: 'all' });
    const referenceRows = expectedRows.filter((row) => row.scriptId === 'ATP1D1FRFail');

    const relaxed = compareReferenceSignalRows(referenceRows, expectedRows, {
      minCoverage: 0.5,
    });
    expect(relaxed.diff).toBeNull();
    expect(relaxed.coverage).toBe(0.5);

    const strictSet = compareReferenceSignalRows(referenceRows, expectedRows, {
      requireAllExpectedRows: true,
      minCoverage: 1,
    });
    expect(strictSet.diff?.path).toBe('$.__coverage');
  });
});
