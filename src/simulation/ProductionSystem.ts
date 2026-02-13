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

  constructor(rules: GameRules, harvestSystem: HarvestSystem) {
    this.rules = rules;
    this.harvestSystem = harvestSystem;
  }

  addPlayerBuilding(playerId: number, buildingType: string): void {
    if (!this.playerBuildings.has(playerId)) {
      this.playerBuildings.set(playerId, new Set());
    }
    this.playerBuildings.get(playerId)!.add(buildingType);
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
      item.elapsed++;
      if (item.elapsed >= item.totalTime) {
        queue.shift();
        EventBus.emit('production:complete', { unitType: item.typeName, owner: playerId, buildingId: 0 });
      }
    }

    // Process unit queues
    for (const [playerId, queue] of this.unitQueues) {
      if (queue.length === 0) continue;
      const item = queue[0];
      item.elapsed++;
      if (item.elapsed >= item.totalTime) {
        queue.shift();
        EventBus.emit('production:complete', { unitType: item.typeName, owner: playerId, buildingId: 0 });
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
