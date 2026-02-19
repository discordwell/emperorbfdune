import * as THREE from 'three';
import { Game } from './core/Game';
import { SceneManager } from './rendering/SceneManager';
import { TerrainRenderer, TerrainType } from './rendering/TerrainRenderer';
import { InputManager } from './input/InputManager';
import { parseRules, type GameRules } from './config/RulesParser';
import { parseArtIni, type ArtEntry } from './config/ArtIniParser';
import { loadConstants, GameConstants } from './utils/Constants';
import { worldToTile } from './utils/MathUtils';
import { ModelManager } from './rendering/ModelManager';
import { UnitRenderer } from './rendering/UnitRenderer';
import { SelectionManager } from './input/SelectionManager';
import { CommandManager } from './input/CommandManager';
import { MovementSystem } from './simulation/MovementSystem';
import { PathfindingSystem } from './simulation/PathfindingSystem';
import { CombatSystem } from './simulation/CombatSystem';
import { HarvestSystem } from './simulation/HarvestSystem';
import { ProductionSystem, type ProductionState } from './simulation/ProductionSystem';
import { Sidebar } from './ui/Sidebar';
import { IconRenderer } from './rendering/IconRenderer';
import { MinimapRenderer } from './rendering/MinimapRenderer';
import { AIPlayer } from './ai/AIPlayer';
import { EventBus } from './core/EventBus';
import { AudioManager } from './audio/AudioManager';
import { FogOfWar } from './rendering/FogOfWar';
import { BuildingPlacement } from './input/BuildingPlacement';
import { VictorySystem, GameStats } from './ui/VictoryScreen';
import { HouseSelect, type HouseChoice, type SubhouseChoice, type Difficulty, type MapChoice, type GameMode, type SkirmishOptions, type OpponentConfig } from './ui/HouseSelect';
import { loadMap, getCampaignMapId } from './config/MapLoader';
import { CampaignMap } from './ui/CampaignMap';
import { SelectionPanel } from './ui/SelectionPanel';
import { EffectsManager } from './rendering/EffectsManager';
import { DamageNumbers } from './rendering/DamageNumbers';
import { SandwormSystem } from './simulation/SandwormSystem';
import { AbilitySystem } from './simulation/AbilitySystem';
import { showMissionBriefing } from './ui/MissionBriefing';
import { loadCampaignStrings, type HousePrefix, JUMP_POINTS } from './campaign/CampaignData';
import { CampaignPhaseManager } from './campaign/CampaignPhaseManager';
import { SubHouseSystem } from './campaign/SubHouseSystem';
import { MentatScreen } from './ui/MentatScreen';
import { PauseMenu } from './ui/PauseMenu';
import { SuperweaponSystem } from './simulation/SuperweaponSystem';
import { getDisplayName } from './config/DisplayNames';
import { generateMissionConfig, type MissionConfigData } from './campaign/MissionConfig';
import {
  addEntity, addComponent, removeEntity, hasComponent,
  Position, Velocity, Rotation, Health, Owner, UnitType, Selectable,
  MoveTarget, AttackTarget, Combat, Armour, Speed, ViewRange, Renderable,
  Harvester, BuildingType, PowerSource, Veterancy, TurretRotation,
  unitQuery, buildingQuery,
  type World,
} from './core/ECS';

// Globals
let gameRules: GameRules;
let artMap: Map<string, ArtEntry>;

// Save/Load types
interface SavedEntity {
  x: number; z: number; y: number; rotY: number;
  hp: number; maxHp: number; owner: number;
  unitTypeId?: number; buildingTypeId?: number;
  harvester?: { spice: number; maxCap: number; state: number; refEid: number };
  moveTarget?: { x: number; z: number; active: number };
  speed?: { max: number; turn: number };
  vet?: { xp: number; rank: number };
  ammo?: number; // aircraft ammo
  passengerTypeIds?: number[]; // transport passenger unit type IDs
  stance?: number; // 0=aggressive, 1=defensive (default, not saved), 2=hold
  guardPos?: { x: number; z: number }; // guard position
}

interface SaveData {
  version: number;
  tick: number;
  housePrefix: string;
  enemyPrefix: string;
  houseName: string;
  enemyName: string;
  solaris: number[];
  entities: SavedEntity[];
  spice: number[][]; // [row][col]
  production?: ProductionState;
  fogExplored?: number[]; // RLE-encoded explored tiles
  superweaponCharge?: Array<{ playerId: number; palaceType: string; charge: number }>;
  victoryTick?: number;
}

// ID maps
const unitTypeIdMap = new Map<string, number>();
const unitTypeNames: string[] = [];
const buildingTypeIdMap = new Map<string, number>();
const buildingTypeNames: string[] = [];
const armourIdMap = new Map<string, number>();

/** Distribute N spawn positions evenly around an ellipse inscribed in the map */
function getSpawnPositions(mapW: number, mapH: number, count: number): { x: number; z: number }[] {
  const TILE_SZ = 2; // TILE_SIZE from MathUtils
  const centerX = (mapW / 2) * TILE_SZ;
  const centerZ = (mapH / 2) * TILE_SZ;
  const radiusX = mapW * 0.35 * TILE_SZ;
  const radiusZ = mapH * 0.35 * TILE_SZ;
  const margin = 20 * TILE_SZ; // 20 tiles from edge minimum
  const maxX = mapW * TILE_SZ - margin;
  const maxZ = mapH * TILE_SZ - margin;

  const positions: { x: number; z: number }[] = [];

  if (count === 2) {
    // Classic 2-player: opposite corners (preserves original behavior)
    const minPos = Math.max(margin, 50);
    const corners = [
      { x: minPos, z: minPos },   // Top-left
      { x: maxX, z: minPos },     // Top-right
      { x: minPos, z: maxZ },     // Bottom-left
      { x: maxX, z: maxZ },       // Bottom-right
    ];
    const playerIdx = Math.floor(Math.random() * 4);
    const enemyIdx = 3 - playerIdx; // Opposite corner
    positions.push(corners[playerIdx], corners[enemyIdx]);
  } else {
    // N players: evenly spaced around ellipse, starting from random angle
    const startAngle = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const angle = startAngle + (i * Math.PI * 2) / count;
      let x = centerX + Math.cos(angle) * radiusX;
      let z = centerZ + Math.sin(angle) * radiusZ;
      // Clamp to map bounds with margin
      x = Math.max(margin, Math.min(maxX, x));
      z = Math.max(margin, Math.min(maxZ, z));
      positions.push({ x, z });
    }
  }

  return positions;
}

function updateLoading(pct: number, text: string, detail?: string) {
  const bar = document.getElementById('loading-bar');
  const label = document.getElementById('loading-text');
  const detailEl = document.getElementById('loading-detail');
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = text;
  if (detailEl) detailEl.textContent = detail ?? '';
}

