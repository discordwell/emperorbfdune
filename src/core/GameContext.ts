import * as THREE from 'three';
import type { Game } from './Game';
import type { SceneManager } from '../rendering/SceneManager';
import type { TerrainRenderer } from '../rendering/TerrainRenderer';
import type { InputManager } from '../input/InputManager';
import type { ModelManager } from '../rendering/ModelManager';
import type { UnitRenderer } from '../rendering/UnitRenderer';
import type { SelectionManager } from '../input/SelectionManager';
import type { CommandManager } from '../input/CommandManager';
import type { MovementSystem } from '../simulation/MovementSystem';
import type { PathfindingSystem } from '../simulation/PathfindingSystem';
import type { AsyncPathfinder } from '../simulation/AsyncPathfinder';
import type { CombatSystem } from '../simulation/CombatSystem';
import type { HarvestSystem } from '../simulation/HarvestSystem';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { MinimapRenderer } from '../rendering/MinimapRenderer';
import type { FogOfWar } from '../rendering/FogOfWar';
import type { EffectsManager } from '../rendering/EffectsManager';
import type { DamageNumbers } from '../rendering/DamageNumbers';
import type { SandwormSystem } from '../simulation/SandwormSystem';
import type { AbilitySystem } from '../simulation/AbilitySystem';
import type { SuperweaponSystem } from '../simulation/SuperweaponSystem';
import type { WallSystem } from '../simulation/WallSystem';
import type { AIPlayer } from '../ai/AIPlayer';
import type { AudioManager } from '../audio/AudioManager';
import type { BuildingPlacement } from '../input/BuildingPlacement';
import type { VictorySystem, GameStats } from '../ui/VictoryScreen';
import type { SelectionPanel } from '../ui/SelectionPanel';
import type { Sidebar } from '../ui/Sidebar';
import type { IconRenderer } from '../rendering/IconRenderer';
import type { PIPRenderer } from '../rendering/PIPRenderer';
import type { GameRules } from '../config/RulesParser';
import type { ArtEntry } from '../config/ArtIniParser';
import type { HouseChoice, OpponentConfig } from '../ui/HouseSelect';
import type { MissionConfigData } from '../campaign/MissionConfig';
import type { MissionRuntimeSettings } from '../campaign/MissionRuntime';
import type { TypeRegistry } from './TypeRegistry';
import type { SimulationHashTracker } from './SimulationHash';
import type { ReplayRecorder, ReplayPlayer } from './ReplaySystem';
import type { MissionScriptRunnerInterface } from '../campaign/scripting/MissionScriptTypes';
import type { MapMetadata } from '../config/MapLoader';
import type { DeliverySystem } from '../simulation/DeliverySystem';

// Save/Load types
export interface SavedEntity {
  x: number; z: number; y: number; rotY: number;
  hp: number; maxHp: number; owner: number;
  unitTypeId?: number; buildingTypeId?: number;
  harvester?: { spice: number; maxCap: number; state: number; refEid: number };
  moveTarget?: { x: number; z: number; active: number };
  speed?: { max: number; turn: number };
  vet?: { xp: number; rank: number };
  ammo?: number;
  passengerTypeIds?: number[];
  stance?: number;
  guardPos?: { x: number; z: number };
  attackMoveDest?: { x: number; z: number };
  shield?: { current: number; max: number };
}

export interface SaveData {
  version: number;
  tick: number;
  housePrefix: string;
  enemyPrefix: string;
  houseName: string;
  enemyName: string;
  gameMode?: string;
  difficulty?: string;
  mapChoice?: any;
  skirmishOptions?: any;
  opponents?: OpponentConfig[];
  campaignTerritoryId?: number;
  subhouse?: any;
  mapId?: string;
  missionConfig?: MissionConfigData;
  solaris: number[];
  entities: SavedEntity[];
  spice: number[][];
  production?: any;
  fogExplored?: number[];
  superweaponCharge?: Array<{ playerId: number; palaceType: string; charge: number }>;
  victoryTick?: number;
  controlGroups?: Record<number, number[]>;
  groundSplats?: Array<{ x: number; z: number; ticksLeft: number; ownerPlayerId: number; type: string }>;
  abilityState?: {
    deviated?: Array<{ eid: number; originalOwner: number; revertTick: number }>;
    leech?: Array<{ leechEid: number; targetEid: number }>;
    kobraDeployed?: number[];
    kobraBaseRange?: Array<{ eid: number; range: number }>;
  };
  rngState?: [number, number, number, number];
  scriptState?: import('../campaign/scripting/MissionScriptTypes').MissionScriptState;
  scriptId?: string;
}

