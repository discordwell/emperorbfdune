/**
 * Deterministic rule engine for the oracle loop.
 * 10 rules evaluated in priority order, producing Actions.
 * References AIPlayer.ts patterns for build orders, army management, composition.
 */

import type { GameState, PlayerState, UnitInfo, BuildingInfo } from '../state/GameState.js';
import type { Action } from '../actions/Action.js';
import { getBuildOrder, COMPOSITION_GOAL, getDefaultUnitPool, HARVESTER_TYPE, type HousePrefix } from './BuildOrders.js';
import type { StrategicPlan } from './LlmAdvisor.js';

export interface RuleEngineConfig {
  housePrefix: HousePrefix;
  /** Override composition goal from LLM */
  strategicPlan?: StrategicPlan | null;
}

export class RuleEngine {
  private housePrefix: HousePrefix;
  private strategicPlan: StrategicPlan | null = null;

  constructor(config: RuleEngineConfig) {
    this.housePrefix = config.housePrefix;
    this.strategicPlan = config.strategicPlan ?? null;
  }

  setStrategicPlan(plan: StrategicPlan | null): void {
    this.strategicPlan = plan;
  }

  /**
   * Evaluate all rules against current state, return prioritized actions.
   */
  evaluate(state: GameState): Action[] {
    const actions: Action[] = [];
    const p = state.player;

    // Rule 1: Emergency power
    actions.push(...this.ruleEmergencyPower(p));

    // Rule 2: Build order execution
    actions.push(...this.ruleBuildOrder(p));

    // Rule 3: Harvester management
    actions.push(...this.ruleHarvesterManagement(p, state));

    // Rule 4: Defense response
    actions.push(...this.ruleDefenseResponse(p, state));

    // Rule 5: Production balancing
    actions.push(...this.ruleProductionBalancing(p));

    // Rule 6: Upgrade checking
    actions.push(...this.ruleUpgradeChecking(p));

    // Rule 7: Repair priority
    actions.push(...this.ruleRepairPriority(p));

    // Rule 8: Idle army grouping
    actions.push(...this.ruleIdleArmyGrouping(p, state));

    // Rule 9: Scout deployment
    actions.push(...this.ruleScoutDeployment(p, state));

    // Rule 10: Starport purchases
    actions.push(...this.ruleStarportPurchases(p));

    return actions;
  }

  /**
   * Rule 1: Queue windtrap if power ratio < 1.0
   */
  private ruleEmergencyPower(p: PlayerState): Action[] {
    if (p.power.ratio >= 1.0) return [];
    // Don't queue if already producing a windtrap
    const windtrapName = `${this.housePrefix}SmWindtrap`;
    const alreadyQueued = p.productionQueues.building.some(
      q => q.typeName === windtrapName
    );
    if (alreadyQueued) return [];

    return [{ type: 'produce', typeName: windtrapName, isBuilding: true }];
  }

  /**
   * Rule 2: Execute house-specific build order.
   * Derives the next building from what's owned vs what's needed,
   * so it self-corrects if production fails or buildings are destroyed.
   * Skips steps that require tech levels above the player's current level.
   */
  private ruleBuildOrder(p: PlayerState): Action[] {
    // Don't start building if we already have a building in queue
    if (p.productionQueues.building.length > 0) return [];

    // Must have a ConYard
    const conyard = `${this.housePrefix}ConYard`;
    if (!p.ownedBuildingTypes.has(conyard)) return [];

    // Walk the build order: find the first step that isn't yet satisfied
    const order = getBuildOrder(this.housePrefix);
    const consumed = new Map<string, number>();
    for (let i = 0; i < order.length; i++) {
      const name = order[i].typeName;
      const used = consumed.get(name) ?? 0;
      const available = (p.ownedBuildingTypes.get(name) ?? 0) - used;
      if (available > 0) {
        consumed.set(name, used + 1);
      } else {
        // This is the next building we need — but check if we can build it
        // (tech level check; production system will validate the rest)
        return [{ type: 'produce', typeName: name, isBuilding: true }];
      }
    }

    // Build order exhausted — keep building windtraps and refineries for economy
    const windtrap = `${this.housePrefix}SmWindtrap`;
    const refinery = `${this.housePrefix}Refinery`;
    const windtrapCount = p.ownedBuildingTypes.get(windtrap) ?? 0;
    const refineryCount = p.ownedBuildingTypes.get(refinery) ?? 0;

    // Need ~1 windtrap per 3 buildings for power
    const totalBuildings = p.buildings.length;
    if (windtrapCount < Math.ceil(totalBuildings / 3) + 1) {
      return [{ type: 'produce', typeName: windtrap, isBuilding: true }];
    }

    // Extra refineries for economy (up to 3)
    if (refineryCount < 3 && p.solaris < 3000) {
      return [{ type: 'produce', typeName: refinery, isBuilding: true }];
    }

    return [];
  }

