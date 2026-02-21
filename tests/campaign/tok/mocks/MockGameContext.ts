import { createWorld } from 'bitecs';
import { vi } from 'vitest';

import type { GameContext } from '../../../../src/core/GameContext';
import { buildStringTable } from '../../../../src/campaign/scripting/tok/TokStringTable';
import {
  addComponent,
  addEntity,
  BuildingType,
  Health,
  MoveTarget,
  Owner,
  Position,
  UnitType,
} from '../../../../src/core/ECS';

export interface MockCtx extends GameContext {
  __spawns: {
    units: number[];
    buildings: number[];
  };
}

export function createMockCtx(): MockCtx {
  const world = createWorld();

  const unitTypeIdMap = new Map<string, number>();
  const unitTypeNames: string[] = [];
  const buildingTypeIdMap = new Map<string, number>();
  const buildingTypeNames: string[] = [];

  const tokStrings = buildStringTable(null as any);
  for (let i = 0; i < tokStrings.length; i++) {
    const name = tokStrings[i];
    if (i <= 32 || i >= 111) {
      if (!buildingTypeIdMap.has(name)) {
        buildingTypeIdMap.set(name, buildingTypeNames.length);
        buildingTypeNames.push(name);
      }
    } else {
      if (!unitTypeIdMap.has(name)) {
        unitTypeIdMap.set(name, unitTypeNames.length);
        unitTypeNames.push(name);
      }
    }
  }

  if (!buildingTypeIdMap.has('ATConYard')) {
    buildingTypeIdMap.set('ATConYard', buildingTypeNames.length);
    buildingTypeNames.push('ATConYard');
  }
  if (!unitTypeIdMap.has('MCV')) {
    unitTypeIdMap.set('MCV', unitTypeNames.length);
    unitTypeNames.push('MCV');
  }

  const solaris = new Map<number, number>();
  const typeRegistry = {
    unitTypeIdMap,
    unitTypeNames,
    buildingTypeIdMap,
    buildingTypeNames,
    armourIdMap: new Map<string, number>([['None', 0]]),
  };

  const gameRules: any = {
    general: {},
    spiceMound: {},
    houseTypes: ['Atreides', 'Harkonnen'],
    terrainTypes: ['Sand', 'Rock'],
    armourTypes: ['None'],
    units: new Map<string, any>(),
    buildings: new Map<string, any>(),
    turrets: new Map(),
    bullets: new Map(),
    warheads: new Map(),
  };

  for (const unitName of unitTypeNames) {
    gameRules.units.set(unitName, {
      name: unitName,
      health: 100,
      deploysTo: unitName === 'MCV' ? 'ATConYard' : undefined,
    });
  }
  for (const buildingName of buildingTypeNames) {
    gameRules.buildings.set(buildingName, {
      name: buildingName,
      health: 1000,
    });
  }

  const ctx = {
    game: {
      getWorld: () => world,
    },

    gameRules,
    artMap: new Map(),
    typeRegistry,
    house: { prefix: 'AT', displayName: 'Atreides' },
    opponents: [],
    totalPlayers: 2,
    activeMissionConfig: null,
    activeMapId: 'mock_map',
    mapMetadata: {
      spawnPoints: [{ x: 10, z: 10 }, { x: 60, z: 60 }],
      scriptPoints: new Array(24).fill(null),
      entrances: [
        { marker: 0, x: 5, z: 5 },
        { marker: 1, x: 60, z: 5 },
        { marker: 99, x: 5, z: 60 },
      ],
      spiceFields: [],
      aiWaypoints: [],
    },
    missionRuntime: null,

    scene: {
      panTo: vi.fn(),
    },
    terrain: {
      getMapWidth: () => 64,
      getMapHeight: () => 64,
      getTerrainType: () => 0,
    },
    input: {
      setEnabled: vi.fn(),
    },
    modelManager: {},
    unitRenderer: {},
    selectionManager: {
      setEnabled: vi.fn(),
    },
    commandManager: {
      setEnabled: vi.fn(),
    },
    pathfinder: {},
    asyncPathfinder: {},
    movement: {},
    combatSystem: {
      setAttackMove: vi.fn(),
    },
    harvestSystem: {
      getSolaris: vi.fn((playerId: number) => solaris.get(playerId) ?? 0),
      addSolaris: vi.fn((playerId: number, amount: number) => {
        solaris.set(playerId, (solaris.get(playerId) ?? 0) + amount);
      }),
    },
    productionSystem: {},
    minimapRenderer: {
      setRadarActive: vi.fn(),
    },
    fogOfWar: {
      isTileVisible: vi.fn(() => true),
      revealWorldArea: vi.fn(),
    },
    effectsManager: {
      spawnCrate: vi.fn(),
    },
    damageNumbers: {},
    sandwormSystem: {
      deployThumper: vi.fn(),
    },
    abilitySystem: {},
    superweaponSystem: {
      fire: vi.fn(),
    },
    wallSystem: {},
    audioManager: {},
    buildingPlacement: {},
    victorySystem: {
      forceVictory: vi.fn(),
      forceDefeat: vi.fn(),
      setVictoryCondition: vi.fn(),
    },
    gameStats: {},
    selectionPanel: {
      addMessage: vi.fn(),
    },
    sidebar: {},
    iconRenderer: {},
    aiPlayers: [],

    missionScriptRunner: null,

    aircraftAmmo: new Map(),
    rearmingAircraft: new Set(),
    descendingUnits: new Map(),
    dyingTilts: new Map(),
    processedDeaths: new Set(),
    deferredActions: [],
    repairingBuildings: new Set(),
    groundSplats: [],
    bloomMarkers: new Map(),
    activeCrates: new Map(),
    nextCrateId: 1,
    stormWaitTimer: 0,
    activeStormListener: null,

    spawnUnit: (_w: any, typeName: string, owner: number, x: number, z: number) =>
      spawnMockUnit(ctx as any, typeName, owner, x, z),
    spawnBuilding: (_w: any, typeName: string, owner: number, x: number, z: number) =>
      spawnMockBuilding(ctx as any, typeName, owner, x, z),
    sellBuilding: vi.fn((eid: number) => {
      Health.current[eid] = 0;
    }),
    repairBuilding: vi.fn(),
    tickRepairs: vi.fn(),
    findRefinery: vi.fn(() => null),
    findNearestLandingPad: vi.fn(() => null),
    deferAction: vi.fn(),

    buildSaveData: vi.fn(),
    saveGame: vi.fn(),

    hashTracker: {},
    replayRecorder: {},
    replayPlayer: {},

    pushGameEvent: vi.fn(),
    updateSpeedIndicator: vi.fn(),

    MAX_AMMO: 8,

    __spawns: {
      units: [],
      buildings: [],
    },
  } as unknown as MockCtx;

  return ctx;
}

