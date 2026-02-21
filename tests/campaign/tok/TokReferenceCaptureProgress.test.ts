import { describe, expect, it } from 'vitest';

import { buildCaptureProgress } from '../../../tools/oracles/lib/capture-progress.mjs';

describe('Tok reference capture progress', () => {
  it('computes mission and checkpoint completion from manifest', () => {
    const manifest = {
      missions: [
        { scriptId: 'A', maxTick: 80, frameCount: 81, checkpointTicks: [0, 20, 40, 60, 80] },
        { scriptId: 'B', maxTick: 8, frameCount: 9, checkpointTicks: [0, 8] },
      ],
    };

    const rows = [
      { s: 'A', t: 0 },
      { s: 'A', t: 20 },
      { s: 'A', t: 80 },
      { s: 'B', t: 0 },
      { s: 'Z', t: 5 }, // unexpected mission
    ];

    const progress = buildCaptureProgress(rows, manifest);
    expect(progress.missionCount).toBe(2);
    expect(progress.completeMissionCount).toBe(0);
    expect(progress.requiredCheckpoints).toBe(7);
    expect(progress.capturedCheckpoints).toBe(4);
    expect(progress.unexpectedMissions).toEqual(['Z']);

    const missionA = progress.missions.find((m) => m.scriptId === 'A');
    expect(missionA?.missingTicks).toEqual([40, 60]);
  });

  it('marks fully captured manifest as complete', () => {
    const manifest = {
      missions: [
        { scriptId: 'A', maxTick: 80, checkpointTicks: [0, 20, 40, 60, 80] },
      ],
    };
    const rows = [
      { scriptId: 'A', tick: 0 },
      { scriptId: 'A', tick: 20 },
      { scriptId: 'A', tick: 40 },
      { scriptId: 'A', tick: 60 },
      { scriptId: 'A', tick: 80 },
    ];

    const progress = buildCaptureProgress(rows, manifest);
    expect(progress.completeMissionCount).toBe(1);
    expect(progress.missionCoverage).toBe(1);
    expect(progress.checkpointCoverage).toBe(1);
    expect(progress.missions[0].complete).toBe(true);
  });
});
