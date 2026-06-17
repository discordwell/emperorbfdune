import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorld } from 'bitecs';

import { HarvestSystem } from '../../src/simulation/HarvestSystem';
import { CombatSystem } from '../../src/simulation/CombatSystem';
import type { GameRules } from '../../src/config/RulesParser';
import type { TerrainRenderer } from '../../src/rendering/TerrainRenderer';
import { EventBus } from '../../src/core/EventBus';
import {
  addComponent,
  addEntity,
  AttackTarget,
  Combat,
  Harvester,
  Health,
  Owner,
  Position,
} from '../../src/core/ECS';

// Harvester states (mirror the private constants in HarvestSystem)
const HARVESTING = 2;
const RETURNING = 3;

type TestWorld = ReturnType<typeof createWorld>;

/** Minimal terrain stub — HarvestSystem.update() only needs map dims + spice queries. */
function makeMockTerrain(): TerrainRenderer {
  return {
    getMapWidth: () => 32,
    getMapHeight: () => 32,
    getTerrainType: () => 0, // Sand
    getSpice: () => 0,
    setSpice: () => {},
    updateSpiceVisuals: () => {},
    isPassable: () => true,
  } as unknown as TerrainRenderer;
}

function makeRules(): GameRules {
  return {
    general: {},
    spiceMound: {},
    houseTypes: [],
    terrainTypes: [],
    armourTypes: ['None'],
    units: new Map(),
    buildings: new Map(),
    turrets: new Map(),
    bullets: new Map(),
    warheads: new Map(),
  } as unknown as GameRules;
}

function spawnHarvester(world: TestWorld, owner: number, x: number, z: number): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, Health, eid);
  addComponent(world, Owner, eid);
  addComponent(world, Harvester, eid);
  Position.x[eid] = x;
  Position.y[eid] = 0;
  Position.z[eid] = z;
  Health.max[eid] = 1000;
  Health.current[eid] = 1000;
  Owner.playerId[eid] = owner;
  Harvester.state[eid] = HARVESTING;
  Harvester.refineryEntity[eid] = 0; // no refinery — returnToRefinery falls back to map center
  return eid;
}

describe('HarvestSystem flee-on-damage', () => {
  beforeEach(() => {
    EventBus.clear();
    // HarvestSystem.update() touches document for the HUD counters; stub it away.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).document = { getElementById: () => null };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).document;
  });

  it('flees an AI-owned harvester damaged below 50% (combat:hit is owner-agnostic)', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    const harvester = spawnHarvester(world, 1 /* AI player */, 50, 50);
    harvest.update(world, 0); // register harvester in knownHarvesters

    Harvester.state[harvester] = HARVESTING;
    Health.current[harvester] = 400; // 40% of 1000

    EventBus.emit('combat:hit', {
      entityId: harvester,
      x: 50,
      z: 50,
      damage: 100,
      targetOwner: 1,
      attackerOwner: 0,
    });

    expect(Harvester.state[harvester]).toBe(RETURNING);
  });

  it('does not flee on a glancing hit that leaves health above 50%', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    const harvester = spawnHarvester(world, 1, 50, 50);
    harvest.update(world, 0);

    Harvester.state[harvester] = HARVESTING;
    Health.current[harvester] = 800; // 80% — above the 50% flee threshold

    EventBus.emit('combat:hit', {
      entityId: harvester,
      x: 50,
      z: 50,
      damage: 100,
      targetOwner: 1,
      attackerOwner: 0,
    });

    expect(Harvester.state[harvester]).toBe(HARVESTING);
  });

  it('still flees the local player’s harvester (no regression)', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    const harvester = spawnHarvester(world, 0 /* local player */, 50, 50);
    harvest.update(world, 0);

    Harvester.state[harvester] = HARVESTING;
    Health.current[harvester] = 400;

    EventBus.emit('combat:hit', {
      entityId: harvester,
      x: 50,
      z: 50,
      damage: 100,
      targetOwner: 0,
      attackerOwner: 1,
    });

    expect(Harvester.state[harvester]).toBe(RETURNING);
  });

  it('ignores combat:hit for non-harvester entities', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    const harvester = spawnHarvester(world, 1, 50, 50);
    harvest.update(world, 0);

    Harvester.state[harvester] = HARVESTING;
    Health.current[harvester] = 400;

    // A hit on some unrelated entity id must not move our harvester.
    EventBus.emit('combat:hit', {
      entityId: harvester + 999,
      x: 0,
      z: 0,
      damage: 100,
      targetOwner: 1,
      attackerOwner: 0,
    });

    expect(Harvester.state[harvester]).toBe(HARVESTING);
  });

  it('does not re-trigger flee while already fleeing (debounce)', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    const harvester = spawnHarvester(world, 1, 50, 50);
    harvest.update(world, 0);

    Harvester.state[harvester] = HARVESTING;
    Health.current[harvester] = 400;

    const hit = () =>
      EventBus.emit('combat:hit', {
        entityId: harvester,
        x: 50,
        z: 50,
        damage: 100,
        targetOwner: 1,
        attackerOwner: 0,
      });

    hit();
    expect(Harvester.state[harvester]).toBe(RETURNING);

    // While fleeing, a second hit must be a no-op: forcing the harvester back to
    // HARVESTING and hitting again should NOT immediately re-issue a return order.
    Harvester.state[harvester] = HARVESTING;
    hit();
    expect(Harvester.state[harvester]).toBe(HARVESTING);
  });

  it('ignores hits on a harvester that is already returning', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    const harvester = spawnHarvester(world, 1, 50, 50);
    harvest.update(world, 0);

    Harvester.state[harvester] = RETURNING; // already heading home
    Health.current[harvester] = 100; // very low, but the guard should short-circuit

    EventBus.emit('combat:hit', {
      entityId: harvester,
      x: 50,
      z: 50,
      damage: 100,
      targetOwner: 1,
      attackerOwner: 0,
    });

    expect(Harvester.state[harvester]).toBe(RETURNING);
  });

  it('end-to-end: an AI harvester shot by CombatSystem.update() flees', () => {
    const world = createWorld();
    const combat = new CombatSystem(makeRules());
    combat.init(world);
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    // AI harvester (player 2), already below half health so one shot keeps it there.
    const harvester = spawnHarvester(world, 2, 60, 60);
    Health.current[harvester] = 400;

    // Attacker owned by a *different* AI (player 1) — proves the trigger is not
    // limited to the local player on either side.
    const attacker = addEntity(world);
    addComponent(world, Position, attacker);
    addComponent(world, Health, attacker);
    addComponent(world, Owner, attacker);
    addComponent(world, Combat, attacker);
    addComponent(world, AttackTarget, attacker);
    Position.x[attacker] = 61;
    Position.z[attacker] = 61;
    Health.max[attacker] = 200;
    Health.current[attacker] = 200;
    Owner.playerId[attacker] = 1;
    AttackTarget.entityId[attacker] = harvester;
    AttackTarget.active[attacker] = 1;
    Combat.attackRange[attacker] = 25;
    Combat.fireTimer[attacker] = 0;
    Combat.rof[attacker] = 7;

    harvest.update(world, 0); // register the harvester
    Harvester.state[harvester] = HARVESTING;
    Health.current[harvester] = 400;

    combat.update(world, 0); // attacker fires -> combat:hit(entityId=harvester) -> flee

    expect(Health.current[harvester]).toBeLessThan(400); // actually took damage
    expect(Harvester.state[harvester]).toBe(RETURNING); // and fled
  });
});
