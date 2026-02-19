import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Health, Combat, Owner, AttackTarget, MoveTarget, Rotation, Speed,
  Armour, BuildingType, Veterancy, TurretRotation,
  combatQuery, healthQuery, hasComponent,
} from '../core/ECS';
import type { GameRules } from '../config/RulesParser';
import type { BulletDef } from '../config/WeaponDefs';
import { distance2D, worldToTile, angleBetween, lerpAngle } from '../utils/MathUtils';
import { EventBus } from '../core/EventBus';
import type { FogOfWar } from '../rendering/FogOfWar';
import type { TerrainRenderer } from '../rendering/TerrainRenderer';
import { TerrainType } from '../rendering/TerrainRenderer';
import type { SpatialGrid } from '../utils/SpatialGrid';

const TILE_SIZE = 2;

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
  // Unit stances: 0=aggressive (chase), 1=defensive (fight in range, don't chase), 2=hold (fire only)
  private stances = new Map<number, number>();
  // Stealthed entities (idle stealth units, can't be auto-targeted)
  private stealthedEntities = new Set<number>();
  // Guard positions: units return here after combat
  private guardPositions = new Map<number, { x: number; z: number }>();
  // Escort targets: units follow and protect this entity
  private escortTargets = new Map<number, number>(); // escorter eid -> target eid
  // Faction prefix per player (for faction-specific damage bonuses)
  private playerFactions = new Map<number, string>();
  // Suppressed entities: skip combat entirely (rearming aircraft, etc.)
  private suppressedEntities = new Set<number>();
  // Bullet definition lookup cache: turret name -> BulletDef (null if not found)
  private bulletCache = new Map<string, BulletDef | null>();
  // Spatial grid from MovementSystem for efficient neighbor queries
  private spatialGrid: SpatialGrid | null = null;
  // Entities that fired this tick (for animation triggering)
  private recentlyFired = new Set<number>();
  // Hit slowdown: target eid -> { ticksLeft, speedReduction (0-100%) }
  private hitSlowdowns = new Map<number, { ticksLeft: number; amount: number }>();
  // Infantry suppression timers (1/5 chance on hit, 200 tick duration, stops firing)
  // Uses separate set from suppressedEntities to avoid conflicts with aircraft rearming etc.
  private suppressionTimers = new Map<number, number>(); // eid -> ticksLeft
  private infantrySuppressed = new Set<number>();
  // Terrain reference for height/infantry rock bonuses
  private terrain: TerrainRenderer | null = null;

  constructor(rules: GameRules) {
    this.rules = rules;
  }

  setPlayerFaction(playerId: number, prefix: string): void {
    this.playerFactions.set(playerId, prefix);
  }

  setSpatialGrid(grid: SpatialGrid): void {
    this.spatialGrid = grid;
  }

  setTerrain(terrain: TerrainRenderer): void {
    this.terrain = terrain;
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

  setStance(eid: number, stance: number): void {
    this.stances.set(eid, stance);
  }

  setStealthed(eid: number, stealthed: boolean): void {
    if (stealthed) this.stealthedEntities.add(eid);
    else this.stealthedEntities.delete(eid);
  }

  setSuppressed(eid: number, suppressed: boolean): void {
    if (suppressed) this.suppressedEntities.add(eid);
    else this.suppressedEntities.delete(eid);
  }

  getStance(eid: number): number {
    return this.stances.get(eid) ?? 1; // Default: defensive
  }

  setGuardPosition(eid: number, x: number, z: number): void {
    this.guardPositions.set(eid, { x, z });
  }

  clearGuardPosition(eid: number): void {
    this.guardPositions.delete(eid);
  }

  setEscortTarget(eid: number, targetEid: number): void {
    this.escortTargets.set(eid, targetEid);
  }

  clearEscortTarget(eid: number): void {
    this.escortTargets.delete(eid);
  }

  getEscortTarget(eid: number): number | undefined {
    return this.escortTargets.get(eid);
  }

  init(_world: World): void {
    this.armourTypes = this.rules.armourTypes;
  }

  registerUnit(eid: number, typeName: string): void {
    this.unitTypeMap.set(eid, typeName);
  }

  unregisterUnit(eid: number): void {
    this.unitTypeMap.delete(eid);
    this.hitSlowdowns.delete(eid);
    this.suppressionTimers.delete(eid);
    this.infantrySuppressed.delete(eid);
    this.attackMoveEntities.delete(eid);
    this.attackMoveDestinations.delete(eid);
    this.stances.delete(eid);
    this.guardPositions.delete(eid);
    this.escortTargets.delete(eid);
    // Clear any units escorting this entity
    for (const [escorter, target] of this.escortTargets) {
      if (target === eid) this.escortTargets.delete(escorter);
    }
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

  isAttackMove(eid: number): boolean {
    return this.attackMoveEntities.has(eid);
  }

  /** Check if an entity just fired (for animation triggering) */
  hasFiredThisTick(eid: number): boolean {
    return this.recentlyFired.has(eid);
  }

  /** Get speed multiplier for hit slowdown + suppression (1.0 = normal, lower = slowed) */
  getHitSlowdownMultiplier(eid: number): number {
    let mult = 1.0;
    const slow = this.hitSlowdowns.get(eid);
    if (slow) mult = Math.max(0.1, 1.0 - slow.amount / 100);
    // Suppressed infantry move at 50% speed
    if (this.infantrySuppressed.has(eid)) mult *= 0.5;
    return mult;
  }

  /** Check if an entity is suppressed by combat (infantry suppression) */
  isSuppressed(eid: number): boolean {
    return this.infantrySuppressed.has(eid);
  }

  update(world: World, _dt: number): void {
    this.world = world;
    this.recentlyFired.clear();

    // Tick down hit slowdowns
    for (const [eid, slow] of this.hitSlowdowns) {
      slow.ticksLeft--;
      if (slow.ticksLeft <= 0) this.hitSlowdowns.delete(eid);
    }

    // Tick down infantry suppression timers (separate from aircraft/leech suppression)
    for (const [eid, ticksLeft] of this.suppressionTimers) {
      if (ticksLeft <= 1) {
        this.suppressionTimers.delete(eid);
        this.infantrySuppressed.delete(eid);
      } else {
        this.suppressionTimers.set(eid, ticksLeft - 1);
      }
    }

    // Update escort targets: follow the escorted unit
    for (const [escorter, targetEid] of this.escortTargets) {
      if (!hasComponent(world, Health, targetEid) || Health.current[targetEid] <= 0) {
        this.escortTargets.delete(escorter);
        this.guardPositions.delete(escorter);
        continue;
      }
      // Update guard position to target's current position
      const tx = Position.x[targetEid];
      const tz = Position.z[targetEid];
      this.guardPositions.set(escorter, { x: tx, z: tz });

      // If not in combat and too far from target, follow
      if (hasComponent(world, MoveTarget, escorter) &&
          hasComponent(world, AttackTarget, escorter) &&
          AttackTarget.active[escorter] === 0 &&
          MoveTarget.active[escorter] === 0) {
        const dx = Position.x[escorter] - tx;
        const dz = Position.z[escorter] - tz;
        if (dx * dx + dz * dz > 25) { // Follow if > 5 units away
          MoveTarget.x[escorter] = tx + (Math.random() - 0.5) * 3;
          MoveTarget.z[escorter] = tz + (Math.random() - 0.5) * 3;
          MoveTarget.active[escorter] = 1;
        }
      }
    }

    const entities = combatQuery(world);

    for (const eid of entities) {
      // Skip disabled buildings (low power), suppressed units (rearming), or infantry suppressed by combat
      if (this.disabledBuildings.has(eid)) continue;
      if (this.suppressedEntities.has(eid)) continue;
      if (this.infantrySuppressed.has(eid)) continue;

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
          } else {
            // Return to guard position if set
            const guardPos = this.guardPositions.get(eid);
            if (guardPos && hasComponent(world, MoveTarget, eid)) {
              MoveTarget.x[eid] = guardPos.x;
              MoveTarget.z[eid] = guardPos.z;
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
        // Return to guard position if idle and no targets
        if (!this.attackMoveEntities.has(eid) && hasComponent(world, MoveTarget, eid) && MoveTarget.active[eid] === 0) {
          const guardPos = this.guardPositions.get(eid);
          if (guardPos) {
            const distToGuard = distance2D(Position.x[eid], Position.z[eid], guardPos.x, guardPos.z);
            if (distToGuard > 3.0) {
              MoveTarget.x[eid] = guardPos.x;
              MoveTarget.z[eid] = guardPos.z;
              MoveTarget.active[eid] = 1;
            }
          }
        }
        continue;
      }

      const dist = distance2D(
        Position.x[eid], Position.z[eid],
        Position.x[targetEid], Position.z[targetEid]
      );

      let range = Combat.attackRange[eid];

      // Terrain range bonuses
      if (this.terrain) {
        const aTypeName = this.unitTypeMap.get(eid);
        const aDef = aTypeName ? this.rules.units.get(aTypeName) : null;
        if (aDef && aDef.getsHeightAdvantage) {
          const aTile = worldToTile(Position.x[eid], Position.z[eid]);
          const tt = this.terrain.getTerrainType(aTile.tx, aTile.tz);
          if (tt === TerrainType.InfantryRock && aDef.infantry) {
            range += 4; // +2 tiles (InfRockRangeBonus from rules.txt)
          } else if (tt === TerrainType.Rock || tt === TerrainType.InfantryRock) {
            range += 2; // +1 tile (HeightRangeBonus from rules.txt)
          }
        }
      }

      if (dist > range) {
        const stance = this.stances.get(eid) ?? 1;
        // Hold position (stance=2): never move to chase
        if (stance === 2) continue;
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
        } else if (stance === 0) {
          // Aggressive: chase auto-acquired targets
          if (hasComponent(world, MoveTarget, eid)) {
            MoveTarget.x[eid] = Position.x[targetEid];
            MoveTarget.z[eid] = Position.z[targetEid];
            MoveTarget.active[eid] = 1;
          }
        }
        // Defensive (stance=1): don't chase auto-acquired targets that are out of range
        continue;
      }

      // In range — stop to fire if attack-moving
      if (this.attackMoveEntities.has(eid) && hasComponent(world, MoveTarget, eid)) {
        MoveTarget.active[eid] = 0;
      }

      // Rotate turret/unit to face target
      if (hasComponent(world, Rotation, eid)) {
        const isBuilding = hasComponent(world, BuildingType, eid);
        const desiredAngle = angleBetween(
          Position.x[eid], Position.z[eid],
          Position.x[targetEid], Position.z[targetEid]
        );
        if (hasComponent(world, TurretRotation, eid)) {
          // Independent turret: rotate turret toward target, hull stays facing movement
          const turnRate = (hasComponent(world, Speed, eid) && Speed.turnRate[eid] > 0)
            ? Speed.turnRate[eid] : 0.15;
          TurretRotation.y[eid] = lerpAngle(TurretRotation.y[eid], desiredAngle, Math.min(1, turnRate * 4));
          // Don't fire until turret is roughly aimed (within ~20 degrees)
          let angleDiff = desiredAngle - TurretRotation.y[eid];
          if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          if (Math.abs(angleDiff) > 0.35) continue;
        } else {
          // No turret: rotate whole hull
          const turnRate = hasComponent(world, Speed, eid) ? Speed.turnRate[eid] : 0.15;
          Rotation.y[eid] = lerpAngle(Rotation.y[eid], desiredAngle, Math.min(1, turnRate * 3));
          let angleDiff = desiredAngle - Rotation.y[eid];
          if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
          if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          if (Math.abs(angleDiff) > 0.35) continue;
        }
      }

      // Only fire when cooldown is done
      if (Combat.fireTimer[eid] > 0) continue;

      this.fire(world, eid, targetEid);
      this.recentlyFired.add(eid);
      // Buildings fire slower when low on power
      let rof = Combat.rof[eid];
      if (hasComponent(world, BuildingType, eid)) {
        const mult = this.powerMultipliers.get(Owner.playerId[eid]) ?? 1.0;
        if (mult < 1.0) rof = Math.ceil(rof / mult); // Lower mult = slower fire
      }
      Combat.fireTimer[eid] = rof;
    }
  }

  /** Look up the BulletDef for an attacker entity via turretAttach -> bullet chain. Cached. */
  private getBulletDef(attackerEid: number): BulletDef | null {
    const typeName = this.unitTypeMap.get(attackerEid);
    if (!typeName) return null;

    const cached = this.bulletCache.get(typeName);
    if (cached !== undefined) return cached;

    const unitDef = this.rules.units.get(typeName);
    const bldgDef = this.rules.buildings.get(typeName);
    const turretName = unitDef?.turretAttach ?? bldgDef?.turretAttach;
    if (!turretName) {
      this.bulletCache.set(typeName, null);
      return null;
    }
    const turret = this.rules.turrets.get(turretName);
    if (!turret?.bullet) {
      this.bulletCache.set(typeName, null);
      return null;
    }
    const bullet = this.rules.bullets.get(turret.bullet) ?? null;
    this.bulletCache.set(typeName, bullet);
    return bullet;
  }

  /** Apply warhead multiplier based on target's armor type. Returns adjusted damage. */
  private applyWarheadMultiplier(baseDamage: number, warheadName: string, targetEid: number): number {
    if (!warheadName || !hasComponent(this.world!, Armour, targetEid)) return baseDamage;
    const warhead = this.rules.warheads.get(warheadName);
    if (!warhead) return baseDamage;
    const armourIdx = Armour.type[targetEid];
    const armourName = this.armourTypes[armourIdx] ?? 'None';
    const multiplier = (warhead.vs[armourName] ?? 100) / 100;
    return Math.round(baseDamage * multiplier);
  }

  /** Apply damage to a single entity, handling kill tracking, veterancy XP, and events. */
  private applyDamageToEntity(
    world: World, attackerEid: number, targetEid: number, damage: number
  ): void {
    if (damage <= 0) return;
    if (!hasComponent(world, Health, targetEid) || Health.current[targetEid] <= 0) return;

    Health.current[targetEid] -= damage;

    // Apply hit slowdown if attacker's weapon causes it
    const attackerTypeName = this.unitTypeMap.get(attackerEid);
    if (attackerTypeName) {
      const attackerDef = this.rules.units.get(attackerTypeName);
      if (attackerDef && attackerDef.hitSlowDownAmount > 0 && attackerDef.hitSlowDownDuration > 0) {
        const existing = this.hitSlowdowns.get(targetEid);
        if (!existing || attackerDef.hitSlowDownAmount >= existing.amount) {
          // Stronger or equal hit: apply new slowdown
          this.hitSlowdowns.set(targetEid, {
            ticksLeft: attackerDef.hitSlowDownDuration,
            amount: attackerDef.hitSlowDownAmount,
          });
        } else {
          // Weaker hit: just refresh timer if it would last longer
          existing.ticksLeft = Math.max(existing.ticksLeft, attackerDef.hitSlowDownDuration);
        }
      }
    }

    // Infantry suppression: 1/5 chance when hit, lasts 200 ticks (stops firing + slows)
    const targetTypeName = this.unitTypeMap.get(targetEid);
    if (targetTypeName && !this.suppressionTimers.has(targetEid)) {
      const targetDef = this.rules.units.get(targetTypeName);
      if (targetDef && targetDef.canBeSuppressed && Math.random() < 0.2) { // 1/5 chance
        this.suppressionTimers.set(targetEid, 200);
        this.infantrySuppressed.add(targetEid);
      }
    }

    // Emit hit event for floating damage numbers (all visible hits)
    const targetOwner = Owner.playerId[targetEid];
    EventBus.emit('combat:hit', {
      x: Position.x[targetEid],
      z: Position.z[targetEid],
      damage,
      targetOwner,
    });

    // Notify when local player's units/buildings take damage
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

  /** Apply AoE blast damage at the target's position, hitting all entities within blast radius. */
  private applyBlastDamage(
    world: World, attackerEid: number, targetEid: number,
    baseDamage: number, bullet: BulletDef
  ): void {
    // Impact point = target position
    const impactX = Position.x[targetEid];
    const impactZ = Position.z[targetEid];

    // Convert game-units blast radius to world units: 32 game units = 1 tile = TILE_SIZE world units
    const worldRadius = (bullet.blastRadius / 32) * TILE_SIZE;
    const worldRadiusSq = worldRadius * worldRadius;

    const attackerOwner = Owner.playerId[attackerEid];

    // Emit blast event for visual effects
    EventBus.emit('combat:blast', { x: impactX, z: impactZ, radius: worldRadius });

    // Iterate all entities with Health+Position
    const entities = healthQuery(world);
    for (const eid of entities) {
      if (Health.current[eid] <= 0) continue;

      const dx = Position.x[eid] - impactX;
      const dz = Position.z[eid] - impactZ;
      const distSq = dx * dx + dz * dz;

      if (distSq > worldRadiusSq) continue;

      const dist = Math.sqrt(distSq);

      // Check friendly fire
      const entityOwner = Owner.playerId[eid];
      const isFriendly = hasComponent(world, Owner, eid) && entityOwner === attackerOwner;

      if (isFriendly && !bullet.damageFriendly) continue;

      // Calculate damage for this entity: apply warhead multiplier per-target (different armor types)
      let damage = this.applyWarheadMultiplier(baseDamage, bullet.warhead, eid);

      // Distance falloff: linear from full damage at center to 0 at edge
      if (bullet.reduceDamageWithDistance && worldRadius > 0) {
        damage *= (1 - dist / worldRadius);
      }

      // Friendly damage reduction
      if (isFriendly) {
        damage *= bullet.friendlyDamageAmount / 100;
      }

      damage = Math.round(damage);

      // Apply veterancy defense bonus per target
      if (hasComponent(world, Veterancy, eid)) {
        const defRank = Veterancy.rank[eid];
        const defBonus = [1.0, 0.9, 0.8, 0.7][defRank] ?? 1.0;
        damage = Math.round(damage * defBonus);
      }

      this.applyDamageToEntity(world, attackerEid, eid, damage);
    }
  }

  private fire(world: World, attackerEid: number, targetEid: number): void {
    let baseDamage = 100; // Default
    let bulletName = '';
    const bullet = this.getBulletDef(attackerEid);

    if (bullet) {
      baseDamage = bullet.damage;
      bulletName = bullet.name;
    }

    // Veterancy damage bonus: +15%/+30%/+50% per rank
    if (hasComponent(world, Veterancy, attackerEid)) {
      const rank = Veterancy.rank[attackerEid];
      const vetBonus = [1.0, 1.15, 1.30, 1.50][rank] ?? 1.0;
      baseDamage = Math.round(baseDamage * vetBonus);
    }

    // Damage degradation: damaged units deal less damage (proportional to HP ratio)
    // Harkonnen are exempt — they maintain full combat power until destroyed
    const attackerOwner = Owner.playerId[attackerEid];
    const attackerFaction = this.playerFactions.get(attackerOwner);
    if (attackerFaction !== 'HK') {
      const hpRatio = Health.current[attackerEid] / Math.max(1, Health.max[attackerEid]);
      // Scale: 100% HP = full damage, 50% HP = 75% damage, 0% HP = 50% damage
      const degradation = 0.5 + hpRatio * 0.5;
      baseDamage = Math.round(baseDamage * degradation);
    }

    // Terrain bonuses: infantry on InfantryRock get +50% damage
    if (this.terrain) {
      const attackerTypeName = this.unitTypeMap.get(attackerEid);
      const attackerDef = attackerTypeName ? this.rules.units.get(attackerTypeName) : null;
      if (attackerDef && attackerDef.getsHeightAdvantage) {
        const tile = worldToTile(Position.x[attackerEid], Position.z[attackerEid]);
        const terrainType = this.terrain.getTerrainType(tile.tx, tile.tz);
        if (terrainType === TerrainType.InfantryRock && attackerDef.infantry) {
          baseDamage = Math.round(baseDamage * 1.5); // +50% per rules.txt InfDamageRangeBonus
        }
      }
    }

    // Emit fire event for visual projectile
    EventBus.emit('combat:fire', {
      attackerX: Position.x[attackerEid],
      attackerZ: Position.z[attackerEid],
      targetX: Position.x[targetEid],
      targetZ: Position.z[targetEid],
      weaponType: bulletName,
      attackerEntity: attackerEid,
      targetEntity: targetEid,
    });

    // AoE blast damage: if bullet has a blast radius, damage all entities in the area
    if (bullet && bullet.blastRadius > 0) {
      this.applyBlastDamage(world, attackerEid, targetEid, baseDamage, bullet);
      return;
    }

    // Single-target damage path: apply warhead multiplier for the specific target
    if (bullet) {
      baseDamage = this.applyWarheadMultiplier(baseDamage, bullet.warhead, targetEid);
    }

    // Veterancy defense bonus on target: -10%/-20%/-30% damage taken
    if (hasComponent(world, Veterancy, targetEid)) {
      const defRank = Veterancy.rank[targetEid];
      const defBonus = [1.0, 0.9, 0.8, 0.7][defRank] ?? 1.0;
      baseDamage = Math.round(baseDamage * defBonus);
    }

    this.applyDamageToEntity(world, attackerEid, targetEid, baseDamage);
  }

  private findNearestEnemy(world: World, eid: number, _entities: readonly number[]): number {
    const myOwner = Owner.playerId[eid];
    const viewRange = Combat.attackRange[eid] * 2; // Auto-acquire at 2x attack range
    let bestScore = Infinity;
    let bestTarget = -1;

    const px = Position.x[eid];
    const pz = Position.z[eid];

    // Use spatial grid if available for O(n*k) lookup, else fall back to full scan
    const candidates = this.spatialGrid
      ? this.spatialGrid.getInRadius(px, pz, viewRange)
      : _entities as number[];

    // Get attacker's bullet def for warhead effectiveness scoring
    const bullet = this.getBulletDef(eid);

    for (const other of candidates) {
      if (Owner.playerId[other] === myOwner) continue;
      if (!hasComponent(world, Health, other)) continue;
      if (Health.current[other] <= 0) continue;
      // Skip stealthed enemies (unless very close - within 4 units)
      if (this.stealthedEntities.has(other)) {
        const closeRange = 4;
        const cdx = px - Position.x[other];
        const cdz = pz - Position.z[other];
        if (cdx * cdx + cdz * cdz > closeRange * closeRange) continue;
      }

      // Player units can only auto-target enemies in visible fog tiles
      if (myOwner === this.localPlayerId && this.fogOfWar && this.fogOfWar.isEnabled()) {
        const tile = worldToTile(Position.x[other], Position.z[other]);
        if (!this.fogOfWar.isTileVisible(tile.tx, tile.tz)) continue;
      }

      const dist = distance2D(px, pz, Position.x[other], Position.z[other]);
      if (dist > viewRange) continue;

      // Weighted scoring: lower = better target
      let score = dist; // Base: distance

      // Bonus: prefer nearly-dead targets (focus fire)
      const hpRatio = Health.max[other] > 0 ? Health.current[other] / Health.max[other] : 1;
      score -= (1 - hpRatio) * 8; // Up to 8 units bonus for low-HP targets

      // Bonus: prefer targets we deal extra damage to (warhead effectiveness)
      if (bullet?.warhead && hasComponent(world, Armour, other)) {
        const warhead = this.rules.warheads.get(bullet.warhead);
        if (warhead) {
          const armourIdx = Armour.type[other];
          const armourName = this.armourTypes[armourIdx] ?? 'None';
          const mult = (warhead.vs[armourName] ?? 100) / 100;
          score -= (mult - 1) * 6; // Bonus for targets we're effective against
        }
      }

      // Penalty: deprioritize buildings (prefer mobile threats)
      if (hasComponent(world, BuildingType, other)) {
        score += 10;
      }

      if (score < bestScore) {
        bestScore = score;
        bestTarget = other;
      }
    }

    return bestTarget;
  }
}
