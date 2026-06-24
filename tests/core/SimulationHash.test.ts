import { describe, it, expect } from 'vitest';
import { createWorld } from 'bitecs';
import { SimulationHashTracker, computeSimulationHash } from '../../src/core/SimulationHash';
import {
  addComponent,
  addEntity,
  AttackTarget,
  BuildingType,
  Combat,
  Health,
  Owner,
  Position,
  Rotation,
  TurretRotation,
  UnitType,
} from '../../src/core/ECS';

type World = ReturnType<typeof createWorld>;

/** A turreted building (e.g. a gun turret): has combat, turret aim, and a target. */
function spawnTurretBuilding(world: World): number {
  const eid = addEntity(world);
  for (const c of [Position, BuildingType, Owner, Health, Rotation, Combat, TurretRotation, AttackTarget]) {
    addComponent(world, c, eid);
  }
  Position.x[eid] = 30; Position.z[eid] = 30;
  Health.current[eid] = 400; Health.max[eid] = 400;
  Owner.playerId[eid] = 1;
  return eid;
}

function spawnTurretedUnit(world: World): number {
  const eid = addEntity(world);
  for (const c of [Position, UnitType, Owner, Health, Rotation, Combat, TurretRotation]) {
    addComponent(world, c, eid);
  }
  Position.x[eid] = 10; Position.z[eid] = 10;
  Health.current[eid] = 100; Health.max[eid] = 100;
  Owner.playerId[eid] = 0;
  return eid;
}

describe('SimulationHashTracker', () => {
  it('records and retrieves hashes', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 0xDEADBEEF);
    tracker.record(50, 0xCAFEBABE);

    expect(tracker.getHash(25)).toBe(0xDEADBEEF);
    expect(tracker.getHash(50)).toBe(0xCAFEBABE);
    expect(tracker.getHash(75)).toBeNull();
  });

  it('returns null for unrecorded ticks', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 0x12345678);
    expect(tracker.getHash(10)).toBeNull(); // Not recorded
    expect(tracker.getHash(25)).toBe(0x12345678);
  });

  it('handles non-contiguous tick numbers (every 25 ticks)', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(0, 100);
    tracker.record(25, 200);
    tracker.record(50, 300);

    expect(tracker.getHash(0)).toBe(100);
    expect(tracker.getHash(25)).toBe(200);
    expect(tracker.getHash(50)).toBe(300);
    expect(tracker.getHash(1)).toBeNull(); // Not a recorded tick
    expect(tracker.getHash(26)).toBeNull();
  });

  it('evicts old entries beyond maxAge', () => {
    const tracker = new SimulationHashTracker(100); // maxAge=100 ticks
    tracker.record(0, 100);
    tracker.record(25, 200);
    tracker.record(50, 300);
    tracker.record(75, 400);
    tracker.record(100, 500); // Tick 0 should be evicted (100 - 0 >= 100)

    expect(tracker.getHash(0)).toBeNull(); // Evicted
    expect(tracker.getHash(100)).toBe(500);
  });

  it('verifies matching hashes', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 0xABCD);

    expect(tracker.verify(25, 0xABCD)).toBe('match');
    expect(tracker.verify(25, 0x1234)).toBe('mismatch');
    expect(tracker.verify(99, 0xABCD)).toBe('unavailable');
  });

  it('tracks latest tick', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 100);
    expect(tracker.getLatestTick()).toBe(25);
    tracker.record(50, 200);
    expect(tracker.getLatestTick()).toBe(50);
  });

  it('resets cleanly', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 0xABCD);
    tracker.reset();
    expect(tracker.getHash(25)).toBeNull();
  });
});

describe('computeSimulationHash field coverage', () => {
  it('is stable when nothing changes', () => {
    const world = createWorld();
    spawnTurretBuilding(world);
    spawnTurretedUnit(world);
    expect(computeSimulationHash(world)).toBe(computeSimulationHash(world));
  });

  it('reflects a building turret rotation change', () => {
    const world = createWorld();
    const bld = spawnTurretBuilding(world);
    TurretRotation.y[bld] = 0;
    const before = computeSimulationHash(world);
    TurretRotation.y[bld] = 1.5; // turret swivels — same everything else
    expect(computeSimulationHash(world)).not.toBe(before);
  });

  it('reflects a building fire timer change', () => {
    const world = createWorld();
    const bld = spawnTurretBuilding(world);
    Combat.fireTimer[bld] = 0;
    const before = computeSimulationHash(world);
    Combat.fireTimer[bld] = 12;
    expect(computeSimulationHash(world)).not.toBe(before);
  });

  it('reflects a building attack-target change', () => {
    const world = createWorld();
    const bld = spawnTurretBuilding(world);
    AttackTarget.active[bld] = 1; AttackTarget.entityId[bld] = 7;
    const before = computeSimulationHash(world);
    AttackTarget.entityId[bld] = 99;
    expect(computeSimulationHash(world)).not.toBe(before);
  });

  it('reflects a unit body rotation change', () => {
    const world = createWorld();
    const unit = spawnTurretedUnit(world);
    Rotation.y[unit] = 0;
    const before = computeSimulationHash(world);
    Rotation.y[unit] = 2.0;
    expect(computeSimulationHash(world)).not.toBe(before);
  });

  it('reflects a unit turret rotation change', () => {
    const world = createWorld();
    const unit = spawnTurretedUnit(world);
    TurretRotation.y[unit] = 0;
    const before = computeSimulationHash(world);
    TurretRotation.y[unit] = 0.75;
    expect(computeSimulationHash(world)).not.toBe(before);
  });
});
