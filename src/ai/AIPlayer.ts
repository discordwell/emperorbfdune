import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Owner, Health, MoveTarget, UnitType, AttackTarget,
  addComponent, addEntity, unitQuery, buildingQuery,
  BuildingType, Harvester, hasComponent,
} from '../core/ECS';
import type { GameRules } from '../config/RulesParser';
import type { CombatSystem } from '../simulation/CombatSystem';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { HarvestSystem } from '../simulation/HarvestSystem';
import { randomFloat, distance2D } from '../utils/MathUtils';

// AI: builds structures, trains units, sends attack waves
export class AIPlayer implements GameSystem {
  private rules: GameRules;
  private combatSystem: CombatSystem;
  private production: ProductionSystem | null = null;
  private harvestSystem: HarvestSystem | null = null;
  private playerId: number;
  private baseX: number;
  private baseZ: number;
  private targetX: number;
  private targetZ: number;
  private tickCounter = 0;
  private waveInterval = 750;
  private waveSize = 3;
  private spawnCallback: ((eid: number, typeName: string, owner: number, x: number, z: number) => void) | null = null;
  private factionPrefix = 'HK';

  // Unit types the AI can build
  private unitPool: string[] = [];
  private infantryPool: string[] = [];
  private vehiclePool: string[] = [];
  private subhousePrefix = '';

  // Build order tracking
  private buildPhase = 0;
  private lastBuildTick = 0;
  private buildCooldown = 200;
  // Building type name lookup (set externally)
  private buildingTypeNames: string[] = [];
  // Base defense: designated defender units stay near base
  private defenders = new Set<number>();
  private maxDefenders = 4;
  // Track if base was recently attacked for priority response
  private baseUnderAttack = false;
  private baseAttackTick = 0;

  // Army management
  private attackGroupSize = 4;
  private retreatHealthPct = 0.3;
  private lastAttackTick = 0;
  private attackCooldown = 500; // 20 seconds between major attacks
  private difficulty = 1.0; // Scales with game time

  setDifficulty(level: 'easy' | 'normal' | 'hard'): void {
    if (level === 'easy') {
      this.waveInterval = 1200;
      this.waveSize = 2;
      this.buildCooldown = 350;
      this.attackGroupSize = 3;
      this.attackCooldown = 800;
    } else if (level === 'hard') {
      this.waveInterval = 500;
      this.waveSize = 5;
      this.buildCooldown = 120;
      this.attackGroupSize = 6;
      this.attackCooldown = 300;
    }
    // 'normal' uses defaults
  }

  constructor(rules: GameRules, combatSystem: CombatSystem, playerId: number, baseX: number, baseZ: number, targetX: number, targetZ: number) {
    this.rules = rules;
    this.combatSystem = combatSystem;
    this.playerId = playerId;
    this.baseX = baseX;
    this.baseZ = baseZ;
    this.targetX = targetX;
    this.targetZ = targetZ;

    for (const [name, def] of rules.units) {
      if (name.startsWith('HK') && def.cost > 0 && def.cost <= 1200 && !def.canFly) {
        this.unitPool.push(name);
      }
    }
    if (this.unitPool.length === 0) {
      this.unitPool = ['HKLightInf', 'HKBuzzsaw', 'HKAssault'];
    }
  }

  setSpawnCallback(cb: (eid: number, typeName: string, owner: number, x: number, z: number) => void): void {
    this.spawnCallback = cb;
  }

  setBasePosition(x: number, z: number): void {
    this.baseX = x;
    this.baseZ = z;
  }

  setTargetPosition(x: number, z: number): void {
    this.targetX = x;
    this.targetZ = z;
  }

  getBasePosition(): { x: number; z: number } {
    return { x: this.baseX, z: this.baseZ };
  }

  setProductionSystem(production: ProductionSystem, harvestSystem: HarvestSystem): void {
    this.production = production;
    this.harvestSystem = harvestSystem;
  }

  setBuildingTypeNames(names: string[]): void {
    this.buildingTypeNames = names;
  }

  /** Set sub-house prefix to add sub-house units/buildings to AI's pool */
  setSubhousePrefix(prefix: string): void {
    this.subhousePrefix = prefix;
    // Add sub-house units to the unit pools
    for (const [name, def] of this.rules.units) {
      if (name.startsWith(prefix) && def.cost > 0 && !def.canFly) {
        this.unitPool.push(name);
        if (def.infantry) {
          this.infantryPool.push(name);
        } else {
          this.vehiclePool.push(name);
        }
      }
    }
  }

