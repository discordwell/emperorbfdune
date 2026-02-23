import { simRng } from '../utils/DeterministicRNG';
import type { GameRules } from '../config/RulesParser';
import type { UnitDef } from '../config/UnitDefs';
import type { BuildingDef } from '../config/BuildingDefs';
import type { HarvestSystem } from './HarvestSystem';
import { EventBus } from '../core/EventBus';
import { GameConstants } from '../utils/Constants';

type Difficulty = 'easy' | 'normal' | 'hard';

interface QueueItem {
  typeName: string;
  isBuilding: boolean;
  totalTime: number;
  elapsed: number;
  cost: number;
}

export interface ProductionState {
  buildingQueues: Record<number, QueueItem[]>;
  infantryQueues: Record<number, QueueItem[]>;
  vehicleQueues: Record<number, QueueItem[]>;
  upgradeQueues: Record<number, QueueItem[]>;
  upgradedBuildings: Record<number, string[]>;
  repeatUnits: Record<number, string[]>;
  costMultipliers?: Record<number, number>;
  timeMultipliers?: Record<number, number>;
  starportPrices?: Record<string, number>;
  starportStock?: Record<string, number>;
  starportTick?: number;
  starportStockTick?: number;
}

export class ProductionSystem {
  private rules: GameRules;
  private harvestSystem: HarvestSystem;

  // Per-player production queues
  private buildingQueues = new Map<number, QueueItem[]>(); // playerId -> queue
  // Parallel unit production: infantry and vehicles build simultaneously
  private infantryQueues = new Map<number, QueueItem[]>();
  private vehicleQueues = new Map<number, QueueItem[]>();

  // Built buildings per player (for tech tree checking) - count allows duplicates
  private playerBuildings = new Map<number, Map<string, number>>();

  // Power multiplier per player: 1.0 = full power, 0.5 = low power
  private powerMultipliers = new Map<number, number>();
  // Unit count callback for population cap
  private unitCountCallback: ((playerId: number) => number) | null = null;
  private maxUnits = 50;
  // Upgraded buildings: playerId -> Set of building type names that have been upgraded
  private upgradedBuildings = new Map<number, Set<string>>();
  // Upgrade queues (same structure as building queues but for upgrades)
  private upgradeQueues = new Map<number, QueueItem[]>();
  // Repeat mode: auto-requeue completed unit types
  private repeatUnits = new Map<number, Set<string>>(); // playerId -> Set of type names

  // Difficulty-based cost/time multipliers per player
  private costMultipliers = new Map<number, number>();   // playerId -> multiplier
  private timeMultipliers = new Map<number, number>();   // playerId -> multiplier
  // Campaign tech level cap override per player (limits max tech level)
  private techLevelOverrides = new Map<number, number>(); // playerId -> max tech level

  constructor(rules: GameRules, harvestSystem: HarvestSystem) {
    this.rules = rules;
    this.harvestSystem = harvestSystem;
  }

  /** Determine if a unit type uses the infantry production queue */
  private isInfantryType(typeName: string): boolean {
    return this.rules.units.get(typeName)?.infantry ?? false;
  }

  /** Set difficulty scaling for a specific player.
   *  For human player: easy=cheaper/faster, hard=more expensive/slower.
   *  For AI player: inverse scaling (easy AI pays more, hard AI pays less). */
  setDifficulty(playerId: number, difficulty: Difficulty, isAI = false): void {
    let costPct: number;
    let timePct: number;
    if (isAI) {
      // AI gets inverse: easy game => AI pays more, hard game => AI pays less
      switch (difficulty) {
        case 'easy':
          costPct = GameConstants.HARD_BUILD_COST;   // 125% cost for AI
          timePct = GameConstants.HARD_BUILD_TIME;   // 125% time for AI
          break;
        case 'hard':
          costPct = GameConstants.EASY_BUILD_COST;   // 50% cost for AI
          timePct = GameConstants.EASY_BUILD_TIME;   // 75% time for AI
          break;
        default:
          costPct = GameConstants.NORMAL_BUILD_COST;
          timePct = GameConstants.NORMAL_BUILD_TIME;
      }
    } else {
      switch (difficulty) {
        case 'easy':
          costPct = GameConstants.EASY_BUILD_COST;   // 50%
          timePct = GameConstants.EASY_BUILD_TIME;    // 75%
          break;
        case 'hard':
          costPct = GameConstants.HARD_BUILD_COST;   // 125%
          timePct = GameConstants.HARD_BUILD_TIME;    // 125%
          break;
        default:
          costPct = GameConstants.NORMAL_BUILD_COST;  // 100%
          timePct = GameConstants.NORMAL_BUILD_TIME;   // 100%
      }
    }
    this.costMultipliers.set(playerId, costPct / 100);
    this.timeMultipliers.set(playerId, timePct / 100);
  }