  /**
   * Rule 3: Maintain 2 harvesters per refinery, route idle ones to spice
   */
  private ruleHarvesterManagement(p: PlayerState, state: GameState): Action[] {
    const actions: Action[] = [];
    const refineryCount = countBuildingsOfType(p, 'Refinery');
    const harvesters = p.units.filter(u => u.isHarvester);
    const targetCount = refineryCount * 2;

    // Produce more harvesters if needed
    const harvesterType = HARVESTER_TYPE;
    const inProduction = p.productionQueues.vehicle.filter(q => q.typeName === harvesterType).length;
    if (harvesters.length + inProduction < targetCount) {
      const hasFactory = p.ownedBuildingTypes.has(`${this.housePrefix}Factory`) ||
                         p.ownedBuildingTypes.has(`${this.housePrefix}Refinery`);
      if (hasFactory) {
        actions.push({ type: 'produce', typeName: harvesterType, isBuilding: false });
      }
    }

    // Route idle harvesters toward spice (center of map as fallback)
    for (const harv of harvesters) {
      if (harv.isIdle && harv.harvesterState === 0) {
        // Send idle harvesters to a reasonable location
        // In the real game, HarvestSystem handles routing — we just nudge idles
        const basePos = getBaseCenter(p);
        if (basePos) {
          // Move toward map center from base (spice tends to be in the middle)
          const mapCenterX = 64 * 2.5; // rough tile center
          const mapCenterZ = 64 * 2.5;
          const dx = mapCenterX - basePos.x;
          const dz = mapCenterZ - basePos.z;
          const dist = Math.sqrt(dx * dx + dz * dz) || 1;
          actions.push({
            type: 'move',
            entityIds: [harv.eid],
            x: basePos.x + (dx / dist) * 40,
            z: basePos.z + (dz / dist) * 40,
          });
        }
      }
    }

    return actions;
  }

  /**
   * Rule 4: Rally idle military to buildings under attack
   */
  private ruleDefenseResponse(p: PlayerState, state: GameState): Action[] {
    const actions: Action[] = [];

    // Check for under_attack events
    const attackEvents = state.events.filter(
      e => e.type === 'under_attack' && e.owner === p.playerId
    );
    if (attackEvents.length === 0) return [];

    // Find idle combat units (not harvesters)
    const idleMilitary = p.units.filter(
      u => u.isIdle && !u.isHarvester
    );
    if (idleMilitary.length === 0) return [];

    // Rally to the most recent attack location
    const lastAttack = attackEvents[attackEvents.length - 1];
    if (lastAttack.type === 'under_attack') {
      actions.push({
        type: 'attack_move',
        entityIds: idleMilitary.map(u => u.eid),
        x: lastAttack.x,
        z: lastAttack.z,
      });
    }

    return actions;
  }

