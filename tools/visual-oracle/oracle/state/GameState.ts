/**
 * Common normalized game state types used by both Remake and Wine adapters.
 * The oracle loop works with these types regardless of backend.
 */

export interface UnitInfo {
  eid: number;
  typeName: string;
  x: number;
  z: number;
  healthPct: number;
  isHarvester: boolean;
  isIdle: boolean;
  /** 0=idle, 1=movingToSpice, 2=harvesting, 3=returning, 4=unloading */
  harvesterState?: number;
  spiceCarried?: number;
  maxCapacity?: number;
  isInfantry: boolean;
  canFly: boolean;
}

export interface BuildingInfo {
  eid: number;
  typeName: string;
  x: number;
  z: number;
  healthPct: number;
}

export interface ProductionQueueItem {
  typeName: string;
  isBuilding: boolean;
  progress: number; // 0.0 to 1.0
}

export interface PowerInfo {
  produced: number;
  consumed: number;
  ratio: number;
}

export interface PlayerState {
  playerId: number;
  solaris: number;
  power: PowerInfo;
  techLevel: number;
  units: UnitInfo[];
  buildings: BuildingInfo[];
  productionQueues: {
    building: ProductionQueueItem[];
    infantry: ProductionQueueItem[];
    vehicle: ProductionQueueItem[];
  };
  ownedBuildingTypes: Map<string, number>;
}

export interface GameState {
  tick: number;
  /** Our player's full state */
  player: PlayerState;
  /** Enemy states (may be partial for Wine — only visible units) */
  enemies: PlayerState[];
  /** Confidence: 1.0 for remake (exact ECS data), 0.3-0.8 for Wine (vision-estimated) */
  confidence: number;
  /** Events that occurred since last observation */
  events: GameEvent[];
}

export type GameEvent =
  | { type: 'unit_destroyed'; eid: number; owner: number; typeName: string }
  | { type: 'building_destroyed'; eid: number; owner: number; typeName: string }
  | { type: 'production_complete'; typeName: string; owner: number; isBuilding: boolean }
  | { type: 'under_attack'; x: number; z: number; owner: number }
  | { type: 'unit_created'; eid: number; owner: number; typeName: string };
