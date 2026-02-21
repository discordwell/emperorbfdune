import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TokInterpreter } from '../../../../src/campaign/scripting/tok/TokInterpreter';
import { EventBus } from '../../../../src/core/EventBus';
import { Owner, buildingQuery, unitQuery } from '../../../../src/core/ECS';
import { buildSaveRestoreFinalHash } from './missionOracle';
import { sha256Hex } from './hash';
import { runFreshMissionTrace } from '../traceHarness';
import type { TokBranchOracleDatasetV1, TokBranchScenarioEntryV1 } from './oracleTypes';
import { TOK_ORACLE_SCHEMA_VERSION } from './oracleTypes';
import { createMockCtx, spawnMockUnit, type MockCtx } from '../mocks/MockGameContext';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../../');
const TOK_DIR = path.join(ROOT, 'assets/data/missions/tok');

function readTok(name: string): ArrayBuffer {
  const bytes = fs.readFileSync(path.join(TOK_DIR, `${name}.tok`));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function countUnitsForSide(ctx: MockCtx, side: number): number {
  let count = 0;
  const world = ctx.game.getWorld();
  for (const eid of unitQuery(world)) {
    if (Owner.playerId[eid] === side) count++;
  }
  return count;
}

function buildIdentityEntityMap(ctx: MockCtx): Map<number, number> {
  const world = ctx.game.getWorld();
  const map = new Map<number, number>();
  for (const eid of unitQuery(world)) map.set(eid, eid);
  for (const eid of buildingQuery(world)) map.set(eid, eid);
  return map;
}

function buildTokBuffer(segments: number[][]): ArrayBuffer {
  const payload: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    payload.push(...segments[i]);
    if (i < segments.length - 1) payload.push(0x00);
  }
  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, true);
  view.setUint32(4, segments.length - 1, true);
  out.set(payload, 8);
  return out.buffer;
}

function scenarioCashOnce(): TokBranchScenarioEntryV1 {
  EventBus.clear();
  const ctx = createMockCtx();
  const interpreter = new TokInterpreter();
  interpreter.init(ctx, readTok('ATP1D1FRFail'), 'ATP1D1FRFail');
  interpreter.tick(ctx, 0);
  interpreter.tick(ctx, 1);

  const calls = (ctx.harvestSystem.addSolaris as any).mock.calls.map((c: unknown[]) => [
    Number(c[0]),
    Number(c[1]),
  ]);
  const tokState = interpreter.serialize(new Map()).tokState!;
  interpreter.dispose();
  EventBus.clear();

  return {
    id: 'atp1d1frfail_cash_once',
    description: 'ATP1D1FRFail grants 10000 credits exactly once on startup.',
    signals: {
      addSolarisCallCount: calls.length,
      addSolarisCalls: calls.flat(),
      finalIntVar1: tokState.intVars[1] ?? -1,
    },
  };
}

function scenarioWaveProgression(): TokBranchScenarioEntryV1 {
  EventBus.clear();
  const ctx = createMockCtx();
  const interpreter = new TokInterpreter();

  interpreter.init(ctx, readTok('ATP1D1FR'), 'ATP1D1FR');

  interpreter.tick(ctx, 0);
  const setup = interpreter.serialize(new Map()).tokState!;

  for (let i = 0; i < 5; i++) spawnMockUnit(ctx, 'CubScout', 1, 10 + i, 10 + i);
  interpreter.tick(ctx, 1);
  const side2AfterWave1 = countUnitsForSide(ctx, 2);

  interpreter.tick(ctx, 2);
  const side2AfterGuardTick = countUnitsForSide(ctx, 2);

  for (let i = 0; i < 10; i++) spawnMockUnit(ctx, 'CubScout', 1, 30 + i, 30 + i);
  interpreter.tick(ctx, 3);
  const side3AfterWave2 = countUnitsForSide(ctx, 3);

  for (let i = 0; i < 20; i++) spawnMockUnit(ctx, 'CubScout', 1, 60 + i, 60 + i);
  interpreter.tick(ctx, 4);
  const side4AfterWave3 = countUnitsForSide(ctx, 4);

  const final = interpreter.serialize(new Map()).tokState!;
  interpreter.dispose();
  EventBus.clear();

  return {
    id: 'atp1d1fr_wave_progression',
    description: 'ATP1D1FR wave triggers fire once at expected SideUnitCount thresholds.',
    signals: {
      setupSides: [setup.intVars[1], setup.intVars[2], setup.intVars[3]],
      side2AfterWave1,
      side2AfterGuardTick,
      side3AfterWave2,
      side4AfterWave3,
      guardInts: [final.intVars[4], final.intVars[5], final.intVars[6]],
      messageCount: (ctx.selectionPanel.addMessage as any).mock.calls.length,
    },
  };
}

