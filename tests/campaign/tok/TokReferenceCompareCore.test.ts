import { describe, expect, it } from 'vitest';

import {
  compareMissionOracleDatasets,
  validateMissionOracleDataset,
} from '../../../tools/oracles/lib/reference-compare.mjs';

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

function mission(scriptId: string, seed: string) {
  return {
    scriptId,
    maxTick: 80,
    frameCount: 81,
    checkpoints: [signal(0, seed), signal(80, seed)],
    final: signal(80, seed),
  };
}

function dataset(missions: Record<string, ReturnType<typeof mission>>) {
  return {
    schemaVersion: 1,
    generator: 'test',
    generatedAt: '2026-02-22T00:00:00.000Z',
    seed: 9001,
    defaultMaxTick: 80,
    headerMaxTick: 8,
    checkpointStride: 20,
    fastScripts: [],
    missions,
  };
}

describe('Tok reference compare core', () => {
  it('validates a mission oracle dataset', () => {
    const valid = dataset({
      ATP1D1FRFail: mission('ATP1D1FRFail', 'a'),
    });
    const result = validateMissionOracleDataset(valid, 'valid');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports schema violations for invalid datasets', () => {
    const invalid = {
      schemaVersion: 1,
      missions: {
        ATP1D1FRFail: {
          scriptId: 'wrong',
          maxTick: 80,
          frameCount: 81,
          checkpoints: [],
          final: {},
        },
      },
    };
    const result = validateMissionOracleDataset(invalid as any, 'invalid');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('detects first mission mismatch path', () => {
    const reference = dataset({
      ATP1D1FRFail: mission('ATP1D1FRFail', 'a'),
    });
    const internal = dataset({
      ATP1D1FRFail: mission('ATP1D1FRFail', 'b'),
    });

    const result = compareMissionOracleDatasets(reference, internal, {
      requireAllMissions: true,
      minCoverage: 1,
    });

    expect(result.diff).not.toBeNull();
    expect(result.diff?.path.startsWith('$.missions.ATP1D1FRFail')).toBe(true);
  });

  it('enforces coverage and mission-set gates when requested', () => {
    const reference = dataset({
      ATP1D1FRFail: mission('ATP1D1FRFail', 'a'),
      ATP1D1FR: mission('ATP1D1FR', 'b'),
    });
    const internal = dataset({
      ATP1D1FRFail: mission('ATP1D1FRFail', 'a'),
    });

    const coverageOnly = compareMissionOracleDatasets(reference, internal, {
      minCoverage: 0.5,
    });
    expect(coverageOnly.coverage).toBe(0.5);
    expect(coverageOnly.diff).toBeNull();
    expect(coverageOnly.missingInInternal).toEqual(['ATP1D1FR']);

    const strictSet = compareMissionOracleDatasets(reference, internal, {
      requireAllMissions: true,
      minCoverage: 1,
    });
    expect(strictSet.diff?.path).toBe('$.missions.__coverage');
  });
});