  setUnitPool(prefix: string): void {
    this.factionPrefix = prefix;
    this.unitPool = [];
    this.infantryPool = [];
    this.vehiclePool = [];

    for (const [name, def] of this.rules.units) {
      if (name.startsWith(prefix) && def.cost > 0 && !def.canFly) {
        this.unitPool.push(name);
        if (def.infantry) {
          this.infantryPool.push(name);
        } else {
          this.vehiclePool.push(name);
        }
      }
    }
    if (this.unitPool.length === 0) {
      this.unitPool = [`${prefix}LightInf`, `${prefix}Trooper`];
    }
    if (this.infantryPool.length === 0) {
      this.infantryPool = this.unitPool.slice(0, 2);
    }
    if (this.vehiclePool.length === 0) {
      this.vehiclePool = this.unitPool.slice(0, 2);
    }
  }

  init(_world: World): void {}

  update(world: World, _dt: number): void {
    this.tickCounter++;

    // Scale difficulty over time (ramps up over 5 minutes)
    this.difficulty = 1.0 + Math.min(2.0, this.tickCounter / 7500);

    // Building decisions
    if (this.tickCounter - this.lastBuildTick > this.buildCooldown && this.production && this.harvestSystem) {
      this.makeBuildDecision(world);
      this.lastBuildTick = this.tickCounter;
    }

    // Train units continuously (faster as difficulty rises)
    const trainInterval = Math.max(75, Math.floor(150 / this.difficulty));
    if (this.tickCounter % trainInterval === 0 && this.production && this.harvestSystem) {
      this.trainUnits();
    }

    // Detect base attacks: check if AI buildings are taking damage
    if (this.tickCounter % 25 === 0) {
      this.checkBaseDefense(world);
    }

    // Spawn wave (fallback if production system isn't connected)
    if (!this.production && this.tickCounter % this.waveInterval === 0) {
      this.spawnWave(world);
      if (this.waveSize < 10) this.waveSize++;
      if (this.waveInterval > 375) this.waveInterval -= 25;
    }

    // Manage army every 3 seconds
    if (this.tickCounter % 75 === 0) {
      this.manageArmy(world);
    }

    // Retreat wounded units every 2 seconds
    if (this.tickCounter % 50 === 0) {
      this.retreatWounded(world);
    }

    // Hunt player harvesters occasionally (every ~30 seconds)
    if (this.tickCounter % 750 === 0 && this.difficulty > 1.5) {
      this.huntHarvesters(world);
    }

    // Update target to player's most valuable cluster (every ~20 seconds)
    if (this.tickCounter % 500 === 250) {
      this.updateAttackTarget(world);
    }
  }

  /** Dynamically retarget to the player's most valuable building cluster */
  private updateAttackTarget(world: World): void {
    const buildings = buildingQuery(world);
    let bestX = this.targetX;
    let bestZ = this.targetZ;
    let bestScore = 0;

    for (const eid of buildings) {
      if (Owner.playerId[eid] === this.playerId || Health.current[eid] <= 0) continue;
      const typeId = BuildingType.id[eid];
      const bName = this.buildingTypeNames[typeId] ?? '';
      // Score by building value
      let score = 1;
      if (bName.includes('ConYard')) score = 10;
      else if (bName.includes('Refinery')) score = 8;
      else if (bName.includes('Factory')) score = 6;
      else if (bName.includes('Windtrap')) score = 3;
      else if (bName.includes('Starport')) score = 5;

      // Bonus for clusters: check nearby buildings
      for (const other of buildings) {
        if (other === eid || Owner.playerId[other] === this.playerId || Health.current[other] <= 0) continue;
        const dx = Position.x[other] - Position.x[eid];
        const dz = Position.z[other] - Position.z[eid];
        if (dx * dx + dz * dz < 400) score += 1; // Within 20 units
      }

      if (score > bestScore) {
        bestScore = score;
        bestX = Position.x[eid];
        bestZ = Position.z[eid];
      }
    }

    this.targetX = bestX;
    this.targetZ = bestZ;
  }

  private makeBuildDecision(world: World): void {
    if (!this.production || !this.harvestSystem) return;

    const solaris = this.harvestSystem.getSolaris(this.playerId);
    const px = this.factionPrefix;

    let totalBuildings = 0;
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      totalBuildings++;
    }

