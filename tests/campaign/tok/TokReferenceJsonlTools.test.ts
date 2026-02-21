import { describe, expect, it } from 'vitest';

import {
  buildCaptureManifestFromOracleDataset,
  buildMissionOracleDatasetFromRows,
  mergeRows,
  validateReferenceRows,
} from '../../../tools/oracles/lib/reference-jsonl.mjs';

describe('Tok reference JSONL tools', () => {
  it('builds mission oracle dataset from compact alias rows', () => {
    const rows = [
      {
        s: 'ATP1D1FRFail',
        t: 0,
        mt: 1,
        fc: 2,
        i: [1, 2],
        o: [3],
        p: [{ x: 10, z: 20 }],
        r: [{ a: 1, b: 2, rel: 'enemy' }],
        e: ['side_attack:1:2'],
        d: { camera: 0 },
      },
      {
        s: 'ATP1D1FRFail',
        t: 1,
        mt: 1,
        fc: 2,
        i: [4, 5],
        o: [6],
        p: [{ x: 30, z: 40 }],
        r: [{ a: 1, b: 2, rel: 'enemy' }],
        e: [],
        d: { camera: 1 },
      },
    ];

    const out = buildMissionOracleDatasetFromRows(rows, {
      checkpointStride: 20,
      seed: 9001,
      defaultMaxTick: 80,
      headerMaxTick: 8,
    });

    expect(out.schemaVersion).toBe(1);
    expect(Object.keys(out.missions)).toEqual(['ATP1D1FRFail']);
    expect(out.missions.ATP1D1FRFail.frameCount).toBe(2);
    expect(out.missions.ATP1D1FRFail.maxTick).toBe(1);
    expect(out.missions.ATP1D1FRFail.final.tick).toBe(1);
    expect(out.missions.ATP1D1FRFail.checkpoints.length).toBe(2);
  });

  it('merges duplicate mission ticks with last-write strategy', () => {
    const rows = [
      { scriptId: 'ATP1D1FRFail', tick: 0, intVars: [1] },
      { scriptId: 'ATP1D1FRFail', tick: 0, intVars: [2] },
      { scriptId: 'ATP1D1FRFail', tick: 1, intVars: [3] },
    ];

    const merged = mergeRows(rows, { prefer: 'last' });
    expect(merged.rows).toHaveLength(2);
    expect(merged.conflicts).toHaveLength(1);
    const tick0 = merged.rows.find((r) => (r.tick ?? r.t) === 0);
    expect(tick0?.intVars).toEqual([2]);
  });

  it('validates mission coverage and expected max ticks', () => {
    const rows = [
      { scriptId: 'ATP1D1FRFail', tick: 0, intVars: [] },
      { scriptId: 'ATP1D1FRFail', tick: 80, intVars: [] },
    ];

    const report = validateReferenceRows(rows, {
      expectedMissionMax: {
        ATP1D1FRFail: 80,
        ATP1D1FR: 80,
      },
      requireAllMissions: false,
      requireExpectedMaxTick: true,
      requireTickZero: true,
    });

    expect(report.ok).toBe(true);
    expect(report.coverage).toBe(0.5);
    expect(report.missingMissions).toEqual(['ATP1D1FR']);
  });

  it('builds capture manifest from internal oracle dataset', () => {
    const dataset = {
      seed: 9001,
      defaultMaxTick: 80,
      headerMaxTick: 8,
      checkpointStride: 20,
      fastScripts: ['ATP1D1FRFail'],
      missions: {
        ATP1D1FRFail: { maxTick: 80, frameCount: 81 },
        ATP1D1FR: { maxTick: 80, frameCount: 81 },
      },
    };

    const manifestFast = buildCaptureManifestFromOracleDataset(dataset, { scripts: 'fast' });
    expect(manifestFast.missionCount).toBe(1);
    expect(manifestFast.missions[0].scriptId).toBe('ATP1D1FRFail');
    expect(manifestFast.missions[0].frameCount).toBe(81);
    expect(manifestFast.missions[0].checkpointTicks).toEqual([0, 20, 40, 60, 80]);

    const manifestAll = buildCaptureManifestFromOracleDataset(dataset, { scripts: 'all' });
    expect(manifestAll.missionCount).toBe(2);
  });
});
