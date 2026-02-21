import { describe, expect, it } from 'vitest';

import { runFreshMissionTrace, runMissionTraceWithRestore } from './traceHarness';

const TRACE_CASES: Array<{
  scriptId: string;
  maxTick: number;
  saveTick: number;
}> = [
  { scriptId: 'ATTutorial', maxTick: 220, saveTick: 70 },
  { scriptId: 'ATP1D1FR', maxTick: 240, saveTick: 80 },
  { scriptId: 'ATP1D3SA', maxTick: 280, saveTick: 90 },
  { scriptId: 'ORP2M14IX', maxTick: 320, saveTick: 110 },
];

describe('Tok mission differential trace validation', () => {
  for (const { scriptId, maxTick } of TRACE_CASES) {
    it(`is deterministic across two fresh runs for ${scriptId}`, () => {
      const a = runFreshMissionTrace(scriptId, maxTick, 1337);
      const b = runFreshMissionTrace(scriptId, maxTick, 1337);
      expect(b).toEqual(a);
    });
  }

  for (const { scriptId, maxTick, saveTick } of TRACE_CASES) {
    it(`matches fresh trace after save/restore for ${scriptId}`, () => {
      const fresh = runFreshMissionTrace(scriptId, maxTick, 2025);
      const restored = runMissionTraceWithRestore(scriptId, maxTick, saveTick, 2025);
      expect(restored).toEqual(fresh);
    });
  }
});
