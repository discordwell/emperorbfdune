/**
 * Function dispatch for the .tok bytecode interpreter.
 *
 * Maps the 162 game functions to game system calls.
 * Functions are implemented in priority order:
 *   - Critical (every mission): fully implemented
 *   - Common (30%+ missions): fully implemented
 *   - Less common: stubbed with console.warn
 */

import type { TokExpr, TokPos } from './TokTypes';
import { FUNC, FUNC_NAMES, VarType } from './TokTypes';
import type { TokEvaluator } from './TokEvaluator';
import type { GameContext } from '../../../core/GameContext';
import {
  Health, Owner, Position, MoveTarget,
  unitQuery, buildingQuery, UnitType, BuildingType,
  hasComponent,
} from '../../../core/ECS';
import { getCampaignString } from '../../CampaignData';
import { EventBus } from '../../../core/EventBus';
import { simRng } from '../../../utils/DeterministicRNG';
import { TILE_SIZE } from '../../../utils/MathUtils';

export class TokFunctionDispatch {
  private stringTable: string[] = [];

  setStringTable(table: string[]): void {
    this.stringTable = table;
  }

  /** Resolve a string table index to a type name. */
  resolveString(index: number): string {
    const name = this.stringTable[index];
    if (!name) {
      console.warn(`[Tok] String table index ${index} out of range (table has ${this.stringTable.length} entries)`);
      return `UNKNOWN_TYPE_${index}`;
    }
    return name;
  }

  /**
   * Call a function by ID with evaluated arguments.
   * Returns a numeric value (or position for pos-returning functions).
   */
  call(
    funcId: number,
    argExprs: TokExpr[],
    ctx: GameContext,
    ev: TokEvaluator,
    currentTick: number,
  ): number | TokPos {
    // Evaluate arguments
    const args: Array<number | TokPos> = argExprs.map(a =>
      ev.evaluateExpr(a, ctx, this, currentTick)
    );

    switch (funcId) {
      // -------------------------------------------------------------------
      // Tick / Random / Multiplayer
      // -------------------------------------------------------------------
      case FUNC.ModelTick:
        return currentTick;

      case FUNC.Random:
        // Random(max) → 0..max-1
        return simRng.int(0, (asInt(args[0]) || 100) - 1);

      case FUNC.Multiplayer:
        return 0; // Always single-player

      // -------------------------------------------------------------------
      // Position functions
      // -------------------------------------------------------------------
      case FUNC.GetSideBasePoint:
      case FUNC.GetSidePosition: {
        const side = asInt(args[0]);
        return this.getSidePosition(ctx, ev, side);
      }

      case FUNC.GetPlayerSide:
        return 0;

      case FUNC.GetSecondPlayerSide:
        return 0;

      case FUNC.GetEnemySide:
        return 1;

      case FUNC.GetNeutralSide:
        return 255; // Neutral side ID

      case FUNC.GetEntrancePoint: {
        const side = args.length > 0 ? asInt(args[0]) : 0;
        return this.getEntrancePoint(ctx, side);
      }

      case FUNC.GetNeutralEntrancePoint:
        return this.getNeutralEntrancePoint(ctx);

      case FUNC.GetExitPoint:
      case FUNC.GetNeutralExitPoint:
        return this.getNeutralEntrancePoint(ctx); // Same as entrance for now

      case FUNC.GetUnusedBasePoint:
        return this.getUnusedBasePoint(ctx);

      case FUNC.GetScriptPoint: {
        const idx = asInt(args[0]);
        return this.getScriptPoint(ctx, idx);
      }

      case FUNC.GetObjectPosition: {
        const eid = asInt(args[0]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Position, eid)) {
          return { x: Position.x[eid], z: Position.z[eid] };
        }
        return { x: 0, z: 0 };
      }

      case FUNC.GetEntrancePointByIndex:
      case FUNC.GetEntrancNearToPos:
      case FUNC.GetEntranceFarFromPos:
        return this.getNeutralEntrancePoint(ctx);

      case FUNC.GetIsolatedEntrance:
      case FUNC.GetHideOut:
      case FUNC.GetConvoyWayPointFunction:
      case FUNC.GetValley:
      case FUNC.GetIsolatedInfantryRock:
        return this.getUnusedBasePoint(ctx);

      // -------------------------------------------------------------------
      // Side management
      // -------------------------------------------------------------------
      case FUNC.CreateSide:
        return ev.sides.createSide();

      case FUNC.GetSideCash: {
        const side = asInt(args[0]);
        return ctx.harvestSystem.getSolaris(side);
      }

      case FUNC.GetSideSpice:
        return 0;

      case FUNC.GetObjectSide: {
        const eid = asInt(args[0]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Owner, eid)) {
          return Owner.playerId[eid];
        }
        return 0;
      }