  /** Get the difficulty-adjusted cost for a unit or building (rounded to integer). */
  getAdjustedCost(playerId: number, typeName: string, isBuilding: boolean): number {
    const def = isBuilding ? this.rules.buildings.get(typeName) : this.rules.units.get(typeName);
    if (!def) return 0;
    const mult = this.costMultipliers.get(playerId) ?? 1.0;
    return Math.round(def.cost * mult);
  }

  /** Get the difficulty-adjusted build time for a unit or building. */
  private getAdjustedBuildTime(playerId: number, def: UnitDef | BuildingDef): number {
    const mult = this.timeMultipliers.get(playerId) ?? 1.0;
    return Math.round(def.buildTime * mult);
  }

  /** Get the cost multiplier for a player (for UI display). */
  getCostMultiplier(playerId: number): number {
    return this.costMultipliers.get(playerId) ?? 1.0;
  }

  setPowerMultiplier(playerId: number, multiplier: number): void {
    this.powerMultipliers.set(playerId, multiplier);
  }

  getPowerMultiplier(playerId: number): number {
    return this.powerMultipliers.get(playerId) ?? 1.0;
  }

  setUnitCountCallback(cb: (playerId: number) => number): void {
    this.unitCountCallback = cb;
  }

  setMaxUnits(max: number): void {
    this.maxUnits = max;
  }

  toggleRepeat(playerId: number, typeName: string): boolean {
    if (!this.repeatUnits.has(playerId)) {
      this.repeatUnits.set(playerId, new Set());
    }
    const set = this.repeatUnits.get(playerId)!;
    if (set.has(typeName)) {
      set.delete(typeName);
      return false;
    }
    set.add(typeName);
    return true;
  }

  isOnRepeat(playerId: number, typeName: string): boolean {
    return this.repeatUnits.get(playerId)?.has(typeName) ?? false;
  }

  ownsBuilding(playerId: number, buildingType: string): boolean {
    const owned = this.playerBuildings.get(playerId);
    return owned ? (owned.get(buildingType) ?? 0) > 0 : false;
  }

  getPlayerBuildings(playerId: number): Map<string, number> | undefined {
    return this.playerBuildings.get(playerId);
  }

  /** Check if a building type can serve as a primary production facility (from rules.txt CanBePrimary). */
  canSetAsPrimary(buildingType: string): boolean {
    const def = this.rules.buildings.get(buildingType);
    return def?.canBePrimary ?? false;
  }

  ownsAnyBuildingSuffix(playerId: number, suffix: string): boolean {
    const owned = this.playerBuildings.get(playerId);
    if (!owned) return false;
    for (const bType of owned.keys()) {
      if (bType.endsWith(suffix) && (owned.get(bType) ?? 0) > 0) return true;
    }
    return false;
  }

  /** Count buildings with a given suffix for production speed bonuses */
  private countBuildingSuffix(playerId: number, suffix: string): number {
    const owned = this.playerBuildings.get(playerId);
    if (!owned) return 0;
    let total = 0;
    for (const [bType, count] of owned) {
      if (bType.endsWith(suffix) && count > 0) total += count;
    }
    return total;
  }

  /** Get production speed multiplier from multiple factories.
   *  Returns 0 if no production building exists (pauses production). */
  private getFactorySpeedBonus(playerId: number, queueType: 'building' | 'infantry' | 'vehicle'): number {
    let count: number;
    if (queueType === 'building') {
      count = this.countBuildingSuffix(playerId, 'ConYard');
    } else if (queueType === 'infantry') {
      count = this.countBuildingSuffix(playerId, 'Barracks');
    } else {
      // Vehicle: count both Factory and Heavy Factory variants
      count = this.countBuildingSuffix(playerId, 'Factory');
    }
    // No production building = production paused (0 speed)
    if (count === 0) return 0;
    // Diminishing returns: 1st factory = 1x, 2nd = +0.5x, 3rd+ = +0.25x each
    if (count <= 1) return 1.0;
    return 1.0 + 0.5 + (count - 2) * 0.25;
  }

