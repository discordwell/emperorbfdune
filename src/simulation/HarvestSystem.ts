import { simRng } from '../utils/DeterministicRNG';
import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Harvester, MoveTarget, Owner, Health, BuildingType,
  harvestQuery, buildingQuery, unitQuery, hasComponent,
} from '../core/ECS';
import type { TerrainRenderer } from '../rendering/TerrainRenderer';
import { TerrainType } from '../rendering/TerrainRenderer';
import { worldToTile, tileToWorld, distance2D } from '../utils/MathUtils';
import { GameConstants } from '../utils/Constants';
import { EventBus } from '../core/EventBus';

// Harvester states
const IDLE = 0;
const MOVING_TO_SPICE = 1;
const HARVESTING = 2;
const RETURNING = 3;
const UNLOADING = 4;

export class HarvestSystem implements GameSystem {
  private terrain: TerrainRenderer;
  // Player resources
  private solaris = new Map<number, number>(); // playerId -> credits
  private harvestTimers = new Map<number, number>(); // eid -> ticks spent harvesting
  private tickCounter = 0;
  // Spice mound lifecycle (faithful to original rules.txt [SpiceMound])
  // A mound appears, lives for 1000-1500 ticks, then erupts creating spice bloom
  private activeMound: { tx: number; tz: number; ticksLeft: number; totalLife: number } | null = null;
  // Regrow cooldown: delay after eruption before next mound can spawn (200-2000 ticks)
  private regrowCooldown = 0;
  // Cash fallback: when all spice is gone, deliver credits periodically
  private noSpiceTimer = 0;
  private noSpiceDeliveryInterval = 0; // randomized each cycle
  private playerCount = 2;
  // Spice spread/growth tracking
  private spiceDirty = false; // Splatmap needs update flag
  // Carryall: players that have a Hanger get auto-airlift for harvesters
  private playersWithCarryall = new Set<number>();
  // Harvesters being airlifted: eid -> ticks remaining
  private airlifting = new Map<number, number>();

  // Income rate tracking
  private lastSolarisSnapshot = 0;
  private displayedSolaris = 0;
  // Tracked harvester entity IDs
  private knownHarvesters = new Set<number>();
  // Harvesters that recently took damage - flee to refinery (eid -> expiry tick)
  private fleeing = new Map<number, number>();
  // Building lookup for refinery reassignment
  private world: World | null = null;
  private buildingTypeNames: string[] = [];

  /** Validate that a stored refinery entity ID is still a living refinery (guards against ID recycling) */
  private isValidRefinery(refEntity: number): boolean {
    if (refEntity <= 0) return false;
    if (!this.world || !hasComponent(this.world, BuildingType, refEntity)) return false;
    if (Health.current[refEntity] <= 0) return false;
    const bTypeId = BuildingType.id[refEntity];
    const bName = this.buildingTypeNames[bTypeId] ?? '';
    return bName.includes('Refinery');
  }

  constructor(terrain: TerrainRenderer) {
    this.terrain = terrain;

    // Harvesters flee when damaged (unless already returning/unloading)
    EventBus.on('unit:damaged', ({ entityId }) => {
      if (!this.knownHarvesters.has(entityId)) return;
      const state = Harvester.state[entityId];
      if (state !== RETURNING && state !== UNLOADING) {
        Harvester.state[entityId] = RETURNING;
        this.returnToRefinery(entityId);
        this.fleeing.set(entityId, this.tickCounter + 250); // ~10 seconds at 25 tps
      }
    });
  }

  /** Force a harvester to return to refinery immediately (e.g. R key) */
  forceReturn(eid: number): void {
    if (!this.knownHarvesters.has(eid)) return;
    Harvester.state[eid] = RETURNING;
    this.returnToRefinery(eid);
    MoveTarget.active[eid] = 1;
  }

