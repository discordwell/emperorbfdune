import { describe, it, expect } from 'vitest';
import { createWorld } from 'bitecs';

import { buildSaveData } from '../../src/core/SaveLoadSystem';
import {
  addComponent,
  addEntity,
  Health,
  Owner,
  Position,
  UnitType,
} from '../../src/core/ECS';

/**
 * Regression test for the transport-passenger save/load duplication bug.
 *
 * Units riding a transport are parked off-map at (-999) but remain live ECS
 * entities, so they show up in unitQuery. buildSaveData also records them on
 * their transport via `passengerTypeIds`, and the restore path recreates them
 * from that list. Before the fix the parked passengers were *also* serialized as
 * standalone entities, so a save/load produced: (a) an orphaned ghost passenger
 * at (-999) belonging to no transport, and (b) a duplicate fresh passenger in
 * the APC. The fix skips current passengers in the standalone-unit save loop.
 */

const UNIT_NAMES = ['ATAPC', 'ATLightInf'];
const AT_APC = 0;
const AT_LIGHT_INF = 1;

function makeUnit(world: ReturnType<typeof createWorld>, typeId: number, owner: number, x: number, z: number): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, UnitType, eid);
  addComponent(world, Owner, eid);
  addComponent(world, Health, eid);
  Position.x[eid] = x;
  Position.z[eid] = z;
  Position.y[eid] = 0;
  UnitType.id[eid] = typeId;
  Owner.playerId[eid] = owner;
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  return eid;
}

function makeContext(
  world: ReturnType<typeof createWorld>,
  transportPassengers: Map<number, number[]>,
  activeCarryallEids: number[] = [],
) {
  return {
    game: { getWorld: () => world, getTickCount: () => 0 },
    typeRegistry: { unitTypeNames: UNIT_NAMES, buildingTypeNames: [] as string[] },
    totalPlayers: 2,
    activeMapId: null,
    activeMissionConfig: null,
    groundSplats: [] as unknown[],
    house: {
      prefix: 'AT', enemyPrefix: 'HK', name: 'Atreides', enemyName: 'Harkonnen',
      gameMode: 'skirmish', difficulty: 'normal', mapChoice: 0, skirmishOptions: {},
      opponents: [], campaignTerritoryId: undefined, subhouse: undefined,
    },
    abilitySystem: {
      getTransportPassengers: () => transportPassengers,
      getAbilityState: () => ({ deviated: [], leech: [], kobraDeployed: [], kobraBaseRange: [] }),
    },
    deliverySystem: { getActiveCarryallEids: () => activeCarryallEids },
    activeCrates: new Map<number, { x: number; z: number; type: string }>(),
    nextCrateId: 0,
    aircraftAmmo: new Map<number, number>(),
    combatSystem: {
      getStance: () => 1,
      getGuardPosition: () => null,
      isAttackMove: () => false,
      getAttackMoveDestination: () => null,
    },
    harvestSystem: { getSolaris: () => 0 },
    productionSystem: { getState: () => ({}) },
    fogOfWar: { getExploredData: () => [] },
    sandwormSystem: { serialize: () => ({ worms: [], tickCounter: 0, thumpers: [], attractSides: [], repelSides: [] }) },
    superweaponSystem: { getChargeState: () => ({}) },
    victorySystem: { getTickCounter: () => 0 },
    selectionManager: { getControlGroups: () => new Map() },
    terrain: { getMapWidth: () => 2, getMapHeight: () => 2, getSpice: () => 0 },
    missionScriptRunner: undefined,
  } as any;
}

describe('buildSaveData transport passengers', () => {
  it('does not serialize loaded passengers as standalone entities', () => {
    const world = createWorld();
    const apc = makeUnit(world, AT_APC, 0, 50, 50);
    // Two infantry currently riding the APC, parked off-map.
    const p1 = makeUnit(world, AT_LIGHT_INF, 0, -999, -999);
    const p2 = makeUnit(world, AT_LIGHT_INF, 0, -999, -999);
    const transportPassengers = new Map<number, number[]>([[apc, [p1, p2]]]);

    const save = buildSaveData(makeContext(world, transportPassengers));

    const unitEntities = save.entities.filter(e => e.unitTypeId !== undefined);
    // Only the APC is a standalone unit; the two passengers are carried by it.
    expect(unitEntities.length).toBe(1);

    const apcEntity = unitEntities[0];
    expect(apcEntity.unitTypeId).toBe(AT_APC);
    expect(apcEntity.passengerTypeIds).toEqual([AT_LIGHT_INF, AT_LIGHT_INF]);

    // No orphaned ghost parked at (-999) was written.
    expect(save.entities.some(e => e.x === -999)).toBe(false);
  });

  it('still saves free-standing infantry normally (not treated as passengers)', () => {
    const world = createWorld();
    const apc = makeUnit(world, AT_APC, 0, 50, 50);
    const free = makeUnit(world, AT_LIGHT_INF, 0, 30, 30); // walking around, not loaded
    const transportPassengers = new Map<number, number[]>([[apc, []]]);

    const save = buildSaveData(makeContext(world, transportPassengers));

    const unitEntities = save.entities.filter(e => e.unitTypeId !== undefined);
    expect(unitEntities.length).toBe(2); // APC + free infantry both saved
    expect(unitEntities.some(e => e.unitTypeId === AT_LIGHT_INF && e.x === 30)).toBe(true);
    void free;
  });

  it('does not serialize in-flight delivery Carryalls (throwaway animation entities)', () => {
    const world = createWorld();
    const tank = makeUnit(world, AT_APC, 0, 40, 40); // a normal owned unit
    // A delivery Carryall mid-flight: real unitQuery entity, Health 9999, tracked
    // only by DeliverySystem.
    const carryall = makeUnit(world, AT_LIGHT_INF, 0, 12, 12);
    Health.current[carryall] = 9999;
    Health.max[carryall] = 9999;

    const save = buildSaveData(makeContext(world, new Map(), [carryall]));

    const unitEntities = save.entities.filter(e => e.unitTypeId !== undefined);
    // Only the real tank is saved; the delivery Carryall is skipped so it can't be
    // restored as an immortal phantom.
    expect(unitEntities.length).toBe(1);
    expect(unitEntities.some(e => e.x === 12)).toBe(false);
    void tank;
  });
});