  addPlayerBuilding(playerId: number, buildingType: string): void {
    if (!this.playerBuildings.has(playerId)) {
      this.playerBuildings.set(playerId, new Map());
    }
    const counts = this.playerBuildings.get(playerId)!;
    counts.set(buildingType, (counts.get(buildingType) ?? 0) + 1);
  }

  removePlayerBuilding(playerId: number, buildingType: string): void {
    const counts = this.playerBuildings.get(playerId);
    if (counts) {
      const current = counts.get(buildingType) ?? 0;
      if (current <= 1) {
        counts.delete(buildingType);
        // Cancel any in-progress upgrade if last building of this type is destroyed
        const queue = this.upgradeQueues.get(playerId);
        if (queue) {
          const idx = queue.findIndex(q => q.typeName === buildingType);
          if (idx >= 0) {
            const item = queue[idx];
            // Partial refund based on remaining time
            const refundRatio = item.totalTime > 0 ? 1 - item.elapsed / item.totalTime : 1;
            this.harvestSystem.addSolaris(playerId, Math.round(item.cost * Math.max(0, refundRatio)));
            queue.splice(idx, 1);
          }
        }
      } else {
        counts.set(buildingType, current - 1);
      }
    }
  }

  canUpgrade(playerId: number, buildingType: string): boolean {
    const def = this.rules.buildings.get(buildingType);
    if (!def || !def.upgradable) return false;
    // Already upgraded?
    if (this.upgradedBuildings.get(playerId)?.has(buildingType)) return false;
    // Already in upgrade queue?
    const queue = this.upgradeQueues.get(playerId);
    if (queue?.some(q => q.typeName === buildingType)) return false;
    // Can afford? (apply difficulty cost multiplier to upgrade cost)
    const costMult = this.costMultipliers.get(playerId) ?? 1.0;
    const adjustedUpgradeCost = Math.round(def.upgradeCost * costMult);
    if (this.harvestSystem.getSolaris(playerId) < adjustedUpgradeCost) return false;
    // Must own the building
    const owned = this.playerBuildings.get(playerId);
    if (!owned || (owned.get(buildingType) ?? 0) <= 0) return false;
    return true;
  }

  startUpgrade(playerId: number, buildingType: string): boolean {
    if (!this.canUpgrade(playerId, buildingType)) return false;
    const def = this.rules.buildings.get(buildingType)!;
    const costMult = this.costMultipliers.get(playerId) ?? 1.0;
    const timeMult = this.timeMultipliers.get(playerId) ?? 1.0;
    const adjustedUpgradeCost = Math.round(def.upgradeCost * costMult);
    if (!this.harvestSystem.spendSolaris(playerId, adjustedUpgradeCost)) return false;

    const queue = this.upgradeQueues.get(playerId) ?? [];
    queue.push({
      typeName: buildingType,
      isBuilding: true,
      totalTime: Math.round(def.buildTime * 0.5 * timeMult),
      elapsed: 0,
      cost: adjustedUpgradeCost,
    });
    this.upgradeQueues.set(playerId, queue);
    EventBus.emit('production:started', { unitType: `${buildingType} Upgrade`, owner: playerId, isBuilding: true });
    return true;
  }

  isUpgraded(playerId: number, buildingType: string): boolean {
    return this.upgradedBuildings.get(playerId)?.has(buildingType) ?? false;
  }

  getPlayerTechLevel(playerId: number): number {
    // Tech level = max of: owned buildings' base tech levels + upgraded buildings' upgrade tech levels
    let maxTech = 0;

    // Base tech from owned buildings
    const owned = this.playerBuildings.get(playerId);
    if (owned) {
      for (const bType of owned.keys()) {
        const def = this.rules.buildings.get(bType);
        if (def && def.techLevel > maxTech) maxTech = def.techLevel;
      }
    }

    // Higher tech from upgrades
    const upgraded = this.upgradedBuildings.get(playerId);
    if (upgraded) {
      for (const bType of upgraded) {
        const def = this.rules.buildings.get(bType);
        if (def && def.upgradeTechLevel > maxTech) maxTech = def.upgradeTechLevel;
      }
    }

    // Owning any building gives at least tech 1
    if (owned && owned.size > 0 && maxTech < 1) maxTech = 1;

    // Campaign tech level cap
    const override = this.techLevelOverrides.get(playerId);
    if (override !== undefined && maxTech > override) {
      maxTech = override;
    }

    return maxTech;
  }

