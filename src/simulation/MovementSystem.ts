import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Velocity, Speed, MoveTarget, Rotation, Health,
  movableQuery, hasComponent,
} from '../core/ECS';
import { PathfindingSystem } from './PathfindingSystem';
import { SpatialGrid } from '../utils/SpatialGrid';
import { worldToTile, angleBetween, lerpAngle, distance2D } from '../utils/MathUtils';
import { TerrainType, type TerrainRenderer } from '../rendering/TerrainRenderer';

const ARRIVAL_THRESHOLD = 1.0;
const SEPARATION_RADIUS = 2.0;
const SEPARATION_FORCE = 0.5;
const FLIGHT_ALTITUDE = 5.0;

export class MovementSystem implements GameSystem {
  private pathfinder: PathfindingSystem;
  // Path cache per entity
  private paths = new Map<number, { x: number; z: number }[]>();
  private pathIndex = new Map<number, number>();
  // Stuck detection: count ticks with no movement progress
  private stuckTicks = new Map<number, number>();
  private lastPos = new Map<number, { x: number; z: number }>();
  // Flying entities skip pathfinding
  private flyingEntities = new Set<number>();
  // Infantry entities use infantry passability for pathfinding
  private infantryEntities = new Set<number>();
  private tickCount = 0;
  // Spatial grid for O(n*k) neighbor lookups instead of O(n²)
  private spatialGrid = new SpatialGrid(SEPARATION_RADIUS);
  /** Expose the spatial grid for use by CombatSystem */
  getSpatialGrid(): SpatialGrid { return this.spatialGrid; }
  // Map bounds in world units (set from terrain)
  private mapMaxX = 256;
  private mapMaxZ = 256;
  // Speed modifier callback (e.g., hit slowdown from CombatSystem)
  private speedModifierFn: ((eid: number) => number) | null = null;
  // Terrain reference for height following
  private terrain: TerrainRenderer | null = null;

  constructor(pathfinder: PathfindingSystem) {
    this.pathfinder = pathfinder;
  }

  setSpeedModifier(fn: (eid: number) => number): void {
    this.speedModifierFn = fn;
  }

  setMapBounds(maxX: number, maxZ: number): void {
    this.mapMaxX = maxX;
    this.mapMaxZ = maxZ;
  }

  setTerrain(terrain: TerrainRenderer): void {
    this.terrain = terrain;
  }

  /** Invalidate all cached paths (call when blocked tiles change, e.g. building placed/destroyed) */
  invalidateAllPaths(): void {
    this.paths.clear();
    this.pathIndex.clear();
  }

  isFlyer(eid: number): boolean {
    return this.flyingEntities.has(eid);
  }

  registerFlyer(eid: number): void {
    this.flyingEntities.add(eid);
  }

  unregisterFlyer(eid: number): void {
    this.flyingEntities.delete(eid);
  }

  registerInfantry(eid: number): void {
    this.infantryEntities.add(eid);
  }

  unregisterInfantry(eid: number): void {
    this.infantryEntities.delete(eid);
  }

  init(_world: World): void {}

