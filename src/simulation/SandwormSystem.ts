import { simRng } from '../utils/DeterministicRNG';
import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Health, Owner, UnitType, Harvester, MoveTarget,
  unitQuery, hasComponent,
} from '../core/ECS';
import type { TerrainRenderer } from '../rendering/TerrainRenderer';
import { TerrainType } from '../rendering/TerrainRenderer';
import { worldToTile, distance2D, randomFloat } from '../utils/MathUtils';
import { GameConstants } from '../utils/Constants';
import { EventBus } from '../core/EventBus';
import type { EffectsManager } from '../rendering/EffectsManager';
import type { GameRules } from '../config/RulesParser';

interface Worm {
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  speed: number;
  life: number; // Ticks remaining before burrowing
  huntingEid: number | null; // Entity being hunted
  huntingOwner: number; // Owner of hunted entity at hunt start (for ID recycling detection)
  state: 'roaming' | 'hunting' | 'emerging' | 'submerging' | 'mounted';
  emergeTicks: number;
  riderEid?: number; // Entity riding this worm
  riderOwner?: number; // Owner of the rider
}

export class SandwormSystem implements GameSystem {
  private terrain: TerrainRenderer;
  private effects: EffectsManager;
  private worms: Worm[] = [];
  private tickCounter = 0;
  private maxWorms: number;
  private spawnChance: number;
  private rules: GameRules | null = null;
  private unitTypeNames: string[] = [];
  // Thumper locations: deployed by units, attract worms
  private thumpers: Array<{ x: number; z: number; ticksLeft: number }> = [];
  // Persistent per-side worm attraction/repulsion flags (set by mission scripts)
  private sideAttractsWorms = new Set<number>();
  private sideRepelsWorms = new Set<number>();

  constructor(terrain: TerrainRenderer, effects: EffectsManager) {
    this.terrain = terrain;
    this.effects = effects;
    this.maxWorms = GameConstants.MAX_SURFACE_WORMS;
    this.spawnChance = GameConstants.CHANCE_OF_SURFACE_WORM;
  }

  init(_world: World): void {}

  setRules(rules: GameRules, unitTypeNames: string[]): void {
    this.rules = rules;
    this.unitTypeNames = unitTypeNames;
  }

  /** Deploy a thumper at a location (attracts worms for ~20 seconds) */
  deployThumper(x: number, z: number): void {
    this.thumpers.push({ x, z, ticksLeft: GameConstants.THUMPER_DURATION });
    EventBus.emit('thumper:deployed', { x, z });
  }

  /** Mark a side's units as permanently attracting worms (mission script flag). */
  setSideAttractsWorms(side: number): void {
    this.sideAttractsWorms.add(side);
    this.sideRepelsWorms.delete(side); // mutually exclusive
  }

  /** Mark a side's units as permanently repelling worms (mission script flag). */
  setSideRepelsWorms(side: number): void {
    this.sideRepelsWorms.add(side);
    this.sideAttractsWorms.delete(side); // mutually exclusive
  }

  /** Check if a side attracts worms. */
  doesSideAttractWorms(side: number): boolean {
    return this.sideAttractsWorms.has(side);
  }

  /** Check if a side repels worms. */
  doesSideRepelWorms(side: number): boolean {
    return this.sideRepelsWorms.has(side);
  }