      // -------------------------------------------------------------------
      // Spawning
      // -------------------------------------------------------------------
      case FUNC.NewObject: {
        const side = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const pos = asPos(args[2]);
        const typeName = this.resolveString(typeIdx);
        return this.spawnObject(ctx, typeName, side, pos.x, pos.z);
      }

      case FUNC.NewObjectInAPC: {
        const side = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const apcEid = asInt(args[2]);
        const typeName = this.resolveString(typeIdx);
        // Spawn near APC position
        let x = 50, z = 50;
        if (apcEid >= 0 && hasComponent(ctx.game.getWorld(), Position, apcEid)) {
          x = Position.x[apcEid] + (simRng.int(0, 4) - 2);
          z = Position.z[apcEid] + (simRng.int(0, 4) - 2);
        }
        return this.spawnObject(ctx, typeName, side, x, z);
      }

      case FUNC.NewObjectOffsetOrientation: {
        const side = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const pos = asPos(args[2]);
        // Additional args: offset, orientation — use position directly
        const typeName = this.resolveString(typeIdx);
        return this.spawnObject(ctx, typeName, side, pos.x, pos.z);
      }

      // -------------------------------------------------------------------
      // Object queries
      // -------------------------------------------------------------------
      case FUNC.ObjectValid: {
        const eid = asInt(args[0]);
        if (eid < 0) return 0;
        return hasComponent(ctx.game.getWorld(), Health, eid) && Health.current[eid] > 0 ? 1 : 0;
      }

      case FUNC.ObjectDestroyed: {
        const eid = asInt(args[0]);
        if (eid < 0) return 1;
        if (!hasComponent(ctx.game.getWorld(), Health, eid)) return 1;
        return Health.current[eid] <= 0 ? 1 : 0;
      }

