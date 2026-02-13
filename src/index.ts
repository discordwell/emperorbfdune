import * as THREE from 'three';
import { Game } from './core/Game';
import { SceneManager } from './rendering/SceneManager';
import { TerrainRenderer, MAP_SIZE } from './rendering/TerrainRenderer';
import { InputManager } from './input/InputManager';
import { parseRules, type GameRules } from './config/RulesParser';
import { parseArtIni, type ArtEntry } from './config/ArtIniParser';
import { loadConstants, GameConstants } from './utils/Constants';
import { ModelManager } from './rendering/ModelManager';
import { UnitRenderer } from './rendering/UnitRenderer';
import { SelectionManager } from './input/SelectionManager';
import { CommandManager } from './input/CommandManager';
import { MovementSystem } from './simulation/MovementSystem';
import { PathfindingSystem } from './simulation/PathfindingSystem';
import { CombatSystem } from './simulation/CombatSystem';
import { HarvestSystem } from './simulation/HarvestSystem';
import { ProductionSystem } from './simulation/ProductionSystem';
import { Sidebar } from './ui/Sidebar';
import { MinimapRenderer } from './rendering/MinimapRenderer';
import { AIPlayer } from './ai/AIPlayer';
import { EventBus } from './core/EventBus';
import { AudioManager } from './audio/AudioManager';
import { FogOfWar } from './rendering/FogOfWar';
import { BuildingPlacement } from './input/BuildingPlacement';
import { VictorySystem, GameStats } from './ui/VictoryScreen';
import { HouseSelect, type HouseChoice, type SubhouseChoice, type Difficulty, type MapChoice, type GameMode, type SkirmishOptions } from './ui/HouseSelect';
import { CampaignMap } from './ui/CampaignMap';
import { SelectionPanel } from './ui/SelectionPanel';
import { EffectsManager } from './rendering/EffectsManager';
import { SandwormSystem } from './simulation/SandwormSystem';
import { showMissionBriefing } from './ui/MissionBriefing';
import {
  addEntity, addComponent, removeEntity, hasComponent,
  Position, Velocity, Rotation, Health, Owner, UnitType, Selectable,
  MoveTarget, AttackTarget, Combat, Armour, Speed, ViewRange, Renderable,
  Harvester, BuildingType, PowerSource, Veterancy,
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
}

interface SaveData {
  version: number;
  tick: number;
  housePrefix: string;
  enemyPrefix: string;
  houseName: string;
  enemyName: string;
  solaris: [number, number];
  entities: SavedEntity[];
  spice: number[][]; // [row][col]
}

// ID maps
const unitTypeIdMap = new Map<string, number>();
const unitTypeNames: string[] = [];
const buildingTypeIdMap = new Map<string, number>();
const buildingTypeNames: string[] = [];
const armourIdMap = new Map<string, number>();

