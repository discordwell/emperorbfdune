import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TokInterpreter } from '../../../../src/campaign/scripting/tok/TokInterpreter';
import { EventBus } from '../../../../src/core/EventBus';
import {
  Position,
  Health,
  Owner,
  UnitType,
  BuildingType,
  MoveTarget,
  AttackTarget,
  Harvester,
  Veterancy,
  Combat,
  Shield,
  Speed,
  Production,
  hasComponent,
  unitQuery,
  buildingQuery,
  type World,
} from '../../../../src/core/ECS';
import { simRng } from '../../../../src/utils/DeterministicRNG';
import { createMockCtx } from '../mocks/MockGameContext';
import type {
  TokSimulationHashCheckpointV1,
  TokSimulationHashDatasetV1,
  TokSimulationHashEntryV1,
} from './oracleTypes';
import { TOK_ORACLE_SCHEMA_VERSION } from './oracleTypes';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../../');
const TOK_DIR = path.join(ROOT, 'assets/data/missions/tok');

export const DEFAULT_SIMHASH_SEED = 7331;
export const DEFAULT_SIMHASH_MAX_TICK = 120;
export const HEADER_SIMHASH_MAX_TICK = 12;
export const DEFAULT_SIMHASH_STRIDE = 20;

export const FAST_SIMHASH_SCRIPTS = [
  'ATP1D1FR',
  'ATP1D3SA',
  'ATTutorial',
  'ATStart',
  'HKStart',
  'ORStart',
  'HKP2M17TL',
  'ORP2M18TL',
  'ORP3D10TL',
  'Atreides Heighliner Mission',
  'Ordos Homeworld Defense',
  'header',
] as const;

export interface BuildSimulationHashDatasetOptions {
  scriptIds: string[];
  seed?: number;
  defaultMaxTick?: number;
  headerMaxTick?: number;
  checkpointStride?: number;
  fastScripts?: string[];
}

export function discoverSimHashScriptIds(): string[] {
  return fs.readdirSync(TOK_DIR)
    .filter((f) => f.endsWith('.tok'))
    .map((f) => f.replace(/\.tok$/i, ''))
    .sort((a, b) => a.localeCompare(b));
}

export function buildSimulationHashDataset(options: BuildSimulationHashDatasetOptions): TokSimulationHashDatasetV1 {
  const seed = options.seed ?? DEFAULT_SIMHASH_SEED;
  const defaultMaxTick = options.defaultMaxTick ?? DEFAULT_SIMHASH_MAX_TICK;
  const headerMaxTick = options.headerMaxTick ?? HEADER_SIMHASH_MAX_TICK;
  const checkpointStride = options.checkpointStride ?? DEFAULT_SIMHASH_STRIDE;

  const missions: Record<string, TokSimulationHashEntryV1> = {};
  for (const scriptId of options.scriptIds) {
    const maxTick = scriptId === 'header' ? headerMaxTick : defaultMaxTick;
    missions[scriptId] = buildSimulationHashEntry(scriptId, maxTick, checkpointStride, seed);
  }

  return {
    schemaVersion: TOK_ORACLE_SCHEMA_VERSION,
    generator: 'tok-simhash-oracle-v1',
    generatedAt: new Date().toISOString(),
    seed,
    defaultMaxTick,
    headerMaxTick,
    checkpointStride,
    fastScripts: (options.fastScripts ?? [...FAST_SIMHASH_SCRIPTS]).filter((s) => missions[s]),
    missions,
  };
}

function buildSimulationHashEntry(
  scriptId: string,
  maxTick: number,
  checkpointStride: number,
  seed: number,
): TokSimulationHashEntryV1 {
  const ctx = createMockCtx();
  const interpreter = new TokInterpreter();
  const tokBuffer = readTok(scriptId);

  EventBus.clear();
  simRng.reseed(seed);
  interpreter.init(ctx, tokBuffer, scriptId);

  const checkpoints: TokSimulationHashCheckpointV1[] = [];
  try {
    for (let tick = 0; tick <= maxTick; tick++) {
      interpreter.tick(ctx, tick);

      if (tick % checkpointStride === 0 || tick === maxTick) {
        checkpoints.push({
          tick,
          hash: computeCanonicalSimulationHash(ctx.game.getWorld(), creditSnapshot(ctx)),
        });
      }
    }
  } finally {
    interpreter.dispose();
    EventBus.clear();
  }

  return {
    scriptId,
    maxTick,
    checkpoints,
  };
}

function creditSnapshot(ctx: ReturnType<typeof createMockCtx>): Map<number, number> {
  const map = new Map<number, number>();
  for (let playerId = 0; playerId <= 12; playerId++) {
    map.set(playerId, ctx.harvestSystem.getSolaris(playerId));
  }
  return map;
}

