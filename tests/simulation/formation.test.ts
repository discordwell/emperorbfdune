import { describe, it, expect } from 'vitest';
import { createWorld } from 'bitecs';

import { FormationSystem } from '../../src/simulation/FormationSystem';
import {
  addComponent,
  addEntity,
  AttackTarget,
  Health,
  MoveTarget,
  Speed,
} from '../../src/core/ECS';

type TestWorld = ReturnType<typeof createWorld>;

/** Spawn a moving unit eligible to stay in a formation (alive, moving, not in combat). */
function spawnUnit(world: TestWorld, maxSpeed: number): number {
  const eid = addEntity(world);
  addComponent(world, Health, eid);
  addComponent(world, MoveTarget, eid);
  addComponent(world, AttackTarget, eid);
  addComponent(world, Speed, eid);
  Health.max[eid] = 100;
  Health.current[eid] = 100;
  MoveTarget.active[eid] = 1; // actively moving toward the formation target
  AttackTarget.active[eid] = 0; // not engaged
  Speed.max[eid] = maxSpeed;
  return eid;
}

describe('FormationSystem speed cap', () => {
  it('caps the formation to its slowest member at creation', () => {
    const world = createWorld();
    const fs = new FormationSystem();

    const fast = spawnUnit(world, 10);
    const slow = spawnUnit(world, 3);
    const medium = spawnUnit(world, 6);

    fs.createFormation([fast, slow, medium], 50, 50);

    // Every member is held to the slowest unit's speed so they travel together.
    expect(fs.getFormationSpeedCap(fast)).toBe(3);
    expect(fs.getFormationSpeedCap(medium)).toBe(3);
    expect(fs.getFormationSpeedCap(slow)).toBe(3);
  });

  it('raises the cap when the slowest member dies (pruned by update)', () => {
    const world = createWorld();
    const fs = new FormationSystem();

    const fast = spawnUnit(world, 10);
    const slow = spawnUnit(world, 3);
    const medium = spawnUnit(world, 6);

    fs.createFormation([fast, slow, medium], 50, 50);
    expect(fs.getFormationSpeedCap(fast)).toBe(3);

    // The slow unit dies; update() prunes it and must recompute the cap.
    Health.current[slow] = 0;
    fs.update(world);

    // Survivors are now bottlenecked by the medium unit, not the dead one.
    expect(fs.getFormationSpeedCap(fast)).toBe(6);
    expect(fs.getFormationSpeedCap(medium)).toBe(6);
    // The dead unit is no longer tracked.
    expect(fs.isInFormation(slow)).toBe(false);
  });

  it('raises the cap when the slowest member breaks off for combat', () => {
    const world = createWorld();
    const fs = new FormationSystem();

    const fast = spawnUnit(world, 9);
    const slow = spawnUnit(world, 2);
    const medium = spawnUnit(world, 5);

    fs.createFormation([fast, slow, medium], 20, 20);
    expect(fs.getFormationSpeedCap(fast)).toBe(2);

    // The slow unit engages an enemy and leaves the formation.
    fs.breakFormationForCombat(slow);

    expect(fs.getFormationSpeedCap(fast)).toBe(5);
    expect(fs.getFormationSpeedCap(medium)).toBe(5);
  });

  it('keeps the cap unchanged while every member is still present', () => {
    const world = createWorld();
    const fs = new FormationSystem();

    const fast = spawnUnit(world, 8);
    const slow = spawnUnit(world, 4);

    fs.createFormation([fast, slow], 10, 10);
    expect(fs.getFormationSpeedCap(fast)).toBe(4);

    // Nobody died/arrived/engaged — the slowest unit still bounds the group.
    fs.update(world);
    expect(fs.getFormationSpeedCap(fast)).toBe(4);
  });

  it('does not change the cap of a non-slowest member that leaves', () => {
    const world = createWorld();
    const fs = new FormationSystem();

    const fast = spawnUnit(world, 10);
    const slow = spawnUnit(world, 3);
    const medium = spawnUnit(world, 6);

    fs.createFormation([fast, slow, medium], 50, 50);
    expect(fs.getFormationSpeedCap(slow)).toBe(3);

    // The fast unit (not the bottleneck) leaves — cap stays at the slow unit.
    fs.breakFormationForCombat(fast);
    expect(fs.getFormationSpeedCap(slow)).toBe(3);
    expect(fs.getFormationSpeedCap(medium)).toBe(3);
  });
});
