import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Owner, Health, MoveTarget, UnitType,
  addComponent, addEntity, unitQuery, buildingQuery,
  BuildingType, hasComponent,
} from '../core/ECS';
import type { GameRules } from '../config/RulesParser';
import type { CombatSystem } from '../simulation/CombatSystem';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { HarvestSystem } from '../simulation/HarvestSystem';
import { randomFloat } from '../utils/MathUtils';

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
  private buildCooldown = 200; // 8 seconds between build decisions

  constructor(rules: GameRules, combatSystem: CombatSystem, playerId: number, baseX: number, baseZ: number, targetX: number, targetZ: number) {
    this.rules = rules;
    this.combatSystem = combatSystem;
    this.playerId = playerId;
    this.baseX = baseX;
    this.baseZ = baseZ;
    this.targetX = targetX;
    this.targetZ = targetZ;

    // Build unit pool from available Harkonnen units
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
        } else if (def.cost <= 1500) {
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

    // Building decisions every buildCooldown ticks
    if (this.tickCounter - this.lastBuildTick > this.buildCooldown && this.production && this.harvestSystem) {
      this.makeBuildDecision(world);
      this.lastBuildTick = this.tickCounter;
    }

    // Train units continuously
    if (this.tickCounter % 150 === 0 && this.production && this.harvestSystem) {
      this.trainUnits();
    }

    // Spawn wave (fallback if production system isn't connected)
    if (!this.production && this.tickCounter % this.waveInterval === 0) {
      this.spawnWave(world);
      if (this.waveSize < 10) this.waveSize++;
      if (this.waveInterval > 375) this.waveInterval -= 25;
    }

    // Send idle AI units to attack (gather first, then attack in groups)
    if (this.tickCounter % 75 === 0) {
      this.manageArmy(world);
    }
  }

  private makeBuildDecision(world: World): void {
    if (!this.production || !this.harvestSystem) return;

    const solaris = this.harvestSystem.getSolaris(this.playerId);
    const px = this.factionPrefix;

    // Count current buildings
    const buildingCounts = new Map<string, number>();
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      // We don't have easy access to building type names, so just count total
      buildingCounts.set('total', (buildingCounts.get('total') ?? 0) + 1);
    }

    const totalBuildings = buildingCounts.get('total') ?? 0;

    // Build order based on phase
    const buildOrder = [
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 0 },
      { name: `${px}Refinery`, minSolaris: 1600, phase: 1 },
      { name: `${px}Barracks`, minSolaris: 300, phase: 2 },
      { name: `${px}Factory`, minSolaris: 1100, phase: 3 },
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 4 }, // Second windtrap
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 5 }, // Third windtrap
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
          // Can't build this yet, skip
          this.buildPhase++;
        }
      }
    } else {
      // Late game: build more windtraps and factories if we can afford it
      if (solaris > 2000 && totalBuildings < 10) {
        const lateBuildings = [`${px}SmWindtrap`, `${px}Factory`, `${px}Barracks`];
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

    // Mix of infantry and vehicles
    const pool = Math.random() < 0.4 ? this.infantryPool : this.vehiclePool;
    if (pool.length === 0) return;

    const typeName = pool[Math.floor(Math.random() * pool.length)];

    // Train via production system if available
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
    let totalUnits = 0;

    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      totalUnits++;

      if (MoveTarget.active[eid] === 0) {
        idleUnits.push(eid);
      }
    }

    // Only attack in groups of 3+ or if we have many units
    const attackThreshold = Math.min(5, Math.max(3, Math.floor(totalUnits * 0.3)));

    if (idleUnits.length >= attackThreshold) {
      // Send the group to attack
      for (const eid of idleUnits) {
        MoveTarget.x[eid] = this.targetX + randomFloat(-25, 25);
        MoveTarget.z[eid] = this.targetZ + randomFloat(-25, 25);
        MoveTarget.active[eid] = 1;
      }
    } else if (idleUnits.length > 0 && idleUnits.length < attackThreshold) {
      // Rally idle units near base
      for (const eid of idleUnits) {
        const rallyX = this.baseX + randomFloat(-15, 15);
        const rallyZ = this.baseZ - 15 + randomFloat(-5, 5); // In front of base
        MoveTarget.x[eid] = rallyX;
        MoveTarget.z[eid] = rallyZ;
        MoveTarget.active[eid] = 1;
      }
    }
  }
}
