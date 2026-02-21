import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TokInterpreter } from '../../../src/campaign/scripting/tok/TokInterpreter';
import { EventBus } from '../../../src/core/EventBus';

import { createMockCtx } from './mocks/MockGameContext';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const TOK_DIR = path.join(ROOT, 'assets/data/missions/tok');

function readTokByFile(fileName: string): ArrayBuffer {
  const bytes = fs.readFileSync(path.join(TOK_DIR, fileName));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function runMissionTicks(fileName: string, maxTick: number): void {
  const ctx = createMockCtx();
  const interpreter = new TokInterpreter();
  const scriptId = fileName.replace(/\.tok$/i, '');
  interpreter.init(ctx, readTokByFile(fileName), scriptId);
  for (let tick = 0; tick <= maxTick; tick++) {
    interpreter.tick(ctx, tick);
  }
  interpreter.dispose();
}

describe('Tok runtime smoke', () => {
  beforeEach(() => {
    EventBus.clear();
  });

  it('executes startup ticks for every mission tok without unimplemented function warnings', () => {
    const files = fs.readdirSync(TOK_DIR).filter((f) => f.endsWith('.tok')).sort();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const file of files) {
      runMissionTicks(file, 25);
    }

    const unimplemented = warn.mock.calls.filter(([msg]) =>
      typeof msg === 'string' && msg.includes('[Tok] Unimplemented function:')
    );
    expect(unimplemented).toEqual([]);
  });

  it('executes extended ticks on complex mission scripts without unimplemented warnings', () => {
    const longRun: Array<{ file: string; ticks: number }> = [
      { file: 'Atreides Heighliner Mission.tok', ticks: 700 },
      { file: 'Ordos Heighliner Mission.tok', ticks: 700 },
      { file: 'ORP3M10TL.tok', ticks: 700 },
      { file: 'HKP1M15HK.tok', ticks: 1200 },
      { file: 'Ordos Homeworld Defense.tok', ticks: 1200 },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const { file, ticks } of longRun) {
      runMissionTicks(file, ticks);
    }

    const unimplemented = warn.mock.calls.filter(([msg]) =>
      typeof msg === 'string' && msg.includes('[Tok] Unimplemented function:')
    );
    expect(unimplemented).toEqual([]);
  });

  it('executes sustained runtime ticks for every mission without unimplemented warnings', () => {
    const files = fs.readdirSync(TOK_DIR).filter((f) => f.endsWith('.tok')).sort();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const file of files) {
      runMissionTicks(file, 200);
    }

    const unimplemented = warn.mock.calls.filter(([msg]) =>
      typeof msg === 'string' && msg.includes('[Tok] Unimplemented function:')
    );
    expect(unimplemented).toEqual([]);
  });
});
