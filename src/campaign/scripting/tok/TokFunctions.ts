/**
 * Function dispatch for the .tok bytecode interpreter.
 *
 * Maps the 162 game functions to game system calls.
 * Functions are implemented in priority order:
 *   - Critical (every mission): fully implemented
 *   - Common (30%+ missions): fully implemented
 *   - Less common: stubbed with console.warn
 */

import type { TokDispatchSaveState, TokExpr, TokPos } from './TokTypes';
import { FUNC, FUNC_NAMES, VarType } from './TokTypes';
import type { TokEvaluator } from './TokEvaluator';
import type { GameContext } from '../../../core/GameContext';
import {
  Health, Owner, Position, MoveTarget, Rotation, AttackTarget,
  unitQuery, buildingQuery, UnitType, BuildingType, Veterancy,
  hasComponent, addComponent, removeComponent,
} from '../../../core/ECS';
import { getCampaignString, getMissionMessage } from '../../CampaignData';
import { EventBus } from '../../../core/EventBus';
import { simRng } from '../../../utils/DeterministicRNG';
import { TILE_SIZE, tileToWorld, worldToTile } from '../../../utils/MathUtils';
import { lookupSoundCategory, lookupSoundOgg } from '../../../audio/SoundIdTable';

type CameraSnapshot = { x: number; z: number; zoom: number; rotation: number };
type CameraSpinState = { active: boolean; speed: number; direction: number };

// Proximity thresholds in world units (TILE_SIZE=2).
// Original game thresholds are undocumented; these are calibrated for 128-tile maps.
const NEAR_OBJECT_TO_SIDE = 30;  // ~15 tiles — object near a base
const NEAR_OBJECT_TO_OBJECT = 20; // ~10 tiles — two objects close together
const NEAR_SIDE_TO_SIDE = 40;     // ~20 tiles — two armies close
const NEAR_SIDE_TO_POINT = 40;    // ~20 tiles — army near a waypoint

export class TokFunctionDispatch {
  private stringTable: string[] = [];
  private housePrefix: string = 'AT';
  // Air strike tracking: strikeId → { units, targetX, targetZ }
  private airStrikes = new Map<number, { units: number[]; targetX: number; targetZ: number }>();
  // Tooltip storage: entity ID -> tooltip message ID
  private tooltipMap = new Map<number, number>();
  // Script-assigned side color overrides.
  private sideColors = new Map<number, number>();
  // Cached base position per side (set on first building/NewObject for the side).
  private sideBasePositions = new Map<number, TokPos>();
  // Script-assigned threat levels by type name.
  private typeThreatLevels = new Map<string, number>();
  // Script camera state.
  private lastCameraTick = -1;
  private mainCameraTrackEid: number | null = null;
  private pipCameraTrackEid: number | null = null;
  private mainCameraSpin: CameraSpinState = { active: false, speed: 0, direction: 1 };
  private pipCameraSpin: CameraSpinState = { active: false, speed: 0, direction: 1 };
  private mainCameraStored: CameraSnapshot | null = null;
  private pipCameraStored: CameraSnapshot | null = null;

  setStringTable(table: string[]): void {
    this.stringTable = table;
  }

  setHousePrefix(prefix: string): void {
    this.housePrefix = prefix;
  }

  getHousePrefix(): string {
    return this.housePrefix;
  }

  /** Get the tooltip message ID for an entity, or undefined if none assigned. */
  getTooltipId(eid: number): number | undefined {
    return this.tooltipMap.get(eid);
  }

  serialize(eidToIndex: Map<number, number>): TokDispatchSaveState {
    const mapEntity = (eid: number): number =>
      eid >= 0 ? (eidToIndex.get(eid) ?? -1) : -1;

    return {
      airStrikes: Array.from(this.airStrikes.entries()).map(([strikeId, strike]) => ({
        strikeId,
        units: strike.units.map(mapEntity),
        targetX: strike.targetX,
        targetZ: strike.targetZ,
      })),
      tooltipMap: Array.from(this.tooltipMap.entries()).map(([entity, tooltipId]) => ({
        entity: mapEntity(entity),
        tooltipId,
      })),
      sideColors: Array.from(this.sideColors.entries()).map(([side, color]) => ({ side, color })),
      typeThreatLevels: Array.from(this.typeThreatLevels.entries()).map(([typeName, level]) => ({ typeName, level })),
      lastCameraTick: this.lastCameraTick,
      mainCameraTrackEid: mapEntity(this.mainCameraTrackEid ?? -1),
      pipCameraTrackEid: mapEntity(this.pipCameraTrackEid ?? -1),
      mainCameraSpin: { ...this.mainCameraSpin },
      pipCameraSpin: { ...this.pipCameraSpin },
      mainCameraStored: this.mainCameraStored ? { ...this.mainCameraStored } : null,
      pipCameraStored: this.pipCameraStored ? { ...this.pipCameraStored } : null,
      sideBasePositions: Array.from(this.sideBasePositions.entries()).map(([side, pos]) => ({ side, x: pos.x, z: pos.z })),
    };
  }

