import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Health, Combat, Owner, AttackTarget, MoveTarget,
  Armour, BuildingType, combatQuery, hasComponent,
} from '../core/ECS';
import type { GameRules } from '../config/RulesParser';
import { distance2D } from '../utils/MathUtils';
import { EventBus } from '../core/EventBus';

export class CombatSystem implements GameSystem {
  private rules: GameRules;
  private armourTypes: string[] = [];
  private unitTypeMap = new Map<number, string>(); // eid -> unit type name
  // Power multiplier per player: affects building turret fire rate
  private powerMultipliers = new Map<number, number>();

  constructor(rules: GameRules) {
    this.rules = rules;
  }

  setPowerMultiplier(playerId: number, multiplier: number): void {
    this.powerMultipliers.set(playerId, multiplier);
  }

  init(_world: World): void {
    this.armourTypes = this.rules.armourTypes;
  }

  registerUnit(eid: number, typeName: string): void {
    this.unitTypeMap.set(eid, typeName);
  }

  unregisterUnit(eid: number): void {
    this.unitTypeMap.delete(eid);
  }

  update(world: World, _dt: number): void {
    const entities = combatQuery(world);

    for (const eid of entities) {
      // Decrement fire timer
      if (Combat.fireTimer[eid] > 0) {
        Combat.fireTimer[eid]--;
      }

      // Check for explicit attack target
      let targetEid = -1;

      if (hasComponent(world, AttackTarget, eid) && AttackTarget.active[eid] === 1) {
        targetEid = AttackTarget.entityId[eid];
        if (!hasComponent(world, Health, targetEid) || Health.current[targetEid] <= 0) {
          AttackTarget.active[eid] = 0;
          targetEid = -1;
        }
      }

      // Auto-acquire target if none
      if (targetEid < 0) {
        targetEid = this.findNearestEnemy(world, eid, entities);
      }

      if (targetEid < 0) continue;

      const dist = distance2D(
        Position.x[eid], Position.z[eid],
        Position.x[targetEid], Position.z[targetEid]
      );

      const range = Combat.attackRange[eid];

      if (dist > range) {
        // Move toward target if we have an explicit attack target
        if (hasComponent(world, AttackTarget, eid) && AttackTarget.active[eid] === 1) {
          if (hasComponent(world, MoveTarget, eid)) {
            MoveTarget.x[eid] = Position.x[targetEid];
            MoveTarget.z[eid] = Position.z[targetEid];
            MoveTarget.active[eid] = 1;
          }
        }
        continue;
      }

      // Only fire when cooldown is done
      if (Combat.fireTimer[eid] > 0) continue;

      this.fire(world, eid, targetEid);
      // Buildings fire slower when low on power
      let rof = Combat.rof[eid];
      if (hasComponent(world, BuildingType, eid)) {
        const mult = this.powerMultipliers.get(Owner.playerId[eid]) ?? 1.0;
        if (mult < 1.0) rof = Math.ceil(rof / mult); // Lower mult = slower fire
      }
      Combat.fireTimer[eid] = rof;
    }
  }

  private fire(world: World, attackerEid: number, targetEid: number): void {
    // Look up weapon damage
    const weaponId = Combat.weaponId[attackerEid];
    // For now, use a simplified damage model
    // weaponId indexes into a runtime array; we store base damage in rof for simplicity
    // In a full impl, look up turret -> bullet -> warhead chain

    let baseDamage = 100; // Default
    const typeName = this.unitTypeMap.get(attackerEid);
    if (typeName) {
      const unitDef = this.rules.units.get(typeName);
      if (unitDef?.turretAttach) {
        const turret = this.rules.turrets.get(unitDef.turretAttach);
        if (turret?.bullet) {
          const bullet = this.rules.bullets.get(turret.bullet);
          if (bullet) {
            baseDamage = bullet.damage;
            // Apply warhead vs armor
            if (bullet.warhead && hasComponent(world, Armour, targetEid)) {
              const warhead = this.rules.warheads.get(bullet.warhead);
              const armourIdx = Armour.type[targetEid];
              const armourName = this.armourTypes[armourIdx] ?? 'None';
              if (warhead) {
                const multiplier = (warhead.vs[armourName] ?? 100) / 100;
                baseDamage = Math.round(baseDamage * multiplier);
              }
            }
          }
        }
      }
    }

    // Emit fire event for visual projectile
    EventBus.emit('combat:fire', {
      attackerX: Position.x[attackerEid],
      attackerZ: Position.z[attackerEid],
      targetX: Position.x[targetEid],
      targetZ: Position.z[targetEid],
    });

    // Apply damage
    Health.current[targetEid] -= baseDamage;

    if (Health.current[targetEid] <= 0) {
      Health.current[targetEid] = 0;
      EventBus.emit('unit:died', { entityId: targetEid, killerEntity: attackerEid });
    }
  }

  private findNearestEnemy(world: World, eid: number, entities: readonly number[]): number {
    const myOwner = Owner.playerId[eid];
    const viewRange = Combat.attackRange[eid] * 2; // Auto-acquire at 2x attack range
    let bestDist = viewRange * 2; // In world units (tiles * TILE_SIZE)
    let bestTarget = -1;

    const px = Position.x[eid];
    const pz = Position.z[eid];

    for (const other of entities) {
      if (Owner.playerId[other] === myOwner) continue;
      if (!hasComponent(world, Health, other)) continue;
      if (Health.current[other] <= 0) continue;

      const dist = distance2D(px, pz, Position.x[other], Position.z[other]);
      if (dist < bestDist) {
        bestDist = dist;
        bestTarget = other;
      }
    }

    return bestTarget;
  }
}
