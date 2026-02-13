import { Game } from './core/Game';
import { SceneManager } from './rendering/SceneManager';
import { TerrainRenderer } from './rendering/TerrainRenderer';
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
import { VictorySystem } from './ui/VictoryScreen';
import { HouseSelect, type HouseChoice } from './ui/HouseSelect';
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

  // House selection screen
  const houseSelect = new HouseSelect(audioManager);
  const house = await houseSelect.show();

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
  const pathfinder = new PathfindingSystem(terrain);
  const movement = new MovementSystem(pathfinder);
  const combatSystem = new CombatSystem(gameRules);
  commandManager.setCombatSystem(combatSystem);
  const harvestSystem = new HarvestSystem(terrain);
  const productionSystem = new ProductionSystem(gameRules, harvestSystem);
  const minimapRenderer = new MinimapRenderer(terrain, scene);
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
  const victorySystem = new VictorySystem(audioManager, 0);

  const sandwormSystem = new SandwormSystem(terrain, effectsManager);

  // AI setup based on enemy faction
  const aiPlayer = new AIPlayer(gameRules, combatSystem, 1, 200, 200, 60, 60);
  // Override AI unit pool for the enemy faction
  aiPlayer.setUnitPool(house.enemyPrefix);
  // Connect AI to production/economy systems
  aiPlayer.setProductionSystem(productionSystem, harvestSystem);

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

    // Sell visual effect
    effectsManager.spawnExplosion(Position.x[eid], Position.y[eid], Position.z[eid], 'small');

    // Clean up from production prerequisites and combat
    if (typeName) {
      productionSystem.removePlayerBuilding(0, typeName);
    }
    combatSystem.unregisterUnit(eid);

    try { removeEntity(world, eid); } catch {}
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

    combatSystem.unregisterUnit(entityId);

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

    setTimeout(() => {
      try { removeEntity(world, entityId); } catch {}
    }, 500);
  });

  // Veterancy promotion
  EventBus.on('unit:promoted', ({ entityId, rank }) => {
    if (Owner.playerId[entityId] === 0) {
      const rankNames = ['', 'Veteran', 'Elite', 'Heroic'];
      selectionPanel.addMessage(`Unit promoted to ${rankNames[rank]}!`, '#ffd700');
    }
  });

  // Sandworm events
  EventBus.on('worm:emerge', () => {
    selectionPanel.addMessage('Worm sign detected!', '#ff8800');
  });
  EventBus.on('worm:eat', ({ ownerId }) => {
    if (ownerId === 0) {
      selectionPanel.addMessage('Unit lost to sandworm!', '#ff4444');
    }
  });

  // Rally point visuals
  EventBus.on('rally:set', ({ playerId, x, z }) => {
    effectsManager.setRallyPoint(playerId, x, z);
    selectionPanel.addMessage('Rally point set', '#44ff44');
  });

  // Projectile visuals
  EventBus.on('combat:fire', ({ attackerX, attackerZ, targetX, targetZ }) => {
    effectsManager.spawnProjectile(attackerX, 0, attackerZ, targetX, 0, targetZ);
  });

  EventBus.on('unit:move', ({ entityIds }) => {
    for (const eid of entityIds) {
      movement.clearPath(eid);
    }
  });

  // Auto-spawn produced units
  EventBus.on('production:complete', ({ unitType, owner }) => {
    const world = game.getWorld();
    const isBuilding = gameRules.buildings.has(unitType);

    if (isBuilding) {
      // Start building placement mode for player buildings
      if (owner === 0) {
        buildingPlacement.startPlacement(unitType);
      } else {
        // AI auto-places buildings near base
        const x = 200 + (Math.random() - 0.5) * 20;
        const z = 200 + (Math.random() - 0.5) * 20;
        spawnBuilding(world, unitType, owner, x, z);
      }
    } else {
      // Spawn unit near appropriate building
      const prefix = owner === 0 ? house.prefix : house.enemyPrefix;
      const baseX = owner === 0 ? 55 : 200;
      const baseZ = owner === 0 ? 55 : 200;
      const x = baseX + (Math.random() - 0.5) * 10;
      const z = baseZ + (Math.random() - 0.5) * 10;
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

  EventBus.on('game:tick', () => {
    const world = game.getWorld();

    productionSystem.update();
    unitRenderer.update(world);
    unitRenderer.tickConstruction();
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
      const powerMult = powerGen >= powerUsed ? 1.0 : 0.5;
      productionSystem.setPowerMultiplier(0, powerMult);
      combatSystem.setPowerMultiplier(0, powerMult);
      if (powerMult < 1.0 && powerUsed > 0 && game.getTickCount() % 250 === 0) {
        audioManager.playSfx('powerlow');
        selectionPanel.addMessage('Low power! Build more Windtraps', '#ff4444');
      }

      // AI always gets full power (simplification - AI builds enough windtraps)
      productionSystem.setPowerMultiplier(1, 1.0);
      combatSystem.setPowerMultiplier(1, 1.0);
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
  }, house.prefix);

  setInterval(() => sidebar.updateProgress(), 200);

  // Help overlay toggle
  const helpOverlay = document.getElementById('help-overlay');

  // Track last combat event position for Space key
  let lastEventX = 55, lastEventZ = 55;
  EventBus.on('unit:died', ({ entityId }) => {
    lastEventX = Position.x[entityId];
    lastEventZ = Position.z[entityId];
  });
  EventBus.on('worm:emerge', ({ x, z }) => { lastEventX = x; lastEventZ = z; });

  window.addEventListener('keydown', (e) => {
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      if (helpOverlay) {
        helpOverlay.style.display = helpOverlay.style.display === 'none' ? 'block' : 'none';
      }
    } else if (e.key === 'Escape' && helpOverlay?.style.display === 'block') {
      helpOverlay.style.display = 'none';
    } else if (e.key === 'h' && !e.ctrlKey && !e.altKey) {
      // Snap to base (construction yard)
      scene.cameraTarget.set(50, 0, 50);
      scene.updateCameraPosition();
    } else if (e.key === ' ' && !e.ctrlKey) {
      // Snap to last event
      e.preventDefault();
      scene.cameraTarget.set(lastEventX, 0, lastEventZ);
      scene.updateCameraPosition();
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
    } else if (e.key === 'F9') {
      e.preventDefault();
      game.pause();
      selectionPanel.addMessage(game.isPaused() ? 'Game Paused' : 'Game Resumed', '#888');
    }
  });

  // --- SPAWN INITIAL ENTITIES ---
  const world = game.getWorld();

  // Player base
  const px = house.prefix;
  spawnBuilding(world, `${px}ConYard`, 0, 50, 50);
  spawnBuilding(world, `${px}SmWindtrap`, 0, 56, 50);
  spawnBuilding(world, `${px}Barracks`, 0, 44, 50);
  spawnBuilding(world, `${px}Factory`, 0, 50, 56);
  spawnBuilding(world, `${px}Refinery`, 0, 56, 56);

  // Starting player units - find available unit types for the house
  const playerInfantry = [...gameRules.units.keys()].filter(n => n.startsWith(px) && gameRules.units.get(n)?.infantry);
  const playerVehicles = [...gameRules.units.keys()].filter(n => n.startsWith(px) && !gameRules.units.get(n)?.infantry && gameRules.units.get(n)!.cost > 0);

  // Spawn 3 infantry
  for (let i = 0; i < 3 && i < playerInfantry.length; i++) {
    spawnUnit(world, playerInfantry[i], 0, 45 + i * 2, 60);
  }
  // Spawn 4 vehicles
  for (let i = 0; i < 4 && i < playerVehicles.length; i++) {
    spawnUnit(world, playerVehicles[i], 0, 53 + i * 2, 62);
  }

  // Harvester
  const harvTypes = [...gameRules.units.keys()].filter(n => n.startsWith(px) && (n.includes('Harv') || n.includes('harvester')));
  if (harvTypes.length > 0) {
    spawnUnit(world, harvTypes[0], 0, 60, 58);
  } else {
    // Fallback: make a trike into a harvester
    const fallbackVehicle = playerVehicles[0];
    if (fallbackVehicle) {
      const harvEid = spawnUnit(world, fallbackVehicle, 0, 60, 58);
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
  spawnBuilding(world, `${ex}ConYard`, 1, 200, 200);
  spawnBuilding(world, `${ex}SmWindtrap`, 1, 206, 200);
  spawnBuilding(world, `${ex}Barracks`, 1, 194, 200);
  spawnBuilding(world, `${ex}Factory`, 1, 200, 206);
  spawnBuilding(world, `${ex}SmWindtrap`, 1, 206, 206);
  spawnBuilding(world, `${ex}Refinery`, 1, 194, 206);

  // Enemy starting units
  const enemyInfantry = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && gameRules.units.get(n)?.infantry);
  const enemyVehicles = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && !gameRules.units.get(n)?.infantry && gameRules.units.get(n)!.cost > 0 && !gameRules.units.get(n)!.canFly);

  for (let i = 0; i < 3 && i < enemyInfantry.length; i++) {
    spawnUnit(world, enemyInfantry[i], 1, 195 + i * 2, 210);
  }
  for (let i = 0; i < 3 && i < enemyVehicles.length; i++) {
    spawnUnit(world, enemyVehicles[i], 1, 201 + i * 2, 212);
  }

  // Enemy harvester
  const enemyHarvTypes = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && (n.includes('Harv') || n.includes('harvester')));
  if (enemyHarvTypes.length > 0) {
    spawnUnit(world, enemyHarvTypes[0], 1, 195, 212);
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