  /** Set a campaign tech level cap for a player. Tech level from buildings will not exceed this value. */
  setOverrideTechLevel(playerId: number, maxTechLevel: number): void {
    this.techLevelOverrides.set(playerId, maxTechLevel);
  }

  canBuild(playerId: number, typeName: string, isBuilding: boolean): boolean {
    return this.getBuildBlockReason(playerId, typeName, isBuilding) === null;
  }

  /** Returns the reason a unit/building can't be built, or null if it can */
  getBuildBlockReason(playerId: number, typeName: string, isBuilding: boolean): { reason: 'cost' | 'prereq' | 'tech' | 'cap'; detail: string } | null {
    const def = isBuilding ? this.rules.buildings.get(typeName) : this.rules.units.get(typeName);
    if (!def) return { reason: 'prereq', detail: 'Unknown type' };
    const owned = this.playerBuildings.get(playerId);
    const hasReq = (name: string) => owned && owned.has(name) && (owned.get(name) ?? 0) > 0;

    // Check prerequisites first
    if (def.primaryBuilding && !hasReq(def.primaryBuilding)) {
      const bDef = isBuilding ? this.rules.buildings.get(typeName) : null;
      const alts = bDef?.primaryBuildingAlts ?? [];
      if (alts.length === 0 || !alts.some(alt => hasReq(alt))) {
        const reqName = def.primaryBuilding.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
        return { reason: 'prereq', detail: reqName };
      }
    }
    if (def.secondaryBuildings) {
      for (const req of def.secondaryBuildings) {
        if (!hasReq(req)) {
          const reqName = req.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
          return { reason: 'prereq', detail: reqName };
        }
      }
    }
    // Check upgraded primary requirement
    if (def.upgradedPrimaryRequired && def.primaryBuilding) {
      if (!this.isUpgraded(playerId, def.primaryBuilding)) {
        const reqName = def.primaryBuilding.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
        return { reason: 'prereq', detail: `Upgrade ${reqName}` };
      }
    }
    if (def.techLevel > 0 && def.techLevel > this.getPlayerTechLevel(playerId)) {
      return { reason: 'tech', detail: `Tech ${def.techLevel}` };
    }
    if (!isBuilding && this.unitCountCallback) {
      const queuedUnits = (this.infantryQueues.get(playerId)?.length ?? 0)
                        + (this.vehicleQueues.get(playerId)?.length ?? 0);
      if (this.unitCountCallback(playerId) + queuedUnits >= this.maxUnits) {
        return { reason: 'cap', detail: `Max ${this.maxUnits} units` };
      }
    }
    const adjustedCost = this.getAdjustedCost(playerId, typeName, isBuilding);
    if (this.harvestSystem.getSolaris(playerId) < adjustedCost) {
      return { reason: 'cost', detail: `Need $${adjustedCost}` };
    }
    return null;
  }

  startProduction(playerId: number, typeName: string, isBuilding: boolean): boolean {
    if (!this.canBuild(playerId, typeName, isBuilding)) return false;

    const def = isBuilding
      ? this.rules.buildings.get(typeName)
      : this.rules.units.get(typeName);
    if (!def) return false;

    let queue: QueueItem[];
    if (isBuilding) {
      queue = this.buildingQueues.get(playerId) ?? [];
    } else {
      const isInf = this.isInfantryType(typeName);
      const queueMap = isInf ? this.infantryQueues : this.vehicleQueues;
      queue = queueMap.get(playerId) ?? [];
    }

    // Queue limit: max 5 items per production queue
    if (queue.length >= 5) return false;

    // Spend money (difficulty-adjusted)
    const adjustedCost = this.getAdjustedCost(playerId, typeName, isBuilding);
    if (!this.harvestSystem.spendSolaris(playerId, adjustedCost)) return false;

    const adjustedTime = this.getAdjustedBuildTime(playerId, def);
    queue.push({
      typeName,
      isBuilding,
      totalTime: adjustedTime,
      elapsed: 0,
      cost: adjustedCost,
    });

    if (isBuilding) {
      this.buildingQueues.set(playerId, queue);
    } else {
      const isInf = this.isInfantryType(typeName);
      (isInf ? this.infantryQueues : this.vehicleQueues).set(playerId, queue);
    }

    EventBus.emit('production:started', { unitType: typeName, owner: playerId, isBuilding });
    return true;
  }