  update(world: World, _dt: number): void {
    this.tickCounter++;

    // Try to spawn new worm (not before MinimumTicksWormCanAppear)
    if (this.worms.length < this.maxWorms && this.tickCounter % 100 === 0 &&
        this.tickCounter >= GameConstants.MIN_TICKS_WORM_CAN_APPEAR) {
      // spawnChance is per-tick rate; scale by check interval (100 ticks)
      if (simRng.random() * this.spawnChance < 100) {
        this.spawnWorm();
      }
    }

    // Update existing worms
    for (let i = this.worms.length - 1; i >= 0; i--) {
      const worm = this.worms[i];
      worm.life--;

      if (worm.life <= 0) {
        // Dismount rider before removing worm
        if (worm.state === 'mounted' && worm.riderEid != null) {
          Position.y[worm.riderEid] = 0.1;
          worm.riderEid = undefined;
          worm.riderOwner = undefined;
        }
        // Submerge and remove
        this.effects.spawnExplosion(worm.x, 0, worm.z, 'medium');
        EventBus.emit('worm:submerge', { x: worm.x, z: worm.z });
        this.worms.splice(i, 1);
        continue;
      }

      switch (worm.state) {
        case 'emerging':
          worm.emergeTicks--;
          if (worm.emergeTicks <= 0) {
            worm.state = 'roaming';
          }
          break;

        case 'roaming':
          this.updateRoaming(world, worm);
          break;

        case 'hunting':
          this.updateHunting(world, worm);
          break;

        case 'mounted':
          this.updateMounted(world, worm);
          break;

        case 'submerging':
          // Remove on next tick
          break;
      }

      // Sandworm destroys spice on tiles it passes through (RemoveSpice=200 from rules.txt)
      if (worm.state !== 'emerging' && worm.state !== 'submerging') {
        const wormTile = worldToTile(worm.x, worm.z);
        const spice = this.terrain.getSpice(wormTile.tx, wormTile.tz);
        if (spice > 0) {
          this.terrain.setSpice(wormTile.tx, wormTile.tz, Math.max(0, spice - GameConstants.WORM_SPICE_DESTROY_RATE));
        }
      }
    }

    // Update thumpers: decay and attract worms
    for (let i = this.thumpers.length - 1; i >= 0; i--) {
      this.thumpers[i].ticksLeft--;
      if (this.thumpers[i].ticksLeft <= 0) {
        this.thumpers.splice(i, 1);
        continue;
      }
      // Rhythmic thumper sound (~every 3 seconds)
      if (this.tickCounter % 75 === 0) {
        EventBus.emit('thumper:rhythm', { x: this.thumpers[i].x, z: this.thumpers[i].z });
      }
      // Thumpers attract roaming worms toward them
      if (this.tickCounter % 25 === 0) {
        const t = this.thumpers[i];
        for (const worm of this.worms) {
          if (worm.state !== 'roaming') continue;
          const dist = distance2D(worm.x, worm.z, t.x, t.z);
          if (dist < GameConstants.WORM_ATTRACTION_RADIUS * 2) {
            worm.targetX = t.x;
            worm.targetZ = t.z;
          }
        }
      }
    }

    // Thumpers also increase worm spawn chance (still respects minimum appearance delay)
    if (this.thumpers.length > 0 && this.worms.length < this.maxWorms && this.tickCounter % 50 === 25 &&
        this.tickCounter >= GameConstants.MIN_TICKS_WORM_CAN_APPEAR) {
      this.spawnWorm();
    }
  }

  private spawnWorm(): void {
    // Spawn on sand tile away from any buildings
    const worldW = this.terrain.getMapWidth() * 2;
    const worldH = this.terrain.getMapHeight() * 2;
    const x = randomFloat(20, worldW - 20);
    const z = randomFloat(20, worldH - 20);
    const tile = worldToTile(x, z);
    const terrainType = this.terrain.getTerrainType(tile.tx, tile.tz);

    // Only spawn on sand/dunes/spice
    if (terrainType !== TerrainType.Sand && terrainType !== TerrainType.Dunes &&
        terrainType !== TerrainType.SpiceLow && terrainType !== TerrainType.SpiceHigh) {
      return;
    }

    const minLife = GameConstants.SURFACE_WORM_MIN_LIFE;
    const maxLife = GameConstants.SURFACE_WORM_MAX_LIFE;

    const worm: Worm = {
      x, z,
      targetX: Math.max(10, Math.min(worldW - 10, x + randomFloat(-50, 50))),
      targetZ: Math.max(10, Math.min(worldH - 10, z + randomFloat(-50, 50))),
      speed: GameConstants.WORM_ROAM_SPEED,
      life: minLife + Math.floor(simRng.random() * (maxLife - minLife)),
      huntingEid: null,
      huntingOwner: -1,
      state: 'emerging',
      emergeTicks: GameConstants.WORM_EMERGE_TICKS,
    };

    this.worms.push(worm);
    this.effects.spawnExplosion(x, 0, z, 'large');
    EventBus.emit('worm:emerge', { x, z });
  }

  private updateRoaming(world: World, worm: Worm): void {
    // Move toward target
    const dx = worm.targetX - worm.x;
    const dz = worm.targetZ - worm.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 2) {
      // Pick new random target on sand
      worm.targetX = worm.x + randomFloat(-60, 60);
      worm.targetZ = worm.z + randomFloat(-60, 60);
      const wW = this.terrain.getMapWidth() * 2;
      const wH = this.terrain.getMapHeight() * 2;
      worm.targetX = Math.max(10, Math.min(wW - 10, worm.targetX));
      worm.targetZ = Math.max(10, Math.min(wH - 10, worm.targetZ));
    } else if (dist > 0.1) {
      worm.x += (dx / dist) * worm.speed;
      worm.z += (dz / dist) * worm.speed;
    }