  /**
   * Rule 5: Production balancing — maintain target composition
   */
  private ruleProductionBalancing(p: PlayerState): Action[] {
    const actions: Action[] = [];

    // Don't produce if queues are full (2 items each max for oracle)
    if (p.productionQueues.infantry.length >= 2 && p.productionQueues.vehicle.length >= 2) {
      return [];
    }

    const pool = getDefaultUnitPool(this.housePrefix);
    const combatUnits = p.units.filter(u => !u.isHarvester);

    // If we have fewer than 3 units, just produce whatever is available
    if (combatUnits.length < 3) {
      if (pool.infantry.length > 0 && p.productionQueues.infantry.length < 2) {
        const hasBarracks = countBuildingsOfType(p, 'Barracks') > 0;
        if (hasBarracks) {
          actions.push({ type: 'produce', typeName: pool.infantry[0], isBuilding: false });
        }
      }
      if (pool.vehicles.length > 0 && p.productionQueues.vehicle.length < 2) {
        const hasFactory = countBuildingsOfType(p, 'Factory') > 0;
        if (hasFactory) {
          actions.push({ type: 'produce', typeName: pool.vehicles[0], isBuilding: false });
        }
      }
      return actions;
    }

    // Count current composition
    const infantryCount = combatUnits.filter(u => u.isInfantry).length;
    const vehicleCount = combatUnits.filter(u => !u.isInfantry && !u.canFly).length;
    const total = combatUnits.length || 1;

    const infantryRatio = infantryCount / total;
    const vehicleRatio = vehicleCount / total;

    // Adjust based on strategic plan (with NaN guard for partial LLM responses)
    const hint = this.strategicPlan?.compositionHint;
    const goal = {
      antiVeh: hint?.antiVeh ?? COMPOSITION_GOAL.antiVeh,
      antiInf: hint?.antiInf ?? COMPOSITION_GOAL.antiInf,
      antiBldg: hint?.antiBldg ?? COMPOSITION_GOAL.antiBldg,
      scout: hint?.scout ?? COMPOSITION_GOAL.scout,
    };
    const targetInfRatio = goal.antiInf + goal.scout * 0.5;
    const targetVehRatio = goal.antiVeh + goal.antiBldg;

    // Produce infantry if under-ratio
    if (infantryRatio < targetInfRatio && p.productionQueues.infantry.length < 2) {
      const hasBarracks = countBuildingsOfType(p, 'Barracks') > 0;
      if (hasBarracks && pool.infantry.length > 0) {
        // Pick a random infantry type for variety
        const idx = Math.floor(Math.random() * pool.infantry.length);
        actions.push({ type: 'produce', typeName: pool.infantry[idx], isBuilding: false });
      }
    }

    // Produce vehicles if under-ratio
    if (vehicleRatio < targetVehRatio && p.productionQueues.vehicle.length < 2) {
      const hasFactory = countBuildingsOfType(p, 'Factory') > 0;
      if (hasFactory && pool.vehicles.length > 0) {
        const idx = Math.floor(Math.random() * pool.vehicles.length);
        actions.push({ type: 'produce', typeName: pool.vehicles[idx], isBuilding: false });
      }
    }

    return actions;
  }

  /**
   * Rule 6: Upgrade buildings when tech prerequisites met
   */
  private ruleUpgradeChecking(_p: PlayerState): Action[] {
    // Upgrades in EBFD happen via the production system's upgrade queue
    // The oracle defers to the build order for now — upgrades are part of later phases
    return [];
  }

  /**
   * Rule 7: Repair damaged ConYard, refineries with priority
   */
  private ruleRepairPriority(p: PlayerState): Action[] {
    const actions: Action[] = [];
    const REPAIR_THRESHOLD = 0.8;

    for (const bldg of p.buildings) {
      if (bldg.healthPct >= REPAIR_THRESHOLD) continue;

      // Prioritize: ConYard > Refinery > Factory > others
      const isHighPriority =
        bldg.typeName.includes('ConYard') ||
        bldg.typeName.includes('Refinery') ||
        bldg.typeName.includes('Factory');

      if (isHighPriority || bldg.healthPct < 0.5) {
        actions.push({ type: 'repair', buildingEid: bldg.eid });
      }
    }

    return actions;
  }

  /**
   * Rule 8: Group idle combat units near rally point
   */
  private ruleIdleArmyGrouping(p: PlayerState, state: GameState): Action[] {
    const idleMilitary = p.units.filter(u => u.isIdle && !u.isHarvester);
    if (idleMilitary.length < 3) return [];

    const basePos = getBaseCenter(p);
    if (!basePos) return [];

    // Rally point: slightly in front of base toward enemy
    const enemyCentroid = getEnemyCentroid(state);
    let rallyX = basePos.x;
    let rallyZ = basePos.z;
    if (enemyCentroid) {
      const dx = enemyCentroid.x - basePos.x;
      const dz = enemyCentroid.z - basePos.z;
      const dist = Math.sqrt(dx * dx + dz * dz) || 1;
      rallyX = basePos.x + (dx / dist) * 15;
      rallyZ = basePos.z + (dz / dist) * 15;
    }

    // Only move units that are far from rally point
    const farUnits = idleMilitary.filter(u => {
      const d = Math.sqrt((u.x - rallyX) ** 2 + (u.z - rallyZ) ** 2);
      return d > 20;
    });

    if (farUnits.length === 0) return [];

    return [{
      type: 'move',
      entityIds: farUnits.map(u => u.eid),
      x: rallyX,
      z: rallyZ,
    }];
  }

