import { describe, expect, it } from 'vitest';
import { createWorld } from 'bitecs';

import { SuperweaponSystem } from '../../src/simulation/SuperweaponSystem';
import {
  addComponent,
  addEntity,
  BuildingType,
  Health,
  Owner,
  Position,
  UnitType,
} from '../../src/core/ECS';

type World = ReturnType<typeof createWorld>;

function spawnBuilding(world: World, owner: number, x: number, z: number, hp = 500): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, BuildingType, eid);
  addComponent(world, Owner, eid);
  addComponent(world, Health, eid);
  Position.x[eid] = x; Position.y[eid] = 0; Position.z[eid] = z;
  Owner.playerId[eid] = owner;
  Health.current[eid] = hp; Health.max[eid] = 500;
  return eid;
}

function spawnUnit(world: World, owner: number, x: number, z: number, hp = 100): number {
  const eid = addEntity(world);
  addComponent(world, Position, eid);
  addComponent(world, UnitType, eid);
  addComponent(world, Owner, eid);
  addComponent(world, Health, eid);
  Position.x[eid] = x; Position.y[eid] = 0; Position.z[eid] = z;
  Owner.playerId[eid] = owner;
  Health.current[eid] = hp; Health.max[eid] = 100;
  return eid;
}

const AI = 1;
const ENEMY = 0;

describe('SuperweaponSystem.pickAiTarget', () => {
  it('targets the densest cluster of enemy buildings', () => {
    const world = createWorld();
    // A 3-building cluster around (60,60) and a lone building far away.
    spawnBuilding(world, ENEMY, 60, 60);
    spawnBuilding(world, ENEMY, 62, 61);
    spawnBuilding(world, ENEMY, 61, 63);
    spawnBuilding(world, ENEMY, 200, 200);
    // AI's own building must not be targeted.
    spawnBuilding(world, AI, 61, 61);

    const target = SuperweaponSystem.pickAiTarget(world, AI);
    expect(target).not.toBeNull();
    // Cluster centre is one of the three clustered buildings (x in 60..62).
    expect(target!.x).toBeGreaterThanOrEqual(60);
    expect(target!.x).toBeLessThanOrEqual(62);
  });

  it('falls back to enemy units when the enemy has no buildings (the bug)', () => {
    const world = createWorld();
    // Enemy lost all buildings but keeps a unit cluster near (40,40).
    spawnUnit(world, ENEMY, 40, 40);
    spawnUnit(world, ENEMY, 41, 41);
    // AI owns a building (its own palace) — must be ignored as a target.
    spawnBuilding(world, AI, 300, 300);

    const target = SuperweaponSystem.pickAiTarget(world, AI);
    // Before the fix this returned null and the AI never fired its superweapon.
    expect(target).not.toBeNull();
    expect(target!.x).toBeGreaterThanOrEqual(40);
    expect(target!.x).toBeLessThanOrEqual(41);
  });

  it('prefers buildings over units when both exist', () => {
    const world = createWorld();
    spawnBuilding(world, ENEMY, 80, 80);
    spawnUnit(world, ENEMY, 10, 10);

    const target = SuperweaponSystem.pickAiTarget(world, AI);
    expect(target).not.toBeNull();
    expect(target!.x).toBe(80);
    expect(target!.z).toBe(80);
  });

  it('ignores off-map passengers and dead enemy units', () => {
    const world = createWorld();
    spawnUnit(world, ENEMY, -999, -999);     // parked transport passenger
    spawnUnit(world, ENEMY, 50, 50, 0);      // dead (hp 0)

    const target = SuperweaponSystem.pickAiTarget(world, AI);
    expect(target).toBeNull();
  });

  it('returns null when the enemy has no surviving targets', () => {
    const world = createWorld();
    spawnBuilding(world, AI, 100, 100);      // only the AI's own building exists
    const target = SuperweaponSystem.pickAiTarget(world, AI);
    expect(target).toBeNull();
  });
});
