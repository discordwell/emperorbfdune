import type { GameContext, SaveData } from './GameContext';
import { GameConstants } from '../utils/Constants';
import { EventBus } from './EventBus';
import {
  hasComponent, addComponent,
  Position, Velocity, Rotation, Health, Owner, UnitType, Selectable,
  MoveTarget, AttackTarget, Speed, Renderable,
  Harvester, BuildingType, Veterancy, Shield,
  unitQuery, buildingQuery,
  type World,
} from './ECS';

export function buildSaveData(ctx: GameContext): SaveData {
  const w = ctx.game.getWorld();
  const entities: import('./GameContext').SavedEntity[] = [];
  const eidToIndex = new Map<number, number>();
  const { unitTypeNames, buildingTypeNames } = ctx.typeRegistry;

  // Save all units
  const allUnits = unitQuery(w);
  for (const eid of allUnits) {
    if (Health.current[eid] <= 0) continue;
    eidToIndex.set(eid, entities.length);
    const se: import('./GameContext').SavedEntity = {
      x: Position.x[eid], z: Position.z[eid], y: Position.y[eid],
      rotY: Rotation.y[eid],
      hp: Health.current[eid], maxHp: Health.max[eid],
      owner: Owner.playerId[eid],
      unitTypeId: UnitType.id[eid],
      speed: { max: Speed.max[eid], turn: Speed.turnRate[eid] },
      vet: { xp: Veterancy.xp[eid], rank: Veterancy.rank[eid] },
    };
    if (MoveTarget.active[eid]) {
      se.moveTarget = { x: MoveTarget.x[eid], z: MoveTarget.z[eid], active: MoveTarget.active[eid] };
    }
    if (hasComponent(w, Harvester, eid)) {
      se.harvester = {
        spice: Harvester.spiceCarried[eid], maxCap: Harvester.maxCapacity[eid],
        state: Harvester.state[eid], refEid: 0,
      };
    }
    if (ctx.aircraftAmmo.has(eid)) {
      se.ammo = ctx.aircraftAmmo.get(eid);
    }
    const passengers = ctx.abilitySystem.getTransportPassengers().get(eid);
    if (passengers && passengers.length > 0) {
      se.passengerTypeIds = passengers
        .filter(p => Health.current[p] > 0)
        .map(p => UnitType.id[p]);
    }
    const stance = ctx.combatSystem.getStance(eid);
    if (stance !== 1) se.stance = stance;
    const gp = ctx.combatSystem.getGuardPosition(eid);
    if (gp) se.guardPos = { x: gp.x, z: gp.z };
    if (ctx.combatSystem.isAttackMove(eid)) {
      const amd = ctx.combatSystem.getAttackMoveDestination(eid);
      if (amd) se.attackMoveDest = { x: amd.x, z: amd.z };
    }
    if (hasComponent(w, Shield, eid)) {
      se.shield = { current: Shield.current[eid], max: Shield.max[eid] };
    }
    entities.push(se);
  }

  // Save all buildings
  const allBuildings = buildingQuery(w);
  for (const eid of allBuildings) {
    if (Health.current[eid] <= 0) continue;
    eidToIndex.set(eid, entities.length);
    entities.push({
      x: Position.x[eid], z: Position.z[eid], y: Position.y[eid],
      rotY: Rotation.y[eid],
      hp: Health.current[eid], maxHp: Health.max[eid],
      owner: Owner.playerId[eid],
      buildingTypeId: BuildingType.id[eid],
    });
  }

  // Save spice map
  const spice: number[][] = [];
  const saveW = ctx.terrain.getMapWidth(), saveH = ctx.terrain.getMapHeight();
  for (let tz = 0; tz < saveH; tz++) {
    const row: number[] = [];
    for (let tx = 0; tx < saveW; tx++) {
      const s = ctx.terrain.getSpice(tx, tz);
      row.push(s > 0 ? Math.round(s * 100) / 100 : 0);
    }
    spice.push(row);
  }

  return {
    version: 1,
    tick: ctx.game.getTickCount(),
    housePrefix: ctx.house.prefix,
    enemyPrefix: ctx.house.enemyPrefix,
    houseName: ctx.house.name,
    enemyName: ctx.house.enemyName,
    gameMode: ctx.house.gameMode,
    difficulty: ctx.house.difficulty,
    mapChoice: ctx.house.mapChoice,
    skirmishOptions: ctx.house.skirmishOptions,
    opponents: ctx.house.opponents,
    campaignTerritoryId: ctx.house.campaignTerritoryId,
    subhouse: ctx.house.subhouse,
    mapId: ctx.activeMapId ?? undefined,
    missionConfig: ctx.activeMissionConfig ?? undefined,
    solaris: Array.from({ length: ctx.totalPlayers }, (_, i) => ctx.harvestSystem.getSolaris(i)),
    entities,
    spice,
    production: ctx.productionSystem.getState(),
    fogExplored: ctx.fogOfWar.getExploredData(),
    superweaponCharge: ctx.superweaponSystem.getChargeState(),
    victoryTick: ctx.victorySystem.getTickCounter(),
    controlGroups: (() => {
      const cg: Record<number, number[]> = {};
      for (const [key, eids] of ctx.selectionManager.getControlGroups()) {
        const indices = eids
          .filter(e => hasComponent(w, Health, e) && Health.current[e] > 0)
          .map(e => eidToIndex.get(e))
          .filter((idx): idx is number => idx !== undefined);
        if (indices.length > 0) cg[key] = indices;
      }
      return Object.keys(cg).length > 0 ? cg : undefined;
    })(),
    groundSplats: ctx.groundSplats.length > 0 ? ctx.groundSplats.map(s => ({ ...s })) : undefined,
    abilityState: (() => {
      const raw = ctx.abilitySystem.getAbilityState();
      const mapEid = (eid: number) => eidToIndex.get(eid);
      const deviated = raw.deviated
        .filter(d => mapEid(d.eid) !== undefined)
        .map(d => ({ eid: mapEid(d.eid)!, originalOwner: d.originalOwner, revertTick: d.revertTick }));
      const leech = raw.leech
        .filter(l => mapEid(l.leechEid) !== undefined && mapEid(l.targetEid) !== undefined)
        .map(l => ({ leechEid: mapEid(l.leechEid)!, targetEid: mapEid(l.targetEid)! }));
      const kobraDeployed = raw.kobraDeployed
        .filter(eid => mapEid(eid) !== undefined)
        .map(eid => mapEid(eid)!);
      const kobraBaseRange = raw.kobraBaseRange
        .filter(r => mapEid(r.eid) !== undefined)
        .map(r => ({ eid: mapEid(r.eid)!, range: r.range }));
      if (deviated.length === 0 && leech.length === 0 && kobraDeployed.length === 0) return undefined;
      return { deviated, leech, kobraDeployed, kobraBaseRange };
    })(),
  };
}