async function main() {
  console.log('Emperor: Battle for Dune - Initializing...');
  updateLoading(5, 'Loading game data...');

  // Load rules and art ini in parallel
  const [rulesResponse, artResponse] = await Promise.all([
    fetch('/extracted/MODEL0001/Rules.txt'),
    fetch('/extracted/MODEL0001/ArtIni.txt'),
  ]);
  const [rulesText, artText] = await Promise.all([rulesResponse.text(), artResponse.text()]);

  updateLoading(15, 'Parsing game rules...');
  gameRules = parseRules(rulesText);
  artMap = parseArtIni(artText);
  loadConstants(gameRules.general);

  // Build ID maps
  let idx = 0;
  for (const name of gameRules.units.keys()) {
    unitTypeIdMap.set(name, idx);
    unitTypeNames.push(name);
    idx++;
  }
  idx = 0;
  for (const name of gameRules.buildings.keys()) {
    buildingTypeIdMap.set(name, idx);
    buildingTypeNames.push(name);
    idx++;
  }
  idx = 0;
  for (const armour of gameRules.armourTypes) {
    armourIdMap.set(armour, idx);
    idx++;
  }

  console.log(`Parsed: ${gameRules.units.size} units, ${gameRules.buildings.size} buildings`);

  // Audio manager (created early for menu music)
  const audioManager = new AudioManager();

  // Initialize voice system with parsed game rules
  audioManager.initVoices(gameRules);

  // Check for saved game to load
  const shouldLoad = localStorage.getItem('ebfd_load') === '1';
  const savedJson = shouldLoad ? (localStorage.getItem('ebfd_load_data') ?? localStorage.getItem('ebfd_save')) : null;
  let savedGame: SaveData | null = null;
  if (savedJson) {
    try { savedGame = JSON.parse(savedJson); } catch { /* corrupted save */ }
  }
  localStorage.removeItem('ebfd_load');
  localStorage.removeItem('ebfd_load_data');

  // Create WebGLRenderer early so it can be shared between 3D menus and game
  const gameCanvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  let sharedRenderer: THREE.WebGLRenderer | null = null;
  try {
    sharedRenderer = new THREE.WebGLRenderer({
      canvas: gameCanvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    sharedRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    sharedRenderer.setSize(window.innerWidth, window.innerHeight);
    console.log('WebGL renderer created');
  } catch (e) {
    console.warn('WebGL renderer creation failed, using DOM menus:', e);
  }

  // House selection screen (skip if loading)
  let house: HouseChoice;
  if (savedGame) {
    house = {
      id: savedGame.housePrefix.toLowerCase(),
      name: savedGame.houseName,
      prefix: savedGame.housePrefix,
      color: '#ffffff',
      description: '',
      enemyPrefix: savedGame.enemyPrefix,
      enemyName: savedGame.enemyName,
      difficulty: 'normal' as Difficulty,
      gameMode: 'skirmish' as GameMode,
    };
    // Hide loading screen elements from house select
    const loadScreen = document.getElementById('loading-screen');
    if (loadScreen) loadScreen.style.display = 'flex';
  } else {
    // Hide loading screen and game HUD so house selection is visible
    const loadScreenEl = document.getElementById('loading-screen');
    const uiOverlay = document.getElementById('ui-overlay');
    if (loadScreenEl) loadScreenEl.style.display = 'none';
    if (uiOverlay) uiOverlay.style.display = 'none';
    const houseSelect = new HouseSelect(audioManager, sharedRenderer ? gameCanvas : undefined, sharedRenderer ?? undefined);
    house = await houseSelect.show();
    if (uiOverlay) uiOverlay.style.display = '';

    // Load campaign strings for briefing text
    if (house.gameMode === 'campaign') {
      await loadCampaignStrings();
    }

    // Show mission briefing for campaign mode BEFORE restoring loading screen
    if (house.gameMode === 'campaign' && house.campaignTerritoryId !== undefined) {
      // Retrieve campaign state to build mission config
      const savedCampaign = localStorage.getItem('ebfd_campaign');
      let missionConfig: MissionConfigData | undefined;
      if (savedCampaign) {
        try {
          const cState = JSON.parse(savedCampaign);
          const phaseManager = CampaignPhaseManager.deserialize(cState.phaseState);
          const territory = cState.territories?.find((t: { id: number }) => t.id === house.campaignTerritoryId);
          if (territory) {
            const playerCount = cState.territories.filter((t: { owner: string }) => t.owner === 'player').length;
            const enemyCount = cState.territories.filter((t: { owner: string }) => t.owner === 'enemy' || t.owner === 'enemy2').length;
            const enemyHouse = territory.ownerHouse !== 'neutral' && territory.ownerHouse !== cState.housePrefix
              ? territory.ownerHouse as HousePrefix : cState.enemyPrefix as HousePrefix;
            missionConfig = generateMissionConfig({
              playerHouse: cState.housePrefix as HousePrefix,
              phase: phaseManager.getCurrentPhase(),
              phaseType: phaseManager.getPhaseType(),
              territoryId: house.campaignTerritoryId,
              territoryName: territory.name,
              enemyHouse,
              isAttack: territory.owner !== 'player',
              territoryDiff: playerCount - enemyCount,
              subHousePresent: null,
            });
            // Override enemy for this mission based on territory owner
            house.enemyPrefix = enemyHouse;
            const enemyNames: Record<string, string> = { AT: 'Atreides', HK: 'Harkonnen', OR: 'Ordos' };
            house.enemyName = enemyNames[enemyHouse] ?? house.enemyName;
          }
        } catch { /* use defaults */ }
      }

      // Build territory data from campaign state or fall back
      const campaignState = savedCampaign ? JSON.parse(savedCampaign) : null;
      const tData = campaignState?.territories?.find((t: { id: number }) => t.id === house.campaignTerritoryId);
      if (tData) {
        const briefingResult = await showMissionBriefing(
          { id: house.campaignTerritoryId, name: tData.name, description: tData.description ?? '', difficulty: tData.difficulty ?? 'normal', x: 0, y: 0, adjacent: [], mapSeed: 0, owner: 'enemy', ownerHouse: tData.ownerHouse ?? 'neutral', isHomeworld: false },
          house.name, house.prefix, house.enemyName, undefined, missionConfig
        );
        if (briefingResult === 'resign') {
          window.location.reload();
          return;
        }
      }
    }

    // Now restore loading screen for asset loading phase
    if (loadScreenEl) loadScreenEl.style.display = 'flex';
  }

  console.log(`Playing as ${house.name} vs ${house.enemyName}`);
  audioManager.setPlayerFaction(house.prefix);
  audioManager.startGameMusic();
  audioManager.startAmbientWind();

  // Create game and systems
  const game = new Game();
  // Create renderer now if it wasn't created earlier (e.g. WebGL was temporarily unavailable)
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({
      canvas: gameCanvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    sharedRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    sharedRenderer.setSize(window.innerWidth, window.innerHeight);
  }
  const scene = new SceneManager(sharedRenderer);
  const terrain = new TerrainRenderer(scene);
  const input = new InputManager(scene);
  const modelManager = new ModelManager();
  const unitRenderer = new UnitRenderer(scene, modelManager, artMap);
  const selectionManager = new SelectionManager(scene, unitRenderer);
  selectionManager.setBuildingTypeNames(buildingTypeNames);
  const commandManager = new CommandManager(scene, selectionManager, unitRenderer);
  commandManager.setAudioManager(audioManager);

  // Unit classifier: determines category for audio feedback
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
  // Unit type resolver: maps entity ID -> unit type name (for voice lines)
  audioManager.setUnitTypeResolver((eid: number): string => {
    const typeId = UnitType.id[eid];
    return unitTypeNames[typeId] ?? '';
  });
  commandManager.setUnitClassifier(classifyUnit);

  const pathfinder = new PathfindingSystem(terrain);
  const movement = new MovementSystem(pathfinder);
  const combatSystem = new CombatSystem(gameRules);
  commandManager.setCombatSystem(combatSystem);
  commandManager.setMoveMarkerFn((x, z) => effectsManager.spawnMoveMarker(x, z));
  const harvestSystem = new HarvestSystem(terrain);
  commandManager.setForceReturnFn((eid) => harvestSystem.forceReturn(eid));
  const productionSystem = new ProductionSystem(gameRules, harvestSystem);
  // Apply difficulty-based cost/time scaling (additional AI players registered after opponents array is created)
  const playerDifficulty = house.difficulty ?? 'normal';
  productionSystem.setDifficulty(0, playerDifficulty, false);  // Human player
  productionSystem.setDifficulty(1, playerDifficulty, true);   // AI player 1 gets inverse scaling
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
  // Differentiated minimap rendering: unit types and building names
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
  // Build set of building names hidden from minimap (decorations like trees)
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
  // Idle harvester visual indicator
  unitRenderer.setIdleHarvesterFn((eid: number) => {
    const world = game.getWorld();
    return hasComponent(world, Harvester, eid) && Harvester.state[eid] === 0 && MoveTarget.active[eid] === 0;
  });
  combatSystem.setFogOfWar(fogOfWar, 0);
  combatSystem.setSpatialGrid(movement.getSpatialGrid());
  combatSystem.setTerrain(terrain);
  movement.setSpeedModifier((eid: number) => combatSystem.getHitSlowdownMultiplier(eid));
  combatSystem.setPlayerFaction(0, house.prefix);
  combatSystem.setPlayerFaction(1, house.enemyPrefix);  // AI player 1 (additional AIs registered below)

  // Unit population cap
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
  const effectsManager = new EffectsManager(scene);
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

  // Campaign progress tracking
  if (house.gameMode === 'campaign' && house.campaignTerritoryId !== undefined) {
    const campaign = new CampaignMap(audioManager, house.prefix, house.name, house.enemyPrefix, house.enemyName);
    const phaseManager = campaign.getPhaseManager();
    const subHouseSystem = campaign.getSubHouseSystem();

    // Apply victory condition from phase state machine
    const phaseType = phaseManager.getPhaseType();
    const phase = phaseManager.getCurrentPhase();
    const victoryObjectives: Record<string, { condition: string; label: string }> = {
      heighliner: { condition: 'survival', label: 'Survive the Heighliner mission' },
      homeDefense: { condition: 'survival', label: 'Defend your homeworld' },
      homeAttack: { condition: 'annihilate', label: 'Destroy all enemy structures' },
      civilWar: { condition: 'annihilate', label: 'Win the civil war' },
      final: { condition: 'annihilate', label: 'Defeat the Emperor Worm' },
    };

    const specialObj = victoryObjectives[phaseType];
    if (specialObj) {
      victorySystem.setVictoryCondition(specialObj.condition as 'conyard' | 'annihilate' | 'survival');
      victorySystem.setObjectiveLabel(specialObj.label);
      if (specialObj.condition === 'survival') {
        victorySystem.setSurvivalTicks(25 * 60 * 8); // 8 minutes
      }
    } else {
      // Standard missions: conyard for early phases, annihilate for Phase 3+
      const vc = phase >= 3 ? 'annihilate' : 'conyard';
      victorySystem.setVictoryCondition(vc);
      victorySystem.setObjectiveLabel(
        vc === 'annihilate' ? 'Destroy all enemy structures' : 'Destroy the enemy Construction Yard'
      );
    }

    // Tech level override for production
    const techLevel = phaseManager.getCurrentTechLevel();
    productionSystem.setOverrideTechLevel(0, techLevel);

    victorySystem.setVictoryCallback(() => {
      // Determine capture status BEFORE recording victory (which changes owner)
      const targetTerritory = campaign.getState().territories.find(t => t.id === house.campaignTerritoryId);
      const capturedTerritory = targetTerritory ? targetTerritory.owner !== 'player' : true;

      // Check if captured territory is an enemy jump point (not our own)
      const playerJP = JUMP_POINTS[house.prefix as HousePrefix];
      const isJumpPoint = Object.values(JUMP_POINTS).some(jp => jp === house.campaignTerritoryId && jp !== playerJP);

      // Record victory in campaign state (sets territory owner to 'player')
      campaign.recordVictory(house.campaignTerritoryId!);

      phaseManager.recordBattleResult(true, capturedTerritory, isJumpPoint);
      campaign.saveCampaign();
    });

    victorySystem.setDefeatCallback(() => {
      // Record defeat in phase manager (no territory captured)
      phaseManager.recordBattleResult(false, false, false);
      campaign.recordDefeat();
    });

    victorySystem.setCampaignContinue(async () => {
      // Check phase transitions
      const phState = phaseManager.getState();

      if (phState.isVictory) {
        // Campaign complete!
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:3000;font-family:inherit;';
        overlay.innerHTML = `
          <div style="color:#f0c040;font-size:48px;font-weight:bold;text-shadow:0 0 20px #f0c04060;margin-bottom:12px;">CAMPAIGN COMPLETE</div>
          <div style="color:#ccc;font-size:18px;margin-bottom:8px;">House ${house.name} has conquered Arrakis!</div>
          <div style="color:#888;font-size:14px;margin-bottom:24px;">The spice must flow under your command.</div>
        `;
        const menuBtn = document.createElement('button');
        menuBtn.textContent = 'Return to Menu';
        menuBtn.style.cssText = 'padding:12px 36px;font-size:16px;background:#f0c04022;border:2px solid #f0c040;color:#fff;cursor:pointer;';
        menuBtn.onclick = () => window.location.reload();
        overlay.appendChild(menuBtn);
        document.body.appendChild(overlay);
        return;
      }

      if (phState.isLost) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:3000;font-family:inherit;';
        overlay.innerHTML = `
          <div style="color:#cc4444;font-size:48px;font-weight:bold;margin-bottom:12px;">CAMPAIGN LOST</div>
          <div style="color:#ccc;font-size:18px;margin-bottom:24px;">House ${house.name} has fallen on Arrakis.</div>
        `;
        const menuBtn = document.createElement('button');
        menuBtn.textContent = 'Return to Menu';
        menuBtn.style.cssText = 'padding:12px 36px;font-size:16px;background:#cc444422;border:2px solid #cc4444;color:#fff;cursor:pointer;';
        menuBtn.onclick = () => {
          localStorage.removeItem('ebfd_campaign');
          window.location.reload();
        };
        overlay.appendChild(menuBtn);
        document.body.appendChild(overlay);
        return;
      }

      // Show campaign map for next territory selection
      const choice = await campaign.show();
      if (choice) {
        localStorage.setItem('ebfd_campaign_next', JSON.stringify({
          territoryId: choice.territory.id,
          difficulty: choice.difficulty,
          mapSeed: choice.mapSeed,
        }));
        window.location.reload();
      } else {
        window.location.reload();
      }
    });
  }

  const sandwormSystem = new SandwormSystem(terrain, effectsManager);

  // AI setup — support multiple opponents
  const opponents: OpponentConfig[] = house.opponents ?? [{ prefix: house.enemyPrefix, difficulty: house.difficulty ?? 'normal' }];
  const aiSubhousePrefixes = ['FR', 'IM', 'IX', 'TL', 'GU'];
  const playerSubPrefix = house.subhouse?.prefix ?? '';
  const availableSubhouses = aiSubhousePrefixes.filter(p => p !== playerSubPrefix);

  const aiPlayers: AIPlayer[] = [];
  for (let i = 0; i < opponents.length; i++) {
    const playerId = i + 1;
    // Positions will be set after terrain loads (in FRESH GAME section)
    const ai = new AIPlayer(gameRules, combatSystem, playerId, 200, 200, 60, 60);
    ai.setUnitPool(opponents[i].prefix);
    ai.setDifficulty(opponents[i].difficulty);
    ai.setSubhousePrefix(availableSubhouses[i % availableSubhouses.length]);
    ai.setProductionSystem(productionSystem, harvestSystem);
    ai.setBuildingTypeNames(buildingTypeNames);
    ai.setUnitTypeNames(unitTypeNames);
    ai.setSpatialGrid(movement.getSpatialGrid());
    // Stagger tick offsets to spread CPU load across frames
    ai.setTickOffset(Math.floor((i * 10) / opponents.length));
    aiPlayers.push(ai);
    // Register faction and difficulty for additional AI players (player 1 already registered above)
    if (playerId > 1) {
      combatSystem.setPlayerFaction(playerId, opponents[i].prefix);
      productionSystem.setDifficulty(playerId, opponents[i].difficulty, true);
    }
    console.log(`AI ${playerId}: ${opponents[i].prefix}, sub-house: ${availableSubhouses[i % availableSubhouses.length]}, difficulty: ${opponents[i].difficulty}`);
  }

  // Apply skirmish options
  if (house.skirmishOptions) {
    const opts = house.skirmishOptions;
    // Override starting credits (default is 5000 set in HarvestSystem.init)
    const extraCredits = opts.startingCredits - 5000;
    if (extraCredits !== 0) {
      harvestSystem.addSolaris(0, extraCredits);
      for (let i = 0; i < opponents.length; i++) {
        harvestSystem.addSolaris(i + 1, extraCredits);
      }
    }
    // Apply unit cap
    productionSystem.setMaxUnits(opts.unitCap);
  }

  // Hard difficulty: AI gets resource bonus
  for (let i = 0; i < opponents.length; i++) {
    if (opponents[i].difficulty === 'hard') {
      harvestSystem.addSolaris(i + 1, 3000);
    }
  }

  // Register systems
  game.addSystem(input);
  game.addSystem(movement);
  game.addSystem(combatSystem);
  game.addSystem(harvestSystem);
  for (const ai of aiPlayers) game.addSystem(ai);
  game.addSystem(sandwormSystem);
  game.addRenderSystem(scene);

  // Initialize
  updateLoading(30, 'Initializing game systems...');
  game.init();
  // Initialize solaris for additional AI players (game.init calls harvestSystem.init with default=2 players)
  for (let i = 2; i < totalPlayers; i++) {
    harvestSystem.addSolaris(i, 5000);
  }
  updateLoading(40, 'Loading terrain...');
  // Determine which map to load
  let realMapId: string | undefined;
  if (house.mapChoice?.mapId) {
    // Skirmish: real map selected from manifest
    realMapId = house.mapChoice.mapId;
  } else if (house.gameMode === 'campaign' && house.campaignTerritoryId) {
    // Campaign: derive map ID from territory
    realMapId = getCampaignMapId(house.campaignTerritoryId, house.prefix) ?? undefined;
  }

  let mapLoaded = false;
  if (realMapId) {
    const mapData = await loadMap(realMapId);
    if (mapData) {
      await terrain.loadFromMapData(mapData);
      mapLoaded = true;
      console.log(`Loaded real map: ${realMapId} (${mapData.width}×${mapData.height})`);
    }
  }
  if (!mapLoaded) {
    // Fallback to procedural generation
    if (house.mapChoice) {
      terrain.setMapSeed(house.mapChoice.seed);
    }
    await terrain.generate();
  }

  // Update systems with actual map dimensions after terrain is ready
  const mapW = terrain.getMapWidth(), mapH = terrain.getMapHeight();
  for (const ai of aiPlayers) ai.setMapDimensions(mapW, mapH);
  fogOfWar.reinitialize(); // Re-create fog buffers/mesh for actual map dimensions
  minimapRenderer.renderTerrain(); // Re-render minimap with actual terrain data
  scene.setMapBounds(mapW * 2, mapH * 2); // TILE_SIZE = 2
  movement.setMapBounds(mapW * 2, mapH * 2);
  movement.setTerrain(terrain);

  // Load model manifest for case-insensitive lookups
  updateLoading(45, 'Loading model manifest...');
  await modelManager.loadManifest();

  // Preload all models
  updateLoading(50, 'Loading unit models...');
  const allUnitNames = [...gameRules.units.keys()];
  await unitRenderer.preloadModels(allUnitNames, (done, total, name) => {
    const pct = 50 + Math.round((done / total) * 25);
    updateLoading(pct, `Loading unit models... (${done}/${total})`, name);
  });
  updateLoading(75, 'Loading building models...');
  // Filter out decorative/environmental buildings (birds, whales, etc.) — only preload faction buildings with cost > 0
  const factionPrefixes = ['AT', 'HK', 'OR', 'FR', 'IM', 'IX', 'TL', 'GU', 'IN'];
  const allBuildingNames = [...gameRules.buildings.keys()].filter(name => {
    const def = gameRules.buildings.get(name)!;
    const art = artMap.get(name);
    return art?.xaf && def.cost > 0 && factionPrefixes.some(p => name.startsWith(p));
  });
  await unitRenderer.preloadBuildingModels(allBuildingNames, (done, total, name) => {
    const pct = 75 + Math.round((done / total) * 13);
    updateLoading(pct, `Loading building models... (${done}/${total})`, name);
  });
  // Retry any pending model assignments that were deferred during preload
  unitRenderer.resolvePendingModels();

  // Render sidebar production icons from 3D models
  updateLoading(88, 'Rendering icons...', 'Production thumbnails');
  const iconRenderer = new IconRenderer();
  const iconNames = [...allUnitNames, ...allBuildingNames].map(n => {
    const art = artMap.get(n);
    return art?.xaf ?? n;
  });
  await iconRenderer.renderIcons(iconNames, modelManager);

  // Preload priority SFX samples (non-blocking, runs in parallel with spawn)
  updateLoading(88, 'Loading audio samples...', 'Sound effects');
  await audioManager.preloadSfx();

  // Preload voice lines for the player's faction
  updateLoading(89, 'Loading voice lines...', house.name + ' faction voices');
  await audioManager.preloadVoices(house.prefix);

  // Preload spoken dialog lines (advisor/mentat callouts)
  updateLoading(90, 'Loading dialog lines...', 'Advisor callouts');
  audioManager.initDialog();
  await audioManager.preloadDialog(house.prefix);

  updateLoading(92, 'Spawning bases...', 'Placing starting structures');

  // --- SPAWN HELPERS ---

  function findRefinery(world: World, owner: number, nearX?: number, nearZ?: number): number | null {
    const buildings = buildingQuery(world);
    let best: number | null = null;
    let bestDist = Infinity;
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== owner) continue;
      if (Health.current[eid] <= 0) continue;
      const typeId = BuildingType.id[eid];
      const name = buildingTypeNames[typeId] ?? '';
      if (name.includes('Refinery') || name.includes('RefineryDock')) {
        if (nearX !== undefined && nearZ !== undefined) {
          const dx = Position.x[eid] - nearX;
          const dz = Position.z[eid] - nearZ;
          const dist = dx * dx + dz * dz;
          if (dist < bestDist) { bestDist = dist; best = eid; }
        } else {
          return eid;
        }
      }
    }
    return best;
  }

  function spawnUnit(world: World, typeName: string, owner: number, x: number, z: number): number {
    const def = gameRules.units.get(typeName);
    if (!def) return -1;

    const eid = addEntity(world);
    addComponent(world, Position, eid);
    addComponent(world, Velocity, eid);
    addComponent(world, Rotation, eid);
    addComponent(world, Health, eid);
    addComponent(world, Owner, eid);
    addComponent(world, UnitType, eid);
    addComponent(world, Selectable, eid);
    addComponent(world, MoveTarget, eid);
    addComponent(world, AttackTarget, eid);
    addComponent(world, Speed, eid);
    addComponent(world, Renderable, eid);
    addComponent(world, ViewRange, eid);

    Position.x[eid] = x;
    Position.y[eid] = terrain.getHeightAt(x, z) + 0.1;
    Position.z[eid] = z;
    Rotation.y[eid] = 0;
    Health.current[eid] = def.health;
    Health.max[eid] = def.health;
    Owner.playerId[eid] = owner;
    UnitType.id[eid] = unitTypeIdMap.get(typeName) ?? 0;
    Selectable.selected[eid] = 0;
    MoveTarget.active[eid] = 0;
    AttackTarget.active[eid] = 0;
    Speed.max[eid] = def.speed;
    Speed.turnRate[eid] = def.turnRate;
    Renderable.modelId[eid] = unitTypeIdMap.get(typeName) ?? 0;
    Renderable.sceneIndex[eid] = -1;
    ViewRange.range[eid] = (def.viewRange || 5) * 2;

    if (def.turretAttach) {
      addComponent(world, Combat, eid);
      addComponent(world, TurretRotation, eid);
      TurretRotation.y[eid] = 0;
      const turret = gameRules.turrets.get(def.turretAttach);
      const bullet = turret ? gameRules.bullets.get(turret.bullet) : null;
      Combat.weaponId[eid] = 0;
      Combat.attackRange[eid] = bullet ? bullet.maxRange * 2 : 8;
      Combat.fireTimer[eid] = 0;
      Combat.rof[eid] = turret?.reloadCount ?? 30;
    }

    addComponent(world, Armour, eid);
    Armour.type[eid] = armourIdMap.get(def.armour) ?? 0;

    addComponent(world, Veterancy, eid);
    Veterancy.xp[eid] = 0;
    Veterancy.rank[eid] = 0;

    combatSystem.registerUnit(eid, typeName);

    const art = artMap.get(typeName);
    if (art?.xaf) {
      unitRenderer.setEntityModel(eid, art.xaf);
    }

    // Register aircraft for flight system
    if (def.canFly) {
      movement.registerFlyer(eid);
      Position.y[eid] = 5.0; // Flight altitude
    }

    // Register infantry for terrain passability
    if (def.infantry) {
      movement.registerInfantry(eid);
    }

    // Ornithopters/gunships need rearming - track ammo
    if (def.ornithopter) {
      aircraftAmmo.set(eid, MAX_AMMO);
    }

    // Auto-add harvester component for harvester units
    if (typeName.includes('Harvester') || typeName.includes('Harv')) {
      addComponent(world, Harvester, eid);
      Harvester.maxCapacity[eid] = 1.0;
      Harvester.spiceCarried[eid] = 0;
      Harvester.state[eid] = 0;
      // Link to nearest refinery owned by same player
      Harvester.refineryEntity[eid] = findRefinery(world, owner, x, z) ?? 0;
    }

    return eid;
  }

  function spawnBuilding(world: World, typeName: string, owner: number, x: number, z: number): number {
    const def = gameRules.buildings.get(typeName);
    if (!def) return -1;

    const eid = addEntity(world);
    addComponent(world, Position, eid);
    addComponent(world, Rotation, eid);
    addComponent(world, Health, eid);
    addComponent(world, Owner, eid);
    addComponent(world, BuildingType, eid);
    addComponent(world, Renderable, eid);
    addComponent(world, Selectable, eid);
    addComponent(world, ViewRange, eid);

    Position.x[eid] = x;
    Position.y[eid] = terrain.getHeightAt(x, z);
    Position.z[eid] = z;
    Rotation.y[eid] = 0;

    // Concrete slab bonus: buildings on concrete get 50% more health
    let healthBonus = 1.0;
    const bTile = worldToTile(x, z);
    const bHalfW = 1; // 3x3 footprint => half = 1
    const bHalfH = 1;
    let concreteCount = 0;
    let totalTiles = 0;
    for (let dtz = -bHalfH; dtz <= bHalfH; dtz++) {
      for (let dtx = -bHalfW; dtx <= bHalfW; dtx++) {
        totalTiles++;
        if (terrain.getTerrainType(bTile.tx + dtx, bTile.tz + dtz) === TerrainType.ConcreteSlab) {
          concreteCount++;
        }
      }
    }
    if (concreteCount > 0) {
      healthBonus = 1.0 + 0.5 * (concreteCount / totalTiles);
    }

    Health.current[eid] = Math.floor(def.health * healthBonus);
    Health.max[eid] = Math.floor(def.health * healthBonus);
    Owner.playerId[eid] = owner;
    BuildingType.id[eid] = buildingTypeIdMap.get(typeName) ?? 0;
    Renderable.modelId[eid] = 0;
    Renderable.sceneIndex[eid] = -1;
    Selectable.selected[eid] = 0;
    ViewRange.range[eid] = (def.viewRange || 10) * 2; // Convert tile range to world units

    if (def.powerGenerated > 0 || def.powerUsed > 0) {
      addComponent(world, PowerSource, eid);
      PowerSource.amount[eid] = def.powerGenerated - def.powerUsed;
    }

    if (def.turretAttach) {
      addComponent(world, Combat, eid);
      addComponent(world, TurretRotation, eid);
      TurretRotation.y[eid] = 0;
      addComponent(world, MoveTarget, eid);
      addComponent(world, AttackTarget, eid);
      addComponent(world, Velocity, eid);
      addComponent(world, Speed, eid);
      Speed.max[eid] = 0;
      Speed.turnRate[eid] = 0;
      MoveTarget.active[eid] = 0;
      AttackTarget.active[eid] = 0;
      const turret = gameRules.turrets.get(def.turretAttach);
      const bullet = turret ? gameRules.bullets.get(turret.bullet) : null;
      Combat.attackRange[eid] = bullet ? bullet.maxRange * 2 : 12;
      Combat.rof[eid] = turret?.reloadCount ?? 45;
      // Register in combat system so damage lookups work
      combatSystem.registerUnit(eid, typeName);
    }

    addComponent(world, Armour, eid);
    Armour.type[eid] = armourIdMap.get(def.armour) ?? armourIdMap.get('Building') ?? 0;

    productionSystem.addPlayerBuilding(owner, typeName);

    const art = artMap.get(typeName);
    if (art?.xaf) {
      unitRenderer.setEntityModel(eid, art.xaf, 0.025);
    }

    return eid;
  }

  function sellBuilding(eid: number): void {
    const world = game.getWorld();
    if (!hasComponent(world, BuildingType, eid)) return;
    if (Owner.playerId[eid] !== 0) return; // Only sell own buildings

    const typeId = BuildingType.id[eid];
    const typeName = buildingTypeNames[typeId];
    const def = typeName ? gameRules.buildings.get(typeName) : null;
    // Refund scales by building HP ratio (damaged buildings return less)
    const hpRatio = Health.max[eid] > 0 ? Health.current[eid] / Health.max[eid] : 1;
    const refund = def ? Math.floor(def.cost * 0.5 * hpRatio) : 0;

    harvestSystem.addSolaris(0, refund);
    selectionPanel.addMessage(`Sold for ${refund} Solaris`, '#f0c040');
    audioManager.getDialogManager()?.trigger('buildingSold');

    effectsManager.clearBuildingDamage(eid);

    // Clean up from production prerequisites and combat immediately
    if (typeName) {
      productionSystem.removePlayerBuilding(0, typeName);
    }
    combatSystem.unregisterUnit(eid);

    const bx = Position.x[eid];
    const bz = Position.z[eid];

    // Prevent combat targeting this building and block duplicate death processing
    Health.current[eid] = 0;
    processedDeaths.add(eid);

    // Notify systems that building is gone (path invalidation, AI tracking, etc.)
    EventBus.emit('building:destroyed', { entityId: eid, owner: 0, x: bx, z: bz });
    movement.invalidateAllPaths();

    // Animate deconstruction over ~2 seconds (50 ticks), then remove
    unitRenderer.startDeconstruction(eid, 50, () => {
      effectsManager.spawnExplosion(bx, Position.y[eid], bz, 'small');
      try { removeEntity(world, eid); } catch {}
    });
  }

  // Continuous repair: set of building eids being auto-repaired
  const repairingBuildings = new Set<number>();

  function repairBuilding(eid: number): void {
    const world = game.getWorld();
    if (!hasComponent(world, BuildingType, eid)) return;
    if (Owner.playerId[eid] !== 0) return;

    // Toggle continuous repair on/off
    if (repairingBuildings.has(eid)) {
      repairingBuildings.delete(eid);
      selectionPanel.addMessage('Repair stopped', '#aaaaaa');
      return;
    }

    const hp = Health.current[eid];
    const maxHp = Health.max[eid];
    if (hp >= maxHp) {
      selectionPanel.addMessage('Building at full health', '#aaaaaa');
      return;
    }

    repairingBuildings.add(eid);
    audioManager.playSfx('build');
    selectionPanel.addMessage('Repairing...', '#44ff44');
  }

  // Called from game tick to process continuous repairs
  function tickRepairs(): void {
    if (repairingBuildings.size === 0) return;

    for (const eid of repairingBuildings) {
      const world = game.getWorld();
      if (!hasComponent(world, BuildingType, eid) || Health.current[eid] <= 0) {
        repairingBuildings.delete(eid);
        continue;
      }

      const hp = Health.current[eid];
      const maxHp = Health.max[eid];
      if (hp >= maxHp) {
        repairingBuildings.delete(eid);
        selectionPanel.addMessage('Repair complete', '#44ff44');
        continue;
      }

      // Repair 1% per tick (~2.5% per second), costs proportional
      const repairAmount = Math.min(maxHp * 0.01, maxHp - hp);
      const typeId = BuildingType.id[eid];
      const typeName = buildingTypeNames[typeId];
      const def = typeName ? gameRules.buildings.get(typeName) : null;
      const cost = def ? Math.max(1, Math.floor(def.cost * 0.005)) : 5;

      if (harvestSystem.spendSolaris(0, cost)) {
        Health.current[eid] += repairAmount;
      } else {
        repairingBuildings.delete(eid);
        selectionPanel.addMessage('Repair stopped: insufficient funds', '#ff4444');
        audioManager.getDialogManager()?.trigger('insufficientFunds');
      }
    }
  }

  // --- BUILDING PLACEMENT ---

  const buildingPlacement = new BuildingPlacement(scene, terrain, audioManager, (typeName, x, z) => {
    const world = game.getWorld();
    // Cost already paid by ProductionSystem.startProduction() — just spawn
    const eid = spawnBuilding(world, typeName, 0, x, z);
    movement.invalidateAllPaths(); // Building changed terrain
    // Animate construction over ~3 seconds (75 ticks at 25 TPS)
    if (eid >= 0) {
      audioManager.playSfx('place');
      const def = gameRules.buildings.get(typeName);
      const duration = def ? Math.max(25, Math.floor(def.buildTime * 0.5)) : 75;
      unitRenderer.startConstruction(eid, duration);

      // Spawn free unit when building completes (e.g. Harvester from Refinery)
      if (def?.getUnitWhenBuilt) {
        const freeUnitName = def.getUnitWhenBuilt;
        setTimeout(() => {
          const w = game.getWorld();
          const freeEid = spawnUnit(w, freeUnitName, 0, x + 3, z + 3);
          if (freeEid >= 0) {
            audioManager.getDialogManager()?.trigger('unitReady');
          }
        }, duration * 40); // Match construction duration (40ms per tick at 25 TPS)
      }
    }
  });

  // Build footprint map from game rules for building placement
  const buildingFootprints = new Map<string, { w: number; h: number }>();
  for (const [name, def] of gameRules.buildings) {
    const h = def.occupy.length || 3;
    const w = def.occupy[0]?.length || 3;
    buildingFootprints.set(name, { w, h });
  }
  buildingPlacement.setBuildingContext(buildingTypeNames, buildingFootprints);

  // --- SELECTION PANEL ---

  const selectionPanel = new SelectionPanel(
    gameRules, audioManager, unitTypeNames, buildingTypeNames,
    sellBuilding, repairBuilding
  );
  selectionPanel.setProductionSystem(productionSystem, (_eid, buildingType) => {
    if (productionSystem.startUpgrade(0, buildingType)) {
      selectionPanel.addMessage(`Upgrading ${buildingType.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '')}`, '#88f');
    } else {
      selectionPanel.addMessage('Cannot upgrade', '#ff4444');
    }
  });
  selectionPanel.setCombatSystem(combatSystem);
  // --- ABILITY SYSTEM ---
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
    spawnUnit: (w, typeName, owner, x, z) => spawnUnit(w, typeName, owner, x, z),
    spawnBuilding: (w, typeName, owner, x, z) => spawnBuilding(w, typeName, owner, x, z),
    getWorld: () => game.getWorld(),
    getTickCount: () => game.getTickCount(),
    housePrefix: house.prefix,
    enemyPrefix: house.enemyPrefix,
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

  // --- AI SPAWN CALLBACK ---

  for (const ai of aiPlayers) {
    ai.setSpawnCallback((eid, typeName, owner, x, z) => {
      const world = game.getWorld();
      removeEntity(world, eid);
      spawnUnit(world, typeName, owner, x, z);
    });
  }

  // --- EVENTS ---

  // Track harvest income
  EventBus.on('harvest:delivered', ({ amount, owner }) => {
    gameStats.recordCreditsEarned(owner, amount);
  });

  // Track damage dealt for post-game stats
  EventBus.on('combat:hit', ({ damage, attackerOwner }) => {
    gameStats.recordDamage(attackerOwner, damage);
  });

  // Refund when player cancels building placement
  EventBus.on('placement:cancelled', ({ typeName }) => {
    const refund = productionSystem.getAdjustedCost(0, typeName, true);
    if (refund > 0) {
      harvestSystem.addSolaris(0, refund);
      selectionPanel.addMessage('Building cancelled - refunded', '#f0c040');
    }
  });

  const processedDeaths = new Set<number>();
  EventBus.on('unit:died', ({ entityId }) => {
    if (processedDeaths.has(entityId)) return;
    processedDeaths.add(entityId);
    const world = game.getWorld();
    const isBuilding = hasComponent(world, BuildingType, entityId);
    const x = Position.x[entityId];
    const y = Position.y[entityId];
    const z = Position.z[entityId];
    const deadOwner = Owner.playerId[entityId];

    // Track stats
    if (isBuilding) gameStats.recordBuildingLost(deadOwner);
    else gameStats.recordUnitLost(deadOwner);

    combatSystem.unregisterUnit(entityId);
    movement.unregisterFlyer(entityId);
    movement.unregisterInfantry(entityId);
    effectsManager.clearBuildingDamage(entityId);

    // Clean up aircraft ammo tracking
    aircraftAmmo.delete(entityId);
    rearmingAircraft.delete(entityId);
    // Clean up all ability tracking (transport, leech, kobra, NIAB, etc.)
    abilitySystem.handleUnitDeath(entityId);

    // Visual effects — infantry get small, vehicles medium, buildings large
    const isUnit = hasComponent(world, UnitType, entityId);
    let explosionSize: 'small' | 'medium' | 'large' = 'medium';
    if (isBuilding) explosionSize = 'large';
    else if (isUnit) {
      const typeId = UnitType.id[entityId];
      const typeName = unitTypeNames[typeId];
      const def = typeName ? gameRules.units.get(typeName) : null;
      explosionSize = def?.infantry ? 'small' : 'medium';
    }
    effectsManager.spawnExplosion(x, y, z, explosionSize);
    effectsManager.spawnWreckage(x, y, z, isBuilding);
    effectsManager.spawnDecal(x, z, explosionSize);
    // Minimap death ping (red for enemy deaths, orange for own units)
    const deathColor = deadOwner === 0 ? '#ff6600' : '#ff2222';
    minimapRenderer.flashPing(x, z, deathColor);
    // Screen shake proportional to explosion size
    if (explosionSize === 'large') scene.shake(0.4);
    else if (explosionSize === 'medium') scene.shake(0.15);
    if (isBuilding) {
      EventBus.emit('building:destroyed', { entityId, owner: deadOwner, x, z });
      movement.invalidateAllPaths(); // Building removed — paths may have changed
    }

    // Death animation: play explode clip if available, otherwise procedural tilt
    const hasDeathClip = unitRenderer.playDeathAnim(entityId);
    const obj = unitRenderer.getEntityObject(entityId);
    if (obj && !isBuilding && !hasDeathClip) {
      const tiltDir = Math.random() * Math.PI * 2;
      let frame = 0;
      const animateDeath = () => {
        if (!obj.parent || frame >= 8) return;
        frame++;
        obj.rotation.x = Math.sin(tiltDir) * frame * 0.1;
        obj.rotation.z = Math.cos(tiltDir) * frame * 0.1;
        obj.position.y -= 0.05;
        if (frame < 8) setTimeout(animateDeath, 50);
      };
      animateDeath();
    }

    // Clean up building from production prerequisites
    if (isBuilding) {
      const typeId = BuildingType.id[entityId];
      const typeName = buildingTypeNames[typeId];
      if (typeName) {
        productionSystem.removePlayerBuilding(Owner.playerId[entityId], typeName);
      }

      // Spawn infantry survivors when building is destroyed
      const bDef = typeName ? gameRules.buildings.get(typeName) : null;
      if (bDef && bDef.numInfantryWhenGone > 0) {
        const FACTION_INFANTRY: Record<string, string> = {
          'AT': 'ATInfantry', 'HK': 'HKLightInf', 'OR': 'ORChemical',
          'FR': 'FRFremen', 'IM': 'IMSardaukar', 'IX': 'IXSlave',
          'TL': 'TLContaminator', 'GU': 'GUMaker'
        };
        const prefix = typeName.substring(0, 2);
        const infantryType = FACTION_INFANTRY[prefix];
        if (infantryType && gameRules.units.has(infantryType)) {
          const count = Math.min(bDef.numInfantryWhenGone, 5);
          for (let i = 0; i < count; i++) {
            const sx = x + (Math.random() - 0.5) * 4;
            const sz = z + (Math.random() - 0.5) * 4;
            spawnUnit(world, infantryType, deadOwner, sx, sz);
          }
          EventBus.emit('building:survivors', { x, z, count, owner: deadOwner });
          if (deadOwner === 0) {
            selectionPanel.addMessage(`${count} survivor${count > 1 ? 's' : ''} emerged from wreckage`, '#88cc88');
          }
        }
      }
    }

    // Auto-replace harvesters: queue a new one if player loses a harvester
    const owner = Owner.playerId[entityId];
    if (owner === 0 && hasComponent(world, Harvester, entityId)) {
      const typeId = UnitType.id[entityId];
      const harvTypeName = unitTypeNames[typeId];
      if (harvTypeName && findRefinery(world, 0)) {
        // Auto-queue replacement
        if (productionSystem.startProduction(0, harvTypeName, false)) {
          selectionPanel.addMessage('Harvester lost - replacement queued', '#ff8800');
        }
      }
    }

    setTimeout(() => {
      try { removeEntity(world, entityId); } catch {}
    }, 500);
  });

  // Veterancy promotion
  EventBus.on('unit:promoted', ({ entityId, rank }) => {
    if (Owner.playerId[entityId] === 0) {
      const rankNames = ['', 'Veteran', 'Elite', 'Heroic'];
      selectionPanel.addMessage(`Unit promoted to ${rankNames[rank]}!`, '#ffd700');
      audioManager.playSfx('select');
    }
    // Gold star burst at unit position
    effectsManager.spawnPromotionBurst(Position.x[entityId], 0, Position.z[entityId]);
  });

  // Sandworm events
  EventBus.on('worm:emerge', () => {
    selectionPanel.addMessage('Worm sign detected!', '#ff8800');
    audioManager.playSfx('worm');
    scene.shake(0.5);
  });
  EventBus.on('worm:eat', ({ ownerId }) => {
    if (ownerId === 0) {
      selectionPanel.addMessage('Unit lost to sandworm!', '#ff4444');
    }
  });

  // Spice bloom events
  const bloomMarkers = new Map<string, { mesh: THREE.Mesh; ticks: number }>();
  EventBus.on('bloom:warning', ({ x, z }) => {
    selectionPanel.addMessage('Spice bloom forming...', '#ff8800');
    // Create pulsing ground marker at bloom site
    const geo = new THREE.RingGeometry(1.5, 3.0, 16);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.1, z);
    scene.scene.add(mesh);
    bloomMarkers.set(`${Math.floor(x)},${Math.floor(z)}`, { mesh, ticks: 0 });
  });
  EventBus.on('bloom:tremor', ({ x, z, intensity }) => {
    // Spawn small dust particles at bloom site
    effectsManager.spawnExplosion(x + (Math.random() - 0.5) * 4, 0, z + (Math.random() - 0.5) * 4, 'small');
    // Pulse the bloom marker
    const key = `${Math.floor(x)},${Math.floor(z)}`;
    const marker = bloomMarkers.get(key);
    if (marker) {
      marker.ticks = 0; // Reset TTL on activity
      (marker.mesh.material as THREE.MeshBasicMaterial).opacity = 0.3 + intensity * 0.5;
      const scale = 1.0 + intensity * 0.5;
      marker.mesh.scale.set(scale, scale, scale);
    }
  });
  EventBus.on('bloom:eruption', ({ x, z }) => {
    effectsManager.spawnExplosion(x, 0.5, z, 'large');
    scene.shake(0.3);
    selectionPanel.addMessage('Spice bloom detected!', '#ff8800');
    audioManager.playSfx('worm'); // Rumble sound
    terrain.updateSpiceVisuals(); // Immediate visual update for bloom
    // Remove bloom marker
    const key = `${Math.floor(x)},${Math.floor(z)}`;
    const marker = bloomMarkers.get(key);
    if (marker) {
      scene.scene.remove(marker.mesh);
      marker.mesh.geometry.dispose();
      (marker.mesh.material as THREE.Material).dispose();
      bloomMarkers.delete(key);
    }
    // Bloom eruption damages nearby units (SpicePuff damage within bloom radius)
    const dmgRadius = GameConstants.SPICE_BLOOM_DAMAGE_RADIUS;
    const r2 = dmgRadius * dmgRadius;
    const allUnits = unitQuery(world);
    for (const eid of allUnits) {
      if (Health.current[eid] <= 0) continue;
      const dx = Position.x[eid] - x;
      const dz = Position.z[eid] - z;
      if (dx * dx + dz * dz <= r2) {
        Health.current[eid] = Math.max(0, Health.current[eid] - GameConstants.SPICE_BLOOM_DAMAGE);
        if (Health.current[eid] <= 0) {
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
        }
      }
    }
  });

  // Cash fallback notification
  EventBus.on('spice:cashFallback', ({ amount }) => {
    selectionPanel.addMessage(`Emergency spice reserves: +${amount} credits`, '#FFD700');
  });

  // Under-attack notifications (throttled to once per 5 seconds)
  let lastAttackNotifyTime = 0;
  const attackFlashEl = document.getElementById('attack-flash');
  EventBus.on('unit:damaged', ({ entityId, x, z, isBuilding }) => {
    if (Owner.playerId[entityId] !== 0) return; // Only notify for local player
    const now = Date.now();
    if (now - lastAttackNotifyTime < 5000) return; // Throttle
    lastAttackNotifyTime = now;
    if (isBuilding) {
      selectionPanel.addMessage('Base under attack!', '#ff2222');
      minimapRenderer.flashPing(x, z, '#ff2222');
    } else {
      selectionPanel.addMessage('Units under attack!', '#ff6644');
    }
    audioManager.playSfx('underattack');
    // Pulse minimap border
    const minimapEl = document.getElementById('minimap-container');
    if (minimapEl) {
      minimapEl.classList.remove('under-attack');
      void minimapEl.offsetWidth; // Force reflow to restart animation
      minimapEl.classList.add('under-attack');
    }
    // Screen edge red flash
    if (attackFlashEl) {
      attackFlashEl.classList.remove('active');
      void attackFlashEl.offsetWidth;
      attackFlashEl.classList.add('active');
    }
  });

  // Rally point visuals
  EventBus.on('rally:set', ({ playerId, x, z }) => {
    effectsManager.setRallyPoint(playerId, x, z);
    if (playerId === 0) minimapRenderer.setRallyPoint(x, z);
    selectionPanel.addMessage('Rally point set', '#44ff44');
  });

  // Rally line: show dashed line from selected building to rally point
  EventBus.on('unit:selected', ({ entityIds }) => {
    const w = game.getWorld();
    if (!w) return;
    const rally = commandManager.getRallyPoint(0);
    if (!rally) { effectsManager.hideRallyLine(); return; }
    // Find first building in selection
    const bldg = entityIds.find(eid => hasComponent(w, BuildingType, eid) && Owner.playerId[eid] === 0);
    if (bldg !== undefined) {
      effectsManager.showRallyLine(Position.x[bldg], Position.z[bldg], rally.x, rally.z);
    } else {
      effectsManager.hideRallyLine();
    }
  });
  EventBus.on('unit:deselected', () => {
    effectsManager.hideRallyLine();
  });

  // Projectile visuals — color and speed vary by weapon type
  EventBus.on('combat:fire', ({ attackerX, attackerZ, targetX, targetZ, weaponType, attackerEntity, targetEntity }) => {
    let color = 0xffaa00; // Default orange
    let speed = 40;
    let style: 'bullet' | 'rocket' | 'laser' | 'flame' | 'mortar' = 'bullet';
    const wt = (weaponType ?? '').toLowerCase();
    if (wt.includes('rocket') || wt.includes('missile')) {
      color = 0xff4400; speed = 25; style = 'rocket';
    } else if (wt.includes('laser') || wt.includes('sonic')) {
      color = 0x00ffff; speed = 80; style = 'laser';
    } else if (wt.includes('flame')) {
      color = 0xff6600; speed = 20; style = 'flame';
    } else if (wt.includes('gun') || wt.includes('cannon') || wt.includes('machinegun')) {
      color = 0xffff44; speed = 60; style = 'bullet';
    } else if (wt.includes('mortar') || wt.includes('inkvine')) {
      color = 0x88ff44; speed = 15; style = 'mortar';
    }
    const attackerY = attackerEntity !== undefined ? (Position.y[attackerEntity] ?? 0) : 0;
    const targetY = targetEntity !== undefined ? (Position.y[targetEntity] ?? 0) : 0;
    effectsManager.spawnProjectile(attackerX, attackerY, attackerZ, targetX, targetY, targetZ, color, speed, undefined, style);

    // Decrement ammo for ornithopters/gunships
    if (attackerEntity !== undefined && aircraftAmmo.has(attackerEntity)) {
      const ammo = aircraftAmmo.get(attackerEntity)! - 1;
      aircraftAmmo.set(attackerEntity, Math.max(0, ammo));
      if (ammo <= 0 && !rearmingAircraft.has(attackerEntity)) {
        // Out of ammo — send to nearest landing pad
        const owner = Owner.playerId[attackerEntity];
        const pad = findNearestLandingPad(game.getWorld(), owner, attackerX, attackerZ);
        if (pad) {
          MoveTarget.x[attackerEntity] = pad.x;
          MoveTarget.z[attackerEntity] = pad.z;
          MoveTarget.active[attackerEntity] = 1;
          AttackTarget.active[attackerEntity] = 0;
          rearmingAircraft.add(attackerEntity);
          combatSystem.setSuppressed(attackerEntity, true);
          if (owner === 0) selectionPanel.addMessage('Aircraft returning to rearm', '#88aaff');
        } else {
          // No landing pad available — suppress combat so it stops firing at 0 ammo
          MoveTarget.active[attackerEntity] = 0;
          AttackTarget.active[attackerEntity] = 0;
          combatSystem.setSuppressed(attackerEntity, true);
          rearmingAircraft.add(attackerEntity);
        }
      }
    }

    // Deviator & contaminator abilities (delegated to AbilitySystem)
    if (attackerEntity !== undefined && targetEntity !== undefined) {
      abilitySystem.handleCombatHit(attackerEntity, targetEntity);
    }
  });

  // AoE blast visual effects — sized by blast radius
  EventBus.on('combat:blast', ({ x, z, radius }) => {
    const size: 'small' | 'medium' | 'large' = radius <= 2 ? 'small' : radius <= 5 ? 'medium' : 'large';
    effectsManager.spawnExplosion(x, 0, z, size);
  });

  EventBus.on('unit:move', ({ entityIds }) => {
    for (const eid of entityIds) {
      movement.clearPath(eid);
    }
  });

  // NIAB Tank teleport handling moved to AbilitySystem

  // Track credits spent on production
  EventBus.on('production:started', ({ unitType, owner }: { unitType: string; owner: number }) => {
    const def = gameRules.units.get(unitType) ?? gameRules.buildings.get(unitType);
    if (def) gameStats.recordCreditsSpent(owner, def.cost);
  });

  // Auto-spawn produced units
  EventBus.on('production:complete', ({ unitType, owner }) => {
    const world = game.getWorld();

    // Handle upgrade completions (unitType ends with " Upgrade")
    if (unitType.endsWith(' Upgrade')) {
      const baseName = unitType.replace(' Upgrade', '');
      if (owner === 0) {
        const displayName = baseName.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
        selectionPanel.addMessage(`${displayName} upgraded!`, '#ffcc00');
        audioManager.playSfx('build');
      }
      // Add glow effect to all buildings of this type owned by this player
      const buildings = buildingQuery(world);
      for (const bid of buildings) {
        if (Owner.playerId[bid] !== owner) continue;
        if (Health.current[bid] <= 0) continue;
        const bTypeId = BuildingType.id[bid];
        const bName = buildingTypeNames[bTypeId] ?? '';
        if (bName === baseName) {
          effectsManager.spawnExplosion(Position.x[bid], 1, Position.z[bid], 'medium');
          unitRenderer.markUpgraded(bid);
        }
      }
      return;
    }

    const isBuilding = gameRules.buildings.has(unitType);

    // Track stats
    if (isBuilding) gameStats.recordBuildingBuilt(owner);
    else gameStats.recordUnitBuilt(owner);

    // Notify player when their production completes
    if (owner === 0) {
      const displayName = unitType.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
      selectionPanel.addMessage(`${displayName} ready`, '#44ff44');
      audioManager.playSfx('select');
    }

    if (isBuilding) {
      // Start building placement mode for player buildings
      if (owner === 0) {
        const placeDef = gameRules.buildings.get(unitType);
        const fp = buildingFootprints.get(unitType) ?? { w: 3, h: 3 };
        buildingPlacement.startPlacement(unitType, fp.w, fp.h, placeDef?.terrain);
      } else {
        // AI strategically places buildings based on type
        const bDef = gameRules.buildings.get(unitType);
        const ownerAi = aiPlayers[owner - 1];
        if (bDef && ownerAi) {
          const pos = ownerAi.getNextBuildingPlacement(unitType, bDef);
          spawnBuilding(world, unitType, owner, pos.x, pos.z);
          movement.invalidateAllPaths(); // AI building placed
          // Spawn free unit for AI buildings (e.g. Harvester from Refinery)
          if (bDef.getUnitWhenBuilt) {
            spawnUnit(world, bDef.getUnitWhenBuilt, owner, pos.x + 3, pos.z + 3);
          }
        }
      }
    } else {
      // Check if this is a starportable unit arriving via Starport
      const uDef2 = gameRules.units.get(unitType);
      let fromStarport = false;
      let starportX = 0, starportZ = 0;

      // Spawn unit near appropriate building — find a barracks/factory owned by this player
      let baseX = 55, baseZ = 55;
      const spawnBuildings = buildingQuery(world);
      let found = false;

      // If starportable, try to spawn near the Starport first
      if (uDef2?.starportable) {
        for (const bid of spawnBuildings) {
          if (Owner.playerId[bid] !== owner) continue;
          if (Health.current[bid] <= 0) continue;
          const bName = buildingTypeNames[BuildingType.id[bid]] ?? '';
          if (bName.includes('Starport')) {
            baseX = Position.x[bid];
            baseZ = Position.z[bid];
            starportX = baseX;
            starportZ = baseZ;
            fromStarport = true;
            found = true;
            break;
          }
        }
      }

      if (!found) {
        for (const bid of spawnBuildings) {
          if (Owner.playerId[bid] !== owner) continue;
          if (Health.current[bid] <= 0) continue;
          const bTypeId = BuildingType.id[bid];
          const bName = buildingTypeNames[bTypeId] ?? '';
          if (bName.includes('Barracks') || bName.includes('Factory')) {
            baseX = Position.x[bid];
            baseZ = Position.z[bid];
            found = true;
            break;
          }
        }
      }
      if (!found) {
        // Fallback: use ConYard or any building
        for (const bid of spawnBuildings) {
          if (Owner.playerId[bid] !== owner) continue;
          if (Health.current[bid] <= 0) continue;
          baseX = Position.x[bid];
          baseZ = Position.z[bid];
          found = true;
          break;
        }
      }
      if (!found) {
        if (owner === 0) {
          baseX = 55;
          baseZ = 55;
        } else {
          const ownerAi = aiPlayers[owner - 1];
          const aiBase = ownerAi ? ownerAi.getBasePosition() : { x: 200, z: 200 };
          baseX = aiBase.x;
          baseZ = aiBase.z;
        }
      }
      const x = baseX! + (Math.random() - 0.5) * 10;
      const z = baseZ! + (Math.random() - 0.5) * 10;
      const eid = spawnUnit(world, unitType, owner, x, z);

      // Starport arrival: descent animation from above
      if (fromStarport && eid >= 0) {
        Position.y[eid] = 15; // Start high
        MoveTarget.active[eid] = 0; // Don't move during descent
        combatSystem.setSuppressed(eid, true);
        let frame = 0;
        const descend = () => {
          if (Health.current[eid] <= 0 || frame >= 30) {
            Position.y[eid] = terrain.getHeightAt(Position.x[eid], Position.z[eid]) + 0.1;
            combatSystem.setSuppressed(eid, false);
            return;
          }
          frame++;
          const groundY = terrain.getHeightAt(Position.x[eid], Position.z[eid]) + 0.1;
          Position.y[eid] = groundY + (15 - groundY) * (1 - frame / 30); // Descend to ground
          setTimeout(descend, 33); // ~30fps
        };
        descend();
        effectsManager.spawnExplosion(starportX, 8, starportZ, 'small');
        if (owner === 0) {
          audioManager.playSfx('build');
          selectionPanel.addMessage('Starport delivery arriving!', '#88aaff');
        }
      }

      // Atreides veterancy bonus: infantry from upgraded barracks start at rank 1
      if (eid >= 0) {
        const ownerPrefix = owner === 0 ? house.prefix : (opponents[owner - 1]?.prefix ?? house.enemyPrefix);
        if (ownerPrefix === 'AT') {
          const uDef = gameRules.units.get(unitType);
          if (uDef?.infantry && productionSystem.isUpgraded(owner, `${ownerPrefix}Barracks`)) {
            if (hasComponent(world, Veterancy, eid) && Veterancy.rank[eid] < 1) {
              combatSystem.addXp(eid, 1); // Applies rank + health bonus properly
            }
          }
        }
      }

      // Send to rally point if player has one set
      if (owner === 0 && eid >= 0) {
        const rally = commandManager.getRallyPoint(0);
        if (rally) {
          MoveTarget.x[eid] = rally.x;
          MoveTarget.z[eid] = rally.z;
          MoveTarget.active[eid] = 1;
        }
      }

      // Flash minimap ping at spawn location for player units
      if (owner === 0 && eid >= 0) {
        minimapRenderer.flashPing(Position.x[eid], Position.z[eid], '#44ff44');
      }

      // AI auto-deploys MCVs into ConYards
      if (owner !== 0 && eid >= 0 && unitType.endsWith('MCV')) {
        const prefix = unitType.substring(0, 2);
        const conYardName = `${prefix}ConYard`;
        if (gameRules.buildings.has(conYardName)) {
          // Deploy near current base with some offset
          const ownerAi = aiPlayers[owner - 1];
          const aiBase = ownerAi ? ownerAi.getBasePosition() : { x: 200, z: 200 };
          const deployX = aiBase.x + (Math.random() - 0.5) * 10;
          const deployZ = aiBase.z + (Math.random() - 0.5) * 10;
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
          spawnBuilding(world, conYardName, owner, deployX, deployZ);
          movement.invalidateAllPaths(); // MCV deployed
        }
      }
    }
  });

  // --- GAME TICK ---

  // UI elements for resource bar
  const powerEl = document.getElementById('power-status');
  const powerBarFill = document.getElementById('power-bar-fill');
  const unitCountEl = document.getElementById('unit-count');
  const unitBreakdownEl = document.getElementById('unit-breakdown');
  const commandModeEl = document.getElementById('command-mode');
  const lowPowerEl = document.getElementById('low-power-warning');
  const controlGroupsEl = document.getElementById('control-groups');
  const techLevelEl = document.getElementById('tech-level');
  const musicTrackEl = document.getElementById('music-track');
  const tooltipEl = document.getElementById('tooltip');

  // Objective display for campaign
  let objectiveEl: HTMLDivElement | null = null;
  let objectiveBarFillEl: HTMLDivElement | null = null;
  if (victorySystem.getObjectiveLabel()) {
    objectiveEl = document.createElement('div');
    objectiveEl.style.cssText = `
      position:fixed;top:36px;left:50%;transform:translateX(-50%);
      background:rgba(0,0,0,0.6);border:1px solid #555;padding:3px 16px;
      border-radius:3px;font-family:'Segoe UI',Tahoma,sans-serif;
      font-size:11px;color:#ff8;pointer-events:none;z-index:15;
    `;
    const objectiveTextNode = document.createElement('span');
    objectiveTextNode.textContent = `Objective: ${victorySystem.getObjectiveLabel()}`;
    objectiveEl.appendChild(objectiveTextNode);
    // Add progress bar for survival missions
    if (victorySystem.getObjectiveLabel().includes('Survive')) {
      const barContainer = document.createElement('div');
      barContainer.style.cssText = `margin-top:3px;height:4px;background:#222;border-radius:2px;overflow:hidden;`;
      objectiveBarFillEl = document.createElement('div');
      objectiveBarFillEl.style.cssText = `height:100%;width:0%;background:linear-gradient(90deg,#f44,#ff8,#4f4);transition:width 0.5s;`;
      barContainer.appendChild(objectiveBarFillEl);
      objectiveEl.appendChild(barContainer);
    }
    document.body.appendChild(objectiveEl);
  }

  // Crate/power-up state
  let nextCrateId = 0;
  const activeCrates = new Map<number, { x: number; z: number; type: string }>();

  // --- APC TRANSPORT SYSTEM (delegated to AbilitySystem) ---

  // --- AIRCRAFT AMMO/REARMING SYSTEM ---
  const MAX_AMMO = 6;
  const aircraftAmmo = new Map<number, number>(); // eid -> shots remaining
  const rearmingAircraft = new Set<number>(); // aircraft currently at a pad rearming

  // Wire rearm progress to UnitRenderer
  unitRenderer.setRearmProgressFn((eid: number) => {
    if (!rearmingAircraft.has(eid)) return null;
    const ammo = aircraftAmmo.get(eid) ?? 0;
    return ammo / MAX_AMMO;
  });

  // Wire aircraft ammo display to SelectionPanel
  selectionPanel.setAircraftAmmoFn((eid: number) => {
    if (!aircraftAmmo.has(eid)) return null;
    return { current: aircraftAmmo.get(eid)!, max: MAX_AMMO };
  });

  // Ability state maps moved to AbilitySystem

  function findNearestLandingPad(world: World, owner: number, fromX: number, fromZ: number): { eid: number; x: number; z: number } | null {
    const blds = buildingQuery(world);
    let best: { eid: number; x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (const bid of blds) {
      if (Owner.playerId[bid] !== owner || Health.current[bid] <= 0) continue;
      const bTypeId = BuildingType.id[bid];
      const bName = buildingTypeNames[bTypeId] ?? '';
      if (!bName.includes('Helipad') && !bName.includes('LandPad') && !bName.includes('Hanger')) continue;
      const dx = Position.x[bid] - fromX;
      const dz = Position.z[bid] - fromZ;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        best = { eid: bid, x: Position.x[bid], z: Position.z[bid] };
      }
    }
    return best;
  }

  // --- SUPERWEAPON SYSTEM (extracted to SuperweaponSystem module) ---
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

  EventBus.on('game:tick', () => {
    processedDeaths.clear();
    const world = game.getWorld();

    productionSystem.update();
    productionSystem.updateStarportPrices();

    // Continuous building repair (every 10 ticks = ~2.5x per second)
    if (game.getTickCount() % 10 === 0) {
      tickRepairs();
    }

    superweaponSystem.update(world, game.getTickCount());

    // Dust trails for moving ground units (every 3rd tick to limit particles)
    if (game.getTickCount() % 3 === 0) {
      const dustUnits = unitQuery(world);
      for (const eid of dustUnits) {
        if (Health.current[eid] <= 0) continue;
        if (MoveTarget.active[eid] !== 1) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def || def.canFly || def.infantry) continue; // Only ground vehicles
        effectsManager.spawnDustPuff(Position.x[eid], Position.z[eid]);
      }
    }

    unitRenderer.update(world);
    unitRenderer.tickConstruction();
    // Construction dust particles (every 4th tick for buildings under construction)
    if (game.getTickCount() % 4 === 0) {
      for (const [eid] of unitRenderer.getConstructingEntities()) {
        if (!hasComponent(world, Position, eid)) continue;
        const cx = Position.x[eid] + (Math.random() - 0.5) * 4;
        const cz = Position.z[eid] + (Math.random() - 0.5) * 4;
        effectsManager.spawnDustPuff(cx, cz);
      }
    }
    unitRenderer.tickDeconstruction();
    unitRenderer.tickDeathAnimations();
    // Check radar state: player needs an Outpost building for minimap
    if (game.getTickCount() % 50 === 0) {
      let hasOutpost = false;
      const blds = buildingQuery(world);
      for (const bid of blds) {
        if (Owner.playerId[bid] !== 0 || Health.current[bid] <= 0) continue;
        const bTypeId = BuildingType.id[bid];
        const bName = buildingTypeNames[bTypeId];
        const bDef = bName ? gameRules.buildings.get(bName) : null;
        if (bDef?.outpost) { hasOutpost = true; break; }
      }
      minimapRenderer.setRadarActive(hasOutpost);
    }
    minimapRenderer.update(world);
    effectsManager.update(40); // ~40ms per tick at 25 TPS
    effectsManager.updateWormVisuals(sandwormSystem.getWorms(), 40);
    // Flush pending spice visual changes from external sources (sandworms, etc.)
    if (game.getTickCount() % 50 === 0) terrain.flushSpiceVisuals();
    // Day/night cycle: update lighting every second
    if (game.getTickCount() % 25 === 0) scene.updateDayNightCycle(game.getTickCount());
    damageNumbers.update();
    // Clean up stale bloom markers (TTL: 300 ticks = 12 seconds)
    for (const [key, marker] of bloomMarkers) {
      marker.ticks++;
      if (marker.ticks > 300) {
        scene.scene.remove(marker.mesh);
        marker.mesh.geometry.dispose();
        (marker.mesh.material as THREE.Material).dispose();
        bloomMarkers.delete(key);
      }
    }
    fogOfWar.update(world);
    victorySystem.update(world);
    audioManager.updateIntensity();
    // Sync audio listener position to camera for positional audio
    const camPos = scene.getCameraTarget();
    audioManager.updateListenerPosition(camPos.x, camPos.z);
    // Update survival objective timer display + progress bar
    if (objectiveEl && victorySystem.getObjectiveLabel().includes('Survive')) {
      const progress = victorySystem.getSurvivalProgress();
      if (progress > 0 && progress < 1) {
        const remaining = Math.ceil((1 - progress) * 8 * 60); // 8 minute survival
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const textSpan = objectiveEl.querySelector('span');
        if (textSpan) textSpan.textContent = `Objective: Survive (${mins}:${secs.toString().padStart(2, '0')} remaining)`;
        objectiveEl.style.borderColor = progress > 0.7 ? '#4f4' : progress > 0.4 ? '#ff8' : '#f44';
        if (objectiveBarFillEl) objectiveBarFillEl.style.width = `${Math.round(progress * 100)}%`;
      }
    }
    commandManager.setWorld(world);
    commandManager.updateWaypoints();

    // Update waypoint path lines for selected units (every 10 ticks for perf)
    if (game.getTickCount() % 10 === 0) {
      const selected = selectionManager.getSelectedEntities();
      if (selected.length > 0 && selected.length <= 20) {
        const positions = new Map<number, { x: number; z: number }>();
        const moveTargets = new Map<number, { x: number; z: number; active: boolean }>();
        for (const eid of selected) {
          positions.set(eid, { x: Position.x[eid], z: Position.z[eid] });
          moveTargets.set(eid, { x: MoveTarget.x[eid], z: MoveTarget.z[eid], active: MoveTarget.active[eid] === 1 });
        }
        effectsManager.updateWaypointLines(
          selected, positions,
          commandManager.getWaypointQueues(),
          commandManager.getPatrolEntities(),
          moveTargets
        );
      } else {
        effectsManager.clearWaypointLines();
      }
    }

    // Spice shimmer particles over spice fields
    effectsManager.updateSpiceShimmer(terrain);

    buildingPlacement.updateOccupiedTiles(world);
    pathfinder.updateBlockedTiles(buildingPlacement.getOccupiedTiles());
    selectionPanel.setWorld(world);
    // Refresh selection panel periodically for dynamic info (upgrade progress, repair state)
    if (game.getTickCount() % 10 === 0) selectionPanel.refresh();

    // Command mode indicator (don't overwrite superweapon targeting)
    const mode = commandManager.getCommandMode();
    if (commandModeEl && !superweaponSystem.isTargeting) {
      if (mode === 'attack-move') {
        commandModeEl.style.display = 'block';
        commandModeEl.textContent = 'ATTACK-MOVE — Right-click destination';
      } else if (mode === 'patrol') {
        commandModeEl.style.display = 'block';
        commandModeEl.textContent = 'PATROL — Right-click destination';
      } else {
        commandModeEl.style.display = 'none';
      }
    }

    // Cursor state is handled by mousemove handler below

    // Update power and unit count every 25 ticks (~1 second)
    if (game.getTickCount() % 25 === 0) {
      let powerGen = 0;
      let powerUsed = 0;
      let unitCount = 0;

      const buildings = buildingQuery(world);
      for (const eid of buildings) {
        if (Owner.playerId[eid] !== 0) continue;
        if (Health.current[eid] <= 0) continue;
        if (hasComponent(world, PowerSource, eid)) {
          const amt = PowerSource.amount[eid];
          if (amt > 0) powerGen += amt;
          else powerUsed += Math.abs(amt);
        }
      }

      let idleHarvesters = 0;
      let combatCount = 0;
      let harvesterCount = 0;
      let aircraftCount = 0;
      const units = unitQuery(world);
      for (const eid of units) {
        if (Owner.playerId[eid] !== 0) continue;
        if (Health.current[eid] <= 0) continue;
        unitCount++;
        // Categorize units
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const uDef = typeName ? gameRules.units.get(typeName) : null;
        if (hasComponent(world, Harvester, eid)) {
          harvesterCount++;
          if (Harvester.state[eid] === 0 && MoveTarget.active[eid] === 0) idleHarvesters++;
        } else if (uDef?.canFly) {
          aircraftCount++;
        } else if (uDef && !uDef.engineer && !uDef.repair && !typeName?.includes('MCV')) {
          combatCount++;
        }
      }

      if (idleHarvesters > 0 && game.getTickCount() % 125 === 0) {
        selectionPanel.addMessage(`${idleHarvesters} harvester${idleHarvesters > 1 ? 's' : ''} idle`, '#ff8800');
      }

      if (powerEl) {
        powerEl.textContent = `${powerGen}/${powerUsed}`;
        const sufficient = powerGen >= powerUsed;
        powerEl.style.color = sufficient ? '#4f4' : '#f44';
        if (powerBarFill) {
          const ratio = powerUsed > 0 ? Math.min(1, powerGen / powerUsed) : 1;
          powerBarFill.style.width = `${ratio * 100}%`;
          powerBarFill.style.background = sufficient ? '#4f4' : ratio > 0.5 ? '#ff8800' : '#f44';
        }
      }
      if (unitCountEl) unitCountEl.textContent = `${unitCount}`;
      if (unitBreakdownEl) {
        const parts: string[] = [];
        if (combatCount > 0) parts.push(`${combatCount} combat`);
        if (harvesterCount > 0) parts.push(`${harvesterCount} harv`);
        if (aircraftCount > 0) parts.push(`${aircraftCount} air`);
        unitBreakdownEl.textContent = parts.length > 0 ? `(${parts.join(', ')})` : '';
      }
      // Tech level display
      if (techLevelEl) {
        const techLevel = productionSystem.getPlayerTechLevel(0);
        techLevelEl.textContent = `${techLevel}`;
        techLevelEl.style.color = techLevel >= 3 ? '#FFD700' : techLevel >= 2 ? '#8cf' : '#aaa';
      }

      // Control group badges (update every second)
      if (controlGroupsEl && game.getTickCount() % 25 === 0) {
        const groups = selectionManager.getControlGroups();
        let html = '';
        for (let i = 1; i <= 9; i++) {
          const grp = groups.get(i);
          if (grp && grp.length > 0) {
            const w = game.getWorld();
            const alive = grp.filter(eid => { try { return w && hasComponent(w, Health, eid) && Health.current[eid] > 0; } catch { return false; } });
            if (alive.length > 0) {
              html += `<span style="display:inline-block;min-width:18px;height:18px;line-height:18px;text-align:center;background:#1a1a3e;border:1px solid #555;border-radius:3px;font-size:10px;color:#aaa;cursor:pointer;" title="Group ${i}: ${alive.length} units" data-grp="${i}">${i}<sub style="font-size:8px;color:#888;">${alive.length}</sub></span>`;
            }
          }
        }
        controlGroupsEl.innerHTML = html;
      }

      // Power affects gameplay: slow production and turrets when in deficit
      const lowPower = powerGen < powerUsed;
      const powerMult = lowPower ? 0.5 : 1.0;
      if (lowPowerEl) lowPowerEl.style.display = lowPower ? 'block' : 'none';
      productionSystem.setPowerMultiplier(0, powerMult);
      combatSystem.setPowerMultiplier(0, powerMult);

      // Disable buildings with disableWithLowPower flag when in deficit (player 0)
      for (const eid of buildings) {
        if (Owner.playerId[eid] !== 0) continue;
        if (Health.current[eid] <= 0) continue;
        const typeId = BuildingType.id[eid];
        const bName = buildingTypeNames[typeId];
        const bDef = bName ? gameRules.buildings.get(bName) : null;
        if (bDef?.disableWithLowPower) {
          combatSystem.setDisabledBuilding(eid, lowPower);
          // Visual: use opacity to dim disabled buildings (preserves original colors)
          const obj = unitRenderer.getEntityObject(eid);
          if (obj) {
            obj.traverse(child => {
              if (child instanceof THREE.Mesh && child.material) {
                const mat = child.material as THREE.MeshStandardMaterial;
                mat.transparent = lowPower;
                mat.opacity = lowPower ? 0.4 : 1.0;
              }
            });
          }
        }
      }

      if (lowPower && powerUsed > 0 && game.getTickCount() % 250 === 0) {
        audioManager.playSfx('powerlow');
        audioManager.getDialogManager()?.trigger('lowPower');
        selectionPanel.addMessage('Low power! Build more Windtraps', '#ff4444');
      }

      // Music track display (update every second)
      if (musicTrackEl) {
        const trackName = audioManager.getCurrentTrackName();
        musicTrackEl.textContent = trackName ? `♪ ${trackName}` : '';
      }

      // Calculate real power for AI players (destroying windtraps matters)
      for (let ai = 1; ai < totalPlayers; ai++) {
        let aiPowerGen = 0;
        let aiPowerUsed = 0;
        for (const eid of buildings) {
          if (Owner.playerId[eid] !== ai) continue;
          if (Health.current[eid] <= 0) continue;
          if (hasComponent(world, PowerSource, eid)) {
            const amt = PowerSource.amount[eid];
            if (amt > 0) aiPowerGen += amt;
            else aiPowerUsed += Math.abs(amt);
          }
        }
        const aiLowPower = aiPowerGen < aiPowerUsed;
        const aiPowerMult = aiLowPower ? 0.5 : 1.0;
        productionSystem.setPowerMultiplier(ai, aiPowerMult);
        combatSystem.setPowerMultiplier(ai, aiPowerMult);

        // Disable AI buildings with disableWithLowPower flag
        for (const eid of buildings) {
          if (Owner.playerId[eid] !== ai) continue;
          if (Health.current[eid] <= 0) continue;
          const typeId = BuildingType.id[eid];
          const bName = buildingTypeNames[typeId];
          const bDef = bName ? gameRules.buildings.get(bName) : null;
          if (bDef?.disableWithLowPower) {
            combatSystem.setDisabledBuilding(eid, aiLowPower);
          }
        }
      }

      // Check for Hanger buildings (enables Carryall harvester airlift)
      const hasHanger = new Array(totalPlayers).fill(false);
      for (const eid of buildings) {
        if (Health.current[eid] <= 0) continue;
        const typeId = BuildingType.id[eid];
        const bName = buildingTypeNames[typeId] ?? '';
        if (bName.includes('Hanger')) {
          const o = Owner.playerId[eid];
          if (o < totalPlayers) hasHanger[o] = true;
        }
      }
      for (let i = 0; i < totalPlayers; i++) {
        harvestSystem.setCarryallAvailable(i, hasHanger[i]);
      }

      // Building damage visual states: smoke and fire based on HP + repair sparkles
      for (const eid of buildings) {
        if (Health.current[eid] <= 0) continue;
        const ratio = Health.max[eid] > 0 ? Health.current[eid] / Health.max[eid] : 1;
        // Green repair sparkles on buildings being repaired
        if (repairingBuildings.has(eid) && game.getTickCount() % 8 === 0) {
          const bx = Position.x[eid] + (Math.random() - 0.5) * 3;
          const bz = Position.z[eid] + (Math.random() - 0.5) * 3;
          effectsManager.spawnRepairSparkle(bx, 1 + Math.random() * 2, bz);
        }
        effectsManager.updateBuildingDamage(
          eid, Position.x[eid], Position.y[eid], Position.z[eid], ratio
        );
      }

      // Stealth visuals now handled by AbilitySystem.updateStealth()
    }

    // --- ABILITY SYSTEM UPDATE ---
    // Infantry crushing, engineer capture, saboteur, infiltrator, leech, projector,
    // kobra, NIAB cooldowns, passive repair, repair vehicles, faction bonuses, stealth
    abilitySystem.update(world, game.getTickCount());

    // Spice bloom visuals are now handled via HarvestSystem events (bloom:warning/tremor/eruption)

    // --- AIRCRAFT REARMING ---
    if (game.getTickCount() % 10 === 5 && rearmingAircraft.size > 0) {
      for (const eid of rearmingAircraft) {
        if (Health.current[eid] <= 0) { rearmingAircraft.delete(eid); aircraftAmmo.delete(eid); continue; }
        // Check if near any landing pad
        const owner = Owner.playerId[eid];
        const blds = buildingQuery(world);
        let nearPad = false;
        for (const bid of blds) {
          if (Owner.playerId[bid] !== owner || Health.current[bid] <= 0) continue;
          const bName = buildingTypeNames[BuildingType.id[bid]] ?? '';
          if (!bName.includes('Helipad') && !bName.includes('LandPad') && !bName.includes('Hanger')) continue;
          const dx = Position.x[eid] - Position.x[bid];
          const dz = Position.z[eid] - Position.z[bid];
          if (dx * dx + dz * dz < 25) { nearPad = true; break; } // Within 5 units
        }
        if (nearPad) {
          const ammo = (aircraftAmmo.get(eid) ?? 0) + 1;
          aircraftAmmo.set(eid, ammo);
          if (ammo >= MAX_AMMO) {
            rearmingAircraft.delete(eid);
            combatSystem.setSuppressed(eid, false);
            if (owner === 0) selectionPanel.addMessage('Aircraft rearmed', '#44ff44');
          }
        } else if (MoveTarget.active[eid] !== 1) {
          // Not near pad and not moving — try to find a pad to fly to
          const pad = findNearestLandingPad(world, owner, Position.x[eid], Position.z[eid]);
          if (pad) {
            MoveTarget.x[eid] = pad.x;
            MoveTarget.z[eid] = pad.z;
            MoveTarget.active[eid] = 1;
          }
        }
      }
    }

    // Crate drops: spawn a random crate every ~40 seconds
    if (game.getTickCount() % 1000 === 500 && activeCrates.size < 3) {
      const crateTypes = ['credits', 'veterancy', 'heal'];
      const type = crateTypes[Math.floor(Math.random() * crateTypes.length)];
      const cx = 20 + Math.random() * (terrain.getMapWidth() * 2 - 40);
      const cz = 20 + Math.random() * (terrain.getMapHeight() * 2 - 40);
      const crateId = nextCrateId++;
      activeCrates.set(crateId, { x: cx, z: cz, type });
      effectsManager.spawnCrate(crateId, cx, cz, type);
    }

    // Crate collection: check if any unit is near a crate (every 10 ticks)
    if (game.getTickCount() % 10 === 0 && activeCrates.size > 0) {
      const allUnits = unitQuery(world);
      for (const [crateId, crate] of activeCrates) {
        let collected = false;
        for (const eid of allUnits) {
          if (Health.current[eid] <= 0) continue;
          const dx = Position.x[eid] - crate.x;
          const dz = Position.z[eid] - crate.z;
          if (dx * dx + dz * dz < 4.0) { // Within 2 units
            const owner = Owner.playerId[eid];
            // Apply crate bonus
            if (crate.type === 'credits') {
              harvestSystem.addSolaris(owner, 500);
              if (owner === 0) selectionPanel.addMessage('+500 Solaris!', '#ffd700');
            } else if (crate.type === 'veterancy') {
              combatSystem.addXp(eid, 100);
              if (owner === 0) selectionPanel.addMessage('Unit experience boost!', '#44ff44');
            } else if (crate.type === 'heal') {
              // Heal all nearby friendly units
              for (const other of allUnits) {
                if (Owner.playerId[other] !== owner) continue;
                if (Health.current[other] <= 0) continue;
                const ox = Position.x[other] - crate.x;
                const oz = Position.z[other] - crate.z;
                if (ox * ox + oz * oz < 100) { // Within 10 units
                  Health.current[other] = Math.min(Health.max[other], Health.current[other] + Health.max[other] * 0.25);
                }
              }
              if (owner === 0) selectionPanel.addMessage('Area heal!', '#4488ff');
            }
            effectsManager.removeCrate(crateId);
            collected = true;
            break;
          }
        }
        if (collected) activeCrates.delete(crateId);
      }
    }

    // Sandstorm events: ~1% chance every 20 seconds, lasts 8 seconds
    if (game.getTickCount() % 500 === 0 && !effectsManager.isSandstormActive() && Math.random() < 0.01 * (game.getTickCount() / 2500 + 0.5)) {
      effectsManager.startSandstorm();
      selectionPanel.addMessage('Sandstorm approaching!', '#ff8844');
      // End storm after 200 ticks (8 seconds)
      const stormEnd = game.getTickCount() + 200;
      const stormDamage = () => {
        if (game.getTickCount() >= stormEnd) {
          effectsManager.stopSandstorm();
          selectionPanel.addMessage('Sandstorm subsided', '#aaa');
          EventBus.off('game:tick', stormDamage);
          return;
        }
        // Damage units and buildings on sand every 25 ticks during storm
        if (game.getTickCount() % 25 === 0) {
          const stormUnits = unitQuery(world);
          for (const eid of stormUnits) {
            if (Health.current[eid] <= 0) continue;
            const typeId = UnitType.id[eid];
            const tName = unitTypeNames[typeId];
            const uDef = tName ? gameRules.units.get(tName) : null;
            const dmg = uDef?.stormDamage ?? 5;
            if (dmg <= 0) continue;
            // Only damage units on sand terrain
            const tileX = Math.floor(Position.x[eid] / 2);
            const tileZ = Math.floor(Position.z[eid] / 2);
            const terrType = terrain.getTerrainType(tileX, tileZ);
            if (terrType === 0 || terrType === 4) { // Sand or Dunes
              Health.current[eid] = Math.max(0, Health.current[eid] - dmg);
              if (Health.current[eid] <= 0) {
                EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
              }
            }
          }
          // Buildings also take storm damage (per-building stormDamage from rules.txt)
          const stormBldgs = buildingQuery(world);
          for (const bid of stormBldgs) {
            if (Health.current[bid] <= 0) continue;
            const bTypeId = BuildingType.id[bid];
            const bName = buildingTypeNames[bTypeId];
            const bDef = bName ? gameRules.buildings.get(bName) : null;
            const bDmg = bDef?.stormDamage ?? 0;
            if (bDmg <= 0) continue;
            Health.current[bid] = Math.max(0, Health.current[bid] - bDmg);
            if (Health.current[bid] <= 0) {
              EventBus.emit('unit:died', { entityId: bid, killerEntity: -1 });
            }
          }
        }
      };
      EventBus.on('game:tick', stormDamage);
    }

    // Sample stats for post-game graphs every 250 ticks (~10 seconds)
    if (game.getTickCount() % 250 === 0) {
      const allU = unitQuery(world);
      const unitCounts = new Array(totalPlayers).fill(0);
      for (const uid of allU) {
        if (Health.current[uid] <= 0) continue;
        const o = Owner.playerId[uid];
        if (o < totalPlayers) unitCounts[o]++;
      }
      const credits = [];
      for (let i = 0; i < totalPlayers; i++) credits.push(harvestSystem.getSolaris(i));
      gameStats.sample(game.getTickCount(), credits, unitCounts);
    }

    // Autosave every 2 minutes (3000 ticks at 25 TPS)
    if (game.getTickCount() > 0 && game.getTickCount() % 3000 === 0 && victorySystem.getOutcome() === 'playing') {
      const autoSaveData = buildSaveData();
      localStorage.setItem('ebfd_autosave', JSON.stringify(autoSaveData));
      localStorage.setItem('ebfd_autosave_time', new Date().toLocaleString());
      selectionPanel.addMessage('Autosaved', '#888');
    }

    // Pause game on victory/defeat
    if (victorySystem.getOutcome() !== 'playing') {
      game.pause();
    }
  });

  // --- SIDEBAR ---

  const sidebar = new Sidebar(gameRules, productionSystem, artMap, (typeName, isBuilding) => {
    if (isBuilding) {
      // Start production, then placement on completion
      const def = gameRules.buildings.get(typeName);
      if (!def) return;
      if (!productionSystem.startProduction(0, typeName, true)) {
        audioManager.playSfx('error');
        selectionPanel.addMessage('Cannot build', '#ff4444');
        audioManager.getDialogManager()?.trigger('insufficientFunds');
        return;
      }
    } else {
      // Start unit production
      if (!productionSystem.startProduction(0, typeName, false)) {
        audioManager.playSfx('error');
        selectionPanel.addMessage('Cannot build', '#ff4444');
        audioManager.getDialogManager()?.trigger('insufficientFunds');
        return;
      }
    }
    sidebar.refresh();
  }, house.prefix, house.subhouse?.prefix ?? '');

  // Pass rendered 3D model icons to sidebar
  if (iconRenderer.getIcon('')) { /* noop, just check existence */ }
  const iconMap = new Map<string, string>();
  for (const name of [...allUnitNames, ...allBuildingNames]) {
    const art = artMap.get(name);
    const iconKey = art?.xaf ?? name;
    const url = iconRenderer.getIcon(iconKey);
    if (url) iconMap.set(iconKey, url);
  }
  if (iconMap.size > 0) sidebar.setIcons(iconMap);
  iconRenderer.dispose();

  // Concrete slab placement
  const CONCRETE_COST = 20;
  sidebar.setConcreteCallback(() => {
    buildingPlacement.startConcretePlacement((tx, tz) => {
      if (harvestSystem.getSolaris(0) < CONCRETE_COST) {
        selectionPanel.addMessage('Insufficient funds', '#ff4444');
        audioManager.getDialogManager()?.trigger('insufficientFunds');
        return false;
      }
      harvestSystem.spendSolaris(0, CONCRETE_COST);
      terrain.setTerrainType(tx, tz, 6); // TerrainType.ConcreteSlab
      terrain.updateSpiceVisuals();
      return true;
    });
  });

  setInterval(() => {
    sidebar.updateProgress();
    sidebar.refresh(); // Re-render to update buildable/unbuildable items
  }, 2000); // Refresh every 2 seconds
  setInterval(() => sidebar.updateProgress(), 200); // Progress bar updates faster

  // Help overlay toggle
  const helpOverlay = document.getElementById('help-overlay');

  // Camera bookmarks (F1-F4 recall, Ctrl+F1-F4 save)
  const cameraBookmarks = new Map<number, { x: number; z: number }>();

  // Event ring buffer for Space key cycling (last 5 events)
  type GameEvent = { x: number; z: number; type: string; time: number };
  const eventQueue: GameEvent[] = [];
  let eventCycleIdx = -1;
  function pushGameEvent(x: number, z: number, type: string): void {
    eventQueue.push({ x, z, type, time: Date.now() });
    if (eventQueue.length > 5) eventQueue.shift();
    eventCycleIdx = eventQueue.length - 1;
    updateEventQueueUI();
  }
  // Build the event queue widget (near minimap)
  const eventQueueEl = document.createElement('div');
  eventQueueEl.style.cssText = `
    position:fixed;bottom:10px;left:210px;
    font-family:'Segoe UI',Tahoma,sans-serif;font-size:10px;
    pointer-events:auto;z-index:15;display:flex;gap:3px;
  `;
  document.body.appendChild(eventQueueEl);
  function updateEventQueueUI(): void {
    eventQueueEl.innerHTML = '';
    for (let i = eventQueue.length - 1; i >= 0; i--) {
      const ev = eventQueue[i];
      const age = (Date.now() - ev.time) / 1000;
      if (age > 120) continue; // Only show events from last 2 minutes
      const iconMap: Record<string, string> = { attack: '\u2694', death: '\u2620', worm: '\ud83d\udc1b' };
      const colorMap: Record<string, string> = { attack: '#f44', death: '#f88', worm: '#f80' };
      const icon = iconMap[ev.type] ?? '\u26a0';
      const color = colorMap[ev.type] ?? '#aaa';
      const opacity = Math.max(0.4, 1 - age / 120);
      const btn = document.createElement('div');
      btn.style.cssText = `
        width:22px;height:22px;background:rgba(20,10,10,0.8);border:1px solid ${color};
        border-radius:3px;display:flex;align-items:center;justify-content:center;
        cursor:pointer;opacity:${opacity};font-size:12px;
      `;
      btn.title = `${ev.type} (${Math.round(age)}s ago) — click to jump`;
      btn.textContent = icon;
      const idx = i;
      btn.addEventListener('click', () => {
        eventCycleIdx = idx;
        scene.panTo(eventQueue[idx].x, eventQueue[idx].z);
      });
      eventQueueEl.appendChild(btn);
    }
  }
  // Refresh stale event age display every 10s
  setInterval(updateEventQueueUI, 10000);

  EventBus.on('unit:died', ({ entityId }) => {
    pushGameEvent(Position.x[entityId], Position.z[entityId], 'death');
  });
  EventBus.on('worm:emerge', ({ x, z }) => { pushGameEvent(x, z, 'worm'); });
  let lastAttackEventTime = 0;
  EventBus.on('unit:damaged', ({ entityId, x, z }) => {
    if (Owner.playerId[entityId] !== 0) return;
    const now = Date.now();
    if (now - lastAttackEventTime < 3000) return; // Throttle attack events to 3s
    lastAttackEventTime = now;
    pushGameEvent(x, z, 'attack');
  });

  const speedEl = document.getElementById('game-speed');
  function updateSpeedIndicator(speed: number): void {
    if (!speedEl) return;
    const label = speed <= 0.5 ? '0.5x' : speed >= 2.0 ? '2x' : '1x';
    const color = speed <= 0.5 ? '#88aaff' : speed >= 2.0 ? '#ff8844' : '#888';
    speedEl.textContent = label;
    speedEl.style.color = color;
  }

  // Contextual cursor — updates on mousemove with throttling
  const ATTACK_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='9' stroke='%23ff3333' stroke-width='2' fill='none'/%3E%3Cline x1='12' y1='3' x2='12' y2='7' stroke='%23ff3333' stroke-width='2'/%3E%3Cline x1='12' y1='17' x2='12' y2='21' stroke='%23ff3333' stroke-width='2'/%3E%3Cline x1='3' y1='12' x2='7' y2='12' stroke='%23ff3333' stroke-width='2'/%3E%3Cline x1='17' y1='12' x2='21' y2='12' stroke='%23ff3333' stroke-width='2'/%3E%3C/svg%3E") 12 12, crosshair`;
  const MOVE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M12 2 L17 8 L14 8 L14 14 L8 14 L8 8 L5 8 Z' fill='%2344ff44' stroke='%23000' stroke-width='1'/%3E%3C/svg%3E") 12 2, default`;
  let lastCursorUpdate = 0;
  let lastCursorStyle = '';
  let lastTooltipEid = -1;
  if (gameCanvas) {
    gameCanvas.addEventListener('mousemove', (e: MouseEvent) => {
      const now = performance.now();
      if (now - lastCursorUpdate < 80) return; // Throttle to ~12 fps
      lastCursorUpdate = now;

      const mode = commandManager.getCommandMode();
      if (mode === 'attack-move' || mode === 'patrol' || mode === 'teleport') {
        if (lastCursorStyle !== 'crosshair') {
          gameCanvas.style.cursor = 'crosshair';
          lastCursorStyle = 'crosshair';
        }
        if (tooltipEl) tooltipEl.style.display = 'none';
        lastTooltipEid = -1;
        return;
      }

      // In-game hover tooltip: show unit/building info on hover
      const hoverEid = unitRenderer.getEntityAtScreen(e.clientX, e.clientY);
      if (hoverEid !== null && tooltipEl) {
        const w = game.getWorld();
        if (!w || !hasComponent(w, Health, hoverEid)) {
          if (lastTooltipEid !== -1) { tooltipEl.style.display = 'none'; lastTooltipEid = -1; }
        } else {
          if (hoverEid !== lastTooltipEid) {
            lastTooltipEid = hoverEid;
            let name = '';
            let isBuilding = false;
            if (hasComponent(w, UnitType, hoverEid)) {
              const typeId = UnitType.id[hoverEid];
              name = unitTypeNames[typeId] ?? '';
            } else if (hasComponent(w, BuildingType, hoverEid)) {
              const typeId = BuildingType.id[hoverEid];
              name = buildingTypeNames[typeId] ?? '';
              isBuilding = true;
            }
            const displayName = name ? getDisplayName(name) : 'Unknown';
            const hp = Health.current[hoverEid];
            const maxHp = Health.max[hoverEid];
            const hpPct = maxHp > 0 ? Math.round((hp / maxHp) * 100) : 0;
            const hpColor = hpPct > 60 ? '#4f4' : hpPct > 30 ? '#ff8' : '#f44';
            const owner = Owner.playerId[hoverEid];
            const ownerLabel = owner === 0 ? 'You' : `Player ${owner}`;
            const rank = hasComponent(w, Veterancy, hoverEid) ? Veterancy.rank[hoverEid] : 0;
            const rankStr = rank > 0 ? ` ${'*'.repeat(rank)}` : '';
            tooltipEl.innerHTML = `<div style="font-weight:bold;color:#fff;">${displayName}${rankStr}</div>`
              + `<div style="color:${hpColor};">HP: ${Math.round(hp)}/${Math.round(maxHp)} (${hpPct}%)</div>`
              + `<div style="color:#aaa;font-size:10px;">${ownerLabel}${isBuilding ? ' | Building' : ''}</div>`;
            tooltipEl.style.display = 'block';
          }
          // Position tooltip near cursor, clamped to viewport
          const tx = Math.min(e.clientX + 16, window.innerWidth - 260);
          const ty = Math.max(10, Math.min(e.clientY - 10, window.innerHeight - 60));
          tooltipEl.style.left = `${tx}px`;
          tooltipEl.style.top = `${ty}px`;
        }
      } else {
        if (tooltipEl && lastTooltipEid !== -1) {
          tooltipEl.style.display = 'none';
          lastTooltipEid = -1;
        }
      }

      const selected = selectionManager.getSelectedEntities();
      if (selected.length === 0) {
        if (lastCursorStyle !== 'default') {
          gameCanvas.style.cursor = 'default';
          lastCursorStyle = 'default';
        }
        return;
      }

      // Cursor style based on hover context
      if (hoverEid !== null) {
        const hoverOwner = Owner.playerId[hoverEid];
        const selOwner = Owner.playerId[selected[0]];
        if (hoverOwner !== selOwner) {
          // Enemy — show attack cursor
          if (lastCursorStyle !== 'attack') {
            gameCanvas.style.cursor = ATTACK_CURSOR;
            lastCursorStyle = 'attack';
          }
        } else {
          // Friendly — show move cursor (escort)
          if (lastCursorStyle !== 'move') {
            gameCanvas.style.cursor = MOVE_CURSOR;
            lastCursorStyle = 'move';
          }
        }
      } else {
        // Terrain — show move cursor
        if (lastCursorStyle !== 'move') {
          gameCanvas.style.cursor = MOVE_CURSOR;
          lastCursorStyle = 'move';
        }
      }
    });
    // Hide tooltip when mouse leaves the canvas
    gameCanvas.addEventListener('mouseleave', () => {
      if (tooltipEl) tooltipEl.style.display = 'none';
      lastTooltipEid = -1;
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      if (helpOverlay) {
        helpOverlay.style.display = helpOverlay.style.display === 'none' ? 'block' : 'none';
      }
    } else if (e.key === 'Escape' && helpOverlay?.style.display === 'block') {
      helpOverlay.style.display = 'none';
    } else if (e.key === 'h' && !e.ctrlKey && !e.altKey) {
      // Snap to base (find player's ConYard)
      const w = game.getWorld();
      const blds = buildingQuery(w);
      let baseX = 50, baseZ = 50;
      for (const bid of blds) {
        if (Owner.playerId[bid] !== 0 || Health.current[bid] <= 0) continue;
        const bTypeId = BuildingType.id[bid];
        const bName = buildingTypeNames[bTypeId] ?? '';
        if (bName.includes('ConYard')) {
          baseX = Position.x[bid];
          baseZ = Position.z[bid];
          break;
        }
      }
      scene.panTo(baseX, baseZ);
    } else if (e.key === ' ' && !e.ctrlKey) {
      // Cycle through recent events (most recent first)
      // Skip if units are selected — SelectionManager handles Space for centering on selection
      e.preventDefault();
      if (selectionManager.getSelectedEntities().length > 0) {
        // Let SelectionManager's handler handle this
      } else if (eventQueue.length > 0) {
        if (eventCycleIdx < 0 || eventCycleIdx >= eventQueue.length) eventCycleIdx = eventQueue.length - 1;
        const ev = eventQueue[eventCycleIdx];
        scene.panTo(ev.x, ev.z);
        eventCycleIdx--;
        if (eventCycleIdx < 0) eventCycleIdx = eventQueue.length - 1;
      }
    } else if ('xdtluw'.includes(e.key) && !e.ctrlKey && !e.altKey) {
      // Ability key commands: X=self-destruct, D=deploy/MCV, T=teleport/projector,
      // L=load transport, U=unload transport, W=mount worm
      const selected = selectionManager.getSelectedEntities();
      const handled = abilitySystem.handleKeyCommand(e.key, selected, game.getWorld());
      // X key fallback: scatter if no ability consumed it
      if (!handled && e.key === 'x' && selected.length > 0) {
        commandManager.issueScatterCommand(selected);
      }
    } else if (e.key === 'F1' || e.key === 'F2' || e.key === 'F3' || e.key === 'F4') {
      e.preventDefault();
      const slot = parseInt(e.key.charAt(1)) - 1; // 0-3
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+F1-F4: Save camera bookmark
        const ct = scene.getCameraTarget();
        cameraBookmarks.set(slot, { x: ct.x, z: ct.z });
        selectionPanel.addMessage(`Camera ${slot + 1} saved`, '#88f');
      } else {
        // F1-F4: Recall camera bookmark
        const bm = cameraBookmarks.get(slot);
        if (bm) {
          scene.panTo(bm.x, bm.z);
          selectionPanel.addMessage(`Camera ${slot + 1}`, '#88f');
        } else {
          selectionPanel.addMessage(`Camera ${slot + 1} not set (Ctrl+F${slot + 1} to save)`, '#666');
        }
      }
    } else if (e.key === '-' || e.key === '_') {
      // Speed down
      const speeds = [0.5, 1.0, 2.0];
      const currentSpeed = game.getSpeed();
      const idx = speeds.findIndex(s => Math.abs(s - currentSpeed) < 0.01);
      const newSpeed = speeds[Math.max(0, (idx < 0 ? 1 : idx) - 1)];
      game.setSpeed(newSpeed);
      selectionPanel.addMessage(`Speed: ${newSpeed}x`, '#888');
      updateSpeedIndicator(newSpeed);
    } else if (e.key === '=' || e.key === '+') {
      // Speed up
      const speeds = [0.5, 1.0, 2.0];
      const currentSpeed = game.getSpeed();
      const idx = speeds.findIndex(s => Math.abs(s - currentSpeed) < 0.01);
      const newSpeed = speeds[Math.min(speeds.length - 1, (idx < 0 ? 1 : idx) + 1)];
      game.setSpeed(newSpeed);
      selectionPanel.addMessage(`Speed: ${newSpeed}x`, '#888');
      updateSpeedIndicator(newSpeed);
    } else if (e.key === 'F5') {
      e.preventDefault();
      saveGame();
    } else if (e.key === 'F8') {
      e.preventDefault();
      if (localStorage.getItem('ebfd_save')) {
        selectionPanel.addMessage('Loading saved game...', '#88f');
        localStorage.setItem('ebfd_load', '1');
        setTimeout(() => window.location.reload(), 300);
      } else {
        selectionPanel.addMessage('No saved game found', '#f44');
      }
    } else if (e.key === 'Escape' && !helpOverlay?.style.display?.includes('block')) {
      e.preventDefault();
      if (pauseMenu.isOpen) {
        pauseMenu.close();
        if (game.isPaused()) game.pause(); // Unpause
      } else {
        if (!game.isPaused()) game.pause();
        pauseMenu.show();
      }
    } else if (e.key === 'F9') {
      e.preventDefault();
      game.pause();
      selectionPanel.addMessage(game.isPaused() ? 'Game Paused' : 'Game Resumed', '#888');
    }
  });

  function buildSaveData(): SaveData {
    const w = game.getWorld();
    const entities: SavedEntity[] = [];

    // Save all units
    const allUnits = unitQuery(w);
    for (const eid of allUnits) {
      if (Health.current[eid] <= 0) continue;
      const se: SavedEntity = {
        x: Position.x[eid], z: Position.z[eid], y: Position.y[eid],
        rotY: Rotation.y[eid],
        hp: Health.current[eid], maxHp: Health.max[eid],
        owner: Owner.playerId[eid],
        unitTypeId: UnitType.id[eid],
        speed: { max: Speed.max[eid], turn: Speed.turnRate[eid] },
        vet: { xp: Veterancy.xp[eid], rank: Veterancy.rank[eid] },
      };
      if (MoveTarget.active[eid]) {
        se.moveTarget = { x: MoveTarget.x[eid], z: MoveTarget.z[eid], active: MoveTarget.active[eid] };
      }
      if (hasComponent(w, Harvester, eid)) {
        se.harvester = {
          spice: Harvester.spiceCarried[eid], maxCap: Harvester.maxCapacity[eid],
          state: Harvester.state[eid], refEid: 0,
        };
      }
      // Save aircraft ammo
      if (aircraftAmmo.has(eid)) {
        se.ammo = aircraftAmmo.get(eid);
      }
      // Save transport passengers (as type IDs for respawn on load)
      const passengers = abilitySystem.getTransportPassengers().get(eid);
      if (passengers && passengers.length > 0) {
        se.passengerTypeIds = passengers
          .filter(p => Health.current[p] > 0)
          .map(p => UnitType.id[p]);
      }
      // Save stance (skip default defensive=1)
      const stance = combatSystem.getStance(eid);
      if (stance !== 1) se.stance = stance;
      // Save guard position
      const gp = combatSystem.getGuardPosition(eid);
      if (gp) se.guardPos = { x: gp.x, z: gp.z };
      entities.push(se);
    }

    // Save all buildings
    const allBuildings = buildingQuery(w);
    for (const eid of allBuildings) {
      if (Health.current[eid] <= 0) continue;
      entities.push({
        x: Position.x[eid], z: Position.z[eid], y: Position.y[eid],
        rotY: Rotation.y[eid],
        hp: Health.current[eid], maxHp: Health.max[eid],
        owner: Owner.playerId[eid],
        buildingTypeId: BuildingType.id[eid],
      });
    }

    // Save spice map (use actual map dimensions)
    const spice: number[][] = [];
    const saveW = terrain.getMapWidth(), saveH = terrain.getMapHeight();
    for (let tz = 0; tz < saveH; tz++) {
      const row: number[] = [];
      for (let tx = 0; tx < saveW; tx++) {
        const s = terrain.getSpice(tx, tz);
        row.push(s > 0 ? Math.round(s * 100) / 100 : 0);
      }
      spice.push(row);
    }

    return {
      version: 1,
      tick: game.getTickCount(),
      housePrefix: house.prefix,
      enemyPrefix: house.enemyPrefix,
      houseName: house.name,
      enemyName: house.enemyName,
      solaris: Array.from({ length: totalPlayers }, (_, i) => harvestSystem.getSolaris(i)),
      entities,
      spice,
      production: productionSystem.getState(),
      fogExplored: fogOfWar.getExploredData(),
      superweaponCharge: superweaponSystem.getChargeState(),
      victoryTick: victorySystem.getTickCounter(),
    };
  }

  function saveGame(): void {
    const save = buildSaveData();
    try {
      localStorage.setItem('ebfd_save', JSON.stringify(save));
      localStorage.setItem('ebfd_save_time', new Date().toLocaleString());
      selectionPanel.addMessage('Game saved! (F8 to load)', '#44ff44');
    } catch {
      selectionPanel.addMessage('Save failed: storage full', '#ff4444');
    }
  }

  // Pause menu (extracted to PauseMenu module)
  const pauseMenu = new PauseMenu({
    audioManager,
    selectionPanel,
    gameRules,
    getTickCount: () => game.getTickCount(),
    setSpeed: (speed: number) => game.setSpeed(speed),
    pause: () => game.pause(),
    buildSaveData,
    setScrollSpeed: (m: number) => input.setScrollSpeed(m),
    setFogEnabled: (v: boolean) => fogOfWar.setEnabled(v),
    isFogEnabled: () => fogOfWar.isEnabled(),
    setDamageNumbers: (v: boolean) => damageNumbers.setEnabled(v),
    isDamageNumbers: () => damageNumbers.isEnabled(),
    setRangeCircles: (v: boolean) => unitRenderer.setRangeCircleEnabled(v),
    isRangeCircles: () => unitRenderer.isRangeCircleEnabled(),
  });

  // --- SPAWN INITIAL ENTITIES ---
  const world = game.getWorld();
  harvestSystem.setBuildingContext(world, buildingTypeNames);

  if (savedGame) {
    // --- RESTORE FROM SAVE ---
    game.setTickCount(savedGame.tick);
    for (let i = 0; i < savedGame.solaris.length; i++) {
      harvestSystem.addSolaris(i, savedGame.solaris[i] - harvestSystem.getSolaris(i));
    }

    // Restore spice (use actual map dimensions)
    const loadW = terrain.getMapWidth(), loadH = terrain.getMapHeight();
    for (let tz = 0; tz < savedGame.spice.length && tz < loadH; tz++) {
      for (let tx = 0; tx < savedGame.spice[tz].length && tx < loadW; tx++) {
        terrain.setSpice(tx, tz, savedGame.spice[tz][tx]);
      }
    }
    terrain.updateSpiceVisuals();

    // Restore entities - buildings first (so refineries exist for harvesters)
    for (const se of savedGame.entities) {
      if (se.buildingTypeId !== undefined) {
        const bName = buildingTypeNames[se.buildingTypeId];
        if (!bName) continue;
        const eid = spawnBuilding(world, bName, se.owner, se.x, se.z);
        if (eid >= 0) {
          Health.max[eid] = se.maxHp;
          Health.current[eid] = se.hp;
          Position.y[eid] = se.y;
          Rotation.y[eid] = se.rotY;
        }
      }
    }
    // Then units
    for (const se of savedGame.entities) {
      if (se.unitTypeId !== undefined) {
        const uName = unitTypeNames[se.unitTypeId];
        if (!uName) continue;
        const eid = spawnUnit(world, uName, se.owner, se.x, se.z);
        if (eid >= 0) {
          Health.max[eid] = se.maxHp;
          Health.current[eid] = se.hp;
          Position.y[eid] = se.y;
          Rotation.y[eid] = se.rotY;
          if (se.vet) {
            Veterancy.xp[eid] = se.vet.xp;
            Veterancy.rank[eid] = se.vet.rank;
          }
          if (se.moveTarget && se.moveTarget.active) {
            MoveTarget.x[eid] = se.moveTarget.x;
            MoveTarget.z[eid] = se.moveTarget.z;
            MoveTarget.active[eid] = se.moveTarget.active;
          }
          if (se.harvester && hasComponent(world, Harvester, eid)) {
            Harvester.spiceCarried[eid] = se.harvester.spice;
            Harvester.state[eid] = se.harvester.state;
          }
          // Restore aircraft ammo
          if (se.ammo !== undefined) {
            aircraftAmmo.set(eid, se.ammo);
          }
          // Restore transport passengers (spawn hidden infantry)
          if (se.passengerTypeIds && se.passengerTypeIds.length > 0) {
            const passengers: number[] = [];
            for (const pTypeId of se.passengerTypeIds) {
              const pName = unitTypeNames[pTypeId];
              if (!pName) continue;
              const pEid = spawnUnit(world, pName, se.owner, -999, -999);
              if (pEid >= 0) {
                Position.y[pEid] = -999;
                MoveTarget.active[pEid] = 0;
                AttackTarget.active[pEid] = 0;
                passengers.push(pEid);
              }
            }
            if (passengers.length > 0) abilitySystem.setTransportPassengers(eid, passengers);
          }
          // Restore stance and guard position
          if (se.stance !== undefined) combatSystem.setStance(eid, se.stance);
          if (se.guardPos) combatSystem.setGuardPosition(eid, se.guardPos.x, se.guardPos.z);
        }
      }
    }
    // Restore production queues and upgrade state
    if (savedGame.production) {
      productionSystem.restoreState(savedGame.production);
    }
    // Restore fog of war explored tiles
    if (savedGame.fogExplored) {
      fogOfWar.setExploredData(savedGame.fogExplored);
    }
    // Restore superweapon charge state
    if (savedGame.superweaponCharge) {
      superweaponSystem.setChargeState(savedGame.superweaponCharge);
    }
    // Restore victory system tick counter
    if (savedGame.victoryTick !== undefined) {
      victorySystem.setTickCounter(savedGame.victoryTick);
    }

    console.log(`Restored ${savedGame.entities.length} entities from save (tick ${savedGame.tick})`);
  } else {
    // --- FRESH GAME ---
    // Distribute spawn positions for all players
    const spawnPositions = getSpawnPositions(terrain.getMapWidth(), terrain.getMapHeight(), totalPlayers);
    const playerBase = spawnPositions[0];

    // Update all AI targets/bases to match spawn positions
    for (let i = 0; i < aiPlayers.length; i++) {
      const aiBase = spawnPositions[i + 1];
      aiPlayers[i].setBasePosition(aiBase.x, aiBase.z);
      aiPlayers[i].setTargetPosition(playerBase.x, playerBase.z);
    }

    // Player base
    const px = house.prefix;
    spawnBuilding(world, `${px}ConYard`, 0, playerBase.x, playerBase.z);
    spawnBuilding(world, `${px}SmWindtrap`, 0, playerBase.x + 6, playerBase.z);
    spawnBuilding(world, `${px}Barracks`, 0, playerBase.x - 6, playerBase.z);
    spawnBuilding(world, `${px}Factory`, 0, playerBase.x, playerBase.z + 6);
    spawnBuilding(world, `${px}Refinery`, 0, playerBase.x + 6, playerBase.z + 6);

    // Starting player units - find available unit types for the house
    const playerInfantry = [...gameRules.units.keys()].filter(n => n.startsWith(px) && gameRules.units.get(n)?.infantry);
    const playerVehicles = [...gameRules.units.keys()].filter(n => n.startsWith(px) && !gameRules.units.get(n)?.infantry && gameRules.units.get(n)!.cost > 0);

    // Spawn 3 infantry
    for (let i = 0; i < 3 && i < playerInfantry.length; i++) {
      spawnUnit(world, playerInfantry[i], 0, playerBase.x - 5 + i * 2, playerBase.z + 10);
    }
    // Spawn 4 vehicles
    for (let i = 0; i < 4 && i < playerVehicles.length; i++) {
      spawnUnit(world, playerVehicles[i], 0, playerBase.x + 3 + i * 2, playerBase.z + 12);
    }

    // Harvester — check faction-prefixed first, then generic "Harvester"
    const harvTypes = [...gameRules.units.keys()].filter(n =>
      (n.startsWith(px) || n === 'Harvester') && (n.includes('Harv') || n.includes('harvester'))
    );
    if (harvTypes.length > 0) {
      spawnUnit(world, harvTypes[0], 0, playerBase.x + 10, playerBase.z + 8);
    } else {
      // Fallback: make a trike into a harvester
      const fallbackVehicle = playerVehicles[0];
      if (fallbackVehicle) {
        const harvEid = spawnUnit(world, fallbackVehicle, 0, playerBase.x + 10, playerBase.z + 8);
        if (harvEid >= 0) {
          addComponent(world, Harvester, harvEid);
          Harvester.maxCapacity[harvEid] = 1.0;
          Harvester.spiceCarried[harvEid] = 0;
          Harvester.state[harvEid] = 0;
          Harvester.refineryEntity[harvEid] = 0;
        }
      }
    }

    // AI bases — spawn for each opponent
    for (let i = 0; i < opponents.length; i++) {
      const aiBase = spawnPositions[i + 1];
      const ex = opponents[i].prefix;
      const owner = i + 1;

      spawnBuilding(world, `${ex}ConYard`, owner, aiBase.x, aiBase.z);
      spawnBuilding(world, `${ex}SmWindtrap`, owner, aiBase.x + 6, aiBase.z);
      spawnBuilding(world, `${ex}Barracks`, owner, aiBase.x - 6, aiBase.z);
      spawnBuilding(world, `${ex}Factory`, owner, aiBase.x, aiBase.z + 6);
      spawnBuilding(world, `${ex}SmWindtrap`, owner, aiBase.x + 6, aiBase.z + 6);
      spawnBuilding(world, `${ex}Refinery`, owner, aiBase.x - 6, aiBase.z + 6);

      // Enemy starting units
      const enemyInfantry = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && gameRules.units.get(n)?.infantry);
      const enemyVehicles = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && !gameRules.units.get(n)?.infantry && gameRules.units.get(n)!.cost > 0 && !gameRules.units.get(n)!.canFly);

      for (let j = 0; j < 3 && j < enemyInfantry.length; j++) {
        spawnUnit(world, enemyInfantry[j], owner, aiBase.x - 5 + j * 2, aiBase.z + 10);
      }
      for (let j = 0; j < 3 && j < enemyVehicles.length; j++) {
        spawnUnit(world, enemyVehicles[j], owner, aiBase.x + 1 + j * 2, aiBase.z + 12);
      }

      // Enemy harvester — check faction-prefixed first, then generic "Harvester"
      const enemyHarvTypes = [...gameRules.units.keys()].filter(n =>
        (n.startsWith(ex) || n === 'Harvester') && (n.includes('Harv') || n.includes('harvester'))
      );
      if (enemyHarvTypes.length > 0) {
        spawnUnit(world, enemyHarvTypes[0], owner, aiBase.x - 5, aiBase.z + 12);
      }
    }

    // Camera starts at player base
    scene.cameraTarget.set(playerBase.x, 0, playerBase.z);
    scene.updateCameraPosition();
  }

  // --- DIALOG MANAGER WIRING ---
  // Wire up spoken advisor/mentat dialog lines to game events
  const dialogManager = audioManager.getDialogManager();
  if (dialogManager) {
    dialogManager.setPlayerFaction(house.prefix);
    dialogManager.wireEvents(0); // Human player is ID 0

    // Set up harvester detection for "harvester under attack" dialog
    dialogManager.setHarvesterChecker(
      (eid: number) => {
        try { return hasComponent(game.getWorld(), Harvester, eid); } catch { return false; }
      },
      0,
      (eid: number) => Owner.playerId[eid]
    );

    // Wire insufficient funds: trigger when production fails due to funds
    // (This is handled in sidebar callbacks, but we also hook power:update for low power)
  }

  // Start!
  game.start();
  // Hide loading screen
  updateLoading(100, 'Ready!');
  setTimeout(() => {
    const loadScreen = document.getElementById('loading-screen');
    if (loadScreen) {
      loadScreen.style.transition = 'opacity 0.5s';
      loadScreen.style.opacity = '0';
      setTimeout(() => loadScreen.remove(), 500);
    }
  }, 300);

  console.log('Game started - WASD to scroll, left-click to select, right-click to command');
  console.log('A: Attack-move | S: Stop | G: Guard | M: Mute music | Shift+click: Waypoints');

  // Debug helpers
  (window as any).game = game;
  (window as any).rules = gameRules;
  (window as any).fogOfWar = fogOfWar;
  (window as any).spawnUnit = (name: string, owner: number, x: number, z: number) => spawnUnit(game.getWorld(), name, owner, x, z);
  (window as any).spawnBuilding = (name: string, owner: number, x: number, z: number) => spawnBuilding(game.getWorld(), name, owner, x, z);
  (window as any).sandworm = sandwormSystem;

  // Enhanced debug namespace
  (window as any).debug = {
    modelReport() {
      const report = modelManager.getLoadReport();
      console.log(`%cModel Load Report`, 'font-size:14px;font-weight:bold;color:#0af');
      console.log(`  Loaded: ${report.loaded.length} | Failed: ${report.failed.length} | Total: ${report.total}`);
      if (report.failed.length > 0) {
        console.log('%cFailed models:', 'color:#f44;font-weight:bold');
        for (const name of report.failed) {
          const result = modelManager.getLoadResults().get(name);
          console.log(`  - ${name}: ${result?.error ?? 'unknown'}`);
        }
      }
      if (report.loaded.length > 0) {
        console.log('%cLoaded models:', 'color:#4f4');
        for (const name of report.loaded) {
          const result = modelManager.getLoadResults().get(name);
          console.log(`  + ${name} -> ${result?.url ?? '?'}`);
        }
      }
      return report;
    },

    artReport() {
      console.log(`%cArt Mapping Report`, 'font-size:14px;font-weight:bold;color:#fa0');
      const missing: string[] = [];
      const mapped: string[] = [];
      for (const [name] of gameRules.buildings) {
        const art = artMap.get(name);
        if (!art?.xaf) missing.push(name);
        else mapped.push(`${name} -> ${art.xaf}`);
      }
      for (const [name] of gameRules.units) {
        const art = artMap.get(name);
        if (!art?.xaf) missing.push(name);
        else mapped.push(`${name} -> ${art.xaf}`);
      }
      console.log(`  Mapped: ${mapped.length} | Missing xaf: ${missing.length}`);
      if (missing.length > 0) {
        console.log('%cMissing art mappings:', 'color:#f44');
        for (const name of missing) console.log(`  - ${name}`);
      }
      return { mapped: mapped.length, missing };
    },

    screenshot() {
      const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
      if (!canvas) { console.error('No canvas found'); return; }
      const link = document.createElement('a');
      link.download = `ebfd-screenshot-${Date.now()}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      console.log('Screenshot saved');
    },

    async evaluate() {
      try {
        const { runEvalChecklist } = await import('./debug/EvalChecklist');
        runEvalChecklist(modelManager, gameRules, artMap, productionSystem, unitRenderer);
      } catch (e) {
        console.warn('EvalChecklist module not available:', e);
      }
    },
  };
}

main().catch(console.error);
