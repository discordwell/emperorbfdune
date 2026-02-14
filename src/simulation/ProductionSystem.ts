import type { GameRules } from '../config/RulesParser';
import type { UnitDef } from '../config/UnitDefs';
import type { BuildingDef } from '../config/BuildingDefs';
import type { HarvestSystem } from './HarvestSystem';
import { EventBus } from '../core/EventBus';

interface QueueItem {
  typeName: string;
  isBuilding: boolean;
  totalTime: number;
  elapsed: number;
  cost: number;
}

export class ProductionSystem {
  private rules: GameRules;
  private harvestSystem: HarvestSystem;

  // Per-player production queues
  private buildingQueues = new Map<number, QueueItem[]>(); // playerId -> queue
  private unitQueues = new Map<number, QueueItem[]>();

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

  constructor(rules: GameRules, harvestSystem: HarvestSystem) {
    this.rules = rules;
    this.harvestSystem = harvestSystem;
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
    // Can afford?
    if (this.harvestSystem.getSolaris(playerId) < def.upgradeCost) return false;
    // Must own the building
    const owned = this.playerBuildings.get(playerId);
    if (!owned || (owned.get(buildingType) ?? 0) <= 0) return false;
    return true;
  }

  startUpgrade(playerId: number, buildingType: string): boolean {
    if (!this.canUpgrade(playerId, buildingType)) return false;
    const def = this.rules.buildings.get(buildingType)!;
    if (!this.harvestSystem.spendSolaris(playerId, def.upgradeCost)) return false;

    const queue = this.upgradeQueues.get(playerId) ?? [];
    queue.push({
      typeName: buildingType,
      isBuilding: true,
      totalTime: def.buildTime, // Same time as building
      elapsed: 0,
      cost: def.upgradeCost,
    });
    this.upgradeQueues.set(playerId, queue);
    EventBus.emit('production:started', { unitType: `${buildingType} Upgrade`, owner: playerId });
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

    return maxTech;
  }

  canBuild(playerId: number, typeName: string, isBuilding: boolean): boolean {
    const def = isBuilding
      ? this.rules.buildings.get(typeName)
      : this.rules.units.get(typeName);
    if (!def) return false;

    // Check cost
    if (this.harvestSystem.getSolaris(playerId) < def.cost) return false;

    // Check prerequisites (primary building must exist)
    const owned = this.playerBuildings.get(playerId);
    if (def.primaryBuilding) {
      const hasReq = (name: string) => owned && owned.has(name) && (owned.get(name) ?? 0) > 0;
      if (!hasReq(def.primaryBuilding)) {
        // Check alternatives (e.g. walls accept ANY faction's ConYard)
        const bDef = isBuilding ? this.rules.buildings.get(typeName) : null;
        const alts = bDef?.primaryBuildingAlts ?? [];
        if (alts.length === 0 || !alts.some(alt => hasReq(alt))) return false;
      }
    }

    // Check secondary building prerequisites
    if (def.secondaryBuildings && def.secondaryBuildings.length > 0) {
      for (const req of def.secondaryBuildings) {
        if (!owned || !owned.has(req) || (owned.get(req) ?? 0) <= 0) return false;
      }
    }

    // Tech level requirement
    if (def.techLevel > 0) {
      const playerTech = this.getPlayerTechLevel(playerId);
      if (def.techLevel > playerTech) return false;
    }

    // Unit population cap (only for units, not buildings)
    if (!isBuilding && this.unitCountCallback) {
      if (this.unitCountCallback(playerId) >= this.maxUnits) return false;
    }

    return true;
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
    if (def.techLevel > 0 && def.techLevel > this.getPlayerTechLevel(playerId)) {
      return { reason: 'tech', detail: `Tech ${def.techLevel}` };
    }
    if (!isBuilding && this.unitCountCallback && this.unitCountCallback(playerId) >= this.maxUnits) {
      return { reason: 'cap', detail: `Max ${this.maxUnits} units` };
    }
    if (this.harvestSystem.getSolaris(playerId) < def.cost) {
      return { reason: 'cost', detail: `Need $${def.cost}` };
    }
    return null;
  }

  startProduction(playerId: number, typeName: string, isBuilding: boolean): boolean {
    if (!this.canBuild(playerId, typeName, isBuilding)) return false;

    const def = isBuilding
      ? this.rules.buildings.get(typeName)
      : this.rules.units.get(typeName);
    if (!def) return false;

    // Spend money
    if (!this.harvestSystem.spendSolaris(playerId, def.cost)) return false;

    const queue = isBuilding
      ? (this.buildingQueues.get(playerId) ?? [])
      : (this.unitQueues.get(playerId) ?? []);

    queue.push({
      typeName,
      isBuilding,
      totalTime: def.buildTime,
      elapsed: 0,
      cost: def.cost,
    });

    if (isBuilding) {
      this.buildingQueues.set(playerId, queue);
    } else {
      this.unitQueues.set(playerId, queue);
    }

    EventBus.emit('production:started', { unitType: typeName, owner: playerId });
    return true;
  }

