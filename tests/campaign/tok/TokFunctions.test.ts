import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TokFunctionDispatch } from '../../../src/campaign/scripting/tok/TokFunctions';
import { TokEvaluator } from '../../../src/campaign/scripting/tok/TokEvaluator';
import { buildStringTable } from '../../../src/campaign/scripting/tok/TokStringTable';
import { FUNC, VarType, type TokExpr } from '../../../src/campaign/scripting/tok/TokTypes';
import { BuildingType, Health, MoveTarget, Owner, Position, UnitType, hasComponent } from '../../../src/core/ECS';

import { createMockCtx, spawnMockBuilding, spawnMockUnit, type MockCtx } from './mocks/MockGameContext';

const lit = (value: number): TokExpr => ({ kind: 'literal', value });
const posVar = (slot: number): TokExpr => ({ kind: 'var', slot, varType: VarType.Pos });
const objVar = (slot: number): TokExpr => ({ kind: 'var', slot, varType: VarType.Obj });

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
      [5, VarType.Obj],
      [6, VarType.Obj],
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
      expect(call(FUNC.GetSecondPlayerSide, [])).toBe(1);
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

    it('spawns with NewObjectOffsetOrientation applying tile offsets', () => {
      setPosVar(ev, 0, 30, 45);
      const unitType = indexOfType('TLScientist');

      const eid = call(FUNC.NewObjectOffsetOrientation, [
        lit(3), lit(unitType), posVar(0), lit(5), lit(2), lit(1),
      ]);

      expect(hasComponent(ctx.game.getWorld(), UnitType, eid)).toBe(true);
      // Base (30,45) + offset (5,2) * TILE_SIZE(2) = (40, 49)
      expect(Position.x[eid]).toBe(40);
      expect(Position.z[eid]).toBe(49);
    });
  });

  describe('object mutation', () => {
    it('morphs entities in-place via ObjectInfect and ObjectDetonate', () => {
      const original = spawnMockUnit(ctx, 'CubScout', 2, 8, 9);
      const saboteurType = indexOfType('ORSaboteur');
      const carryallType = indexOfType('ORADVCarryall');

      // ObjectInfect morphs in-place: same entity ID, new type/owner
      const infected = call(FUNC.ObjectInfect, [lit(original), lit(saboteurType), lit(4)]);
      expect(infected).toBe(original); // Preserves entity ID
      expect(Health.current[infected]).toBeGreaterThan(0);
      expect(Owner.playerId[infected]).toBe(4);

      // ObjectDetonate also morphs in-place
      const detonated = call(FUNC.ObjectDetonate, [lit(infected), lit(carryallType)]);
      expect(detonated).toBe(infected); // Still same entity ID
      expect(Health.current[detonated]).toBeGreaterThan(0);
      expect(Owner.playerId[detonated]).toBe(4);
    });

    it('undeploys conyards back into MCVs', () => {
      const conYard = spawnMockBuilding(ctx, 'ATConYard', 2, 14, 18);
      const undeployed = call(FUNC.ObjectUndeploy, [lit(conYard)]);
      expect(undeployed).toBeGreaterThanOrEqual(0);
      expect(Health.current[conYard]).toBe(0);
      expect(hasComponent(ctx.game.getWorld(), UnitType, undeployed)).toBe(true);
      expect(Owner.playerId[undeployed]).toBe(2);
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

    it('checks whether a unit is carried by transport', () => {
      const passenger = spawnMockUnit(ctx, 'CubScout', 1, 5, 5);
      (ctx.abilitySystem as any).getTransportPassengers = vi.fn(() => new Map([[55, [passenger]]]));
      expect(call(FUNC.ObjectIsCarried, [lit(passenger)])).toBe(1);
      expect(call(FUNC.ObjectIsCarried, [lit(passenger + 1)])).toBe(0);
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

    it('handles SideAIEnterBuilding by consuming nearby units', () => {
      const target = spawnMockBuilding(ctx, 'FRCamp', 0, 20, 20);
      const near = spawnMockUnit(ctx, 'CubScout', 6, 22, 21);
      const far = spawnMockUnit(ctx, 'CubScout', 6, 80, 80);

      const entered = call(FUNC.SideAIEnterBuilding, [lit(6), lit(target)]);
      expect(entered).toBe(1);
      expect(Health.current[near]).toBe(0);
      expect(MoveTarget.active[far]).toBe(1);
      expect(MoveTarget.x[far]).toBe(20);
      expect(MoveTarget.z[far]).toBe(20);
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

    it('writes out object vars for delivered/constructed event queries', () => {
      const typeIdx = indexOfType('FRCamp');
      ev.events.objectDelivered(4, 121);
      ev.events.objectConstructed(4, 122);
      ev.events.objectTypeConstructed(4, dispatch.resolveString(typeIdx), 123);

      expect(call(FUNC.EventObjectDelivered, [lit(4), objVar(5)])).toBe(1);
      expect(ev.getVar(5, VarType.Obj)).toBe(121);
      expect(call(FUNC.EventObjectDelivered, [lit(4), objVar(5)])).toBe(0);

      expect(call(FUNC.EventObjectConstructed, [lit(4), objVar(6)])).toBe(1);
      expect(ev.getVar(6, VarType.Obj)).toBe(122);
      expect(call(FUNC.EventObjectConstructed, [lit(4), objVar(6)])).toBe(0);

      expect(call(FUNC.EventObjectTypeConstructed, [lit(4), lit(typeIdx), objVar(6)])).toBe(1);
      expect(ev.getVar(6, VarType.Obj)).toBe(123);
      expect(call(FUNC.EventObjectTypeConstructed, [lit(4), lit(typeIdx), objVar(6)])).toBe(0);
    });
  });

  describe('credits', () => {
    it('adds/sets/gets side cash', () => {
      call(FUNC.AddSideCash, [lit(1), lit(250)]);
      expect(call(FUNC.GetSideCash, [lit(1)])).toBe(250);
      expect(call(FUNC.GetSideSpice, [lit(1)])).toBe(250);

      call(FUNC.SetSideCash, [lit(1), lit(900)]);
      expect(call(FUNC.GetSideCash, [lit(1)])).toBe(900);
      expect(call(FUNC.GetSideSpice, [lit(1)])).toBe(900);
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

    it('stores/restores camera state and tracks spin flags', () => {
      (ctx.scene as any).snapTo(9, 10);
      (ctx.scene as any).setZoom(42);
      (ctx.scene as any).setRotation(0.3);

      call(FUNC.CameraStore, []);
      call(FUNC.CameraZoomTo, [lit(0), lit(70)]);
      call(FUNC.CameraStartRotate, [lit(2), lit(1)]);
      call(FUNC.ModelTick, [], 40);
      expect(call(FUNC.CameraIsSpinning, [])).toBe(1);
      expect((ctx.scene as any).rotateCamera).toHaveBeenCalled();

      call(FUNC.CameraStopRotate, []);
      expect(call(FUNC.CameraIsSpinning, [])).toBe(0);

      call(FUNC.CameraRestore, [lit(80)]);
      expect((ctx.scene as any).snapTo).toHaveBeenCalledWith(9, 10);
      expect((ctx.scene as any).setZoom).toHaveBeenCalledWith(42);
      expect((ctx.scene as any).setRotation).toHaveBeenCalledWith(0.3);
    });
  });

  describe('radar', () => {
    it('forces radar enabled when requested by script', () => {
      expect(call(FUNC.RadarEnabled, [])).toBe(1);
      expect((ctx.minimapRenderer as any).setRadarActive).toHaveBeenCalledWith(true);
      expect((ctx as any).__tokForceRadarEnabled).toBe(true);
    });
  });

  describe('fog of war', () => {
    it('reveals the full map via RemoveMapShroud', () => {
      call(FUNC.RemoveMapShroud, []);
      expect(ctx.fogOfWar.revealWorldArea).toHaveBeenCalledTimes(1);
    });

    it('re-covers an area via ReplaceShroud', () => {
      setPosVar(ev, 0, 20, 30);
      call(FUNC.ReplaceShroud, [posVar(0), lit(12)]);
      expect((ctx.fogOfWar as any).coverWorldArea).toHaveBeenCalledWith(20, 30, 12);
    });
  });

  describe('misc script helpers', () => {
    it('tracks side colors and returns them', () => {
      call(FUNC.SetSideColor, [lit(3), lit(7)]);
      expect(call(FUNC.GetSideColor, [lit(3)])).toBe(7);
      expect(call(FUNC.GetSideColor, [lit(2)])).toBe(0);
    });

    it('updates threat level for type definitions', () => {
      const typeIdx = indexOfType('ATRepairUnit');
      call(FUNC.SetThreatLevel, [lit(typeIdx), lit(80)]);
      const def = ctx.gameRules.units.get('ATRepairUnit') as any;
      expect(def.aiThreat).toBe(80);
    });

    it('converts tile coordinates to world positions with SetTilePos', () => {
      const pos = dispatch.call(FUNC.SetTilePos, [lit(207), lit(108)], ctx, ev, 0) as { x: number; z: number };
      expect(pos).toEqual({ x: 414, z: 216 });
    });

    it('toggles player interaction for freeze/ui script calls', () => {
      call(FUNC.DisableUI, []);
      expect((ctx.input as any).setEnabled).toHaveBeenCalledWith(false);
      expect((ctx.selectionManager as any).setEnabled).toHaveBeenCalledWith(false);
      expect((ctx.commandManager as any).setEnabled).toHaveBeenCalledWith(false);

      call(FUNC.EnableUI, []);
      expect((ctx.input as any).setEnabled).toHaveBeenCalledWith(true);
      expect((ctx.selectionManager as any).setEnabled).toHaveBeenCalledWith(true);
      expect((ctx.commandManager as any).setEnabled).toHaveBeenCalledWith(true);

      call(FUNC.FreezeGame, []);
      expect((ctx.input as any).setEnabled).toHaveBeenCalledWith(false);
      call(FUNC.UnFreezeGame, []);
      expect((ctx.input as any).setEnabled).toHaveBeenCalledWith(true);
    });
  });

  describe('victory', () => {
    it('dispatches MissionOutcome(TRUE) as victory', () => {
      call(FUNC.MissionOutcome, [lit(1)]);
      expect(ctx.victorySystem.setVictoryCondition).toHaveBeenCalledWith('annihilate');
      expect(ctx.victorySystem.forceVictory).toHaveBeenCalledTimes(1);
    });

    it('dispatches MissionOutcome(FALSE) as defeat', () => {
      call(FUNC.MissionOutcome, [lit(0)]);
      expect(ctx.victorySystem.forceDefeat).toHaveBeenCalledTimes(1);
    });

    it('dispatches EndGameWin / EndGameLose', () => {
      call(FUNC.EndGameWin, []);
      call(FUNC.EndGameLose, []);
      expect(ctx.victorySystem.forceVictory).toHaveBeenCalledTimes(1);
      expect(ctx.victorySystem.forceDefeat).toHaveBeenCalledTimes(1);
    });

    it('evaluates NormalConditionLose based on surviving forces', () => {
      expect(call(FUNC.NormalConditionLose, [lit(8)])).toBe(1);

      const b = spawnMockBuilding(ctx, 'FRCamp', 8, 10, 10);
      expect(call(FUNC.NormalConditionLose, [lit(8)])).toBe(0);
      Health.current[b] = 0;
      expect(call(FUNC.NormalConditionLose, [lit(8)])).toBe(1);

      const u = spawnMockUnit(ctx, 'CubScout', 8, 12, 12);
      expect(call(FUNC.NormalConditionLose, [lit(8)])).toBe(0);
      Health.current[u] = 0;
      expect(call(FUNC.NormalConditionLose, [lit(8)])).toBe(1);
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

    it('supports side worm attract/repel directives', () => {
      spawnMockUnit(ctx, 'CubScout', 2, 20, 25);
      call(FUNC.SideAttractsWorms, [lit(2)]);
      call(FUNC.SideRepelsWorms, [lit(2)]);
      expect(ctx.sandwormSystem.deployThumper).toHaveBeenCalledTimes(2);
    });
  });

  describe('delivery and production', () => {
    it('handles Delivery(side, pos, type...) and marks EventObjectDelivered', () => {
      setPosVar(ev, 0, 70, 90);
      const t1 = indexOfType('CubScout');
      const t2 = indexOfType('FRCamp');

      const last = call(FUNC.Delivery, [lit(9), posVar(0), lit(t1), lit(t2)]);
      expect(last).toBeGreaterThanOrEqual(0);
      expect(Owner.playerId[last]).toBe(9);
      expect(ctx.__spawns.units.length + ctx.__spawns.buildings.length).toBe(2);

      expect(call(FUNC.EventObjectDelivered, [lit(9), objVar(5)])).toBe(1);
      const firstDelivered = ev.getVar(5, VarType.Obj) as number;
      expect(firstDelivered).toBeGreaterThanOrEqual(0);
      expect(call(FUNC.EventObjectDelivered, [lit(9), objVar(5)])).toBe(1);
      const secondDelivered = ev.getVar(5, VarType.Obj) as number;
      expect(secondDelivered).not.toBe(firstDelivered);
    });

    it('supports BuildObject(side, type) and emits constructed events', () => {
      const typeIdx = indexOfType('CubScout');
      const built = call(FUNC.BuildObject, [lit(7), lit(typeIdx)]);
      expect(built).toBeGreaterThanOrEqual(0);
      expect(Owner.playerId[built]).toBe(7);

      expect(call(FUNC.EventObjectConstructed, [lit(7), objVar(6)])).toBe(1);
      expect(ev.getVar(6, VarType.Obj)).toBe(built);
      expect(call(FUNC.EventObjectTypeConstructed, [lit(7), lit(typeIdx), objVar(6)])).toBe(1);
      expect(ev.getVar(6, VarType.Obj)).toBe(built);
    });

    it('applies SetReinforcements to matching AI side', () => {
      const ai = { playerId: 4, waveInterval: 750, attackCooldown: 500 } as any;
      ctx.aiPlayers = [ai];
      call(FUNC.SetReinforcements, [lit(4), lit(120)]);
      // level=120 → waveInterval = max(150, 600-120*30) = 150
      // attackCooldown = max(100, floor(150*0.8)) = 120
      expect(ai.waveInterval).toBe(150);
      expect(ai.attackCooldown).toBe(120);
      expect(ai.reinforcementsEnabled).toBe(true);
      expect(ai.reinforcementLevel).toBe(120);
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

  it('removes timer messages and can trigger script sounds/superweapons', () => {
    call(FUNC.TimerMessageRemove, []);
    expect((ctx.selectionPanel as any).removeTimerMessage).toHaveBeenCalledTimes(1);

    call(FUNC.PlaySound, [lit(3)]);
    expect((ctx.audioManager as any).playSfx).toHaveBeenCalled();

    setPosVar(ev, 0, 77, 99);
    call(FUNC.FireSpecialWeapon, [lit(1), posVar(0)]);
    expect(ctx.superweaponSystem.fire).toHaveBeenCalledWith(1, 77, 99);
  });
});
