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
import type { SpatialGrid } from '../utils/SpatialGrid';
import { randomFloat, distance2D, worldToTile, TILE_SIZE } from '../utils/MathUtils';
import { EventBus } from '../core/EventBus';

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
  private aircraftPool: string[] = [];
  private specialPool: string[] = []; // Engineers, saboteurs, infiltrators, deviators
  private specialEntities = new Set<number>(); // Track deployed special units
  private subhousePrefix = '';

  // Build order tracking
  private buildPhase = 0;
  private lastBuildTick = 0;
  private buildCooldown = 200;
  // Building type name lookup (set externally)
  private buildingTypeNames: string[] = [];
  // Unit type name lookup (set externally) — replaces O(n) Map iteration
  private unitTypeNamesCache: string[] = [];
  // Base defense: designated defender units stay near base
  private defenders = new Set<number>();
  private maxDefenders = 4;
  // Track if base was recently attacked for priority response
  private baseUnderAttack = false;
  private baseAttackTick = 0;
  // Track building health snapshots for detecting active damage (not just permanent damage)
  private buildingHealthSnapshot = new Map<number, number>();
  // Track last known attacker positions for smarter counterattack direction
  private lastAttackerCentroid: { x: number; z: number } | null = null;

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

  // Campaign personality tuning (0..4)
  private personality = 2;
  private aggressionBias = 1.0;
  private defenseBias = 1.0;
  private economyBias = 1.0;
  private retreatBias = 1.0;

  // Map dimensions (configurable for variable-size maps)
  private mapWidth = 128;
  private mapHeight = 128;

  // Tick offset for staggering multiple AI players across frames
  private tickOffset = 0;

  // --- Scouting System ---
  private scoutMap: Uint8Array = new Uint8Array(128 * 128);
  private scoutQueue: { x: number; z: number }[] = [];
  private scoutEntities = new Set<number>();
  private knownEnemyPositions = new Map<number, { x: number; z: number; typeName: string; tick: number }>();
  private maxScouts = 2;
  private scoutInitialized = false;

  // --- Unit Composition System ---
  private unitRoles = new Map<string, UnitRole>();
  private compositionGoal = { antiInf: 0.3, antiVeh: 0.4, antiBldg: 0.2, scout: 0.1 };
  private rolesClassified = false;

  // Spatial grid reference for O(k) neighbor lookups (shared from MovementSystem)
  private spatialGrid: SpatialGrid | null = null;

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

  /** 0=fortifier, 1=economic, 2=balanced, 3=raider, 4=berserker */
  setPersonality(personality: number): void {
    const p = Math.max(0, Math.min(4, Math.floor(personality)));
    this.personality = p;

    // Reset to neutral multipliers before applying a profile
    this.aggressionBias = 1.0;
    this.defenseBias = 1.0;
    this.economyBias = 1.0;
    this.retreatBias = 1.0;

    switch (p) {
      case 0: // Fortifier
        this.aggressionBias = 0.8;
        this.defenseBias = 1.4;
        this.economyBias = 1.0;
        this.retreatBias = 1.2;
        break;
      case 1: // Economic
        this.aggressionBias = 0.85;
        this.defenseBias = 0.9;
        this.economyBias = 1.35;
        this.retreatBias = 1.1;
        break;
      case 3: // Raider
        this.aggressionBias = 1.25;
        this.defenseBias = 0.9;
        this.economyBias = 0.95;
        this.retreatBias = 0.9;
        break;
      case 4: // Berserker
        this.aggressionBias = 1.5;
        this.defenseBias = 0.75;
        this.economyBias = 0.8;
        this.retreatBias = 0.75;
        break;
      default: // Balanced
        break;
    }
  }

  /** Reconstruct build phase from existing buildings after save/load.
   *  Also fast-forwards tickCounter to match game tick so difficulty ramp is correct. */
  reconstructFromWorldState(gameTick: number, world?: World): void {
    this.tickCounter = gameTick;
    this.difficulty = 1.0 + Math.min(2.0, gameTick / 7500);

    // Rebuild placedBuildings from actual world state so spacing checks,
    // wall staggering, and ConYard-anchored base position all work correctly
    if (world) {
      this.placedBuildings = [];
      const buildings = buildingQuery(world);
      for (const eid of buildings) {
        if (Owner.playerId[eid] !== this.playerId || Health.current[eid] <= 0) continue;
        const typeId = BuildingType.id[eid];
        const name = this.buildingTypeNames[typeId] ?? '';
        this.placedBuildings.push({ x: Position.x[eid], z: Position.z[eid], name });
      }
      this.updateBaseCenterOfMass();
    }

    // Determine build phase by counting what buildings already exist
    const px = this.factionPrefix;
    const buildOrder = [
      `${px}SmWindtrap`,   // phase 0
      `${px}Refinery`,     // phase 1
      `${px}Barracks`,     // phase 2
      `${px}Factory`,      // phase 3
      `${px}Outpost`,      // phase 4
      `${px}SmWindtrap`,   // phase 5 (second)
      `${px}SmWindtrap`,   // phase 6 (third)
      `${px}Refinery`,     // phase 7 (second)
      `${px}Hanger`,       // phase 8
      `${px}SmWindtrap`,   // phase 9 (fourth)
    ];
    // Count owned buildings by type
    const ownedCounts = new Map<string, number>();
    if (this.production) {
      const owned = this.production.getPlayerBuildings(this.playerId);
      if (owned) {
        for (const [name, count] of owned) {
          if (count > 0) ownedCounts.set(name, count);
        }
      }
    }
    // Walk through build order, consuming from owned counts
    const consumed = new Map<string, number>();
    let phase = 0;
    for (let i = 0; i < buildOrder.length; i++) {
      const name = buildOrder[i];
      const used = consumed.get(name) ?? 0;
      const available = (ownedCounts.get(name) ?? 0) - used;
      if (available > 0) {
        consumed.set(name, used + 1);
        phase = i + 1;
      } else {
        break; // Stop at first missing building
      }
    }
    this.buildPhase = phase;
  }

  constructor(rules: GameRules, combatSystem: CombatSystem, playerId: number, baseX: number, baseZ: number, targetX: number, targetZ: number) {
    this.rules = rules;
    this.combatSystem = combatSystem;
    this.playerId = playerId;
    this.baseX = baseX;
    this.baseZ = baseZ;
    this.targetX = targetX;
    this.targetZ = targetZ;

    // Clean up destroyed buildings from placement tracking
    EventBus.on('building:destroyed', ({ owner, x, z }) => {
      if (owner === this.playerId) {
        const idx = this.placedBuildings.findIndex(b =>
          Math.abs(b.x - x) < 2 && Math.abs(b.z - z) < 2
        );
        if (idx >= 0) {
          this.placedBuildings.splice(idx, 1);
          this.updateBaseCenterOfMass();
        }
      }
    });

    // Unit pools start empty — setUnitPool(prefix) must be called before first update
  }

  setSpawnCallback(cb: (eid: number, typeName: string, owner: number, x: number, z: number) => void): void {
    this.spawnCallback = cb;
  }

  setTickOffset(offset: number): void {
    this.tickOffset = offset;
  }

  setMapDimensions(w: number, h: number): void {
    this.mapWidth = w;
    this.mapHeight = h;
    this.scoutMap = new Uint8Array(w * h);
    this.scoutInitialized = false;
    this.scoutQueue = [];
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
      if (name.startsWith(prefix) && def.cost > 0) {
        if (def.canFly) {
          this.aircraftPool.push(name);
        } else if (def.aiSpecial && !def.deviator) {
          this.specialPool.push(name);
        } else {
          this.unitPool.push(name);
          if (def.infantry) {
            this.infantryPool.push(name);
          } else {
            this.vehiclePool.push(name);
          }
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
    this.aircraftPool = [];
    this.specialPool = [];

    for (const [name, def] of this.rules.units) {
      if (name.startsWith(prefix) && def.cost > 0) {
        if (def.canFly) {
          this.aircraftPool.push(name);
        } else if (def.aiSpecial && !def.deviator) {
          // Special units get their own pool - not mixed with regular army
          this.specialPool.push(name);
        } else {
          this.unitPool.push(name);
          if (def.infantry) {
            this.infantryPool.push(name);
          } else {
            this.vehiclePool.push(name);
          }
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

    // Staggered tick for scheduling — distributes AI computation across frames
    const t = this.tickCounter + this.tickOffset;

    // One-time role classification (deferred until first update so all pools are set)
    if (!this.rolesClassified) {
      this.classifyUnitRoles();
      this.rolesClassified = true;
    }

    // Scale difficulty over time (ramps up over 5 minutes)
    this.difficulty = 1.0 + Math.min(2.0, this.tickCounter / 7500);

    // Difficulty-based income bonus/penalty (every 10 seconds)
    if (t % 250 === 0 && this.harvestSystem) {
      if (this.difficultyLevel === 'hard') {
        this.harvestSystem.addSolaris(this.playerId, Math.floor(50 * this.difficulty));
      } else if (this.difficultyLevel === 'easy') {
        // Easy AI gets slower income ramp
        this.harvestSystem.addSolaris(this.playerId, 10);
      }
    }

    // Building decisions
    if (this.tickCounter - this.lastBuildTick > this.buildCooldown && this.production && this.harvestSystem) {
      this.makeBuildDecision(world);
      this.lastBuildTick = this.tickCounter;
    }

    // Train units continuously (faster as difficulty rises)
    const trainInterval = Math.max(75, Math.floor(150 / this.difficulty));
    if (t % trainInterval === 0 && this.production && this.harvestSystem) {
      this.trainUnits();
    }

    // Train aircraft periodically (slower than ground units)
    if (t % 500 === 200 && this.production && this.harvestSystem && this.aircraftPool.length > 0) {
      this.trainAircraft();
    }

    // Use Starport for bulk purchases when prices are good
    if (t % 375 === 100 && this.production && this.harvestSystem) {
      this.useStarport();
    }

    // Train special units (engineers, saboteurs, infiltrators) periodically
    if (t % 600 === 300 && this.production && this.harvestSystem && this.specialPool.length > 0) {
      this.trainSpecialUnit();
    }

    // Deploy special units toward enemy buildings (every ~12 seconds)
    if (t % 300 === 150) {
      this.deploySpecialUnits(world);
    }

    // Detect base attacks: check if AI buildings are taking damage
    if (t % 25 === 0) {
      this.checkBaseDefense(world);
    }

    // Spawn wave (fallback if production system isn't connected)
    if (!this.production && t % this.waveInterval === 0) {
      this.spawnWave(world);
      if (this.waveSize < 10) this.waveSize++;
      if (this.waveInterval > 375) this.waveInterval -= 25;
    }

    // Manage army every 3 seconds
    if (t % 75 === 0) {
      this.manageArmy(world);
    }

    // Retreat wounded units every 2 seconds
    if (t % 50 === 0) {
      this.retreatWounded(world);
    }

    // Hunt player harvesters occasionally (every ~30 seconds)
    if (t % 750 === 0 && this.difficulty > 1.5) {
      this.huntHarvesters(world);
    }

    // Update target to player's most valuable cluster (every ~20 seconds)
    if (t % 500 === 250) {
      this.updateAttackTarget(world);
    }

    // --- Scouting ---
    // Difficulty-based scouting start: easy=1500, normal=750, hard=0
    const scoutStartTick = this.difficultyLevel === 'easy' ? 1500
      : this.difficultyLevel === 'normal' ? 750 : 0;

    if (this.tickCounter >= scoutStartTick) {
      // Manage scouting every ~100 ticks (4 seconds)
      if (t % 100 === 0) {
        this.manageScouting(world);
      }
      // Update scout knowledge every ~50 ticks (2 seconds)
      if (t % 50 === 10) {
        this.updateScoutKnowledge(world);
      }
    }

    // --- Composition counter-adjustment every ~200 ticks (8 seconds) ---
    if (t % 200 === 100) {
      this.adjustCompositionForCounters();
    }

    // --- Repair damaged buildings every ~200 ticks (8 seconds) ---
    if (t % 200 === 50 && this.harvestSystem) {
      this.repairBuildings(world);
    }

    // --- Economy management every ~150 ticks (6 seconds) ---
    if (t % 150 === 75 && this.production && this.harvestSystem) {
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

    const worldMaxX = this.mapWidth * TILE_SIZE;
    const worldMaxZ = this.mapHeight * TILE_SIZE;
    const margin = 10;

    // On hard difficulty, bias toward the player's side of map first
    const playerSideFirst = this.difficultyLevel === 'hard';

    // Strategic exploration points: center, edge midpoints, corners
    const points: { x: number; z: number; priority: number }[] = [
      // Map center
      { x: worldMaxX / 2, z: worldMaxZ / 2, priority: 1 },
      // Edge midpoints
      { x: worldMaxX / 2, z: margin, priority: 2 },
      { x: worldMaxX / 2, z: worldMaxZ - margin, priority: 2 },
      { x: margin, z: worldMaxZ / 2, priority: 2 },
      { x: worldMaxX - margin, z: worldMaxZ / 2, priority: 2 },
      // Corners
      { x: margin, z: margin, priority: 3 },
      { x: worldMaxX - margin, z: margin, priority: 3 },
      { x: margin, z: worldMaxZ - margin, priority: 3 },
      { x: worldMaxX - margin, z: worldMaxZ - margin, priority: 3 },
      // Quarter points for additional coverage
      { x: worldMaxX / 4, z: worldMaxZ / 4, priority: 4 },
      { x: worldMaxX * 3 / 4, z: worldMaxZ / 4, priority: 4 },
      { x: worldMaxX / 4, z: worldMaxZ * 3 / 4, priority: 4 },
      { x: worldMaxX * 3 / 4, z: worldMaxZ * 3 / 4, priority: 4 },
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
      if (tile.tx >= 0 && tile.tx < this.mapWidth && tile.tz >= 0 && tile.tz < this.mapHeight) {
        if (this.scoutMap[tile.tz * this.mapWidth + tile.tx] === 0) {
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
    const worldMaxX = this.mapWidth * TILE_SIZE;
    const worldMaxZ = this.mapHeight * TILE_SIZE;
    for (let attempt = 0; attempt < 10; attempt++) {
      const rx = randomFloat(10, worldMaxX - 10);
      const rz = randomFloat(10, worldMaxZ - 10);
      const tile = worldToTile(rx, rz);
      if (tile.tx >= 0 && tile.tx < this.mapWidth && tile.tz >= 0 && tile.tz < this.mapHeight) {
        if (this.scoutMap[tile.tz * this.mapWidth + tile.tx] === 0) {
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
        if (tx >= 0 && tx < this.mapWidth && tz >= 0 && tz < this.mapHeight) {
          this.scoutMap[tz * this.mapWidth + tx] = 1;
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

      const viewRangeSq = viewRange * viewRange;

      // Use spatial grid for O(k) unit neighbor lookup instead of O(n) scan
      const nearbyUnits = this.spatialGrid
        ? this.spatialGrid.getInRadius(px, pz, viewRange)
        : units;
      for (let i = 0; i < nearbyUnits.length; i++) {
        const other = nearbyUnits[i];
        if (Owner.playerId[other] === this.playerId) continue;
        if (Health.current[other] <= 0) continue;
        const dx = Position.x[other] - px;
        const dz = Position.z[other] - pz;
        if (dx * dx + dz * dz < viewRangeSq) {
          this.knownEnemyPositions.set(other, {
            x: Position.x[other],
            z: Position.z[other],
            typeName: this.getUnitTypeName(other) ?? 'Unknown',
            tick: this.tickCounter,
          });
        }
      }

      // Scan buildings (few entities, no grid needed)
      for (const beid of buildings) {
        if (Owner.playerId[beid] === this.playerId) continue;
        if (Health.current[beid] <= 0) continue;
        const dx = Position.x[beid] - px;
        const dz = Position.z[beid] - pz;
        if (dx * dx + dz * dz < viewRangeSq) {
          const typeId = BuildingType.id[beid];
          const bName = this.buildingTypeNames[typeId] ?? 'Building';
          this.knownEnemyPositions.set(beid + 100000, {
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

  /** Set the unit type name lookup array (from index.ts unitTypeNames) */
  setUnitTypeNames(names: string[]): void {
    this.unitTypeNamesCache = names;
  }

  /** Inject spatial grid for O(k) neighbor queries instead of O(n) scans */
  setSpatialGrid(grid: SpatialGrid): void {
    this.spatialGrid = grid;
  }

  /** Get a unit type name from an entity's UnitType.id component */
  private getUnitTypeName(eid: number): string | null {
    const typeId = UnitType.id[eid];
    return this.unitTypeNamesCache[typeId] ?? null;
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
      if (this.specialEntities.has(eid)) continue;

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
    const baseHarvesters = this.difficultyLevel === 'hard' ? 3 : 2;
    const desiredHarvesters = Math.max(2, Math.min(5, Math.round(baseHarvesters * this.economyBias)));

    if (harvesterCount < desiredHarvesters) {
      const solaris = this.harvestSystem.getSolaris(this.playerId);
      const harvName = `${this.factionPrefix}Harvester`;
      const minCost = this.production ? this.production.getAdjustedCost(this.playerId, harvName, false) : 600;
      if (solaris < minCost) return; // Can't afford one

      // Try to find a harvester unit type in the rules
      const harvesterNames = [
        `${this.factionPrefix}Harvester`,
        `${this.factionPrefix}harvester`,
        'Harvester', // Generic shared harvester type
      ];

      // Also search all units for any harvester-type unit
      for (const [name] of this.rules.units) {
        if (name.toLowerCase().includes('harvester') &&
            (name.startsWith(this.factionPrefix) || name === 'Harvester')) {
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

  /** Repair the most damaged AI building (prioritizing critical ones) */
  private repairBuildings(world: World): void {
    if (!this.harvestSystem) return;

    const solaris = this.harvestSystem.getSolaris(this.playerId);
    if (solaris < 300) return; // Don't repair if low on funds

    const buildings = buildingQuery(world);
    let worstEid = -1;
    let worstScore = 0;

    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;

      const hp = Health.current[eid];
      const maxHp = Health.max[eid];
      if (hp >= maxHp) continue;

      const damageRatio = 1 - hp / maxHp;
      if (damageRatio < 0.1) continue; // Don't repair minor scratches

      // Priority: ConYard > Refinery > Factory > Barracks > Windtrap > other
      const typeId = BuildingType.id[eid];
      const name = this.buildingTypeNames[typeId] ?? '';
      let priority = 1;
      if (name.includes('ConYard')) priority = 10;
      else if (name.includes('Refinery')) priority = 8;
      else if (name.includes('Factory')) priority = 6;
      else if (name.includes('Barracks')) priority = 4;
      else if (name.includes('Windtrap')) priority = 3;
      else if (name.includes('Turret')) priority = 2;

      const score = damageRatio * priority;
      if (score > worstScore) {
        worstScore = score;
        worstEid = eid;
      }
    }

    if (worstEid < 0) return;

    // Repair 20% per tick, costs 5% of building cost
    const maxHp = Health.max[worstEid];
    const repairAmount = Math.min(maxHp * 0.2, maxHp - Health.current[worstEid]);
    const typeId = BuildingType.id[worstEid];
    const typeName = this.buildingTypeNames[typeId];
    const bDef = typeName ? this.rules.buildings.get(typeName) : null;
    const cost = bDef ? Math.floor(bDef.cost * 0.05) : 50;

    if (this.harvestSystem.spendSolaris(this.playerId, cost)) {
      Health.current[worstEid] = Math.min(Health.max[worstEid], Health.current[worstEid] + repairAmount);
    }
  }

  // ==========================================
  // Strategic Building Placement
  // ==========================================

  /** Determine the ideal position for a new building based on its role */
  getNextBuildingPlacement(typeName: string, def: BuildingDef): { x: number; z: number } {
    const baseX = this.baseX;
    const baseZ = this.baseZ;

    // Direction TOWARD player (for defensive buildings)
    const toPlayerX = this.targetX - baseX;
    const toPlayerZ = this.targetZ - baseZ;
    const dist = Math.sqrt(toPlayerX * toPlayerX + toPlayerZ * toPlayerZ) || 1;
    const dirX = toPlayerX / dist;
    const dirZ = toPlayerZ / dist;

    // Direction AWAY from player (for economy/power)
    const awayX = -dirX;
    const awayZ = -dirZ;

    let idealX = baseX;
    let idealZ = baseZ;

    if (typeName.includes('Wall')) {
      // Walls: build a defensive line perpendicular to the player direction, in front of base
      const perpX = -dirZ;
      const perpZ = dirX;
      // Count existing walls to stagger placement along the line
      const existingWalls = this.placedBuildings.filter(b => b.name.includes('Wall')).length;
      const offset = (existingWalls - 3.5) * 2.5; // Spread walls evenly along perpendicular
      idealX = baseX + dirX * 8 + perpX * offset;
      idealZ = baseZ + dirZ * 8 + perpZ * offset;
    } else if (def.powerGenerated > 0) {
      // Windtraps: behind base, away from player
      idealX = baseX + awayX * 8 + (Math.random() - 0.5) * 6;
      idealZ = baseZ + awayZ * 8 + (Math.random() - 0.5) * 6;
    } else if (def.refinery) {
      // Refineries: to the side of base (perpendicular to player direction)
      const perpX = -dirZ;
      const perpZ = dirX;
      const side = Math.random() > 0.5 ? 1 : -1;
      idealX = baseX + perpX * 10 * side + (Math.random() - 0.5) * 4;
      idealZ = baseZ + perpZ * 10 * side + (Math.random() - 0.5) * 4;
    } else if (def.aiDefence || def.turretAttach) {
      // Turrets/defense: toward player, in front of base
      idealX = baseX + dirX * 10 + (Math.random() - 0.5) * 8;
      idealZ = baseZ + dirZ * 10 + (Math.random() - 0.5) * 8;
    } else if (typeName.includes('Barracks') || typeName.includes('Factory') || typeName.includes('Hanger')) {
      // Production buildings: near center with slight random offset
      idealX = baseX + (Math.random() - 0.5) * 8;
      idealZ = baseZ + (Math.random() - 0.5) * 8;
    } else {
      // Other buildings (Palace, Research, etc.): near base
      idealX = baseX + (Math.random() - 0.5) * 10;
      idealZ = baseZ + (Math.random() - 0.5) * 10;
    }

    // Validate and adjust position
    const result = this.findValidPlacement(idealX, idealZ, typeName.includes('Wall'));

    // Track the placed building and update base center of mass
    this.placedBuildings.push({ x: result.x, z: result.z, name: typeName });
    this.updateBaseCenterOfMass();

    return result;
  }

  /** Find a valid placement near the ideal position using spiral search */
  private findValidPlacement(idealX: number, idealZ: number, isWall = false): { x: number; z: number } {
    const worldMaxX = this.mapWidth * TILE_SIZE;
    const worldMaxZ = this.mapHeight * TILE_SIZE;
    const margin = 4; // Keep buildings away from map edges
    const minSpacing = isWall ? 2 : 4; // Walls can be placed closer together

    // Try the ideal position first, then spiral outward
    for (let ring = 0; ring < 10; ring++) {
      const steps = ring === 0 ? 1 : ring * 8;
      const radius = ring * 3;

      for (let step = 0; step < steps; step++) {
        let tryX: number, tryZ: number;

        if (ring === 0) {
          tryX = idealX;
          tryZ = idealZ;
        } else {
          const angle = (step / steps) * Math.PI * 2;
          tryX = idealX + Math.cos(angle) * radius;
          tryZ = idealZ + Math.sin(angle) * radius;
        }

        // Clamp to map boundaries with margin
        tryX = Math.max(margin, Math.min(worldMaxX - margin, tryX));
        tryZ = Math.max(margin, Math.min(worldMaxZ - margin, tryZ));

        // Check minimum spacing against all existing AI buildings
        let tooClose = false;
        for (const placed of this.placedBuildings) {
          const dx = placed.x - tryX;
          const dz = placed.z - tryZ;
          if (dx * dx + dz * dz < minSpacing * minSpacing) {
            tooClose = true;
            break;
          }
        }

        if (!tooClose) {
          return { x: tryX, z: tryZ };
        }
      }
    }

    // Fallback: return ideal position clamped to map bounds
    return {
      x: Math.max(margin, Math.min(worldMaxX - margin, idealX)),
      z: Math.max(margin, Math.min(worldMaxZ - margin, idealZ)),
    };
  }

  /** Update the AI base position, anchored to the Construction Yard.
   *  Falls back to center of mass only if no ConYard exists. */
  private updateBaseCenterOfMass(): void {
    if (this.placedBuildings.length === 0) return;

    // Anchor to ConYard if one exists — prevents base drift from expansion buildings
    const conYard = this.placedBuildings.find(b => b.name.includes('ConYard'));
    if (conYard) {
      this.baseX = conYard.x;
      this.baseZ = conYard.z;
      return;
    }

    // Fallback: center of mass when ConYard is destroyed
    let sumX = 0;
    let sumZ = 0;
    for (const b of this.placedBuildings) {
      sumX += b.x;
      sumZ += b.z;
    }
    this.baseX = sumX / this.placedBuildings.length;
    this.baseZ = sumZ / this.placedBuildings.length;
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

    // Emergency power check: always prioritize windtraps when in power deficit
    const powerMult = this.production.getPowerMultiplier(this.playerId);
    if (powerMult < 1.0 && solaris >= 250) {
      const windtrapName = `${px}SmWindtrap`;
      const bldQueue = this.production.getQueue(this.playerId, true);
      const alreadyQueued = bldQueue.some(q => q.typeName === windtrapName);
      if (!alreadyQueued && this.production.canBuild(this.playerId, windtrapName, true)) {
        this.production.startProduction(this.playerId, windtrapName, true);
        return;
      }
    }

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
      { name: `${px}Outpost`, minSolaris: 400, phase: 4 }, // Radar + tech unlock
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 5 },
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 6 },
      { name: `${px}Refinery`, minSolaris: 1600, phase: 7 }, // Second refinery
      { name: `${px}Hanger`, minSolaris: 1000, phase: 8 },
      { name: `${px}SmWindtrap`, minSolaris: 300, phase: 9 },
    ];

    if (this.buildPhase < buildOrder.length) {
      const order = buildOrder[this.buildPhase];
      if (solaris >= order.minSolaris) {
        const def = this.rules.buildings.get(order.name);
        if (!def) {
          // Building doesn't exist in rules — skip permanently
          this.buildPhase++;
        } else if (this.production.canBuild(this.playerId, order.name, true)) {
          if (this.production.startProduction(this.playerId, order.name, true)) {
            this.buildPhase++;
          }
        }
        // If canBuild is false (missing prerequisite), don't advance — retry next tick
      }
    } else {
      // Proactive upgrade: scan unit pool for units needing upgradedPrimaryRequired
      // and upgrade those buildings first, then fall back to generic upgrade priority
      if (solaris > 800) {
        const neededUpgrades = new Set<string>();
        for (const unitName of this.unitPool) {
          const uDef = this.rules.units.get(unitName);
          if (uDef?.upgradedPrimaryRequired && uDef.primaryBuilding) {
            if (!this.production.isUpgraded(this.playerId, uDef.primaryBuilding)) {
              neededUpgrades.add(uDef.primaryBuilding);
            }
          }
        }
        // Also check building pool for upgradedPrimaryRequired buildings
        const allBuildings = [`${px}Factory`, `${px}Barracks`, `${px}ConYard`, `${px}Hanger`];
        if (this.subhousePrefix) {
          const subBuildings: Record<string, string[]> = {
            'FR': ['FRFremenCamp'], 'IM': ['IMBarracks'], 'IX': ['IXResCentre'],
            'TL': ['TLFleshVat'], 'GU': ['GUPalace'],
          };
          allBuildings.push(...(subBuildings[this.subhousePrefix] ?? []));
        }
        for (const bName of allBuildings) {
          const bDef = this.rules.buildings.get(bName);
          if (bDef?.upgradedPrimaryRequired && bDef.primaryBuilding) {
            if (!this.production.isUpgraded(this.playerId, bDef.primaryBuilding)) {
              neededUpgrades.add(bDef.primaryBuilding);
            }
          }
        }

        // Try upgrading buildings that unlock units first
        let startedUpgrade = false;
        for (const bType of neededUpgrades) {
          if (this.production.canUpgrade(this.playerId, bType)) {
            this.production.startUpgrade(this.playerId, bType);
            startedUpgrade = true;
            break;
          }
        }
        // Then try generic upgrades for tech level progression
        if (!startedUpgrade && solaris > 1500) {
          for (const bType of allBuildings) {
            if (this.production.canUpgrade(this.playerId, bType)) {
              this.production.startUpgrade(this.playerId, bType);
              break;
            }
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
      const defensiveTurretCap = Math.max(3, Math.floor(4 * this.defenseBias));
      if (this.baseUnderAttack && turretCount < defensiveTurretCap && solaris > 500) {
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
      const desiredRefineries = Math.max(2, Math.min(5, Math.round((2 + Math.floor(this.difficulty)) * this.economyBias)));
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
      const periodicTurretCap = Math.max(4, Math.floor(6 * this.defenseBias));
      if (turretCount < periodicTurretCap && solaris > 800 && Math.random() < 0.25) {
        const turretTypes = [`${px}GunTurret`, `${px}RocketTurret`, `${px}Turret`];
        for (const turret of turretTypes) {
          if (this.production.canBuild(this.playerId, turret, true)) {
            this.production.startProduction(this.playerId, turret, true);
            return;
          }
        }
      }

      // Priority 5.5: Defensive walls (build a line of walls toward the player, cap at 8)
      let wallCount = 0;
      for (const eid of buildings) {
        if (Owner.playerId[eid] !== this.playerId || Health.current[eid] <= 0) continue;
        const name = this.buildingTypeNames[BuildingType.id[eid]] ?? '';
        if (name.includes('Wall')) wallCount++;
      }
      if (wallCount < 8 && turretCount >= 2 && solaris > 200 && Math.random() < 0.3) {
        const wallName = `${px}Wall`;
        if (this.production.canBuild(this.playerId, wallName, true)) {
          this.production.startProduction(this.playerId, wallName, true);
          return;
        }
      }

      // Priority 6: Advanced structures (starport, hangar, palace)
      if (totalBuildings < 20 && solaris > 2000) {
        const advBuildings = [`${px}Outpost`, `${px}Starport`, `${px}Hanger`, `${px}Palace`];
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

  /** Train aircraft when the AI has a Hanger/Helipad */
  private trainAircraft(): void {
    if (!this.production || !this.harvestSystem) return;
    const solaris = this.harvestSystem.getSolaris(this.playerId);
    if (solaris < 800) return; // Aircraft are expensive — only build with surplus

    const buildable = this.aircraftPool.filter(name =>
      this.production!.canBuild(this.playerId, name, false)
    );
    if (buildable.length === 0) return;

    const typeName = buildable[Math.floor(Math.random() * buildable.length)];
    this.production.startProduction(this.playerId, typeName, false);
  }

  /** Buy units from the Starport when prices are favorable */
  private useStarport(): void {
    if (!this.production || !this.harvestSystem) return;
    const solaris = this.harvestSystem.getSolaris(this.playerId);
    if (solaris < 1000) return;

    // Must own a Starport building
    if (!this.production.ownsAnyBuildingSuffix(this.playerId, 'Starport')) return;

    const offers = this.production.getStarportOffers(this.factionPrefix, this.playerId);
    if (offers.length === 0) return;

    // Find best deal: lowest price relative to base cost
    let bestDeal: { name: string; price: number; ratio: number } | null = null;
    for (const offer of offers) {
      const def = this.rules.units.get(offer.name);
      if (!def) continue;
      const ratio = offer.price / def.cost; // < 1.0 = discount
      if (ratio < 1.1 && offer.price <= solaris) { // Buy if at most 10% markup
        if (!bestDeal || ratio < bestDeal.ratio) {
          bestDeal = { name: offer.name, price: offer.price, ratio };
        }
      }
    }

    if (bestDeal) {
      this.production.buyFromStarport(this.playerId, bestDeal.name);
    }
  }

  /** Train a special unit (engineer, saboteur, infiltrator, deviator) */
  private trainSpecialUnit(): void {
    if (!this.production || !this.harvestSystem) return;
    const solaris = this.harvestSystem.getSolaris(this.playerId);
    if (solaris < 1000) return; // Special units are a luxury — only with surplus funds

    const buildable = this.specialPool.filter(name =>
      this.production!.canBuild(this.playerId, name, false)
    );
    if (buildable.length === 0) return;

    // Limit special units: max 3 alive at a time
    this.cleanupSpecialEntities();
    if (this.specialEntities.size >= 3) return;

    const typeName = buildable[Math.floor(Math.random() * buildable.length)];
    this.production.startProduction(this.playerId, typeName, false);
  }

  /** Deploy idle special units toward enemy buildings */
  private deploySpecialUnits(world: World): void {
    this.cleanupSpecialEntities();

    const units = unitQuery(world);

    // Find idle special units belonging to this AI
    const idleSpecials: number[] = [];
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;

      const typeName = this.getUnitTypeName(eid);
      if (!typeName) continue;
      const def = this.rules.units.get(typeName);
      if (!def?.aiSpecial || def.deviator) continue;

      // Track this entity as a special unit
      this.specialEntities.add(eid);

      // Only command idle specials (not already on a mission)
      if (MoveTarget.active[eid] === 1) continue;

      idleSpecials.push(eid);
    }

    if (idleSpecials.length === 0) return;

    // Find enemy buildings to target
    const buildings = buildingQuery(world);
    const targets: { eid: number; x: number; z: number; priority: number }[] = [];
    for (const bid of buildings) {
      if (Owner.playerId[bid] === this.playerId) continue;
      if (Health.current[bid] <= 0) continue;

      // Prioritize high-value targets
      const bTypeId = BuildingType.id[bid];
      const bName = this.buildingTypeNames[bTypeId] ?? '';
      const bDef = bName ? this.rules.buildings.get(bName) : null;

      let priority = 1;
      if (bName.includes('ConYard') || bName.includes('Conyard')) priority = 5;
      else if (bName.includes('Refinery')) priority = 4;
      else if (bName.includes('Factory')) priority = 3;
      else if (bDef?.powerGenerated && bDef.powerGenerated > 0) priority = 2;

      targets.push({
        eid: bid,
        x: Position.x[bid],
        z: Position.z[bid],
        priority,
      });
    }

    if (targets.length === 0) return;

    // Sort by priority (highest first)
    targets.sort((a, b) => b.priority - a.priority);

    // Assign each special unit to a target building
    for (let i = 0; i < idleSpecials.length; i++) {
      const eid = idleSpecials[i];
      // Cycle through targets so multiple specials don't all go to the same building
      const target = targets[i % targets.length];

      MoveTarget.x[eid] = target.x + randomFloat(-3, 3);
      MoveTarget.z[eid] = target.z + randomFloat(-3, 3);
      MoveTarget.active[eid] = 1;
    }
  }

  /** Remove dead/destroyed/recycled entities from specialEntities tracking */
  private cleanupSpecialEntities(): void {
    for (const eid of this.specialEntities) {
      if (Health.current[eid] <= 0 || Owner.playerId[eid] !== this.playerId) {
        this.specialEntities.delete(eid);
        continue;
      }
      // Verify entity still has aiSpecial flag (handles entity ID reuse)
      const typeName = this.getUnitTypeName(eid);
      const def = typeName ? this.rules.units.get(typeName) : null;
      if (!def?.aiSpecial || def.deviator) {
        this.specialEntities.delete(eid);
      }
    }
  }

  private spawnWave(world: World): void {
    if (this.unitPool.length === 0) return;
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
      // Skip special units (engineers, saboteurs, etc.) - they have their own deployment
      if (this.specialEntities.has(eid)) continue;
      totalUnits++;

      if (MoveTarget.active[eid] === 0) {
        idleUnits.push(eid);
        // Check if near base (wider radius for larger armies)
        const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
        if (dist < 60) nearBaseUnits.push(eid);
      }
    }

    // Scale max defenders with difficulty
    const scaledMaxDefenders = Math.max(2, Math.floor(this.maxDefenders * this.difficulty * this.defenseBias));

    // Ensure we have some defenders near base
    if (this.defenders.size < scaledMaxDefenders && nearBaseUnits.length > scaledMaxDefenders) {
      for (const eid of nearBaseUnits) {
        if (this.defenders.size >= scaledMaxDefenders) break;
        if (!this.defenders.has(eid)) {
          this.defenders.add(eid);
        }
      }
    }

    // Dynamic attack threshold: higher difficulty = attack sooner with fewer units
    const attackThreshold = Math.max(3, Math.floor(this.attackGroupSize / (this.difficulty * this.aggressionBias)));
    const effectiveAttackCooldown = Math.max(150, Math.floor(this.attackCooldown / this.aggressionBias));
    const canAttack = this.tickCounter - this.lastAttackTick > effectiveAttackCooldown;

    // Filter out designated defenders from attack group
    const attackableUnits = nearBaseUnits.filter(eid => !this.defenders.has(eid));

    if (attackableUnits.length >= attackThreshold && canAttack) {
      this.lastAttackTick = this.tickCounter;

      // Hard difficulty: split off 2-3 fast units for harvester harassment
      let harassUnits: number[] = [];
      let mainUnits = attackableUnits;
      if (this.difficultyLevel === 'hard' && attackableUnits.length > 5) {
        harassUnits = attackableUnits.slice(-3);
        mainUnits = attackableUnits.slice(0, -3);
      }

      // Plan multi-front attack objectives from scout data
      const objectives = this.planAttackObjectives();

      if (objectives.length <= 1) {
        // Single objective: original 2-group flank behavior
        const target = objectives[0] ?? { x: this.targetX, z: this.targetZ };
        const groupSize = Math.ceil(mainUnits.length / 2);
        const group1 = mainUnits.slice(0, groupSize);
        const group2 = mainUnits.slice(groupSize);

        const angle1 = Math.atan2(target.z - this.baseZ, target.x - this.baseX);
        const flankAngle = (Math.random() * 0.5 + 0.4) * (Math.random() < 0.5 ? 1 : -1);
        const angle2 = angle1 + flankAngle;

        for (const eid of group1) {
          const spread = randomFloat(-10, 10);
          MoveTarget.x[eid] = target.x + Math.cos(angle1 + 1.57) * spread;
          MoveTarget.z[eid] = target.z + Math.sin(angle1 + 1.57) * spread;
          MoveTarget.active[eid] = 1;
        }
        // Set attack-move so units engage enemies while marching
        this.combatSystem.setAttackMove([...group1]);
        if (group2.length > 0) {
          const flankDist = 30;
          for (const eid of group2) {
            MoveTarget.x[eid] = target.x + Math.cos(angle2) * flankDist + randomFloat(-8, 8);
            MoveTarget.z[eid] = target.z + Math.sin(angle2) * flankDist + randomFloat(-8, 8);
            MoveTarget.active[eid] = 1;
          }
          this.combatSystem.setAttackMove([...group2]);
        }
      } else {
        // Multi-front: assign units to closest objective to minimize travel
        const groups: number[][] = objectives.map(() => []);
        for (const eid of mainUnits) {
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
          this.combatSystem.setAttackMove([...group]);
        }
      }

      // Dispatch harassment group concurrently (hard difficulty)
      if (harassUnits.length > 0) {
        this.sendHarassGroup(world, harassUnits);
      }
    } else if (idleUnits.length > 0 && idleUnits.length < attackThreshold) {
      // Rally idle units toward enemy side of base
      const toTargetX = this.targetX - this.baseX;
      const toTargetZ = this.targetZ - this.baseZ;
      const tDist = Math.sqrt(toTargetX * toTargetX + toTargetZ * toTargetZ) || 1;
      const rallyDirX = toTargetX / tDist;
      const rallyDirZ = toTargetZ / tDist;

      for (const eid of idleUnits) {
        if (this.defenders.has(eid)) continue; // Don't rally defenders away from base
        const rallyX = this.baseX + rallyDirX * 15 + randomFloat(-8, 8);
        const rallyZ = this.baseZ + rallyDirZ * 15 + randomFloat(-8, 8);
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
      // Special units (engineers, saboteurs) don't retreat — they're on suicide missions
      if (this.specialEntities.has(eid)) continue;

      const ratio = Health.max[eid] > 0 ? Health.current[eid] / Health.max[eid] : 1;
      const retreatThreshold = Math.max(0.1, Math.min(0.95, this.retreatHealthPct * this.retreatBias));
      if (ratio < retreatThreshold) {
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
    let activeDamageDetected = false;

    // Detect ACTIVE damage by comparing current health to snapshot
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) {
        this.buildingHealthSnapshot.delete(eid);
        continue;
      }

      const prevHealth = this.buildingHealthSnapshot.get(eid);
      const currHealth = Health.current[eid];
      this.buildingHealthSnapshot.set(eid, currHealth);

      // Building lost health since last check = actively taking damage
      if (prevHealth !== undefined && currHealth < prevHealth) {
        activeDamageDetected = true;
      }
    }

    // Also detect enemies near base as an attack indicator
    if (!activeDamageDetected) {
      const baseCheckRadius = 30;
      if (this.spatialGrid) {
        const nearby = this.spatialGrid.getInRadius(this.baseX, this.baseZ, baseCheckRadius);
        for (let i = 0; i < nearby.length; i++) {
          const eid = nearby[i];
          if (Owner.playerId[eid] === this.playerId) continue;
          if (Health.current[eid] <= 0) continue;
          const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
          if (dist < baseCheckRadius) {
            activeDamageDetected = true;
            break;
          }
        }
      } else {
        const units = unitQuery(world);
        for (const eid of units) {
          if (Owner.playerId[eid] === this.playerId) continue;
          if (Health.current[eid] <= 0) continue;
          const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
          if (dist < baseCheckRadius) {
            activeDamageDetected = true;
            break;
          }
        }
      }
    }

    if (activeDamageDetected) {
      this.baseAttackTick = this.tickCounter;
      if (!this.baseUnderAttack) {
        this.baseUnderAttack = true;
        // Emergency: recall all idle units to defend base
        this.recallDefenders(world);
      }
    } else if (this.baseUnderAttack) {
      // All clear after 15 seconds of no active damage
      if (this.tickCounter - this.baseAttackTick > 375) {
        this.baseUnderAttack = false;
        // Counterattack: immediately send rallied forces (they're already gathered at base)
        this.launchCounterattack(world);
      }
    }

    // Active defense: make defenders engage nearby enemies during attack
    if (this.baseUnderAttack) {
      this.engageNearbyEnemies(world);
    }

    // Clean up stale defenders (dead, deviated, or wandered too far)
    for (const eid of this.defenders) {
      if (Health.current[eid] <= 0 || Owner.playerId[eid] !== this.playerId) {
        this.defenders.delete(eid);
      } else {
        const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
        if (dist > 80) this.defenders.delete(eid);
      }
    }
  }

  private recallDefenders(world: World): void {
    const units = unitQuery(world);
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (hasComponent(world, Harvester, eid)) continue;
      if (this.specialEntities.has(eid)) continue;

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

  /** After surviving a base attack, launch immediate counterattack with rallied forces */
  private launchCounterattack(world: World): void {
    const units = unitQuery(world);
    const attackForce: number[] = [];

    for (const eid of units) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (hasComponent(world, Harvester, eid)) continue;
      if (this.scoutEntities.has(eid)) continue;
      if (this.specialEntities.has(eid)) continue;

      // Only send healthy units (>50% HP) on counterattack
      const hpRatio = Health.max[eid] > 0 ? Health.current[eid] / Health.max[eid] : 1;
      if (hpRatio < 0.5) continue;

      const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
      if (dist < 60) {
        attackForce.push(eid);
      }
    }

    // Need at least 3 units for a meaningful counterattack
    if (attackForce.length < 3) return;

    // Keep some defenders behind (half of scaled maxDefenders)
    const scaledMaxDefenders = Math.max(2, Math.floor(this.maxDefenders * this.difficulty * this.defenseBias));
    const keepBack = Math.floor(scaledMaxDefenders / 2);
    this.defenders.clear();
    for (let i = 0; i < keepBack && i < attackForce.length; i++) {
      this.defenders.add(attackForce[i]);
    }
    const counterForce = attackForce.filter(eid => !this.defenders.has(eid));
    if (counterForce.length < 2) return;

    // Send toward where the attackers came from, or fall back to primary target
    const tx = this.lastAttackerCentroid?.x ?? this.targetX;
    const tz = this.lastAttackerCentroid?.z ?? this.targetZ;
    this.lastAttackerCentroid = null;

    for (const eid of counterForce) {
      MoveTarget.x[eid] = tx + randomFloat(-12, 12);
      MoveTarget.z[eid] = tz + randomFloat(-12, 12);
      MoveTarget.active[eid] = 1;
    }
    this.combatSystem.setAttackMove([...counterForce]);

    // Reset attack cooldown so this doesn't interfere with normal attack scheduling
    this.lastAttackTick = this.tickCounter;
  }

  /** During base defense, make nearby units actively engage enemy attackers */
  private engageNearbyEnemies(world: World): void {
    const enemies: number[] = [];

    // Find enemy units near AI base using spatial grid
    const engageRadius = 40;
    if (this.spatialGrid) {
      const nearby = this.spatialGrid.getInRadius(this.baseX, this.baseZ, engageRadius);
      for (let i = 0; i < nearby.length; i++) {
        const eid = nearby[i];
        if (Owner.playerId[eid] === this.playerId) continue;
        if (Health.current[eid] <= 0) continue;
        const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
        if (dist < engageRadius) {
          enemies.push(eid);
        }
      }
    } else {
      const allUnits = unitQuery(world);
      for (const eid of allUnits) {
        if (Owner.playerId[eid] === this.playerId) continue;
        if (Health.current[eid] <= 0) continue;
        const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
        if (dist < engageRadius) {
          enemies.push(eid);
        }
      }
    }

    if (enemies.length === 0) return;

    // Track attacker centroid for smarter counterattack direction
    let centroidX = 0, centroidZ = 0;
    for (const eid of enemies) {
      centroidX += Position.x[eid];
      centroidZ += Position.z[eid];
    }
    this.lastAttackerCentroid = {
      x: centroidX / enemies.length,
      z: centroidZ / enemies.length,
    };

    // Assign idle defenders and nearby units to attack the closest enemy
    const defenderRadius = 50;
    const candidates = this.spatialGrid
      ? this.spatialGrid.getInRadius(this.baseX, this.baseZ, defenderRadius)
      : unitQuery(world);

    for (const eid of candidates) {
      if (Owner.playerId[eid] !== this.playerId) continue;
      if (Health.current[eid] <= 0) continue;
      if (hasComponent(world, Harvester, eid)) continue;

      // Only engage units near base that aren't already attacking
      const dist = distance2D(Position.x[eid], Position.z[eid], this.baseX, this.baseZ);
      if (dist > defenderRadius) continue;

      // Skip units that already have an active attack target
      if (hasComponent(world, AttackTarget, eid) && AttackTarget.active[eid] === 1) continue;

      // Find closest enemy
      let closestEnemy = -1;
      let closestDist = Infinity;
      for (const enemy of enemies) {
        const d = distance2D(Position.x[eid], Position.z[eid], Position.x[enemy], Position.z[enemy]);
        if (d < closestDist) {
          closestDist = d;
          closestEnemy = enemy;
        }
      }

      if (closestEnemy >= 0 && closestDist < 30) {
        if (hasComponent(world, AttackTarget, eid)) {
          AttackTarget.entityId[eid] = closestEnemy;
          AttackTarget.active[eid] = 1;
        }
        MoveTarget.x[eid] = Position.x[closestEnemy];
        MoveTarget.z[eid] = Position.z[closestEnemy];
        MoveTarget.active[eid] = 1;
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
      if (this.specialEntities.has(eid)) continue;
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
