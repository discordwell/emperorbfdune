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

  // Built buildings per player (for tech tree checking)
  private playerBuildings = new Map<number, Set<string>>();

  // Power multiplier per player: 1.0 = full power, 0.5 = low power
  private powerMultipliers = new Map<number, number>();
  // Unit count callback for population cap
  private unitCountCallback: ((playerId: number) => number) | null = null;
  private maxUnits = 50;
  // Upgraded buildings: playerId -> Set of building type names that have been upgraded
  private upgradedBuildings = new Map<number, Set<string>>();
  // Upgrade queues (same structure as building queues but for upgrades)
  private upgradeQueues = new Map<number, QueueItem[]>();

  constructor(rules: GameRules, harvestSystem: HarvestSystem) {
    this.rules = rules;
    this.harvestSystem = harvestSystem;
  }

  setPowerMultiplier(playerId: number, multiplier: number): void {
    this.powerMultipliers.set(playerId, multiplier);
  }

  setUnitCountCallback(cb: (playerId: number) => number): void {
    this.unitCountCallback = cb;
  }

  addPlayerBuilding(playerId: number, buildingType: string): void {
    if (!this.playerBuildings.has(playerId)) {
      this.playerBuildings.set(playerId, new Set());
    }
    this.playerBuildings.get(playerId)!.add(buildingType);
  }

  removePlayerBuilding(playerId: number, buildingType: string): void {
    const owned = this.playerBuildings.get(playerId);
    if (owned) {
      owned.delete(buildingType);
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
    if (!owned || !owned.has(buildingType)) return false;
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
    // Tech level = max upgrade tech level of all upgraded buildings
    let maxTech = 1;
    const upgraded = this.upgradedBuildings.get(playerId);
    if (upgraded) {
      for (const bType of upgraded) {
        const def = this.rules.buildings.get(bType);
        if (def && def.upgradeTechLevel > maxTech) maxTech = def.upgradeTechLevel;
      }
    }
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
    if (def.primaryBuilding && owned && !owned.has(def.primaryBuilding)) return false;

    // Unit population cap (only for units, not buildings)
    if (!isBuilding && this.unitCountCallback) {
      if (this.unitCountCallback(playerId) >= this.maxUnits) return false;
    }

    return true;
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
        queue.shift();
        EventBus.emit('production:complete', { unitType: item.typeName, owner: playerId, buildingId: 0 });
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
}