  /** Provide building context for refinery reassignment when a refinery is destroyed */
  setBuildingContext(world: World, buildingTypeNames: string[]): void {
    this.world = world;
    this.buildingTypeNames = buildingTypeNames;
  }

  /** Mark a player as having carryall support (owns a Hanger) */
  setCarryallAvailable(playerId: number, available: boolean): void {
    if (available) this.playersWithCarryall.add(playerId);
    else this.playersWithCarryall.delete(playerId);
  }

  hasCarryall(playerId: number): boolean {
    return this.playersWithCarryall.has(playerId);
  }

  /** Get airlift state for visual rendering */
  getAirliftingEntities(): ReadonlyMap<number, number> {
    return this.airlifting;
  }

  init(_world: World, playerCount = 2): void {
    this.playerCount = playerCount;
    // Start all players with initial credits
    for (let i = 0; i < playerCount; i++) {
      this.solaris.set(i, 5000);
    }
  }

  setPlayerCount(count: number): void {
    this.playerCount = count;
  }

  getSolaris(playerId: number): number {
    return this.solaris.get(playerId) ?? 0;
  }

  addSolaris(playerId: number, amount: number): void {
    this.solaris.set(playerId, (this.solaris.get(playerId) ?? 0) + amount);
  }

  spendSolaris(playerId: number, amount: number): boolean {
    const current = this.solaris.get(playerId) ?? 0;
    if (current < amount) return false;
    this.solaris.set(playerId, current - amount);
    return true;
  }

