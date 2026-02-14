import type { GameSystem } from '../core/Game';
import type { World } from '../core/ECS';
import {
  Position, Owner, Health, MoveTarget, UnitType, AttackTarget,
  addEntity, unitQuery, buildingQuery,
  BuildingType, Harvester, hasComponent, ViewRange,
} from '../core/ECS';
import type { GameRules } from '../config/RulesParser';
import type { BuildingDef } from '../config/BuildingDefs';
import type { CombatSystem } from '../simulation/CombatSystem';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { HarvestSystem } from '../simulation/HarvestSystem';
import { randomFloat, distance2D, worldToTile, TILE_SIZE } from '../utils/MathUtils';

const MAP_SIZE = 128;

// Unit combat role classification
type UnitRole = 'antiInf' | 'antiVeh' | 'antiBldg' | 'scout';

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

  // Strategic building placement tracking
  private placedBuildings: { x: number; z: number; name: string }[] = [];

  // Army management
  private attackGroupSize = 4;
  private retreatHealthPct = 0.3;
  private lastAttackTick = 0;
  private attackCooldown = 500; // 20 seconds between major attacks
  private difficulty = 1.0; // Scales with game time
  private difficultyLevel: 'easy' | 'normal' | 'hard' = 'normal';
  private maxAttackFronts = 2; // Multi-front: easy=1, normal=2, hard=3

  // --- Scouting System ---
  private scoutMap: Uint8Array = new Uint8Array(MAP_SIZE * MAP_SIZE);
  private scoutQueue: { x: number; z: number }[] = [];
  private scoutEntities = new Set<number>();
  private knownEnemyPositions = new Map<number, { x: number; z: number; typeName: string; tick: number }>();
  private maxScouts = 2;
  private scoutInitialized = false;

  // --- Unit Composition System ---
  private unitRoles = new Map<string, UnitRole>();
  private compositionGoal = { antiInf: 0.3, antiVeh: 0.4, antiBldg: 0.2, scout: 0.1 };
  private rolesClassified = false;

  // Cached world reference for methods that need it (set each update tick)
  private currentWorld: World | null = null;

  setDifficulty(level: 'easy' | 'normal' | 'hard'): void {
    this.difficultyLevel = level;
    if (level === 'easy') {
      this.waveInterval = 1200;
      this.waveSize = 2;
      this.buildCooldown = 350;
      this.attackGroupSize = 3;
      this.attackCooldown = 800;
      this.maxScouts = 1;
      this.maxAttackFronts = 1;
    } else if (level === 'hard') {
      this.waveInterval = 500;
      this.waveSize = 5;
      this.buildCooldown = 120;
      this.attackGroupSize = 6;
      this.attackCooldown = 300;
      this.maxScouts = 2;
      this.maxAttackFronts = 3;
    }
    // 'normal' uses defaults (maxScouts = 2, maxAttackFronts = 2)
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
    // Re-classify roles when pool changes
    this.rolesClassified = false;
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
    // Re-classify roles when pool changes
    this.rolesClassified = false;
  }

  init(_world: World): void {}

  update(world: World, _dt: number): void {
    this.tickCounter++;
    this.currentWorld = world;

    // One-time role classification (deferred until first update so all pools are set)
    if (!this.rolesClassified) {
      this.classifyUnitRoles();
      this.rolesClassified = true;
    }

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

    // --- Scouting ---
    // Difficulty-based scouting start: easy=1500, normal=750, hard=0
    const scoutStartTick = this.difficultyLevel === 'easy' ? 1500
      : this.difficultyLevel === 'normal' ? 750 : 0;

    if (this.tickCounter >= scoutStartTick) {
      // Manage scouting every ~100 ticks (4 seconds)
      if (this.tickCounter % 100 === 0) {
        this.manageScouting(world);
      }
      // Update scout knowledge every ~50 ticks (2 seconds)
      if (this.tickCounter % 50 === 10) {
        this.updateScoutKnowledge(world);
      }
    }

    // --- Composition counter-adjustment every ~200 ticks (8 seconds) ---
    if (this.tickCounter % 200 === 100) {
      this.adjustCompositionForCounters();
    }

    // --- Economy management every ~150 ticks (6 seconds) ---
    if (this.tickCounter % 150 === 75 && this.production && this.harvestSystem) {
      this.manageEconomy(world);
    }
  }

  // ==========================================
  // Scouting System
  // ==========================================

  /** Initialize the scout queue with strategic map points */
  private initScoutQueue(): void {
    if (this.scoutInitialized) return;
    this.scoutInitialized = true;

    const worldMax = MAP_SIZE * TILE_SIZE; // 256 world units
    const margin = 10;

    // On hard difficulty, bias toward the player's side of map first
    const playerSideFirst = this.difficultyLevel === 'hard';

    // Strategic exploration points: center, edge midpoints, corners
    const points: { x: number; z: number; priority: number }[] = [
      // Map center
      { x: worldMax / 2, z: worldMax / 2, priority: 1 },
      // Edge midpoints
      { x: worldMax / 2, z: margin, priority: 2 },
      { x: worldMax / 2, z: worldMax - margin, priority: 2 },
      { x: margin, z: worldMax / 2, priority: 2 },
      { x: worldMax - margin, z: worldMax / 2, priority: 2 },
      // Corners
      { x: margin, z: margin, priority: 3 },
      { x: worldMax - margin, z: margin, priority: 3 },
      { x: margin, z: worldMax - margin, priority: 3 },
      { x: worldMax - margin, z: worldMax - margin, priority: 3 },
      // Quarter points for additional coverage
      { x: worldMax / 4, z: worldMax / 4, priority: 4 },
      { x: worldMax * 3 / 4, z: worldMax / 4, priority: 4 },
      { x: worldMax / 4, z: worldMax * 3 / 4, priority: 4 },
      { x: worldMax * 3 / 4, z: worldMax * 3 / 4, priority: 4 },
    ];

    if (playerSideFirst) {
      // Sort by distance to target (player base) - closest first
      points.sort((a, b) => {
        const da = distance2D(a.x, a.z, this.targetX, this.targetZ);
        const db = distance2D(b.x, b.z, this.targetX, this.targetZ);
        return da - db;
      });
    } else {
      // Sort by priority (lower = higher priority), then distance from AI base
      points.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        const da = distance2D(a.x, a.z, this.baseX, this.baseZ);
        const db = distance2D(b.x, b.z, this.baseX, this.baseZ);
        return da - db;
      });
    }

    this.scoutQueue = points.map(p => ({ x: p.x, z: p.z }));
  }

  /** Manage scout unit assignments and movement */
  private manageScouting(world: World): void {
    this.initScoutQueue();

    // Clean up dead scouts
    for (const eid of this.scoutEntities) {
      if (Health.current[eid] <= 0) {
        this.scoutEntities.delete(eid);
      }
    }

    // Check if scouts have reached their targets
    for (const eid of this.scoutEntities) {
      if (Health.current[eid] <= 0) continue;
      // If scout is idle (reached destination or stuck), assign next waypoint
      if (MoveTarget.active[eid] === 0) {
        this.assignNextScoutTarget(eid);
      } else {
        // Check if close enough to current target
        const dx = Position.x[eid] - MoveTarget.x[eid];
        const dz = Position.z[eid] - MoveTarget.z[eid];
        if (dx * dx + dz * dz < 25) { // Within 5 world units
          // Mark surrounding area as explored
          this.markExplored(Position.x[eid], Position.z[eid], 8);
          // Move to next target
          this.assignNextScoutTarget(eid);
        }
      }
    }

    // Recruit new scouts if needed
    if (this.scoutEntities.size < this.maxScouts) {
      const units = unitQuery(world);
      // Find cheap, fast, idle units for scouting
      const candidates: { eid: number; score: number }[] = [];

      for (const eid of units) {
        if (Owner.playerId[eid] !== this.playerId) continue;
        if (Health.current[eid] <= 0) continue;
        if (hasComponent(world, Harvester, eid)) continue;
        if (this.scoutEntities.has(eid)) continue;
        if (this.defenders.has(eid)) continue;
        // Only consider idle units
        if (MoveTarget.active[eid] !== 0) continue;

        const unitTypeName = this.getUnitTypeName(eid);
        if (!unitTypeName) continue;

        const def = this.rules.units.get(unitTypeName);
        if (!def) continue;

        // Prefer cheap, fast units as scouts
        const costScore = 1000 / Math.max(1, def.cost); // Higher for cheaper units
        const speedScore = def.speed;
        candidates.push({ eid, score: costScore + speedScore * 2 });
      }

      // Sort by score (best scouts first)
      candidates.sort((a, b) => b.score - a.score);

      for (const candidate of candidates) {
        if (this.scoutEntities.size >= this.maxScouts) break;
        this.scoutEntities.add(candidate.eid);
        this.assignNextScoutTarget(candidate.eid);
      }
    }
  }

  /** Assign the next unexplored waypoint to a scout */
  private assignNextScoutTarget(eid: number): void {
    // Find next unexplored target from queue
    while (this.scoutQueue.length > 0) {
      const target = this.scoutQueue[0];
      const tile = worldToTile(target.x, target.z);
      if (tile.tx >= 0 && tile.tx < MAP_SIZE && tile.tz >= 0 && tile.tz < MAP_SIZE) {
        if (this.scoutMap[tile.tz * MAP_SIZE + tile.tx] === 0) {
          // This tile is unexplored, send scout there
          MoveTarget.x[eid] = target.x;
          MoveTarget.z[eid] = target.z;
          MoveTarget.active[eid] = 1;
          // Move to back of queue so other scouts get different targets
          this.scoutQueue.push(this.scoutQueue.shift()!);
          return;
        }
      }
      // Already explored, remove from queue
      this.scoutQueue.shift();
    }

    // All queued targets explored - generate random unexplored location
    const worldMax = MAP_SIZE * TILE_SIZE;
    for (let attempt = 0; attempt < 10; attempt++) {
      const rx = randomFloat(10, worldMax - 10);
      const rz = randomFloat(10, worldMax - 10);
      const tile = worldToTile(rx, rz);
      if (tile.tx >= 0 && tile.tx < MAP_SIZE && tile.tz >= 0 && tile.tz < MAP_SIZE) {
        if (this.scoutMap[tile.tz * MAP_SIZE + tile.tx] === 0) {
          MoveTarget.x[eid] = rx;
          MoveTarget.z[eid] = rz;
          MoveTarget.active[eid] = 1;
          return;
        }
      }
    }

    // Map mostly explored - patrol between known enemy positions
    if (this.knownEnemyPositions.size > 0) {
      const entries = Array.from(this.knownEnemyPositions.values());
      const target = entries[Math.floor(Math.random() * entries.length)];
      MoveTarget.x[eid] = target.x + randomFloat(-15, 15);
      MoveTarget.z[eid] = target.z + randomFloat(-15, 15);
      MoveTarget.active[eid] = 1;
    }
  }

  /** Mark tiles around a world position as explored */
  private markExplored(wx: number, wz: number, radiusTiles: number): void {
    const center = worldToTile(wx, wz);
    for (let dz = -radiusTiles; dz <= radiusTiles; dz++) {
      for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
        if (dx * dx + dz * dz > radiusTiles * radiusTiles) continue;
        const tx = center.tx + dx;
        const tz = center.tz + dz;
        if (tx >= 0 && tx < MAP_SIZE && tz >= 0 && tz < MAP_SIZE) {
          this.scoutMap[tz * MAP_SIZE + tx] = 1;
        }
      }
    }
  }

  /** Update the AI's knowledge of enemy positions based on scout vision */
  private updateScoutKnowledge(world: World): void {
    const units = unitQuery(world);
    const buildings = buildingQuery(world);

    // For each AI unit (not just scouts), detect nearby enemy entities
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;

      const viewRange = ViewRange.range ? (ViewRange.range[eid] || 10) : 10;
      const px = Position.x[eid];
      const pz = Position.z[eid];

      // Mark explored tiles around this unit
      const tileSightRadius = Math.ceil(viewRange / TILE_SIZE);
      // Only scouts actively mark explored tiles (to avoid revealing everything)
      if (this.scoutEntities.has(eid)) {
        this.markExplored(px, pz, tileSightRadius);
      }

      // Scan for enemy units within view range
      for (const other of units) {
        if (Owner.playerId[other] === this.playerId) continue;
        if (Health.current[other] <= 0) continue;
        const dx = Position.x[other] - px;
        const dz = Position.z[other] - pz;
        if (dx * dx + dz * dz < viewRange * viewRange) {
          const otherTypeName = this.getUnitTypeName(other);
          this.knownEnemyPositions.set(other, {
            x: Position.x[other],
            z: Position.z[other],
            typeName: otherTypeName ?? 'Unknown',
            tick: this.tickCounter,
          });
        }
      }

      // Scan for enemy buildings within view range
      for (const beid of buildings) {
        if (Owner.playerId[beid] === this.playerId) continue;
        if (Health.current[beid] <= 0) continue;
        const dx = Position.x[beid] - px;
        const dz = Position.z[beid] - pz;
        if (dx * dx + dz * dz < viewRange * viewRange) {
          const typeId = BuildingType.id[beid];
          const bName = this.buildingTypeNames[typeId] ?? 'Building';
          this.knownEnemyPositions.set(beid + 100000, { // Offset to avoid collision with unit eids
            x: Position.x[beid],
            z: Position.z[beid],
            typeName: bName,
            tick: this.tickCounter,
          });
        }
      }
    }

    // Expire old entries (>2000 ticks old = ~80 seconds)
    for (const [key, info] of this.knownEnemyPositions) {
      if (this.tickCounter - info.tick > 2000) {
        this.knownEnemyPositions.delete(key);
      }
    }
  }

  /** Get a unit type name from an entity's UnitType.id component */
  private getUnitTypeName(eid: number): string | null {
    const typeId = UnitType.id[eid];
    // typeId is an index into the rules.units Map (insertion order)
    if (typeId === undefined || typeId === 0) {
      // Check if 0 is valid (it's the first unit type) or uninitialized
      // We'll try to return it regardless since 0 is a valid index
    }
    let idx = 0;
    for (const [name] of this.rules.units) {
      if (idx === typeId) return name;
      idx++;
    }
    return null;
  }

  // ==========================================
  // Unit Composition System
  // ==========================================

  /** Classify each unit in the pool by combat role using the turret->bullet->warhead chain */
  private classifyUnitRoles(): void {
    for (const unitName of this.unitPool) {
      const def = this.rules.units.get(unitName);
      if (!def) {
        this.unitRoles.set(unitName, 'scout');
        continue;
      }

      // Check if this is a cheap fast unit with no/weak weapon -> scout
      if (!def.turretAttach || def.turretAttach === '') {
        // No turret = no weapon. If cheap and fast, it's a scout
        if (def.cost <= 200 || def.engineer || def.saboteur || def.infiltrator) {
          this.unitRoles.set(unitName, 'scout');
        } else {
          // Expensive with no weapon - probably a special unit, default to antiVeh
          this.unitRoles.set(unitName, 'antiVeh');
        }
        continue;
      }

      // Follow the turret -> bullet -> warhead chain
      const turret = this.rules.turrets.get(def.turretAttach);
      if (!turret || !turret.bullet) {
        this.unitRoles.set(unitName, 'scout');
        continue;
      }

      const bullet = this.rules.bullets.get(turret.bullet);
      if (!bullet || !bullet.warhead) {
        this.unitRoles.set(unitName, 'scout');
        continue;
      }

      const warhead = this.rules.warheads.get(bullet.warhead);
      if (!warhead) {
        this.unitRoles.set(unitName, 'antiVeh'); // default
        continue;
      }

      // Determine best damage type from warhead.vs
      const vs = warhead.vs;

      // Anti-infantry: best vs None, Earplugs, BPV, Light
      const antiInfScore = Math.max(
        vs['None'] ?? 0, vs['Earplugs'] ?? 0, vs['BPV'] ?? 0, vs['Light'] ?? 0
      );

      // Anti-vehicle: best vs Medium, Heavy
      const antiVehScore = Math.max(vs['Medium'] ?? 0, vs['Heavy'] ?? 0);

      // Anti-building: best vs Building, CY, Concrete
      const antiBldgScore = Math.max(vs['Building'] ?? 0, vs['CY'] ?? 0, vs['Concrete'] ?? 0);

      // Cheap fast units with low damage are scouts regardless
      if (def.cost <= 150 && def.speed >= 3 && bullet.damage < 50) {
        this.unitRoles.set(unitName, 'scout');
        continue;
      }

      // Classify by best relative effectiveness
      if (antiBldgScore >= antiVehScore && antiBldgScore >= antiInfScore && antiBldgScore > 50) {
        this.unitRoles.set(unitName, 'antiBldg');
      } else if (antiVehScore >= antiInfScore) {
        this.unitRoles.set(unitName, 'antiVeh');
      } else {
        this.unitRoles.set(unitName, 'antiInf');
      }
    }
  }

  /** Count living AI units by role */
  private countUnitsByRole(world: World): Record<UnitRole, number> {
    const counts: Record<UnitRole, number> = { antiInf: 0, antiVeh: 0, antiBldg: 0, scout: 0 };
    const units = unitQuery(world);

    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (hasComponent(world, Harvester, eid)) continue;

      const typeName = this.getUnitTypeName(eid);
      if (!typeName) continue;

      const role = this.unitRoles.get(typeName) ?? 'antiVeh';
      counts[role]++;
    }

    return counts;
  }

  /** Determine which role is most under-represented compared to the composition goal */
  private getMostNeededRole(world: World): UnitRole {
    const counts = this.countUnitsByRole(world);
    const total = counts.antiInf + counts.antiVeh + counts.antiBldg + counts.scout;

    if (total === 0) return 'antiVeh'; // Default on first unit

    // Calculate current ratios vs goal ratios
    let worstRole: UnitRole = 'antiVeh';
    let worstDeficit = -Infinity;

    for (const role of ['antiInf', 'antiVeh', 'antiBldg', 'scout'] as UnitRole[]) {
      const currentRatio = counts[role] / total;
      const goalRatio = this.compositionGoal[role];
      const deficit = goalRatio - currentRatio;
      if (deficit > worstDeficit) {
        worstDeficit = deficit;
        worstRole = role;
      }
    }

    return worstRole;
  }

  /** Adjust composition goal based on observed enemy composition (counter-strategy) */
  private adjustCompositionForCounters(): void {
    if (this.knownEnemyPositions.size === 0) return;

    let enemyInfantry = 0;
    let enemyVehicles = 0;
    let enemyBuildings = 0;

    for (const info of this.knownEnemyPositions.values()) {
      // Only consider recent sightings (within last 1000 ticks)
      if (this.tickCounter - info.tick > 1000) continue;

      const def = this.rules.units.get(info.typeName);
      if (def) {
        if (def.infantry) {
          enemyInfantry++;
        } else {
          enemyVehicles++;
        }
      } else {
        // Likely a building
        enemyBuildings++;
      }
    }

    const total = enemyInfantry + enemyVehicles + enemyBuildings;
    if (total < 3) return; // Not enough intel to adjust

    // Start from default ratios and shift toward countering
    const goal = { antiInf: 0.3, antiVeh: 0.4, antiBldg: 0.2, scout: 0.1 };

    const infRatio = enemyInfantry / total;
    const vehRatio = enemyVehicles / total;
    const bldgRatio = enemyBuildings / total;

    // If enemy has lots of infantry, build more anti-infantry
    if (infRatio > 0.5) {
      goal.antiInf = 0.5;
      goal.antiVeh = 0.25;
      goal.antiBldg = 0.15;
    }
    // If enemy has lots of vehicles, build more anti-vehicle
    else if (vehRatio > 0.5) {
      goal.antiVeh = 0.55;
      goal.antiInf = 0.2;
      goal.antiBldg = 0.15;
    }
    // If enemy has lots of buildings (turtling), build more anti-building
    else if (bldgRatio > 0.4) {
      goal.antiBldg = 0.35;
      goal.antiVeh = 0.35;
      goal.antiInf = 0.2;
    }

    this.compositionGoal = goal;
  }

  // ==========================================
  // Economy Management
  // ==========================================

  /** Ensure the AI has enough harvesters */
  private manageEconomy(world: World): void {
    if (!this.production || !this.harvestSystem) return;

    // Count living AI harvesters
    const units = unitQuery(world);
    let harvesterCount = 0;
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (hasComponent(world, Harvester, eid)) {
        harvesterCount++;
      }
    }

    // Desired harvester count by difficulty
    const desiredHarvesters = this.difficultyLevel === 'hard' ? 3 : 2;

    if (harvesterCount < desiredHarvesters) {
      const solaris = this.harvestSystem.getSolaris(this.playerId);
      if (solaris < 600) return; // Can't afford one

      // Try to find a harvester unit type in the rules
      const harvesterNames = [
        `${this.factionPrefix}Harvester`,
        `${this.factionPrefix}harvester`,
        // Also check for generic harvester types
      ];

      // Also search all units for any harvester-type unit matching our faction
      for (const [name, def] of this.rules.units) {
        if (name.startsWith(this.factionPrefix) && def.getUnitWhenBuilt) {
          // Some buildings produce harvesters when built (refineries)
          // But we want to directly train harvesters
        }
        if (name.toLowerCase().includes('harvester') && name.startsWith(this.factionPrefix)) {
          if (!harvesterNames.includes(name)) harvesterNames.push(name);
        }
      }

      for (const hName of harvesterNames) {
        if (this.production.canBuild(this.playerId, hName, false)) {
          this.production.startProduction(this.playerId, hName, false);
          return;
        }
      }

      // If direct harvester training fails, build a refinery (which comes with a harvester)
      const refName = `${this.factionPrefix}Refinery`;
      if (solaris >= 1600 && this.production.canBuild(this.playerId, refName, true)) {
        this.production.startProduction(this.playerId, refName, true);
      }
    }
  }

  // ==========================================
  // Original Methods (with scout-aware targeting)
  // ==========================================

  /** Dynamically retarget to the player's most valuable building cluster */
  private updateAttackTarget(world: World): void {
    // First, try to use scout-gathered intelligence
    if (this.knownEnemyPositions.size > 0) {
      let bestX = this.targetX;
      let bestZ = this.targetZ;
      let bestScore = 0;

      // Score known enemy positions by value
      for (const info of this.knownEnemyPositions.values()) {
        // Skip very old intel
        if (this.tickCounter - info.tick > 1500) continue;

        let score = 1;
        const name = info.typeName;
        if (name.includes('ConYard')) score = 10;
        else if (name.includes('Refinery')) score = 8;
        else if (name.includes('Factory')) score = 6;
        else if (name.includes('Starport')) score = 5;
        else if (name.includes('Windtrap')) score = 3;
        else if (name.includes('Barracks')) score = 4;

        // Freshness bonus: more recent intel is more reliable
        const freshness = 1.0 - (this.tickCounter - info.tick) / 2000;
        score *= Math.max(0.3, freshness);

        // Cluster bonus: count nearby known enemies
        for (const other of this.knownEnemyPositions.values()) {
          if (other === info) continue;
          const dx = other.x - info.x;
          const dz = other.z - info.z;
          if (dx * dx + dz * dz < 400) score += 0.5;
        }

        if (score > bestScore) {
          bestScore = score;
          bestX = info.x;
          bestZ = info.z;
        }
      }

      if (bestScore > 0) {
        this.targetX = bestX;
        this.targetZ = bestZ;
        return;
      }
    }

    // Fallback: omniscient building scan (original behavior)
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

    // --- Composition-aware training ---
    // Determine which role is most needed
    if (!this.currentWorld) return;
    const neededRole = this.getMostNeededRole(this.currentWorld);

    // Filter unit pool by needed role
    const roleFilteredPool = this.unitPool.filter(name => {
      const role = this.unitRoles.get(name);
      return role === neededRole;
    });

    // Choose pool: role-filtered if available (70% chance), otherwise original logic
    let pool: string[];
    if (roleFilteredPool.length > 0 && Math.random() < 0.7) {
      pool = roleFilteredPool;
    } else {
      // Fallback to original infantry/vehicle preference
      if (solaris > 800 && this.vehiclePool.length > 0) {
        pool = Math.random() < 0.3 ? this.infantryPool : this.vehiclePool;
      } else {
        pool = Math.random() < 0.6 ? this.infantryPool : this.vehiclePool;
      }
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

  /** Build a list of 2-3 attack objectives from scouted enemy positions */
  private planAttackObjectives(): { x: number; z: number; priority: number }[] {
    if (this.knownEnemyPositions.size === 0) {
      return [{ x: this.targetX, z: this.targetZ, priority: 1 }];
    }

    // Score and cluster known enemy positions into objectives
    const scored: { x: number; z: number; priority: number }[] = [];
    for (const info of this.knownEnemyPositions.values()) {
      if (this.tickCounter - info.tick > 1500) continue;
      let score = 1;
      const name = info.typeName;
      if (name.includes('Refinery') || name.includes('Harvester')) score = 8;
      else if (name.includes('ConYard')) score = 10;
      else if (name.includes('Factory') || name.includes('Barracks')) score = 6;
      else if (name.includes('Starport')) score = 5;
      else score = 2;
      scored.push({ x: info.x, z: info.z, priority: score });
    }
    if (scored.length === 0) {
      return [{ x: this.targetX, z: this.targetZ, priority: 1 }];
    }

    // Cluster nearby positions (within 20 world units) into single objectives
    const clusters: { x: number; z: number; priority: number }[] = [];
    const used = new Set<number>();
    for (let i = 0; i < scored.length; i++) {
      if (used.has(i)) continue;
      let cx = scored[i].x * scored[i].priority;
      let cz = scored[i].z * scored[i].priority;
      let totalWeight = scored[i].priority;
      used.add(i);
      for (let j = i + 1; j < scored.length; j++) {
        if (used.has(j)) continue;
        const dx = scored[j].x - scored[i].x;
        const dz = scored[j].z - scored[i].z;
        if (dx * dx + dz * dz < 400) { // Within 20 world units
          cx += scored[j].x * scored[j].priority;
          cz += scored[j].z * scored[j].priority;
          totalWeight += scored[j].priority;
          used.add(j);
        }
      }
      clusters.push({ x: cx / totalWeight, z: cz / totalWeight, priority: totalWeight });
    }

    // Sort by priority descending, take top N
    clusters.sort((a, b) => b.priority - a.priority);
    return clusters.slice(0, this.maxAttackFronts);
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
      // Skip scouts - they have their own orders
      if (this.scoutEntities.has(eid)) continue;
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

      // Hard difficulty: split off 2-3 fast units for harvester harassment
      let harassUnits: number[] = [];
      if (this.difficultyLevel === 'hard' && attackableUnits.length > 5) {
        harassUnits = attackableUnits.splice(attackableUnits.length - 3, 3);
      }

      // Plan multi-front attack objectives from scout data
      const objectives = this.planAttackObjectives();

      if (objectives.length <= 1) {
        // Single objective: original 2-group flank behavior
        const target = objectives[0] ?? { x: this.targetX, z: this.targetZ };
        const groupSize = Math.ceil(attackableUnits.length / 2);
        const group1 = attackableUnits.slice(0, groupSize);
        const group2 = attackableUnits.slice(groupSize);

        const angle1 = Math.atan2(target.z - this.baseZ, target.x - this.baseX);
        const flankAngle = (Math.random() * 0.5 + 0.4) * (Math.random() < 0.5 ? 1 : -1);
        const angle2 = angle1 + flankAngle;

        for (const eid of group1) {
          const spread = randomFloat(-10, 10);
          MoveTarget.x[eid] = target.x + Math.cos(angle1 + 1.57) * spread;
          MoveTarget.z[eid] = target.z + Math.sin(angle1 + 1.57) * spread;
          MoveTarget.active[eid] = 1;
        }
        if (group2.length > 0) {
          const flankDist = 30;
          for (const eid of group2) {
            MoveTarget.x[eid] = target.x + Math.cos(angle2) * flankDist + randomFloat(-8, 8);
            MoveTarget.z[eid] = target.z + Math.sin(angle2) * flankDist + randomFloat(-8, 8);
            MoveTarget.active[eid] = 1;
          }
        }
      } else {
        // Multi-front: assign units to closest objective to minimize travel
        const groups: number[][] = objectives.map(() => []);
        for (const eid of attackableUnits) {
          let bestIdx = 0;
          let bestDist = Infinity;
          for (let i = 0; i < objectives.length; i++) {
            const d = distance2D(Position.x[eid], Position.z[eid], objectives[i].x, objectives[i].z);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
          }
          groups[bestIdx].push(eid);
        }
        // Ensure no group is empty by redistributing from largest
        for (let i = 0; i < groups.length; i++) {
          if (groups[i].length === 0) {
            const largest = groups.reduce((a, b, _idx, _arr) => b.length > a.length ? b : a, groups[0]);
            if (largest.length > 1) groups[i].push(largest.pop()!);
          }
        }

        // Send each group toward its objective from a unique approach angle
        for (let i = 0; i < objectives.length; i++) {
          const obj = objectives[i];
          const group = groups[i];
          if (group.length === 0) continue;
          // Compute approach angle from group centroid + random offset for unpredictability
          let cx = 0, cz = 0;
          for (const eid of group) { cx += Position.x[eid]; cz += Position.z[eid]; }
          cx /= group.length; cz /= group.length;
          const approachAngle = Math.atan2(obj.z - cz, obj.x - cx) + randomFloat(-0.3, 0.3);
          for (const eid of group) {
            const spread = randomFloat(-8, 8);
            MoveTarget.x[eid] = obj.x + Math.cos(approachAngle + 1.57) * spread;
            MoveTarget.z[eid] = obj.z + Math.sin(approachAngle + 1.57) * spread;
            MoveTarget.active[eid] = 1;
          }
        }
      }

      // Dispatch harassment group concurrently (hard difficulty)
      if (harassUnits.length > 0) {
        this.sendHarassGroup(world, harassUnits);
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

  /** Send a small harassment group to target enemy harvesters concurrently with main attack */
  private sendHarassGroup(world: World, harassers: number[]): void {
    const units = unitQuery(world);
    let targetHarvester = -1;
    let bestDist = Infinity;
    for (const eid of units) {
      if (Owner.playerId[eid] === this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (!hasComponent(world, Harvester, eid)) continue;
      const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
      if (dist < bestDist) { bestDist = dist; targetHarvester = eid; }
    }
    if (targetHarvester < 0) {
      // No harvester found: send harassers to a secondary objective instead
      const tx = this.targetX + randomFloat(-30, 30);
      const tz = this.targetZ + randomFloat(-30, 30);
      for (const eid of harassers) {
        MoveTarget.x[eid] = tx + randomFloat(-5, 5);
        MoveTarget.z[eid] = tz + randomFloat(-5, 5);
        MoveTarget.active[eid] = 1;
      }
      return;
    }
    for (const eid of harassers) {
      MoveTarget.x[eid] = Position.x[targetHarvester] + randomFloat(-5, 5);
      MoveTarget.z[eid] = Position.z[targetHarvester] + randomFloat(-5, 5);
      MoveTarget.active[eid] = 1;
      if (hasComponent(world, AttackTarget, eid)) {
        AttackTarget.entityId[eid] = targetHarvester;
        AttackTarget.active[eid] = 1;
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
          // Remove from scouts if retreating
          this.scoutEntities.delete(eid);
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
        // Remove from scouts when recalled
        this.scoutEntities.delete(eid);
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
      if (this.scoutEntities.has(eid)) continue; // Don't pull scouts
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