      case FUNC.ObjectGetHealth: {
        const eid = asInt(args[0]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Health, eid)) {
          return Health.current[eid];
        }
        return 0;
      }

      case FUNC.ObjectMaxHealth: {
        const eid = asInt(args[0]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Health, eid)) {
          return Health.max[eid];
        }
        return 0;
      }

      case FUNC.ObjectNearToSide:
      case FUNC.ObjectNearToSideBase: {
        const eid = asInt(args[0]);
        const side = asInt(args[1]);
        if (eid < 0 || !hasComponent(ctx.game.getWorld(), Position, eid)) return 0;
        const sidePos = this.getSidePosition(ctx, ev, side);
        const dx = Position.x[eid] - sidePos.x;
        const dz = Position.z[eid] - sidePos.z;
        return Math.sqrt(dx * dx + dz * dz) < 30 ? 1 : 0;
      }

      case FUNC.ObjectNearToObject: {
        const eid1 = asInt(args[0]);
        const eid2 = asInt(args[1]);
        const w = ctx.game.getWorld();
        if (eid1 < 0 || eid2 < 0) return 0;
        if (!hasComponent(w, Position, eid1) || !hasComponent(w, Position, eid2)) return 0;
        const dx = Position.x[eid1] - Position.x[eid2];
        const dz = Position.z[eid1] - Position.z[eid2];
        return Math.sqrt(dx * dx + dz * dz) < 20 ? 1 : 0;
      }

      case FUNC.ObjectVisibleToSide:
      case FUNC.ObjectTypeVisibleToSide:
        // Simplified: return true if object exists
        return asInt(args[0]) >= 0 ? 1 : 0;

      case FUNC.ObjectIsCarried:
        return 0; // Not implemented

      // -------------------------------------------------------------------
      // Object mutation
      // -------------------------------------------------------------------
      case FUNC.ObjectSetHealth: {
        const eid = asInt(args[0]);
        const hp = asInt(args[1]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Health, eid)) {
          Health.current[eid] = hp;
        }
        return 0;
      }

      case FUNC.ObjectChangeSide: {
        const eid = asInt(args[0]);
        const newSide = asInt(args[1]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Owner, eid)) {
          Owner.playerId[eid] = newSide;
        }
        return 0;
      }

      case FUNC.ObjectChange: {
        // ObjectChange(obj, typeName, side) — morph a unit to a different type
        const eid = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const side = args.length > 2 ? asInt(args[2]) : -1;
        const typeName = this.resolveString(typeIdx);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Position, eid)) {
          const x = Position.x[eid];
          const z = Position.z[eid];
          const owner = side >= 0 ? side : (hasComponent(ctx.game.getWorld(), Owner, eid) ? Owner.playerId[eid] : 0);
          // Remove old entity and spawn new one
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
          return this.spawnObject(ctx, typeName, owner, x, z);
        }
        return -1;
      }

      case FUNC.ObjectRemove: {
        const eid = asInt(args[0]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Health, eid)) {
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
        }
        return 0;
      }

      case FUNC.ObjectDeploy:
      case FUNC.ObjectUndeploy:
        return 0; // Stub

      case FUNC.ObjectSell: {
        const eid = asInt(args[0]);
        if (eid >= 0) {
          ctx.sellBuilding(eid);
        }
        return 0;
      }

      case FUNC.ObjectInfect:
      case FUNC.ObjectDetonate:
      case FUNC.ObjectToolTip:
        return 0;

      // -------------------------------------------------------------------
      // Side queries
      // -------------------------------------------------------------------
      case FUNC.SideUnitCount: {
        const side = asInt(args[0]);
        return this.countSideUnits(ctx, side);
      }

      case FUNC.SideBuildingCount: {
        const side = asInt(args[0]);
        return this.countSideBuildings(ctx, side);
      }

      case FUNC.SideObjectCount: {
        const side = asInt(args[0]);
        return this.countSideUnits(ctx, side) + this.countSideBuildings(ctx, side);
      }

      case FUNC.SideAIDone: {
        // Returns TRUE when the AI side has no pending move orders
        // Simplified: return true after a delay
        return 1;
      }

      case FUNC.SideVisibleToSide: {
        const sideA = asInt(args[0]);
        const sideB = asInt(args[1]);
        // Simplified: return true if side A has units
        return this.countSideUnits(ctx, sideA) > 0 ? 1 : 0;
      }

      case FUNC.SideNearToSide:
      case FUNC.SideNearToSideBase: {
        const sideA = asInt(args[0]);
        const sideB = asInt(args[1]);
        const posA = this.getSidePosition(ctx, ev, sideA);
        const posB = this.getSidePosition(ctx, ev, sideB);
        const dx = posA.x - posB.x;
        const dz = posA.z - posB.z;
        return Math.sqrt(dx * dx + dz * dz) < 40 ? 1 : 0;
      }

      case FUNC.SideNearToPoint: {
        const side = asInt(args[0]);
        const pos = asPos(args[1]);
        const sidePos = this.getSidePosition(ctx, ev, side);
        const dx = sidePos.x - pos.x;
        const dz = sidePos.z - pos.z;
        return Math.sqrt(dx * dx + dz * dz) < 40 ? 1 : 0;
      }

      // -------------------------------------------------------------------
      // Side relationships
      // -------------------------------------------------------------------
      case FUNC.SideEnemyTo: {
        const a = asInt(args[0]);
        const b = asInt(args[1]);
        ev.sides.setEnemy(a, b);
        return 0;
      }

      case FUNC.SideFriendTo: {
        const a = asInt(args[0]);
        const b = asInt(args[1]);
        ev.sides.setFriend(a, b);
        return 0;
      }

      case FUNC.SideNeutralTo: {
        const a = asInt(args[0]);
        const b = asInt(args[1]);
        ev.sides.setNeutral(a, b);
        return 0;
      }

      case FUNC.SideChangeSide: {
        // Change all units of side A to side B
        const sideA = asInt(args[0]);
        const sideB = asInt(args[1]);
        const w = ctx.game.getWorld();
        for (const eid of unitQuery(w)) {
          if (Owner.playerId[eid] === sideA) {
            Owner.playerId[eid] = sideB;
          }
        }
        for (const eid of buildingQuery(w)) {
          if (Owner.playerId[eid] === sideA) {
            Owner.playerId[eid] = sideB;
          }
        }
        return 0;
      }

      // -------------------------------------------------------------------
      // AI commands
      // -------------------------------------------------------------------
      case FUNC.SideAIAggressive: {
        const side = asInt(args[0]);
        this.aiAttackMove(ctx, ev, side);
        return 0;
      }

      case FUNC.SideAIAggressiveTowards: {
        const side = asInt(args[0]);
        const targetSide = asInt(args[1]);
        const targetPos = this.getSidePosition(ctx, ev, targetSide);
        this.aiMoveUnits(ctx, side, targetPos.x, targetPos.z, true);
        return 0;
      }

      case FUNC.SideAIMove: {
        const side = asInt(args[0]);
        const pos = asPos(args[1]);
        this.aiMoveUnits(ctx, side, pos.x, pos.z, false);
        return 0;
      }

      case FUNC.SideAIStop: {
        const side = asInt(args[0]);
        const w = ctx.game.getWorld();
        for (const eid of unitQuery(w)) {
          if (Owner.playerId[eid] === side) {
            MoveTarget.active[eid] = 0;
          }
        }
        return 0;
      }

      case FUNC.SideAIAttackObject: {
        const side = asInt(args[0]);
        const targetEid = asInt(args[1]);
        if (targetEid >= 0 && hasComponent(ctx.game.getWorld(), Position, targetEid)) {
          this.aiMoveUnits(ctx, side, Position.x[targetEid], Position.z[targetEid], true);
        }
        return 0;
      }

      case FUNC.SideAIGuardObject: {
        const side = asInt(args[0]);
        const targetEid = asInt(args[1]);
        if (targetEid >= 0 && hasComponent(ctx.game.getWorld(), Position, targetEid)) {
          this.aiMoveUnits(ctx, side, Position.x[targetEid], Position.z[targetEid], false);
        }
        return 0;
      }

      case FUNC.SideAIExitMap: {
        const side = asInt(args[0]);
        const mapW = ctx.terrain.getMapWidth() * 2;
        this.aiMoveUnits(ctx, side, mapW, 0, false);
        return 0;
      }

      case FUNC.SideAIEncounterAttack: {
        // Mark side as aggressive on encounter — implemented via attack-move
        const side = asInt(args[0]);
        this.setAttackMoveForSide(ctx, side);
        return 0;
      }

      case FUNC.SideAIControl:
      case FUNC.SideAIBehaviourAggressive:
      case FUNC.SideAIBehaviourRetreat:
      case FUNC.SideAIBehaviourNormal:
      case FUNC.SideAIBehaviourDefensive:
      case FUNC.SideAIEncounterIgnore:
      case FUNC.SideAIEnterBuilding:
      case FUNC.SideAIHeadlessChicken:
      case FUNC.SideAIShuffle:
        return 0; // AI behavior modifiers — simplified to no-op

      // -------------------------------------------------------------------
      // Dialog / Messages
      // -------------------------------------------------------------------
      case FUNC.Message: {
        const msgId = asInt(args[0]);
        const text = getCampaignString(`#${msgId}`) ?? `[Message ${msgId}]`;
        ctx.selectionPanel.addMessage(text, '#ffcc44');
        return 0;
      }

      case FUNC.GiftingMessage: {
        const msgId = asInt(args[0]);
        const text = getCampaignString(`#${msgId}`) ?? `[Message ${msgId}]`;
        ctx.selectionPanel.addMessage(text, '#44ff44');
        return 0;
      }

      case FUNC.TimerMessage: {
        const msgId = asInt(args[0]);
        const text = getCampaignString(`#${msgId}`) ?? `[Timer ${msgId}]`;
        ctx.selectionPanel.addMessage(text, '#ffaa00');
        return 0;
      }

      case FUNC.TimerMessageRemove:
        return 0; // Timer UI not implemented

      // -------------------------------------------------------------------
      // Credits
      // -------------------------------------------------------------------
      case FUNC.AddSideCash: {
        const side = asInt(args[0]);
        const amount = asInt(args[1]);
        ctx.harvestSystem.addSolaris(side, amount);
        return 0;
      }

      case FUNC.SetSideCash: {
        const side = asInt(args[0]);
        const amount = asInt(args[1]);
        const current = ctx.harvestSystem.getSolaris(side);
        ctx.harvestSystem.addSolaris(side, amount - current);
        return 0;
      }

      // -------------------------------------------------------------------
      // Camera / PIP
      // -------------------------------------------------------------------
      case FUNC.CameraLookAtPoint:
      case FUNC.CameraPanToPoint:
      case FUNC.CameraScrollToPoint: {
        const pos = asPos(args[0]);
        ctx.scene.panTo(pos.x, pos.z);
        return 0;
      }

      case FUNC.CameraTrackObject:
      case FUNC.PIPCameraTrackObject: {
        const eid = asInt(args[0]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Position, eid)) {
          ctx.scene.panTo(Position.x[eid], Position.z[eid]);
        }
        return 0;
      }

      case FUNC.PIPCameraLookAtPoint:
      case FUNC.PIPCameraPanToPoint:
      case FUNC.PIPCameraScrollToPoint: {
        const pos = asPos(args[0]);
        ctx.scene.panTo(pos.x, pos.z);
        return 0;
      }

      case FUNC.PIPRelease:
        // Returns the current game tick (used for timer calculations)
        return currentTick;

      case FUNC.CameraZoomTo:
      case FUNC.CameraViewFrom:
      case FUNC.CameraStartRotate:
      case FUNC.CameraStopRotate:
      case FUNC.CameraStopTrack:
      case FUNC.CameraIsPanning:
      case FUNC.CameraIsScrolling:
      case FUNC.CameraIsSpinning:
      case FUNC.CameraStore:
      case FUNC.CameraRestore:
      case FUNC.PIPCameraZoomTo:
      case FUNC.PIPCameraViewFrom:
      case FUNC.PIPCameraStartRotate:
      case FUNC.PIPCameraStopRotate:
      case FUNC.PIPCameraStopTrack:
      case FUNC.PIPCameraIsPanning:
      case FUNC.PIPCameraIsScrolling:
      case FUNC.PIPCameraIsSpinning:
      case FUNC.PIPCameraStore:
      case FUNC.PIPCameraRestore:
      case FUNC.CentreCursor:
        return 0;

      // -------------------------------------------------------------------
      // Fog of War
      // -------------------------------------------------------------------
      case FUNC.RemoveShroud: {
        const pos = asPos(args[0]);
        const radius = args.length > 1 ? asInt(args[1]) : 10;
        ctx.fogOfWar.revealWorldArea(pos.x, pos.z, radius);
        return 0;
      }

      case FUNC.ReplaceShroud:
      case FUNC.RemoveMapShroud:
        // RemoveMapShroud reveals entire map
        return 0;

      // -------------------------------------------------------------------
      // Radar
      // -------------------------------------------------------------------
      case FUNC.RadarEnabled:
        return 0;

      case FUNC.RadarAlert: {
        const pos = asPos(args[0]);
        ctx.pushGameEvent(pos.x, pos.z, 'radar-alert');
        return 0;
      }

      // -------------------------------------------------------------------
      // Victory / Defeat
      // -------------------------------------------------------------------
      case FUNC.MissionOutcome: {
        const win = asInt(args[0]);
        if (win) {
          ctx.victorySystem.setVictoryCondition('survival');
        }
        return 0;
      }

      case FUNC.EndGameWin:
        ctx.victorySystem.forceVictory();
        return 0;

      case FUNC.EndGameLose:
        ctx.victorySystem.forceDefeat();
        return 0;

      case FUNC.NormalConditionLose:
        // Enable normal lose conditions (all buildings destroyed)
        return 0;

      // -------------------------------------------------------------------
      // Events
      // -------------------------------------------------------------------
      case FUNC.EventObjectDestroyed: {
        const eid = asInt(args[0]);
        return ev.events.wasObjectDestroyed(eid) ? 1 : 0;
      }

      case FUNC.EventSideAttacksSide: {
        const a = asInt(args[0]);
        const b = asInt(args[1]);
        return ev.events.didSideAttackSide(a, b) ? 1 : 0;
      }

      case FUNC.EventObjectDelivered: {
        const eid = asInt(args[0]);
        return ev.events.wasObjectDelivered(eid) ? 1 : 0;
      }

      case FUNC.EventObjectConstructed: {
        const side = asInt(args[0]);
        const eid = asInt(args[1]);
        return ev.events.wasObjectConstructed(side, eid) ? 1 : 0;
      }

      case FUNC.EventObjectTypeConstructed: {
        const side = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const typeName = this.resolveString(typeIdx);
        return ev.events.wasObjectTypeConstructed(side, typeName) ? 1 : 0;
      }

      case FUNC.EventObjectAttacksSide: {
        const eid = asInt(args[0]);
        const side = asInt(args[1]);
        return ev.events.didObjectAttackSide(eid, side) ? 1 : 0;
      }

      // -------------------------------------------------------------------
      // Special weapons / Worms
      // -------------------------------------------------------------------
      case FUNC.ForceWormStrike: {
        const pos = asPos(args[0]);
        // Deploy a thumper at position to attract worms
        ctx.sandwormSystem.deployThumper(pos.x, pos.z);
        return 0;
      }

      case FUNC.SideNuke:
      case FUNC.SideNukeAll:
      case FUNC.AirStrike:
      case FUNC.AirStrikeDone:
      case FUNC.FireSpecialWeapon:
        return 0; // Stub

      case FUNC.SideAttractsWorms:
      case FUNC.SideRepelsWorms:
        return 0;

      // -------------------------------------------------------------------
      // Crates
      // -------------------------------------------------------------------
      case FUNC.NewCrateUnit: {
        const pos = asPos(args[0]);
        const crateId = ctx.nextCrateId++;
        ctx.activeCrates.set(crateId, { x: pos.x, z: pos.z, type: 'unit' });
        ctx.effectsManager.spawnCrate(crateId, pos.x, pos.z, 'unit');
        return 0;
      }

      case FUNC.NewCrateBomb: {
        const pos = asPos(args[0]);
        const crateId = ctx.nextCrateId++;
        ctx.activeCrates.set(crateId, { x: pos.x, z: pos.z, type: 'bomb' });
        ctx.effectsManager.spawnCrate(crateId, pos.x, pos.z, 'bomb');
        return 0;
      }

      case FUNC.NewCrateStealth: {
        const pos = asPos(args[0]);
        const crateId = ctx.nextCrateId++;
        ctx.activeCrates.set(crateId, { x: pos.x, z: pos.z, type: 'stealth' });
        ctx.effectsManager.spawnCrate(crateId, pos.x, pos.z, 'stealth');
        return 0;
      }

      case FUNC.NewCrateCash: {
        const pos = asPos(args[0]);
        const crateId = ctx.nextCrateId++;
        ctx.activeCrates.set(crateId, { x: pos.x, z: pos.z, type: 'cash' });
        ctx.effectsManager.spawnCrate(crateId, pos.x, pos.z, 'cash');
        return 0;
      }

      case FUNC.NewCrateShroud: {
        const pos = asPos(args[0]);
        const crateId = ctx.nextCrateId++;
        ctx.activeCrates.set(crateId, { x: pos.x, z: pos.z, type: 'shroud' });
        ctx.effectsManager.spawnCrate(crateId, pos.x, pos.z, 'shroud');
        return 0;
      }

      // -------------------------------------------------------------------
      // Delivery / Production
      // -------------------------------------------------------------------
      case FUNC.CarryAllDelivery:
      case FUNC.Delivery:
      case FUNC.StarportDelivery:
        // These spawn units via carryall — use direct spawn for now
        if (args.length >= 3) {
          const side = asInt(args[0]);
          const typeIdx = asInt(args[1]);
          const pos = asPos(args[2]);
          const typeName = this.resolveString(typeIdx);
          return this.spawnObject(ctx, typeName, side, pos.x, pos.z);
        }
        return -1;

      case FUNC.BuildObject: {
        if (args.length >= 3) {
          const side = asInt(args[0]);
          const typeIdx = asInt(args[1]);
          const pos = asPos(args[2]);
          const typeName = this.resolveString(typeIdx);
          return this.spawnObject(ctx, typeName, side, pos.x, pos.z);
        }
        return -1;
      }

      case FUNC.SetReinforcements:
        return 0;

      // -------------------------------------------------------------------
      // Misc
      // -------------------------------------------------------------------
      case FUNC.Neg: {
        const val = asInt(args[0]);
        return -val;
      }

      case FUNC.SetValue: {
        // SetValue(a, b) → returns b (used in some scripts)
        return args.length > 1 ? asInt(args[1]) : 0;
      }

      case FUNC.SetSideColor:
      case FUNC.GetSideColor:
        return 0;

      case FUNC.PlaySound: {
        // PlaySound with numeric ID — not implemented
        return 0;
      }

      case FUNC.FreezeGame:
      case FUNC.UnFreezeGame:
      case FUNC.DisableUI:
      case FUNC.EnableUI:
      case FUNC.BreakPoint:
        return 0;

      case FUNC.SetVeterancy: {
        // SetVeterancy(obj, rank)
        // Vet system stores xp/rank in ECS — simplified to no-op for now
        return 0;
      }

      case FUNC.SetThreatLevel:
      case FUNC.SetTilePos:
        return 0;

      default: {
        const name = FUNC_NAMES[funcId] ?? `Func_${funcId}`;
        console.warn(`[Tok] Unimplemented function: ${name} (${funcId})`);
        return 0;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helper methods
  // -----------------------------------------------------------------------

  private spawnObject(ctx: GameContext, typeName: string, side: number, x: number, z: number): number {
    const world = ctx.game.getWorld();
    // Check if it's a building or unit
    if (ctx.typeRegistry.buildingTypeIdMap.has(typeName)) {
      return ctx.spawnBuilding(world, typeName, side, x, z);
    } else {
      return ctx.spawnUnit(world, typeName, side, x, z);
    }
  }

  private countSideUnits(ctx: GameContext, side: number): number {
    let count = 0;
    for (const eid of unitQuery(ctx.game.getWorld())) {
      if (Owner.playerId[eid] === side && Health.current[eid] > 0) count++;
    }
    return count;
  }

  private countSideBuildings(ctx: GameContext, side: number): number {
    let count = 0;
    for (const eid of buildingQuery(ctx.game.getWorld())) {
      if (Owner.playerId[eid] === side && Health.current[eid] > 0) count++;
    }
    return count;
  }

  private getSidePosition(ctx: GameContext, ev: TokEvaluator, side: number): TokPos {
    // Find the centroid of all units belonging to this side
    let sumX = 0, sumZ = 0, count = 0;
    const w = ctx.game.getWorld();

    for (const eid of unitQuery(w)) {
      if (Owner.playerId[eid] === side && Health.current[eid] > 0) {
        sumX += Position.x[eid];
        sumZ += Position.z[eid];
        count++;
      }
    }
    for (const eid of buildingQuery(w)) {
      if (Owner.playerId[eid] === side && Health.current[eid] > 0) {
        sumX += Position.x[eid];
        sumZ += Position.z[eid];
        count++;
      }
    }

    if (count > 0) {
      return { x: sumX / count, z: sumZ / count };
    }

    // Fallback: use AI player base position if available
    const ai = ctx.aiPlayers.find(a => (a as any).playerId === side);
    if (ai) {
      return { x: (ai as any).baseX ?? 50, z: (ai as any).baseZ ?? 50 };
    }

    // Default fallback
    const mapW = ctx.terrain.getMapWidth() * 2;
    const mapH = ctx.terrain.getMapHeight() * 2;
    if (side === 0) return { x: mapW * 0.2, z: mapH * 0.8 };
    if (side === 1) return { x: mapW * 0.8, z: mapH * 0.2 };
    return { x: mapW * 0.5, z: mapH * 0.5 };
  }

  private getEntrancePoint(ctx: GameContext, side: number): TokPos {
    const meta = ctx.mapMetadata;
    if (meta && meta.entrances.length > 0) {
      // Find entrance matching the side marker, or closest to side's base
      const match = meta.entrances.find(e => e.marker === side);
      if (match) {
        return { x: match.x * TILE_SIZE, z: match.z * TILE_SIZE };
      }
      // Fall back to any non-generic entrance, or first available
      const nonGeneric = meta.entrances.filter(e => e.marker !== 99);
      const pick = nonGeneric.length > side ? nonGeneric[side] : meta.entrances[side % meta.entrances.length];
      return { x: pick.x * TILE_SIZE, z: pick.z * TILE_SIZE };
    }

    // Fallback: map edge positions
    const mapW = ctx.terrain.getMapWidth() * 2;
    const mapH = ctx.terrain.getMapHeight() * 2;
    if (side === 0) return { x: 5, z: mapH * 0.7 };
    if (side === 1) return { x: mapW - 5, z: mapH * 0.3 };
    const edge = simRng.int(0, 3);
    switch (edge) {
      case 0: return { x: simRng.int(5, mapW - 5), z: 5 };
      case 1: return { x: simRng.int(5, mapW - 5), z: mapH - 5 };
      case 2: return { x: 5, z: simRng.int(5, mapH - 5) };
      default: return { x: mapW - 5, z: simRng.int(5, mapH - 5) };
    }
  }

  private getNeutralEntrancePoint(ctx: GameContext): TokPos {
    const meta = ctx.mapMetadata;
    if (meta && meta.entrances.length > 0) {
      // Pick a random generic entrance (marker === 99)
      const generic = meta.entrances.filter(e => e.marker === 99);
      if (generic.length > 0) {
        const pick = generic[simRng.int(0, generic.length - 1)];
        return { x: pick.x * TILE_SIZE, z: pick.z * TILE_SIZE };
      }
      // Fall back to any entrance
      const pick = meta.entrances[simRng.int(0, meta.entrances.length - 1)];
      return { x: pick.x * TILE_SIZE, z: pick.z * TILE_SIZE };
    }

    // Fallback: random map edge
    const mapW = ctx.terrain.getMapWidth() * 2;
    const mapH = ctx.terrain.getMapHeight() * 2;
    const edge = simRng.int(0, 3);
    switch (edge) {
      case 0: return { x: simRng.int(5, mapW - 5), z: 5 };
      case 1: return { x: simRng.int(5, mapW - 5), z: mapH - 5 };
      case 2: return { x: 5, z: simRng.int(5, mapH - 5) };
      default: return { x: mapW - 5, z: simRng.int(5, mapH - 5) };
    }
  }

  private getUnusedBasePoint(ctx: GameContext): TokPos {
    const meta = ctx.mapMetadata;
    if (meta && meta.spawnPoints.length > 0) {
      // Find a spawn point not currently assigned to any active player
      const usedPositions = new Set<string>();
      for (const ai of ctx.aiPlayers) {
        const bx = (ai as any).baseX;
        const bz = (ai as any).baseZ;
        if (bx !== undefined) usedPositions.add(`${Math.round(bx)},${Math.round(bz)}`);
      }
      for (const sp of meta.spawnPoints) {
        const wx = sp.x * TILE_SIZE;
        const wz = sp.z * TILE_SIZE;
        if (!usedPositions.has(`${Math.round(wx)},${Math.round(wz)}`)) {
          return { x: wx, z: wz };
        }
      }
      // All used — pick last spawn point as best guess
      const last = meta.spawnPoints[meta.spawnPoints.length - 1];
      return { x: last.x * TILE_SIZE, z: last.z * TILE_SIZE };
    }

    // Fallback: random position in center area
    const mapW = ctx.terrain.getMapWidth() * 2;
    const mapH = ctx.terrain.getMapHeight() * 2;
    return { x: mapW * (0.3 + simRng.int(0, 40) / 100), z: mapH * (0.3 + simRng.int(0, 40) / 100) };
  }

  private getScriptPoint(ctx: GameContext, idx: number): TokPos {
    const meta = ctx.mapMetadata;
    if (meta) {
      // Script1 → index 0, Script24 → index 23
      const scriptIdx = idx - 1;
      if (scriptIdx >= 0 && scriptIdx < meta.scriptPoints.length) {
        const pt = meta.scriptPoints[scriptIdx];
        if (pt) {
          return { x: pt.x * TILE_SIZE, z: pt.z * TILE_SIZE };
        }
      }
    }

    // Fallback: map center
    const mapW = ctx.terrain.getMapWidth() * 2;
    const mapH = ctx.terrain.getMapHeight() * 2;
    return { x: mapW * 0.5, z: mapH * 0.5 };
  }

  private aiMoveUnits(ctx: GameContext, side: number, x: number, z: number, attackMove: boolean): void {
    const w = ctx.game.getWorld();
    const units: number[] = [];
    for (const eid of unitQuery(w)) {
      if (Owner.playerId[eid] === side && Health.current[eid] > 0) {
        MoveTarget.x[eid] = x;
        MoveTarget.z[eid] = z;
        MoveTarget.active[eid] = 1;
        units.push(eid);
      }
    }
    if (attackMove && units.length > 0) {
      ctx.combatSystem.setAttackMove(units);
    }
  }

  private aiAttackMove(ctx: GameContext, ev: TokEvaluator, side: number): void {
    // Move all units of this side toward the nearest enemy
    const enemies: number[] = [];
    for (let s = 0; s < ev.sides.nextSideId; s++) {
      if (s !== side && ev.sides.isEnemy(side, s)) {
        enemies.push(s);
      }
    }
    // Include default enemy (player 0 if side != 0, or player 1)
    if (enemies.length === 0) {
      enemies.push(side === 0 ? 1 : 0);
    }

    // Find nearest enemy centroid
    let bestPos: TokPos = { x: 50, z: 50 };
    let bestDist = Infinity;
    const sidePos = this.getSidePosition(ctx, ev, side);

    for (const enemySide of enemies) {
      const ePos = this.getSidePosition(ctx, ev, enemySide);
      const dx = ePos.x - sidePos.x;
      const dz = ePos.z - sidePos.z;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestPos = ePos;
      }
    }

    this.aiMoveUnits(ctx, side, bestPos.x, bestPos.z, true);
  }

  private setAttackMoveForSide(ctx: GameContext, side: number): void {
    const w = ctx.game.getWorld();
    const units: number[] = [];
    for (const eid of unitQuery(w)) {
      if (Owner.playerId[eid] === side && Health.current[eid] > 0) {
        units.push(eid);
      }
    }
    if (units.length > 0) {
      ctx.combatSystem.setAttackMove(units);
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function asInt(v: number | TokPos | undefined): number {
  if (v === undefined) return 0;
  if (typeof v === 'number') return v;
  return 0;
}

function asPos(v: number | TokPos | undefined): TokPos {
  if (v === undefined) return { x: 0, z: 0 };
  if (typeof v === 'object') return v;
  return { x: 0, z: 0 };
}
