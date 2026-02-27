/**
 * Extracts GameState from the TS remake via page.evaluate().
 * Runs inside the browser context, reads ECS components directly.
 */

import type { Page } from 'playwright';
import type { GameState, PlayerState, UnitInfo, BuildingInfo, ProductionQueueItem, GameEvent } from './GameState.js';

/**
 * Injected into the page to collect buffered events.
 * Call installEventCollector() once after game starts.
 */
export async function installEventCollector(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w._oracleEvents) return; // already installed
    w._oracleEvents = [] as any[];

    const pushEvent = (evt: any) => {
      if (w._oracleEvents.length < 200) {
        w._oracleEvents.push(evt);
      }
    };

    // Access the EventBus singleton exposed by index.ts as window._eventBus
    const EB = w._eventBus;
    if (!EB) {
      console.warn('[Oracle] _eventBus not found — event collection disabled');
      return;
    }

    EB.on('unit:died', (d: any) => pushEvent({
      type: 'unit_destroyed', eid: d.entityId ?? 0, owner: 0, typeName: '',
    }));
    EB.on('building:destroyed', (d: any) => pushEvent({
      type: 'building_destroyed', eid: d.entityId ?? 0, owner: d.owner ?? 0, typeName: '',
    }));
    EB.on('production:complete', (d: any) => pushEvent({
      type: 'production_complete', typeName: d.unitType, owner: d.owner, isBuilding: d.isBuilding,
    }));
    EB.on('unit:damaged', (d: any) => {
      // Only push under_attack for player 0's units/buildings
      if (d.isBuilding || true) { // track all damage to player's entities
        pushEvent({ type: 'under_attack', x: d.x ?? 0, z: d.z ?? 0, owner: 0 });
      }
    });
    EB.on('unit:spawned', (d: any) => pushEvent({
      type: 'unit_created', eid: d.entityId, owner: d.owner, typeName: d.unitType ?? '',
    }));
  });
}

/**
 * Extract full GameState from the remake via page.evaluate().
 * Player 0 = human/oracle, players 1+ = enemies.
 */