  update(): void {
    // Process building queues
    for (const [playerId, queue] of this.buildingQueues) {
      if (queue.length === 0) continue;
      const item = queue[0];
      const mult = this.powerMultipliers.get(playerId) ?? 1.0;
      item.elapsed += mult;
      if (item.elapsed >= item.totalTime) {
        queue.shift();
        EventBus.emit('production:complete', { unitType: item.typeName, owner: playerId, buildingId: 0 });
      }
    }

    // Process unit queues
    for (const [playerId, queue] of this.unitQueues) {
      if (queue.length === 0) continue;
      const item = queue[0];
      const mult = this.powerMultipliers.get(playerId) ?? 1.0;
      item.elapsed += mult;
      if (item.elapsed >= item.totalTime) {
        const completedName = item.typeName;
        queue.shift();
        EventBus.emit('production:complete', { unitType: completedName, owner: playerId, buildingId: 0 });
        // Auto-requeue if on repeat and can afford it
        if (this.repeatUnits.get(playerId)?.has(completedName)) {
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
        EventBus.emit('production:complete', { unitType: `${item.typeName} Upgrade`, owner: playerId, buildingId: 0 });
      }
    }
  }

  getQueueProgress(playerId: number, isBuilding: boolean): { typeName: string; progress: number } | null {
    const queue = isBuilding
      ? this.buildingQueues.get(playerId)
      : this.unitQueues.get(playerId);
    if (!queue || queue.length === 0) return null;
    const item = queue[0];
    return { typeName: item.typeName, progress: item.elapsed / item.totalTime };
  }

  // --- Starport Trading ---
  private starportPrices = new Map<string, number>(); // unit name -> current price
  private starportTick = 0;

  /** Update starport prices (call periodically) */
  updateStarportPrices(): void {
    this.starportTick++;
    if (this.starportTick % 250 !== 0 && this.starportPrices.size > 0) return; // Update every ~10 seconds

    for (const [name, def] of this.rules.units) {
      if (!def.starportable) continue;
      // Price fluctuates between 50% and 150% of base cost
      const variance = 0.5 + Math.random();
      this.starportPrices.set(name, Math.floor(def.cost * variance));
    }
  }

  /** Get available starport units with current prices */
  getStarportOffers(factionPrefix: string): { name: string; price: number }[] {
    const offers: { name: string; price: number }[] = [];
    for (const [name, price] of this.starportPrices) {
      if (!name.startsWith(factionPrefix)) continue;
      offers.push({ name, price });
    }
    return offers;
  }

  /** Purchase a unit from the starport (arrives after delay via normal production:complete) */
  buyFromStarport(playerId: number, unitName: string): boolean {
    const price = this.starportPrices.get(unitName);
    if (price === undefined) return false;
    if (!this.harvestSystem.spendSolaris(playerId, price)) return false;

    // Queue as a unit with reduced build time (arrives by air)
    const def = this.rules.units.get(unitName);
    if (!def) return false;

    const queue = this.unitQueues.get(playerId) ?? [];
    queue.push({
      typeName: unitName,
      isBuilding: false,
      totalTime: Math.floor(def.buildTime * 0.3), // Starport units arrive faster
      elapsed: 0,
      cost: price,
    });
    this.unitQueues.set(playerId, queue);
    return true;
  }

  /** Get full queue contents for UI display */
  getQueue(playerId: number, isBuilding: boolean): { typeName: string; progress: number }[] {
    const queue = isBuilding
      ? this.buildingQueues.get(playerId)
      : this.unitQueues.get(playerId);
    if (!queue) return [];
    return queue.map((item, i) => ({
      typeName: item.typeName,
      progress: i === 0 && item.totalTime > 0 ? item.elapsed / item.totalTime : 0,
    }));
  }

  /** Cancel a queued item by index, refunding cost (partial for in-progress) */
  cancelQueueItem(playerId: number, isBuilding: boolean, index: number): boolean {
    const queue = isBuilding
      ? this.buildingQueues.get(playerId)
      : this.unitQueues.get(playerId);
    if (!queue || index < 0 || index >= queue.length) return false;

    const item = queue[index];
    // Full refund for queued items, partial for in-progress
    const refundRatio = index === 0 ? (1 - item.elapsed / item.totalTime) : 1.0;
    const refund = Math.floor(item.cost * refundRatio);
    this.harvestSystem.addSolaris(playerId, refund);

    queue.splice(index, 1);
    return true;
  }
}