export function saveGame(ctx: GameContext): void {
  const save = buildSaveData(ctx);
  try {
    localStorage.setItem('ebfd_save', JSON.stringify(save));
    localStorage.setItem('ebfd_save_time', new Date().toLocaleString());
    ctx.selectionPanel.addMessage('Game saved! (F8 to load)', '#44ff44');
  } catch {
    ctx.selectionPanel.addMessage('Save failed: storage full', '#ff4444');
  }
}

export function restoreFromSave(ctx: GameContext, savedGame: SaveData): void {
  const world = ctx.game.getWorld();
  const { unitTypeNames, buildingTypeNames } = ctx.typeRegistry;

  ctx.game.setTickCount(savedGame.tick);
  for (let i = 0; i < savedGame.solaris.length; i++) {
    ctx.harvestSystem.addSolaris(i, savedGame.solaris[i] - ctx.harvestSystem.getSolaris(i));
  }

  // Restore spice
  const loadW = ctx.terrain.getMapWidth(), loadH = ctx.terrain.getMapHeight();
  for (let tz = 0; tz < savedGame.spice.length && tz < loadH; tz++) {
    for (let tx = 0; tx < savedGame.spice[tz].length && tx < loadW; tx++) {
      ctx.terrain.setSpice(tx, tz, savedGame.spice[tz][tx]);
    }
  }
  ctx.terrain.updateSpiceVisuals();

  const indexToEid = new Map<number, number>();

  // Restore buildings first (so refineries exist for harvesters)
  for (let idx = 0; idx < savedGame.entities.length; idx++) {
    const se = savedGame.entities[idx];
    if (se.buildingTypeId !== undefined) {
      const bName = buildingTypeNames[se.buildingTypeId];
      if (!bName) continue;
      const eid = ctx.spawnBuilding(world, bName, se.owner, se.x, se.z);
      if (eid >= 0) {
        Health.max[eid] = se.maxHp;
        Health.current[eid] = se.hp;
        Position.y[eid] = se.y;
        Rotation.y[eid] = se.rotY;
        indexToEid.set(idx, eid);
      }
    }
  }
  // Then units
  for (let idx = 0; idx < savedGame.entities.length; idx++) {
    const se = savedGame.entities[idx];
    if (se.unitTypeId !== undefined) {
      const uName = unitTypeNames[se.unitTypeId];
      if (!uName) continue;
      const eid = ctx.spawnUnit(world, uName, se.owner, se.x, se.z);
      if (eid >= 0) {
        Health.max[eid] = se.maxHp;
        Health.current[eid] = se.hp;
        Position.y[eid] = se.y;
        Rotation.y[eid] = se.rotY;
        indexToEid.set(idx, eid);
        if (se.vet) {
          Veterancy.xp[eid] = se.vet.xp;
          Veterancy.rank[eid] = se.vet.rank;
        }
        if (se.moveTarget && se.moveTarget.active) {
          MoveTarget.x[eid] = se.moveTarget.x;
          MoveTarget.z[eid] = se.moveTarget.z;
          MoveTarget.active[eid] = se.moveTarget.active;
        }
        if (se.harvester && hasComponent(world, Harvester, eid)) {
          Harvester.spiceCarried[eid] = se.harvester.spice;
          Harvester.state[eid] = se.harvester.state;
        }
        if (se.ammo !== undefined) {
          ctx.aircraftAmmo.set(eid, se.ammo);
        }
        if (se.passengerTypeIds && se.passengerTypeIds.length > 0) {
          const passengers: number[] = [];
          for (const pTypeId of se.passengerTypeIds) {
            const pName = unitTypeNames[pTypeId];
            if (!pName) continue;
            const pEid = ctx.spawnUnit(world, pName, se.owner, -999, -999);
            if (pEid >= 0) {
              Position.y[pEid] = -999;
              MoveTarget.active[pEid] = 0;
              AttackTarget.active[pEid] = 0;
              passengers.push(pEid);
            }
          }
          if (passengers.length > 0) ctx.abilitySystem.setTransportPassengers(eid, passengers);
        }
        if (se.stance !== undefined) ctx.combatSystem.setStance(eid, se.stance);
        if (se.guardPos) ctx.combatSystem.setGuardPosition(eid, se.guardPos.x, se.guardPos.z);
        if (se.attackMoveDest) ctx.combatSystem.restoreAttackMove(eid, se.attackMoveDest);
        if (se.shield) {
          addComponent(world, Shield, eid);
          Shield.current[eid] = se.shield.current;
          Shield.max[eid] = se.shield.max;
        }
      }
    }
  }

  // Restore production queues and upgrade state
  if (savedGame.production) {
    ctx.productionSystem.restoreState(savedGame.production);
  }

  // Clear deferred actions and descending units from pre-save state
  ctx.deferredActions.length = 0;
  ctx.descendingUnits.clear();

  // Snap any units with elevated Y to ground level
  for (const eid of unitQuery(world)) {
    if (Health.current[eid] <= 0) continue;
    const groundY = ctx.terrain.getHeightAt(Position.x[eid], Position.z[eid]) + 0.1;
    if (Position.y[eid] > groundY + 1.0 && !ctx.movement.isFlyer(eid)) {
      Position.y[eid] = groundY;
      ctx.combatSystem.setSuppressed(eid, false);
      const owner = Owner.playerId[eid];
      if (owner === 0) {
        const rally = ctx.commandManager.getRallyPoint(0);
        if (rally) {
          MoveTarget.x[eid] = rally.x;
          MoveTarget.z[eid] = rally.z;
          MoveTarget.active[eid] = 1;
        }
      }
    }
  }

  // Restore fog of war explored tiles
  if (savedGame.fogExplored) {
    ctx.fogOfWar.setExploredData(savedGame.fogExplored);
  }
  // Restore superweapon charge state
  if (savedGame.superweaponCharge) {
    ctx.superweaponSystem.setChargeState(savedGame.superweaponCharge);
  }
  // Restore victory system tick counter
  if (savedGame.victoryTick !== undefined) {
    ctx.victorySystem.setTickCounter(savedGame.victoryTick);
  }
  // Restore control groups
  if (savedGame.controlGroups) {
    const restoredGroups = new Map<number, number[]>();
    for (const [key, indices] of Object.entries(savedGame.controlGroups)) {
      const eids = indices
        .map((idx: number) => indexToEid.get(idx))
        .filter((eid): eid is number => eid !== undefined);
      if (eids.length > 0) restoredGroups.set(Number(key), eids);
    }
    ctx.selectionManager.setControlGroups(restoredGroups);
  }

  // Restore ability system state
  if (savedGame.abilityState) {
    ctx.abilitySystem.restoreAbilityState(savedGame.abilityState, indexToEid);
  }

  // Clean up any active storm listener before loading
  if (ctx.activeStormListener) {
    EventBus.off('game:tick', ctx.activeStormListener);
    ctx.activeStormListener = null;
    ctx.effectsManager.stopSandstorm();
  }
  ctx.stormWaitTimer = GameConstants.STORM_MIN_WAIT + Math.floor(Math.random() * GameConstants.STORM_MAX_WAIT);

  // Restore ground splats
  ctx.effectsManager.clearAllGroundSplats();
  ctx.groundSplats.length = 0;
  if (savedGame.groundSplats) {
    for (const s of savedGame.groundSplats) {
      const splatType = (s.type === 'fallout' ? 'fallout' : 'inkvine') as 'inkvine' | 'fallout';
      ctx.groundSplats.push({ x: s.x, z: s.z, ticksLeft: s.ticksLeft, ownerPlayerId: s.ownerPlayerId, type: splatType });
      ctx.effectsManager.spawnGroundSplat(s.x, s.z, splatType);
    }
  }

  // Restore AI state from saved buildings
  for (let i = 0; i < ctx.aiPlayers.length; i++) {
    const buildings = buildingQuery(world);
    let pBaseX = 0, pBaseZ = 0, pCount = 0;
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
      pBaseX += Position.x[eid];
      pBaseZ += Position.z[eid];
      pCount++;
    }
    if (pCount > 0) {
      ctx.aiPlayers[i].setTargetPosition(pBaseX / pCount, pBaseZ / pCount);
    }
    ctx.aiPlayers[i].reconstructFromWorldState(savedGame.tick, world);
  }

  // Position camera at player's base after load
  const playerBuildings = buildingQuery(world);
  let camX = 0, camZ = 0, camCount = 0;
  for (const eid of playerBuildings) {
    if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
    const typeId = BuildingType.id[eid];
    const bName = ctx.typeRegistry.buildingTypeNames[typeId] ?? '';
    if (bName.includes('ConYard')) {
      camX = Position.x[eid];
      camZ = Position.z[eid];
      camCount = 1;
      break;
    }
    camX += Position.x[eid];
    camZ += Position.z[eid];
    camCount++;
  }
  if (camCount > 0) {
    ctx.scene.cameraTarget.set(camX / camCount, 0, camZ / camCount);
    ctx.scene.updateCameraPosition();
  }

  console.log(`Restored ${savedGame.entities.length} entities from save (tick ${savedGame.tick})`);
}
