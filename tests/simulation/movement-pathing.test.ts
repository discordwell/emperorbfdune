import { describe, it, expect } from 'vitest';
import { createWorld } from 'bitecs';

import { MovementSystem } from '../../src/simulation/MovementSystem';
import { PathfindingSystem } from '../../src/simulation/PathfindingSystem';
import { TerrainType } from '../../src/rendering/TerrainRenderer';
import {
  addComponent, addEntity,
  Position, Velocity, Speed, MoveTarget, Rotation, Health,
} from '../../src/core/ECS';

/**
 * Regression test for the path-discard bug in MovementSystem.
 *
 * When a unit is ordered to an IMPASSABLE tile (a building, rock, or — as here —
 * a cliff wall), PathfindingSystem.findPath remaps the destination to the nearest
 * passable tile and returns a real route to it. The old staleness check compared
 * the cached path's LAST WAYPOINT (that nearest-passable tile) against the raw
 * MoveTarget; when they were >2 units apart it deleted the path every tick. In
 * async mode (the default in real play) that meant the freshly-computed A* route
 * was thrown away before it was ever followed, and the unit perpetually chased a
 * straight-line stub at the unreachable point — jamming against the obstacle
 * instead of routing around it.
 *
 * The fix tracks the destination each path was REQUESTED for and only invalidates
 * when the commanded MoveTarget actually changes. This test drives a real
 * MovementSystem with an async pathfinder and asserts the unit routes around a
 * wall to the far side (only possible if the A* path is actually followed).
 */

const MAP = 24;

class MockTerrain {
  private data: TerrainType[];
  constructor() {
    this.data = new Array(MAP * MAP).fill(TerrainType.Sand);
  }
  getMapWidth(): number { return MAP; }
  getMapHeight(): number { return MAP; }
  getHeightAt(): number { return 0; }
  getTerrainType(tx: number, tz: number): TerrainType {
    if (tx < 0 || tx >= MAP || tz < 0 || tz >= MAP) return TerrainType.Cliff;
    return this.data[tz * MAP + tx];
  }
  setTile(tx: number, tz: number, type: TerrainType): void {
    if (tx >= 0 && tx < MAP && tz >= 0 && tz < MAP) this.data[tz * MAP + tx] = type;
  }
  isPassable(tx: number, tz: number): boolean {
    return this.getTerrainType(tx, tz) !== TerrainType.Cliff;
  }
  isPassableVehicle(tx: number, tz: number): boolean {
    const t = this.getTerrainType(tx, tz);
    return t !== TerrainType.Cliff && t !== TerrainType.InfantryRock;
  }
}

/** Stand-in for the Web Worker pathfinder — resolves with a real synchronous A* result. */
class MockAsyncPathfinder {
  constructor(private pf: PathfindingSystem) {}
  isWorkerAvailable(): boolean { return true; }
  findPathAsync(
    sx: number, sz: number, ex: number, ez: number,
    isVehicle: boolean, maxNodes = 3000,
  ): Promise<{ x: number; z: number }[] | null> {
    return Promise.resolve(this.pf.findPath(sx, sz, ex, ez, isVehicle, maxNodes));
  }
}

function spawnUnit(world: ReturnType<typeof createWorld>, x: number, z: number): number {
  const e = addEntity(world);
  addComponent(world, Position, e);
  addComponent(world, Velocity, e);
  addComponent(world, Speed, e);
  addComponent(world, MoveTarget, e);
  addComponent(world, Rotation, e);
  addComponent(world, Health, e);
  Position.x[e] = x; Position.z[e] = z; Position.y[e] = 0;
  Speed.max[e] = 24;          // ~0.96 world-units/tick after the 0.04 scaling
  Speed.acceleration[e] = 0;  // instant speed (no ramp) for a deterministic test
  Speed.turnRate[e] = 1.0;
  Speed.current[e] = 0;
  Health.current[e] = 100; Health.max[e] = 100;
  return e;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('MovementSystem path invalidation', () => {
  it('routes around a wall to reach an impassable target (does not discard the A* path)', async () => {
    const terrain = new MockTerrain();
    // A thick horizontal cliff wall: x=8..14, z=7..11. The wall is deep enough
    // BELOW the target that the target's nearest passable tile lies ABOVE it.
    for (let x = 8; x <= 14; x++) {
      for (let z = 7; z <= 11; z++) terrain.setTile(x, z, TerrainType.Cliff);
    }
    // Target tile (11,8) -> world (23,17). The full 3x3 around it is wall, so the
    // nearest passable tile is (11,6) -> world (23,13), two tiles ABOVE the wall.
    // That endpoint is 4 world units from the raw target in z, which is exactly
    // what made the old `|endpoint - target| > 2` check discard the path forever.

    const pf = new PathfindingSystem(terrain as any);
    const movement = new MovementSystem(pf);
    movement.setTerrain(terrain as any);
    movement.setMapBounds(MAP * 2, MAP * 2);
    movement.setAsyncPathfinder(new MockAsyncPathfinder(pf) as any);

    const world = createWorld();
    // Unit BELOW the wall at tile (11,13) -> world (23,27).
    const unit = spawnUnit(world, 23, 27);

    MoveTarget.x[unit] = 23;
    MoveTarget.z[unit] = 17; // impassable target buried in the wall
    MoveTarget.active[unit] = 1;

    // Run until the move completes (arrival clears MoveTarget.active) or budget.
    for (let t = 0; t < 400 && MoveTarget.active[unit] === 1; t++) {
      movement.update(world, 40);
      await flush(); // let the async path .then() install the real route
    }

    // With the fix the unit rounds an end of the wall, climbs ABOVE it to the
    // nearest passable tile, and the move COMPLETES (MoveTarget.active clears).
    // With the bug it beelines north at the buried target, jams against the
    // wall's bottom edge (z stays ~24), the freshly-computed A* route is
    // discarded every tick, and the move never completes.
    expect(MoveTarget.active[unit]).toBe(0); // arrived (bug: never arrives)
    expect(Position.z[unit]).toBeLessThan(14); // got above the wall (bug: ~24)
  });

  it('keeps following the path when the destination is unchanged', async () => {
    // A plain passable target: the path must NOT be torn down each tick.
    const terrain = new MockTerrain();
    const pf = new PathfindingSystem(terrain as any);
    const movement = new MovementSystem(pf);
    movement.setTerrain(terrain as any);
    movement.setMapBounds(MAP * 2, MAP * 2);
    movement.setAsyncPathfinder(new MockAsyncPathfinder(pf) as any);

    const world = createWorld();
    const unit = spawnUnit(world, 3, 3); // tile (1,1)

    MoveTarget.x[unit] = 41; // tile (20,1) -> world (41,3), passable
    MoveTarget.z[unit] = 3;
    MoveTarget.active[unit] = 1;

    for (let t = 0; t < 120 && MoveTarget.active[unit] === 1; t++) {
      movement.update(world, 40);
      await flush();
    }

    // The unit reaches the (passable) destination and the move completes.
    expect(MoveTarget.active[unit]).toBe(0);
    expect(Position.x[unit]).toBeGreaterThan(38);
  });
});