  restore(state: TokDispatchSaveState | undefined, indexToEid: Map<number, number>, ctx: GameContext): void {
    const mapEntity = (idx: number): number =>
      idx >= 0 ? (indexToEid.get(idx) ?? -1) : -1;

    this.airStrikes.clear();
    this.tooltipMap.clear();
    this.sideColors.clear();
    this.sideBasePositions.clear();
    this.typeThreatLevels.clear();
    this.lastCameraTick = -1;
    this.mainCameraTrackEid = null;
    this.pipCameraTrackEid = null;
    this.mainCameraSpin = { active: false, speed: 0, direction: 1 };
    this.pipCameraSpin = { active: false, speed: 0, direction: 1 };
    this.mainCameraStored = null;
    this.pipCameraStored = null;

    if (!state) return;

    for (const strike of state.airStrikes ?? []) {
      this.airStrikes.set(strike.strikeId, {
        units: strike.units.map(mapEntity).filter((eid) => eid >= 0),
        targetX: strike.targetX,
        targetZ: strike.targetZ,
      });
    }

    for (const entry of state.tooltipMap ?? []) {
      const entity = mapEntity(entry.entity);
      if (entity >= 0) {
        this.tooltipMap.set(entity, entry.tooltipId);
      }
    }

    for (const entry of state.sideColors ?? []) {
      this.sideColors.set(entry.side, entry.color);
    }

    for (const entry of state.typeThreatLevels ?? []) {
      this.typeThreatLevels.set(entry.typeName, entry.level);
      const unitDef = ctx.gameRules.units.get(entry.typeName);
      if (unitDef) {
        (unitDef as any).aiThreat = entry.level;
      }
      const buildingDef = ctx.gameRules.buildings.get(entry.typeName);
      if (buildingDef) {
        (buildingDef as any).aiThreat = entry.level;
      }
    }

    this.lastCameraTick = typeof state.lastCameraTick === 'number' ? state.lastCameraTick : -1;
    const mainTrack = mapEntity(state.mainCameraTrackEid ?? -1);
    const pipTrack = mapEntity(state.pipCameraTrackEid ?? -1);
    this.mainCameraTrackEid = mainTrack >= 0 ? mainTrack : null;
    this.pipCameraTrackEid = pipTrack >= 0 ? pipTrack : null;

    this.mainCameraSpin = state.mainCameraSpin
      ? { ...state.mainCameraSpin }
      : { active: false, speed: 0, direction: 1 };
    this.pipCameraSpin = state.pipCameraSpin
      ? { ...state.pipCameraSpin }
      : { active: false, speed: 0, direction: 1 };

    this.mainCameraStored = state.mainCameraStored ? { ...state.mainCameraStored } : null;
    this.pipCameraStored = state.pipCameraStored ? { ...state.pipCameraStored } : null;

    for (const entry of (state as any).sideBasePositions ?? []) {
      this.sideBasePositions.set(entry.side, { x: entry.x, z: entry.z });
    }
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

    this.updateScriptCamera(ctx, currentTick);

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
        return 0;

      // -------------------------------------------------------------------
      // Position functions
      // -------------------------------------------------------------------
      case FUNC.GetSideBasePoint: {
        // Returns the fixed base position for a side (stable reference point)
        const side = asInt(args[0]);
        return this.getSideBasePosition(ctx, ev, side);
      }
      case FUNC.GetSidePosition: {
        // Returns the current centroid of a side's forces
        const side = asInt(args[0]);
        return this.getSidePosition(ctx, ev, side);
      }

      case FUNC.GetPlayerSide:
        return 0;

      case FUNC.GetSecondPlayerSide:
        return 1;

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

      case FUNC.GetExitPoint: {
        const side = args.length > 0 ? asInt(args[0]) : 0;
        return this.getExitPoint(ctx, side);
      }

      case FUNC.GetNeutralExitPoint: {
        const fromPos = args.length > 0 && isPos(args[0]) ? asPos(args[0]) : null;
        return this.getNeutralExitPoint(ctx, fromPos);
      }

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

      case FUNC.GetEntrancePointByIndex: {
        const idx = args.length > 0 ? asInt(args[0]) : 0;
        return this.getEntrancePointByIndex(ctx, idx);
      }

      case FUNC.GetEntranceNearToPos:
      case FUNC.GetEntrancNearToPos: {
        const pos = args.length > 0 && isPos(args[0]) ? asPos(args[0]) : this.getSidePosition(ctx, ev, 0);
        return this.getEntranceNearToPos(ctx, pos);
      }

      case FUNC.GetEntranceFarFromPos: {
        const pos = args.length > 0 && isPos(args[0]) ? asPos(args[0]) : this.getSidePosition(ctx, ev, 0);
        return this.getEntranceFarFromPos(ctx, pos);
      }

      case FUNC.GetIsolatedEntrance:
        return this.getIsolatedEntrance(ctx, ev);

      case FUNC.GetHideOut:
      case FUNC.GetValley:
      case FUNC.GetIsolatedInfantryRock: {
        // Map script points (Script1-Script24 markers) — use first available
        const meta = ctx.mapMetadata;
        if (meta) {
          for (const pt of meta.scriptPoints) {
            if (pt) return { x: pt.x * TILE_SIZE, z: pt.z * TILE_SIZE };
          }
        }
        return this.getUnusedBasePoint(ctx);
      }

      case FUNC.GetConvoyWayPointFunction: {
        // Convoy waypoints use AI waypoints from map metadata
        const meta = ctx.mapMetadata;
        if (meta && meta.aiWaypoints.length > 0) {
          const wp = meta.aiWaypoints[simRng.int(0, meta.aiWaypoints.length - 1)];
          return { x: wp.x * TILE_SIZE, z: wp.z * TILE_SIZE };
        }
        return this.getUnusedBasePoint(ctx);
      }

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
        // Scripts use GetSideSpice interchangeably with GetSideCash for affordability checks.
        return ctx.harvestSystem.getSolaris(asInt(args[0]));

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
        // Spawn a unit inside an APC as a passenger (hidden until unloaded)
        const side = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const apcEid = asInt(args[2]);
        const typeName = this.resolveString(typeIdx);
        // Spawn at APC position (will be hidden off-map as passenger)
        let x = 50, z = 50;
        if (apcEid >= 0 && hasComponent(ctx.game.getWorld(), Position, apcEid)) {
          x = Position.x[apcEid];
          z = Position.z[apcEid];
        }
        const unitEid = this.spawnObject(ctx, typeName, side, x, z);
        // Load into APC via ability system's transport passenger list
        if (unitEid >= 0 && apcEid >= 0) {
          const ability = ctx.abilitySystem as any;
          if (typeof ability?.getTransportPassengers === 'function') {
            const passengers: Map<number, number[]> = ability.getTransportPassengers();
            const list = passengers.get(apcEid) ?? [];
            list.push(unitEid);
            passengers.set(apcEid, list);
            // Hide off-map
            Position.x[unitEid] = -999;
            Position.z[unitEid] = -999;
            if (hasComponent(ctx.game.getWorld(), MoveTarget, unitEid)) {
              MoveTarget.active[unitEid] = 0;
            }
          }
        }
        return unitEid;
      }

