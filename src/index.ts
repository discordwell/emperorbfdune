import { Game } from './core/Game';
import { SceneManager } from './rendering/SceneManager';
import { TerrainRenderer } from './rendering/TerrainRenderer';
import { InputManager } from './input/InputManager';
import { parseRules, type GameRules } from './config/RulesParser';
import { parseArtIni, type ArtEntry } from './config/ArtIniParser';
import { loadConstants } from './utils/Constants';
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
import {
  addEntity, addComponent, removeEntity,
  Position, Velocity, Rotation, Health, Owner, UnitType, Selectable,
  MoveTarget, AttackTarget, Combat, Armour, Speed, ViewRange, Renderable,
  Harvester, BuildingType, PowerSource,
  type World,
} from './core/ECS';

// Globals
let gameRules: GameRules;
let artMap: Map<string, ArtEntry>;

// Unit type name -> numeric ID mapping
const unitTypeIdMap = new Map<string, number>();
const unitTypeNames: string[] = [];
const buildingTypeIdMap = new Map<string, number>();

// Armour type name -> numeric ID
const armourIdMap = new Map<string, number>();

async function main() {
  console.log('Emperor: Battle for Dune - Initializing...');

  // Load rules and art ini in parallel
  const [rulesResponse, artResponse] = await Promise.all([
    fetch('/extracted/MODEL0001/Rules.txt'),
    fetch('/extracted/MODEL0001/ArtIni.txt'),
  ]);
  const [rulesText, artText] = await Promise.all([rulesResponse.text(), artResponse.text()]);

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
    idx++;
  }
  idx = 0;
  for (const armour of gameRules.armourTypes) {
    armourIdMap.set(armour, idx);
    idx++;
  }

  console.log(`Parsed: ${gameRules.units.size} units, ${gameRules.buildings.size} buildings, ${gameRules.turrets.size} turrets, ${gameRules.bullets.size} bullets, ${gameRules.warheads.size} warheads`);

  const sonicTank = gameRules.units.get('ATSonicTank');
  if (sonicTank) {
    console.log(`ATSonicTank: Cost=${sonicTank.cost}, Health=${sonicTank.health}, Speed=${sonicTank.speed}`);
  }

  // Create game and systems
  const game = new Game();

  const scene = new SceneManager();
  const terrain = new TerrainRenderer(scene);
  const input = new InputManager(scene);
  const modelManager = new ModelManager();
  const unitRenderer = new UnitRenderer(scene, modelManager, artMap);
  const selectionManager = new SelectionManager(scene, unitRenderer);
  const commandManager = new CommandManager(scene, selectionManager, unitRenderer);
  const pathfinder = new PathfindingSystem(terrain);
  const movement = new MovementSystem(pathfinder);
  const combatSystem = new CombatSystem(gameRules);
  const harvestSystem = new HarvestSystem(terrain);
  const productionSystem = new ProductionSystem(gameRules, harvestSystem);
  const minimapRenderer = new MinimapRenderer(terrain, scene);
  const aiPlayer = new AIPlayer(gameRules, combatSystem, 1, 200, 200, 60, 60);

  // Register systems
  game.addSystem(input);
  game.addSystem(movement);
  game.addSystem(combatSystem);
  game.addSystem(harvestSystem);
  game.addSystem(aiPlayer);
  game.addRenderSystem(scene);

  // Initialize
  game.init();
  terrain.generate();

  // Preload models
  const modelNames = [...gameRules.units.keys()].filter(n => n.startsWith('AT') || n.startsWith('HK'));
  await unitRenderer.preloadModels(modelNames);

  // Helper: spawn a unit entity
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

    // Combat component if unit has a weapon
    if (def.turretAttach) {
      addComponent(world, Combat, eid);
      const turret = gameRules.turrets.get(def.turretAttach);
      const bullet = turret ? gameRules.bullets.get(turret.bullet) : null;
      Combat.weaponId[eid] = 0;
      Combat.attackRange[eid] = bullet ? bullet.maxRange * 2 : 8;
      Combat.fireTimer[eid] = 0;
      Combat.rof[eid] = turret?.reloadCount ?? 30;
    }

    // Armour
    addComponent(world, Armour, eid);
    Armour.type[eid] = armourIdMap.get(def.armour) ?? 0;

    combatSystem.registerUnit(eid, typeName);

    // Set 3D model
    const art = artMap.get(typeName);
    if (art?.xaf) {
      unitRenderer.setEntityModel(eid, art.xaf);
    }

    return eid;
  }

  // Helper: spawn building
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

    // Power
    if (def.powerGenerated > 0 || def.powerUsed > 0) {
      addComponent(world, PowerSource, eid);
      PowerSource.amount[eid] = def.powerGenerated - def.powerUsed;
    }

    // Turret for defense buildings
    if (def.turretAttach) {
      addComponent(world, Combat, eid);
      addComponent(world, MoveTarget, eid);
      addComponent(world, AttackTarget, eid);
      addComponent(world, Velocity, eid);
      addComponent(world, Speed, eid);
      Speed.max[eid] = 0;
      Speed.turnRate[eid] = 0;
      MoveTarget.active[eid] = 0;
      const turret = gameRules.turrets.get(def.turretAttach);
      const bullet = turret ? gameRules.bullets.get(turret.bullet) : null;
      Combat.attackRange[eid] = bullet ? bullet.maxRange * 2 : 12;
      Combat.rof[eid] = turret?.reloadCount ?? 45;
    }

    addComponent(world, Armour, eid);
    Armour.type[eid] = armourIdMap.get(def.armour) ?? armourIdMap.get('Building') ?? 0;

    productionSystem.addPlayerBuilding(owner, typeName);

    return eid;
  }

  // AI spawn callback
  aiPlayer.setSpawnCallback((eid, typeName, owner, x, z) => {
    const world = game.getWorld();
    removeEntity(world, eid); // Remove bare entity AI created
    spawnUnit(world, typeName, owner, x, z);
  });

  // Handle unit death
  EventBus.on('unit:died', ({ entityId }) => {
    const world = game.getWorld();
    combatSystem.unregisterUnit(entityId);
    setTimeout(() => {
      try { removeEntity(world, entityId); } catch {}
    }, 500);
  });

  // Handle move commands - clear cached paths
  EventBus.on('unit:move', ({ entityIds }) => {
    for (const eid of entityIds) {
      movement.clearPath(eid);
    }
  });

  // Production system tick
  EventBus.on('game:tick', () => {
    productionSystem.update();
    const world = game.getWorld();
    unitRenderer.update(world);
    minimapRenderer.update(world);
  });

  // Sidebar build callback
  const sidebar = new Sidebar(gameRules, productionSystem, artMap, (typeName, isBuilding) => {
    const world = game.getWorld();
    if (isBuilding) {
      // For now, auto-place building near base
      const x = 50 + Math.random() * 20;
      const z = 50 + Math.random() * 20;
      if (harvestSystem.spendSolaris(0, gameRules.buildings.get(typeName)?.cost ?? 0)) {
        spawnBuilding(world, typeName, 0, x, z);
      }
    } else {
      if (harvestSystem.spendSolaris(0, gameRules.units.get(typeName)?.cost ?? 0)) {
        const x = 55 + Math.random() * 10;
        const z = 55 + Math.random() * 10;
        spawnUnit(world, typeName, 0, x, z);
      }
    }
    sidebar.refresh();
  });

  // Update sidebar progress periodically
  setInterval(() => sidebar.updateProgress(), 200);

  // --- SPAWN INITIAL UNITS FOR DEMO ---
  const world = game.getWorld();

  // Player 0 (Atreides) base area
  spawnBuilding(world, 'ATConYard', 0, 50, 50);
  spawnBuilding(world, 'ATSmWindtrap', 0, 56, 50);
  spawnBuilding(world, 'ATBarracks', 0, 44, 50);
  spawnBuilding(world, 'ATFactory', 0, 50, 56);
  spawnBuilding(world, 'ATRefinery', 0, 56, 56);

  // Starting Atreides units
  spawnUnit(world, 'ATInfantry', 0, 45, 60);
  spawnUnit(world, 'ATInfantry', 0, 47, 60);
  spawnUnit(world, 'ATInfantry', 0, 49, 60);
  spawnUnit(world, 'ATSniper', 0, 51, 60);
  spawnUnit(world, 'ATTrike', 0, 53, 62);
  spawnUnit(world, 'ATTrike', 0, 55, 62);
  spawnUnit(world, 'ATMongoose', 0, 57, 62);
  spawnUnit(world, 'ATSonicTank', 0, 60, 62);

  // Harvester
  const harvEid = spawnUnit(world, 'ATTrike', 0, 60, 58); // TODO: use actual harvester
  if (harvEid >= 0) {
    addComponent(world, Harvester, harvEid);
    Harvester.maxCapacity[harvEid] = 1.0;
    Harvester.spiceCarried[harvEid] = 0;
    Harvester.state[harvEid] = 0; // idle
    Harvester.refineryEntity[harvEid] = 0;
  }

  // Enemy (Harkonnen) base area - top-right
  spawnBuilding(world, 'HKConYard', 1, 200, 200);
  spawnBuilding(world, 'HKSmWindtrap', 1, 206, 200);
  spawnBuilding(world, 'HKBarracks', 1, 194, 200);
  spawnBuilding(world, 'HKFactory', 1, 200, 206);

  // Starting Harkonnen units
  spawnUnit(world, 'HKLightInf', 1, 195, 210);
  spawnUnit(world, 'HKLightInf', 1, 197, 210);
  spawnUnit(world, 'HKTrooper', 1, 199, 210);
  spawnUnit(world, 'HKBuzzsaw', 1, 201, 212);
  spawnUnit(world, 'HKAssault', 1, 203, 212);
  spawnUnit(world, 'HKAssault', 1, 205, 212);

  // Start!
  game.start();
  console.log('Game started - select units with click/box-drag, right-click to move, enemies auto-engage');

  // Expose for debugging
  (window as any).game = game;
  (window as any).rules = gameRules;
  (window as any).spawnUnit = (name: string, owner: number, x: number, z: number) => spawnUnit(game.getWorld(), name, owner, x, z);
}

main().catch(console.error);
