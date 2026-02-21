import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TokInterpreter } from '../../../src/campaign/scripting/tok/TokInterpreter';
import { buildStringTable } from '../../../src/campaign/scripting/tok/TokStringTable';
import { FUNC, type TokExpr } from '../../../src/campaign/scripting/tok/TokTypes';
import { CombatSystem } from '../../../src/simulation/CombatSystem';
import { EventBus } from '../../../src/core/EventBus';
import { addComponent, AttackTarget, Combat, MoveTarget, Owner, buildingQuery, unitQuery } from '../../../src/core/ECS';

import { createMockCtx, spawnMockUnit, type MockCtx } from './mocks/MockGameContext';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const TOK_DIR = path.join(ROOT, 'assets/data/missions/tok');

function readTok(name: string): ArrayBuffer {
  const bytes = fs.readFileSync(path.join(TOK_DIR, `${name}.tok`));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
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

function encodeIntLiteral(value: number): number[] {
  return Array.from(String(value), (ch) => ch.charCodeAt(0));
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

describe('TokInterpreter integration', () => {
  beforeEach(() => {
    EventBus.clear();
  });

  it('executes ATP1D1FRFail: one-time AddSideCash at tick 0', () => {
    const ctx = createMockCtx();
    const interpreter = new TokInterpreter();

    interpreter.init(ctx, readTok('ATP1D1FRFail'), 'ATP1D1FRFail');

    interpreter.tick(ctx, 0);
    expect(ctx.harvestSystem.addSolaris).toHaveBeenCalledWith(1, 10000);
    expect(ctx.harvestSystem.addSolaris).toHaveBeenCalledTimes(1);

    interpreter.tick(ctx, 1);
    expect(ctx.harvestSystem.addSolaris).toHaveBeenCalledTimes(1);

    interpreter.dispose();
  });

  it('simulates ATP1D1FR wave logic across multiple ticks', () => {
    const ctx = createMockCtx();
    const interpreter = new TokInterpreter();

    interpreter.init(ctx, readTok('ATP1D1FR'), 'ATP1D1FR');

    // Tick 0: setup sides + friendly camp + opening message
    interpreter.tick(ctx, 0);

    const tokState0 = interpreter.serialize(new Map()).tokState!;
    expect(tokState0.intVars[1]).toBe(2);
    expect(tokState0.intVars[2]).toBe(3);
    expect(tokState0.intVars[3]).toBe(4);

    expect(ctx.__spawns.buildings.length).toBeGreaterThan(0);
    expect(ctx.selectionPanel.addMessage).toHaveBeenCalled();

    // Trigger wave 1: enemy side (1) has 5 units.
    for (let i = 0; i < 5; i++) {
      spawnMockUnit(ctx, 'CubScout', 1, 10 + i, 10 + i);
    }
    interpreter.tick(ctx, 1);

    expect(countUnitsForSide(ctx, 2)).toBe(7);

    const tokState1 = interpreter.serialize(new Map()).tokState!;
    expect(tokState1.intVars[4]).toBe(1); // wave-1 guard

    // Guard check: wave 1 should not fire again.
    interpreter.tick(ctx, 2);
    expect(countUnitsForSide(ctx, 2)).toBe(7);

    // Trigger wave 2 (enemy count >= 15).
    for (let i = 0; i < 10; i++) {
      spawnMockUnit(ctx, 'CubScout', 1, 30 + i, 30 + i);
    }
    interpreter.tick(ctx, 3);
    expect(countUnitsForSide(ctx, 3)).toBe(10);

    // Trigger wave 3 (enemy count >= 35).
    for (let i = 0; i < 20; i++) {
      spawnMockUnit(ctx, 'CubScout', 1, 60 + i, 60 + i);
    }
    interpreter.tick(ctx, 4);
    expect(countUnitsForSide(ctx, 4)).toBe(10);

    interpreter.dispose();
  });

  it('restores serialized state and continues without refiring completed wave guards', () => {
    const ctx = createMockCtx();
    const tokBuffer = readTok('ATP1D1FR');

    const a = new TokInterpreter();
    a.init(ctx, tokBuffer, 'ATP1D1FR');

    a.tick(ctx, 0);
    for (let i = 0; i < 5; i++) {
      spawnMockUnit(ctx, 'CubScout', 1, 90 + i, 90 + i);
    }
    a.tick(ctx, 1); // wave 1 fired

    const side2Before = countUnitsForSide(ctx, 2);
    expect(side2Before).toBe(7);

    const idMap = new Map<number, number>();
    for (const eid of ctx.__spawns.units) idMap.set(eid, eid);
    for (const eid of ctx.__spawns.buildings) idMap.set(eid, eid);

    const saved = a.serialize(idMap);
    a.dispose();

    const b = new TokInterpreter();
    b.init(ctx, tokBuffer, 'ATP1D1FR');
    b.restore(saved, idMap);

    // Enemy count still >= 5, but wave-1 guard should remain TRUE after restore.
    b.tick(ctx, 2);
    expect(countUnitsForSide(ctx, 2)).toBe(side2Before);

    b.dispose();
  });

  it('restores dispatch runtime state for AirStrikeDone continuity', () => {
    const ctx = createMockCtx();
    const tokBuffer = readTok('ATP1D1FRFail');
    const table = buildStringTable(ctx.typeRegistry);
    const strikeType = table.indexOf('ATOrni');
    expect(strikeType).toBeGreaterThanOrEqual(0);

    const lit = (value: number): TokExpr => ({ kind: 'literal', value });
    const strikePos: TokExpr = {
      kind: 'callExpr',
      funcId: FUNC.SetTilePos,
      args: [lit(20), lit(20)],
    };

    const a = new TokInterpreter();
    a.init(ctx, tokBuffer, 'ATP1D1FRFail');

    const dispatchA = (a as any).functions;
    const evaluatorA = (a as any).evaluator;

    dispatchA.call(FUNC.AirStrike, [
      lit(7),
      strikePos,
      lit(0),
      lit(strikeType),
      lit(strikeType),
    ], ctx, evaluatorA, 0);

    expect(ctx.__spawns.units.length).toBeGreaterThan(0);
    expect(dispatchA.call(FUNC.AirStrikeDone, [lit(7)], ctx, evaluatorA, 0)).toBe(0);

    const identity = buildIdentityEntityMap(ctx);
    const saved = a.serialize(identity);
    a.dispose();

    const b = new TokInterpreter();
    b.init(ctx, tokBuffer, 'ATP1D1FRFail');
    b.restore(saved, identity);

    const dispatchB = (b as any).functions;
    const evaluatorB = (b as any).evaluator;

    expect(dispatchB.call(FUNC.AirStrikeDone, [lit(7)], ctx, evaluatorB, 1)).toBe(0);

    const world = ctx.game.getWorld();
    for (const eid of unitQuery(world)) {
      if (Owner.playerId[eid] === 0) {
        MoveTarget.active[eid] = 0;
      }
    }
    expect(dispatchB.call(FUNC.AirStrikeDone, [lit(7)], ctx, evaluatorB, 2)).toBe(1);

    b.dispose();
  });

  it('restores non-combat dispatch runtime state (tooltip/color/camera)', () => {
    const ctx = createMockCtx();
    const tokBuffer = readTok('ATP1D1FRFail');
    const tracked = spawnMockUnit(ctx, 'CubScout', 0, 16, 18);
    const lit = (value: number): TokExpr => ({ kind: 'literal', value });

    const a = new TokInterpreter();
    a.init(ctx, tokBuffer, 'ATP1D1FRFail');

    const dispatchA = (a as any).functions;
    const evaluatorA = (a as any).evaluator;

    dispatchA.call(FUNC.ObjectToolTip, [lit(tracked), lit(91)], ctx, evaluatorA, 0);
    dispatchA.call(FUNC.SetSideColor, [lit(3), lit(0x33)], ctx, evaluatorA, 0);
    dispatchA.call(FUNC.CameraTrackObject, [lit(tracked)], ctx, evaluatorA, 0);
    dispatchA.call(FUNC.CameraStartRotate, [lit(6), lit(2)], ctx, evaluatorA, 0);

    const identity = buildIdentityEntityMap(ctx);
    const saved = a.serialize(identity);
    const before = saved.tokState?.dispatchState;
    expect(before).toBeDefined();
    expect(before?.mainCameraTrackEid).toBe(tracked);
    expect(before?.mainCameraSpin.active).toBe(true);
    expect(before?.mainCameraSpin.direction).toBe(-1);
    expect(before?.tooltipMap).toContainEqual({ entity: tracked, tooltipId: 91 });
    expect(before?.sideColors).toContainEqual({ side: 3, color: 0x33 });
    a.dispose();

    const b = new TokInterpreter();
    b.init(ctx, tokBuffer, 'ATP1D1FRFail');
    b.restore(saved, identity);

    const after = b.serialize(identity).tokState?.dispatchState;
    expect(after).toBeDefined();
    expect(after?.mainCameraTrackEid).toBe(tracked);
    expect(after?.mainCameraSpin.active).toBe(true);
    expect(after?.mainCameraSpin.direction).toBe(-1);
    expect(after?.tooltipMap).toContainEqual({ entity: tracked, tooltipId: 91 });
    expect(after?.sideColors).toContainEqual({ side: 3, color: 0x33 });

    const dispatchB = (b as any).functions;
    const evaluatorB = (b as any).evaluator;
    expect(dispatchB.call(FUNC.CameraIsSpinning, [], ctx, evaluatorB, 1)).toBe(1);

    b.dispose();
  });

  it('restores SetThreatLevel state into fresh gameRules on load', () => {
    const tokBuffer = readTok('ATP1D1FRFail');
    const lit = (value: number): TokExpr => ({ kind: 'literal', value });

    const ctxA = createMockCtx();
    const tableA = buildStringTable(ctxA.typeRegistry);
    const typeIndex = tableA.indexOf('CubScout');
    expect(typeIndex).toBeGreaterThanOrEqual(0);

    const a = new TokInterpreter();
    a.init(ctxA, tokBuffer, 'ATP1D1FRFail');
    const dispatchA = (a as any).functions;
    const evaluatorA = (a as any).evaluator;
    dispatchA.call(FUNC.SetThreatLevel, [lit(typeIndex), lit(9)], ctxA, evaluatorA, 0);

    const saved = a.serialize(new Map());
    a.dispose();

    const ctxB = createMockCtx();
    const b = new TokInterpreter();
    b.init(ctxB, tokBuffer, 'ATP1D1FRFail');
    b.restore(saved, new Map());

    expect((ctxB.gameRules.units.get('CubScout') as any).aiThreat).toBe(9);
    b.dispose();
  });

  it('re-initializing the same interpreter instance clears prior dispatch state', () => {
    const ctx = createMockCtx();
    const tokBuffer = readTok('ATP1D1FRFail');
    const table = buildStringTable(ctx.typeRegistry);
    const strikeType = table.indexOf('ATOrni');
    expect(strikeType).toBeGreaterThanOrEqual(0);

    const lit = (value: number): TokExpr => ({ kind: 'literal', value });
    const strikePos: TokExpr = {
      kind: 'callExpr',
      funcId: FUNC.SetTilePos,
      args: [lit(12), lit(12)],
    };

    const interpreter = new TokInterpreter();
    interpreter.init(ctx, tokBuffer, 'ATP1D1FRFail');

    const dispatchA = (interpreter as any).functions;
    const evaluatorA = (interpreter as any).evaluator;
    dispatchA.call(FUNC.AirStrike, [
      lit(7),
      strikePos,
      lit(0),
      lit(strikeType),
      lit(strikeType),
    ], ctx, evaluatorA, 0);
    expect(dispatchA.call(FUNC.AirStrikeDone, [lit(7)], ctx, evaluatorA, 0)).toBe(0);
    interpreter.dispose();

    interpreter.init(ctx, tokBuffer, 'ATP1D1FRFail');
    const dispatchB = (interpreter as any).functions;
    const evaluatorB = (interpreter as any).evaluator;

    // After re-init there should be no stale strike state.
    expect(dispatchB.call(FUNC.AirStrikeDone, [lit(7)], ctx, evaluatorB, 0)).toBe(1);
    interpreter.dispose();
  });

  it('re-initializing the same interpreter instance resets evaluator side state', () => {
    const ctx = createMockCtx();
    const tokBuffer = readTok('ATP1D1FR');
    const interpreter = new TokInterpreter();

    interpreter.init(ctx, tokBuffer, 'ATP1D1FR');
    interpreter.tick(ctx, 0);
    const first = interpreter.serialize(new Map()).tokState!;
    expect(first.intVars[1]).toBe(2);
    expect(first.intVars[2]).toBe(3);
    expect(first.intVars[3]).toBe(4);
    interpreter.dispose();

    interpreter.init(ctx, tokBuffer, 'ATP1D1FR');
    interpreter.tick(ctx, 0);
    const second = interpreter.serialize(new Map()).tokState!;
    expect(second.intVars[1]).toBe(2);
    expect(second.intVars[2]).toBe(3);
    expect(second.intVars[3]).toBe(4);
    interpreter.dispose();
  });

  it('does not leak EventBus listeners across re-init/dispose cycles', () => {
    const ctx = createMockCtx();
    const tokBuffer = readTok('ATP1D1FRFail');
    const interpreter = new TokInterpreter();
    const listeners = (EventBus as any).listeners as Map<string, Set<unknown>>;

    interpreter.init(ctx, tokBuffer, 'ATP1D1FRFail');
    expect(listeners.get('unit:attacked')?.size ?? 0).toBe(1);
    expect(listeners.get('unit:died')?.size ?? 0).toBe(1);
    expect(listeners.get('building:completed')?.size ?? 0).toBe(1);

    // Re-init should internally dispose and re-register exactly one listener per event.
    interpreter.init(ctx, tokBuffer, 'ATP1D1FRFail');
    expect(listeners.get('unit:attacked')?.size ?? 0).toBe(1);
    expect(listeners.get('unit:died')?.size ?? 0).toBe(1);
    expect(listeners.get('building:completed')?.size ?? 0).toBe(1);

    interpreter.dispose();
    expect(listeners.get('unit:attacked')?.size ?? 0).toBe(0);
    expect(listeners.get('unit:died')?.size ?? 0).toBe(0);
    expect(listeners.get('building:completed')?.size ?? 0).toBe(0);
  });

  it('records EventSideAttacksSide from unit:attacked events', () => {
    const ctx = createMockCtx();

    const script = buildTokBuffer([
      [0x80, 162, 0x28, 0x81, 0x81, 0x29], // int(v1)
      [
        0x80, 165, 0x28,                   // if (
        0x80, 0xaa, 0x80, 0x28,            // EventSideAttacksSide(
        0x80, 0x8e, 0x80, 0x28, 0x29,      // GetPlayerSide()
        0x2c,                               // ,
        0x80, 0x90, 0x80, 0x28, 0x29,      // GetEnemySide()
        0x29,                               // )
        0x80, 0xa8,                         // ==
        0x80, 0xb1,                         // TRUE
        0x29,                               // )
      ],
      [0x81, 0x81, 0x80, 0xb4, 0x80, 0xb1], // v1 = TRUE
      [0x80, 167],                           // endif
    ]);

    const interpreter = new TokInterpreter();
    interpreter.init(ctx, script, 'event_test');

    const attacker = spawnMockUnit(ctx, 'CubScout', 0, 10, 10);
    const target = spawnMockUnit(ctx, 'CubScout', 1, 12, 12);

    EventBus.emit('unit:attacked', { attackerEid: attacker, targetEid: target });
    interpreter.tick(ctx, 0);

    const state = interpreter.serialize(new Map()).tokState!;
    expect(state.intVars[1]).toBe(1);

    interpreter.dispose();
  });

  it('treats EventSideAttacksSide as a one-tick event flag', () => {
    const ctx = createMockCtx();

    const script = buildTokBuffer([
      [0x80, 162, 0x28, 0x81, 0x81, 0x29], // int(v1)
      [0x80, 165, 0x28, 0x80, 0xb1, 0x29],   // if (TRUE)
      [0x81, 0x81, 0x80, 0xb4, 0x80, 0xb0], //   v1 = FALSE
      [0x80, 167],                           // endif
      [
        0x80, 165, 0x28,                   // if (
        0x80, 0xaa, 0x80, 0x28,            // EventSideAttacksSide(
        0x80, 0x8e, 0x80, 0x28, 0x29,      // GetPlayerSide()
        0x2c,                               // ,
        0x80, 0x90, 0x80, 0x28, 0x29,      // GetEnemySide()
        0x29,                               // )
        0x80, 0xa8,                         // ==
        0x80, 0xb1,                         // TRUE
        0x29,                               // )
      ],
      [0x81, 0x81, 0x80, 0xb4, 0x80, 0xb1], // v1 = TRUE
      [0x80, 167],                           // endif
    ]);

    const interpreter = new TokInterpreter();
    interpreter.init(ctx, script, 'event_tick_window_test');

    const attacker = spawnMockUnit(ctx, 'CubScout', 0, 10, 10);
    const target = spawnMockUnit(ctx, 'CubScout', 1, 12, 12);

    EventBus.emit('unit:attacked', { attackerEid: attacker, targetEid: target });
    interpreter.tick(ctx, 0);
    expect(interpreter.serialize(new Map()).tokState!.intVars[1]).toBe(1);

    // No new event on tick 1: flag should be clear and v1 should reset to FALSE.
    interpreter.tick(ctx, 1);
    expect(interpreter.serialize(new Map()).tokState!.intVars[1]).toBe(0);

    interpreter.dispose();
  });

  it('ignores same-side unit:attacked events for side-attack tracking', () => {
    const ctx = createMockCtx();

    const script = buildTokBuffer([
      [0x80, 162, 0x28, 0x81, 0x81, 0x29], // int(v1)
      [
        0x80, 165, 0x28,                   // if (
        0x80, 0xaa, 0x80, 0x28,            // EventSideAttacksSide(
        0x80, 0x8e, 0x80, 0x28, 0x29,      // GetPlayerSide()
        0x2c,                               // ,
        0x80, 0x8e, 0x80, 0x28, 0x29,      // GetPlayerSide()
        0x29,                               // )
        0x80, 0xa8,                         // ==
        0x80, 0xb1,                         // TRUE
        0x29,                               // )
      ],
      [0x81, 0x81, 0x80, 0xb4, 0x80, 0xb1], // v1 = TRUE
      [0x80, 167],                           // endif
    ]);

    const interpreter = new TokInterpreter();
    interpreter.init(ctx, script, 'same_side_attack_test');

    const attacker = spawnMockUnit(ctx, 'CubScout', 0, 10, 10);
    const target = spawnMockUnit(ctx, 'CubScout', 0, 12, 12);

    EventBus.emit('unit:attacked', { attackerEid: attacker, targetEid: target });
    interpreter.tick(ctx, 0);

    expect(interpreter.serialize(new Map()).tokState!.intVars[1]).toBe(0);
    interpreter.dispose();
  });

  it('records EventObjectAttacksSide from unit:attacked events', () => {
    const ctx = createMockCtx();
    const attacker = spawnMockUnit(ctx, 'CubScout', 0, 10, 10);
    const target = spawnMockUnit(ctx, 'CubScout', 1, 12, 12);

    const script = buildTokBuffer([
      [0x80, 162, 0x28, 0x81, 0x81, 0x29], // int(v1)
      [
        0x80, 165, 0x28,                   // if (
        0x80, 0xab, 0x80, 0x28,            // EventObjectAttacksSide(
        ...encodeIntLiteral(attacker),     // attacker eid literal
        0x2c,                               // ,
        0x80, 0x90, 0x80, 0x28, 0x29,      // GetEnemySide()
        0x29,                               // )
        0x80, 0xa8,                         // ==
        0x80, 0xb1,                         // TRUE
        0x29,                               // )
      ],
      [0x81, 0x81, 0x80, 0xb4, 0x80, 0xb1], // v1 = TRUE
      [0x80, 167],                           // endif
    ]);

    const interpreter = new TokInterpreter();
    interpreter.init(ctx, script, 'event_object_attack_test');

    EventBus.emit('unit:attacked', { attackerEid: attacker, targetEid: target });
    interpreter.tick(ctx, 0);

    const state = interpreter.serialize(new Map()).tokState!;
    expect(state.intVars[1]).toBe(1);

    interpreter.dispose();
  });

  it('bridges CombatSystem fire events into Tok EventSideAttacksSide', () => {
    const ctx = createMockCtx();

    const script = buildTokBuffer([
      [0x80, 162, 0x28, 0x81, 0x81, 0x29], // int(v1)
      [
        0x80, 165, 0x28,                   // if (
        0x80, 0xaa, 0x80, 0x28,            // EventSideAttacksSide(
        0x80, 0x8e, 0x80, 0x28, 0x29,      // GetPlayerSide()
        0x2c,                               // ,
        0x80, 0x90, 0x80, 0x28, 0x29,      // GetEnemySide()
        0x29,                               // )
        0x80, 0xa8,                         // ==
        0x80, 0xb1,                         // TRUE
        0x29,                               // )
      ],
      [0x81, 0x81, 0x80, 0xb4, 0x80, 0xb1], // v1 = TRUE
      [0x80, 167],                           // endif
    ]);

    const interpreter = new TokInterpreter();
    interpreter.init(ctx, script, 'combat_bridge_test');

    const world = ctx.game.getWorld();
    const combat = new CombatSystem(ctx.gameRules as any);
    combat.init(world);

    const attacker = spawnMockUnit(ctx, 'CubScout', 0, 10, 10);
    const target = spawnMockUnit(ctx, 'CubScout', 1, 12, 12);

    addComponent(world, Combat, attacker);
    addComponent(world, AttackTarget, attacker);
    Combat.attackRange[attacker] = 25;
    Combat.fireTimer[attacker] = 0;
    Combat.rof[attacker] = 5;
    AttackTarget.entityId[attacker] = target;
    AttackTarget.active[attacker] = 1;

    combat.update(world, 0);
    interpreter.tick(ctx, 0);

    const state = interpreter.serialize(new Map()).tokState!;
    expect(state.intVars[1]).toBe(1);

    interpreter.dispose();
  });

  it('bridges CombatSystem fire events into Tok EventObjectAttacksSide', () => {
    const ctx = createMockCtx();
    const world = ctx.game.getWorld();

    const attacker = spawnMockUnit(ctx, 'CubScout', 0, 10, 10);
    const target = spawnMockUnit(ctx, 'CubScout', 1, 12, 12);

    const script = buildTokBuffer([
      [0x80, 162, 0x28, 0x81, 0x81, 0x29], // int(v1)
      [
        0x80, 165, 0x28,                   // if (
        0x80, 0xab, 0x80, 0x28,            // EventObjectAttacksSide(
        ...encodeIntLiteral(attacker),
        0x2c,                               // ,
        0x80, 0x90, 0x80, 0x28, 0x29,      // GetEnemySide()
        0x29,                               // )
        0x80, 0xa8,                         // ==
        0x80, 0xb1,                         // TRUE
        0x29,                               // )
      ],
      [0x81, 0x81, 0x80, 0xb4, 0x80, 0xb1], // v1 = TRUE
      [0x80, 167],                           // endif
    ]);

    const interpreter = new TokInterpreter();
    interpreter.init(ctx, script, 'combat_object_bridge_test');

    const combat = new CombatSystem(ctx.gameRules as any);
    combat.init(world);
    addComponent(world, Combat, attacker);
    addComponent(world, AttackTarget, attacker);
    Combat.attackRange[attacker] = 25;
    Combat.fireTimer[attacker] = 0;
    Combat.rof[attacker] = 5;
    AttackTarget.entityId[attacker] = target;
    AttackTarget.active[attacker] = 1;

    combat.update(world, 0);
    interpreter.tick(ctx, 0);

    const state = interpreter.serialize(new Map()).tokState!;
    expect(state.intVars[1]).toBe(1);

    interpreter.dispose();
  });

  it('handles BuildObject flow gated by GetSideSpice in ORP2M14IX', () => {
    const ctx = createMockCtx();
    const interpreter = new TokInterpreter();

    interpreter.init(ctx, readTok('ORP2M14IX'), 'ORP2M14IX');
    interpreter.tick(ctx, 0);

    const initState = interpreter.serialize(new Map()).tokState!;
    const builderSide = initState.intVars[0];
    expect(builderSide).toBeGreaterThanOrEqual(2);

    ctx.harvestSystem.addSolaris(builderSide, 4000);
    interpreter.tick(ctx, 101);

    const after = interpreter.serialize(new Map()).tokState!;
    expect(after.intVars[6]).toBe(1); // int_6 increments after EventObjectConstructed
    expect(after.intVars[1]).toBe(0); // int_1 reset to FALSE after handling

    let playerOwnedUnits = 0;
    const world = ctx.game.getWorld();
    for (const eid of unitQuery(world)) {
      if (Owner.playerId[eid] === 0) playerOwnedUnits++;
    }
    expect(playerOwnedUnits).toBeGreaterThan(0);

    interpreter.dispose();
  });
});
