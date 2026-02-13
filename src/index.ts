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
  combatSystem.setFogOfWar(fogOfWar, 0);

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

  function findRefinery(world: World, owner: number): number | null {
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== owner) continue;
      if (Health.current[eid] <= 0) continue;
      const typeId = BuildingType.id[eid];
      const name = buildingTypeNames[typeId] ?? '';
      if (name.includes('Refinery') || name.includes('Ref')) {
        return eid;
      }
    }
    return null;
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

    // Auto-add harvester component for harvester units
    if (typeName.includes('Harvester') || typeName.includes('Harv')) {
      addComponent(world, Harvester, eid);
      Harvester.maxCapacity[eid] = 1.0;
      Harvester.spiceCarried[eid] = 0;
      Harvester.state[eid] = 0;
      // Link to nearest refinery owned by same player
      Harvester.refineryEntity[eid] = findRefinery(world, owner) ?? 0;
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
    audioManager.playSfx('explosion');

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
    selectionPanel.addMessage('Rally point set', '#44ff44');
  });

  // Projectile visuals — color and speed vary by weapon type
  // Deviator conversion tracking: entityId -> { originalOwner, revertTick }
  const deviatedUnits = new Map<number, { originalOwner: number; revertTick: number }>();

  EventBus.on('combat:fire', ({ attackerX, attackerZ, targetX, targetZ, weaponType, attackerEntity, targetEntity }) => {
    let color = 0xffaa00; // Default orange
    let speed = 40;
    const wt = (weaponType ?? '').toLowerCase();
    if (wt.includes('rocket') || wt.includes('missile')) {
      color = 0xff4400; speed = 25; // Red, slower
    } else if (wt.includes('laser') || wt.includes('sonic')) {
      color = 0x00ffff; speed = 80; // Cyan, fast
    } else if (wt.includes('flame')) {
      color = 0xff6600; speed = 20; // Deep orange, slow
    } else if (wt.includes('gun') || wt.includes('cannon') || wt.includes('machinegun')) {
      color = 0xffff44; speed = 60; // Yellow, fast
    } else if (wt.includes('mortar') || wt.includes('inkvine')) {
      color = 0x88ff44; speed = 15; // Green, arcing
    }
    effectsManager.spawnProjectile(attackerX, 0, attackerZ, targetX, 0, targetZ, color, speed);

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
    }
  });

  EventBus.on('unit:move', ({ entityIds }) => {
    for (const eid of entityIds) {
      movement.clearPath(eid);
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
      // Spawn unit near appropriate building — find a barracks/factory owned by this player
      let baseX: number, baseZ: number;
      const spawnBuildings = buildingQuery(world);
      let found = false;
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

      // Send to rally point if player has one set
      if (owner === 0 && eid >= 0) {
        const rally = commandManager.getRallyPoint(0);
        if (rally) {
          MoveTarget.x[eid] = rally.x;
          MoveTarget.z[eid] = rally.z;
          MoveTarget.active[eid] = 1;
        }
      }
    }
  });

  // --- GAME TICK ---

  // UI elements for resource bar
  const powerEl = document.getElementById('power-status');
  const unitCountEl = document.getElementById('unit-count');
  const commandModeEl = document.getElementById('command-mode');
  const lowPowerEl = document.getElementById('low-power-warning');

  // Crate/power-up state
  let nextCrateId = 0;
  const activeCrates = new Map<number, { x: number; z: number; type: string }>();

  EventBus.on('game:tick', () => {
    const world = game.getWorld();

    productionSystem.update();
    productionSystem.updateStarportPrices();

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

    unitRenderer.update(world);
    unitRenderer.tickConstruction();
    unitRenderer.tickDeconstruction();
    minimapRenderer.update(world);
    effectsManager.update(40); // ~40ms per tick at 25 TPS
    effectsManager.updateWormVisuals(sandwormSystem.getWorms(), 40);
    fogOfWar.update(world);
    victorySystem.update(world);
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
        powerEl.style.color = powerGen >= powerUsed ? '#4f4' : '#f44';
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
      for (const eid of units) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def?.stealth) continue;
        const isIdle = MoveTarget.active[eid] === 0;
        combatSystem.setStealthed(eid, isIdle);
        const obj = unitRenderer.getEntityObject(eid);
        if (obj) {
          const targetAlpha = isIdle ? (Owner.playerId[eid] === 0 ? 0.3 : 0.0) : 1.0;
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
      for (const eid of allUnits) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def || !def.crushes) continue;
        if (MoveTarget.active[eid] !== 1) continue; // Only crush while moving

        // Check for nearby crushable infantry
        for (const other of allUnits) {
          if (other === eid) continue;
          if (Health.current[other] <= 0) continue;
          if (Owner.playerId[other] === Owner.playerId[eid]) continue; // Don't crush friendlies
          const oTypeId = UnitType.id[other];
          const oName = unitTypeNames[oTypeId];
          const oDef = oName ? gameRules.units.get(oName) : null;
          if (!oDef || !oDef.crushable) continue;

          const dx = Position.x[eid] - Position.x[other];
          const dz = Position.z[eid] - Position.z[other];
          if (dx * dx + dz * dz < 2.0) { // Within 1.4 units
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

    // Repair vehicles: units with canBeRepaired tag that have "Repair" in name heal nearby friendlies
    if (game.getTickCount() % 25 === 0) {
      const allUnits = unitQuery(world);
      for (const eid of allUnits) {
        if (Health.current[eid] <= 0) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        if (!typeName || !typeName.toLowerCase().includes('repair')) continue;

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
    } else if (e.key === 'F1') {
      e.preventDefault();
      game.setSpeed(0.5);
      selectionPanel.addMessage('Speed: Slow', '#888');
    } else if (e.key === 'F2') {
      e.preventDefault();
      game.setSpeed(1.0);
      selectionPanel.addMessage('Speed: Normal', '#888');
    } else if (e.key === 'F3') {
      e.preventDefault();
      game.setSpeed(2.0);
      selectionPanel.addMessage('Speed: Fast', '#888');
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