export function spawnMockUnit(ctx: GameContext, typeName: string, owner: number, x: number, z: number): number {
  const world = ctx.game.getWorld();
  const eid = addEntity(world);

  addComponent(world, Position, eid);
  addComponent(world, Health, eid);
  addComponent(world, Owner, eid);
  addComponent(world, UnitType, eid);
  addComponent(world, MoveTarget, eid);

  Position.x[eid] = x;
  Position.y[eid] = 0;
  Position.z[eid] = z;

  Health.current[eid] = 100;
  Health.max[eid] = 100;

  Owner.playerId[eid] = owner;
  UnitType.id[eid] = ctx.typeRegistry.unitTypeIdMap.get(typeName) ?? 0;

  MoveTarget.x[eid] = x;
  MoveTarget.z[eid] = z;
  MoveTarget.active[eid] = 0;

  (ctx as MockCtx).__spawns.units.push(eid);
  return eid;
}

export function spawnMockBuilding(ctx: GameContext, typeName: string, owner: number, x: number, z: number): number {
  const world = ctx.game.getWorld();
  const eid = addEntity(world);

  addComponent(world, Position, eid);
  addComponent(world, Health, eid);
  addComponent(world, Owner, eid);
  addComponent(world, BuildingType, eid);

  Position.x[eid] = x;
  Position.y[eid] = 0;
  Position.z[eid] = z;

  Health.current[eid] = 1000;
  Health.max[eid] = 1000;

  Owner.playerId[eid] = owner;
  BuildingType.id[eid] = ctx.typeRegistry.buildingTypeIdMap.get(typeName) ?? 0;

  (ctx as MockCtx).__spawns.buildings.push(eid);
  return eid;
}
