import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Harvester, MoveTarget, Owner, Health, BuildingType,
  harvestQuery, buildingQuery,
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
  private bloomInterval = 500; // ~20 seconds between bloom checks
  // Pending bloom: coordinates of upcoming spice bloom (for pre-warning effect)
  private pendingBloom: { tx: number; tz: number; ticksLeft: number } | null = null;
  // Carryall: players that have a Hanger get auto-airlift for harvesters
  private playersWithCarryall = new Set<number>();
  // Harvesters being airlifted: eid -> ticks remaining
  private airlifting = new Map<number, number>();

  // Income rate tracking
  private lastSolarisSnapshot = 0;
  // Tracked harvester entity IDs
  private knownHarvesters = new Set<number>();
  // Harvesters that recently took damage - flee to refinery
  private fleeing = new Set<number>();
  // Building lookup for refinery reassignment
  private world: World | null = null;
  private buildingTypeNames: string[] = [];

  constructor(terrain: TerrainRenderer) {
    this.terrain = terrain;

    // Harvesters flee when damaged (unless already returning/unloading)
    EventBus.on('unit:damaged', ({ entityId }) => {
      if (!this.knownHarvesters.has(entityId)) return;
      const state = Harvester.state[entityId];
      if (state !== RETURNING && state !== UNLOADING) {
        Harvester.state[entityId] = RETURNING;
        this.returnToRefinery(entityId);
        this.fleeing.add(entityId);
        // Clear flee flag after 10 seconds so they can resume
        setTimeout(() => {
          if (this.knownHarvesters.has(entityId)) this.fleeing.delete(entityId);
        }, 10000);
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
    // Start all players with initial credits
    for (let i = 0; i < playerCount; i++) {
      this.solaris.set(i, 5000);
    }
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

    for (const eid of entities) {
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

    // Spice bloom: periodically regenerate spice on sand tiles
    this.tickCounter++;

    // Process pending bloom countdown
    if (this.pendingBloom) {
      this.pendingBloom.ticksLeft--;
      // Emit tremor events during countdown for visual effects
      if (this.pendingBloom.ticksLeft % 25 === 0 && this.pendingBloom.ticksLeft > 0) {
        const wx = tileToWorld(this.pendingBloom.tx, this.pendingBloom.tz);
        EventBus.emit('bloom:tremor', { x: wx.x, z: wx.z, intensity: 1 - this.pendingBloom.ticksLeft / 125 });
      }
      if (this.pendingBloom.ticksLeft <= 0) {
        this.executeBloom(this.pendingBloom.tx, this.pendingBloom.tz);
        this.pendingBloom = null;
      }
    }

    if (this.tickCounter % this.bloomInterval === 0 && !this.pendingBloom) {
      this.scheduleBloom();
    }

    // Update UI with flash animation
    const p0Credits = this.solaris.get(0) ?? 0;
    const el = document.getElementById('solaris-count');
    if (el) {
      const prev = parseInt(el.textContent ?? '0', 10);
      const current = Math.floor(p0Credits);
      el.textContent = String(current);
      if (current > prev) {
        el.classList.remove('flash-red');
        el.classList.add('flash-green');
        setTimeout(() => el.classList.remove('flash-green'), 400);
      } else if (current < prev) {
        el.classList.remove('flash-green');
        el.classList.add('flash-red');
        setTimeout(() => el.classList.remove('flash-red'), 400);
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

  private scheduleBloom(): void {
    // Count current spice tiles
    const mw = this.terrain.getMapWidth(), mh = this.terrain.getMapHeight();
    let spiceTileCount = 0;
    for (let tz = 0; tz < mh; tz++) {
      for (let tx = 0; tx < mw; tx++) {
        if (this.terrain.getSpice(tx, tz) > 0) spiceTileCount++;
      }
    }

    if (spiceTileCount >= 20) return;

    // Find a valid sand tile for the bloom
    for (let attempt = 0; attempt < 50; attempt++) {
      const tx = 10 + Math.floor(Math.random() * Math.max(1, mw - 20));
      const tz = 10 + Math.floor(Math.random() * Math.max(1, mh - 20));
      const type = this.terrain.getTerrainType(tx, tz);
      if (type === TerrainType.Sand) {
        // Schedule bloom with 5-second warning (125 ticks)
        this.pendingBloom = { tx, tz, ticksLeft: 125 };
        const wx = tileToWorld(tx, tz);
        EventBus.emit('bloom:warning', { x: wx.x, z: wx.z });
        return;
      }
    }
  }

  private executeBloom(tx: number, tz: number): void {
    // Create a small spice patch (3x3 to 5x5)
    const radius = 1 + Math.floor(Math.random() * 2);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const stx = tx + dx;
        const stz = tz + dz;
        if (stx < 0 || stx >= this.terrain.getMapWidth() || stz < 0 || stz >= this.terrain.getMapHeight()) continue;
        if (this.terrain.getTerrainType(stx, stz) !== TerrainType.Sand) continue;
        const amount = 0.3 + Math.random() * 0.7;
        this.terrain.setSpice(stx, stz, amount);
      }
    }
    const wx = tileToWorld(tx, tz);
    EventBus.emit('bloom:eruption', { x: wx.x, z: wx.z });
  }

  private handleIdle(eid: number): void {
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
      // Airlift complete - teleport to refinery
      this.airlifting.delete(eid);
      const refEntity = Harvester.refineryEntity[eid];
      if (refEntity > 0) {
        Position.x[eid] = Position.x[refEntity];
        Position.z[eid] = Position.z[refEntity];
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

    if (timer < 25) return; // Unloading takes 1 second (25 ticks)

    const spiceValue = Harvester.spiceCarried[eid] * GameConstants.SPICE_VALUE * 100;
    const owner = Owner.playerId[eid];
    this.addSolaris(owner, spiceValue);
    EventBus.emit('harvest:delivered', { amount: spiceValue, owner });

    Harvester.spiceCarried[eid] = 0;
    Harvester.state[eid] = IDLE;
  }

  private returnToRefinery(eid: number): void {
    const refineryEntity = Harvester.refineryEntity[eid];
    // Validate refinery is alive
    if (refineryEntity > 0 && Health.current[refineryEntity] > 0) {
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
