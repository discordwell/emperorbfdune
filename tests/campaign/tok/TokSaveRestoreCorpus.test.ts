import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runFreshMissionTrace, runMissionTraceWithRestore } from './traceHarness';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const TOK_DIR = path.join(ROOT, 'assets/data/missions/tok');

describe('Tok save/restore corpus parity', () => {
  it('matches final VM state for every mission after save/restore continuation', () => {
    const files = fs.readdirSync(TOK_DIR).filter((f) => f.endsWith('.tok')).sort();
    expect(files.length).toBe(229);

    for (const file of files) {
      const scriptId = file.replace(/\.tok$/i, '');
      const maxTick = scriptId === 'header' ? 8 : 80;
      const saveTick = scriptId === 'header' ? 3 : 40;

      const fresh = runFreshMissionTrace(scriptId, maxTick, 9001);
      const restored = runMissionTraceWithRestore(scriptId, maxTick, saveTick, 9001);

      const freshFinal = fresh[fresh.length - 1];
      const restoredFinal = restored[restored.length - 1];
      expect(restoredFinal).toEqual(freshFinal);
    }
  });
});
