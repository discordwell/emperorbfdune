import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MissionScriptState } from '../../../src/campaign/scripting/MissionScriptTypes';
import { TokInterpreter } from '../../../src/campaign/scripting/tok/TokInterpreter';
import { buildingQuery, unitQuery } from '../../../src/core/ECS';
import { EventBus } from '../../../src/core/EventBus';
import { simRng } from '../../../src/utils/DeterministicRNG';

import { createMockCtx, type MockCtx } from './mocks/MockGameContext';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const TOK_DIR = path.join(ROOT, 'assets/data/missions/tok');

export interface TokTraceFrame {
  tick: number;
  intVars: number[];
  objVars: number[];
  posVars: Array<{ x: number; z: number }>;
  nextSideId: number;
  relationships: Array<{ a: number; b: number; rel: string }>;
  eventFlags: string[];
}

interface ObjIdNormalizer {
  nextCanonicalId: number;
  canonicalByRawId: Map<number, number>;
}

function readTokByScriptId(scriptId: string): ArrayBuffer {
  const bytes = fs.readFileSync(path.join(TOK_DIR, `${scriptId}.tok`));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function buildIdentityMap(ctx: MockCtx): Map<number, number> {
  const world = ctx.game.getWorld();
  const map = new Map<number, number>();

  for (const eid of unitQuery(world)) map.set(eid, eid);
  for (const eid of buildingQuery(world)) map.set(eid, eid);
  for (const eid of ctx.__spawns.units) map.set(eid, eid);
  for (const eid of ctx.__spawns.buildings) map.set(eid, eid);

  return map;
}

function normalizeObjId(rawId: number, normalizer: ObjIdNormalizer): number {
  if (rawId < 0) return -1;

  const existing = normalizer.canonicalByRawId.get(rawId);
  if (existing !== undefined) return existing;

  const created = normalizer.nextCanonicalId++;
  normalizer.canonicalByRawId.set(rawId, created);
  return created;
}

function normalizeEventFlagKey(rawKey: string, normalizer: ObjIdNormalizer): string {
  if (rawKey.startsWith('obj_destroyed:')) {
    const raw = Number(rawKey.slice('obj_destroyed:'.length));
    return `obj_destroyed:${normalizeObjId(raw, normalizer)}`;
  }

  if (rawKey.startsWith('obj_delivered:')) {
    const raw = Number(rawKey.slice('obj_delivered:'.length));
    return `obj_delivered:${normalizeObjId(raw, normalizer)}`;
  }

  if (rawKey.startsWith('obj_delivered_side:')) {
    const parts = rawKey.split(':');
    if (parts.length === 3) {
      const side = Number(parts[1]);
      const raw = Number(parts[2]);
      return `obj_delivered_side:${side}:${normalizeObjId(raw, normalizer)}`;
    }
  }

  if (rawKey.startsWith('obj_constructed:')) {
    const parts = rawKey.split(':');
    if (parts.length === 3) {
      const side = Number(parts[1]);
      const raw = Number(parts[2]);
      return `obj_constructed:${side}:${normalizeObjId(raw, normalizer)}`;
    }
  }

  if (rawKey.startsWith('type_constructed_obj:')) {
    const parts = rawKey.split(':');
    if (parts.length === 4) {
      const side = Number(parts[1]);
      const typeName = parts[2];
      const raw = Number(parts[3]);
      return `type_constructed_obj:${side}:${typeName}:${normalizeObjId(raw, normalizer)}`;
    }
  }

  if (rawKey.startsWith('obj_attacks_side:')) {
    const parts = rawKey.split(':');
    if (parts.length === 3) {
      const raw = Number(parts[1]);
      const side = Number(parts[2]);
      return `obj_attacks_side:${normalizeObjId(raw, normalizer)}:${side}`;
    }
  }

  return rawKey;
}

function snapshot(
  interpreter: TokInterpreter,
  ctx: MockCtx,
  tick: number,
  normalizer: ObjIdNormalizer,
): TokTraceFrame {
  const state = interpreter.serialize(buildIdentityMap(ctx)).tokState;
  if (!state) {
    throw new Error('Expected tokState during trace snapshot');
  }

  return {
    tick,
    intVars: [...state.intVars],
    objVars: state.objVars.map((rawId) => normalizeObjId(rawId, normalizer)),
    posVars: state.posVars.map((p) => ({ x: p.x, z: p.z })),
    nextSideId: state.nextSideId,
    relationships: [...state.relationships].sort((a, b) => {
      if (a.a !== b.a) return a.a - b.a;
      if (a.b !== b.b) return a.b - b.b;
      return a.rel.localeCompare(b.rel);
    }),
    eventFlags: Object.keys(state.eventFlags)
      .filter((key) => state.eventFlags[key])
      .map((key) => normalizeEventFlagKey(key, normalizer))
      .sort((a, b) => a.localeCompare(b)),
  };
}

function runTicks(
  interpreter: TokInterpreter,
  ctx: MockCtx,
  fromTick: number,
  toTick: number,
  frames: TokTraceFrame[],
  normalizer: ObjIdNormalizer,
): void {
  for (let tick = fromTick; tick <= toTick; tick++) {
    interpreter.tick(ctx, tick);
    frames.push(snapshot(interpreter, ctx, tick, normalizer));
  }
}

function resetDeterminism(seed: number): void {
  EventBus.clear();
  simRng.reseed(seed);
}

function disposeSafe(interpreter: TokInterpreter | null): void {
  if (!interpreter) return;
  interpreter.dispose();
}

export function runFreshMissionTrace(
  scriptId: string,
  maxTick: number,
  seed = 424242,
): TokTraceFrame[] {
  resetDeterminism(seed);
  const frames: TokTraceFrame[] = [];
  const normalizer: ObjIdNormalizer = { nextCanonicalId: 1, canonicalByRawId: new Map() };
  const ctx = createMockCtx();
  let interpreter: TokInterpreter | null = new TokInterpreter();

  try {
    interpreter.init(ctx, readTokByScriptId(scriptId), scriptId);
    runTicks(interpreter, ctx, 0, maxTick, frames, normalizer);
  } finally {
    disposeSafe(interpreter);
    interpreter = null;
    EventBus.clear();
  }

  return frames;
}

export function runMissionTraceWithRestore(
  scriptId: string,
  maxTick: number,
  saveTick: number,
  seed = 424242,
): TokTraceFrame[] {
  if (saveTick < 0 || saveTick >= maxTick) {
    throw new Error(`saveTick must be in [0, ${maxTick - 1}], got ${saveTick}`);
  }

  resetDeterminism(seed);
  const ctx = createMockCtx();
  const frames: TokTraceFrame[] = [];
  const normalizer: ObjIdNormalizer = { nextCanonicalId: 1, canonicalByRawId: new Map() };
  const tokBuffer = readTokByScriptId(scriptId);
  let beforeRestore: TokInterpreter | null = new TokInterpreter();
  let afterRestore: TokInterpreter | null = null;

  try {
    beforeRestore.init(ctx, tokBuffer, scriptId);
    runTicks(beforeRestore, ctx, 0, saveTick, frames, normalizer);

    const identity = buildIdentityMap(ctx);
    const saveState: MissionScriptState = beforeRestore.serialize(identity);

    beforeRestore.dispose();
    beforeRestore = null;

    afterRestore = new TokInterpreter();
    afterRestore.init(ctx, tokBuffer, scriptId);
    afterRestore.restore(saveState, identity);

    runTicks(afterRestore, ctx, saveTick + 1, maxTick, frames, normalizer);
  } finally {
    disposeSafe(beforeRestore);
    disposeSafe(afterRestore);
    EventBus.clear();
  }

  return frames;
}