  update(world: World, _dt: number): void {
    const entities = harvestQuery(world);

    // Track known harvesters for damage detection
    this.knownHarvesters.clear();
    for (const eid of entities) this.knownHarvesters.add(eid);

    // Expire flee timers
    for (const [eid, expiry] of this.fleeing) {
      if (this.tickCounter >= expiry || !this.knownHarvesters.has(eid)) {
        this.fleeing.delete(eid);
      }
    }

    for (const eid of entities) {
      // Skip dead harvesters (in death animation)
      if (Health.current[eid] <= 0) {
        this.harvestTimers.delete(eid);
        this.airlifting.delete(eid);
        continue;
      }

      const state = Harvester.state[eid];

      // Clean up airlift state if harvester left RETURNING
      if (state !== RETURNING && this.airlifting.has(eid)) {
        this.airlifting.delete(eid);
        Position.y[eid] = 0.1;
      }

      switch (state) {
        case IDLE:
          this.handleIdle(eid);
          break;
        case MOVING_TO_SPICE:
          this.handleMovingToSpice(eid);
          break;
        case HARVESTING:
          this.handleHarvesting(eid);
          break;
        case RETURNING:
          this.handleReturning(eid);
          break;
        case UNLOADING:
          this.handleUnloading(eid);
          break;
      }
    }

    // Dynamic spice system (faithful to original Emperor: Battle for Dune)
    this.tickCounter++;

    // 1) Spice mound lifecycle: mound appears → warning → tremors → eruption → bloom
    if (this.activeMound) {
      this.activeMound.ticksLeft--;
      const totalLife = this.activeMound.totalLife;
      const progress = 1 - this.activeMound.ticksLeft / totalLife;

      // Warning phase: emit tremors as mound nears eruption (last 30% of life)
      if (this.activeMound.ticksLeft < totalLife * 0.3 && this.activeMound.ticksLeft % 25 === 0) {
        const wx = tileToWorld(this.activeMound.tx, this.activeMound.tz);
        EventBus.emit('bloom:tremor', { x: wx.x, z: wx.z, intensity: progress });
      }

      if (this.activeMound.ticksLeft <= 0) {
        // Eruption!
        this.executeBloom(this.activeMound.tx, this.activeMound.tz);
        this.activeMound = null;
        // Set regrow cooldown (200-2000 ticks from rules.txt)
        this.regrowCooldown = GameConstants.SPICE_MOUND_REGROW_MIN +
          Math.floor(simRng.random() * (GameConstants.SPICE_MOUND_REGROW_MAX - GameConstants.SPICE_MOUND_REGROW_MIN));
      }
    } else if (this.regrowCooldown > 0) {
      this.regrowCooldown--;
    } else if (this.tickCounter % 250 === 0) {
      // Try to spawn a new spice mound
      this.spawnMound();
    }

    // 2) Spice spreading: existing spice tiles grow outward to adjacent sand
    if (this.tickCounter % GameConstants.SPICE_SPREAD_INTERVAL === 0) {
      this.spreadSpice();
    }

    // 3) Spice growth: existing spice tiles slowly increase in density
    if (this.tickCounter % 50 === 0) {
      this.growSpice();
    }

    // 4) Cash fallback when all spice is depleted (from rules.txt [General])
    this.updateCashFallback();

    // 5) Update 3D visuals if spice changed
    if (this.spiceDirty && this.tickCounter % 25 === 0) {
      this.terrain.updateSpiceVisuals();
      this.spiceDirty = false;
    }

    // Update UI with smooth count-up/count-down ticker
    const p0Credits = this.solaris.get(0) ?? 0;
    const el = document.getElementById('solaris-count');
    if (el) {
      const current = Math.floor(p0Credits);
      // Snap on first update to avoid counting up from 0
      if (this.displayedSolaris === 0 && current > 0 && this.tickCounter <= 1) {
        this.displayedSolaris = current;
      }
      const displayed = this.displayedSolaris;
      if (displayed !== current) {
        // Animate toward target: move ~10% of difference per tick, minimum 1
        const diff = current - displayed;
        const step = Math.sign(diff) * Math.max(1, Math.floor(Math.abs(diff) * 0.15));
        const next = Math.abs(step) >= Math.abs(diff) ? current : displayed + step;
        this.displayedSolaris = next;
        el.textContent = String(next);
        if (diff > 0) {
          el.classList.remove('flash-red');
          if (!el.classList.contains('flash-green')) el.classList.add('flash-green');
        } else {
          el.classList.remove('flash-green');
          if (!el.classList.contains('flash-red')) el.classList.add('flash-red');
        }
      } else {
        el.classList.remove('flash-green');
        el.classList.remove('flash-red');
      }
    }

    // Income rate display (update every 2 seconds / 50 ticks)
    if (this.tickCounter % 50 === 0) {
      const rate = Math.floor(p0Credits) - this.lastSolarisSnapshot;
      this.lastSolarisSnapshot = Math.floor(p0Credits);
      const rateEl = document.getElementById('income-rate');
      if (rateEl) {
        if (rate > 0) {
          rateEl.textContent = `+${rate}/2s`;
          rateEl.style.color = '#44ff44';
        } else if (rate < 0) {
          rateEl.textContent = `${rate}/2s`;
          rateEl.style.color = '#ff4444';
        } else {
          rateEl.textContent = '';
        }
      }
    }
  }

  /** Spawn a spice mound on a sand tile if conditions are met */
  private spawnMound(): void {
    const mw = this.terrain.getMapWidth(), mh = this.terrain.getMapHeight();

    // Find a valid sand tile away from edges
    for (let attempt = 0; attempt < 50; attempt++) {
      const margin = Math.min(10, Math.floor(Math.min(mw, mh) * 0.1));
      const tx = margin + Math.floor(simRng.random() * Math.max(1, mw - margin * 2));
      const tz = margin + Math.floor(simRng.random() * Math.max(1, mh - margin * 2));
      const type = this.terrain.getTerrainType(tx, tz);
      // Mound can appear on sand or existing spice
      if (type === TerrainType.Sand || type === TerrainType.Dunes ||
          type === TerrainType.SpiceLow || type === TerrainType.SpiceHigh) {
        // Duration: Size + random(Cost) from rules.txt = 1000 + random(500) ticks
        const duration = GameConstants.SPICE_MOUND_MIN_DURATION +
          Math.floor(simRng.random() * GameConstants.SPICE_MOUND_RANDOM_DURATION);
        this.activeMound = { tx, tz, ticksLeft: duration, totalLife: duration };
        const wx = tileToWorld(tx, tz);
        EventBus.emit('bloom:warning', { x: wx.x, z: wx.z });
        return;
      }
    }
  }

