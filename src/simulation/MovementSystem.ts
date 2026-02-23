import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Velocity, Speed, MoveTarget, Rotation, Health,
  movableQuery, hasComponent,
} from '../core/ECS';
import { PathfindingSystem } from './PathfindingSystem';
import type { AsyncPathfinder } from './AsyncPathfinder';
import type { FormationSystem } from './FormationSystem';
import { SpatialGrid } from '../utils/SpatialGrid';
import { worldToTile, angleBetween, stepAngle, distance2D } from '../utils/MathUtils';
import type { TerrainRenderer } from '../rendering/TerrainRenderer';

const ARRIVAL_THRESHOLD = 1.0;
const SEPARATION_RADIUS = 2.0;
const SEPARATION_FORCE = 0.5;
const FLIGHT_ALTITUDE = 5.0;

export class MovementSystem implements GameSystem {
  private pathfinder: PathfindingSystem;
  private asyncPathfinder: AsyncPathfinder | null = null;
  // Path cache per entity
  private paths = new Map<number, { x: number; z: number }[]>();
  private pathIndex = new Map<number, number>();
  // Entities waiting for async path result
  private pendingAsync = new Set<number>();
  // Path generation counter per entity (guards against stale async results on ID recycling)
  private pathGeneration = new Map<number, number>();
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
  // Formation system for coordinated group movement speed capping
  private formationSystem: FormationSystem | null = null;

  constructor(pathfinder: PathfindingSystem) {
    this.pathfinder = pathfinder;
  }