  update(): void {
    // Process building queues
    for (const [playerId, queue] of this.buildingQueues) {
      if (queue.length === 0) continue;
      const item = queue[0];
      const mult = (this.powerMultipliers.get(playerId) ?? 1.0) * this.getFactorySpeedBonus(playerId, 'building');
      item.elapsed += mult;
      if (item.elapsed >= item.totalTime) {
        queue.shift();
        EventBus.emit('production:complete', { unitType: item.typeName, owner: playerId, buildingId: 0, isBuilding: true });
      }
    }

    // Process infantry queues (parallel with vehicle queues)
    for (const [playerId, queue] of this.infantryQueues) {
      if (queue.length === 0) continue;
      const item = queue[0];
      const mult = (this.powerMultipliers.get(playerId) ?? 1.0) * this.getFactorySpeedBonus(playerId, 'infantry');
      item.elapsed += mult;
      if (item.elapsed >= item.totalTime) {
        const completedName = item.typeName;
        const shouldRepeat = this.repeatUnits.get(playerId)?.has(completedName) ?? false;
        queue.shift();
        EventBus.emit('production:complete', { unitType: completedName, owner: playerId, buildingId: 0, isBuilding: false });
        // Defer repeat-requeue: the just-completed unit hasn't spawned yet, so
        // canBuild's pop cap check would be off by one. Add +1 to account for it.
        if (shouldRepeat && this.unitCountCallback) {
          const queuedUnits = (this.infantryQueues.get(playerId)?.length ?? 0)
                            + (this.vehicleQueues.get(playerId)?.length ?? 0);
          if (this.unitCountCallback(playerId) + queuedUnits + 1 < this.maxUnits) {
            this.startProduction(playerId, completedName, false);
          }
        } else if (shouldRepeat) {
          this.startProduction(playerId, completedName, false);
        }
      }
    }

    // Process vehicle queues (parallel with infantry queues)
    for (const [playerId, queue] of this.vehicleQueues) {
      if (queue.length === 0) continue;
      const item = queue[0];
      const mult = (this.powerMultipliers.get(playerId) ?? 1.0) * this.getFactorySpeedBonus(playerId, 'vehicle');
      item.elapsed += mult;
      if (item.elapsed >= item.totalTime) {
        const completedName = item.typeName;
        const shouldRepeat = this.repeatUnits.get(playerId)?.has(completedName) ?? false;
        queue.shift();
        EventBus.emit('production:complete', { unitType: completedName, owner: playerId, buildingId: 0, isBuilding: false });
        if (shouldRepeat && this.unitCountCallback) {
          const queuedUnits = (this.infantryQueues.get(playerId)?.length ?? 0)
                            + (this.vehicleQueues.get(playerId)?.length ?? 0);
          if (this.unitCountCallback(playerId) + queuedUnits + 1 < this.maxUnits) {
            this.startProduction(playerId, completedName, false);
          }
        } else if (shouldRepeat) {
          this.startProduction(playerId, completedName, false);
        }
      }
    }

    // Process upgrade queues
    for (const [playerId, queue] of this.upgradeQueues) {
      if (queue.length === 0) continue;
      const item = queue[0];
      const mult = this.powerMultipliers.get(playerId) ?? 1.0;
      item.elapsed += mult;
      if (item.elapsed >= item.totalTime) {
        queue.shift();
        if (!this.upgradedBuildings.has(playerId)) {
          this.upgradedBuildings.set(playerId, new Set());
        }
        this.upgradedBuildings.get(playerId)!.add(item.typeName);
        EventBus.emit('production:complete', { unitType: `${item.typeName} Upgrade`, owner: playerId, buildingId: 0, isBuilding: true });
      }
    }
  }

  /** Get upgrade queue progress for a specific building type (or first in queue if no type specified) */
  getUpgradeProgress(playerId: number, buildingType?: string): { typeName: string; progress: number } | null {
    const queue = this.upgradeQueues.get(playerId);
    if (!queue || queue.length === 0) return null;
    if (buildingType) {
      const item = queue.find(q => q.typeName === buildingType);
      if (!item) return null;
      return { typeName: item.typeName, progress: item.totalTime > 0 ? Math.min(1, item.elapsed / item.totalTime) : 1 };
    }
    const item = queue[0];
    return { typeName: item.typeName, progress: item.totalTime > 0 ? Math.min(1, item.elapsed / item.totalTime) : 1 };
  }