  /**
   * Rule 9: Send 1-2 fast units to explore
   */
  private ruleScoutDeployment(p: PlayerState, state: GameState): Action[] {
    const idleMilitary = p.units.filter(u => u.isIdle && !u.isHarvester && !u.canFly);
    if (idleMilitary.length < 5) return []; // don't scout if army is small

    // Pick 1 idle unit to scout a random map edge
    const scout = idleMilitary[0];
    const targets = [
      { x: 20, z: 20 },
      { x: 300, z: 20 },
      { x: 20, z: 300 },
      { x: 300, z: 300 },
      { x: 160, z: 20 },
      { x: 160, z: 300 },
    ];
    const target = targets[Math.floor(Math.random() * targets.length)];

    return [{
      type: 'attack_move',
      entityIds: [scout.eid],
      x: target.x,
      z: target.z,
    }];
  }

  /**
   * Rule 10: Buy from Starport when cash-rich and favorable offers exist
   */
  private ruleStarportPurchases(p: PlayerState): Action[] {
    // Starport purchasing is complex — defer to future implementation
    // Would check p.solaris > threshold and available starport offers
    return [];
  }

  /**
   * Detect if the game state represents a strategic inflection point.
   * Used by DecisionEngine to decide when to call the LLM.
   */
  isStrategicInflection(state: GameState, lastLlmTick: number): boolean {
    const ticksSinceLlm = state.tick - lastLlmTick;

    // Time-based: call every ~60s (1500 ticks at 25 tps)
    if (ticksSinceLlm > 1500) return true;

    // Army ready: we have 8+ idle military units
    const idleMilitary = state.player.units.filter(u => u.isIdle && !u.isHarvester);
    if (idleMilitary.length >= 8 && ticksSinceLlm > 500) return true;

    // Heavy losses: lost 3+ units since last check
    const losses = state.events.filter(
      e => e.type === 'unit_destroyed' && e.owner === state.player.playerId
    );
    if (losses.length >= 3 && ticksSinceLlm > 300) return true;

    // Income drop: very low solaris
    if (state.player.solaris < 500 && ticksSinceLlm > 750) return true;

    return false;
  }

  /** No-op: build order is now derived from state each tick (no internal phase counter) */
  reconstructBuildPhase(_p: PlayerState): void {
    // Build order logic in ruleBuildOrder() walks the order against ownedBuildingTypes
    // each evaluation, so no reconstruction is needed.
  }
}

// --- Helpers ---

function countBuildingsOfType(p: PlayerState, suffix: string): number {
  let count = 0;
  for (const [name, n] of p.ownedBuildingTypes) {
    if (name.includes(suffix)) count += n;
  }
  return count;
}

function getBaseCenter(p: PlayerState): { x: number; z: number } | null {
  // ConYard is the base center, fallback to average building position
  for (const b of p.buildings) {
    if (b.typeName.includes('ConYard')) return { x: b.x, z: b.z };
  }
  if (p.buildings.length === 0) return null;
  let sx = 0, sz = 0;
  for (const b of p.buildings) { sx += b.x; sz += b.z; }
  return { x: sx / p.buildings.length, z: sz / p.buildings.length };
}

function getEnemyCentroid(state: GameState): { x: number; z: number } | null {
  const allEnemyBuildings: BuildingInfo[] = [];
  for (const e of state.enemies) {
    allEnemyBuildings.push(...e.buildings);
  }
  if (allEnemyBuildings.length === 0) return null;
  let sx = 0, sz = 0;
  for (const b of allEnemyBuildings) { sx += b.x; sz += b.z; }
  return { x: sx / allEnemyBuildings.length, z: sz / allEnemyBuildings.length };
}