    // Phase-based build order
    const buildOrder = [
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 0 },
      { name: `${px}Refinery`, minSolaris: 1600, phase: 1 },
      { name: `${px}Barracks`, minSolaris: 300, phase: 2 },
      { name: `${px}Factory`, minSolaris: 1100, phase: 3 },
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 4 },
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 5 },
      { name: `${px}Refinery`, minSolaris: 1600, phase: 6 }, // Second refinery
      { name: `${px}Hanger`, minSolaris: 1000, phase: 7 },
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 8 },
    ];

    if (this.buildPhase < buildOrder.length) {
      const order = buildOrder[this.buildPhase];
      if (solaris >= order.minSolaris) {
        const def = this.rules.buildings.get(order.name);
        if (def && this.production.canBuild(this.playerId, order.name, true)) {
          if (this.production.startProduction(this.playerId, order.name, true)) {
            this.buildPhase++;
          }
        } else {
          this.buildPhase++;
        }
      }
    } else {
      // Try upgrading buildings for higher tech levels
      if (solaris > 1500) {
        const upgradePriority = [`${px}Factory`, `${px}Barracks`, `${px}ConYard`];
        for (const bType of upgradePriority) {
          if (this.production.canUpgrade(this.playerId, bType)) {
            this.production.startUpgrade(this.playerId, bType);
            break;
          }
        }
      }

      // Count specific building types for smart expansion
      let refineryCount = 0, windtrapCount = 0, turretCount = 0, factoryCount = 0;
      for (const eid of buildings) {
        if (Owner.playerId[eid] !== this.playerId || Health.current[eid] <= 0) continue;
        const typeId = BuildingType.id[eid];
        const name = this.buildingTypeNames[typeId] ?? '';
        if (name.includes('Refinery')) refineryCount++;
        if (name.includes('Windtrap')) windtrapCount++;
        if (name.includes('Turret')) turretCount++;
        if (name.includes('Factory')) factoryCount++;
      }

      // Priority 1: Defense turrets (especially when under attack)
      if (this.baseUnderAttack && turretCount < 4 && solaris > 500) {
        const turretTypes = [`${px}GunTurret`, `${px}RocketTurret`, `${px}Turret`];
        for (const turret of turretTypes) {
          if (this.production.canBuild(this.playerId, turret, true)) {
            this.production.startProduction(this.playerId, turret, true);
            return;
          }
        }
      }

      // Priority 2: Power — maintain at least 1 windtrap per 3 buildings
      if (windtrapCount < Math.ceil(totalBuildings / 3) && solaris > 300) {
        if (this.production.canBuild(this.playerId, `${px}SmWindtrap`, true)) {
          this.production.startProduction(this.playerId, `${px}SmWindtrap`, true);
          return;
        }
      }

      // Priority 3: Economy — scale up refineries with difficulty
      const desiredRefineries = Math.min(4, 2 + Math.floor(this.difficulty));
      if (refineryCount < desiredRefineries && solaris > 1600) {
        if (this.production.canBuild(this.playerId, `${px}Refinery`, true)) {
          this.production.startProduction(this.playerId, `${px}Refinery`, true);
          return;
        }
      }

      // Priority 4: Military production — second factory at high difficulty
      if (factoryCount < 2 && this.difficulty > 1.5 && solaris > 1100) {
        if (this.production.canBuild(this.playerId, `${px}Factory`, true)) {
          this.production.startProduction(this.playerId, `${px}Factory`, true);
          return;
        }
      }

      // Priority 5: Turrets periodically (cap at 6)
      if (turretCount < 6 && solaris > 800 && Math.random() < 0.25) {
        const turretTypes = [`${px}GunTurret`, `${px}RocketTurret`, `${px}Turret`];
        for (const turret of turretTypes) {
          if (this.production.canBuild(this.playerId, turret, true)) {
            this.production.startProduction(this.playerId, turret, true);
            return;
          }
        }
      }

      // Priority 6: Advanced structures (starport, hangar, palace)
      if (totalBuildings < 20 && solaris > 2000) {
        const advBuildings = [`${px}Starport`, `${px}Hanger`, `${px}Palace`];
        for (const name of advBuildings) {
          if (this.production.canBuild(this.playerId, name, true)) {
            this.production.startProduction(this.playerId, name, true);
            return;
          }
        }
      }

      // Priority 7: Sub-house buildings (Fremen Camp, Sardaukar Barracks, Ix Research Center, etc.)
      if (this.subhousePrefix && this.difficulty > 1.3 && solaris > 1000) {
        // Map sub-house prefix to building name
        const subBuildings: Record<string, string[]> = {
          'FR': ['FRFremenCamp'],
          'IM': ['IMBarracks'],
          'IX': ['IXResCentre'],
          'TL': ['TLFleshVat'],
          'GU': ['GUPalace'],
        };
        const candidates = subBuildings[this.subhousePrefix] ?? [];
        for (const bName of candidates) {
          if (this.production.canBuild(this.playerId, bName, true)) {
            this.production.startProduction(this.playerId, bName, true);
            return;
          }
        }
        // Also try upgrading sub-house buildings
        for (const bName of candidates) {
          if (this.production.canUpgrade(this.playerId, bName)) {
            this.production.startUpgrade(this.playerId, bName);
            return;
          }
        }
      }
    }
  }

  private trainUnits(): void {
    if (!this.production || !this.harvestSystem) return;

    const solaris = this.harvestSystem.getSolaris(this.playerId);
    if (solaris < 200) return;

    // Prefer vehicles when we can afford them, infantry when cheap
    let pool: string[];
    if (solaris > 800 && this.vehiclePool.length > 0) {
      pool = Math.random() < 0.3 ? this.infantryPool : this.vehiclePool;
    } else {
      pool = Math.random() < 0.6 ? this.infantryPool : this.vehiclePool;
    }
    if (pool.length === 0) pool = this.unitPool;
    if (pool.length === 0) return;

    // Filter to units we can actually build (tech level + prerequisites)
    const buildable = pool.filter(name => this.production!.canBuild(this.playerId, name, false));
    if (buildable.length === 0) {
      // Fall back to any buildable unit
      const anyBuildable = this.unitPool.filter(name => this.production!.canBuild(this.playerId, name, false));
      if (anyBuildable.length === 0) return;
      const typeName = anyBuildable[Math.floor(Math.random() * anyBuildable.length)];
      this.production.startProduction(this.playerId, typeName, false);
      return;
    }

    const typeName = buildable[Math.floor(Math.random() * buildable.length)];
    this.production.startProduction(this.playerId, typeName, false);
  }

  private spawnWave(world: World): void {
    for (let i = 0; i < this.waveSize; i++) {
      const typeName = this.unitPool[Math.floor(Math.random() * this.unitPool.length)];
      const x = this.baseX + randomFloat(-10, 10);
      const z = this.baseZ + randomFloat(-10, 10);

      if (this.spawnCallback) {
        const eid = addEntity(world);
        this.spawnCallback(eid, typeName, this.playerId, x, z);
      }
    }
  }

  private manageArmy(world: World): void {
    const units = unitQuery(world);
    const idleUnits: number[] = [];
    const nearBaseUnits: number[] = [];
    let totalUnits = 0;

    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      // Skip harvesters
      if (hasComponent(world, Harvester, eid)) continue;
      totalUnits++;

      if (MoveTarget.active[eid] === 0) {
        idleUnits.push(eid);
        // Check if near base (wider radius for larger armies)
        const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
        if (dist < 60) nearBaseUnits.push(eid);
      }
    }

    // Scale max defenders with difficulty
    const scaledMaxDefenders = Math.floor(this.maxDefenders * this.difficulty);

    // Ensure we have some defenders near base
    if (this.defenders.size < scaledMaxDefenders && nearBaseUnits.length > scaledMaxDefenders) {
      for (const eid of nearBaseUnits) {
        if (this.defenders.size >= scaledMaxDefenders) break;
        if (!this.defenders.has(eid)) {
          this.defenders.add(eid);
        }
      }
    }

    // Dynamic attack group size based on difficulty
    const attackThreshold = Math.max(3, Math.floor(this.attackGroupSize * this.difficulty));
    const canAttack = this.tickCounter - this.lastAttackTick > this.attackCooldown;

    // Filter out designated defenders from attack group
    const attackableUnits = nearBaseUnits.filter(eid => !this.defenders.has(eid));

    if (attackableUnits.length >= attackThreshold && canAttack) {
      this.lastAttackTick = this.tickCounter;

      // Split into groups for multi-direction attack
      const groupSize = Math.ceil(attackableUnits.length / 2);
      const group1 = attackableUnits.slice(0, groupSize);
      const group2 = attackableUnits.slice(groupSize);

      // Main attack direction
      const angle1 = Math.atan2(this.targetZ - this.baseZ, this.targetX - this.baseX);
      // Flanking direction (±30-45 degrees)
      const flankAngle = (Math.random() * 0.5 + 0.4) * (Math.random() < 0.5 ? 1 : -1);
      const angle2 = angle1 + flankAngle;

      // Group 1: direct assault
      for (const eid of group1) {
        const spread = randomFloat(-10, 10);
        MoveTarget.x[eid] = this.targetX + Math.cos(angle1 + 1.57) * spread;
        MoveTarget.z[eid] = this.targetZ + Math.sin(angle1 + 1.57) * spread;
        MoveTarget.active[eid] = 1;
      }

      // Group 2: flanking attack (offset target)
      if (group2.length > 0) {
        const flankDist = 30;
        const flankTargetX = this.targetX + Math.cos(angle2) * flankDist;
        const flankTargetZ = this.targetZ + Math.sin(angle2) * flankDist;
        for (const eid of group2) {
          MoveTarget.x[eid] = flankTargetX + randomFloat(-8, 8);
          MoveTarget.z[eid] = flankTargetZ + randomFloat(-8, 8);
          MoveTarget.active[eid] = 1;
        }
      }
    } else if (idleUnits.length > 0 && idleUnits.length < attackThreshold) {
      // Rally idle units near base
      for (const eid of idleUnits) {
        const rallyX = this.baseX + randomFloat(-15, 15);
        const rallyZ = this.baseZ - 15 + randomFloat(-5, 5);
        MoveTarget.x[eid] = rallyX;
        MoveTarget.z[eid] = rallyZ;
        MoveTarget.active[eid] = 1;
      }
    }
  }

  private retreatWounded(world: World): void {
    const units = unitQuery(world);
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (hasComponent(world, Harvester, eid)) continue;

      const ratio = Health.current[eid] / Health.max[eid];
      if (ratio < this.retreatHealthPct) {
        // Retreat to base
        const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
        if (dist > 30) {
          MoveTarget.x[eid] = this.baseX + randomFloat(-10, 10);
          MoveTarget.z[eid] = this.baseZ + randomFloat(-10, 10);
          MoveTarget.active[eid] = 1;
          // Clear attack target so they disengage
          if (hasComponent(world, AttackTarget, eid)) {
            AttackTarget.active[eid] = 0;
          }
        }
      }
    }
  }

  private checkBaseDefense(world: World): void {
    const buildings = buildingQuery(world);
    let underAttack = false;

    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      // Check if any building is below 90% health (recently damaged)
      if (Health.current[eid] < Health.max[eid] * 0.9) {
        underAttack = true;
        break;
      }
    }

    if (underAttack && !this.baseUnderAttack) {
      this.baseUnderAttack = true;
      this.baseAttackTick = this.tickCounter;
      // Emergency: recall all idle units to defend base
      this.recallDefenders(world);
    } else if (!underAttack && this.baseUnderAttack) {
      // All clear after 20 seconds
      if (this.tickCounter - this.baseAttackTick > 500) {
        this.baseUnderAttack = false;
      }
    }

    // Clean up dead defenders
    for (const eid of this.defenders) {
      if (Health.current[eid] <= 0) {
        this.defenders.delete(eid);
      }
    }
  }

  private recallDefenders(world: World): void {
    const units = unitQuery(world);
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (hasComponent(world, Harvester, eid)) continue;

      // Only recall units that aren't already near base
      const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
      if (dist > 50) {
        MoveTarget.x[eid] = this.baseX + (Math.random() - 0.5) * 15;
        MoveTarget.z[eid] = this.baseZ + (Math.random() - 0.5) * 15;
        MoveTarget.active[eid] = 1;
        if (hasComponent(world, AttackTarget, eid)) {
          AttackTarget.active[eid] = 0;
        }
      }
    }
  }

  private huntHarvesters(world: World): void {
    // Find player harvesters
    const units = unitQuery(world);
    let targetHarvester = -1;
    let bestDist = Infinity;

    for (const eid of units) {
      if (Owner.playerId[eid] === this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (!hasComponent(world, Harvester, eid)) continue;

      const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
      if (dist < bestDist) {
        bestDist = dist;
        targetHarvester = eid;
      }
    }

    if (targetHarvester < 0) return;

    // Send 2-3 fast units to intercept the harvester
    const hunters: number[] = [];
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (hasComponent(world, Harvester, eid)) continue;
      if (MoveTarget.active[eid] === 0) {
        hunters.push(eid);
        if (hunters.length >= 3) break;
      }
    }

    for (const eid of hunters) {
      if (hasComponent(world, AttackTarget, eid)) {
        AttackTarget.entityId[eid] = targetHarvester;
        AttackTarget.active[eid] = 1;
      }
      if (hasComponent(world, MoveTarget, eid)) {
        MoveTarget.x[eid] = Position.x[targetHarvester];
        MoveTarget.z[eid] = Position.z[targetHarvester];
        MoveTarget.active[eid] = 1;
      }
    }
  }
}
