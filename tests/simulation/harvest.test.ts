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
  BuildingType,
  Combat,
  Harvester,
  Health,
  MoveTarget,
  Owner,
  Position,
} from '../../src/core/ECS';

// Harvester states (mirror the private constants in HarvestSystem)
const IDLE = 0;
const HARVESTING = 2;
const RETURNING = 3;
const UNLOADING = 4;

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

  it('clears flee state on death so a recycled harvester id can flee again', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    const harvester = spawnHarvester(world, 1, 50, 50);
    harvest.update(world, 0); // register

    // Damage below 50% -> flee. The entity is now tracked in `fleeing`.
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

    // The harvester is destroyed. update() runs the death-cleanup branch, which
    // must drop the stale flee entry (the flee timer is still ~250 ticks out).
    Health.current[harvester] = 0;
    harvest.update(world, 0);

    // Simulate the id being recycled into a brand-new harvester: same entity id,
    // alive again, back to harvesting. Without the death-branch cleanup, the
    // stale flee entry survives (id never left harvestQuery) and the debounce
    // would block this fresh harvester from ever fleeing.
    Health.current[harvester] = 1000;
    Harvester.state[harvester] = HARVESTING;
    harvest.update(world, 0); // re-register the "new" harvester

    Harvester.state[harvester] = HARVESTING;
    Health.current[harvester] = 400; // damaged below 50% again
    hit();

    expect(Harvester.state[harvester]).toBe(RETURNING);
  });

  it('resumes a ground return when carryall support is lost mid-airlift', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    const harvester = spawnHarvester(world, 1, 50, 50);
    Harvester.state[harvester] = RETURNING;
    harvest.setCarryallAvailable(1, true);

    // First tick: airlift begins — ground movement is stopped and the unit is
    // tracked as airborne.
    harvest.update(world, 0);
    expect(harvest.getAirliftingEntities().has(harvester)).toBe(true);
    expect(MoveTarget.active[harvester]).toBe(0);

    // A couple more ticks of airlift: it rises off the ground.
    harvest.update(world, 0);
    harvest.update(world, 0);
    expect(Position.y[harvester]).toBeGreaterThan(0.1);
    expect(Harvester.state[harvester]).toBe(RETURNING);

    // The owner's Hanger is destroyed mid-flight -> carryall support is revoked.
    harvest.setCarryallAvailable(1, false);
    harvest.update(world, 0);

    // It must NOT teleport-unload from its in-air position. Instead it drops the
    // airlift, returns to the ground, and resumes a normal ground return.
    expect(Harvester.state[harvester]).not.toBe(UNLOADING);
    expect(Harvester.state[harvester]).toBe(RETURNING);
    expect(harvest.getAirliftingEntities().has(harvester)).toBe(false);
    expect(Position.y[harvester]).toBeCloseTo(0.1, 5);
    expect(MoveTarget.active[harvester]).toBe(1);
  });

  it('does not flee a harvester sitting idle below 50% until it is hit', () => {
    // Guards the IDLE/flee interaction: handleIdle must not be short-circuited by
    // a phantom flee flag (regression companion to the recycle-cleanup fix).
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);

    const harvester = spawnHarvester(world, 1, 50, 50);
    Harvester.state[harvester] = IDLE;
    Health.current[harvester] = 400;
    harvest.update(world, 0);

    // No hit emitted -> never marked fleeing -> stays eligible to act on IDLE.
    expect(Harvester.state[harvester]).not.toBe(RETURNING);
  });
});

describe('HarvestSystem refinery ownership', () => {
  beforeEach(() => {
    EventBus.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).document = { getElementById: () => null };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).document;
  });

  // Spawn a refinery building: BuildingType.id 0 -> name 'ATRefinery' (contains "Refinery").
  function spawnRefinery(world: TestWorld, owner: number, x: number, z: number): number {
    const eid = addEntity(world);
    addComponent(world, Position, eid);
    addComponent(world, Health, eid);
    addComponent(world, Owner, eid);
    addComponent(world, BuildingType, eid);
    Position.x[eid] = x;
    Position.z[eid] = z;
    Health.max[eid] = 2000;
    Health.current[eid] = 2000;
    Owner.playerId[eid] = owner;
    BuildingType.id[eid] = 0;
    return eid;
  }

  it('retasks a harvester to a surviving own refinery after its refinery is captured', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);
    harvest.setBuildingContext(world, ['ATRefinery']);

    const refA = spawnRefinery(world, 0, 40, 40);
    const refB = spawnRefinery(world, 0, 80, 80);
    const harvester = spawnHarvester(world, 0, 41, 41);
    Harvester.refineryEntity[harvester] = refA;
    Harvester.spiceCarried[harvester] = 5;
    Harvester.state[harvester] = UNLOADING;

    // Baseline: while the harvester still owns refA it stays assigned to it.
    harvest.update(world, 0);
    expect(Harvester.refineryEntity[harvester]).toBe(refA);

    // Enemy engineer captures refA in place: Owner flips, eid unchanged, no event.
    Owner.playerId[refA] = 1;
    harvest.update(world, 0);

    // The harvester must abandon the now-enemy refinery and retask to its own refB.
    // Before the owner check it stayed bound to refA (captured) indefinitely.
    expect(Harvester.refineryEntity[harvester]).toBe(refB);
  });

  it('goes idle when its only refinery is captured and no own refinery remains', () => {
    const world = createWorld();
    const harvest = new HarvestSystem(makeMockTerrain());
    harvest.init(world);
    harvest.setBuildingContext(world, ['ATRefinery']);

    const refA = spawnRefinery(world, 0, 40, 40);
    const harvester = spawnHarvester(world, 0, 41, 41);
    Harvester.refineryEntity[harvester] = refA;
    Harvester.spiceCarried[harvester] = 5;
    Harvester.state[harvester] = UNLOADING;

    Owner.playerId[refA] = 1; // captured — no other own refinery exists
    harvest.update(world, 0);

    expect(Harvester.state[harvester]).toBe(IDLE);
  });
});