  getQueueProgress(playerId: number, isBuilding: boolean, unitType?: 'infantry' | 'vehicle'): { typeName: string; progress: number } | null {
    if (isBuilding) {
      const queue = this.buildingQueues.get(playerId);
      if (!queue || queue.length === 0) return null;
      const item = queue[0];
      return { typeName: item.typeName, progress: item.totalTime > 0 ? Math.min(1, item.elapsed / item.totalTime) : 1 };
    }
    // Unit queues: return specific type or first active
    if (unitType === 'infantry' || unitType === undefined) {
      const q = this.infantryQueues.get(playerId);
      if (q && q.length > 0) {
        return { typeName: q[0].typeName, progress: q[0].totalTime > 0 ? Math.min(1, q[0].elapsed / q[0].totalTime) : 1 };
      }
    }
    if (unitType === 'vehicle' || unitType === undefined) {
      const q = this.vehicleQueues.get(playerId);
      if (q && q.length > 0) {
        return { typeName: q[0].typeName, progress: q[0].totalTime > 0 ? Math.min(1, q[0].elapsed / q[0].totalTime) : 1 };
      }
    }
    return null;
  }

  // --- Starport Trading ---
  private starportPrices = new Map<string, number>(); // unit name -> current price
  private starportStock = new Map<string, number>(); // unit name -> available stock
  private starportTick = 0;
  private starportStockTick = 0;

  /** Update starport prices and stock (call periodically) */
  updateStarportPrices(): void {
    this.starportTick++;
    this.starportStockTick++;

    // Price update
    if (this.starportTick % GameConstants.STARPORT_COST_UPDATE_DELAY === 0 || this.starportPrices.size === 0) {
      const pct = GameConstants.STARPORT_COST_VARIATION_PCT / 100;
      for (const [name, def] of this.rules.units) {
        if (!def.starportable) continue;
        // Price fluctuates within ±StarportCostVariationPercent of base cost
        const variance = (1 - pct) + simRng.random() * (2 * pct);
        this.starportPrices.set(name, Math.floor(def.cost * variance));
        // Initialize stock on first run
        if (!this.starportStock.has(name)) {
          this.starportStock.set(name, GameConstants.STARPORT_MAX_DELIVERY_SINGLE);
        }
      }
    }

    // Stock replenishment
    if (this.starportStockTick % GameConstants.STARPORT_STOCK_INCREASE_DELAY === 0) {
      for (const [name] of this.starportPrices) {
        const current = this.starportStock.get(name) ?? 0;
        if (current < GameConstants.STARPORT_MAX_DELIVERY_SINGLE) {
          // STARPORT_STOCK_INCREASE_PROB% chance to add 1 stock
          if (simRng.random() * 100 < GameConstants.STARPORT_STOCK_INCREASE_PROB) {
            this.starportStock.set(name, current + 1);
          }
        }
      }
    }
  }

  /** Get available starport units with current prices (difficulty-adjusted) and stock */
  getStarportOffers(factionPrefix: string, playerId?: number): { name: string; price: number; stock: number }[] {
    // Require player to own a Starport building before showing offers
    if (playerId !== undefined && !this.ownsAnyBuildingSuffix(playerId, 'Starport')) return [];
    const costMult = playerId !== undefined ? (this.costMultipliers.get(playerId) ?? 1.0) : 1.0;
    const offers: { name: string; price: number; stock: number }[] = [];
    for (const [name, price] of this.starportPrices) {
      if (!name.startsWith(factionPrefix)) continue;
      const stock = this.starportStock.get(name) ?? 0;
      offers.push({ name, price: Math.round(price * costMult), stock });
    }
    return offers;
  }

  /** Check if a player can afford a specific credit amount and has pop cap room (for starport UI) */
  canAffordAmount(playerId: number, amount: number): boolean {
    if (this.harvestSystem.getSolaris(playerId) < amount) return false;
    if (this.unitCountCallback) {
      const queuedUnits = (this.infantryQueues.get(playerId)?.length ?? 0)
                        + (this.vehicleQueues.get(playerId)?.length ?? 0);
      if (this.unitCountCallback(playerId) + queuedUnits >= this.maxUnits) return false;
    }
    return true;
  }