  setAsyncPathfinder(async_pf: AsyncPathfinder): void {
    this.asyncPathfinder = async_pf;
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

  setFormationSystem(fs: FormationSystem): void {
    this.formationSystem = fs;
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

  /** Clean up all cached state for a dead entity (prevents stale data on ID recycling) */
  unregisterEntity(eid: number): void {
    this.paths.delete(eid);
    this.pathIndex.delete(eid);
    this.stuckTicks.delete(eid);
    this.lastPos.delete(eid);
    this.flyingEntities.delete(eid);
    this.infantryEntities.delete(eid);
    this.pendingAsync.delete(eid);
    this.pathGeneration.delete(eid);
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
        // Decelerate to stop when idle
        const accel = Speed.acceleration[eid];
        if (accel > 0 && Speed.current[eid] > 0) {
          // Ramp down at 2x acceleration for snappier stop feel
          Speed.current[eid] = Math.max(0, Speed.current[eid] - accel * 2);
        } else {
          Speed.current[eid] = 0;
        }

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
          Speed.current[eid] = 0;
          continue;
        }
        const dx = targetX - px;
        const dz = targetZ - pz;
        const dirX = dx / dist;
        const dirZ = dz / dist;

        // Acceleration curve for aircraft
        const flyAccel = Speed.acceleration[eid];
        const flyMaxSpeed = Speed.max[eid];
        let flySpeed: number;
        if (flyAccel > 0) {
          Speed.current[eid] = Math.min(flyMaxSpeed, Speed.current[eid] + flyAccel);
          flySpeed = Speed.current[eid];
        } else {
          flySpeed = flyMaxSpeed;
          Speed.current[eid] = flyMaxSpeed;
        }

        const desiredAngle = angleBetween(px, pz, targetX, targetZ);
        // TurnRate from rules.txt is radians per tick — apply directly as fixed angular step
        Rotation.y[eid] = stepAngle(Rotation.y[eid], desiredAngle, Speed.turnRate[eid]);
        const vx = dirX * flySpeed;
        const vz = dirZ * flySpeed;
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
        // Skip if already waiting for async result
        if (this.pendingAsync.has(eid)) continue;

        const startTile = worldToTile(px, pz);
        const endTile = worldToTile(targetX, targetZ);
        const isVehicle = !this.infantryEntities.has(eid);

        if (this.asyncPathfinder?.isWorkerAvailable()) {
          // Use async worker pathfinding — move toward target while waiting
          this.pendingAsync.add(eid);
          const gen = (this.pathGeneration.get(eid) ?? 0) + 1;
          this.pathGeneration.set(eid, gen);
          this.asyncPathfinder.findPathAsync(startTile.tx, startTile.tz, endTile.tx, endTile.tz, isVehicle).then(result => {
            this.pendingAsync.delete(eid);
            // Guard against stale results from ID recycling
            if (result && this.pathGeneration.get(eid) === gen && MoveTarget.active[eid] === 1) {
              this.paths.set(eid, result);
              this.pathIndex.set(eid, 0);
            }
          });
          // Move directly toward target while waiting for path (straight-line approximation)
          path = [{ x: targetX, z: targetZ }];
          this.paths.set(eid, path);
          idx = 0;
          this.pathIndex.set(eid, 0);
        } else {
          // Sync fallback
          path = this.pathfinder.findPath(startTile.tx, startTile.tz, endTile.tx, endTile.tz, isVehicle) ?? [{ x: targetX, z: targetZ }];
          this.paths.set(eid, path);
          idx = 0;
          this.pathIndex.set(eid, 0);
        }
      }

      // Current waypoint
      if (idx >= path.length) {
        // Arrived
        MoveTarget.active[eid] = 0;
        Velocity.x[eid] = 0;
        Velocity.z[eid] = 0;
        Speed.current[eid] = 0;
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
          Speed.current[eid] = 0;
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

      // Turn toward target — TurnRate is radians per tick (from rules.txt)
      const desiredAngle = angleBetween(px, pz, wp.x, wp.z);
      const currentAngle = Rotation.y[eid];
      const turnRate = Speed.turnRate[eid];
      Rotation.y[eid] = stepAngle(currentAngle, desiredAngle, turnRate);

      // Determine target max speed (with formation cap, hit slowdown, and terrain modifiers)
      let maxSpeed = Speed.max[eid];
      // Formation speed cap: match slowest member so units arrive together
      if (this.formationSystem) {
        const cap = this.formationSystem.getFormationSpeedCap(eid);
        if (cap > 0 && cap < maxSpeed) {
          maxSpeed = cap;
        }
      }
      if (this.speedModifierFn) maxSpeed *= this.speedModifierFn(eid);

      // Acceleration curve: ramp up / brake / or instant
      const accel = Speed.acceleration[eid];
      let speed: number;
      if (accel > 0) {
        // Compute distance to final destination for braking
        const finalWp = path[path.length - 1];
        const distToFinal = distance2D(px, pz, finalWp.x, finalWp.z);

        // Braking distance: d = v^2 / (2 * decel), where decel = accel * 2
        // Solve for max speed that allows stopping in distToFinal: v = sqrt(2 * decel * dist)
        const decel = accel * 2;
        const brakingSpeed = Math.sqrt(2 * decel * distToFinal);

        // Target speed is the lesser of max speed and braking speed
        const targetSpeed = Math.min(maxSpeed, brakingSpeed);

        if (Speed.current[eid] < targetSpeed) {
          // Accelerate
          Speed.current[eid] = Math.min(targetSpeed, Speed.current[eid] + accel);
        } else if (Speed.current[eid] > targetSpeed) {
          // Decelerate
          Speed.current[eid] = Math.max(targetSpeed, Speed.current[eid] - decel);
        }
        // Ensure minimum crawl speed so units don't freeze near destination
        speed = Math.max(Speed.current[eid], accel * 0.5);
      } else {
        // No acceleration defined: instant speed (backward compat)
        speed = maxSpeed;
        Speed.current[eid] = maxSpeed;
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

      // Stuck detection: if unit hasn't moved for 30 ticks, force repath
      // (was 15, but slow units navigating obstacles got false-flagged causing zigzag)
      const lastP = this.lastPos.get(eid);
      const cx = Position.x[eid], cz = Position.z[eid];
      if (lastP && Math.abs(cx - lastP.x) < 0.05 && Math.abs(cz - lastP.z) < 0.05) {
        const stuck = (this.stuckTicks.get(eid) ?? 0) + 1;
        this.stuckTicks.set(eid, stuck);
        if (stuck >= 30) {
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
    this.pendingAsync.delete(eid);
    // Increment generation to invalidate any in-flight async path
    this.pathGeneration.set(eid, (this.pathGeneration.get(eid) ?? 0) + 1);
  }
}
