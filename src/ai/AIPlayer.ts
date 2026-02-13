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

  // Build order tracking
  private buildPhase = 0;
  private lastBuildTick = 0;
  private buildCooldown = 200;

  // Army management
  private attackGroupSize = 4;
  private retreatHealthPct = 0.3;
  private lastAttackTick = 0;
  private attackCooldown = 500; // 20 seconds between major attacks
  private difficulty = 1.0; // Scales with game time

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

  setProductionSystem(production: ProductionSystem, harvestSystem: HarvestSystem): void {
    this.production = production;
    this.harvestSystem = harvestSystem;
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

      // Late game: expand economy, military, and advanced buildings
      if (solaris > 2000 && totalBuildings < 15) {
        const lateBuildings = [
          `${px}SmWindtrap`, `${px}Factory`, `${px}Barracks`, `${px}Refinery`,
          `${px}Hanger`, `${px}Starport`, `${px}SmWindtrap`,
        ];
        const pick = lateBuildings[Math.floor(Math.random() * lateBuildings.length)];
        if (this.production.canBuild(this.playerId, pick, true)) {
          this.production.startProduction(this.playerId, pick, true);
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
        // Check if near base
        const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
        if (dist < 40) nearBaseUnits.push(eid);
      }
    }

    // Dynamic attack group size based on difficulty
    const attackThreshold = Math.max(3, Math.floor(this.attackGroupSize * this.difficulty));
    const canAttack = this.tickCounter - this.lastAttackTick > this.attackCooldown;

    if (nearBaseUnits.length >= attackThreshold && canAttack) {
      this.lastAttackTick = this.tickCounter;

      // Split into groups for multi-direction attack
      const groupSize = Math.ceil(nearBaseUnits.length / 2);
      const group1 = nearBaseUnits.slice(0, groupSize);
      const group2 = nearBaseUnits.slice(groupSize);

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