function scenarioWaveRestoreGuard(): TokBranchScenarioEntryV1 {
  EventBus.clear();
  const ctx = createMockCtx();
  const tok = readTok('ATP1D1FR');

  const a = new TokInterpreter();
  a.init(ctx, tok, 'ATP1D1FR');
  a.tick(ctx, 0);
  for (let i = 0; i < 5; i++) spawnMockUnit(ctx, 'CubScout', 1, 90 + i, 90 + i);
  a.tick(ctx, 1);
  const side2Before = countUnitsForSide(ctx, 2);

  const idMap = buildIdentityEntityMap(ctx);
  const save = a.serialize(idMap);
  a.dispose();

  const b = new TokInterpreter();
  b.init(ctx, tok, 'ATP1D1FR');
  b.restore(save, idMap);
  b.tick(ctx, 2);

  const side2After = countUnitsForSide(ctx, 2);
  const state = b.serialize(idMap).tokState!;
  b.dispose();
  EventBus.clear();

  return {
    id: 'atp1d1fr_restore_wave_guard',
    description: 'Wave guard survives save/restore and prevents duplicate wave spawn.',
    signals: {
      side2Before,
      side2After,
      wave1GuardInt4: state.intVars[4],
    },
  };
}

function scenarioHouseStartMatrix(): TokBranchScenarioEntryV1 {
  EventBus.clear();
  const seed = 4242;
  const maxTick = 120;
  const scripts = ['ATStart', 'HKStart', 'ORStart'];
  const hashes: string[] = [];

  for (const scriptId of scripts) {
    const frames = runFreshMissionTrace(scriptId, maxTick, seed);
    const final = frames[frames.length - 1];
    hashes.push(`${scriptId}:${final?.tick ?? -1}:${final ? final.intVars.slice(0, 6).join(',') : ''}`);
  }
  EventBus.clear();

  return {
    id: 'house_start_matrix',
    description: 'House start scripts remain deterministic with stable startup side state.',
    signals: {
      seed,
      maxTick,
      signatures: hashes,
    },
  };
}

function scenarioEventSideAttacksSide(): TokBranchScenarioEntryV1 {
  EventBus.clear();
  const ctx = createMockCtx();

  const script = buildTokBuffer([
    [0x80, 162, 0x28, 0x81, 0x81, 0x29], // int(v1)
    [
      0x80, 165, 0x28,
      0x80, 0xaa, 0x80, 0x28, // EventSideAttacksSide(
      0x80, 0x8e, 0x80, 0x28, 0x29, // GetPlayerSide()
      0x2c,
      0x80, 0x90, 0x80, 0x28, 0x29, // GetEnemySide()
      0x29,
      0x80, 0xa8,
      0x80, 0xb1,
      0x29,
    ],
    [0x81, 0x81, 0x80, 0xb4, 0x80, 0xb1], // v1 = TRUE
    [0x80, 167], // endif;
  ]);

  const interpreter = new TokInterpreter();
  interpreter.init(ctx, script, 'oracle_event_side_attack');
  const attacker = spawnMockUnit(ctx, 'CubScout', 0, 10, 10);
  const target = spawnMockUnit(ctx, 'CubScout', 1, 12, 12);
  EventBus.emit('unit:attacked', { attackerEid: attacker, targetEid: target });
  interpreter.tick(ctx, 0);
  const state = interpreter.serialize(new Map()).tokState!;
  interpreter.dispose();
  EventBus.clear();

  return {
    id: 'event_side_attacks_side',
    description: 'unit:attacked events set EventSideAttacksSide flags in the same tick.',
    signals: {
      intVar1: state.intVars[1] ?? 0,
      eventFlags: Object.keys(state.eventFlags).sort(),
    },
  };
}

function scenarioSaveRestoreTutorial(): TokBranchScenarioEntryV1 {
  const seed = 2025;
  const scriptId = 'ATTutorial';
  const maxTick = 220;
  const saveTick = 70;
  const fresh = runFreshMissionTrace(scriptId, maxTick, seed);
  const freshFinal = fresh[fresh.length - 1];
  const freshFinalHash = freshFinal ? sha256Hex(freshFinal) : '';
  const restoredFinalHash = buildSaveRestoreFinalHash(scriptId, maxTick, saveTick, seed);

  return {
    id: 'tutorial_save_restore',
    description: 'ATTutorial final VM state remains identical after save/restore continuation.',
    signals: {
      scriptId,
      maxTick,
      saveTick,
      freshFinalTick: freshFinal?.tick ?? -1,
      freshFinalHash,
      restoredFinalHash,
      matchesAfterRestore: freshFinalHash === restoredFinalHash,
    },
  };
}

export function buildBranchOracleDataset(): TokBranchOracleDatasetV1 {
  const scenarios = [
    scenarioCashOnce(),
    scenarioWaveProgression(),
    scenarioWaveRestoreGuard(),
    scenarioHouseStartMatrix(),
    scenarioEventSideAttacksSide(),
    scenarioSaveRestoreTutorial(),
  ];

  const table: Record<string, TokBranchScenarioEntryV1> = {};
  for (const scenario of scenarios) {
    table[scenario.id] = scenario;
  }

  return {
    schemaVersion: TOK_ORACLE_SCHEMA_VERSION,
    generator: 'tok-branch-oracle-v1',
    generatedAt: new Date().toISOString(),
    scenarios: table,
  };
}