      case FUNC.NewObjectOffsetOrientation: {
        // NewObjectOffsetOrientation(side, type, basePos, offsetX, offsetZ, orientation)
        const side = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const pos = asPos(args[2]);
        const offsetX = args.length > 3 ? asInt(args[3]) : 0;
        const offsetZ = args.length > 4 ? asInt(args[4]) : 0;
        const orientation = args.length > 5 ? asInt(args[5]) : 0;
        const typeName = this.resolveString(typeIdx);
        // Offsets are in tiles
        const spawnX = pos.x + offsetX * TILE_SIZE;
        const spawnZ = pos.z + offsetZ * TILE_SIZE;
        const eid = this.spawnObject(ctx, typeName, side, spawnX, spawnZ);
        // Apply orientation (0=N, 1=E, 2=S, 3=W → radians)
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Rotation, eid)) {
          Rotation.y[eid] = (orientation & 3) * (Math.PI / 2);
        }
        return eid;
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

      case FUNC.ObjectNearToSide: {
        const eid = asInt(args[0]);
        const side = asInt(args[1]);
        if (eid < 0 || !hasComponent(ctx.game.getWorld(), Position, eid)) return 0;
        const sidePos = this.getSidePosition(ctx, ev, side);
        const dx = Position.x[eid] - sidePos.x;
        const dz = Position.z[eid] - sidePos.z;
        return Math.sqrt(dx * dx + dz * dz) < NEAR_OBJECT_TO_SIDE ? 1 : 0;
      }
      case FUNC.ObjectNearToSideBase: {
        const eid = asInt(args[0]);
        const side = asInt(args[1]);
        if (eid < 0 || !hasComponent(ctx.game.getWorld(), Position, eid)) return 0;
        const sidePos = this.getSideBasePosition(ctx, ev, side);
        const dx = Position.x[eid] - sidePos.x;
        const dz = Position.z[eid] - sidePos.z;
        return Math.sqrt(dx * dx + dz * dz) < NEAR_OBJECT_TO_SIDE ? 1 : 0;
      }

      case FUNC.ObjectNearToObject: {
        const eid1 = asInt(args[0]);
        const eid2 = asInt(args[1]);
        const w = ctx.game.getWorld();
        if (eid1 < 0 || eid2 < 0) return 0;
        if (!hasComponent(w, Position, eid1) || !hasComponent(w, Position, eid2)) return 0;
        const dx = Position.x[eid1] - Position.x[eid2];
        const dz = Position.z[eid1] - Position.z[eid2];
        return Math.sqrt(dx * dx + dz * dz) < NEAR_OBJECT_TO_OBJECT ? 1 : 0;
      }

      case FUNC.ObjectVisibleToSide: {
        // Check if object is visible to a given side via fog of war
        const visEid = asInt(args[0]);
        const visSide = asInt(args[1]);
        if (visEid < 0 || !hasComponent(ctx.game.getWorld(), Position, visEid)) return 0;
        if (Health.current[visEid] <= 0) return 0;
        // FogOfWar only tracks player 0 — non-player sides assume visible
        if (visSide !== 0) return 1;
        const visTile = worldToTile(Position.x[visEid], Position.z[visEid]);
        return ctx.fogOfWar.isTileVisible(visTile.tx, visTile.tz) ? 1 : 0;
      }

      case FUNC.ObjectTypeVisibleToSide: {
        // Check if any unit of a given type is visible to a side
        const typeIdx = asInt(args[0]);
        const typeSide = asInt(args[1]);
        const searchType = this.resolveString(typeIdx);
        const w = ctx.game.getWorld();
        for (const eid of unitQuery(w)) {
          if (Health.current[eid] <= 0) continue;
          const typeId = UnitType.id[eid];
          const typeName = ctx.typeRegistry.unitTypeNames[typeId];
          if (typeName !== searchType) continue;
          if (typeSide !== 0) return 1; // Non-player sides always see
          const tile = worldToTile(Position.x[eid], Position.z[eid]);
          if (ctx.fogOfWar.isTileVisible(tile.tx, tile.tz)) return 1;
        }
        return 0;
      }

      case FUNC.ObjectIsCarried: {
        const eid = asInt(args[0]);
        return this.isObjectCarried(ctx, eid) ? 1 : 0;
      }

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
        // ObjectChange(obj, typeName, side) — morph entity in-place (preserves entity ID)
        const eid = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const side = args.length > 2 ? asInt(args[2]) : -1;
        const typeName = this.resolveString(typeIdx);
        const owner = side >= 0 ? side : (hasComponent(ctx.game.getWorld(), Owner, eid) ? Owner.playerId[eid] : 0);
        return this.morphObject(ctx, eid, typeName, owner);
      }

      case FUNC.ObjectRemove: {
        const eid = asInt(args[0]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Health, eid)) {
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
        }
        return 0;
      }

      case FUNC.ObjectDeploy: {
        // Deploy a unit (MCV→ConYard conversion)
        const deployEid = asInt(args[0]);
        const dw = ctx.game.getWorld();
        if (deployEid < 0 || !hasComponent(dw, Position, deployEid)) return 0;
        if (Health.current[deployEid] <= 0) return 0;
        if (!hasComponent(dw, UnitType, deployEid)) return 0;
        const deployTypeId = UnitType.id[deployEid];
        const deployTypeName = ctx.typeRegistry.unitTypeNames[deployTypeId];
        if (deployTypeName?.endsWith('MCV')) {
          const deployOwner = Owner.playerId[deployEid];
          const deployDef = ctx.gameRules.units.get(deployTypeName);
          const conYardName = deployDef?.deploysTo ?? `${deployTypeName.substring(0, 2)}ConYard`;
          const dx = Position.x[deployEid], dz = Position.z[deployEid];
          Health.current[deployEid] = 0;
          EventBus.emit('unit:died', { entityId: deployEid, killerEntity: -1 });
          return ctx.spawnBuilding(ctx.game.getWorld(), conYardName, deployOwner, dx, dz);
        }
        return 0;
      }

      case FUNC.ObjectUndeploy: {
        const undeployEid = asInt(args[0]);
        const w = ctx.game.getWorld();
        if (undeployEid < 0 || !hasComponent(w, Position, undeployEid)) return 0;
        if (Health.current[undeployEid] <= 0) return 0;
        if (!hasComponent(w, BuildingType, undeployEid)) return 0;

        const typeId = BuildingType.id[undeployEid];
        const buildingName = ctx.typeRegistry.buildingTypeNames[typeId] ?? '';
        if (!buildingName.includes('ConYard')) return 0;

        const owner = hasComponent(w, Owner, undeployEid) ? Owner.playerId[undeployEid] : 0;
        const x = Position.x[undeployEid];
        const z = Position.z[undeployEid];
        const prefix = buildingName.substring(0, 2);
        const guessedMcv = `${prefix}MCV`;
        const mcvName = ctx.typeRegistry.unitTypeIdMap.has(guessedMcv) ? guessedMcv : 'MCV';

        Health.current[undeployEid] = 0;
        EventBus.emit('unit:died', { entityId: undeployEid, killerEntity: -1 });
        return this.spawnObject(ctx, mcvName, owner, x, z);
      }

      case FUNC.ObjectSell: {
        const eid = asInt(args[0]);
        if (eid >= 0) {
          ctx.sellBuilding(eid);
        }
        return 0;
      }

      case FUNC.ObjectInfect: {
        // ObjectInfect(obj, typeName, side): morph in-place (preserves entity ID)
        const eid = asInt(args[0]);
        const typeName = this.resolveString(asInt(args[1]));
        const side = args.length > 2 ? asInt(args[2]) : (hasComponent(ctx.game.getWorld(), Owner, eid) ? Owner.playerId[eid] : 0);
        return this.morphObject(ctx, eid, typeName, side);
      }

      case FUNC.ObjectDetonate: {
        // ObjectDetonate(obj, typeName): replace object with an effect/payload unit.
        const eid = asInt(args[0]);
        if (args.length < 2) {
          if (eid >= 0 && hasComponent(ctx.game.getWorld(), Health, eid)) {
            Health.current[eid] = 0;
            EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
          }
          return 0;
        }
        const owner = hasComponent(ctx.game.getWorld(), Owner, eid) ? Owner.playerId[eid] : 0;
        const typeName = this.resolveString(asInt(args[1]));
        return this.morphObject(ctx, eid, typeName, owner);
      }

      case FUNC.ObjectToolTip: {
        // Store tooltip ID on entity for hover display
        const ttEid = asInt(args[0]);
        const ttId = asInt(args[1]);
        if (ttEid >= 0) this.tooltipMap.set(ttEid, ttId);
        return 0;
      }

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
        // Returns TRUE when the AI side has completed its current command
        // (no pending moves AND not actively attacking)
        const aiSide = asInt(args[0]);
        const w = ctx.game.getWorld();
        for (const eid of unitQuery(w)) {
          if (Owner.playerId[eid] !== aiSide) continue;
          if (Health.current[eid] <= 0) continue;
          if (MoveTarget.active[eid] === 1) return 0;
          if (hasComponent(w, AttackTarget, eid) && AttackTarget.active[eid] === 1) return 0;
        }
        return 1;
      }

      case FUNC.SideVisibleToSide: {
        const sideA = asInt(args[0]);
        const sideB = asInt(args[1]);
        const w = ctx.game.getWorld();
        const isVisibleToSideB = (eid: number): boolean => {
          if (Owner.playerId[eid] !== sideA || Health.current[eid] <= 0) return false;
          if (sideB !== 0) return true;
          const tile = worldToTile(Position.x[eid], Position.z[eid]);
          return ctx.fogOfWar.isTileVisible(tile.tx, tile.tz);
        };

        for (const eid of unitQuery(w)) {
          if (isVisibleToSideB(eid)) return 1;
        }
        for (const eid of buildingQuery(w)) {
          if (isVisibleToSideB(eid)) return 1;
        }
        return 0;
      }

      case FUNC.SideNearToSide: {
        // Check if any unit of sideA is near any unit of sideB
        const sideA = asInt(args[0]);
        const sideB = asInt(args[1]);
        const posA = this.getSidePosition(ctx, ev, sideA);
        const posB = this.getSidePosition(ctx, ev, sideB);
        const dx = posA.x - posB.x;
        const dz = posA.z - posB.z;
        return Math.sqrt(dx * dx + dz * dz) < NEAR_SIDE_TO_SIDE ? 1 : 0;
      }
      case FUNC.SideNearToSideBase: {
        // Check if sideA is near sideB's BASE position (fixed)
        const sideA = asInt(args[0]);
        const sideB = asInt(args[1]);
        const posA = this.getSidePosition(ctx, ev, sideA);
        const posB = this.getSideBasePosition(ctx, ev, sideB);
        const dx = posA.x - posB.x;
        const dz = posA.z - posB.z;
        return Math.sqrt(dx * dx + dz * dz) < NEAR_SIDE_TO_SIDE ? 1 : 0;
      }

      case FUNC.SideNearToPoint: {
        const side = asInt(args[0]);
        const pos = asPos(args[1]);
        const sidePos = this.getSidePosition(ctx, ev, side);
        const dx = sidePos.x - pos.x;
        const dz = sidePos.z - pos.z;
        return Math.sqrt(dx * dx + dz * dz) < NEAR_SIDE_TO_POINT ? 1 : 0;
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
        // Move units to guard an object (attack-move so they engage nearby threats)
        const side = asInt(args[0]);
        const targetEid = asInt(args[1]);
        if (targetEid >= 0 && hasComponent(ctx.game.getWorld(), Position, targetEid)) {
          this.aiMoveUnits(ctx, side, Position.x[targetEid], Position.z[targetEid], true);
        }
        return 0;
      }

      case FUNC.SideAIExitMap: {
        // Move all units of this side toward the nearest map edge
        const side = asInt(args[0]);
        const mapW = ctx.terrain.getMapWidth() * TILE_SIZE;
        const mapH = ctx.terrain.getMapHeight() * TILE_SIZE;
        const sidePos = this.getSidePosition(ctx, ev, side);
        // Find nearest edge
        const distLeft = sidePos.x;
        const distRight = mapW - sidePos.x;
        const distTop = sidePos.z;
        const distBottom = mapH - sidePos.z;
        const minDist = Math.min(distLeft, distRight, distTop, distBottom);
        let exitX = sidePos.x, exitZ = sidePos.z;
        if (minDist === distLeft) exitX = 0;
        else if (minDist === distRight) exitX = mapW;
        else if (minDist === distTop) exitZ = 0;
        else exitZ = mapH;
        this.aiMoveUnits(ctx, side, exitX, exitZ, false);
        return 0;
      }

      case FUNC.SideAIEncounterAttack: {
        // Persistent flag: side attacks enemies on encounter
        const side = asInt(args[0]);
        const ai = ctx.aiPlayers.find(a => (a as any).playerId === side);
        if (ai && typeof (ai as any).setEncounterBehavior === 'function') {
          (ai as any).setEncounterBehavior('attack');
        }
        return 0;
      }

      case FUNC.SideAIControl: {
        const ctrlSide = asInt(args[0]);
        this.setAIBehavior(ctx, ctrlSide, 'normal');
        return 0;
      }

      case FUNC.SideAIBehaviourAggressive: {
        const aggSide = asInt(args[0]);
        this.setAIBehavior(ctx, aggSide, 'aggressive');
        return 0;
      }

      case FUNC.SideAIBehaviourRetreat: {
        const retSide = asInt(args[0]);
        this.setAIBehavior(ctx, retSide, 'retreat');
        return 0;
      }

      case FUNC.SideAIBehaviourNormal: {
        const normSide = asInt(args[0]);
        this.setAIBehavior(ctx, normSide, 'normal');
        return 0;
      }

      case FUNC.SideAIBehaviourDefensive: {
        const defSide = asInt(args[0]);
        this.setAIBehavior(ctx, defSide, 'defensive');
        return 0;
      }

      case FUNC.SideAIEncounterIgnore: {
        // Persistent flag: side ignores enemies on encounter
        const side = asInt(args[0]);
        const ai = ctx.aiPlayers.find(a => (a as any).playerId === side);
        if (ai && typeof (ai as any).setEncounterBehavior === 'function') {
          (ai as any).setEncounterBehavior('ignore');
        }
        return 0;
      }

      case FUNC.SideAIHeadlessChicken: {
        const side = asInt(args[0]);
        const mapW = ctx.terrain.getMapWidth() * 2;
        const mapH = ctx.terrain.getMapHeight() * 2;
        const targetX = simRng.int(0, Math.max(1, Math.floor(mapW)));
        const targetZ = simRng.int(0, Math.max(1, Math.floor(mapH)));
        this.aiMoveUnits(ctx, side, targetX, targetZ, false);
        return 0;
      }

      case FUNC.SideAIShuffle: {
        const side = asInt(args[0]);
        const sidePos = this.getSidePosition(ctx, ev, side);
        const offsetX = simRng.int(-10, 10);
        const offsetZ = simRng.int(-10, 10);
        this.aiMoveUnits(ctx, side, sidePos.x + offsetX, sidePos.z + offsetZ, false);
        return 0;
      }

      case FUNC.SideAIEnterBuilding: {
        const side = asInt(args[0]);
        const targetEid = asInt(args[1]);
        const w = ctx.game.getWorld();
        if (targetEid < 0 || !hasComponent(w, Position, targetEid)) return 0;
        const tx = Position.x[targetEid];
        const tz = Position.z[targetEid];
        const enterRadiusSq = 12 * 12;
        let enteredCount = 0;

        for (const eid of unitQuery(w)) {
          if (Owner.playerId[eid] !== side || Health.current[eid] <= 0) continue;
          const dx = Position.x[eid] - tx;
          const dz = Position.z[eid] - tz;
          if (dx * dx + dz * dz <= enterRadiusSq) {
            Health.current[eid] = 0;
            EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
            enteredCount++;
          } else {
            MoveTarget.x[eid] = tx;
            MoveTarget.z[eid] = tz;
            MoveTarget.active[eid] = 1;
          }
        }
        return enteredCount;
      }

      // -------------------------------------------------------------------
      // Dialog / Messages
      // -------------------------------------------------------------------
      case FUNC.Message: {
        const msgId = asInt(args[0]);
        const text = getMissionMessage(this.housePrefix, msgId)
          ?? getCampaignString(`#${msgId}`)
          ?? `[Message ${msgId}]`;
        ctx.selectionPanel.addMessage(text, '#ffcc44');
        return 0;
      }

      case FUNC.GiftingMessage: {
        const msgId = asInt(args[0]);
        const text = getMissionMessage(this.housePrefix, msgId)
          ?? getCampaignString(`#${msgId}`)
          ?? `[Message ${msgId}]`;
        ctx.selectionPanel.addMessage(text, '#44ff44');
        return 0;
      }

      case FUNC.TimerMessage: {
        const msgId = asInt(args[0]);
        const text = getMissionMessage(this.housePrefix, msgId)
          ?? getCampaignString(`#${msgId}`)
          ?? `[Timer ${msgId}]`;
        // Persistent on-screen display (stays until TimerMessageRemove)
        const panel = ctx.selectionPanel as any;
        if (typeof panel?.addTimerMessage === 'function') {
          panel.addTimerMessage(text, '#ffaa00');
        } else {
          ctx.selectionPanel.addMessage(text, '#ffaa00');
        }
        return 0;
      }

      case FUNC.TimerMessageRemove: {
        const panel = ctx.selectionPanel as any;
        if (typeof panel?.removeTimerMessage === 'function') {
          panel.removeTimerMessage();
        }
        return 0;
      }

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

      case FUNC.CameraTrackObject: {
        const eid = asInt(args[0]);
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Position, eid)) {
          ctx.scene.panTo(Position.x[eid], Position.z[eid]);
        }
        this.mainCameraTrackEid = eid;
        return 0;
      }

      case FUNC.PIPCameraTrackObject: {
        const eid = asInt(args[0]);
        const pip = ctx.pipRenderer;
        if (eid >= 0 && hasComponent(ctx.game.getWorld(), Position, eid)) {
          pip.panTo(Position.x[eid], Position.z[eid]);
        }
        pip.show();
        this.pipCameraTrackEid = eid;
        return 0;
      }

      case FUNC.PIPCameraLookAtPoint:
      case FUNC.PIPCameraPanToPoint:
      case FUNC.PIPCameraScrollToPoint: {
        const pos = asPos(args[0]);
        ctx.pipRenderer.panTo(pos.x, pos.z);
        return 0;
      }

      case FUNC.PIPRelease:
        this.pipCameraTrackEid = null;
        this.pipCameraSpin.active = false;
        ctx.pipRenderer.release();
        return currentTick;

      case FUNC.CameraZoomTo: {
        const targetZoom = args.length > 1 ? asInt(args[1]) : asInt(args[0]);
        this.setCameraZoom(ctx, targetZoom);
        return 0;
      }

      case FUNC.PIPCameraZoomTo: {
        const targetZoom = args.length > 1 ? asInt(args[1]) : asInt(args[0]);
        ctx.pipRenderer.setZoom(targetZoom);
        ctx.pipRenderer.show();
        return 0;
      }

      case FUNC.CameraViewFrom: {
        const pos = asPos(args[0]);
        ctx.scene.panTo(pos.x, pos.z);
        return 0;
      }

      case FUNC.PIPCameraViewFrom: {
        const pos = asPos(args[0]);
        ctx.pipRenderer.panTo(pos.x, pos.z);
        return 0;
      }

      case FUNC.CameraStartRotate: {
        const speed = Math.max(0, asInt(args[0]));
        const dirCode = args.length > 1 ? asInt(args[1]) : 1;
        this.mainCameraSpin.active = true;
        this.mainCameraSpin.speed = speed;
        this.mainCameraSpin.direction = dirCode === 2 ? -1 : 1;
        return 0;
      }

      case FUNC.PIPCameraStartRotate: {
        const speed = Math.max(0, asInt(args[0]));
        const dirCode = args.length > 1 ? asInt(args[1]) : 1;
        this.pipCameraSpin.active = true;
        this.pipCameraSpin.speed = speed;
        this.pipCameraSpin.direction = dirCode === 2 ? -1 : 1;
        ctx.pipRenderer.show();
        return 0;
      }

      case FUNC.CameraStopRotate:
        this.mainCameraSpin.active = false;
        return 0;

      case FUNC.PIPCameraStopRotate:
        this.pipCameraSpin.active = false;
        return 0;

      case FUNC.CameraStopTrack:
        this.mainCameraTrackEid = null;
        return 0;

      case FUNC.PIPCameraStopTrack:
        this.pipCameraTrackEid = null;
        return 0;

      case FUNC.CameraIsPanning:
      case FUNC.CameraIsScrolling:
        return this.isCameraPanning(ctx) ? 1 : 0;

      case FUNC.PIPCameraIsPanning:
      case FUNC.PIPCameraIsScrolling:
        return ctx.pipRenderer.isPanning() ? 1 : 0;

      case FUNC.CameraIsSpinning:
        return this.mainCameraSpin.active ? 1 : 0;

      case FUNC.PIPCameraIsSpinning:
        return this.pipCameraSpin.active ? 1 : 0;

      case FUNC.CameraStore:
        this.mainCameraStored = this.captureCamera(ctx);
        return 0;

      case FUNC.PIPCameraStore:
        this.pipCameraStored = this.capturePIPCamera(ctx);
        return 0;

      case FUNC.CameraRestore:
        if (this.mainCameraStored) this.restoreCamera(ctx, this.mainCameraStored);
        return 0;

      case FUNC.PIPCameraRestore:
        if (this.pipCameraStored) this.restorePIPCamera(ctx, this.pipCameraStored);
        return 0;

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

      case FUNC.ReplaceShroud: {
        const pos = asPos(args[0]);
        const radius = args.length > 1 ? asInt(args[1]) : 10;
        ctx.fogOfWar.coverWorldArea(pos.x, pos.z, radius);
        return 0;
      }

      case FUNC.RemoveMapShroud: {
        const worldW = ctx.terrain.getMapWidth() * TILE_SIZE;
        const worldH = ctx.terrain.getMapHeight() * TILE_SIZE;
        const radius = Math.max(worldW, worldH) * 2;
        ctx.fogOfWar.revealWorldArea(worldW * 0.5, worldH * 0.5, radius);
        return 0;
      }

      // -------------------------------------------------------------------
      // Radar
      // -------------------------------------------------------------------
      case FUNC.RadarEnabled:
        // Campaign scripts can force radar on even without an outpost.
        (ctx as any).__tokForceRadarEnabled = true;
        if (typeof (ctx.minimapRenderer as any)?.setRadarActive === 'function') {
          (ctx.minimapRenderer as any).setRadarActive(true);
        }
        return 1;

      case FUNC.RadarAlert: {
        const pos = asPos(args[0]);
        ctx.pushGameEvent(pos.x, pos.z, 'radar-alert');
        return 0;
      }

      // -------------------------------------------------------------------
      // Victory / Defeat
      // -------------------------------------------------------------------
      case FUNC.MissionOutcome: {
        // MissionOutcome(TRUE/FALSE): Called as a statement (never queried).
        // TRUE = player wins, FALSE = player loses.
        const val = asInt(args[0]);
        if (val) {
          // MissionOutcome(TRUE) — player victory
          ctx.victorySystem.setVictoryCondition('annihilate');
          ctx.victorySystem.forceVictory();
        } else {
          // MissionOutcome(FALSE) — player defeat
          ctx.victorySystem.forceDefeat();
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
        // NormalConditionLose(side): TRUE when side has no surviving units/buildings.
        return this.isSideDefeated(ctx, asInt(args[0])) ? 1 : 0;

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
        // Native scripts pass (side, objVarOut). Support both out-param and direct checks.
        if (args.length >= 2) {
          const side = asInt(args[0]);
          const outArg = argExprs[1];
          if (outArg?.kind === 'var' && outArg.varType === VarType.Obj) {
            const deliveredEid = ev.events.consumeDeliveredObject(side);
            if (deliveredEid === undefined) return 0;
            ev.setVar(outArg.slot, VarType.Obj, deliveredEid);
            return 1;
          }
          const eid = asInt(args[1]);
          return ev.events.wasObjectDeliveredForSide(side, eid) ? 1 : 0;
        }
        const eid = asInt(args[0]);
        return ev.events.wasObjectDelivered(eid) ? 1 : 0;
      }

      case FUNC.EventObjectConstructed: {
        const side = asInt(args[0]);
        if (args.length >= 2) {
          const outArg = argExprs[1];
          if (outArg?.kind === 'var' && outArg.varType === VarType.Obj) {
            const builtEid = ev.events.consumeConstructedObject(side);
            if (builtEid === undefined) return 0;
            ev.setVar(outArg.slot, VarType.Obj, builtEid);
            return 1;
          }
          const eid = asInt(args[1]);
          return ev.events.wasObjectConstructed(side, eid) ? 1 : 0;
        }
        return 0;
      }

      case FUNC.EventObjectTypeConstructed: {
        const side = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const typeName = this.resolveString(typeIdx);
        if (args.length >= 3) {
          const outArg = argExprs[2];
          if (outArg?.kind === 'var' && outArg.varType === VarType.Obj) {
            const builtEid = ev.events.consumeObjectTypeConstructed(side, typeName);
            if (builtEid === undefined) return 0;
            ev.setVar(outArg.slot, VarType.Obj, builtEid);
            return 1;
          }
          const eid = asInt(args[2]);
          return ev.events.wasObjectTypeConstructedObject(side, typeName, eid) ? 1 : 0;
        }
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
        // Force an immediate worm attack at position — deploy a cluster of thumpers
        const pos = asPos(args[0]);
        ctx.sandwormSystem.deployThumper(pos.x, pos.z);
        ctx.sandwormSystem.deployThumper(pos.x + 2, pos.z + 2);
        ctx.sandwormSystem.deployThumper(pos.x - 2, pos.z - 2);
        return 0;
      }

      case FUNC.SideNuke: {
        // SideNuke(side, pos) — fire superweapon at position
        const nukeSide = asInt(args[0]);
        const nukePos = asPos(args[1]);
        ctx.superweaponSystem.fire(nukeSide, nukePos.x, nukePos.z);
        return 0;
      }

      case FUNC.SideNukeAll: {
        // SideNukeAll() — fire at each side's centroid
        for (let s = 0; s < ev.sides.nextSideId; s++) {
          const sPos = this.getSidePosition(ctx, ev, s);
          if (this.countSideUnits(ctx, s) + this.countSideBuildings(ctx, s) > 0) {
            ctx.superweaponSystem.fire(255, sPos.x, sPos.z); // 255 = neutral/scripted
          }
        }
        return 0;
      }

      case FUNC.AirStrike: {
        // AirStrike(strikeId, targetPos, side, unitType1, unitType2, ...)
        const strikeId = asInt(args[0]);
        const strikeTarget = asPos(args[1]);
        const strikeSide = asInt(args[2]);
        // Spawn strike units at entrance point and move toward target
        const strikeUnits: number[] = [];
        const strikeEntrance = this.getEntrancePoint(ctx, strikeSide);
        for (let i = 3; i < args.length; i++) {
          const typeIdx = asInt(args[i]);
          const typeName = this.resolveString(typeIdx);
          const eid = this.spawnObject(ctx, typeName, strikeSide, strikeEntrance.x, strikeEntrance.z);
          if (eid >= 0) {
            MoveTarget.x[eid] = strikeTarget.x;
            MoveTarget.z[eid] = strikeTarget.z;
            MoveTarget.active[eid] = 1;
            strikeUnits.push(eid);
          }
        }
        if (strikeUnits.length > 0) {
          ctx.combatSystem.setAttackMove(strikeUnits);
        }
        this.airStrikes.set(strikeId, { units: strikeUnits, targetX: strikeTarget.x, targetZ: strikeTarget.z });
        return 0;
      }

      case FUNC.AirStrikeDone: {
        // AirStrikeDone(strikeId) — returns 1 when all strike units dead or reached target
        const doneId = asInt(args[0]);
        const strike = this.airStrikes.get(doneId);
        if (!strike) return 1;
        const w = ctx.game.getWorld();
        const alive = strike.units.filter(eid =>
          hasComponent(w, Health, eid) && Health.current[eid] > 0
        );
        if (alive.length === 0) {
          this.airStrikes.delete(doneId);
          return 1;
        }
        // Check if any alive units still have active move orders
        const moving = alive.some(eid => MoveTarget.active[eid] === 1);
        if (!moving) {
          this.airStrikes.delete(doneId);
          return 1;
        }
        return 0;
      }

      case FUNC.FireSpecialWeapon: {
        if (args.length === 0) return 0;
        const side = asInt(args[0]);
        let target: TokPos = this.getSidePosition(ctx, ev, side);
        for (let i = 1; i < args.length; i++) {
          if (isPos(args[i])) {
            target = asPos(args[i]);
            break;
          }
        }
        ctx.superweaponSystem.fire(side, target.x, target.z);
        return 0;
      }

      case FUNC.SideAttractsWorms: {
        // Persistent flag: this side's units always attract worms
        const side = asInt(args[0]);
        ctx.sandwormSystem.setSideAttractsWorms(side);
        return 0;
      }

      case FUNC.SideRepelsWorms: {
        // Persistent flag: worms avoid this side's units entirely
        const side = asInt(args[0]);
        ctx.sandwormSystem.setSideRepelsWorms(side);
        return 0;
      }

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
      case FUNC.CarryAllDelivery: {
        // CarryAllDelivery(side, type, pos)
        // Animated: Carryall flies in from map entrance, drops unit, flies out.
        if (args.length < 3) return -1;
        const side = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const pos = asPos(args[2]);
        const typeName = this.resolveString(typeIdx);
        const entrance = this.getEntrancePoint(ctx, side);
        ctx.deliverySystem.queueDelivery(ctx, {
          side,
          typeNames: [typeName],
          destX: pos.x,
          destZ: pos.z,
          entranceX: entrance.x,
          entranceZ: entrance.z,
          kind: 'carryall',
          onSpawned: (eids) => {
            for (const eid of eids) {
              ev.events.objectDelivered(side, eid);
            }
          },
        });
        // Return 0 since the entity hasn't been spawned yet (async delivery).
        // Scripts that need the entity ID should use a delivery-complete condition.
        return 0;
      }

      case FUNC.Delivery: {
        // Delivery(side, pos, type1, type2, ...)
        // Animated: Carryall flies in from map entrance, drops unit(s), flies out.
        if (args.length < 3) return -1;
        const side = asInt(args[0]);
        const deliveryPos = isPos(args[1]) ? asPos(args[1]) : asPos(args[2]);
        const typeStart = isPos(args[1]) ? 2 : 1;
        const typeNames: string[] = [];
        for (let i = typeStart; i < args.length; i++) {
          if (!isPos(args[i])) typeNames.push(this.resolveString(asInt(args[i])));
        }
        const entrance = this.getEntrancePoint(ctx, side);
        ctx.deliverySystem.queueDelivery(ctx, {
          side,
          typeNames,
          destX: deliveryPos.x,
          destZ: deliveryPos.z,
          entranceX: entrance.x,
          entranceZ: entrance.z,
          kind: 'carryall',
          onSpawned: (eids) => {
            for (const eid of eids) {
              ev.events.objectDelivered(side, eid);
            }
          },
        });
        return 0;
      }

      case FUNC.StarportDelivery: {
        // StarportDelivery(side, pos, type1, type2, ...)
        // Uses starport landing pad descent animation instead of carryall.
        if (args.length < 3) return -1;
        const side = asInt(args[0]);
        const deliveryPos = isPos(args[1]) ? asPos(args[1]) : asPos(args[2]);
        const typeStart = isPos(args[1]) ? 2 : 1;
        const typeNames: string[] = [];
        for (let i = typeStart; i < args.length; i++) {
          if (!isPos(args[i])) typeNames.push(this.resolveString(asInt(args[i])));
        }
        const entrance = this.getEntrancePoint(ctx, side);
        ctx.deliverySystem.queueDelivery(ctx, {
          side,
          typeNames,
          destX: deliveryPos.x,
          destZ: deliveryPos.z,
          entranceX: entrance.x,
          entranceZ: entrance.z,
          kind: 'starport',
          onSpawned: (eids) => {
            for (const eid of eids) {
              ev.events.objectDelivered(side, eid);
            }
          },
        });
        return 0;
      }

      case FUNC.BuildObject: {
        // BuildObject(side, type) in original scripts; optional position fallback.
        // Queues production for sides that have the requisite buildings,
        // otherwise falls back to instant spawn (scripted AI reinforcements).
        if (args.length < 2) return -1;
        const side = asInt(args[0]);
        const typeIdx = asInt(args[1]);
        const pos = args.length >= 3 ? asPos(args[2]) : this.getSidePosition(ctx, ev, side);
        const typeName = this.resolveString(typeIdx);
        const isBuilding = ctx.typeRegistry.buildingTypeIdMap.has(typeName);

        // Try to queue via ProductionSystem for a more natural build experience.
        // Only attempt this for non-building types (units) where side has production buildings.
        if (!isBuilding && ctx.productionSystem.canBuild(side, typeName, false)) {
          const started = ctx.productionSystem.startProduction(side, typeName, false);
          if (started) {
            // Production system will handle spawning via production:complete event.
            // Fire script events when the unit eventually spawns.
            const evRef = ev;
            const sideRef = side;
            const typeNameRef = typeName;
            const handler = ({ unitType, owner }: { unitType: string; owner: number }) => {
              if (owner === sideRef && unitType === typeNameRef) {
                EventBus.off('production:complete', handler);
                // The actual entity is spawned by the production:complete handler,
                // so we just fire the script events.
                evRef.events.objectConstructed(sideRef, -1);
                evRef.events.objectTypeConstructed(sideRef, typeNameRef);
              }
            };
            EventBus.on('production:complete', handler);
            return 0;
          }
        }

        // Fallback: instant spawn (scripted AI sides without production buildings)
        const eid = this.spawnObject(ctx, typeName, side, pos.x, pos.z);
        if (eid >= 0) {
          ev.events.objectConstructed(side, eid);
          ev.events.objectTypeConstructed(side, typeName, eid);
        }
        return eid;
      }

      case FUNC.SetReinforcements: {
        const side = asInt(args[0]);
        const level = Math.max(0, asInt(args[1]));
        this.setSideReinforcements(ctx, side, level);
        return 0;
      }

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
        this.sideColors.set(asInt(args[0]), asInt(args[1]));
        return 0;

      case FUNC.GetSideColor:
        return this.sideColors.get(asInt(args[0])) ?? 0;

      case FUNC.PlaySound: {
        const soundId = asInt(args[0]);
        this.playScriptSound(ctx, soundId);
        return 0;
      }

      case FUNC.FreezeGame:
      case FUNC.DisableUI:
        this.setScriptUiEnabled(ctx, false);
        return 0;

      case FUNC.UnFreezeGame:
      case FUNC.EnableUI:
        this.setScriptUiEnabled(ctx, true);
        return 0;

      case FUNC.BreakPoint:
        return 0;

      case FUNC.SetVeterancy: {
        // SetVeterancy(obj, rank)
        const eid = asInt(args[0]);
        const rank = Math.max(0, Math.min(3, asInt(args[1])));
        const w = ctx.game.getWorld();
        if (eid >= 0 && hasComponent(w, Health, eid)) {
          if (!hasComponent(w, Veterancy, eid)) {
            addComponent(w, Veterancy, eid);
          }
          Veterancy.rank[eid] = rank;
          // Preserve current XP when possible, otherwise seed rank threshold if known.
          if (Veterancy.xp[eid] === 0 && hasComponent(w, UnitType, eid)) {
            const typeName = ctx.typeRegistry.unitTypeNames[UnitType.id[eid]];
            const def = typeName ? ctx.gameRules.units.get(typeName) : null;
            const threshold = rank > 0 ? def?.veterancy?.[rank - 1]?.scoreThreshold ?? 0 : 0;
            Veterancy.xp[eid] = Math.max(0, threshold);
          }
        }
        return 0;
      }

      case FUNC.SetThreatLevel: {
        const typeName = this.resolveString(asInt(args[0]));
        const level = asInt(args[1]);
        this.typeThreatLevels.set(typeName, level);

        const unitDef = ctx.gameRules.units.get(typeName);
        if (unitDef) {
          (unitDef as any).aiThreat = level;
        }
        const buildingDef = ctx.gameRules.buildings.get(typeName);
        if (buildingDef) {
          (buildingDef as any).aiThreat = level;
        }
        return 0;
      }

      case FUNC.SetTilePos: {
        const tx = asInt(args[0]);
        const tz = asInt(args[1]);
        return tileToWorld(tx, tz);
      }

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

  private updateScriptCamera(ctx: GameContext, currentTick: number): void {
    if (currentTick === this.lastCameraTick) return;
    const dt = this.lastCameraTick < 0 ? 1 : Math.max(1, currentTick - this.lastCameraTick);
    this.lastCameraTick = currentTick;

    // Main camera tracking & spin
    this.applyCameraTrack(ctx, this.mainCameraTrackEid, false);
    this.applyCameraSpin(ctx, this.mainCameraSpin, dt, false);

    // PIP camera tracking & spin (independent)
    this.applyCameraTrack(ctx, this.pipCameraTrackEid, true);
    this.applyCameraSpin(ctx, this.pipCameraSpin, dt, true);
  }

  private applyCameraTrack(ctx: GameContext, trackEid: number | null, isPip: boolean): void {
    if (trackEid === null) return;
    const w = ctx.game.getWorld();
    if (trackEid < 0 || !hasComponent(w, Position, trackEid)) return;
    if (hasComponent(w, Health, trackEid) && Health.current[trackEid] <= 0) return;
    if (isPip) {
      ctx.pipRenderer.panTo(Position.x[trackEid], Position.z[trackEid]);
    } else {
      ctx.scene.panTo(Position.x[trackEid], Position.z[trackEid]);
    }
  }

  private applyCameraSpin(ctx: GameContext, spin: CameraSpinState, dt: number, isPip: boolean): void {
    if (!spin.active) return;
    const delta = spin.speed * 0.01 * spin.direction * dt;
    if (isPip) {
      ctx.pipRenderer.rotateCamera(delta);
    } else {
      const scene = ctx.scene as any;
      if (typeof scene?.rotateCamera === 'function') {
        scene.rotateCamera(delta);
      }
    }
  }

  private setCameraZoom(ctx: GameContext, targetZoom: number): void {
    const scene = ctx.scene as any;
    if (typeof scene?.setZoom === 'function') {
      scene.setZoom(targetZoom);
      return;
    }
    if (typeof scene?.getZoom === 'function' && typeof scene?.zoom === 'function') {
      const current = scene.getZoom();
      scene.zoom(targetZoom - current);
    }
  }

  private isCameraPanning(ctx: GameContext): boolean {
    const scene = ctx.scene as any;
    if (typeof scene?.isPanning === 'function') {
      return !!scene.isPanning();
    }
    return false;
  }

  private captureCamera(ctx: GameContext): CameraSnapshot {
    const scene = ctx.scene as any;
    const target = typeof scene?.getCameraTarget === 'function'
      ? scene.getCameraTarget()
      : { x: 0, z: 0 };
    const zoom = typeof scene?.getZoom === 'function' ? scene.getZoom() : 50;
    const rotation = typeof scene?.getCameraRotation === 'function' ? scene.getCameraRotation() : 0;
    return { x: target.x, z: target.z, zoom, rotation };
  }

  private restoreCamera(ctx: GameContext, snap: CameraSnapshot): void {
    const scene = ctx.scene as any;
    if (typeof scene?.snapTo === 'function') {
      scene.snapTo(snap.x, snap.z);
    } else {
      scene.panTo(snap.x, snap.z);
    }
    this.setCameraZoom(ctx, snap.zoom);
    if (typeof scene?.setRotation === 'function') {
      scene.setRotation(snap.rotation);
    } else if (typeof scene?.getCameraRotation === 'function' && typeof scene?.rotateCamera === 'function') {
      scene.rotateCamera(snap.rotation - scene.getCameraRotation());
    }
  }

  private capturePIPCamera(ctx: GameContext): CameraSnapshot {
    const pip = ctx.pipRenderer;
    return pip.captureState();
  }

  private restorePIPCamera(ctx: GameContext, snap: CameraSnapshot): void {
    const pip = ctx.pipRenderer;
    pip.restoreState(snap);
  }

  private isObjectCarried(ctx: GameContext, eid: number): boolean {
    if (eid < 0) return false;
    const ability = ctx.abilitySystem as any;
    if (typeof ability?.getTransportPassengers !== 'function') return false;
    const passengersByTransport = ability.getTransportPassengers() as Map<number, number[]>;
    if (!(passengersByTransport instanceof Map)) return false;
    for (const passengers of passengersByTransport.values()) {
      if (passengers.includes(eid)) return true;
    }
    return false;
  }

  private setSideReinforcements(ctx: GameContext, side: number, level: number): void {
    const ai = ctx.aiPlayers.find(a => (a as any).playerId === side) as any;
    if (!ai) return;

    if (level === 0) {
      // Disable reinforcements
      ai.reinforcementsEnabled = false;
      return;
    }

    // Enable reinforcements at the given level
    ai.reinforcementsEnabled = true;
    ai.reinforcementLevel = level;
    // Higher level = shorter interval between waves
    ai.reinforcementInterval = Math.max(200, 600 - level * 50);

    // Also tune wave timing for immediate AI behavior
    const tunedWaveInterval = Math.max(150, 600 - level * 30);
    ai.waveInterval = tunedWaveInterval;
    if (typeof ai.attackCooldown === 'number') {
      ai.attackCooldown = Math.max(100, Math.floor(tunedWaveInterval * 0.8));
    }
  }

  private playScriptSound(ctx: GameContext, soundId: number): void {
    const audio = ctx.audioManager as any;
    if (typeof audio?.playSfx !== 'function') return;

    // Look up the sound ID in the AUDIO.BAG table (945 entries).
    // First try a direct OGG file if the SampleBank has it loaded.
    const oggPath = lookupSoundOgg(soundId);
    if (oggPath && audio.sampleBank && audio.sampleBank.has(oggPath)) {
      audio.sampleBank.play(oggPath, 0.35, false);
      return;
    }

    // Fall back to SfxManifest category routing (picks a random variant).
    const category = lookupSoundCategory(soundId);
    if (category) {
      audio.playSfx(category);
      return;
    }

    // Unknown sound ID -- fall back to generic 'select' so it's audible.
    console.warn(`[Tok] PlaySound: unmapped sound ID ${soundId}`);
    audio.playSfx('select');
  }

  private replaceObject(ctx: GameContext, eid: number, typeName: string, side: number): number {
    const w = ctx.game.getWorld();
    if (eid < 0) return -1;
    if (!hasComponent(w, Position, eid) || !hasComponent(w, Health, eid)) return -1;
    if (Health.current[eid] <= 0) return -1;

    const x = Position.x[eid];
    const z = Position.z[eid];
    Health.current[eid] = 0;
    EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
    return this.spawnObject(ctx, typeName, side, x, z);
  }

  /**
   * Morph an entity in-place: change its type without destroying/recreating.
   * Preserves entity ID so script variable references remain valid.
   */
  private morphObject(ctx: GameContext, eid: number, typeName: string, side: number): number {
    const w = ctx.game.getWorld();
    if (eid < 0) return -1;
    if (!hasComponent(w, Position, eid) || !hasComponent(w, Health, eid)) return -1;
    if (Health.current[eid] <= 0) return -1;

    // Determine the new type
    const isBuilding = ctx.typeRegistry.buildingTypeIdMap.has(typeName);
    const isUnit = ctx.typeRegistry.unitTypeIdMap.has(typeName);

    if (!isBuilding && !isUnit) {
      // Unknown type — fall back to replace
      return this.replaceObject(ctx, eid, typeName, side);
    }

    // Swap type component: remove old, add new
    const hadUnitType = hasComponent(w, UnitType, eid);
    const hadBuildingType = hasComponent(w, BuildingType, eid);

    if (isUnit) {
      if (hadBuildingType) removeComponent(w, BuildingType, eid);
      if (!hadUnitType) addComponent(w, UnitType, eid);
      UnitType.id[eid] = ctx.typeRegistry.unitTypeIdMap.get(typeName)!;
      // Update health to new type's max
      const def = ctx.gameRules.units.get(typeName);
      if (def && typeof def.health === 'number') {
        Health.max[eid] = def.health;
        Health.current[eid] = def.health;
      }
    } else {
      if (hadUnitType) removeComponent(w, UnitType, eid);
      if (!hadBuildingType) addComponent(w, BuildingType, eid);
      BuildingType.id[eid] = ctx.typeRegistry.buildingTypeIdMap.get(typeName)!;
      const def = ctx.gameRules.buildings.get(typeName);
      if (def && typeof def.health === 'number') {
        Health.max[eid] = def.health;
        Health.current[eid] = def.health;
      }
    }

    // Update owner
    if (hasComponent(w, Owner, eid)) {
      Owner.playerId[eid] = side;
    }

    return eid;
  }

  private setScriptUiEnabled(ctx: GameContext, enabled: boolean): void {
    const input = ctx.input as any;
    if (typeof input?.setEnabled === 'function') input.setEnabled(enabled);

    const selectionManager = ctx.selectionManager as any;
    if (typeof selectionManager?.setEnabled === 'function') {
      selectionManager.setEnabled(enabled);
    }

    const commandManager = ctx.commandManager as any;
    if (typeof commandManager?.setEnabled === 'function') {
      commandManager.setEnabled(enabled);
    }
  }

  private spawnDeliveryObjects(
    ctx: GameContext,
    ev: TokEvaluator,
    side: number,
    pos: TokPos,
    typeIndices: number[],
  ): number {
    let lastSpawned = -1;
    for (const typeIdx of typeIndices) {
      const typeName = this.resolveString(typeIdx);
      const eid = this.spawnObject(ctx, typeName, side, pos.x, pos.z);
      if (eid >= 0) {
        ev.events.objectDelivered(side, eid);
        lastSpawned = eid;
      }
    }
    return lastSpawned;
  }

  private spawnObject(ctx: GameContext, typeName: string, side: number, x: number, z: number): number {
    const world = ctx.game.getWorld();
    const isBuilding = ctx.typeRegistry.buildingTypeIdMap.has(typeName);
    const eid = isBuilding
      ? ctx.spawnBuilding(world, typeName, side, x, z)
      : ctx.spawnUnit(world, typeName, side, x, z);
    // Cache first spawn position as the side's base position
    if (eid >= 0 && !this.sideBasePositions.has(side)) {
      this.sideBasePositions.set(side, { x, z });
    }
    return eid;
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

  /** Returns the fixed base position for a side (first building/spawn location). */
  private getSideBasePosition(ctx: GameContext, ev: TokEvaluator, side: number): TokPos {
    // 1. Cached base position (set on first spawn)
    const cached = this.sideBasePositions.get(side);
    if (cached) return cached;
    // 2. Fall back to first living building of the side
    const w = ctx.game.getWorld();
    for (const eid of buildingQuery(w)) {
      if (Owner.playerId[eid] === side && Health.current[eid] > 0) {
        const pos: TokPos = { x: Position.x[eid], z: Position.z[eid] };
        this.sideBasePositions.set(side, pos);
        return pos;
      }
    }
    // 3. Fall back to centroid
    return this.getSidePosition(ctx, ev, side);
  }

  /** Returns the current centroid of a side's forces (dynamic). */
  private getSidePosition(ctx: GameContext, ev: TokEvaluator, side: number): TokPos {
    // Use cached base if no living units/buildings can provide a centroid
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

    // Fallback: use cached base position
    const cached = this.sideBasePositions.get(side);
    if (cached) return cached;

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

  private getEntrancePointByIndex(ctx: GameContext, index: number): TokPos {
    const meta = ctx.mapMetadata;
    if (meta && meta.entrances.length > 0) {
      const idx = Math.max(0, Math.min(index, meta.entrances.length - 1));
      const e = meta.entrances[idx];
      return { x: e.x * TILE_SIZE, z: e.z * TILE_SIZE };
    }
    return this.getNeutralEntrancePoint(ctx);
  }

  private getEntranceNearToPos(ctx: GameContext, pos: TokPos): TokPos {
    const meta = ctx.mapMetadata;
    if (meta && meta.entrances.length > 0) {
      let best = meta.entrances[0];
      let bestDist = Infinity;
      for (const e of meta.entrances) {
        const wx = e.x * TILE_SIZE;
        const wz = e.z * TILE_SIZE;
        const dx = wx - pos.x;
        const dz = wz - pos.z;
        const dist = dx * dx + dz * dz;
        if (dist < bestDist) {
          bestDist = dist;
          best = e;
        }
      }
      return { x: best.x * TILE_SIZE, z: best.z * TILE_SIZE };
    }
    return this.getNeutralEntrancePoint(ctx);
  }

  private getEntranceFarFromPos(ctx: GameContext, pos: TokPos): TokPos {
    return this.getFarthestEntrancePoint(ctx, pos);
  }

  private getIsolatedEntrance(ctx: GameContext, ev: TokEvaluator): TokPos {
    const meta = ctx.mapMetadata;
    if (meta && meta.entrances.length > 0) {
      // Find entrance farthest from ALL bases
      let bestEntrance = meta.entrances[0];
      let bestMinDist = -1;
      for (const e of meta.entrances) {
        const wx = e.x * TILE_SIZE;
        const wz = e.z * TILE_SIZE;
        let minDist = Infinity;
        for (let s = 0; s < Math.max(2, ev.sides.nextSideId); s++) {
          const sPos = this.getSidePosition(ctx, ev, s);
          const dx = wx - sPos.x;
          const dz = wz - sPos.z;
          minDist = Math.min(minDist, dx * dx + dz * dz);
        }
        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestEntrance = e;
        }
      }
      return { x: bestEntrance.x * TILE_SIZE, z: bestEntrance.z * TILE_SIZE };
    }
    return this.getUnusedBasePoint(ctx);
  }

  private getExitPoint(ctx: GameContext, side: number): TokPos {
    const entrance = this.getEntrancePoint(ctx, side);
    return this.getFarthestEntrancePoint(ctx, entrance);
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

  private getNeutralExitPoint(ctx: GameContext, fromPos: TokPos | null): TokPos {
    const from = fromPos ?? this.getNeutralEntrancePoint(ctx);
    return this.getFarthestEntrancePoint(ctx, from);
  }

  private getFarthestEntrancePoint(ctx: GameContext, from: TokPos): TokPos {
    const meta = ctx.mapMetadata;
    if (meta && meta.entrances.length > 0) {
      let best = meta.entrances[0];
      let bestDist = -1;
      for (const e of meta.entrances) {
        const wx = e.x * TILE_SIZE;
        const wz = e.z * TILE_SIZE;
        const dx = wx - from.x;
        const dz = wz - from.z;
        const dist = dx * dx + dz * dz;
        if (dist > bestDist) {
          bestDist = dist;
          best = e;
        }
      }
      return { x: best.x * TILE_SIZE, z: best.z * TILE_SIZE };
    }

    const mapW = ctx.terrain.getMapWidth() * 2;
    const mapH = ctx.terrain.getMapHeight() * 2;
    const flipX = from.x < mapW * 0.5 ? mapW - 5 : 5;
    const flipZ = from.z < mapH * 0.5 ? mapH - 5 : 5;
    return { x: flipX, z: flipZ };
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

  private setAIBehavior(ctx: GameContext, side: number, behavior: string): void {
    const ai = ctx.aiPlayers.find(a => (a as any).playerId === side);
    if (ai && typeof (ai as any).setBehaviorOverride === 'function') {
      (ai as any).setBehaviorOverride(behavior);
    }
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

  private isSideDefeated(ctx: GameContext, side: number): boolean {
    const w = ctx.game.getWorld();
    for (const eid of buildingQuery(w)) {
      if (Owner.playerId[eid] === side && Health.current[eid] > 0) return false;
    }
    for (const eid of unitQuery(w)) {
      if (Owner.playerId[eid] === side && Health.current[eid] > 0) return false;
    }
    return true;
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

function isPos(v: number | TokPos | undefined): v is TokPos {
  return typeof v === 'object' && v !== null;
}