function updateLoading(pct: number, text: string) {
  const bar = document.getElementById('loading-bar');
  const label = document.getElementById('loading-text');
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = text;
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

  // Check for saved game to load
  const shouldLoad = localStorage.getItem('ebfd_load') === '1';
  const savedJson = shouldLoad ? (localStorage.getItem('ebfd_load_data') ?? localStorage.getItem('ebfd_save')) : null;
  let savedGame: SaveData | null = null;
  if (savedJson) {
    try { savedGame = JSON.parse(savedJson); } catch { /* corrupted save */ }
  }
  localStorage.removeItem('ebfd_load');
  localStorage.removeItem('ebfd_load_data');

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
    const houseSelect = new HouseSelect(audioManager);
    house = await houseSelect.show();
  }

  console.log(`Playing as ${house.name} vs ${house.enemyName}`);
  audioManager.setPlayerFaction(house.prefix);

  // Show mission briefing for campaign mode
  if (house.gameMode === 'campaign' && house.campaignTerritoryId !== undefined && !savedGame) {
    const TERRITORY_DATA: Record<number, { name: string; description: string; difficulty: 'easy' | 'normal' | 'hard' }> = {
      0: { name: 'Carthag Basin', description: 'A wide desert basin near the Carthag spaceport. Light enemy presence.', difficulty: 'easy' },
      1: { name: 'Habbanya Ridge', description: 'Rocky ridge with scattered spice fields. Good defensive terrain.', difficulty: 'easy' },
      2: { name: 'Wind Pass', description: 'A narrow canyon pass battered by constant sandstorms.', difficulty: 'normal' },
      3: { name: 'Arrakeen Flats', description: 'Open desert near the capital. Rich spice deposits attract worms.', difficulty: 'normal' },
      4: { name: 'Sietch Tabr', description: 'Central crossroads territory. Controls access to the deep desert.', difficulty: 'normal' },
      5: { name: 'Shield Wall', description: 'Mountainous terrain near the Shield Wall. Heavily defended.', difficulty: 'normal' },
      6: { name: 'Spice Fields', description: 'The richest spice fields on Arrakis. A strategic prize.', difficulty: 'hard' },
      7: { name: 'Old Gap', description: 'Ancient rock formations hide enemy strongholds.', difficulty: 'hard' },
      8: { name: 'Enemy Capital', description: "The enemy's main base of operations. Final battle.", difficulty: 'hard' },
    };
    const tData = TERRITORY_DATA[house.campaignTerritoryId];
    if (tData) {
      const objectiveOverride = house.campaignTerritoryId === 3 ? 'Survive for 8 minutes against enemy assault' : undefined;
      await showMissionBriefing(
        { id: house.campaignTerritoryId, name: tData.name, description: tData.description, difficulty: tData.difficulty, x: 0, y: 0, adjacent: [], mapSeed: 0, owner: 'enemy' },
        house.name, house.prefix, house.enemyName, objectiveOverride
      );
    }
  }

  audioManager.startGameMusic();

  // Create game and systems
  const game = new Game();
  const scene = new SceneManager();
  const terrain = new TerrainRenderer(scene);
  const input = new InputManager(scene);
  const modelManager = new ModelManager();
  const unitRenderer = new UnitRenderer(scene, modelManager, artMap);
  const selectionManager = new SelectionManager(scene, unitRenderer);
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
  commandManager.setUnitClassifier(classifyUnit);

  const pathfinder = new PathfindingSystem(terrain);
  const movement = new MovementSystem(pathfinder);
  const combatSystem = new CombatSystem(gameRules);
  commandManager.setCombatSystem(combatSystem);
  const harvestSystem = new HarvestSystem(terrain);
  const productionSystem = new ProductionSystem(gameRules, harvestSystem);
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
  const fogOfWar = new FogOfWar(scene, 0);
  minimapRenderer.setFogOfWar(fogOfWar);
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
  combatSystem.setFogOfWar(fogOfWar, 0);
  combatSystem.setPlayerFaction(0, house.prefix);
  combatSystem.setPlayerFaction(1, house.enemyPrefix);

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
  const gameStats = new GameStats();
  const victorySystem = new VictorySystem(audioManager, 0);
  victorySystem.setStats(gameStats);
  victorySystem.setBuildingTypeNames(buildingTypeNames);
  if (house.skirmishOptions?.victoryCondition) {
    victorySystem.setVictoryCondition(house.skirmishOptions.victoryCondition);
  }

  // Campaign progress tracking
  if (house.gameMode === 'campaign' && house.campaignTerritoryId !== undefined) {
    // Territory-specific victory conditions
    const tId = house.campaignTerritoryId;
    if (tId <= 1) {
      // Easy territories: destroy conyard only
      victorySystem.setVictoryCondition('conyard');
      victorySystem.setObjectiveLabel('Destroy the enemy Construction Yard');
    } else if (tId === 3) {
      // Arrakeen Flats: survival mission - survive 8 minutes
      victorySystem.setVictoryCondition('survival');
      victorySystem.setSurvivalTicks(25 * 60 * 8); // 8 minutes
      victorySystem.setObjectiveLabel('Survive for 8 minutes');
    } else if (tId >= 7) {
      // Hard territories: total annihilation
      victorySystem.setVictoryCondition('annihilate');
      victorySystem.setObjectiveLabel('Destroy all enemy structures');
    } else {
      // Normal territories: destroy conyard
      victorySystem.setVictoryCondition('conyard');
      victorySystem.setObjectiveLabel('Destroy the enemy Construction Yard');
    }

    const campaign = new CampaignMap(audioManager, house.prefix, house.name, house.enemyPrefix, house.enemyName);
    victorySystem.setVictoryCallback(() => {
      campaign.recordVictory(house.campaignTerritoryId!);
    });
    victorySystem.setCampaignContinue(async () => {
      // Check if campaign is won (all territories captured)
      if (campaign.isVictory()) {
        // Show campaign victory message then return to menu
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
      // Show campaign map for next territory selection
      const choice = await campaign.show();
      if (choice) {
        // Save selected territory and reload to start new mission
        localStorage.setItem('ebfd_campaign_next', JSON.stringify({
          territoryId: choice.territory.id,
          difficulty: choice.difficulty,
          mapSeed: choice.mapSeed,
        }));
        window.location.reload();
      } else {
        window.location.reload(); // Back to main menu
      }
    });
  }

  const sandwormSystem = new SandwormSystem(terrain, effectsManager);

  // AI setup based on enemy faction
  const aiPlayer = new AIPlayer(gameRules, combatSystem, 1, 200, 200, 60, 60);
  // Override AI unit pool for the enemy faction
  aiPlayer.setUnitPool(house.enemyPrefix);
  aiPlayer.setDifficulty(house.difficulty ?? 'normal');
  // Give AI a random sub-house (different from player's if possible)
  const aiSubhousePrefixes = ['FR', 'IM', 'IX', 'TL', 'GU'];
  const playerSubPrefix = house.subhouse?.prefix ?? '';
  const available = aiSubhousePrefixes.filter(p => p !== playerSubPrefix);
  const aiSubPrefix = available[Math.floor(Math.random() * available.length)];
  aiPlayer.setSubhousePrefix(aiSubPrefix);
  console.log(`AI sub-house: ${aiSubPrefix}`);
  // Apply skirmish options
  if (house.skirmishOptions) {
    const opts = house.skirmishOptions;
    // Override starting credits (default is 5000 set in HarvestSystem.init)
    const extraCredits = opts.startingCredits - 5000;
    if (extraCredits !== 0) {
      harvestSystem.addSolaris(0, extraCredits);
      harvestSystem.addSolaris(1, extraCredits);
    }
    // Apply unit cap
    productionSystem.setMaxUnits(opts.unitCap);
  }

  // Hard difficulty: AI gets resource bonus
  if (house.difficulty === 'hard') {
    harvestSystem.addSolaris(1, 3000);
  }
  // Connect AI to production/economy systems
  aiPlayer.setProductionSystem(productionSystem, harvestSystem);
  aiPlayer.setBuildingTypeNames(buildingTypeNames);

  // Register systems
  game.addSystem(input);
  game.addSystem(movement);
  game.addSystem(combatSystem);
  game.addSystem(harvestSystem);
  game.addSystem(aiPlayer);
  game.addSystem(sandwormSystem);
  game.addRenderSystem(scene);

  // Initialize
  updateLoading(30, 'Initializing game systems...');
  game.init();
  updateLoading(40, 'Generating terrain...');
  if (house.mapChoice) {
    terrain.setMapSeed(house.mapChoice.seed);
  }
  await terrain.generate();

  // Preload all models
  updateLoading(50, 'Loading unit models...');
  const allUnitNames = [...gameRules.units.keys()];
  await unitRenderer.preloadModels(allUnitNames);
  updateLoading(75, 'Loading building models...');
  const allBuildingNames = [...gameRules.buildings.keys()];
  await unitRenderer.preloadBuildingModels(allBuildingNames);
  updateLoading(90, 'Spawning bases...');

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
    Position.y[eid] = 0.1;
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
    ViewRange.range[eid] = def.viewRange * 2;

    if (def.turretAttach) {
      addComponent(world, Combat, eid);
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
    Position.y[eid] = 0;
    Position.z[eid] = z;
    Rotation.y[eid] = 0;
    Health.current[eid] = def.health;
    Health.max[eid] = def.health;
    Owner.playerId[eid] = owner;
    BuildingType.id[eid] = buildingTypeIdMap.get(typeName) ?? 0;
    Renderable.modelId[eid] = 0;
    Renderable.sceneIndex[eid] = -1;
    Selectable.selected[eid] = 0;
    ViewRange.range[eid] = 16; // Buildings see 8 tiles

    if (def.powerGenerated > 0 || def.powerUsed > 0) {
      addComponent(world, PowerSource, eid);
      PowerSource.amount[eid] = def.powerGenerated - def.powerUsed;
    }

    if (def.turretAttach) {
      addComponent(world, Combat, eid);
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
    const refund = def ? Math.floor(def.cost * 0.5) : 0;

    harvestSystem.addSolaris(0, refund);
    selectionPanel.addMessage(`Sold for ${refund} Solaris`, '#f0c040');

    effectsManager.clearBuildingDamage(eid);

    // Clean up from production prerequisites and combat immediately
    if (typeName) {
      productionSystem.removePlayerBuilding(0, typeName);
    }
    combatSystem.unregisterUnit(eid);
    // Prevent combat targeting this building
    Health.current[eid] = 0;

    // Animate deconstruction over ~2 seconds (50 ticks), then remove
    unitRenderer.startDeconstruction(eid, 50, () => {
      effectsManager.spawnExplosion(Position.x[eid], Position.y[eid], Position.z[eid], 'small');
      try { removeEntity(world, eid); } catch {}
    });
  }

  function repairBuilding(eid: number): void {
    const world = game.getWorld();
    if (!hasComponent(world, BuildingType, eid)) return;
    if (Owner.playerId[eid] !== 0) return;

    const hp = Health.current[eid];
    const maxHp = Health.max[eid];
    if (hp >= maxHp) return;

    // Repair 10% per click, costs proportional
    const repairAmount = Math.min(maxHp * 0.1, maxHp - hp);
    const typeId = BuildingType.id[eid];
    const typeName = buildingTypeNames[typeId];
    const def = typeName ? gameRules.buildings.get(typeName) : null;
    const cost = def ? Math.floor(def.cost * 0.05) : 50;

    if (harvestSystem.spendSolaris(0, cost)) {
      Health.current[eid] += repairAmount;
      selectionPanel.addMessage(`Repaired for ${cost} Solaris`, '#44ff44');
    } else {
      audioManager.playSfx('error');
      selectionPanel.addMessage('Insufficient funds', '#ff4444');
    }
  }

  // --- BUILDING PLACEMENT ---

  const buildingPlacement = new BuildingPlacement(scene, terrain, audioManager, (typeName, x, z) => {
    const world = game.getWorld();
    // Cost already paid by ProductionSystem.startProduction() — just spawn
    const eid = spawnBuilding(world, typeName, 0, x, z);
    // Animate construction over ~3 seconds (75 ticks at 25 TPS)
    if (eid >= 0) {
      audioManager.playSfx('place');
      const def = gameRules.buildings.get(typeName);
      const duration = def ? Math.max(25, Math.floor(def.buildTime * 0.5)) : 75;
      unitRenderer.startConstruction(eid, duration);
    }
  });

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
  selectionPanel.setPassengerCountFn(getTransportPassengerCount);

  // --- AI SPAWN CALLBACK ---

  aiPlayer.setSpawnCallback((eid, typeName, owner, x, z) => {
    const world = game.getWorld();
    removeEntity(world, eid);
    spawnUnit(world, typeName, owner, x, z);
  });

  // --- EVENTS ---

  // Track harvest income
  EventBus.on('harvest:delivered', ({ amount, owner }) => {
    gameStats.recordCreditsEarned(owner, amount);
  });

  // Refund when player cancels building placement
  EventBus.on('placement:cancelled', ({ typeName }) => {
    const def = gameRules.buildings.get(typeName);
    if (def) {
      harvestSystem.addSolaris(0, def.cost);
      selectionPanel.addMessage('Building cancelled - refunded', '#f0c040');
    }
  });

  EventBus.on('unit:died', ({ entityId }) => {
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
    effectsManager.clearBuildingDamage(entityId);

    // Kill passengers if this was a transport
    killPassengers(entityId);
    // If this entity was a passenger, remove from its transport
    for (const [tid, passengers] of transportPassengers) {
      const idx = passengers.indexOf(entityId);
      if (idx >= 0) { passengers.splice(idx, 1); break; }
    }
    // Clean up aircraft ammo tracking
    aircraftAmmo.delete(entityId);
    rearmingAircraft.delete(entityId);
    // Clean up special ability tracking
    leechTargets.delete(entityId);
    projectorHolograms.delete(entityId);
    infiltratorRevealed.delete(entityId);
    // Kobra: restore base range on death (for ECS entity recycling safety)
    if (kobraDeployed.has(entityId)) {
      kobraDeployed.delete(entityId);
      kobraBaseRange.delete(entityId);
    }
    // NIAB: clear suppression on death
    if (niabCooldowns.has(entityId)) {
      niabCooldowns.delete(entityId);
      combatSystem.setSuppressed(entityId, false);
    }
    // Dismount worm if rider dies
    sandwormSystem.dismountWorm(entityId);
    // If this entity was being leeched, detach the leech(es)
    const leechesToDetach: number[] = [];
    for (const [leechEid, targetEid] of leechTargets) {
      if (targetEid === entityId) leechesToDetach.push(leechEid);
    }
    for (const leechEid of leechesToDetach) {
      leechTargets.delete(leechEid);
      combatSystem.setSuppressed(leechEid, false);
      Position.y[leechEid] = 0.1;
    }

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
    if (isBuilding) {
      EventBus.emit('building:destroyed', { entityId });
    }

    // Death animation: tilt the 3D model before removal
    const obj = unitRenderer.getEntityObject(entityId);
    if (obj && !isBuilding) {
      const tiltDir = Math.random() * Math.PI * 2;
      let frame = 0;
      const animateDeath = () => {
        if (!obj.parent || frame >= 8) return; // Stop if removed from scene
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
    // Visual effect at unit position
    effectsManager.spawnExplosion(Position.x[entityId], 0.5, Position.z[entityId], 'small');
  });

  // Sandworm events
  EventBus.on('worm:emerge', () => {
    selectionPanel.addMessage('Worm sign detected!', '#ff8800');
    audioManager.playSfx('worm');
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
    sceneManager.scene.add(mesh);
    bloomMarkers.set(`${x},${z}`, { mesh, ticks: 0 });
  });
  EventBus.on('bloom:tremor', ({ x, z, intensity }) => {
    // Spawn small dust particles at bloom site
    effectsManager.spawnExplosion(x + (Math.random() - 0.5) * 4, 0, z + (Math.random() - 0.5) * 4, 'small');
    // Pulse the bloom marker
    const key = `${x},${z}`;
    const marker = bloomMarkers.get(key);
    if (marker) {
      (marker.mesh.material as THREE.MeshBasicMaterial).opacity = 0.3 + intensity * 0.5;
      const scale = 1.0 + intensity * 0.5;
      marker.mesh.scale.set(scale, scale, scale);
    }
  });
  EventBus.on('bloom:eruption', ({ x, z }) => {
    effectsManager.spawnExplosion(x, 0.5, z, 'large');
    selectionPanel.addMessage('Spice bloom detected!', '#ff8800');
    audioManager.playSfx('worm'); // Rumble sound
    terrain.updateSpiceVisuals();
    // Remove bloom marker
    const key = `${x},${z}`;
    const marker = bloomMarkers.get(key);
    if (marker) {
      sceneManager.scene.remove(marker.mesh);
      marker.mesh.geometry.dispose();
      (marker.mesh.material as THREE.Material).dispose();
      bloomMarkers.delete(key);
    }
  });

  // Under-attack notifications (throttled to once per 5 seconds)
  let lastAttackNotifyTime = 0;
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
  });

  // Rally point visuals
  EventBus.on('rally:set', ({ playerId, x, z }) => {
    effectsManager.setRallyPoint(playerId, x, z);
    if (playerId === 0) minimapRenderer.setRallyPoint(x, z);
    selectionPanel.addMessage('Rally point set', '#44ff44');
  });

  // Projectile visuals — color and speed vary by weapon type
  // Deviator conversion tracking: entityId -> { originalOwner, revertTick }
  const deviatedUnits = new Map<number, { originalOwner: number; revertTick: number }>();

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
    effectsManager.spawnProjectile(attackerX, 0, attackerZ, targetX, 0, targetZ, color, speed, undefined, style);

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
        }
      }
    }

    // Deviator conversion: if attacker is a deviator, convert target temporarily
    if (attackerEntity !== undefined && targetEntity !== undefined) {
      const atTypeId = UnitType.id[attackerEntity];
      const atName = unitTypeNames[atTypeId];
      const atDef = atName ? gameRules.units.get(atName) : null;
      if (atDef?.deviator && Health.current[targetEntity] > 0) {
        const tgtDef = unitTypeNames[UnitType.id[targetEntity]] ? gameRules.units.get(unitTypeNames[UnitType.id[targetEntity]]) : null;
        if (tgtDef?.canBeDeviated !== false) {
          const attackerOwner = Owner.playerId[attackerEntity];
          const originalOwner = Owner.playerId[targetEntity];
          if (originalOwner !== attackerOwner) {
            // Store original owner for revert
            if (!deviatedUnits.has(targetEntity)) {
              deviatedUnits.set(targetEntity, { originalOwner, revertTick: game.getTickCount() + 400 });
            }
            Owner.playerId[targetEntity] = attackerOwner;
            if (attackerOwner === 0) selectionPanel.addMessage('Unit deviated!', '#cc44ff');
            else if (originalOwner === 0) selectionPanel.addMessage('Unit mind-controlled!', '#ff4444');
          }
        }
      }

      // Contaminator replication: Contaminator kills infantry and spawns a new Contaminator
      const atName2 = unitTypeNames[UnitType.id[attackerEntity]];
      if (atName2?.includes('Contaminator')) {
        const tgtTypeId = UnitType.id[targetEntity];
        const tgtName = unitTypeNames[tgtTypeId];
        const tgtDef = tgtName ? gameRules.units.get(tgtName) : null;
        if (tgtDef?.infantry && Health.current[targetEntity] > 0) {
          const attackerOwner = Owner.playerId[attackerEntity];
          const tgtOwner = Owner.playerId[targetEntity];
          if (tgtOwner !== attackerOwner) {
            // Kill the target
            Health.current[targetEntity] = 0;
            EventBus.emit('unit:died', { entityId: targetEntity, killerEntity: attackerEntity });
            // Spawn a new Contaminator at the target's position
            const cx = Position.x[targetEntity];
            const cz = Position.z[targetEntity];
            spawnUnit(game.getWorld(), atName2, attackerOwner, cx, cz);
            if (attackerOwner === 0) selectionPanel.addMessage('Infantry contaminated!', '#88ff44');
            else if (tgtOwner === 0) selectionPanel.addMessage('Unit contaminated by enemy!', '#ff4444');
          }
        }
      }
    }
  });

  EventBus.on('unit:move', ({ entityIds }) => {
    for (const eid of entityIds) {
      movement.clearPath(eid);
    }
  });

  // NIAB Tank teleport: handle target selection
  EventBus.on('teleport:target', ({ x, z }: { x: number; z: number }) => {
    const selected = selectionManager.getSelectedEntities();
    const w = game.getWorld();
    for (const eid of selected) {
      if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
      const typeName = unitTypeNames[UnitType.id[eid]];
      const def = typeName ? gameRules.units.get(typeName) : null;
      if (!def?.niabTank) continue;
      if (niabCooldowns.has(eid)) continue;

      // Teleport!
      effectsManager.spawnExplosion(Position.x[eid], 0, Position.z[eid], 'small');
      Position.x[eid] = x;
      Position.z[eid] = z;
      Position.y[eid] = 0.1;
      MoveTarget.active[eid] = 0;
      effectsManager.spawnExplosion(x, 0, z, 'small');
      audioManager.playSfx('explosion');
      // Cooldown (suppress combat during sleep time)
      const sleepTime = def.teleportSleepTime || 93;
      niabCooldowns.set(eid, sleepTime);
      combatSystem.setSuppressed(eid, true);
      selectionPanel.addMessage('NIAB teleported!', '#88aaff');
      break; // Only teleport first selected NIAB
    }
  });

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
        buildingPlacement.startPlacement(unitType);
      } else {
        // AI auto-places buildings near base
        const aiBase = aiPlayer.getBasePosition();
        const x = aiBase.x + (Math.random() - 0.5) * 20;
        const z = aiBase.z + (Math.random() - 0.5) * 20;
        spawnBuilding(world, unitType, owner, x, z);
      }
    } else {
      // Check if this is a starportable unit arriving via Starport
      const uDef2 = gameRules.units.get(unitType);
      let fromStarport = false;
      let starportX = 0, starportZ = 0;

      // Spawn unit near appropriate building — find a barracks/factory owned by this player
      let baseX: number, baseZ: number;
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
        const aiBase = aiPlayer.getBasePosition();
        baseX = owner === 0 ? 55 : aiBase.x;
        baseZ = owner === 0 ? 55 : aiBase.z;
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
            Position.y[eid] = 0.1;
            combatSystem.setSuppressed(eid, false);
            return;
          }
          frame++;
          Position.y[eid] = 15 * (1 - frame / 30); // Linear descent over 30 frames
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
        const ownerPrefix = owner === 0 ? house.prefix : house.enemyPrefix;
        if (ownerPrefix === 'AT') {
          const uDef = gameRules.units.get(unitType);
          if (uDef?.infantry && productionSystem.isUpgraded(owner, `${ownerPrefix}Barracks`)) {
            if (hasComponent(world, Veterancy, eid) && Veterancy.rank[eid] < 1) {
              Veterancy.rank[eid] = 1;
              Veterancy.xp[eid] = 1;
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

      // AI auto-deploys MCVs into ConYards
      if (owner !== 0 && eid >= 0 && unitType === 'MCV') {
        const prefix = unitType.substring(0, 2);
        const conYardName = `${prefix}ConYard`;
        if (gameRules.buildings.has(conYardName)) {
          // Deploy near current base with some offset
          const aiBase = aiPlayer.getBasePosition();
          const deployX = aiBase.x + (Math.random() - 0.5) * 10;
          const deployZ = aiBase.z + (Math.random() - 0.5) * 10;
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
          spawnBuilding(world, conYardName, owner, deployX, deployZ);
        }
      }
    }
  });

  // --- GAME TICK ---

  // UI elements for resource bar
  const powerEl = document.getElementById('power-status');
  const powerBarFill = document.getElementById('power-bar-fill');
  const unitCountEl = document.getElementById('unit-count');
  const commandModeEl = document.getElementById('command-mode');
  const lowPowerEl = document.getElementById('low-power-warning');

  // Objective display for campaign
  let objectiveEl: HTMLDivElement | null = null;
  if (victorySystem.getObjectiveLabel()) {
    objectiveEl = document.createElement('div');
    objectiveEl.style.cssText = `
      position:fixed;top:36px;left:50%;transform:translateX(-50%);
      background:rgba(0,0,0,0.6);border:1px solid #555;padding:3px 16px;
      border-radius:3px;font-family:'Segoe UI',Tahoma,sans-serif;
      font-size:11px;color:#ff8;pointer-events:none;z-index:15;
    `;
    objectiveEl.textContent = `Objective: ${victorySystem.getObjectiveLabel()}`;
    document.body.appendChild(objectiveEl);
  }

  // Crate/power-up state
  let nextCrateId = 0;
  const activeCrates = new Map<number, { x: number; z: number; type: string }>();

  // --- APC TRANSPORT SYSTEM ---
  // Maps transport entity -> array of passenger entity IDs
  const transportPassengers = new Map<number, number[]>();

  function loadIntoTransport(transportEid: number, infantryEid: number): boolean {
    const typeName = unitTypeNames[UnitType.id[transportEid]];
    const def = typeName ? gameRules.units.get(typeName) : null;
    if (!def?.apc) return false;
    const passengers = transportPassengers.get(transportEid) ?? [];
    if (passengers.length >= def.passengerCapacity) return false;
    // Only infantry can board
    const infTypeName = unitTypeNames[UnitType.id[infantryEid]];
    const infDef = infTypeName ? gameRules.units.get(infTypeName) : null;
    if (!infDef?.infantry) return false;
    // Must be same owner
    if (Owner.playerId[infantryEid] !== Owner.playerId[transportEid]) return false;

    passengers.push(infantryEid);
    transportPassengers.set(transportEid, passengers);
    // Hide the passenger: move off-map, stop movement
    Position.x[infantryEid] = -999;
    Position.z[infantryEid] = -999;
    Position.y[infantryEid] = -999;
    MoveTarget.active[infantryEid] = 0;
    AttackTarget.active[infantryEid] = 0;
    return true;
  }

  function unloadTransport(transportEid: number): number {
    const passengers = transportPassengers.get(transportEid);
    if (!passengers || passengers.length === 0) return 0;
    const tx = Position.x[transportEid];
    const tz = Position.z[transportEid];
    let unloaded = 0;
    for (let i = 0; i < passengers.length; i++) {
      const pEid = passengers[i];
      if (Health.current[pEid] <= 0) continue;
      // Place in a circle around the transport
      const angle = (i / passengers.length) * Math.PI * 2;
      Position.x[pEid] = tx + Math.cos(angle) * 3;
      Position.z[pEid] = tz + Math.sin(angle) * 3;
      Position.y[pEid] = 0.1;
      MoveTarget.active[pEid] = 0;
      unloaded++;
    }
    transportPassengers.delete(transportEid);
    return unloaded;
  }

  function killPassengers(transportEid: number): void {
    const passengers = transportPassengers.get(transportEid);
    if (!passengers) return;
    const world = game.getWorld();
    for (const pEid of passengers) {
      if (Health.current[pEid] <= 0) continue;
      Health.current[pEid] = 0;
      EventBus.emit('unit:died', { entityId: pEid, killerEntity: -1 });
    }
    transportPassengers.delete(transportEid);
  }

  function getTransportPassengerCount(transportEid: number): number {
    return transportPassengers.get(transportEid)?.length ?? 0;
  }

  // --- AIRCRAFT AMMO/REARMING SYSTEM ---
  const MAX_AMMO = 6;
  const aircraftAmmo = new Map<number, number>(); // eid -> shots remaining
  const rearmingAircraft = new Set<number>(); // aircraft currently at a pad rearming

  // Leech parasitization: leechEid -> targetVehicleEid
  const leechTargets = new Map<number, number>();
  // Projector holograms: hologramEid -> ticksRemaining
  const projectorHolograms = new Map<number, number>();
  // Kobra deployed units (immobilized, doubled range)
  const kobraDeployed = new Set<number>();
  const kobraBaseRange = new Map<number, number>(); // eid -> original combat range
  // NIAB Tank teleport cooldowns: eid -> ticksRemaining
  const niabCooldowns = new Map<number, number>();
  // Infiltrator reveal persistence: eid -> tick when reveal expires
  const infiltratorRevealed = new Map<number, number>();

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

  // --- SUPERWEAPON SYSTEM ---
  // Palace type -> superweapon config
  const SUPERWEAPON_CONFIG: Record<string, { name: string; chargeTime: number; radius: number; damage: number; style: 'missile' | 'airstrike' | 'lightning' }> = {
    'HKPalace': { name: 'Death Hand Missile', chargeTime: 5184, radius: 15, damage: 800, style: 'missile' },
    'ATPalace': { name: 'Hawk Strike', chargeTime: 4536, radius: 10, damage: 500, style: 'airstrike' },
    'ORPalace': { name: 'Chaos Lightning', chargeTime: 6220, radius: 12, damage: 600, style: 'lightning' },
    'GUPalace': { name: 'Guild NIAB Strike', chargeTime: 5500, radius: 10, damage: 700, style: 'lightning' },
  };
  // Per-player superweapon state
  const superweaponState = new Map<number, { palaceType: string; charge: number; ready: boolean }>();
  let superweaponTargetMode = false;

  // Superweapon UI button (bottom of sidebar area)
  const swButton = document.createElement('div');
  swButton.id = 'superweapon-btn';
  swButton.style.cssText = `
    position:absolute;bottom:8px;right:8px;width:184px;height:36px;
    background:linear-gradient(180deg,#2a1a1a,#1a0a0a);border:1px solid #555;
    border-radius:4px;display:none;align-items:center;justify-content:center;
    font-family:'Segoe UI',Tahoma,sans-serif;font-size:12px;color:#f88;
    cursor:pointer;pointer-events:auto;z-index:15;text-align:center;
    user-select:none;transition:background 0.3s,border-color 0.3s;
  `;
  document.getElementById('sidebar')?.appendChild(swButton);

  // Superweapon charge bar on the button
  const swChargeBar = document.createElement('div');
  swChargeBar.style.cssText = `
    position:absolute;bottom:0;left:0;height:3px;width:0%;
    background:linear-gradient(90deg,#f44,#ff8800);border-radius:0 0 3px 3px;
    transition:width 0.5s;
  `;
  swButton.appendChild(swChargeBar);

  const swLabel = document.createElement('span');
  swLabel.style.cssText = 'position:relative;z-index:1;';
  swButton.appendChild(swLabel);

  swButton.addEventListener('click', () => {
    const sw = superweaponState.get(0);
    if (!sw || !sw.ready) return;
    superweaponTargetMode = true;
    const cmdMode = document.getElementById('command-mode');
    if (cmdMode) {
      cmdMode.style.display = 'block';
      cmdMode.textContent = `${SUPERWEAPON_CONFIG[sw.palaceType]?.name ?? 'Superweapon'} - Click to target`;
      cmdMode.style.background = 'rgba(200,0,0,0.85)';
    }
  });

  // Listen for targeting click when superweapon is active
  window.addEventListener('mousedown', (e) => {
    if (!superweaponTargetMode || e.button !== 0) return;
    // Don't fire on UI areas
    if (e.clientY < 32 || e.clientX > window.innerWidth - 200) return;
    if (e.clientX < 200 && e.clientY > window.innerHeight - 200) return;

    superweaponTargetMode = false;
    const cmdMode = document.getElementById('command-mode');
    if (cmdMode) cmdMode.style.display = 'none';

    // Raycast to get world position
    const worldPos = scene.screenToWorld(e.clientX, e.clientY);
    if (worldPos) {
      fireSuperweapon(0, worldPos.x, worldPos.z);
    }
  });

  // Cancel superweapon targeting on Escape
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && superweaponTargetMode) {
      superweaponTargetMode = false;
      const cmdMode = document.getElementById('command-mode');
      if (cmdMode) cmdMode.style.display = 'none';
      e.stopPropagation();
    }
  }, true);

  function fireSuperweapon(playerId: number, targetX: number, targetZ: number): void {
    const sw = superweaponState.get(playerId);
    if (!sw || !sw.ready) return;

    const config = SUPERWEAPON_CONFIG[sw.palaceType];
    if (!config) return;

    // Reset charge
    sw.charge = 0;
    sw.ready = false;

    EventBus.emit('superweapon:fired', { owner: playerId, type: sw.palaceType, x: targetX, z: targetZ });

    // Visual effects based on style
    if (config.style === 'missile') {
      // Death Hand: large explosion cascade
      effectsManager.spawnExplosion(targetX, 0, targetZ, 'large');
      setTimeout(() => effectsManager.spawnExplosion(targetX + 3, 0, targetZ + 2, 'large'), 100);
      setTimeout(() => effectsManager.spawnExplosion(targetX - 2, 0, targetZ - 3, 'large'), 200);
      setTimeout(() => effectsManager.spawnExplosion(targetX + 1, 0, targetZ + 4, 'large'), 300);
      setTimeout(() => effectsManager.spawnExplosion(targetX - 3, 0, targetZ + 1, 'large'), 400);
    } else if (config.style === 'airstrike') {
      // Hawk Strike: line of explosions
      for (let i = -3; i <= 3; i++) {
        const delay = (i + 3) * 120;
        const ox = targetX + i * 2 + (Math.random() - 0.5) * 2;
        const oz = targetZ + (Math.random() - 0.5) * 3;
        setTimeout(() => effectsManager.spawnExplosion(ox, 0, oz, 'medium'), delay);
      }
    } else if (config.style === 'lightning') {
      // Chaos Lightning: rapid chain of small explosions
      for (let i = 0; i < 8; i++) {
        const delay = i * 80;
        const angle = (i / 8) * Math.PI * 2;
        const dist = 2 + Math.random() * (config.radius * 0.5);
        const ox = targetX + Math.cos(angle) * dist;
        const oz = targetZ + Math.sin(angle) * dist;
        setTimeout(() => effectsManager.spawnExplosion(ox, 0, oz, 'small'), delay);
      }
      // Central flash
      setTimeout(() => effectsManager.spawnExplosion(targetX, 0, targetZ, 'large'), 200);
    }

    audioManager.playSfx('superweaponLaunch');
    scene.shake(config.style === 'missile' ? 1.0 : 0.6); // Camera shake!

    // Apply damage to all entities in radius
    const w = game.getWorld();
    const allUnits = unitQuery(w);
    const allBuildings = buildingQuery(w);
    const targets = [...allUnits, ...allBuildings];
    for (const eid of targets) {
      if (Health.current[eid] <= 0) continue;
      const dx = Position.x[eid] - targetX;
      const dz = Position.z[eid] - targetZ;
      const dist2 = dx * dx + dz * dz;
      const r2 = config.radius * config.radius;
      if (dist2 < r2) {
        const dist = Math.sqrt(dist2);
        const dmg = Math.floor(config.damage * (1 - dist / config.radius));
        Health.current[eid] = Math.max(0, Health.current[eid] - dmg);
        if (Health.current[eid] <= 0) {
          if (hasComponent(w, BuildingType, eid)) {
            EventBus.emit('building:destroyed', { entityId: eid });
          }
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
        }
      }
    }

    // Messages
    if (playerId === 0) {
      selectionPanel.addMessage(`${config.name} launched!`, '#ff4444');
    } else {
      selectionPanel.addMessage(`Enemy ${config.name} incoming!`, '#ff4444');
      minimapRenderer.flashPing(targetX, targetZ, '#ff0000');
    }
  }

  EventBus.on('game:tick', () => {
    const world = game.getWorld();

    productionSystem.update();
    productionSystem.updateStarportPrices();

    // --- Superweapon charge ---
    if (game.getTickCount() % 25 === 0) { // Check every second
      for (let pid = 0; pid <= 1; pid++) {
        // Check if player owns a Palace
        const blds = buildingQuery(world);
        let palaceType: string | null = null;
        for (const bid of blds) {
          if (Owner.playerId[bid] !== pid || Health.current[bid] <= 0) continue;
          const bTypeId = BuildingType.id[bid];
          const bName = buildingTypeNames[bTypeId] ?? '';
          if (SUPERWEAPON_CONFIG[bName]) {
            palaceType = bName;
            break;
          }
        }

        if (palaceType) {
          if (!superweaponState.has(pid)) {
            superweaponState.set(pid, { palaceType, charge: 0, ready: false });
          }
          const sw = superweaponState.get(pid)!;
          sw.palaceType = palaceType;
          const config = SUPERWEAPON_CONFIG[palaceType];
          if (!sw.ready) {
            const mult = productionSystem.getPowerMultiplier(pid);
            sw.charge += 25 * mult; // 25 ticks per check
            if (sw.charge >= config.chargeTime) {
              sw.charge = config.chargeTime;
              sw.ready = true;
              EventBus.emit('superweapon:ready', { owner: pid, type: palaceType });
              audioManager.playSfx('superweaponReady');
              if (pid === 0) {
                selectionPanel.addMessage(`${config.name} ready!`, '#ff8800');
              } else {
                selectionPanel.addMessage(`Warning: Enemy superweapon detected!`, '#ff4444');
              }
            }
          }
        } else {
          superweaponState.delete(pid);
        }
      }

      // Update UI button for player
      const sw = superweaponState.get(0);
      if (sw) {
        swButton.style.display = 'flex';
        const config = SUPERWEAPON_CONFIG[sw.palaceType];
        const pct = Math.min(100, (sw.charge / (config?.chargeTime ?? 1)) * 100);
        swChargeBar.style.width = `${pct}%`;
        if (sw.ready) {
          swLabel.textContent = `${config?.name ?? 'Superweapon'} - READY`;
          swLabel.style.color = '#ff4444';
          swButton.style.borderColor = '#f44';
          swButton.style.cursor = 'pointer';
          swChargeBar.style.background = '#f44';
        } else {
          swLabel.textContent = `${config?.name ?? 'Charging...'} ${Math.floor(pct)}%`;
          swLabel.style.color = '#f88';
          swButton.style.borderColor = '#555';
          swButton.style.cursor = 'default';
        }
      } else {
        swButton.style.display = 'none';
      }

      // AI fires superweapon at player base when ready
      const aiSw = superweaponState.get(1);
      if (aiSw?.ready) {
        // Target player's building cluster
        const playerBlds = buildingQuery(world);
        let bestX = 100, bestZ = 100, bestCount = 0;
        for (const bid of playerBlds) {
          if (Owner.playerId[bid] !== 0 || Health.current[bid] <= 0) continue;
          const bx = Position.x[bid], bz = Position.z[bid];
          let count = 0;
          for (const bid2 of playerBlds) {
            if (Owner.playerId[bid2] !== 0 || Health.current[bid2] <= 0) continue;
            const dx = Position.x[bid2] - bx, dz = Position.z[bid2] - bz;
            if (dx * dx + dz * dz < 225) count++; // 15 unit radius
          }
          if (count > bestCount) { bestCount = count; bestX = bx; bestZ = bz; }
        }
        if (bestCount > 0) {
          // Add some inaccuracy
          bestX += (Math.random() - 0.5) * 6;
          bestZ += (Math.random() - 0.5) * 6;
          fireSuperweapon(1, bestX, bestZ);
        }
      }
    }

    // Revert deviated units when timer expires
    if (game.getTickCount() % 25 === 0 && deviatedUnits.size > 0) {
      const tick = game.getTickCount();
      for (const [eid, info] of deviatedUnits) {
        if (tick >= info.revertTick || Health.current[eid] <= 0) {
          if (Health.current[eid] > 0) {
            Owner.playerId[eid] = info.originalOwner;
          }
          deviatedUnits.delete(eid);
        }
      }
    }

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
    unitRenderer.tickDeconstruction();
    unitRenderer.tickDeathAnimations();
    minimapRenderer.update(world);
    effectsManager.update(40); // ~40ms per tick at 25 TPS
    effectsManager.updateWormVisuals(sandwormSystem.getWorms(), 40);
    fogOfWar.update(world);
    victorySystem.update(world);
    audioManager.updateIntensity();
    // Update survival objective timer display
    if (objectiveEl && victorySystem.getObjectiveLabel().includes('Survive')) {
      const progress = victorySystem.getSurvivalProgress();
      if (progress > 0 && progress < 1) {
        const remaining = Math.ceil((1 - progress) * 8 * 60); // 8 minute survival
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        objectiveEl.textContent = `Objective: Survive (${mins}:${secs.toString().padStart(2, '0')} remaining)`;
        objectiveEl.style.borderColor = progress > 0.7 ? '#4f4' : progress > 0.4 ? '#ff8' : '#f44';
      }
    }
    commandManager.setWorld(world);
    commandManager.updateWaypoints();
    buildingPlacement.updateOccupiedTiles(world);
    pathfinder.updateBlockedTiles(buildingPlacement.getOccupiedTiles());
    selectionPanel.setWorld(world);

    // Command mode indicator
    const mode = commandManager.getCommandMode();
    if (commandModeEl) {
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

    // Update cursor based on context
    const canvas = document.getElementById('game-canvas');
    if (canvas) {
      if (mode === 'attack-move') {
        canvas.style.cursor = 'crosshair';
      } else if (mode === 'patrol') {
        canvas.style.cursor = 'crosshair';
      } else if (selectionManager.getSelectedEntities().length > 0) {
        canvas.style.cursor = 'default';
      } else {
        canvas.style.cursor = 'default';
      }
    }

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
      const units = unitQuery(world);
      for (const eid of units) {
        if (Owner.playerId[eid] !== 0) continue;
        if (Health.current[eid] <= 0) continue;
        unitCount++;
        // Check for idle harvesters (state=0 idle, not moving)
        if (hasComponent(world, Harvester, eid) && Harvester.state[eid] === 0 && MoveTarget.active[eid] === 0) {
          idleHarvesters++;
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

      // Power affects gameplay: slow production and turrets when in deficit
      const lowPower = powerGen < powerUsed;
      const powerMult = lowPower ? 0.5 : 1.0;
      if (lowPowerEl) lowPowerEl.style.display = lowPower ? 'block' : 'none';
      productionSystem.setPowerMultiplier(0, powerMult);
      combatSystem.setPowerMultiplier(0, powerMult);

      // Disable buildings with disableWithLowPower flag when in deficit
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
              const mat = (child as any).material;
              if (mat) {
                mat.transparent = lowPower;
                mat.opacity = lowPower ? 0.4 : 1.0;
              }
            });
          }
        }
      }

      if (lowPower && powerUsed > 0 && game.getTickCount() % 250 === 0) {
        audioManager.playSfx('powerlow');
        selectionPanel.addMessage('Low power! Build more Windtraps', '#ff4444');
      }

      // AI always gets full power (simplification - AI builds enough windtraps)
      productionSystem.setPowerMultiplier(1, 1.0);
      combatSystem.setPowerMultiplier(1, 1.0);

      // Check for Hanger buildings (enables Carryall harvester airlift)
      const hasHanger = [false, false];
      for (const eid of buildings) {
        if (Health.current[eid] <= 0) continue;
        const typeId = BuildingType.id[eid];
        const bName = buildingTypeNames[typeId] ?? '';
        if (bName.includes('Hanger')) {
          hasHanger[Owner.playerId[eid]] = true;
        }
      }
      harvestSystem.setCarryallAvailable(0, hasHanger[0]);
      harvestSystem.setCarryallAvailable(1, hasHanger[1]);

      // Building damage visual states: smoke and fire based on HP
      for (const eid of buildings) {
        if (Health.current[eid] <= 0) continue;
        const ratio = Health.current[eid] / Health.max[eid];
        effectsManager.updateBuildingDamage(
          eid, Position.x[eid], Position.y[eid], Position.z[eid], ratio
        );
      }

      // Stealth visuals: stealthed units become transparent when idle
      // Clean up expired infiltrator reveals
      const currentTick = game.getTickCount();
      for (const [revEid, expireTick] of infiltratorRevealed) {
        if (currentTick >= expireTick || Health.current[revEid] <= 0) {
          infiltratorRevealed.delete(revEid);
        }
      }
      for (const eid of units) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def?.stealth) continue;
        // Don't re-stealth if revealed by infiltrator
        const isRevealed = infiltratorRevealed.has(eid);
        const isIdle = MoveTarget.active[eid] === 0;
        const shouldStealth = isIdle && !isRevealed;
        combatSystem.setStealthed(eid, shouldStealth);
        const obj = unitRenderer.getEntityObject(eid);
        if (obj) {
          const targetAlpha = shouldStealth ? (Owner.playerId[eid] === 0 ? 0.3 : 0.0) : 1.0;
          obj.traverse(child => {
            const mat = (child as any).material;
            if (mat) {
              mat.transparent = true;
              mat.opacity = targetAlpha;
            }
          });
        }
      }
    }

    // Infantry crushing: vehicles crush infantry they overlap (every 10 ticks)
    if (game.getTickCount() % 10 === 0) {
      const allUnits = unitQuery(world);
      // Pre-filter: collect moving crushers and crushable infantry separately
      const crushers: number[] = [];
      const crushable: number[] = [];
      for (const eid of allUnits) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def) continue;
        if (def.crushes && MoveTarget.active[eid] === 1) crushers.push(eid);
        if (def.crushable) crushable.push(eid);
      }
      // Only do O(crushers * crushable) check, typically much smaller than O(n^2)
      for (const eid of crushers) {
        const px = Position.x[eid], pz = Position.z[eid];
        const owner = Owner.playerId[eid];
        for (const other of crushable) {
          if (Health.current[other] <= 0) continue;
          if (Owner.playerId[other] === owner) continue;
          const dx = px - Position.x[other];
          const dz = pz - Position.z[other];
          if (dx * dx + dz * dz < 2.0) {
            Health.current[other] = 0;
            EventBus.emit('unit:died', { entityId: other, killerEntity: eid });
          }
        }
      }
    }

    // Engineer building capture: engineers capture enemy buildings on contact (every 10 ticks)
    if (game.getTickCount() % 10 === 5) {
      const allUnits = unitQuery(world);
      const allBuildings = buildingQuery(world);
      for (const eid of allUnits) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def || !def.engineer) continue;
        if (MoveTarget.active[eid] !== 1) continue; // Only capture while moving (toward target)

        const engOwner = Owner.playerId[eid];

        for (const bid of allBuildings) {
          if (Health.current[bid] <= 0) continue;
          if (Owner.playerId[bid] === engOwner) continue; // Skip friendly buildings
          const bTypeId = BuildingType.id[bid];
          const bName = buildingTypeNames[bTypeId];
          const bDef = bName ? gameRules.buildings.get(bName) : null;
          if (bDef && !bDef.canBeEngineered) continue; // Building can't be captured

          const dx = Position.x[eid] - Position.x[bid];
          const dz = Position.z[eid] - Position.z[bid];
          if (dx * dx + dz * dz < 6.0) { // Within ~2.4 units
            // Capture: transfer ownership
            const prevOwner = Owner.playerId[bid];
            Owner.playerId[bid] = engOwner;
            productionSystem.removePlayerBuilding(prevOwner, bName ?? '');
            productionSystem.addPlayerBuilding(engOwner, bName ?? '');

            // Engineer is consumed
            Health.current[eid] = 0;
            EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });

            if (engOwner === 0) {
              selectionPanel.addMessage(`Captured ${(bName ?? '').replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '')}!`, '#44ff44');
            } else if (prevOwner === 0) {
              selectionPanel.addMessage('Building captured by enemy!', '#ff4444');
            }
            break; // Engineer consumed, stop checking
          }
        }
      }
    }

    // Saboteur auto-suicide: saboteurs destroy enemy buildings on contact (same tick as engineer check)
    if (game.getTickCount() % 10 === 5) {
      const sabUnits = unitQuery(world);
      const sabBlds = buildingQuery(world);
      for (const eid of sabUnits) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def?.saboteur) continue;

        const sabOwner = Owner.playerId[eid];
        for (const bid of sabBlds) {
          if (Health.current[bid] <= 0) continue;
          if (Owner.playerId[bid] === sabOwner) continue;
          const dx = Position.x[eid] - Position.x[bid];
          const dz = Position.z[eid] - Position.z[bid];
          if (dx * dx + dz * dz < 9.0) { // Within 3 units
            // Massive damage to the building (usually kills it)
            const dmg = Math.max(Health.max[bid] * 0.8, 2000);
            Health.current[bid] = Math.max(0, Health.current[bid] - dmg);
            // Explosion effects
            effectsManager.spawnExplosion(Position.x[bid], 0, Position.z[bid], 'large');
            audioManager.playSfx('explosion');
            scene.shake(0.5);
            if (Health.current[bid] <= 0) {
              EventBus.emit('unit:died', { entityId: bid, killerEntity: eid });
            }
            // Saboteur is consumed
            Health.current[eid] = 0;
            EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
            if (sabOwner === 0) selectionPanel.addMessage('Saboteur detonated!', '#ff8800');
            else if (Owner.playerId[bid] === 0) selectionPanel.addMessage('Saboteur attack on base!', '#ff4444');
            break;
          }
        }
      }
    }

    // Infiltrator: reveals stealthed enemies within blast radius, then suicide-attacks building
    if (game.getTickCount() % 10 === 5) {
      const infUnits = unitQuery(world);
      const infBlds = buildingQuery(world);
      for (const eid of infUnits) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def?.infiltrator) continue;
        const infOwner = Owner.playerId[eid];

        // Passive: reveal stealthed enemies within 10 tiles (persistent for 200 ticks)
        for (const other of infUnits) {
          if (Health.current[other] <= 0 || Owner.playerId[other] === infOwner) continue;
          const dx = Position.x[eid] - Position.x[other];
          const dz = Position.z[eid] - Position.z[other];
          if (dx * dx + dz * dz < 100) { // ~10 unit radius
            combatSystem.setStealthed(other, false);
            infiltratorRevealed.set(other, game.getTickCount() + 200);
          }
        }

        // Active: suicide on enemy building contact (like saboteur but full HP damage + destealths area)
        if (MoveTarget.active[eid] !== 1) continue;
        for (const bid of infBlds) {
          if (Health.current[bid] <= 0) continue;
          if (Owner.playerId[bid] === infOwner) continue;
          const dx = Position.x[eid] - Position.x[bid];
          const dz = Position.z[eid] - Position.z[bid];
          if (dx * dx + dz * dz < 9.0) {
            // Full HP damage to building
            const dmg = Health.max[bid];
            Health.current[bid] = Math.max(0, Health.current[bid] - dmg);
            effectsManager.spawnExplosion(Position.x[bid], 0, Position.z[bid], 'large');
            audioManager.playSfx('explosion');
            scene.shake(0.5);
            if (Health.current[bid] <= 0) {
              EventBus.emit('unit:died', { entityId: bid, killerEntity: eid });
            }
            // Destealth all enemies in radius
            for (const other of infUnits) {
              if (Owner.playerId[other] === infOwner || Health.current[other] <= 0) continue;
              const ox = Position.x[other] - Position.x[eid];
              const oz = Position.z[other] - Position.z[eid];
              if (ox * ox + oz * oz < 100) {
                combatSystem.setStealthed(other, false);
              }
            }
            Health.current[eid] = 0;
            EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
            if (infOwner === 0) selectionPanel.addMessage('Infiltrator deployed!', '#88aaff');
            else if (Owner.playerId[bid] === 0) selectionPanel.addMessage('Infiltrator attack on base!', '#ff4444');
            break;
          }
        }
      }
    }

    // Leech: parasitizes enemy vehicles, drains HP over time, spawns new Leech when vehicle dies
    if (game.getTickCount() % 15 === 0) {
      const leechUnits = unitQuery(world);
      for (const eid of leechUnits) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def?.leech) continue;

        const leechOwner = Owner.playerId[eid];

        // Check if actively parasitizing (stored in leechTargets map)
        const parasiteTarget = leechTargets.get(eid);
        if (parasiteTarget !== undefined) {
          // Drain target vehicle
          if (Health.current[parasiteTarget] <= 0 || Position.x[parasiteTarget] < -900) {
            // Target died or gone - spawn a new Leech at target's position
            const tx = Position.x[parasiteTarget];
            const tz = Position.z[parasiteTarget];
            if (tx > -900) {
              spawnUnit(game.getWorld(), typeName, leechOwner, tx + 2, tz + 2);
              if (leechOwner === 0) selectionPanel.addMessage('Leech replicated!', '#88ff44');
            }
            leechTargets.delete(eid);
            // Leech detaches and becomes active again
            Position.y[eid] = 0.1;
            continue;
          }
          // Drain 2% of target's max HP per tick
          const drainDmg = Health.max[parasiteTarget] * 0.02;
          Health.current[parasiteTarget] = Math.max(0, Health.current[parasiteTarget] - drainDmg);
          // Follow target position
          Position.x[eid] = Position.x[parasiteTarget];
          Position.z[eid] = Position.z[parasiteTarget];
          Position.y[eid] = 1.5; // Sit on top of vehicle
          if (Health.current[parasiteTarget] <= 0) {
            EventBus.emit('unit:died', { entityId: parasiteTarget, killerEntity: eid });
            // Spawn new Leech
            spawnUnit(game.getWorld(), typeName, leechOwner,
              Position.x[parasiteTarget] + 2, Position.z[parasiteTarget] + 2);
            leechTargets.delete(eid);
            Position.y[eid] = 0.1;
            if (leechOwner === 0) selectionPanel.addMessage('Leech replicated!', '#88ff44');
            else if (Owner.playerId[parasiteTarget] === 0) selectionPanel.addMessage('Vehicle destroyed by Leech!', '#ff4444');
          }
          continue;
        }

        // Not parasitizing: look for nearby enemy vehicles to latch onto
        if (MoveTarget.active[eid] !== 1) continue; // Only while moving toward target
        for (const other of leechUnits) {
          if (other === eid || Health.current[other] <= 0) continue;
          if (Owner.playerId[other] === leechOwner) continue;
          // Must be a vehicle (not infantry, not flying)
          const otherTypeId = UnitType.id[other];
          const otherTypeName = unitTypeNames[otherTypeId];
          const otherDef = otherTypeName ? gameRules.units.get(otherTypeName) : null;
          if (!otherDef || otherDef.infantry || otherDef.canFly) continue;
          if (otherDef.cantBeLeeched || otherDef.leech) continue;
          const dx = Position.x[eid] - Position.x[other];
          const dz = Position.z[eid] - Position.z[other];
          if (dx * dx + dz * dz < 6.0) {
            // Latch on!
            leechTargets.set(eid, other);
            MoveTarget.active[eid] = 0;
            combatSystem.setSuppressed(eid, true);
            if (leechOwner === 0) selectionPanel.addMessage('Leech attached!', '#88ff44');
            else if (Owner.playerId[other] === 0) selectionPanel.addMessage('Leech on your vehicle!', '#ff4444');
            break;
          }
        }
      }
    }

    // Projector: creates holographic copies that decay over time
    if (game.getTickCount() % 25 === 12) {
      // Decay existing holograms
      for (const [hEid, ticksLeft] of projectorHolograms) {
        if (Health.current[hEid] <= 0) { projectorHolograms.delete(hEid); continue; }
        const remaining = ticksLeft - 25;
        if (remaining <= 0) {
          // Hologram expires
          Health.current[hEid] = 0;
          EventBus.emit('unit:died', { entityId: hEid, killerEntity: -1 });
          projectorHolograms.delete(hEid);
        } else {
          projectorHolograms.set(hEid, remaining);
          // Holograms flicker at low life
          if (remaining < 500) {
            const obj = unitRenderer.getEntityObject(hEid);
            if (obj) {
              const alpha = 0.3 + 0.4 * Math.sin(game.getTickCount() * 0.2);
              obj.traverse(child => {
                const mat = (child as any).material;
                if (mat) { mat.transparent = true; mat.opacity = alpha; }
              });
            }
          }
        }
      }
    }

    // Kobra deployed state: immobilized but doubled range
    if (game.getTickCount() % 25 === 0) {
      for (const eid of kobraDeployed) {
        if (Health.current[eid] <= 0) { kobraDeployed.delete(eid); continue; }
        // Prevent movement while deployed
        MoveTarget.active[eid] = 0;
      }
    }

    // NIAB Tank teleport cooldowns
    if (game.getTickCount() % 25 === 0 && niabCooldowns.size > 0) {
      for (const [eid, ticks] of niabCooldowns) {
        if (Health.current[eid] <= 0) { niabCooldowns.delete(eid); continue; }
        const remaining = ticks - 25;
        if (remaining <= 0) {
          niabCooldowns.delete(eid);
          combatSystem.setSuppressed(eid, false);
        } else {
          niabCooldowns.set(eid, remaining);
        }
      }
    }

    // Passive repair: idle units near friendly buildings heal slowly every 2 seconds
    if (game.getTickCount() % 50 === 0) {
      const allUnits = unitQuery(world);
      const allBuildings = buildingQuery(world);
      for (const eid of allUnits) {
        if (Health.current[eid] <= 0) continue;
        if (Health.current[eid] >= Health.max[eid]) continue;
        // Only heal when idle (not moving, not attacking)
        if (MoveTarget.active[eid] === 1) continue;
        if (hasComponent(world, AttackTarget, eid) && AttackTarget.active[eid] === 1) continue;

        const owner = Owner.playerId[eid];
        const ux = Position.x[eid];
        const uz = Position.z[eid];

        // Check if near a friendly building (within 15 units)
        let nearBase = false;
        for (const bid of allBuildings) {
          if (Owner.playerId[bid] !== owner) continue;
          if (Health.current[bid] <= 0) continue;
          const dx = Position.x[bid] - ux;
          const dz = Position.z[bid] - uz;
          if (dx * dx + dz * dz < 225) { nearBase = true; break; }
        }
        if (nearBase) {
          Health.current[eid] = Math.min(Health.max[eid], Health.current[eid] + Health.max[eid] * 0.02);
        }
      }
    }

    // Repair vehicles: units with repair flag heal nearby friendly units and buildings
    if (game.getTickCount() % 25 === 0) {
      const allUnits = unitQuery(world);
      for (const eid of allUnits) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const repDef = typeName ? gameRules.units.get(typeName) : null;
        if (!repDef?.repair) continue;

        const owner = Owner.playerId[eid];
        const rx = Position.x[eid];
        const rz = Position.z[eid];

        // Heal all friendly units within 8 units, 3% max HP per tick
        for (const other of allUnits) {
          if (other === eid) continue;
          if (Owner.playerId[other] !== owner) continue;
          if (Health.current[other] <= 0) continue;
          if (Health.current[other] >= Health.max[other]) continue;
          const dx = Position.x[other] - rx;
          const dz = Position.z[other] - rz;
          if (dx * dx + dz * dz < 64) { // 8 unit radius
            Health.current[other] = Math.min(Health.max[other],
              Health.current[other] + Health.max[other] * 0.03);
          }
        }

        // Also heal nearby buildings
        const nearBlds = buildingQuery(world);
        for (const bid of nearBlds) {
          if (Owner.playerId[bid] !== owner) continue;
          if (Health.current[bid] <= 0 || Health.current[bid] >= Health.max[bid]) continue;
          const dx = Position.x[bid] - rx;
          const dz = Position.z[bid] - rz;
          if (dx * dx + dz * dz < 64) {
            Health.current[bid] = Math.min(Health.max[bid],
              Health.current[bid] + Health.max[bid] * 0.02);
          }
        }
      }
    }

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
        }
      }
    }

    // --- FACTION-SPECIFIC BONUSES (every 2 seconds) ---
    if (game.getTickCount() % 50 === 25) {
      const allUnits = unitQuery(world);

      for (let pid = 0; pid <= 1; pid++) {
        const prefix = pid === 0 ? house.prefix : house.enemyPrefix;

        // ORDOS: self-regeneration (units slowly heal 1% HP per 2 seconds)
        if (prefix === 'OR') {
          for (const eid of allUnits) {
            if (Owner.playerId[eid] !== pid) continue;
            if (Health.current[eid] <= 0 || Health.current[eid] >= Health.max[eid]) continue;
            Health.current[eid] = Math.min(Health.max[eid],
              Health.current[eid] + Health.max[eid] * 0.01);
          }
        }

        // HARKONNEN: no damage degradation — implemented via combat system bonus
        // (In the real game, all units deal less damage as they lose HP. Harkonnen are exempt.
        //  Our implementation: Harkonnen get +10% damage at all times to represent this advantage.)
        // This is handled in the damage calculation below.
      }
    }

    // Crate drops: spawn a random crate every ~40 seconds
    if (game.getTickCount() % 1000 === 500 && activeCrates.size < 3) {
      const crateTypes = ['credits', 'veterancy', 'heal'];
      const type = crateTypes[Math.floor(Math.random() * crateTypes.length)];
      const cx = 20 + Math.random() * (MAP_SIZE * 2 - 40);
      const cz = 20 + Math.random() * (MAP_SIZE * 2 - 40);
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
              Veterancy.xp[eid] += 100;
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
        // Damage units on sand every 25 ticks during storm
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
        }
      };
      EventBus.on('game:tick', stormDamage);
    }

    // Sample stats for post-game graphs every 250 ticks (~10 seconds)
    if (game.getTickCount() % 250 === 0) {
      const allU = unitQuery(world);
      let p0units = 0, p1units = 0;
      for (const uid of allU) {
        if (Health.current[uid] <= 0) continue;
        if (Owner.playerId[uid] === 0) p0units++;
        else if (Owner.playerId[uid] === 1) p1units++;
      }
      gameStats.sample(
        game.getTickCount(),
        [harvestSystem.getSolaris(0), harvestSystem.getSolaris(1)],
        [p0units, p1units],
      );
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
        return;
      }
    } else {
      // Start unit production
      if (!productionSystem.startProduction(0, typeName, false)) {
        audioManager.playSfx('error');
        selectionPanel.addMessage('Cannot build', '#ff4444');
        return;
      }
    }
    sidebar.refresh();
  }, house.prefix, house.subhouse?.prefix ?? '');

  // Concrete slab placement
  const CONCRETE_COST = 20;
  sidebar.setConcreteCallback(() => {
    buildingPlacement.startConcretePlacement((tx, tz) => {
      if (harvestSystem.getSolaris(0) < CONCRETE_COST) {
        selectionPanel.addMessage('Insufficient funds', '#ff4444');
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

  // Track last combat event position for Space key
  let lastEventX = 55, lastEventZ = 55;
  EventBus.on('unit:died', ({ entityId }) => {
    lastEventX = Position.x[entityId];
    lastEventZ = Position.z[entityId];
  });
  EventBus.on('worm:emerge', ({ x, z }) => { lastEventX = x; lastEventZ = z; });
  EventBus.on('unit:damaged', ({ entityId, x, z }) => {
    if (Owner.playerId[entityId] === 0) { lastEventX = x; lastEventZ = z; }
  });

  const speedEl = document.getElementById('game-speed');
  function updateSpeedIndicator(speed: number): void {
    if (!speedEl) return;
    const label = speed <= 0.5 ? '0.5x' : speed >= 2.0 ? '2x' : '1x';
    const color = speed <= 0.5 ? '#88aaff' : speed >= 2.0 ? '#ff8844' : '#888';
    speedEl.textContent = label;
    speedEl.style.color = color;
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
      // Snap to last event
      e.preventDefault();
      scene.panTo(lastEventX, lastEventZ);
    } else if (e.key === 'x' && !e.ctrlKey && !e.altKey) {
      // Self-destruct for Devastator units
      const selected = selectionManager.getSelectedEntities();
      const w = game.getWorld();
      for (const eid of selected) {
        if (Owner.playerId[eid] !== 0) continue;
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def?.selfDestruct) continue;
        // Massive explosion
        const ex = Position.x[eid], ez = Position.z[eid];
        effectsManager.spawnExplosion(ex, 0, ez, 'large');
        effectsManager.spawnExplosion(ex + 2, 0, ez + 2, 'large');
        effectsManager.spawnExplosion(ex - 2, 0, ez - 2, 'large');
        audioManager.playSfx('explosion');
        selectionPanel.addMessage('SELF-DESTRUCT!', '#ff4444');
        scene.shake(0.8);
        // Damage all nearby units (friend and foe) in 12 unit radius
        const allUnits = unitQuery(w);
        const allBuildings = buildingQuery(w);
        const targets = [...allUnits, ...allBuildings];
        for (const tid of targets) {
          if (tid === eid) continue;
          if (Health.current[tid] <= 0) continue;
          const dx = Position.x[tid] - ex;
          const dz = Position.z[tid] - ez;
          const dist2 = dx * dx + dz * dz;
          if (dist2 < 144) { // 12 unit radius
            const dmg = Math.floor(1000 * (1 - Math.sqrt(dist2) / 12));
            Health.current[tid] = Math.max(0, Health.current[tid] - dmg);
            if (Health.current[tid] <= 0) {
              EventBus.emit('unit:died', { entityId: tid, killerEntity: eid });
            }
          }
        }
        // Kill the Devastator
        Health.current[eid] = 0;
        EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
      }
    } else if (e.key === 'd' && !e.ctrlKey && !e.altKey) {
      // D key: MCV deploy OR Kobra deploy/undeploy
      const selected = selectionManager.getSelectedEntities();
      const w = game.getWorld();
      let handled = false;
      for (const eid of selected) {
        if (Owner.playerId[eid] !== 0) continue;
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;

        // MCV deployment
        if (typeName === 'MCV') {
          const conYardName = `${house.prefix}ConYard`;
          const bDef = gameRules.buildings.get(conYardName);
          if (!bDef) continue;
          const dx = Position.x[eid], dz = Position.z[eid];
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
          spawnBuilding(w, conYardName, 0, dx, dz);
          selectionPanel.addMessage('MCV deployed!', '#44ff44');
          audioManager.playSfx('build');
          handled = true;
          break;
        }

        // Kobra deploy/undeploy toggle
        if (def?.kobra) {
          if (kobraDeployed.has(eid)) {
            // Undeploy: restore original range
            kobraDeployed.delete(eid);
            if (hasComponent(w, Combat, eid)) {
              const base = kobraBaseRange.get(eid) ?? Combat.range[eid];
              Combat.range[eid] = base;
            }
            kobraBaseRange.delete(eid);
            selectionPanel.addMessage('Kobra undeployed', '#aaa');
            audioManager.playSfx('build');
          } else {
            // Deploy: immobilize, double range (store base)
            if (hasComponent(w, Combat, eid)) {
              kobraBaseRange.set(eid, Combat.range[eid]);
              Combat.range[eid] = Combat.range[eid] * 2;
            }
            kobraDeployed.add(eid);
            MoveTarget.active[eid] = 0;
            selectionPanel.addMessage('Kobra deployed - range doubled!', '#44ff44');
            audioManager.playSfx('build');
          }
          handled = true;
        }
      }
    } else if (e.key === 't' && !e.ctrlKey && !e.altKey) {
      // T key: NIAB Tank teleport OR Projector create hologram
      const selected = selectionManager.getSelectedEntities();
      const w = game.getWorld();
      for (const eid of selected) {
        if (Owner.playerId[eid] !== 0) continue;
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;

        // NIAB Tank teleport: enter targeting mode
        if (def?.niabTank) {
          if (niabCooldowns.has(eid)) {
            selectionPanel.addMessage('Teleport on cooldown', '#ff8800');
            break;
          }
          // Enter teleport targeting mode
          commandManager.enterCommandMode('teleport', 'Click to teleport');
          break;
        }

        // Projector: create holographic copy of nearest friendly unit
        if (def?.projector) {
          // Find nearest friendly non-projector unit to copy
          const allUnits = unitQuery(w);
          let bestOther = -1;
          let bestDist = Infinity;
          for (const other of allUnits) {
            if (other === eid || Owner.playerId[other] !== 0) continue;
            if (Health.current[other] <= 0) continue;
            const otherTypeName = unitTypeNames[UnitType.id[other]];
            const otherDef = otherTypeName ? gameRules.units.get(otherTypeName) : null;
            if (otherDef?.projector) continue; // Can't copy another projector
            const dx = Position.x[other] - Position.x[eid];
            const dz = Position.z[other] - Position.z[eid];
            const dist = dx * dx + dz * dz;
            if (dist < 225 && dist < bestDist) { // Within 15 units
              bestDist = dist;
              bestOther = other;
            }
          }
          if (bestOther >= 0) {
            // Create holographic copy
            const copyTypeName = unitTypeNames[UnitType.id[bestOther]];
            if (copyTypeName) {
              const hx = Position.x[eid] + (Math.random() - 0.5) * 4;
              const hz = Position.z[eid] + (Math.random() - 0.5) * 4;
              const holoEid = spawnUnit(w, copyTypeName, 0, hx, hz);
              if (holoEid >= 0) {
                // Hologram: 1 HP, no damage, lasts 6000 ticks (~4 minutes)
                Health.max[holoEid] = 1;
                Health.current[holoEid] = 1;
                if (hasComponent(w, Combat, holoEid)) {
                  Combat.damage[holoEid] = 0; // Holograms can't deal damage
                }
                projectorHolograms.set(holoEid, 6000);
                // Make hologram slightly transparent
                const obj = unitRenderer.getEntityObject(holoEid);
                if (obj) {
                  obj.traverse(child => {
                    const mat = (child as any).material;
                    if (mat) { mat.transparent = true; mat.opacity = 0.7; }
                  });
                }
                selectionPanel.addMessage('Hologram created!', '#88aaff');
                audioManager.playSfx('select');
              }
            }
          } else {
            selectionPanel.addMessage('No unit nearby to copy', '#888');
          }
          break;
        }
      }
    } else if (e.key === 'l' && !e.ctrlKey && !e.altKey) {
      // Load infantry into selected APC
      const selected = selectionManager.getSelectedEntities();
      const w = game.getWorld();
      let apcEid = -1;
      // Find the first selected APC
      for (const eid of selected) {
        if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
        const typeName = unitTypeNames[UnitType.id[eid]];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (def?.apc) { apcEid = eid; break; }
      }
      if (apcEid >= 0) {
        const ax = Position.x[apcEid], az = Position.z[apcEid];
        const allUnits = unitQuery(w);
        let loaded = 0;
        for (const eid of allUnits) {
          if (eid === apcEid) continue;
          if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
          if (Position.x[eid] < -900) continue; // Already loaded
          const dx = Position.x[eid] - ax;
          const dz = Position.z[eid] - az;
          if (dx * dx + dz * dz > 36) continue; // Within 6 units
          if (loadIntoTransport(apcEid, eid)) loaded++;
        }
        if (loaded > 0) {
          selectionPanel.addMessage(`Loaded ${loaded} infantry`, '#44ff44');
          audioManager.playSfx('select');
        } else {
          selectionPanel.addMessage('No infantry nearby to load', '#888');
        }
      }
    } else if (e.key === 'u' && !e.ctrlKey && !e.altKey) {
      // Unload infantry from selected APC
      const selected = selectionManager.getSelectedEntities();
      for (const eid of selected) {
        if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
        const count = unloadTransport(eid);
        if (count > 0) {
          selectionPanel.addMessage(`Unloaded ${count} infantry`, '#44ff44');
          audioManager.playSfx('select');
        }
      }
    } else if (e.key === 'w' && !e.ctrlKey && !e.altKey) {
      // Mount/dismount sandworm (Fremen worm riders)
      const selected = selectionManager.getSelectedEntities();
      for (const eid of selected) {
        if (Owner.playerId[eid] !== 0 || Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def?.wormRider) continue;

        // Check if already mounted — dismount
        const riderWorm = sandwormSystem.getRiderWorm(eid);
        if (riderWorm) {
          sandwormSystem.dismountWorm(eid);
          selectionPanel.addMessage('Dismounted worm', '#aaa');
          audioManager.playSfx('select');
          continue;
        }

        // Try to mount a nearby worm
        const mounted = sandwormSystem.mountWorm(
          eid, Position.x[eid], Position.z[eid], Owner.playerId[eid]
        );
        if (mounted) {
          selectionPanel.addMessage('Worm mounted!', '#f0c040');
          audioManager.playSfx('move');
        } else {
          selectionPanel.addMessage('No worm nearby to mount', '#888');
        }
      }
    } else if (e.key === 'F1') {
      e.preventDefault();
      game.setSpeed(0.5);
      selectionPanel.addMessage('Speed: Slow', '#888');
      updateSpeedIndicator(0.5);
    } else if (e.key === 'F2') {
      e.preventDefault();
      game.setSpeed(1.0);
      selectionPanel.addMessage('Speed: Normal', '#888');
      updateSpeedIndicator(1.0);
    } else if (e.key === 'F3') {
      e.preventDefault();
      game.setSpeed(2.0);
      selectionPanel.addMessage('Speed: Fast', '#888');
      updateSpeedIndicator(2.0);
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
      if (pauseMenu && pauseMenu.parentNode) {
        pauseMenu.remove();
        pauseMenu = null;
        if (game.isPaused()) game.pause(); // Unpause
      } else {
        if (!game.isPaused()) game.pause();
        showPauseMenu();
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
      const passengers = transportPassengers.get(eid);
      if (passengers && passengers.length > 0) {
        se.passengerTypeIds = passengers
          .filter(p => Health.current[p] > 0)
          .map(p => UnitType.id[p]);
      }
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

    // Save spice map
    const spice: number[][] = [];
    for (let tz = 0; tz < 128; tz++) {
      const row: number[] = [];
      for (let tx = 0; tx < 128; tx++) {
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
      solaris: [harvestSystem.getSolaris(0), harvestSystem.getSolaris(1)],
      entities,
      spice,
    };
  }

  function saveGame(): void {
    const save = buildSaveData();
    localStorage.setItem('ebfd_save', JSON.stringify(save));
    localStorage.setItem('ebfd_save_time', new Date().toLocaleString());
    selectionPanel.addMessage('Game saved! (F8 to load)', '#44ff44');
  }

  let pauseMenu: HTMLDivElement | null = null;

  // Settings persistence
  const savedSettings = JSON.parse(localStorage.getItem('ebfd_settings') ?? '{}');
  if (savedSettings.musicVol !== undefined) audioManager.setMusicVolume(savedSettings.musicVol);
  if (savedSettings.sfxVol !== undefined) audioManager.setSfxVolume(savedSettings.sfxVol);

  function saveSettings(musicVol: number, sfxVol: number, scrollSpeed: number): void {
    localStorage.setItem('ebfd_settings', JSON.stringify({ musicVol, sfxVol, scrollSpeed }));
  }

  function showPauseMenu(): void {
    if (pauseMenu) return; // Prevent duplicate menus
    pauseMenu = document.createElement('div');
    pauseMenu.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;
      background:rgba(0,0,0,0.8);display:flex;flex-direction:column;
      align-items:center;justify-content:center;z-index:900;
      font-family:'Segoe UI',Tahoma,sans-serif;
    `;

    const elapsed = Math.floor(game.getTickCount() / 25);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;

    pauseMenu.innerHTML = `
      <div style="color:#d4a840;font-size:36px;font-weight:bold;margin-bottom:8px;">PAUSED</div>
      <div style="color:#888;font-size:14px;margin-bottom:32px;">Game Time: ${mins}:${secs.toString().padStart(2, '0')}</div>
    `;

    const buttons = [
      { label: 'Resume', action: () => { pauseMenu?.remove(); pauseMenu = null; game.pause(); } },
      { label: 'Settings', action: () => { showSettingsPanel(); } },
      { label: 'Save / Load', action: () => { showSaveLoadPanel(); } },
      { label: 'Restart Mission', action: () => { window.location.reload(); } },
      { label: 'Quit to Menu', action: () => {
        // Clear campaign continuation and reload to main menu
        localStorage.removeItem('ebfd_campaign_next');
        localStorage.removeItem('ebfd_load');
        localStorage.removeItem('ebfd_load_data');
        window.location.reload();
      }},
    ];

    for (const { label, action } of buttons) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = 'display:block;width:200px;padding:10px;margin:4px;background:#1a1a3e;border:1px solid #444;color:#ccc;cursor:pointer;font-size:14px;';
      btn.onmouseenter = () => { btn.style.borderColor = '#88f'; btn.style.color = '#fff'; };
      btn.onmouseleave = () => { btn.style.borderColor = '#444'; btn.style.color = '#ccc'; };
      btn.onclick = action;
      pauseMenu.appendChild(btn);
    }

    document.body.appendChild(pauseMenu);
  }

  function showSaveLoadPanel(): void {
    if (!pauseMenu) return;
    pauseMenu.innerHTML = '';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:#1a1a3e;border:1px solid #555;padding:24px 32px;border-radius:4px;min-width:360px;';

    const title = document.createElement('div');
    title.textContent = 'SAVE / LOAD';
    title.style.cssText = 'color:#d4a840;font-size:24px;font-weight:bold;text-align:center;margin-bottom:20px;';
    panel.appendChild(title);

    const slotKeys = ['ebfd_save', 'ebfd_save_2', 'ebfd_save_3'];
    const slotLabels = ['Slot 1 (F5)', 'Slot 2', 'Slot 3'];

    for (let i = 0; i < slotKeys.length; i++) {
      const key = slotKeys[i];
      const raw = localStorage.getItem(key);
      const timeKey = key + '_time';
      const timeStr = localStorage.getItem(timeKey) ?? '';
      const hasSave = !!raw;

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';

      const label = document.createElement('div');
      label.style.cssText = 'color:#ccc;font-size:13px;flex:1;';
      label.textContent = hasSave ? `${slotLabels[i]} — ${timeStr}` : `${slotLabels[i]} — Empty`;
      row.appendChild(label);

      const saveBtn = document.createElement('button');
      saveBtn.textContent = 'Save';
      saveBtn.style.cssText = 'padding:4px 12px;background:#1a3e1a;border:1px solid #4a4;color:#ccc;cursor:pointer;font-size:12px;';
      saveBtn.onmouseenter = () => { saveBtn.style.borderColor = '#8f8'; };
      saveBtn.onmouseleave = () => { saveBtn.style.borderColor = '#4a4'; };
      saveBtn.onclick = () => {
        const data = buildSaveData();
        localStorage.setItem(key, JSON.stringify(data));
        localStorage.setItem(timeKey, new Date().toLocaleString());
        selectionPanel.addMessage(`Saved to ${slotLabels[i]}`, '#44ff44');
        showSaveLoadPanel(); // Refresh
      };
      row.appendChild(saveBtn);

      const loadBtn = document.createElement('button');
      loadBtn.textContent = 'Load';
      loadBtn.style.cssText = `padding:4px 12px;background:#1a1a3e;border:1px solid ${hasSave ? '#44f' : '#333'};color:${hasSave ? '#ccc' : '#555'};cursor:${hasSave ? 'pointer' : 'default'};font-size:12px;`;
      if (hasSave) {
        loadBtn.onmouseenter = () => { loadBtn.style.borderColor = '#88f'; };
        loadBtn.onmouseleave = () => { loadBtn.style.borderColor = '#44f'; };
        loadBtn.onclick = () => {
          localStorage.setItem('ebfd_load_data', raw!);
          localStorage.setItem('ebfd_load', '1');
          window.location.reload();
        };
      }
      row.appendChild(loadBtn);

      panel.appendChild(row);
    }

    // Autosave slot (read-only, load only)
    const autoRaw = localStorage.getItem('ebfd_autosave');
    const autoTime = localStorage.getItem('ebfd_autosave_time') ?? '';
    const hasAuto = !!autoRaw;

    const autoRow = document.createElement('div');
    autoRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid #333;';

    const autoLabel = document.createElement('div');
    autoLabel.style.cssText = 'color:#888;font-size:13px;flex:1;';
    autoLabel.textContent = hasAuto ? `Autosave — ${autoTime}` : 'Autosave — None';
    autoRow.appendChild(autoLabel);

    const autoLoadBtn = document.createElement('button');
    autoLoadBtn.textContent = 'Load';
    autoLoadBtn.style.cssText = `padding:4px 12px;background:#1a1a3e;border:1px solid ${hasAuto ? '#44f' : '#333'};color:${hasAuto ? '#ccc' : '#555'};cursor:${hasAuto ? 'pointer' : 'default'};font-size:12px;`;
    if (hasAuto) {
      autoLoadBtn.onmouseenter = () => { autoLoadBtn.style.borderColor = '#88f'; };
      autoLoadBtn.onmouseleave = () => { autoLoadBtn.style.borderColor = '#44f'; };
      autoLoadBtn.onclick = () => {
        localStorage.setItem('ebfd_load_data', autoRaw!);
        localStorage.setItem('ebfd_load', '1');
        window.location.reload();
      };
    }
    autoRow.appendChild(autoLoadBtn);
    panel.appendChild(autoRow);

    // Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'display:block;width:100%;padding:10px;background:#2a2a4e;border:1px solid #555;color:#ccc;cursor:pointer;font-size:14px;margin-top:16px;';
    backBtn.onmouseenter = () => { backBtn.style.borderColor = '#88f'; };
    backBtn.onmouseleave = () => { backBtn.style.borderColor = '#555'; };
    backBtn.onclick = () => {
      pauseMenu?.remove();
      pauseMenu = null;
      showPauseMenu();
    };
    panel.appendChild(backBtn);

    pauseMenu.appendChild(panel);
  }

  function showSettingsPanel(): void {
    if (!pauseMenu) return;
    // Clear pause menu content and show settings
    pauseMenu.innerHTML = '';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:#1a1a3e;border:1px solid #555;padding:24px 32px;border-radius:4px;min-width:300px;';

    const title = document.createElement('div');
    title.textContent = 'SETTINGS';
    title.style.cssText = 'color:#d4a840;font-size:24px;font-weight:bold;text-align:center;margin-bottom:20px;';
    panel.appendChild(title);

    // Music volume slider
    const currentSettings = JSON.parse(localStorage.getItem('ebfd_settings') ?? '{"musicVol":0.3,"sfxVol":0.5,"scrollSpeed":1}');
    let musicVol = currentSettings.musicVol ?? 0.3;
    let sfxVol = currentSettings.sfxVol ?? 0.5;
    let scrollSpd = currentSettings.scrollSpeed ?? 1;

    const createSlider = (label: string, value: number, onChange: (v: number) => void): HTMLElement => {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:16px;';
      const lbl = document.createElement('div');
      lbl.style.cssText = 'color:#ccc;font-size:13px;margin-bottom:4px;display:flex;justify-content:space-between;';
      const valLabel = document.createElement('span');
      valLabel.textContent = `${Math.round(value * 100)}%`;
      valLabel.style.color = '#8cf';
      lbl.innerHTML = `<span>${label}</span>`;
      lbl.appendChild(valLabel);
      row.appendChild(lbl);
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(Math.round(value * 100));
      slider.style.cssText = 'width:100%;accent-color:#d4a840;';
      slider.oninput = () => {
        const v = parseInt(slider.value) / 100;
        valLabel.textContent = `${slider.value}%`;
        onChange(v);
      };
      row.appendChild(slider);
      return row;
    };

    panel.appendChild(createSlider('Music Volume', musicVol, (v) => {
      musicVol = v;
      audioManager.setMusicVolume(v);
    }));

    panel.appendChild(createSlider('SFX Volume', sfxVol, (v) => {
      sfxVol = v;
      audioManager.setSfxVolume(v);
    }));

    panel.appendChild(createSlider('Scroll Speed', scrollSpd, (v) => {
      scrollSpd = v;
    }));

    // Game speed selector
    const speedRow = document.createElement('div');
    speedRow.style.cssText = 'margin-bottom:20px;';
    const speedLabel = document.createElement('div');
    speedLabel.textContent = 'Game Speed';
    speedLabel.style.cssText = 'color:#ccc;font-size:13px;margin-bottom:4px;';
    speedRow.appendChild(speedLabel);
    const speedBtns = document.createElement('div');
    speedBtns.style.cssText = 'display:flex;gap:4px;';
    for (const { label, speed } of [{ label: 'Slow', speed: 0.5 }, { label: 'Normal', speed: 1.0 }, { label: 'Fast', speed: 2.0 }]) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = 'flex:1;padding:6px;background:#111;border:1px solid #444;color:#ccc;cursor:pointer;font-size:12px;';
      btn.onclick = () => {
        game.setSpeed(speed);
        speedBtns.querySelectorAll('button').forEach(b => (b as HTMLElement).style.borderColor = '#444');
        btn.style.borderColor = '#d4a840';
      };
      speedBtns.appendChild(btn);
    }
    speedRow.appendChild(speedBtns);
    panel.appendChild(speedRow);

    // Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'display:block;width:100%;padding:10px;background:#2a2a4e;border:1px solid #555;color:#ccc;cursor:pointer;font-size:14px;margin-top:8px;';
    backBtn.onmouseenter = () => { backBtn.style.borderColor = '#88f'; };
    backBtn.onmouseleave = () => { backBtn.style.borderColor = '#555'; };
    backBtn.onclick = () => {
      saveSettings(musicVol, sfxVol, scrollSpd);
      pauseMenu?.remove();
      pauseMenu = null;
      showPauseMenu();
    };
    panel.appendChild(backBtn);

    pauseMenu.appendChild(panel);
  }

  // --- SPAWN INITIAL ENTITIES ---
  const world = game.getWorld();

  if (savedGame) {
    // --- RESTORE FROM SAVE ---
    game.setTickCount(savedGame.tick);
    harvestSystem.addSolaris(0, savedGame.solaris[0] - harvestSystem.getSolaris(0));
    harvestSystem.addSolaris(1, savedGame.solaris[1] - harvestSystem.getSolaris(1));

    // Restore spice
    for (let tz = 0; tz < savedGame.spice.length && tz < 128; tz++) {
      for (let tx = 0; tx < savedGame.spice[tz].length && tx < 128; tx++) {
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
            if (passengers.length > 0) transportPassengers.set(eid, passengers);
          }
        }
      }
    }
    console.log(`Restored ${savedGame.entities.length} entities from save (tick ${savedGame.tick})`);
  } else {
    // --- FRESH GAME ---
    // Randomize starting positions: pick 2 opposite corners
    const corners = [
      { x: 50, z: 50 },   // Top-left
      { x: 200, z: 50 },  // Top-right
      { x: 50, z: 200 },  // Bottom-left
      { x: 200, z: 200 }, // Bottom-right
    ];
    const playerCornerIdx = Math.floor(Math.random() * 4);
    const enemyCornerIdx = 3 - playerCornerIdx; // Opposite corner
    const playerBase = corners[playerCornerIdx];
    const enemyBase = corners[enemyCornerIdx];

    // Update AI target/base to match randomized positions
    aiPlayer.setBasePosition(enemyBase.x, enemyBase.z);
    aiPlayer.setTargetPosition(playerBase.x, playerBase.z);

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

    // Harvester
    const harvTypes = [...gameRules.units.keys()].filter(n => n.startsWith(px) && (n.includes('Harv') || n.includes('harvester')));
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

    // Enemy base
    const ex = house.enemyPrefix;
    spawnBuilding(world, `${ex}ConYard`, 1, enemyBase.x, enemyBase.z);
    spawnBuilding(world, `${ex}SmWindtrap`, 1, enemyBase.x + 6, enemyBase.z);
    spawnBuilding(world, `${ex}Barracks`, 1, enemyBase.x - 6, enemyBase.z);
    spawnBuilding(world, `${ex}Factory`, 1, enemyBase.x, enemyBase.z + 6);
    spawnBuilding(world, `${ex}SmWindtrap`, 1, enemyBase.x + 6, enemyBase.z + 6);
    spawnBuilding(world, `${ex}Refinery`, 1, enemyBase.x - 6, enemyBase.z + 6);

    // Enemy starting units
    const enemyInfantry = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && gameRules.units.get(n)?.infantry);
    const enemyVehicles = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && !gameRules.units.get(n)?.infantry && gameRules.units.get(n)!.cost > 0 && !gameRules.units.get(n)!.canFly);

    for (let i = 0; i < 3 && i < enemyInfantry.length; i++) {
      spawnUnit(world, enemyInfantry[i], 1, enemyBase.x - 5 + i * 2, enemyBase.z + 10);
    }
    for (let i = 0; i < 3 && i < enemyVehicles.length; i++) {
      spawnUnit(world, enemyVehicles[i], 1, enemyBase.x + 1 + i * 2, enemyBase.z + 12);
    }

    // Enemy harvester
    const enemyHarvTypes = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && (n.includes('Harv') || n.includes('harvester')));
    if (enemyHarvTypes.length > 0) {
      spawnUnit(world, enemyHarvTypes[0], 1, enemyBase.x - 5, enemyBase.z + 12);
    }

    // Camera starts at player base
    scene.cameraTarget.set(playerBase.x, 0, playerBase.z);
    scene.updateCameraPosition();
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
}

main().catch(console.error);
