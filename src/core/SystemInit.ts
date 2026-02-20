import * as THREE from 'three';
import type { GameRules } from '../config/RulesParser';
import type { ArtEntry } from '../config/ArtIniParser';
import type { HouseChoice, OpponentConfig } from '../ui/HouseSelect';
import type { MissionConfigData } from '../campaign/MissionConfig';
import type { MissionRuntimeSettings } from '../campaign/MissionRuntime';
import type { GameContext } from './GameContext';
import type { TypeRegistry } from './TypeRegistry';
import { Game } from './Game';
import { SceneManager } from '../rendering/SceneManager';
import { TerrainRenderer, TerrainType } from '../rendering/TerrainRenderer';
import { InputManager } from '../input/InputManager';
import { ModelManager } from '../rendering/ModelManager';
import { UnitRenderer } from '../rendering/UnitRenderer';
import { SelectionManager } from '../input/SelectionManager';
import { CommandManager } from '../input/CommandManager';
import { MovementSystem } from '../simulation/MovementSystem';
import { PathfindingSystem } from '../simulation/PathfindingSystem';
import { CombatSystem } from '../simulation/CombatSystem';
import { HarvestSystem } from '../simulation/HarvestSystem';
import { ProductionSystem } from '../simulation/ProductionSystem';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { FogOfWar } from '../rendering/FogOfWar';
import { EffectsManager } from '../rendering/EffectsManager';
import { DamageNumbers } from '../rendering/DamageNumbers';
import { SandwormSystem } from '../simulation/SandwormSystem';
import { AbilitySystem } from '../simulation/AbilitySystem';
import { SuperweaponSystem } from '../simulation/SuperweaponSystem';
import { AIPlayer } from '../ai/AIPlayer';
import { AudioManager } from '../audio/AudioManager';
import { BuildingPlacement } from '../input/BuildingPlacement';
import { VictorySystem, GameStats } from '../ui/VictoryScreen';
import { SelectionPanel } from '../ui/SelectionPanel';
import { Sidebar } from '../ui/Sidebar';
import { IconRenderer } from '../rendering/IconRenderer';
import { EventBus } from './EventBus';
import { GameConstants } from '../utils/Constants';
import { worldToTile } from '../utils/MathUtils';
import { createEntityFactory } from './EntityFactory';
import { buildSaveData as buildSaveDataFn, saveGame as saveGameFn } from './SaveLoadSystem';
import {
  hasComponent,
  Position, Health, Owner, UnitType,
  MoveTarget, AttackTarget, Harvester, BuildingType, Veterancy,
  unitQuery, buildingQuery,
} from './ECS';

export interface SystemInitConfig {
  gameRules: GameRules;
  artMap: Map<string, ArtEntry>;
  typeRegistry: TypeRegistry;
  house: HouseChoice;
  audioManager: AudioManager;
  sharedRenderer: THREE.WebGLRenderer;
  activeMissionConfig: MissionConfigData | null;
  activeMapId: string | null;
  missionRuntime: MissionRuntimeSettings | null;
}