export async function extractGameState(page: Page, playerId = 0): Promise<GameState> {
  const raw = await page.evaluate((pid: number) => {
    const w = window as any;
    const ctx = w.ctx;
    if (!ctx) throw new Error('Game context not available');

    const game = ctx.game;
    const world = game.getWorld();
    const rules = w.rules || ctx.gameRules;
    const registry = ctx.typeRegistry;
    const unitTypeNames: string[] = registry.unitTypeNames;
    const buildingTypeNames: string[] = registry.buildingTypeNames;

    const ECS = w._ecsRefs;
    if (!ECS) {
      const snap = w.debug?.gameStateSnapshot();
      return {
        tick: snap?.tick ?? 0,
        players: {} as any,
        events: (w._oracleEvents ?? []).splice(0),
      };
    }

    const tick = game.getTickCount();

    // Collect all players' data
    const playerMap = new Map<number, {
      units: any[];
      buildings: any[];
      ownedBuildingTypes: Record<string, number>;
    }>();

    const ensurePlayer = (id: number) => {
      if (!playerMap.has(id)) {
        playerMap.set(id, { units: [], buildings: [], ownedBuildingTypes: {} });
      }
      return playerMap.get(id)!;
    };

    // Units
    for (const eid of ECS.unitQuery(world)) {
      const hp = ECS.Health.current[eid];
      if (hp <= 0) continue;
      const owner = ECS.Owner.playerId[eid];
      const typeId = ECS.UnitType?.id?.[eid] ?? 0;
      const typeName = unitTypeNames[typeId] ?? `unit_${typeId}`;
      const maxHp = ECS.Health.max[eid] || 1;

      const isHarv = ECS.Harvester ? ECS.hasComponent(world, ECS.Harvester, eid) : false;
      const moveActive = ECS.MoveTarget?.active?.[eid] ?? 0;
      const attackActive = ECS.AttackTarget?.active?.[eid] ?? 0;
      const isIdle = moveActive === 0 && attackActive === 0;

      const unitDef = rules?.units?.get(typeName);

      const unit: any = {
        eid,
        typeName,
        x: ECS.Position.x[eid],
        z: ECS.Position.z[eid],
        healthPct: hp / maxHp,
        isHarvester: isHarv,
        isIdle,
        isInfantry: unitDef?.infantry ?? false,
        canFly: unitDef?.canFly ?? false,
      };

      if (isHarv && ECS.Harvester) {
        unit.harvesterState = ECS.Harvester.state[eid];
        unit.spiceCarried = ECS.Harvester.spiceCarried[eid];
        unit.maxCapacity = ECS.Harvester.maxCapacity[eid];
      }

      ensurePlayer(owner).units.push(unit);
    }

    // Buildings
    for (const eid of ECS.buildingQuery(world)) {
      const hp = ECS.Health.current[eid];
      if (hp <= 0) continue;
      const owner = ECS.Owner.playerId[eid];
      const typeId = ECS.BuildingType?.id?.[eid] ?? 0;
      const typeName = buildingTypeNames[typeId] ?? `bldg_${typeId}`;
      const maxHp = ECS.Health.max[eid] || 1;

      const p = ensurePlayer(owner);
      p.buildings.push({
        eid,
        typeName,
        x: ECS.Position.x[eid],
        z: ECS.Position.z[eid],
        healthPct: hp / maxHp,
      });
      p.ownedBuildingTypes[typeName] = (p.ownedBuildingTypes[typeName] ?? 0) + 1;
    }

    // Production queues via ProductionSystem.getQueue()
    const playersResult: Record<number, any> = {};
    for (const [pId, data] of playerMap) {
      const solaris = ctx.harvestSystem?.getSolaris(pId) ?? 0;
      const powerInfo = ctx.productionSystem?.getPowerInfo(pId) ?? { produced: 0, consumed: 0, ratio: 1.0 };

      // Read production queues via the public API
      const ps = ctx.productionSystem;
      const bldgQueue = ps?.getQueue(pId, true) ?? [];
      const infQueue = ps?.getQueue(pId, false, 'infantry') ?? [];
      const vehQueue = ps?.getQueue(pId, false, 'vehicle') ?? [];

      const mapQueue = (items: any[]) => items.map((item: any) => ({
        typeName: item.typeName,
        isBuilding: false,
        progress: item.progress ?? 0,
      }));

      playersResult[pId] = {
        playerId: pId,
        solaris,
        power: powerInfo,
        techLevel: 0,
        units: data.units,
        buildings: data.buildings,
        ownedBuildingTypes: data.ownedBuildingTypes,
        productionQueues: {
          building: mapQueue(bldgQueue),
          infantry: mapQueue(infQueue),
          vehicle: mapQueue(vehQueue),
        },
      };
    }

    // Drain events
    const events = (w._oracleEvents ?? []).splice(0);

    return { tick, players: playersResult, events };
  }, playerId);

  // Transform raw data into typed GameState
  const playerData = raw.players[playerId] ?? {
    playerId,
    solaris: 0,
    power: { produced: 0, consumed: 0, ratio: 1.0 },
    techLevel: 0,
    units: [],
    buildings: [],
    ownedBuildingTypes: {},
    productionQueues: { building: [], infantry: [], vehicle: [] },
  };

  const player: PlayerState = {
    playerId,
    solaris: playerData.solaris,
    power: playerData.power,
    techLevel: playerData.techLevel,
    units: playerData.units as UnitInfo[],
    buildings: playerData.buildings as BuildingInfo[],
    productionQueues: playerData.productionQueues,
    ownedBuildingTypes: new Map(Object.entries(playerData.ownedBuildingTypes as Record<string, number>)),
  };

  const enemies: PlayerState[] = [];
  for (const [pid, pdata] of Object.entries(raw.players)) {
    const id = Number(pid);
    if (id === playerId) continue;
    const pd = pdata as any;
    enemies.push({
      playerId: id,
      solaris: pd.solaris,
      power: pd.power,
      techLevel: pd.techLevel,
      units: pd.units as UnitInfo[],
      buildings: pd.buildings as BuildingInfo[],
      productionQueues: pd.productionQueues,
      ownedBuildingTypes: new Map(Object.entries(pd.ownedBuildingTypes as Record<string, number>)),
    });
  }

  return {
    tick: raw.tick,
    player,
    enemies,
    confidence: 1.0,
    events: raw.events as GameEvent[],
  };
}
