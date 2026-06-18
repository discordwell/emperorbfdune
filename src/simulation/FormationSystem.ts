/**
 * FormationSystem - Manages formation groups for coordinated unit movement.
 *
 * When a group of units is given a move command together, they are assigned
 * a shared formation ID. Units in a formation:
 *   - Move toward individual offset positions (grid formation)
 *   - Cap their speed to the slowest member
 *   - Break formation when they engage in combat
 *
 * Formation data is stored as a system-level map (not an ECS component)
 * to keep it lightweight and easy to manage.
 */

import { Speed, Health, MoveTarget, AttackTarget, hasComponent } from '../core/ECS';
import type { World } from '../core/ECS';

export interface FormationGroup {
  id: number;
  /** Entity IDs in this formation */
  members: number[];
  /** The slowest Speed.max among members at creation time */
  slowestSpeed: number;
  /** Target center point (the original click destination) */
  targetX: number;
  targetZ: number;
}

export class FormationSystem {
  /** Formation ID counter */
  private nextFormationId = 1;
  /** Entity -> formation ID */
  private entityFormation = new Map<number, number>();
  /** Formation ID -> FormationGroup */
  private formations = new Map<number, FormationGroup>();

  /**
   * Create a new formation group for the given entities heading to (targetX, targetZ).
   * Returns the formation ID. Single units do not get a formation.
   */
  createFormation(entityIds: number[], targetX: number, targetZ: number): number | null {
    if (entityIds.length <= 1) return null;

    const id = this.nextFormationId++;

    // Remove these entities from any existing formation
    for (const eid of entityIds) {
      this.removeFromFormation(eid);
    }

    const group: FormationGroup = {
      id,
      members: [...entityIds],
      slowestSpeed: 0,
      targetX,
      targetZ,
    };
    // Cap the formation to its slowest member so the group stays together.
    this.recomputeSlowest(group);

    this.formations.set(id, group);
    for (const eid of entityIds) {
      this.entityFormation.set(eid, id);
    }

    return id;
  }

  /**
   * Recompute a group's speed cap from its current members. Called whenever
   * membership changes so survivors are not held to a departed member's speed.
   * Falls back to 0 (no cap) if no member has a valid speed.
   */
  private recomputeSlowest(group: FormationGroup): void {
    let slowest = Infinity;
    for (const eid of group.members) {
      const s = Speed.max[eid];
      if (s > 0 && s < slowest) {
        slowest = s;
      }
    }
    group.slowestSpeed = isFinite(slowest) && slowest > 0 ? slowest : 0;
  }

  /**
   * Get the formation group for an entity, or null if not in a formation.
   */
  getFormation(eid: number): FormationGroup | null {
    const fid = this.entityFormation.get(eid);
    if (fid === undefined) return null;
    return this.formations.get(fid) ?? null;
  }

  /**
   * Get the formation speed cap for an entity.
   * Returns the slowest speed in the formation, or 0 if not in a formation
   * (0 means no cap should be applied).
   */
  getFormationSpeedCap(eid: number): number {
    const group = this.getFormation(eid);
    if (!group) return 0;
    return group.slowestSpeed;
  }

  /**
   * Remove a single entity from its formation.
   * If the formation drops to 1 or fewer members, dissolve it.
   */
  removeFromFormation(eid: number): void {
    const fid = this.entityFormation.get(eid);
    if (fid === undefined) return;

    this.entityFormation.delete(eid);
    const group = this.formations.get(fid);
    if (!group) return;

    const idx = group.members.indexOf(eid);
    if (idx >= 0) group.members.splice(idx, 1);

    // Dissolve formation if 1 or fewer members remain
    if (group.members.length <= 1) {
      for (const remaining of group.members) {
        this.entityFormation.delete(remaining);
      }
      this.formations.delete(fid);
    } else if (idx >= 0) {
      // A member left — the slowest unit may have been the one removed.
      this.recomputeSlowest(group);
    }
  }

  /**
   * Break formation for an entity that has entered combat.
   * The entity leaves the formation but the rest continue.
   */
  breakFormationForCombat(eid: number): void {
    this.removeFromFormation(eid);
  }

  /**
   * Dissolve an entire formation (e.g., stop command).
   */
  dissolveFormation(formationId: number): void {
    const group = this.formations.get(formationId);
    if (!group) return;
    for (const eid of group.members) {
      this.entityFormation.delete(eid);
    }
    this.formations.delete(formationId);
  }

  /**
   * Clean up all formation state for a dead/removed entity.
   */
  unregisterEntity(eid: number): void {
    this.removeFromFormation(eid);
  }

  /**
   * Per-tick update: check for entities that have entered combat or arrived,
   * and remove them from their formations.
   */
  update(world: World): void {
    // Iterate all formations and prune dead/combat/arrived members
    for (const [fid, group] of this.formations) {
      let changed = false;
      for (let i = group.members.length - 1; i >= 0; i--) {
        const eid = group.members[i];

        // Remove dead entities
        if (hasComponent(world, Health, eid) && Health.current[eid] <= 0) {
          group.members.splice(i, 1);
          this.entityFormation.delete(eid);
          changed = true;
          continue;
        }

        // Remove entities that have entered combat (have an active attack target)
        if (AttackTarget.active[eid] === 1) {
          group.members.splice(i, 1);
          this.entityFormation.delete(eid);
          changed = true;
          continue;
        }

        // Remove entities that have arrived (no active move target)
        if (MoveTarget.active[eid] !== 1) {
          group.members.splice(i, 1);
          this.entityFormation.delete(eid);
          changed = true;
          continue;
        }
      }

      if (changed) {
        if (group.members.length <= 1) {
          // Dissolve formation if 1 or fewer members remain
          for (const remaining of group.members) {
            this.entityFormation.delete(remaining);
          }
          this.formations.delete(fid);
        } else {
          // Members were pruned (dead/combat/arrived) — the slowest may be gone,
          // so survivors should no longer be capped to its speed.
          this.recomputeSlowest(group);
        }
      }
    }
  }

  /**
   * Check if an entity is in a formation.
   */
  isInFormation(eid: number): boolean {
    return this.entityFormation.has(eid);
  }

  /**
   * Get all formation IDs (for debugging/save-load).
   */
  getAllFormations(): Map<number, FormationGroup> {
    return this.formations;
  }

  /**
   * Clear all formation data.
   */
  clear(): void {
    this.entityFormation.clear();
    this.formations.clear();
  }
}