  update(world: World, _dt: number): void {
    const entities = movableQuery(world);
    this.tickCount++;
    const doIdleSep = this.tickCount % 5 === 0; // Idle separation every 5 ticks

    // Rebuild spatial grid for efficient neighbor queries (skip dead entities)
    this.spatialGrid.clear();
    for (const eid of entities) {
      if (hasComponent(world, Health, eid) && Health.current[eid] <= 0) continue;
      this.spatialGrid.insert(eid, Position.x[eid], Position.z[eid]);
    }

    for (const eid of entities) {
      // Clean up dead entities' path cache
      if (hasComponent(world, Health, eid) && Health.current[eid] <= 0) {
        this.paths.delete(eid);
        this.pathIndex.delete(eid);
        this.stuckTicks.delete(eid);
        this.lastPos.delete(eid);
        continue;
      }

      if (MoveTarget.active[eid] !== 1) {
        // Apply idle separation to prevent stacking (throttled)
        if (doIdleSep && !this.flyingEntities.has(eid)) {
          const px = Position.x[eid];
          const pz = Position.z[eid];
          let sepX = 0, sepZ = 0;
          const nearby = this.spatialGrid.getNearby(px, pz);
          for (const other of nearby) {
            if (other === eid || this.flyingEntities.has(other)) continue;
            const d = distance2D(px, pz, Position.x[other], Position.z[other]);
            if (d < 1.2 && d > 0.01) {
              sepX += (px - Position.x[other]) / d;
              sepZ += (pz - Position.z[other]) / d;
            }
          }
          if (Math.abs(sepX) > 0.01 || Math.abs(sepZ) > 0.01) {
            const nx = Math.max(0, Math.min(this.mapMaxX, px + sepX * 0.03));
            const nz = Math.max(0, Math.min(this.mapMaxZ, pz + sepZ * 0.03));
            // Check passability before applying separation
            let passable = true;
            if (this.terrain) {
              const tile = worldToTile(nx, nz);
              passable = this.infantryEntities.has(eid)
                ? this.terrain.isPassable(tile.tx, tile.tz)
                : this.terrain.isPassableVehicle(tile.tx, tile.tz);
            }
            if (passable) {
              Position.x[eid] = nx;
              Position.z[eid] = nz;
              if (this.terrain && !this.flyingEntities.has(eid)) {
                Position.y[eid] = this.terrain.getHeightAt(nx, nz) + 0.1;
              }
            }
          }
        }
        Velocity.x[eid] = 0;
        Velocity.z[eid] = 0;
        continue;
      }

      const px = Position.x[eid];
      const pz = Position.z[eid];
      const targetX = MoveTarget.x[eid];
      const targetZ = MoveTarget.z[eid];
      const isFlyer = this.flyingEntities.has(eid);

      // Aircraft: fly direct (no pathfinding), maintain altitude
      if (isFlyer) {
        Position.y[eid] = FLIGHT_ALTITUDE;
        const dist = distance2D(px, pz, targetX, targetZ);
        if (dist < ARRIVAL_THRESHOLD) {
          MoveTarget.active[eid] = 0;
          Velocity.x[eid] = 0;
          Velocity.z[eid] = 0;
          continue;
        }
        const dx = targetX - px;
        const dz = targetZ - pz;
        const dirX = dx / dist;
        const dirZ = dz / dist;
        const speed = Speed.max[eid];
        const desiredAngle = angleBetween(px, pz, targetX, targetZ);
        Rotation.y[eid] = lerpAngle(Rotation.y[eid], desiredAngle, Math.min(1, Speed.turnRate[eid] * 3));
        const vx = dirX * speed;
        const vz = dirZ * speed;
        Velocity.x[eid] = vx;
        Velocity.z[eid] = vz;
        Position.x[eid] = Math.max(0, Math.min(this.mapMaxX, px + vx * 0.04));
        Position.z[eid] = Math.max(0, Math.min(this.mapMaxZ, pz + vz * 0.04));
        continue;
      }

      // Get or compute path
      let path = this.paths.get(eid);
      let idx = this.pathIndex.get(eid) ?? 0;

      // Invalidate cached path if destination has changed
      if (path && path.length > 0) {
        const lastWp = path[path.length - 1];
        if (Math.abs(lastWp.x - targetX) > 2 || Math.abs(lastWp.z - targetZ) > 2) {
          path = undefined;
          this.paths.delete(eid);
          this.pathIndex.delete(eid);
          idx = 0;
        }
      }

      if (!path) {
        const startTile = worldToTile(px, pz);
        const endTile = worldToTile(targetX, targetZ);
        const isVehicle = !this.infantryEntities.has(eid);
        path = this.pathfinder.findPath(startTile.tx, startTile.tz, endTile.tx, endTile.tz, isVehicle) ?? [{ x: targetX, z: targetZ }];
        this.paths.set(eid, path);
        idx = 0;
        this.pathIndex.set(eid, 0);
      }

      // Current waypoint
      if (idx >= path.length) {
        // Arrived
        MoveTarget.active[eid] = 0;
        Velocity.x[eid] = 0;
        Velocity.z[eid] = 0;
        this.paths.delete(eid);
        this.pathIndex.delete(eid);
        this.stuckTicks.delete(eid);
        this.lastPos.delete(eid);
        continue;
      }

      const waypoint = path[idx];
      const dist = distance2D(px, pz, waypoint.x, waypoint.z);

      if (dist < ARRIVAL_THRESHOLD) {
        // Move to next waypoint
        idx++;
        this.pathIndex.set(eid, idx);

        if (idx >= path.length) {
          MoveTarget.active[eid] = 0;
          Velocity.x[eid] = 0;
          Velocity.z[eid] = 0;
          this.paths.delete(eid);
          this.pathIndex.delete(eid);
          continue;
        }
      }

      const wp = path[Math.min(idx, path.length - 1)];

      // Desired direction
      const dx = wp.x - px;
      const dz = wp.z - pz;
      const len = Math.sqrt(dx * dx + dz * dz);

      if (len < 0.01) continue;

      const dirX = dx / len;
      const dirZ = dz / len;

      // Turn toward target
      const desiredAngle = angleBetween(px, pz, wp.x, wp.z);
      const currentAngle = Rotation.y[eid];
      const turnRate = Speed.turnRate[eid];
      Rotation.y[eid] = lerpAngle(currentAngle, desiredAngle, Math.min(1, turnRate * 2));

      // Move at speed (with hit slowdown and terrain modifiers)
      let speed = Speed.max[eid];
      if (this.speedModifierFn) speed *= this.speedModifierFn(eid);
      if (this.terrain) {
        const tile = worldToTile(px, pz);
        const tType = this.terrain.getTerrainType(tile.tx, tile.tz);
        if (tType === TerrainType.Dunes) speed *= 0.7;
        else if (tType === TerrainType.Rock || tType === TerrainType.InfantryRock) speed *= 1.15;
        else if (tType === TerrainType.ConcreteSlab) speed *= 1.25;
      }

      // Separation from nearby units (spatial grid lookup)
      let sepX = 0;
      let sepZ = 0;
      const nearby = this.spatialGrid.getNearby(px, pz);
      for (const other of nearby) {
        if (other === eid || this.flyingEntities.has(other)) continue;
        const ox = Position.x[other];
        const oz = Position.z[other];
        const d = distance2D(px, pz, ox, oz);
        if (d < SEPARATION_RADIUS && d > 0.01) {
          sepX += (px - ox) / d;
          sepZ += (pz - oz) / d;
        }
      }

      const vx = dirX * speed + sepX * SEPARATION_FORCE;
      const vz = dirZ * speed + sepZ * SEPARATION_FORCE;

      Velocity.x[eid] = vx;
      Velocity.z[eid] = vz;

      // Apply velocity (scaled by tick interval), clamped to map bounds
      const newX = Math.max(0, Math.min(this.mapMaxX, px + vx * 0.04));
      const newZ = Math.max(0, Math.min(this.mapMaxZ, pz + vz * 0.04));

      // Check passability before applying movement (separation force can push off-path)
      let passable = true;
      if (this.terrain) {
        const tile = worldToTile(newX, newZ);
        passable = this.infantryEntities.has(eid)
          ? this.terrain.isPassable(tile.tx, tile.tz)
          : this.terrain.isPassableVehicle(tile.tx, tile.tz);
      }
      if (passable) {
        Position.x[eid] = newX;
        Position.z[eid] = newZ;
      } else {
        // Move only along the pathfound direction, ignoring separation force
        const safeX = Math.max(0, Math.min(this.mapMaxX, px + dirX * speed * 0.04));
        const safeZ = Math.max(0, Math.min(this.mapMaxZ, pz + dirZ * speed * 0.04));
        if (this.terrain) {
          const safeTile = worldToTile(safeX, safeZ);
          const safePassable = this.infantryEntities.has(eid)
            ? this.terrain.isPassable(safeTile.tx, safeTile.tz)
            : this.terrain.isPassableVehicle(safeTile.tx, safeTile.tz);
          if (safePassable) {
            Position.x[eid] = safeX;
            Position.z[eid] = safeZ;
          }
          // If even safe direction is impassable, don't move (stuck)
        } else {
          Position.x[eid] = safeX;
          Position.z[eid] = safeZ;
        }
      }

      // Stuck detection: if unit hasn't moved for 15 ticks, force repath
      const lastP = this.lastPos.get(eid);
      const cx = Position.x[eid], cz = Position.z[eid];
      if (lastP && Math.abs(cx - lastP.x) < 0.05 && Math.abs(cz - lastP.z) < 0.05) {
        const stuck = (this.stuckTicks.get(eid) ?? 0) + 1;
        this.stuckTicks.set(eid, stuck);
        if (stuck >= 15) {
          this.paths.delete(eid);
          this.pathIndex.delete(eid);
          this.stuckTicks.set(eid, 0);
        }
      } else {
        this.stuckTicks.set(eid, 0);
      }
      const lp = this.lastPos.get(eid);
      if (lp) { lp.x = cx; lp.z = cz; } else { this.lastPos.set(eid, { x: cx, z: cz }); }

      // Ground units follow terrain height
      if (this.terrain) {
        Position.y[eid] = this.terrain.getHeightAt(Position.x[eid], Position.z[eid]) + 0.1;
      }
    }
  }

  // Clear cached path when a new move command is issued
  clearPath(eid: number): void {
    this.paths.delete(eid);
    this.pathIndex.delete(eid);
    this.stuckTicks.delete(eid);
    this.lastPos.delete(eid);
  }
}
