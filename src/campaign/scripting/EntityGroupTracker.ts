/**
 * Tracks named entity groups for mission scripts.
 *
 * After spawning entities for a group, register their IDs here.
 * The tracker filters out dead entities when queried.
 */

import { Health, Position } from '../../core/ECS';

export class EntityGroupTracker {
  private groups = new Map<string, number[]>();

  /** Register entity IDs for a named group. */
  registerGroup(name: string, entityIds: number[]): void {
    const existing = this.groups.get(name);
    if (existing) {
      existing.push(...entityIds);
    } else {
      this.groups.set(name, [...entityIds]);
    }
  }

  /** Get all living entity IDs in a group. */
  getAlive(name: string): number[] {
    const ids = this.groups.get(name);
    if (!ids) return [];
    return ids.filter(eid => Health.current[eid] > 0);
  }

  /** Check if all entities in a group are dead. */
  isDefeated(name: string): boolean {
    const ids = this.groups.get(name);
    if (!ids || ids.length === 0) return false;
    return ids.every(eid => Health.current[eid] <= 0);
  }

  /** Check if the group centroid is within a radius of a point. */
  isGroupInArea(name: string, x: number, z: number, radius: number): boolean {
    const alive = this.getAlive(name);
    if (alive.length === 0) return false;
    const r2 = radius * radius;
    // Check if the group centroid is in the area
    let cx = 0, cz = 0;
    for (const eid of alive) {
      cx += Position.x[eid];
      cz += Position.z[eid];
    }
    cx /= alive.length;
    cz /= alive.length;
    const dx = cx - x;
    const dz = cz - z;
    return dx * dx + dz * dz <= r2;
  }

  /** Check if a group exists. */
  hasGroup(name: string): boolean {
    return this.groups.has(name);
  }

  /** Get all group names. */
  getGroupNames(): string[] {
    return [...this.groups.keys()];
  }

  /** Get all entity IDs in a group (alive or dead). */
  getAll(name: string): number[] {
    return this.groups.get(name) ?? [];
  }

  /** Serialize state for save/load. */
  serialize(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [name, ids] of this.groups) {
      out[name] = [...ids];
    }
    return out;
  }

  /** Restore state from save data. */
  restore(data: Record<string, number[]>): void {
    this.groups.clear();
    for (const [name, ids] of Object.entries(data)) {
      this.groups.set(name, [...ids]);
    }
  }

  /** Clear all groups. */
  clear(): void {
    this.groups.clear();
  }
}