function readTok(scriptId: string): ArrayBuffer {
  const bytes = fs.readFileSync(path.join(TOK_DIR, `${scriptId}.tok`));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function computeCanonicalSimulationHash(world: World, playerCreditsMap: Map<number, number>): number {
  let h = 0x811c9dc5; // FNV offset basis
  const rngState = simRng.getState();
  h = fnvMix(h, rngState[0]);
  h = fnvMix(h, rngState[1]);
  h = fnvMix(h, rngState[2]);
  h = fnvMix(h, rngState[3]);

  for (let i = 0; i <= 12; i++) {
    h = fnvMixF32(h, playerCreditsMap.get(i) ?? 0);
  }

  const units = [...unitQuery(world)].sort(compareUnit);
  const buildings = [...buildingQuery(world)].sort(compareBuilding);
  const canonicalByEid = new Map<number, number>();
  let nextCanonical = 1;
  for (const eid of units) canonicalByEid.set(eid, nextCanonical++);
  for (const eid of buildings) canonicalByEid.set(eid, nextCanonical++);

  for (const eid of units) {
    h = fnvMix(h, canonicalByEid.get(eid)!);
    h = fnvMixF32(h, Position.x[eid]);
    h = fnvMixF32(h, Position.z[eid]);
    h = fnvMixF32(h, Health.current[eid]);
    h = fnvMix(h, Owner.playerId[eid]);
    h = fnvMix(h, UnitType.id[eid]);
    h = fnvMix(h, MoveTarget.active[eid]);
    if (MoveTarget.active[eid]) {
      h = fnvMixF32(h, MoveTarget.x[eid]);
      h = fnvMixF32(h, MoveTarget.z[eid]);
    }
    h = fnvMix(h, AttackTarget.active[eid]);
    if (AttackTarget.active[eid]) {
      h = fnvMix(h, canonicalByEid.get(AttackTarget.entityId[eid]) ?? -1);
    }
    h = fnvMixF32(h, Combat.fireTimer[eid]);
    h = fnvMixF32(h, Speed.max[eid]);
    h = fnvMix(h, Veterancy.rank[eid]);
    if (hasComponent(world, Harvester, eid)) {
      h = fnvMix(h, Harvester.state[eid]);
      h = fnvMixF32(h, Harvester.spiceCarried[eid]);
    }
    h = fnvMixF32(h, Shield.current[eid]);
    h = fnvMixF32(h, Shield.max[eid]);
  }

  for (const eid of buildings) {
    h = fnvMix(h, canonicalByEid.get(eid)!);
    h = fnvMixF32(h, Position.x[eid]);
    h = fnvMixF32(h, Position.z[eid]);
    h = fnvMixF32(h, Health.current[eid]);
    h = fnvMix(h, Owner.playerId[eid]);
    h = fnvMix(h, BuildingType.id[eid]);
    if (hasComponent(world, Production, eid)) {
      h = fnvMix(h, Production.queueSlot0[eid]);
      h = fnvMixF32(h, Production.progress[eid]);
      h = fnvMix(h, Production.active[eid]);
    }
  }

  return h >>> 0;
}

function compareUnit(a: number, b: number): number {
  if (Owner.playerId[a] !== Owner.playerId[b]) return Owner.playerId[a] - Owner.playerId[b];
  if (UnitType.id[a] !== UnitType.id[b]) return UnitType.id[a] - UnitType.id[b];
  if (Position.x[a] !== Position.x[b]) return Position.x[a] - Position.x[b];
  if (Position.z[a] !== Position.z[b]) return Position.z[a] - Position.z[b];
  if (Health.current[a] !== Health.current[b]) return Health.current[a] - Health.current[b];
  return a - b;
}

function compareBuilding(a: number, b: number): number {
  if (Owner.playerId[a] !== Owner.playerId[b]) return Owner.playerId[a] - Owner.playerId[b];
  if (BuildingType.id[a] !== BuildingType.id[b]) return BuildingType.id[a] - BuildingType.id[b];
  if (Position.x[a] !== Position.x[b]) return Position.x[a] - Position.x[b];
  if (Position.z[a] !== Position.z[b]) return Position.z[a] - Position.z[b];
  if (Health.current[a] !== Health.current[b]) return Health.current[a] - Health.current[b];
  return a - b;
}

function fnvMix(h: number, val: number): number {
  h ^= val & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (val >>> 8) & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (val >>> 16) & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (val >>> 24) & 0xff;
  h = Math.imul(h, 0x01000193);
  return h;
}

const f32Buf = new Float32Array(1);
const u32View = new Uint32Array(f32Buf.buffer);
function fnvMixF32(h: number, val: number): number {
  f32Buf[0] = val;
  return fnvMix(h, u32View[0]);
}