  /** Purchase a unit from the starport (arrives after delay via normal production:complete) */
  buyFromStarport(playerId: number, unitName: string): boolean {
    const basePrice = this.starportPrices.get(unitName);
    if (basePrice === undefined) return false;
    const costMult = this.costMultipliers.get(playerId) ?? 1.0;
    const price = Math.round(basePrice * costMult);

    // Queue as a unit with reduced build time (arrives by air)
    const def = this.rules.units.get(unitName);
    if (!def) return false;

    // Check player owns a Starport building
    if (!this.ownsAnyBuildingSuffix(playerId, 'Starport')) return false;

    // Check stock availability
    const stock = this.starportStock.get(unitName) ?? 0;
    if (stock <= 0) return false;

    // Population cap check (including queued units)
    if (this.unitCountCallback) {
      const queuedUnits = (this.infantryQueues.get(playerId)?.length ?? 0)
                        + (this.vehicleQueues.get(playerId)?.length ?? 0);
      if (this.unitCountCallback(playerId) + queuedUnits >= this.maxUnits) return false;
    }

    const isInf = this.isInfantryType(unitName);
    const queueMap = isInf ? this.infantryQueues : this.vehicleQueues;
    const queue = queueMap.get(playerId) ?? [];
    // Queue limit: max 5 items per production queue
    if (queue.length >= 5) return false;

    // All validation passed — now spend money
    if (!this.harvestSystem.spendSolaris(playerId, price)) return false;
    // Decrement stock
    this.starportStock.set(unitName, (this.starportStock.get(unitName) ?? 1) - 1);
    queue.push({
      typeName: unitName,
      isBuilding: false,
      totalTime: GameConstants.FRIGATE_COUNTDOWN, // Fixed delivery time from rules.txt
      elapsed: 0,
      cost: price,
    });
    queueMap.set(playerId, queue);
    return true;
  }

  /** Get full queue contents for UI display. For units, optionally filter by infantry/vehicle. */
  getQueue(playerId: number, isBuilding: boolean, unitType?: 'infantry' | 'vehicle'): { typeName: string; progress: number }[] {
    if (isBuilding) {
      const queue = this.buildingQueues.get(playerId);
      if (!queue) return [];
      return queue.map((item, i) => ({
        typeName: item.typeName,
        progress: i === 0 && item.totalTime > 0 ? item.elapsed / item.totalTime : 0,
      }));
    }
    const mapQueue = (q: QueueItem[]) => q.map((item, i) => ({
      typeName: item.typeName,
      progress: i === 0 && item.totalTime > 0 ? item.elapsed / item.totalTime : 0,
    }));
    if (unitType === 'infantry') return mapQueue(this.infantryQueues.get(playerId) ?? []);
    if (unitType === 'vehicle') return mapQueue(this.vehicleQueues.get(playerId) ?? []);
    // Merged: infantry first, then vehicle
    return [
      ...mapQueue(this.infantryQueues.get(playerId) ?? []),
      ...mapQueue(this.vehicleQueues.get(playerId) ?? []),
    ];
  }

  // --- Save/Load ---

  /** Serialize production state for saving */
  getState(): ProductionState {
    const serializeQueue = (q: Map<number, QueueItem[]>): Record<number, QueueItem[]> => {
      const out: Record<number, QueueItem[]> = {};
      for (const [pid, items] of q) {
        if (items.length > 0) out[pid] = items.map(i => ({ ...i }));
      }
      return out;
    };
    const serializeSet = (m: Map<number, Set<string>>): Record<number, string[]> => {
      const out: Record<number, string[]> = {};
      for (const [pid, set] of m) {
        if (set.size > 0) out[pid] = [...set];
      }
      return out;
    };
    const costMults: Record<number, number> = {};
    for (const [pid, m] of this.costMultipliers) costMults[pid] = m;
    const timeMults: Record<number, number> = {};
    for (const [pid, m] of this.timeMultipliers) timeMults[pid] = m;
    const starportPricesObj: Record<string, number> = {};
    for (const [name, price] of this.starportPrices) {
      starportPricesObj[name] = price;
    }
    const starportStockObj: Record<string, number> = {};
    for (const [name, stock] of this.starportStock) {
      starportStockObj[name] = stock;
    }
    return {
      buildingQueues: serializeQueue(this.buildingQueues),
      infantryQueues: serializeQueue(this.infantryQueues),
      vehicleQueues: serializeQueue(this.vehicleQueues),
      upgradeQueues: serializeQueue(this.upgradeQueues),
      upgradedBuildings: serializeSet(this.upgradedBuildings),
      repeatUnits: serializeSet(this.repeatUnits),
      costMultipliers: costMults,
      timeMultipliers: timeMults,
      starportPrices: starportPricesObj,
      starportStock: starportStockObj,
      starportTick: this.starportTick,
      starportStockTick: this.starportStockTick,
    };
  }