export function initializeSystems(config: SystemInitConfig): GameContext {
  const {
    gameRules, artMap, typeRegistry, house, audioManager,
    sharedRenderer, activeMissionConfig, activeMapId, missionRuntime,
  } = config;
  const { unitTypeIdMap, unitTypeNames, buildingTypeIdMap, buildingTypeNames, armourIdMap } = typeRegistry;

  // Create game and systems
  const game = new Game();
  const scene = new SceneManager(sharedRenderer);
  const terrain = new TerrainRenderer(scene);
  const input = new InputManager(scene);
  const modelManager = new ModelManager();
  const unitRenderer = new UnitRenderer(scene, modelManager, artMap);
  const selectionManager = new SelectionManager(scene, unitRenderer);
  selectionManager.setBuildingTypeNames(buildingTypeNames);
  const commandManager = new CommandManager(scene, selectionManager, unitRenderer);
  commandManager.setAudioManager(audioManager);

  // Unit classifier
  const classifyUnit = (eid: number): 'infantry' | 'vehicle' | 'harvester' => {
    try {
      const w = game.getWorld();
      if (w && hasComponent(w, Harvester, eid)) return 'harvester';
    } catch { /* world not ready yet */ }
    const typeId = UnitType.id[eid];
    const typeName = unitTypeNames[typeId] ?? '';
    const def = gameRules.units.get(typeName);
    if (def?.infantry) return 'infantry';
    return 'vehicle';
  };
  audioManager.setUnitClassifier(classifyUnit);
  audioManager.setBuildingChecker((eid: number) => {
    try { return hasComponent(game.getWorld(), BuildingType, eid); } catch { return false; }
  });
  audioManager.setUnitTypeResolver((eid: number): string => {
    const typeId = UnitType.id[eid];
    return unitTypeNames[typeId] ?? '';
  });
  commandManager.setUnitClassifier(classifyUnit);

  const pathfinder = new PathfindingSystem(terrain);
  const movement = new MovementSystem(pathfinder);
  const combatSystem = new CombatSystem(gameRules);
  commandManager.setCombatSystem(combatSystem);
  const effectsManager = new EffectsManager(scene);
  commandManager.setMoveMarkerFn((x, z) => effectsManager.spawnMoveMarker(x, z));
  const harvestSystem = new HarvestSystem(terrain);
  commandManager.setForceReturnFn((eid) => harvestSystem.forceReturn(eid));
  const productionSystem = new ProductionSystem(gameRules, harvestSystem);

  const playerDifficulty = house.difficulty ?? 'normal';
  productionSystem.setDifficulty(0, playerDifficulty, false);
  productionSystem.setDifficulty(1, playerDifficulty, true);

  const minimapRenderer = new MinimapRenderer(terrain, scene);
  minimapRenderer.setRightClickCallback((worldX, worldZ) => {
    const selected = selectionManager.getSelectedEntities();
    if (selected.length === 0) return;
    for (const eid of selected) {
      if (Owner.playerId[eid] !== 0) continue;
      if (Health.current[eid] <= 0) continue;
      MoveTarget.x[eid] = worldX;
      MoveTarget.z[eid] = worldZ;
      MoveTarget.active[eid] = 1;
    }
    audioManager.playSfx('move');
    EventBus.emit('unit:move', { entityIds: selected, x: worldX, z: worldZ });
  });
  minimapRenderer.setWorldGetter(() => game.getWorld());
  minimapRenderer.setSelectionCallback((entityIds) => {
    const w = game.getWorld();
    if (w) selectionManager.selectEntities(w, entityIds);
  });

  const fogOfWar = new FogOfWar(scene, terrain, 0);
  minimapRenderer.setFogOfWar(fogOfWar);
  minimapRenderer.setUnitCategoryFn((eid: number): 'infantry' | 'vehicle' | 'aircraft' => {
    const typeId = UnitType.id[eid];
    const typeName = unitTypeNames[typeId];
    if (!typeName) return 'vehicle';
    const def = gameRules.units.get(typeName);
    if (!def) return 'vehicle';
    if (def.canFly) return 'aircraft';
    if (def.infantry) return 'infantry';
    return 'vehicle';
  });
  minimapRenderer.setBuildingNameFn((eid: number): string => {
    const typeId = BuildingType.id[eid];
    return buildingTypeNames[typeId] ?? '';
  });
  const hiddenRadarBuildings = new Set<string>();
  for (const [name, bDef] of gameRules.buildings) {
    if (bDef.hideOnRadar) hiddenRadarBuildings.add(name);
  }
  if (hiddenRadarBuildings.size > 0) {
    minimapRenderer.setHiddenBuildingNames(hiddenRadarBuildings);
  }

  unitRenderer.setFogOfWar(fogOfWar, 0);
  unitRenderer.setUnitCategoryFn((eid: number): 'infantry' | 'vehicle' | 'aircraft' | 'building' => {
    const w = game.getWorld();
    if (w && hasComponent(w, BuildingType, eid)) return 'building';
    const typeId = UnitType.id[eid];
    const typeName = unitTypeNames[typeId];
    if (!typeName) return 'vehicle';
    const def = gameRules.units.get(typeName);
    if (!def) return 'vehicle';
    if (def.canFly) return 'aircraft';
    if (def.infantry) return 'infantry';
    return 'vehicle';
  });
  unitRenderer.setAttackMoveFn((eid: number) => combatSystem.isAttackMove(eid));
  unitRenderer.setIdleHarvesterFn((eid: number) => {
    const world = game.getWorld();
    return hasComponent(world, Harvester, eid) && Harvester.state[eid] === 0 && MoveTarget.active[eid] === 0;
  });

  combatSystem.setFogOfWar(fogOfWar, 0);
  combatSystem.setSpatialGrid(movement.getSpatialGrid());
  combatSystem.setTerrain(terrain);
  combatSystem.setSandstormCallback(() => effectsManager.isSandstormActive());
  movement.setSpeedModifier((eid: number) => {
    let mult = combatSystem.getHitSlowdownMultiplier(eid);
    if (effectsManager.isSandstormActive()) {
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      const tType = terrain.getTerrainType(tile.tx, tile.tz);
      if (tType === TerrainType.Sand || tType === TerrainType.Dunes) mult *= 0.5;
    }
    return mult;
  });
  combatSystem.setPlayerFaction(0, house.prefix);
  combatSystem.setPlayerFaction(1, house.enemyPrefix);

  productionSystem.setUnitCountCallback((playerId: number) => {
    const world = game.getWorld();
    const units = unitQuery(world);
    let count = 0;
    for (const eid of units) {
      if (Owner.playerId[eid] !== playerId) continue;
      if (Health.current[eid] <= 0) continue;
      count++;
    }
    return count;
  });

  const damageNumbers = new DamageNumbers(scene);
  damageNumbers.setFogOfWar(fogOfWar);

  const opponentCount = house.opponents?.length ?? 1;
  const totalPlayers = 1 + opponentCount;
  const gameStats = new GameStats(totalPlayers);
  const victorySystem = new VictorySystem(audioManager, 0);
  victorySystem.setStats(gameStats);
  victorySystem.setBuildingTypeNames(buildingTypeNames);
  if (house.skirmishOptions?.victoryCondition) {
    victorySystem.setVictoryCondition(house.skirmishOptions.victoryCondition);
  }

  const sandwormSystem = new SandwormSystem(terrain, effectsManager);
  sandwormSystem.setRules(gameRules, unitTypeNames);

  // AI setup
  const opponents: OpponentConfig[] = house.opponents ?? [{ prefix: house.enemyPrefix, difficulty: house.difficulty ?? 'normal' }];
  const aiSubhousePrefixes = ['FR', 'IM', 'IX', 'TL', 'GU'];
  const playerSubPrefix = house.subhouse?.prefix ?? '';
  const availableSubhouses = aiSubhousePrefixes.filter(p => p !== playerSubPrefix);

  const aiPlayers: AIPlayer[] = [];
  for (let i = 0; i < opponents.length; i++) {
    const playerId = i + 1;
    const aiDifficulty = missionRuntime?.aiDifficulty ?? opponents[i].difficulty;
    const ai = new AIPlayer(gameRules, combatSystem, playerId, 200, 200, 60, 60);
    ai.setUnitPool(opponents[i].prefix);
    ai.setDifficulty(aiDifficulty);
    if (missionRuntime?.aiPersonality !== null && missionRuntime?.aiPersonality !== undefined) {
      ai.setPersonality((missionRuntime.aiPersonality + i) % 5);
    }
    ai.setSubhousePrefix(availableSubhouses[i % availableSubhouses.length]);
    ai.setProductionSystem(productionSystem, harvestSystem);
    ai.setBuildingTypeNames(buildingTypeNames);
    ai.setUnitTypeNames(unitTypeNames);
    ai.setSpatialGrid(movement.getSpatialGrid());
    ai.setTickOffset(Math.floor((i * 10) / opponents.length));
    aiPlayers.push(ai);
    if (playerId > 1) {
      combatSystem.setPlayerFaction(playerId, opponents[i].prefix);
      productionSystem.setDifficulty(playerId, aiDifficulty, true);
    }
    console.log(`AI ${playerId}: ${opponents[i].prefix}, sub-house: ${availableSubhouses[i % availableSubhouses.length]}, difficulty: ${aiDifficulty}`);
  }
  if (opponents.length > 0) {
    const ai1Difficulty = missionRuntime?.aiDifficulty ?? opponents[0].difficulty;
    productionSystem.setDifficulty(1, ai1Difficulty, true);
  }

  // Shared mutable state
  const aircraftAmmo = new Map<number, number>();
  const rearmingAircraft = new Set<number>();
  const descendingUnits = new Map<number, { startTick: number; duration: number }>();
  const dyingTilts = new Map<number, { obj: THREE.Object3D; tiltDir: number; startTick: number; startY: number }>();
  const processedDeaths = new Set<number>();
  const deferredActions: Array<{ tick: number; action: () => void }> = [];
  const repairingBuildings = new Set<number>();
  const groundSplats: import('./GameContext').GroundSplat[] = [];
  const bloomMarkers = new Map<string, { mesh: THREE.Mesh; ticks: number }>();
  const activeCrates = new Map<number, { x: number; z: number; type: string }>();
  const MAX_AMMO = 6;

  // Create entity factory with mutable deps (selectionPanel set after creation)
  const factoryDeps: import('./EntityFactory').EntityFactoryDeps = {
    gameRules, artMap, typeRegistry, terrain, unitRenderer, combatSystem,
    movement, harvestSystem, productionSystem, effectsManager, audioManager,
    selectionPanel: null as any, // Set after selectionPanel is created below
    game, aircraftAmmo, rearmingAircraft, repairingBuildings, processedDeaths,
    MAX_AMMO,
  };
  const entityFactory = createEntityFactory(factoryDeps);

  // Building placement
  const buildingPlacement = new BuildingPlacement(scene, terrain, audioManager, (typeName, x, z) => {
    const world = game.getWorld();
    const eid = entityFactory.spawnBuilding(world, typeName, 0, x, z);
    movement.invalidateAllPaths();
    if (eid >= 0) {
      audioManager.playSfx('place');
      EventBus.emit('building:placed', { entityId: eid, buildingType: typeName, owner: 0 });
      const def = gameRules.buildings.get(typeName);
      const duration = def ? Math.max(25, Math.floor(def.buildTime * 0.5)) : 75;
      unitRenderer.startConstruction(eid, duration);

      if (def?.getUnitWhenBuilt) {
        const freeUnitName = def.getUnitWhenBuilt;
        const buildingEid = eid;
        deferredActions.push({ tick: game.getTickCount() + duration, action: () => {
          if (Health.current[buildingEid] <= 0) return;
          const w = game.getWorld();
          const freeEid = entityFactory.spawnUnit(w, freeUnitName, 0, x + 3, z + 3);
          if (freeEid >= 0) {
            audioManager.getDialogManager()?.trigger('unitReady');
          }
        }});
      }
    }
  });

  const buildingFootprints = new Map<string, { w: number; h: number }>();
  for (const [name, def] of gameRules.buildings) {
    const h = def.occupy.length || 3;
    const w = def.occupy[0]?.length || 3;
    buildingFootprints.set(name, { w, h });
  }
  buildingPlacement.setBuildingContext(buildingTypeNames, buildingFootprints);

  // Selection panel
  const selectionPanel = new SelectionPanel(
    gameRules, audioManager, unitTypeNames, buildingTypeNames,
    entityFactory.sellBuilding, entityFactory.repairBuilding
  );
  selectionPanel.setProductionSystem(productionSystem, (_eid, buildingType) => {
    if (productionSystem.startUpgrade(0, buildingType)) {
      selectionPanel.addMessage(`Upgrading ${buildingType.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '')}`, '#88f');
    } else {
      selectionPanel.addMessage('Cannot upgrade', '#ff4444');
    }
  });
  selectionPanel.setCombatSystem(combatSystem);

  // Wire selectionPanel into entity factory deps (now reads lazily)
  factoryDeps.selectionPanel = selectionPanel;

  // Ability system
  const abilitySystem = new AbilitySystem({
    rules: gameRules,
    combatSystem,
    sandwormSystem,
    productionSystem,
    unitRenderer,
    effectsManager,
    scene,
    audioManager,
    commandManager,
    selectionManager,
    selectionPanel,
    unitTypeNames,
    buildingTypeNames,
    unitTypeIdMap,
    spawnUnit: (w, typeName, owner, x, z) => entityFactory.spawnUnit(w, typeName, owner, x, z),
    spawnBuilding: (w, typeName, owner, x, z) => entityFactory.spawnBuilding(w, typeName, owner, x, z),
    getWorld: () => game.getWorld(),
    getTickCount: () => game.getTickCount(),
    housePrefix: house.prefix,
    enemyPrefix: house.enemyPrefix,
    getTerrainType: (x: number, z: number) => {
      const tile = worldToTile(x, z);
      return terrain.getTerrainType(tile.tx, tile.tz);
    },
  });

  selectionPanel.setPassengerCountFn((eid) => abilitySystem.getTransportPassengerCount(eid));
  selectionPanel.setRepairingFn((eid) => repairingBuildings.has(eid));
  selectionPanel.setPlayerFaction(house.prefix);
  selectionPanel.setPanToFn((x, z) => scene.panTo(x, z));
  selectionPanel.setDeselectFn((eid) => {
    const current = selectionManager.getSelectedEntities();
    const filtered = current.filter(e => e !== eid);
    if (filtered.length > 0) {
      selectionManager.selectEntities(game.getWorld(), filtered);
    } else {
      EventBus.emit('unit:deselected', {});
    }
  });

  // Wire rearm progress
  unitRenderer.setRearmProgressFn((eid: number) => {
    if (!rearmingAircraft.has(eid)) return null;
    const ammo = aircraftAmmo.get(eid) ?? 0;
    return ammo / MAX_AMMO;
  });

  selectionPanel.setAircraftAmmoFn((eid: number) => {
    if (!aircraftAmmo.has(eid)) return null;
    return { current: aircraftAmmo.get(eid)!, max: MAX_AMMO };
  });

  // AI spawn callbacks
  for (const ai of aiPlayers) {
    ai.setSpawnCallback((eid, typeName, owner, x, z) => {
      const world = game.getWorld();
      removeEntity(world, eid);
      entityFactory.spawnUnit(world, typeName, owner, x, z);
    });
  }

  // Superweapon system
  const superweaponSystem = new SuperweaponSystem({
    scene,
    effectsManager,
    audioManager,
    selectionPanel,
    minimapRenderer,
    totalPlayers,
    buildingTypeNames,
    getWorld: () => game.getWorld(),
    getTickCount: () => game.getTickCount(),
    getPowerMultiplier: (pid) => productionSystem.getPowerMultiplier(pid),
  });

  // Sidebar
  const sidebar = new Sidebar(gameRules, productionSystem, artMap, (typeName, isBuilding) => {
    if (isBuilding) {
      const def = gameRules.buildings.get(typeName);
      if (!def) return;
      if (!productionSystem.startProduction(0, typeName, true)) {
        audioManager.playSfx('error');
        selectionPanel.addMessage('Cannot build', '#ff4444');
        audioManager.getDialogManager()?.trigger('insufficientFunds');
        return;
      }
    } else {
      if (!productionSystem.startProduction(0, typeName, false)) {
        audioManager.playSfx('error');
        selectionPanel.addMessage('Cannot build', '#ff4444');
        audioManager.getDialogManager()?.trigger('insufficientFunds');
        return;
      }
    }
    sidebar.refresh();
  }, house.prefix, house.subhouse?.prefix ?? '');

  const iconRenderer = new IconRenderer();

  // Build the GameContext
  const ctx: GameContext = {
    game, gameRules, artMap, typeRegistry, house,
    opponents, totalPlayers,
    activeMissionConfig, activeMapId, missionRuntime,

    scene, terrain, input, modelManager, unitRenderer,
    selectionManager, commandManager, pathfinder, movement,
    combatSystem, harvestSystem, productionSystem,
    minimapRenderer, fogOfWar, effectsManager, damageNumbers,
    sandwormSystem, abilitySystem, superweaponSystem,
    audioManager, buildingPlacement, victorySystem, gameStats,
    selectionPanel, sidebar, iconRenderer, aiPlayers,

    aircraftAmmo, rearmingAircraft, descendingUnits, dyingTilts,
    processedDeaths, deferredActions, repairingBuildings,
    groundSplats, bloomMarkers, activeCrates,
    nextCrateId: 0,
    stormWaitTimer: GameConstants.STORM_MIN_WAIT + Math.floor(Math.random() * GameConstants.STORM_MAX_WAIT),
    activeStormListener: null,

    spawnUnit: entityFactory.spawnUnit,
    spawnBuilding: entityFactory.spawnBuilding,
    sellBuilding: entityFactory.sellBuilding,
    repairBuilding: entityFactory.repairBuilding,
    tickRepairs: entityFactory.tickRepairs,
    findRefinery: entityFactory.findRefinery,
    findNearestLandingPad: entityFactory.findNearestLandingPad,
    deferAction: (delayTicks, action) => {
      deferredActions.push({ tick: game.getTickCount() + delayTicks, action });
    },

    buildSaveData: () => buildSaveDataFn(ctx),
    saveGame: () => saveGameFn(ctx),

    // These will be wired up by registerInputHandlers
    pushGameEvent: () => {},
    updateSpeedIndicator: () => {},

    MAX_AMMO,
  };

  return ctx;
}

// Need this import for AI spawn callback
import { removeEntity } from './ECS';