export interface GroundSplat {
  x: number; z: number;
  ticksLeft: number;
  ownerPlayerId: number;
  type: 'inkvine' | 'fallout';
}

/**
 * GameContext holds all instantiated systems and shared mutable state.
 * Passed to each extracted module's setup function.
 */
export interface GameContext {
  // Core
  game: Game;
  gameRules: GameRules;
  artMap: Map<string, ArtEntry>;
  typeRegistry: TypeRegistry;
  house: HouseChoice;
  opponents: OpponentConfig[];
  totalPlayers: number;
  activeMissionConfig: MissionConfigData | null;
  activeMapId: string | null;
  mapMetadata: MapMetadata | null;
  missionRuntime: MissionRuntimeSettings | null;

  // Systems
  scene: SceneManager;
  terrain: TerrainRenderer;
  input: InputManager;
  modelManager: ModelManager;
  unitRenderer: UnitRenderer;
  selectionManager: SelectionManager;
  commandManager: CommandManager;
  pathfinder: PathfindingSystem;
  asyncPathfinder: AsyncPathfinder;
  movement: MovementSystem;
  combatSystem: CombatSystem;
  harvestSystem: HarvestSystem;
  productionSystem: ProductionSystem;
  minimapRenderer: MinimapRenderer;
  fogOfWar: FogOfWar;
  effectsManager: EffectsManager;
  damageNumbers: DamageNumbers;
  sandwormSystem: SandwormSystem;
  abilitySystem: AbilitySystem;
  superweaponSystem: SuperweaponSystem;
  wallSystem: WallSystem;
  audioManager: AudioManager;
  buildingPlacement: BuildingPlacement;
  victorySystem: VictorySystem;
  gameStats: GameStats;
  selectionPanel: SelectionPanel;
  sidebar: Sidebar;
  iconRenderer: IconRenderer;
  pipRenderer: PIPRenderer;
  aiPlayers: AIPlayer[];
  agentAI: AIPlayer | null; // Agent mode: AIPlayer controlling player 0
  deliverySystem: DeliverySystem;

  // Mission scripting
  missionScriptRunner: MissionScriptRunnerInterface | null;

  // Shared mutable state
  aircraftAmmo: Map<number, number>;
  rearmingAircraft: Set<number>;
  descendingUnits: Map<number, { startTick: number; duration: number }>;
  dyingTilts: Map<number, { obj: THREE.Object3D; tiltDir: number; startTick: number; startY: number; isBuilding?: boolean }>;
  processedDeaths: Set<number>;
  deferredActions: Array<{ tick: number; action: () => void }>;
  repairingBuildings: Set<number>;
  groundSplats: GroundSplat[];
  bloomMarkers: Map<string, { mesh: THREE.Mesh; ticks: number }>;
  activeCrates: Map<number, { x: number; z: number; type: string }>;
  nextCrateId: number;
  stormWaitTimer: number;
  activeStormListener: ((data: { tick: number }) => void) | null;

  // Entity factory functions (set after EntityFactory is created)
  spawnUnit: (world: any, typeName: string, owner: number, x: number, z: number) => number;
  spawnBuilding: (world: any, typeName: string, owner: number, x: number, z: number) => number;
  sellBuilding: (eid: number) => void;
  repairBuilding: (eid: number) => void;
  tickRepairs: () => void;
  findRefinery: (world: any, owner: number, nearX?: number, nearZ?: number) => number | null;
  findNearestLandingPad: (world: any, owner: number, fromX: number, fromZ: number) => { eid: number; x: number; z: number } | null;
  deferAction: (delayTicks: number, action: () => void) => void;

  // Save/Load
  buildSaveData: () => SaveData;
  saveGame: () => void;

  // Determinism & Replay
  hashTracker: SimulationHashTracker;
  replayRecorder: ReplayRecorder;
  replayPlayer: ReplayPlayer;

  // UI callbacks
  pushGameEvent: (x: number, z: number, type: string) => void;
  updateSpeedIndicator: (speed: number) => void;

  // Constants
  MAX_AMMO: number;
}
