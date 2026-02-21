import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TokFunctionDispatch } from '../../../src/campaign/scripting/tok/TokFunctions';
import { TokEvaluator } from '../../../src/campaign/scripting/tok/TokEvaluator';
import { buildStringTable } from '../../../src/campaign/scripting/tok/TokStringTable';
import { FUNC, VarType, type TokExpr } from '../../../src/campaign/scripting/tok/TokTypes';
import { BuildingType, Health, MoveTarget, Owner, Position, UnitType, hasComponent } from '../../../src/core/ECS';

import { createMockCtx, spawnMockBuilding, spawnMockUnit, type MockCtx } from './mocks/MockGameContext';

const lit = (value: number): TokExpr => ({ kind: 'literal', value });
const posVar = (slot: number): TokExpr => ({ kind: 'var', slot, varType: VarType.Pos });

function setPosVar(ev: TokEvaluator, slot: number, x: number, z: number): void {
  ev.setVar(slot, VarType.Pos, { x, z });
}

describe('TokFunctionDispatch', () => {
  let ctx: MockCtx;
  let ev: TokEvaluator;
  let dispatch: TokFunctionDispatch;
  let stringTable: string[];

  beforeEach(() => {
    ctx = createMockCtx();
    ev = new TokEvaluator();
    dispatch = new TokFunctionDispatch();
    stringTable = buildStringTable(ctx.typeRegistry);
    dispatch.setStringTable(stringTable);

    ev.initVars(new Map([
      [0, VarType.Pos],
      [1, VarType.Pos],
      [2, VarType.Int],
      [3, VarType.Int],
      [4, VarType.Int],
    ]), 8);
  });

  function call(funcId: number, args: TokExpr[], tick = 0): number {
    return dispatch.call(funcId, args, ctx, ev, tick) as number;
  }

  function indexOfType(typeName: string): number {
    const idx = stringTable.indexOf(typeName);
    expect(idx).toBeGreaterThanOrEqual(0);
    return idx;
  }

  describe('side management', () => {
    it('creates sides and sets relationships', () => {
      const a = call(FUNC.CreateSide, []);
      const b = call(FUNC.CreateSide, []);
      expect(a).toBe(2);
      expect(b).toBe(3);

      call(FUNC.SideEnemyTo, [lit(a), lit(b)]);
      expect(ev.sides.isEnemy(a, b)).toBe(true);

      call(FUNC.SideFriendTo, [lit(a), lit(0)]);
      expect(ev.sides.isFriend(a, 0)).toBe(true);
    });

    it('returns fixed player/enemy side IDs', () => {
      expect(call(FUNC.GetPlayerSide, [])).toBe(0);
      expect(call(FUNC.GetEnemySide, [])).toBe(1);
    });
  });

  describe('spawning', () => {
    it('spawns objects with NewObject', () => {
      setPosVar(ev, 0, 12, 24);
      const unitType = indexOfType('CubScout');
      const buildingType = indexOfType('FRCamp');

      const unitEid = call(FUNC.NewObject, [lit(2), lit(unitType), posVar(0)]);
      const buildingEid = call(FUNC.NewObject, [lit(2), lit(buildingType), posVar(0)]);

      const world = ctx.game.getWorld();
      expect(hasComponent(world, UnitType, unitEid)).toBe(true);
      expect(hasComponent(world, BuildingType, buildingEid)).toBe(true);
      expect(Owner.playerId[unitEid]).toBe(2);
      expect(Owner.playerId[buildingEid]).toBe(2);
    });

    it('spawns with NewObjectOffsetOrientation', () => {
      setPosVar(ev, 0, 30, 45);
      const unitType = indexOfType('TLScientist');

      const eid = call(FUNC.NewObjectOffsetOrientation, [
        lit(3), lit(unitType), posVar(0), lit(5), lit(2),
      ]);

      expect(hasComponent(ctx.game.getWorld(), UnitType, eid)).toBe(true);
      expect(Position.x[eid]).toBe(30);
      expect(Position.z[eid]).toBe(45);
    });
  });

  describe('queries', () => {
    it('counts side units', () => {
      spawnMockUnit(ctx, 'CubScout', 4, 10, 10);
      spawnMockUnit(ctx, 'CubScout', 4, 12, 12);
      spawnMockUnit(ctx, 'CubScout', 1, 20, 20);

      expect(call(FUNC.SideUnitCount, [lit(4)])).toBe(2);
      expect(call(FUNC.SideUnitCount, [lit(1)])).toBe(1);
    });

    it('reports SideAIDone based on move activity', () => {
      const eid = spawnMockUnit(ctx, 'CubScout', 5, 5, 5);
      MoveTarget.active[eid] = 1;
      expect(call(FUNC.SideAIDone, [lit(5)])).toBe(0);

      MoveTarget.active[eid] = 0;
      expect(call(FUNC.SideAIDone, [lit(5)])).toBe(1);
    });

    it('checks ObjectValid and ObjectDestroyed', () => {
      const eid = spawnMockUnit(ctx, 'CubScout', 1, 1, 1);
      expect(call(FUNC.ObjectValid, [lit(eid)])).toBe(1);
      expect(call(FUNC.ObjectDestroyed, [lit(eid)])).toBe(0);

      Health.current[eid] = 0;
      expect(call(FUNC.ObjectValid, [lit(eid)])).toBe(0);
      expect(call(FUNC.ObjectDestroyed, [lit(eid)])).toBe(1);
    });
  });

  describe('AI orders', () => {
    it('issues aggressive orders with attack-move', () => {
      const sideUnit = spawnMockUnit(ctx, 'CubScout', 2, 10, 10);
      spawnMockUnit(ctx, 'CubScout', 0, 50, 50);

      call(FUNC.SideAIAggressive, [lit(2)]);

      expect(MoveTarget.active[sideUnit]).toBe(1);
      expect(ctx.combatSystem.setAttackMove).toHaveBeenCalledWith(expect.arrayContaining([sideUnit]));
    });

    it('issues move/stop/attack-object orders', () => {
      const mover = spawnMockUnit(ctx, 'CubScout', 6, 0, 0);
      const target = spawnMockBuilding(ctx, 'FRCamp', 0, 40, 30);

      setPosVar(ev, 0, 20, 22);
      call(FUNC.SideAIMove, [lit(6), posVar(0)]);
      expect(MoveTarget.active[mover]).toBe(1);
      expect(MoveTarget.x[mover]).toBe(20);
      expect(MoveTarget.z[mover]).toBe(22);

      call(FUNC.SideAIStop, [lit(6)]);
      expect(MoveTarget.active[mover]).toBe(0);

      call(FUNC.SideAIAttackObject, [lit(6), lit(target)]);
      expect(MoveTarget.active[mover]).toBe(1);
      expect(MoveTarget.x[mover]).toBe(40);
      expect(MoveTarget.z[mover]).toBe(30);
      expect(ctx.combatSystem.setAttackMove).toHaveBeenCalled();
    });
  });

  describe('events', () => {
    it('reads EventObjectDestroyed and EventSideAttacksSide', () => {
      ev.events.objectDestroyed(11);
      ev.events.sideAttacksSide(2, 0);

      expect(call(FUNC.EventObjectDestroyed, [lit(11)])).toBe(1);
      expect(call(FUNC.EventObjectDestroyed, [lit(12)])).toBe(0);
      expect(call(FUNC.EventSideAttacksSide, [lit(2), lit(0)])).toBe(1);
      expect(call(FUNC.EventSideAttacksSide, [lit(0), lit(2)])).toBe(0);
    });
  });

  describe('credits', () => {
    it('adds/sets/gets side cash', () => {
      call(FUNC.AddSideCash, [lit(1), lit(250)]);
      expect(call(FUNC.GetSideCash, [lit(1)])).toBe(250);

      call(FUNC.SetSideCash, [lit(1), lit(900)]);
      expect(call(FUNC.GetSideCash, [lit(1)])).toBe(900);
    });
  });

  describe('camera', () => {
    it('pans camera to points and objects', () => {
      setPosVar(ev, 0, 11, 19);
      call(FUNC.CameraLookAtPoint, [posVar(0)]);
      call(FUNC.CameraPanToPoint, [posVar(0)]);
      expect(ctx.scene.panTo).toHaveBeenCalledWith(11, 19);

      const eid = spawnMockUnit(ctx, 'CubScout', 0, 33, 44);
      call(FUNC.PIPCameraTrackObject, [lit(eid)]);
      expect(ctx.scene.panTo).toHaveBeenCalledWith(33, 44);
    });
  });

  describe('victory', () => {
    it('dispatches mission/victory/defeat calls', () => {
      call(FUNC.MissionOutcome, [lit(1)]);
      call(FUNC.EndGameWin, []);
      call(FUNC.EndGameLose, []);

      expect(ctx.victorySystem.setVictoryCondition).toHaveBeenCalledWith('survival');
      expect(ctx.victorySystem.forceVictory).toHaveBeenCalledTimes(1);
      expect(ctx.victorySystem.forceDefeat).toHaveBeenCalledTimes(1);
    });
  });

  describe('special functions', () => {
    it('handles AirStrike and AirStrikeDone lifecycle', () => {
      setPosVar(ev, 1, 45, 45);
      const typeA = indexOfType('ATOrni');
      const typeB = indexOfType('ATOrni');

      call(FUNC.AirStrike, [lit(7), posVar(1), lit(2), lit(typeA), lit(typeB)]);
      expect(ctx.combatSystem.setAttackMove).toHaveBeenCalledTimes(1);

      const firstDone = call(FUNC.AirStrikeDone, [lit(7)]);
      expect(firstDone).toBe(0);

      const moveCalls = (ctx.combatSystem.setAttackMove as any).mock.calls;
      const strikeUnits: number[] = moveCalls[0][0];
      for (const eid of strikeUnits) {
        MoveTarget.active[eid] = 0;
      }

      const done = call(FUNC.AirStrikeDone, [lit(7)]);
      expect(done).toBe(1);
    });

    it('fires nukes and deploys MCVs', () => {
      setPosVar(ev, 0, 18, 27);
      call(FUNC.SideNuke, [lit(3), posVar(0)]);
      expect(ctx.superweaponSystem.fire).toHaveBeenCalledWith(3, 18, 27);

      const mcv = spawnMockUnit(ctx, 'MCV', 0, 20, 20);
      const conYard = call(FUNC.ObjectDeploy, [lit(mcv)]);
      expect(conYard).toBeGreaterThanOrEqual(0);
      expect(Health.current[mcv]).toBe(0);
      expect(hasComponent(ctx.game.getWorld(), BuildingType, conYard)).toBe(true);
    });
  });

  it('routes EventObjectAttacksSide from tracker', () => {
    ev.events.objectAttacksSide(77, 1);
    expect(call(FUNC.EventObjectAttacksSide, [lit(77), lit(1)])).toBe(1);
    expect(call(FUNC.EventObjectAttacksSide, [lit(78), lit(1)])).toBe(0);
  });

  it('forwards messages into selection panel', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    call(FUNC.Message, [lit(61)]);
    call(FUNC.GiftingMessage, [lit(62)]);
    call(FUNC.TimerMessage, [lit(63)]);
    expect(ctx.selectionPanel.addMessage).toHaveBeenCalledTimes(3);
  });
});
