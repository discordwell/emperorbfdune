/**
 * Per-tick simulation state hash for desync detection.
 * Uses a fast FNV-1a-inspired hash over key ECS component data.
 * Lightweight enough to run every 25 ticks in multiplayer/replay mode.
 */

import {
  Position, Health, Owner, UnitType, BuildingType,
  MoveTarget, AttackTarget, Harvester, Veterancy, Combat, Shield,
  Speed, Production,
  unitQuery, buildingQuery, hasComponent,
} from './ECS';
import type { World } from './ECS';
import { simRng } from '../utils/DeterministicRNG';

/**
 * Compute a 32-bit hash of the current simulation state.
 * Hashes: RNG state, entity positions, health, owners, movement, combat,
 * harvester state, attack targets, production, credits.
 * Does NOT hash rendering-only state (Renderable, Selectable, etc.).
 */
export function computeSimulationHash(world: World, playerCredits?: number[]): number {
  let h = 0x811c9dc5; // FNV offset basis

  // Hash RNG state (most important — if this diverges, everything diverges)
  const rngState = simRng.getState();
  h = fnvMix(h, rngState[0]);
  h = fnvMix(h, rngState[1]);
  h = fnvMix(h, rngState[2]);
  h = fnvMix(h, rngState[3]);

  // Hash player credits
  if (playerCredits) {
    for (let i = 0; i < playerCredits.length; i++) {
      h = fnvMixF32(h, playerCredits[i]);
    }
  }

  // Hash all units
  const units = unitQuery(world);
  for (let i = 0; i < units.length; i++) {
    const eid = units[i];
    h = fnvMix(h, eid);
    h = fnvMixF32(h, Position.x[eid]);
    h = fnvMixF32(h, Position.z[eid]);
    h = fnvMixF32(h, Health.current[eid]);
    h = fnvMix(h, Owner.playerId[eid]);
    h = fnvMix(h, UnitType.id[eid]);
    h = fnvMix(h, MoveTarget.active[eid]);
    if (MoveTarget.active[eid]) {
      h = fnvMixF32(h, MoveTarget.x[eid]);
      h = fnvMixF32(h, MoveTarget.z[eid]);
    }
    h = fnvMix(h, AttackTarget.active[eid]);
    if (AttackTarget.active[eid]) {
      h = fnvMix(h, AttackTarget.entityId[eid]);
    }
    h = fnvMixF32(h, Combat.fireTimer[eid]);
    h = fnvMixF32(h, Speed.max[eid]);
    h = fnvMix(h, Veterancy.rank[eid]);
    // Harvester state
    if (hasComponent(world, Harvester, eid)) {
      h = fnvMix(h, Harvester.state[eid]);
      h = fnvMixF32(h, Harvester.spiceCarried[eid]);
    }
    // Shield
    h = fnvMixF32(h, Shield.current[eid]);
    h = fnvMixF32(h, Shield.max[eid]);
  }

  // Hash all buildings
  const buildings = buildingQuery(world);
  for (let i = 0; i < buildings.length; i++) {
    const eid = buildings[i];
    h = fnvMix(h, eid);
    h = fnvMixF32(h, Position.x[eid]);
    h = fnvMixF32(h, Position.z[eid]);
    h = fnvMixF32(h, Health.current[eid]);
    h = fnvMix(h, Owner.playerId[eid]);
    h = fnvMix(h, BuildingType.id[eid]);
    // Production state
    if (hasComponent(world, Production, eid)) {
      h = fnvMix(h, Production.queueSlot0[eid]);
      h = fnvMixF32(h, Production.progress[eid]);
      h = fnvMix(h, Production.active[eid]);
    }
  }

  return h >>> 0; // Ensure unsigned
}

/** FNV-1a mix step for a 32-bit integer */
function fnvMix(h: number, val: number): number {
  h ^= val & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (val >>> 8) & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (val >>> 16) & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (val >>> 24) & 0xff;
  h = Math.imul(h, 0x01000193);
  return h;
}

/** FNV-1a mix step for a float32 (reinterpret bits as u32) */
const f32Buf = new Float32Array(1);
const u32View = new Uint32Array(f32Buf.buffer);

function fnvMixF32(h: number, val: number): number {
  f32Buf[0] = val;
  return fnvMix(h, u32View[0]);
}

/**
 * Hash history for desync detection.
 * Uses a Map for sparse tick recording (hashes computed every N ticks).
 * Automatically evicts entries older than maxAge ticks.
 */
export class SimulationHashTracker {
  private hashes = new Map<number, number>();

  constructor(private maxAge = 6400) {} // ~256 seconds at 25 TPS

  /** Record a hash for the given tick */
  record(tick: number, hash: number): void {
    this.hashes.set(tick, hash);
    // Evict old entries
    if (this.hashes.size > this.maxAge / 25) {
      const cutoff = tick - this.maxAge;
      for (const t of this.hashes.keys()) {
        if (t <= cutoff) this.hashes.delete(t);
        else break; // Map iterates in insertion order
      }
    }
  }

  /** Get the hash for a specific tick, or null if not available */
  getHash(tick: number): number | null {
    return this.hashes.get(tick) ?? null;
  }

  /** Compare a remote hash against our recorded hash for the same tick */
  verify(tick: number, remoteHash: number): 'match' | 'mismatch' | 'unavailable' {
    const local = this.getHash(tick);
    if (local === null) return 'unavailable';
    return local === remoteHash ? 'match' : 'mismatch';
  }

  /** Get the most recent recorded tick number */
  getLatestTick(): number {
    let latest = 0;
    for (const t of this.hashes.keys()) {
      latest = t;
    }
    return latest;
  }

  /** Reset the tracker */
  reset(): void {
    this.hashes.clear();
  }
}
