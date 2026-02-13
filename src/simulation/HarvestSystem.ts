import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Harvester, MoveTarget, Owner,
  harvestQuery,
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

  constructor(terrain: TerrainRenderer) {
    this.terrain = terrain;
  }

  init(_world: World): void {
    // Start players with initial credits
    this.solaris.set(0, 5000);
    this.solaris.set(1, 5000);
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

    for (const eid of entities) {
      const state = Harvester.state[eid];

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
    if (this.tickCounter % this.bloomInterval === 0) {
      this.spiceBloom();
    }

    // Update UI
    const p0Credits = this.solaris.get(0) ?? 0;
    const el = document.getElementById('solaris-count');
    if (el) el.textContent = String(Math.floor(p0Credits));
  }

  private spiceBloom(): void {
    // Count current spice tiles
    let spiceTileCount = 0;
    for (let tz = 0; tz < 128; tz++) {
      for (let tx = 0; tx < 128; tx++) {
        if (this.terrain.getSpice(tx, tz) > 0) spiceTileCount++;
      }
    }

    // If less than 20 spice tiles, spawn a bloom
    if (spiceTileCount < 20) {
      // Find a random sand tile and create a spice patch
      for (let attempt = 0; attempt < 50; attempt++) {
        const tx = 10 + Math.floor(Math.random() * 108);
        const tz = 10 + Math.floor(Math.random() * 108);
        const type = this.terrain.getTerrainType(tx, tz);
        if (type === TerrainType.Sand) {
          // Create a small spice patch (3x3 to 5x5)
          const radius = 1 + Math.floor(Math.random() * 2);
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const stx = tx + dx;
              const stz = tz + dz;
              if (stx < 0 || stx >= 128 || stz < 0 || stz >= 128) continue;
              if (this.terrain.getTerrainType(stx, stz) !== TerrainType.Sand) continue;
              const amount = 0.3 + Math.random() * 0.7;
              this.terrain.setSpice(stx, stz, amount);
            }
          }
          break;
        }
      }
    }
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
    // Find nearest refinery (for now, go to a fixed position near start base)
    // In full implementation, look up refinery entities
    const refineryEntity = Harvester.refineryEntity[eid];
    if (refineryEntity > 0) {
      MoveTarget.x[eid] = Position.x[refineryEntity];
      MoveTarget.z[eid] = Position.z[refineryEntity];
    } else {
      // Fallback: return to map center-ish
      MoveTarget.x[eid] = 60;
      MoveTarget.z[eid] = 60;
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