  /** Execute a spice bloom eruption with faithful radius and damage */
  private executeBloom(tx: number, tz: number): void {
    const radius = GameConstants.SPICE_BLOOM_RADIUS; // 6 tiles from rules.txt
    const mw = this.terrain.getMapWidth(), mh = this.terrain.getMapHeight();

    // Create spice patch in circular radius
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        // Circular falloff
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > radius) continue;

        const stx = tx + dx;
        const stz = tz + dz;
        if (stx < 0 || stx >= mw || stz < 0 || stz >= mh) continue;

        const type = this.terrain.getTerrainType(stx, stz);
        // Only place spice on sand/dunes (not on rock/cliff/concrete)
        if (type !== TerrainType.Sand && type !== TerrainType.Dunes &&
            type !== TerrainType.SpiceLow && type !== TerrainType.SpiceHigh) continue;

        // Density falls off from center: center is rich, edges are thin
        const falloff = 1 - (dist / radius);
        const existing = this.terrain.getSpice(stx, stz);
        const amount = Math.min(1.0, existing + 0.3 + falloff * 0.7);
        this.terrain.setSpice(stx, stz, amount);
      }
    }

    this.spiceDirty = true;

    const wx = tileToWorld(tx, tz);

    // AoE damage to units/buildings near the eruption (faithful to original)
    if (this.world) {
      const bloomDamage = GameConstants.SPICE_BLOOM_DAMAGE;
      const worldRadius = GameConstants.SPICE_BLOOM_DAMAGE_RADIUS;
      const r2 = worldRadius * worldRadius;
      const allEntities = [...unitQuery(this.world), ...buildingQuery(this.world)];
      for (const eid of allEntities) {
        if (Health.current[eid] <= 0) continue;
        const dx = Position.x[eid] - wx.x;
        const dz = Position.z[eid] - wx.z;
        const dist2 = dx * dx + dz * dz;
        if (dist2 < r2) {
          const dist = Math.sqrt(dist2);
          const dmg = Math.floor(bloomDamage * (1 - dist / worldRadius));
          if (dmg > 0) {
            Health.current[eid] = Math.max(0, Health.current[eid] - dmg);
            if (Health.current[eid] <= 0) {
              EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
            }
          }
        }
      }
    }

    EventBus.emit('bloom:eruption', { x: wx.x, z: wx.z, radius });
  }

  /** Spice spreading: each spice tile has a chance to grow into adjacent sand */
  private spreadSpice(): void {
    const mw = this.terrain.getMapWidth(), mh = this.terrain.getMapHeight();
    const chance = GameConstants.SPICE_SPREAD_CHANCE;
    // Collect spread targets to avoid modifying during iteration
    const newSpice: { tx: number; tz: number; amount: number }[] = [];

    for (let tz = 1; tz < mh - 1; tz++) {
      for (let tx = 1; tx < mw - 1; tx++) {
        const spice = this.terrain.getSpice(tx, tz);
        if (spice <= 0.2) continue; // Only spread from established tiles

        if (simRng.random() > chance) continue;

        // Pick a random adjacent tile (4-directional)
        const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
        const [ddx, ddz] = dirs[Math.floor(simRng.random() * 4)];
        const ntx = tx + ddx;
        const ntz = tz + ddz;

        if (ntx < 0 || ntx >= mw || ntz < 0 || ntz >= mh) continue;
        const nType = this.terrain.getTerrainType(ntx, ntz);
        // Only spread to sand or dunes
        if (nType !== TerrainType.Sand && nType !== TerrainType.Dunes) continue;

        // New spice starts thin
        newSpice.push({ tx: ntx, tz: ntz, amount: 0.1 + simRng.random() * 0.15 });
      }
    }

    for (const s of newSpice) {
      const existing = this.terrain.getSpice(s.tx, s.tz);
      if (existing <= 0) {
        this.terrain.setSpice(s.tx, s.tz, s.amount);
        this.spiceDirty = true;
      }
    }
  }

  /** Spice growth: existing spice tiles slowly increase in density */
  private growSpice(): void {
    const mw = this.terrain.getMapWidth(), mh = this.terrain.getMapHeight();
    const rate = GameConstants.SPICE_GROWTH_RATE;
    let changed = false;

    for (let tz = 0; tz < mh; tz++) {
      for (let tx = 0; tx < mw; tx++) {
        const spice = this.terrain.getSpice(tx, tz);
        if (spice <= 0 || spice >= 1.0) continue;

        // Grow towards max density, faster when surrounded by more spice
        let neighbors = 0;
        if (this.terrain.getSpice(tx - 1, tz) > 0) neighbors++;
        if (this.terrain.getSpice(tx + 1, tz) > 0) neighbors++;
        if (this.terrain.getSpice(tx, tz - 1) > 0) neighbors++;
        if (this.terrain.getSpice(tx, tz + 1) > 0) neighbors++;

        const growAmount = rate * (1 + neighbors * 0.25);
        const newAmount = Math.min(1.0, spice + growAmount);
        if (newAmount !== spice) {
          this.terrain.setSpice(tx, tz, newAmount);
          changed = true;
        }
      }
    }

    if (changed) this.spiceDirty = true;
  }

  /** Cash fallback: deliver credits to all players when no spice exists */
  private updateCashFallback(): void {
    // Only check every 100 ticks (cash delivery is on 4000-8000 tick intervals)
    if (this.tickCounter % 100 !== 0) {
      if (this.noSpiceTimer > 0) this.noSpiceTimer++;
      return;
    }

    // Full scan to check if ANY spice exists
    const mw = this.terrain.getMapWidth(), mh = this.terrain.getMapHeight();
    let hasSpice = false;
    for (let tz = 0; tz < mh && !hasSpice; tz++) {
      for (let tx = 0; tx < mw && !hasSpice; tx++) {
        if (this.terrain.getSpice(tx, tz) > 0) hasSpice = true;
      }
    }

    if (hasSpice) {
      this.noSpiceTimer = 0;
      return;
    }

    // No spice on map - count towards delivery
    this.noSpiceTimer++;

    if (this.noSpiceDeliveryInterval === 0) {
      // Randomize next delivery interval
      this.noSpiceDeliveryInterval = GameConstants.CASH_NO_SPICE_FREQ_MIN +
        Math.floor(simRng.random() * (GameConstants.CASH_NO_SPICE_FREQ_MAX - GameConstants.CASH_NO_SPICE_FREQ_MIN));
    }

    if (this.noSpiceTimer >= this.noSpiceDeliveryInterval) {
      const amount = GameConstants.CASH_NO_SPICE_AMOUNT_MIN +
        Math.floor(simRng.random() * (GameConstants.CASH_NO_SPICE_AMOUNT_MAX - GameConstants.CASH_NO_SPICE_AMOUNT_MIN));
      // Deliver to all players
      for (let i = 0; i < this.playerCount; i++) {
        this.addSolaris(i, amount);
      }
      EventBus.emit('spice:cashFallback', { amount });
      this.noSpiceTimer = 0;
      this.noSpiceDeliveryInterval = 0; // Re-randomize next time
    }
  }

  /** Get current spice tile count for UI/debug */
  getSpiceTileCount(): number {
    const mw = this.terrain.getMapWidth(), mh = this.terrain.getMapHeight();
    let count = 0;
    for (let tz = 0; tz < mh; tz++) {
      for (let tx = 0; tx < mw; tx++) {
        if (this.terrain.getSpice(tx, tz) > 0) count++;
      }
    }
    return count;
  }

  private handleIdle(eid: number): void {
    // Don't go back to spice while fleeing from damage
    if (this.fleeing.has(eid)) return;
    // Find nearest spice
    const spiceTile = this.findNearestSpice(eid);
    if (!spiceTile) return;

    const worldPos = tileToWorld(spiceTile.tx, spiceTile.tz);
    MoveTarget.x[eid] = worldPos.x + 1;
    MoveTarget.z[eid] = worldPos.z + 1;
    MoveTarget.active[eid] = 1;
    Harvester.state[eid] = MOVING_TO_SPICE;
  }

  private handleMovingToSpice(eid: number): void {
    if (MoveTarget.active[eid] === 1) return; // Still moving

    // Check if we're on spice
    const tile = worldToTile(Position.x[eid], Position.z[eid]);
    const spice = this.terrain.getSpice(tile.tx, tile.tz);
    if (spice > 0) {
      Harvester.state[eid] = HARVESTING;
      this.harvestTimers.set(eid, 0);
    } else {
      // Try again
      Harvester.state[eid] = IDLE;
    }
  }

  private handleHarvesting(eid: number): void {
    const timer = (this.harvestTimers.get(eid) ?? 0) + 1;
    this.harvestTimers.set(eid, timer);

    // Harvest every 5 ticks
    if (timer % 5 !== 0) return;

    const tile = worldToTile(Position.x[eid], Position.z[eid]);
    const spice = this.terrain.getSpice(tile.tx, tile.tz);

    if (spice <= 0 || Harvester.spiceCarried[eid] >= Harvester.maxCapacity[eid]) {
      // Full or no more spice - return to refinery
      Harvester.state[eid] = RETURNING;
      this.returnToRefinery(eid);
      return;
    }

    // Harvest a chunk
    const harvestAmount = Math.min(0.05, spice);
    this.terrain.setSpice(tile.tx, tile.tz, spice - harvestAmount);
    Harvester.spiceCarried[eid] += harvestAmount;
    this.spiceDirty = true;
  }

  private handleReturning(eid: number): void {
    // Carryall airlift: skip walking, teleport after short delay
    const owner = Owner.playerId[eid];
    if (this.playersWithCarryall.has(owner)) {
      const airTimer = this.airlifting.get(eid);
      if (airTimer === undefined) {
        // Start airlift - stop ground movement
        MoveTarget.active[eid] = 0;
        this.airlifting.set(eid, 0);
        return;
      }
      if (airTimer < 50) { // ~2 seconds airlift time
        this.airlifting.set(eid, airTimer + 1);
        // Lift harvester up during airlift
        Position.y[eid] = 0.1 + (airTimer / 50) * 4;
        return;
      }
      // Airlift complete - land adjacent to refinery (try cardinal directions to avoid obstacles)
      this.airlifting.delete(eid);
      const refEntity = Harvester.refineryEntity[eid];
      if (this.isValidRefinery(refEntity)) {
        const rx = Position.x[refEntity];
        const rz = Position.z[refEntity];
        // Try 4 cardinal offsets outside 3x3 building footprint
        const offsets = [[0, 4], [4, 0], [0, -4], [-4, 0]];
        let placed = false;
        for (const [ox, oz] of offsets) {
          const tx = rx + ox;
          const tz = rz + oz;
          const tile = worldToTile(tx, tz);
          if (this.terrain.isPassable(tile.tx, tile.tz)) {
            Position.x[eid] = tx;
            Position.z[eid] = tz;
            placed = true;
            break;
          }
        }
        if (!placed) {
          // Fallback: land south of refinery
          Position.x[eid] = rx;
          Position.z[eid] = rz + 4;
        }
      } else {
        // Refinery died during airlift — find another or go idle
        Position.y[eid] = 0.1;
        this.returnToRefinery(eid); // Sets state to IDLE if no refineries found
        if (Harvester.state[eid] !== IDLE) {
          Harvester.state[eid] = RETURNING;
        }
        return;
      }
      Position.y[eid] = 0.1;
      Harvester.state[eid] = UNLOADING;
      this.harvestTimers.set(eid, 0);
      return;
    }

    if (MoveTarget.active[eid] === 1) return; // Still moving

    // At refinery - unload
    Harvester.state[eid] = UNLOADING;
    this.harvestTimers.set(eid, 0);
  }

  private handleUnloading(eid: number): void {
    const timer = (this.harvestTimers.get(eid) ?? 0) + 1;
    this.harvestTimers.set(eid, timer);

    // Verify refinery is still alive during unload
    const refEntity = Harvester.refineryEntity[eid];
    if (!this.isValidRefinery(refEntity)) {
      this.harvestTimers.delete(eid);
      Harvester.state[eid] = RETURNING;
      this.returnToRefinery(eid);
      return;
    }

    if (timer < 25) return; // Unloading takes 1 second (25 ticks)

    const spiceValue = Harvester.spiceCarried[eid] * GameConstants.SPICE_VALUE;
    const owner = Owner.playerId[eid];
    this.addSolaris(owner, spiceValue);
    EventBus.emit('harvest:delivered', { amount: spiceValue, owner });

    Harvester.spiceCarried[eid] = 0;
    Harvester.state[eid] = IDLE;
  }

  private returnToRefinery(eid: number): void {
    const refineryEntity = Harvester.refineryEntity[eid];
    // Validate refinery is alive and still a refinery (guards against entity ID recycling)
    if (this.isValidRefinery(refineryEntity)) {
      MoveTarget.x[eid] = Position.x[refineryEntity];
      MoveTarget.z[eid] = Position.z[refineryEntity];
    } else {
      // Refinery destroyed — try to find another refinery owned by same player
      const owner = Owner.playerId[eid];
      if (this.world) {
        const blds = buildingQuery(this.world);
        let bestDist = Infinity;
        let bestRef = -1;
        for (const bid of blds) {
          if (Owner.playerId[bid] !== owner || Health.current[bid] <= 0) continue;
          const bTypeId = BuildingType.id[bid];
          const bName = this.buildingTypeNames[bTypeId] ?? '';
          if (!bName.includes('Refinery')) continue;
          const dx = Position.x[bid] - Position.x[eid];
          const dz = Position.z[bid] - Position.z[eid];
          const dist = dx * dx + dz * dz;
          if (dist < bestDist) { bestDist = dist; bestRef = bid; }
        }
        if (bestRef >= 0) {
          Harvester.refineryEntity[eid] = bestRef;
          MoveTarget.x[eid] = Position.x[bestRef];
          MoveTarget.z[eid] = Position.z[bestRef];
        } else {
          // No refineries at all — go idle
          Harvester.state[eid] = IDLE;
          return;
        }
      } else {
        // Fallback: return to map center
        MoveTarget.x[eid] = 60;
        MoveTarget.z[eid] = 60;
      }
    }
    MoveTarget.active[eid] = 1;
  }

  private findNearestSpice(eid: number): { tx: number; tz: number } | null {
    const tile = worldToTile(Position.x[eid], Position.z[eid]);
    let bestDist = Infinity;
    let bestTile: { tx: number; tz: number } | null = null;

    // Search in expanding rings
    for (let r = 0; r < 30; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const tx = tile.tx + dx;
          const tz = tile.tz + dz;
          if (this.terrain.getSpice(tx, tz) > 0) {
            const dist = Math.abs(dx) + Math.abs(dz);
            if (dist < bestDist) {
              bestDist = dist;
              bestTile = { tx, tz };
            }
          }
        }
      }
      if (bestTile) return bestTile;
    }

    return null;
  }
}