    // Look for prey every 25 ticks
    if (this.tickCounter % 25 === 0) {
      const prey = this.findPrey(world, worm);
      if (prey !== null) {
        worm.huntingEid = prey;
        worm.huntingOwner = Owner.playerId[prey];
        worm.state = 'hunting';
        worm.speed = GameConstants.WORM_HUNT_SPEED;
      }
    }
  }

  private updateHunting(world: World, worm: Worm): void {
    if (worm.huntingEid === null) {
      worm.state = 'roaming';
      worm.speed = GameConstants.WORM_ROAM_SPEED;
      return;
    }

    // Check if prey is still alive and valid (guards against entity ID recycling)
    let targetX: number, targetZ: number;
    try {
      if (!hasComponent(world, UnitType, worm.huntingEid) || Health.current[worm.huntingEid] <= 0 ||
          Owner.playerId[worm.huntingEid] !== worm.huntingOwner) {
        worm.huntingEid = null;
        worm.state = 'roaming';
        worm.speed = GameConstants.WORM_ROAM_SPEED;
        return;
      }
      targetX = Position.x[worm.huntingEid];
      targetZ = Position.z[worm.huntingEid];
      if (isNaN(targetX) || isNaN(targetZ)) throw new Error();
    } catch {
      worm.huntingEid = null;
      worm.state = 'roaming';
      worm.speed = GameConstants.WORM_ROAM_SPEED;
      return;
    }

    // Check terrain — worm won't go on rock
    const tile = worldToTile(targetX, targetZ);
    const terrainType = this.terrain.getTerrainType(tile.tx, tile.tz);
    if (terrainType === TerrainType.Rock || terrainType === TerrainType.Cliff || terrainType === TerrainType.InfantryRock) {
      // Prey is on rock — can't reach, give up
      worm.huntingEid = null;
      worm.state = 'roaming';
      worm.speed = GameConstants.WORM_ROAM_SPEED;
      return;
    }

    const dx = targetX - worm.x;
    const dz = targetZ - worm.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 2) {
      // EAT THE UNIT
      this.eatUnit(world, worm.huntingEid, worm);
      worm.huntingEid = null;
      worm.state = 'roaming';
      worm.speed = GameConstants.WORM_ROAM_SPEED;
    } else if (dist > 0.1) {
      worm.x += (dx / dist) * worm.speed;
      worm.z += (dz / dist) * worm.speed;
    }
  }

  private eatUnit(_world: World, eid: number, worm: Worm): void {
    // Guard against eating already-dead units (killed by another system this tick)
    if (Health.current[eid] <= 0) return;
    // Capture owner before killing (entity data may be invalid after death event)
    const ownerId = Owner.playerId[eid];
    // Kill the unit
    Health.current[eid] = 0;
    this.effects.spawnExplosion(worm.x, 0, worm.z, 'large');
    EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
    EventBus.emit('worm:eat', { entityId: eid, x: worm.x, z: worm.z, ownerId });
  }

  private findPrey(world: World, worm: Worm): number | null {
    const units = unitQuery(world);
    const wormRange = GameConstants.WORM_ATTRACTION_RADIUS;
    let bestDist = wormRange;
    let bestEid: number | null = null;

    for (const eid of units) {
      if (Health.current[eid] <= 0) continue;

      // Skip units mounted on worms
      if (this.isRider(eid)) continue;

      // Check if unit is on sand (worm can't eat units on rock)
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      const terrainType = this.terrain.getTerrainType(tile.tx, tile.tz);
      if (terrainType === TerrainType.Rock || terrainType === TerrainType.Cliff || terrainType === TerrainType.InfantryRock) {
        continue;
      }

      // Calculate attraction multiplier based on unit properties
      const isHarvester = hasComponent(world, Harvester, eid);
      let attractionMult = 1.0;
      if (isHarvester) attractionMult = GameConstants.WORM_HARVESTER_ATTRACTION;
      // Check unit def for wormAttraction and tastyToWorms
      if (this.rules && hasComponent(world, UnitType, eid)) {
        const typeName = this.unitTypeNames[UnitType.id[eid]];
        const def = typeName ? this.rules.units.get(typeName) : null;
        if (def) {
          if (def.tastyToWorms) attractionMult *= GameConstants.WORM_TASTY_ATTRACTION;
          if (def.wormAttraction > 0) attractionMult *= Math.max(0.1, 1 - def.wormAttraction * 0.1);
          else if (def.wormAttraction < 0) attractionMult *= 3.0; // Negative values repel worms
        }
      }
      // Persistent side-level worm flags from mission scripts
      const unitOwner = Owner.playerId[eid];
      if (this.sideAttractsWorms.has(unitOwner)) attractionMult *= 0.3; // strongly attracts
      if (this.sideRepelsWorms.has(unitOwner)) continue; // skip entirely

      const dist = distance2D(worm.x, worm.z, Position.x[eid], Position.z[eid]);
      const effectiveDist = dist * attractionMult;

      if (effectiveDist < bestDist) {
        bestDist = effectiveDist;
        bestEid = eid;
      }
    }

    return bestEid;
  }

  private updateMounted(world: World, worm: Worm): void {
    if (worm.riderEid == null) {
      worm.state = 'roaming';
      worm.speed = GameConstants.WORM_ROAM_SPEED;
      return;
    }

    // Check if rider is still alive and is same entity (guards against entity ID recycling)
    if (Health.current[worm.riderEid] <= 0 || Owner.playerId[worm.riderEid] !== worm.riderOwner) {
      worm.state = 'roaming';
      worm.speed = GameConstants.WORM_ROAM_SPEED;
      worm.riderEid = undefined;
      worm.riderOwner = undefined;
      return;
    }

    // Follow rider's move target (rider controls the worm)
    if (MoveTarget.active[worm.riderEid] === 1) {
      const tx = MoveTarget.x[worm.riderEid];
      const tz = MoveTarget.z[worm.riderEid];
      const dx = tx - worm.x;
      const dz = tz - worm.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 2) {
        const nextX = worm.x + (dx / dist) * worm.speed;
        const nextZ = worm.z + (dz / dist) * worm.speed;
        // Worm can't traverse rock/cliff even when mounted
        const tile = worldToTile(nextX, nextZ);
        const tt = this.terrain.getTerrainType(tile.tx, tile.tz);
        if (tt !== TerrainType.Rock && tt !== TerrainType.Cliff && tt !== TerrainType.InfantryRock) {
          worm.x = nextX;
          worm.z = nextZ;
        }
      } else {
        // Arrived at destination — clear move target so rider can idle/heal
        MoveTarget.active[worm.riderEid] = 0;
      }
    }

    // Keep rider on top of the worm
    Position.x[worm.riderEid] = worm.x;
    Position.z[worm.riderEid] = worm.z;
    Position.y[worm.riderEid] = 1.5; // Riding on top

    // Mounted worm eats any enemy units it passes near
    if (this.tickCounter % 10 === 0) {
      const units = unitQuery(world);
      for (const eid of units) {
        if (eid === worm.riderEid) continue;
        if (Health.current[eid] <= 0) continue;
        if (Owner.playerId[eid] === worm.riderOwner) continue; // Don't eat friendlies
        const dx = Position.x[eid] - worm.x;
        const dz = Position.z[eid] - worm.z;
        if (dx * dx + dz * dz < 9) { // Within 3 units
          this.eatUnit(world, eid, worm);
        }
      }
    }
  }

  getWorms(): ReadonlyArray<Worm> {
    return this.worms;
  }

  /** Try to mount a worm near the given position. Returns true if successful. */
  mountWorm(riderEid: number, riderX: number, riderZ: number, riderOwner: number): boolean {
    for (const worm of this.worms) {
      if (worm.state === 'mounted' || worm.state === 'emerging' || worm.state === 'submerging') continue;
      const dx = worm.x - riderX;
      const dz = worm.z - riderZ;
      if (dx * dx + dz * dz < 25) { // Within 5 units
        worm.state = 'mounted';
        worm.riderEid = riderEid;
        worm.riderOwner = riderOwner;
        worm.life = Math.max(worm.life, GameConstants.WORM_MOUNTED_MIN_LIFE);
        worm.speed = GameConstants.WORM_MOUNTED_SPEED;
        worm.huntingEid = null;
        return true;
      }
    }
    return false;
  }

  /** Dismount a rider from their worm */
  dismountWorm(riderEid: number): void {
    for (const worm of this.worms) {
      if (worm.riderEid === riderEid) {
        worm.state = 'roaming';
        worm.speed = GameConstants.WORM_ROAM_SPEED;
        Position.y[riderEid] = 0.1; // Return rider to ground level
        worm.riderEid = undefined;
        worm.riderOwner = undefined;
        break;
      }
    }
  }

  /** Check if an entity is currently riding a worm */
  private isRider(eid: number): boolean {
    for (const worm of this.worms) {
      if (worm.riderEid === eid) return true;
    }
    return false;
  }

  /** Get the worm a rider is on, if any */
  getRiderWorm(riderEid: number): Worm | null {
    for (const worm of this.worms) {
      if (worm.riderEid === riderEid) return worm;
    }
    return null;
  }
}