  /** Restore production state from save data (clears existing state first) */
  restoreState(state: ProductionState): void {
    this.buildingQueues.clear();
    this.infantryQueues.clear();
    this.vehicleQueues.clear();
    this.upgradeQueues.clear();
    this.upgradedBuildings.clear();
    this.repeatUnits.clear();
    this.costMultipliers.clear();
    this.timeMultipliers.clear();
    const restoreQueue = (data: Record<number, QueueItem[]>, target: Map<number, QueueItem[]>): void => {
      for (const pid of Object.keys(data)) {
        const items = data[Number(pid)];
        if (items && items.length > 0) {
          target.set(Number(pid), items.map(i => ({ ...i })));
        }
      }
    };
    const restoreSet = (data: Record<number, string[]>, target: Map<number, Set<string>>): void => {
      for (const pid of Object.keys(data)) {
        const arr = data[Number(pid)];
        if (arr && arr.length > 0) {
          target.set(Number(pid), new Set(arr));
        }
      }
    };

    restoreQueue(state.buildingQueues ?? {}, this.buildingQueues);
    restoreQueue(state.infantryQueues ?? {}, this.infantryQueues);
    restoreQueue(state.vehicleQueues ?? {}, this.vehicleQueues);
    restoreQueue(state.upgradeQueues ?? {}, this.upgradeQueues);
    restoreSet(state.upgradedBuildings ?? {}, this.upgradedBuildings);
    restoreSet(state.repeatUnits ?? {}, this.repeatUnits);
    if (state.costMultipliers) {
      for (const pid of Object.keys(state.costMultipliers)) {
        this.costMultipliers.set(Number(pid), state.costMultipliers[Number(pid)]);
      }
    }
    if (state.timeMultipliers) {
      for (const pid of Object.keys(state.timeMultipliers)) {
        this.timeMultipliers.set(Number(pid), state.timeMultipliers[Number(pid)]);
      }
    }
    // Restore starport prices and stock (reset first for backward-compatible saves)
    this.starportPrices.clear();
    this.starportStock.clear();
    this.starportTick = 0;
    this.starportStockTick = 0;
    if (state.starportPrices) {
      for (const [name, price] of Object.entries(state.starportPrices)) {
        this.starportPrices.set(name, price as number);
      }
    }
    if (state.starportStock) {
      for (const [name, stock] of Object.entries(state.starportStock)) {
        this.starportStock.set(name, stock as number);
      }
    }
    if (state.starportTick !== undefined) {
      this.starportTick = state.starportTick;
    }
    if (state.starportStockTick !== undefined) {
      this.starportStockTick = state.starportStockTick;
    }
  }

  /** Cancel a queued item by index, refunding cost (partial for in-progress).
   *  For units, specify unitType to target the correct sub-queue. */
  cancelQueueItem(playerId: number, isBuilding: boolean, index: number, unitType?: 'infantry' | 'vehicle'): boolean {
    let queue: QueueItem[] | undefined;
    if (isBuilding) {
      queue = this.buildingQueues.get(playerId);
    } else if (unitType === 'infantry') {
      queue = this.infantryQueues.get(playerId);
    } else if (unitType === 'vehicle') {
      queue = this.vehicleQueues.get(playerId);
    } else {
      // Legacy fallback: index into merged view (infantry first, then vehicle)
      const infQ = this.infantryQueues.get(playerId) ?? [];
      if (index < infQ.length) {
        queue = infQ;
      } else {
        queue = this.vehicleQueues.get(playerId);
        index -= infQ.length;
      }
    }
    if (!queue || index < 0 || index >= queue.length) return false;

    const item = queue[index];
    const refundRatio = index === 0 && item.totalTime > 0 ? (1 - item.elapsed / item.totalTime) : 1.0;
    const refund = Math.floor(item.cost * refundRatio);
    this.harvestSystem.addSolaris(playerId, refund);

    queue.splice(index, 1);
    return true;
  }
}
