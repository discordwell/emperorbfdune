import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Health, Combat, Owner, AttackTarget, MoveTarget,
  Armour, BuildingType, Veterancy, combatQuery, hasComponent,
} from '../core/ECS';
import type { GameRules } from '../config/RulesParser';
import { distance2D, worldToTile } from '../utils/MathUtils';
import { EventBus } from '../core/EventBus';
import type { FogOfWar } from '../rendering/FogOfWar';

export class CombatSystem implements GameSystem {
  private rules: GameRules;
  private armourTypes: string[] = [];
  private unitTypeMap = new Map<number, string>(); // eid -> unit type name
  // Power multiplier per player: affects building turret fire rate
  private powerMultipliers = new Map<number, number>();
  private fogOfWar: FogOfWar | null = null;
  private localPlayerId = 0;
  private world: World | null = null;
  // Attack-move entities: auto-acquire targets while moving, resume move after
  private attackMoveEntities = new Set<number>();
  // Stored move destinations for attack-move units that pause to fight
  private attackMoveDestinations = new Map<number, { x: number; z: number }>();
  // Buildings disabled due to low power
  private disabledBuildings = new Set<number>();

  constructor(rules: GameRules) {
    this.rules = rules;
  }

  setFogOfWar(fog: FogOfWar, localPlayerId = 0): void {
    this.fogOfWar = fog;
    this.localPlayerId = localPlayerId;
  }

  setPowerMultiplier(playerId: number, multiplier: number): void {
    this.powerMultipliers.set(playerId, multiplier);
  }

  setDisabledBuilding(eid: number, disabled: boolean): void {
    if (disabled) this.disabledBuildings.add(eid);
    else this.disabledBuildings.delete(eid);
  }

  init(_world: World): void {
    this.armourTypes = this.rules.armourTypes;
  }

  registerUnit(eid: number, typeName: string): void {
    this.unitTypeMap.set(eid, typeName);
  }

  unregisterUnit(eid: number): void {
    this.unitTypeMap.delete(eid);
    this.attackMoveEntities.delete(eid);
    this.attackMoveDestinations.delete(eid);
  }

  setAttackMove(eids: number[]): void {
    for (const eid of eids) {
      this.attackMoveEntities.add(eid);
      // Store current move destination so we can resume after fighting
      if (MoveTarget.active[eid] === 1) {
        this.attackMoveDestinations.set(eid, { x: MoveTarget.x[eid], z: MoveTarget.z[eid] });
      }
    }
  }

  clearAttackMove(eids: number[]): void {
    for (const eid of eids) {
      this.attackMoveEntities.delete(eid);
      this.attackMoveDestinations.delete(eid);
    }
  }

  update(world: World, _dt: number): void {
    this.world = world;
    const entities = combatQuery(world);

    for (const eid of entities) {
      // Skip disabled buildings (low power)
      if (this.disabledBuildings.has(eid)) continue;

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
          // If attack-move unit killed its target, resume moving to destination
          if (this.attackMoveEntities.has(eid)) {
            const dest = this.attackMoveDestinations.get(eid);
            if (dest && hasComponent(world, MoveTarget, eid)) {
              MoveTarget.x[eid] = dest.x;
              MoveTarget.z[eid] = dest.z;
              MoveTarget.active[eid] = 1;
            }
          }
        }
      }

      // Auto-acquire target if none
      if (targetEid < 0) {
        const isMoving = hasComponent(world, MoveTarget, eid) && MoveTarget.active[eid] === 1;
        const isBuilding = hasComponent(world, BuildingType, eid);
        // Only auto-acquire if: idle, building, attack-moving, or AI unit
        if (isMoving && !isBuilding && !this.attackMoveEntities.has(eid) && Owner.playerId[eid] === this.localPlayerId) {
          // Normal move — don't auto-acquire
          continue;
        }
        targetEid = this.findNearestEnemy(world, eid, entities);
      }

      if (targetEid < 0) {
        // If attack-move unit has no targets and isn't moving, resume destination
        if (this.attackMoveEntities.has(eid) && hasComponent(world, MoveTarget, eid) && MoveTarget.active[eid] === 0) {
          const dest = this.attackMoveDestinations.get(eid);
          if (dest) {
            const distToDest = distance2D(Position.x[eid], Position.z[eid], dest.x, dest.z);
            if (distToDest > 2.0) {
              MoveTarget.x[eid] = dest.x;
              MoveTarget.z[eid] = dest.z;
              MoveTarget.active[eid] = 1;
            } else {
              // Arrived at destination, clear attack-move
              this.attackMoveEntities.delete(eid);
              this.attackMoveDestinations.delete(eid);
            }
          }
        }
        continue;
      }

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
        } else if (this.attackMoveEntities.has(eid)) {
          // Attack-move: pause movement and chase the enemy
          MoveTarget.x[eid] = Position.x[targetEid];
          MoveTarget.z[eid] = Position.z[targetEid];
          MoveTarget.active[eid] = 1;
        }
        continue;
      }

      // In range — stop to fire if attack-moving
      if (this.attackMoveEntities.has(eid) && hasComponent(world, MoveTarget, eid)) {
        MoveTarget.active[eid] = 0;
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

    // Veterancy damage bonus: +15%/+30%/+50% per rank
    if (hasComponent(world, Veterancy, attackerEid)) {
      const rank = Veterancy.rank[attackerEid];
      const vetBonus = [1.0, 1.15, 1.30, 1.50][rank] ?? 1.0;
      baseDamage = Math.round(baseDamage * vetBonus);
    }

    // Veterancy defense bonus on target: -10%/-20%/-30% damage taken
    if (hasComponent(world, Veterancy, targetEid)) {
      const defRank = Veterancy.rank[targetEid];
      const defBonus = [1.0, 0.9, 0.8, 0.7][defRank] ?? 1.0;
      baseDamage = Math.round(baseDamage * defBonus);
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

    // Notify when local player's units/buildings take damage (only player 0)
    const targetOwner = Owner.playerId[targetEid];
    if (targetOwner === this.localPlayerId && Owner.playerId[attackerEid] !== targetOwner) {
      EventBus.emit('unit:damaged', {
        entityId: targetEid,
        attackerOwner: Owner.playerId[attackerEid],
        x: Position.x[targetEid],
        z: Position.z[targetEid],
        isBuilding: hasComponent(world, BuildingType, targetEid),
      });
    }

    if (Health.current[targetEid] <= 0) {
      Health.current[targetEid] = 0;

      // Grant XP to killer and check rank promotion
      if (hasComponent(world, Veterancy, attackerEid)) {
        Veterancy.xp[attackerEid]++;
        const xp = Veterancy.xp[attackerEid];
        const oldRank = Veterancy.rank[attackerEid];
        // Promote: rank 1=1 kill, rank 2=3 kills, rank 3=5 kills
        const newRank = xp >= 5 ? 3 : xp >= 3 ? 2 : xp >= 1 ? 1 : 0;
        if (newRank > oldRank) {
          Veterancy.rank[attackerEid] = newRank;
          EventBus.emit('unit:promoted', { entityId: attackerEid, rank: newRank });
        }
      }

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

      // Player units can only auto-target enemies in visible fog tiles
      if (myOwner === this.localPlayerId && this.fogOfWar && this.fogOfWar.isEnabled()) {
        const tile = worldToTile(Position.x[other], Position.z[other]);
        if (!this.fogOfWar.isTileVisible(tile.tx, tile.tz)) continue;
      }

      const dist = distance2D(px, pz, Position.x[other], Position.z[other]);
      if (dist < bestDist) {
        bestDist = dist;
        bestTarget = other;
      }
    }

    return bestTarget;
  }
}
