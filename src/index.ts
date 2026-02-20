import * as THREE from 'three';
import { parseRules, type GameRules } from './config/RulesParser';
import { parseArtIni } from './config/ArtIniParser';
import { loadConstants } from './utils/Constants';
import { AudioManager } from './audio/AudioManager';
import { HouseSelect, type HouseChoice, type GameMode, type Difficulty } from './ui/HouseSelect';
import { loadMap, getCampaignMapId, getSpecialMissionMapId } from './config/MapLoader';
import { CampaignMap } from './ui/CampaignMap';
import { loadCampaignStrings, type HousePrefix, JUMP_POINTS } from './campaign/CampaignData';
import { CampaignPhaseManager } from './campaign/CampaignPhaseManager';
import { showMissionBriefing } from './ui/MissionBriefing';
import { generateMissionConfig, type MissionConfigData } from './campaign/MissionConfig';
import { deriveMissionRuntimeSettings, type MissionRuntimeSettings } from './campaign/MissionRuntime';
import { PauseMenu } from './ui/PauseMenu';
import { EventBus } from './core/EventBus';
import type { SaveData } from './core/GameContext';
import { buildTypeRegistries } from './core/TypeRegistry';
import { updateLoading } from './utils/GameHelpers';
import { initializeSystems } from './core/SystemInit';
import { registerEventHandlers } from './core/EventHandlers';
import { registerTickHandler } from './core/GameTickHandler';
import { registerInputHandlers } from './input/GameInputHandlers';
import { setupGameUI } from './ui/GameUI';
import { spawnFreshGame } from './core/FreshGameSpawn';
import { restoreFromSave } from './core/SaveLoadSystem';
import { hasComponent, Harvester, Owner } from './core/ECS';

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
  const gameRules = parseRules(rulesText);
  const artMap = parseArtIni(artText);
  loadConstants(gameRules.general);

  // Build type registries
  const typeRegistry = buildTypeRegistries(gameRules);
  console.log(`Parsed: ${gameRules.units.size} units, ${gameRules.buildings.size} buildings`);

  // Audio manager (created early for menu music)
  const audioManager = new AudioManager();
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

  let activeMissionConfig: MissionConfigData | null = savedGame?.missionConfig ?? null;
  let activeMapId: string | null = savedGame?.mapId ?? null;
  let missionRuntime: MissionRuntimeSettings | null = null;

  // Create WebGLRenderer early
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
  } catch (e) {
    console.warn('WebGL renderer creation failed, using DOM menus:', e);
  }

  // --- HOUSE SELECTION (pre-game flow) ---
  let house: HouseChoice;
  if (savedGame) {
    const restoredMapChoice = savedGame.mapChoice ?? (savedGame.mapId ? {
      id: savedGame.mapId, name: savedGame.mapId, seed: 0,
      description: 'Restored save map', mapId: savedGame.mapId,
    } : undefined);

    house = {
      id: savedGame.housePrefix.toLowerCase(),
      name: savedGame.houseName,
      prefix: savedGame.housePrefix,
      color: '#ffffff',
      description: '',
      enemyPrefix: savedGame.enemyPrefix,
      enemyName: savedGame.enemyName,
      difficulty: (savedGame.difficulty ?? 'normal') as Difficulty,
      gameMode: (savedGame.gameMode ?? 'skirmish') as GameMode,
      mapChoice: restoredMapChoice,
      skirmishOptions: savedGame.skirmishOptions,
      opponents: savedGame.opponents,
      campaignTerritoryId: savedGame.campaignTerritoryId,
      subhouse: savedGame.subhouse,
    };

    if (house.gameMode === 'campaign') await loadCampaignStrings();
    const loadScreen = document.getElementById('loading-screen');
    if (loadScreen) loadScreen.style.display = 'flex';
  } else {
    const loadScreenEl = document.getElementById('loading-screen');
    const uiOverlay = document.getElementById('ui-overlay');
    if (loadScreenEl) loadScreenEl.style.display = 'none';
    if (uiOverlay) uiOverlay.style.display = 'none';
    const houseSelect = new HouseSelect(audioManager, sharedRenderer ? gameCanvas : undefined, sharedRenderer ?? undefined);
    house = await houseSelect.show();
    if (uiOverlay) uiOverlay.style.display = '';

    if (house.gameMode === 'campaign') await loadCampaignStrings();

    // Show mission briefing for campaign mode
    if (house.gameMode === 'campaign' && house.campaignTerritoryId !== undefined) {
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
            activeMissionConfig = missionConfig;
            house.enemyPrefix = enemyHouse;
            const enemyNames: Record<string, string> = { AT: 'Atreides', HK: 'Harkonnen', OR: 'Ordos' };
            house.enemyName = enemyNames[enemyHouse] ?? house.enemyName;
          }
        } catch { /* use defaults */ }
      }
      activeMissionConfig = missionConfig ?? null;

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

    if (loadScreenEl) loadScreenEl.style.display = 'flex';
  }

  console.log(`Playing as ${house.name} vs ${house.enemyName}`);
  audioManager.setPlayerFaction(house.prefix);
  audioManager.startGameMusic();
  audioManager.startAmbientWind();

  // Ensure renderer exists
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({
      canvas: gameCanvas, antialias: true, powerPreference: 'high-performance',
    });
    sharedRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    sharedRenderer.setSize(window.innerWidth, window.innerHeight);
  }

  // --- CAMPAIGN VICTORY/DEFEAT WIRING ---
  // (stays here because it needs CampaignMap which runs before systems)
  let campaignRef: InstanceType<typeof CampaignMap> | null = null;
  let phaseManagerRef: ReturnType<InstanceType<typeof CampaignMap>['getPhaseManager']> | null = null;
  if (house.gameMode === 'campaign' && house.campaignTerritoryId !== undefined) {
    const campaign = new CampaignMap(audioManager, house.prefix, house.name, house.enemyPrefix, house.enemyName);
    const phaseManager = campaign.getPhaseManager();
    const phaseType = phaseManager.getPhaseType();
    const phase = phaseManager.getCurrentPhase();

    if (!activeMissionConfig) {
      const cState = campaign.getState();
      const territory = cState.territories.find(t => t.id === house.campaignTerritoryId);
      if (territory) {
        const playerCount = cState.territories.filter(t => t.owner === 'player').length;
        const enemyCount = cState.territories.filter(t => t.owner === 'enemy' || t.owner === 'enemy2').length;
        const enemyHouse = territory.ownerHouse !== 'neutral' && territory.ownerHouse !== cState.housePrefix
          ? territory.ownerHouse as HousePrefix : cState.enemyPrefix as HousePrefix;
        activeMissionConfig = generateMissionConfig({
          playerHouse: cState.housePrefix as HousePrefix,
          phase, phaseType,
          territoryId: house.campaignTerritoryId,
          territoryName: territory.name,
          enemyHouse,
          isAttack: territory.owner !== 'player',
          territoryDiff: playerCount - enemyCount,
          subHousePresent: null,
        });
      }
    }

    missionRuntime = deriveMissionRuntimeSettings({ missionConfig: activeMissionConfig, phaseType, phase });
    // Store for wiring after ctx is created
    campaignRef = campaign;
    phaseManagerRef = phaseManager;
  }

  // --- INITIALIZE ALL SYSTEMS ---
  updateLoading(30, 'Initializing game systems...');

  const ctx = initializeSystems({
    gameRules, artMap, typeRegistry, house, audioManager,
    sharedRenderer,
    activeMissionConfig, activeMapId, missionRuntime,
  });

  // Wire campaign callbacks to victory system
  if (missionRuntime) {
    ctx.victorySystem.setVictoryCondition(missionRuntime.victoryCondition);
    ctx.victorySystem.setObjectiveLabel(missionRuntime.objectiveLabel);
    ctx.victorySystem.setSurvivalTicks(missionRuntime.timedObjectiveTicks);
    ctx.victorySystem.setProtectedBuildingToken('ConYard');

    const techLevel = phaseManagerRef!.getCurrentTechLevel();
    ctx.productionSystem.setOverrideTechLevel(0, techLevel);

    ctx.victorySystem.setVictoryCallback(() => {
      const targetTerritory = campaignRef!.getState().territories.find(t => t.id === house.campaignTerritoryId);
      const capturedTerritory = targetTerritory ? targetTerritory.owner !== 'player' : true;
      const playerJP = JUMP_POINTS[house.prefix as HousePrefix];
      const isJumpPoint = Object.values(JUMP_POINTS).some(jp => jp === house.campaignTerritoryId && jp !== playerJP);
      campaignRef!.recordVictory(house.campaignTerritoryId!);
      phaseManagerRef!.recordBattleResult(true, capturedTerritory, isJumpPoint);
      campaignRef!.saveCampaign();
    });

    ctx.victorySystem.setDefeatCallback(() => {
      phaseManagerRef!.recordBattleResult(false, false, false);
      campaignRef!.recordDefeat();
    });

    ctx.victorySystem.setCampaignContinue(async () => {
      const phState = phaseManagerRef!.getState();
      if (phState.isVictory) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:3000;font-family:inherit;';
        overlay.innerHTML = `<div style="color:#f0c040;font-size:48px;font-weight:bold;text-shadow:0 0 20px #f0c04060;margin-bottom:12px;">CAMPAIGN COMPLETE</div><div style="color:#ccc;font-size:18px;margin-bottom:8px;">House ${house.name} has conquered Arrakis!</div><div style="color:#888;font-size:14px;margin-bottom:24px;">The spice must flow under your command.</div>`;
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
        overlay.innerHTML = `<div style="color:#cc4444;font-size:48px;font-weight:bold;margin-bottom:12px;">CAMPAIGN LOST</div><div style="color:#ccc;font-size:18px;margin-bottom:24px;">House ${house.name} has fallen on Arrakis.</div>`;
        const menuBtn = document.createElement('button');
        menuBtn.textContent = 'Return to Menu';
        menuBtn.style.cssText = 'padding:12px 36px;font-size:16px;background:#cc444422;border:2px solid #cc4444;color:#fff;cursor:pointer;';
        menuBtn.onclick = () => { localStorage.removeItem('ebfd_campaign'); window.location.reload(); };
        overlay.appendChild(menuBtn);
        document.body.appendChild(overlay);
        return;
      }
      const choice = await campaignRef!.show();
      if (choice) {
        localStorage.setItem('ebfd_campaign_next', JSON.stringify({
          territoryId: choice.territory.id, difficulty: choice.difficulty, mapSeed: choice.mapSeed,
        }));
        window.location.reload();
      } else {
        window.location.reload();
      }
    });
  }

  // Apply skirmish/campaign credits
  const desiredCreditsByPlayer = new Map<number, number>();
  if (house.skirmishOptions && house.gameMode === 'skirmish') {
    const opts = house.skirmishOptions;
    if (!savedGame) {
      desiredCreditsByPlayer.set(0, opts.startingCredits);
      for (let i = 0; i < ctx.opponents.length; i++) desiredCreditsByPlayer.set(i + 1, opts.startingCredits);
    }
    ctx.productionSystem.setMaxUnits(opts.unitCap);
  }
  if (!savedGame && missionRuntime) {
    if (missionRuntime.playerStartingCredits !== null) desiredCreditsByPlayer.set(0, missionRuntime.playerStartingCredits);
    if (missionRuntime.aiStartingCredits !== null) {
      for (let i = 0; i < ctx.opponents.length; i++) desiredCreditsByPlayer.set(i + 1, missionRuntime.aiStartingCredits);
    }
  }
  if (!savedGame && house.gameMode === 'skirmish') {
    for (let i = 0; i < ctx.opponents.length; i++) {
      if (ctx.opponents[i].difficulty === 'hard') {
        const pid = i + 1;
        desiredCreditsByPlayer.set(pid, (desiredCreditsByPlayer.get(pid) ?? 5000) + 3000);
      }
    }
  }

  // Register systems
  ctx.game.addSystem(ctx.input);
  ctx.game.addSystem(ctx.movement);
  ctx.game.addSystem(ctx.combatSystem);
  ctx.game.addSystem(ctx.harvestSystem);
  for (const ai of ctx.aiPlayers) ctx.game.addSystem(ai);
  ctx.game.addSystem(ctx.sandwormSystem);
  ctx.game.addRenderSystem(ctx.scene);

  // Initialize
  ctx.game.init();
  ctx.harvestSystem.setPlayerCount(ctx.totalPlayers);
  for (let i = 2; i < ctx.totalPlayers; i++) ctx.harvestSystem.addSolaris(i, 5000);
  if (!savedGame && desiredCreditsByPlayer.size > 0) {
    for (const [playerId, targetCredits] of desiredCreditsByPlayer) {
      const current = ctx.harvestSystem.getSolaris(playerId);
      if (current !== targetCredits) ctx.harvestSystem.addSolaris(playerId, targetCredits - current);
    }
  }

  // --- LOAD TERRAIN ---
  updateLoading(40, 'Loading terrain...');
  let realMapId: string | undefined;
  if (savedGame?.mapId) {
    realMapId = savedGame.mapId;
  } else if (house.mapChoice?.mapId) {
    realMapId = house.mapChoice.mapId;
  } else if (house.gameMode === 'campaign') {
    const savedCampaignStr = localStorage.getItem('ebfd_campaign');
    if (savedCampaignStr) {
      try {
        const cState = JSON.parse(savedCampaignStr);
        const pm = CampaignPhaseManager.deserialize(cState.phaseState);
        const pType = pm.getPhaseType();
        if (pType !== 'act' && pType !== 'tutorial') {
          realMapId = getSpecialMissionMapId(pType, house.prefix) ?? undefined;
        }
      } catch { /* fall through */ }
    }
    if (!realMapId && house.campaignTerritoryId) {
      realMapId = getCampaignMapId(house.campaignTerritoryId, house.prefix) ?? undefined;
    }
  }
  ctx.activeMapId = realMapId ?? null;

  let mapLoaded = false;
  if (realMapId) {
    const mapData = await loadMap(realMapId);
    if (mapData) {
      await ctx.terrain.loadFromMapData(mapData);
      mapLoaded = true;
      console.log(`Loaded real map: ${realMapId} (${mapData.width}×${mapData.height})`);
    }
  }
  if (!mapLoaded) {
    if (house.mapChoice) ctx.terrain.setMapSeed(house.mapChoice.seed);
    await ctx.terrain.generate();
    ctx.activeMapId = null;
  }

  // Update systems with actual map dimensions
  const mapW = ctx.terrain.getMapWidth(), mapH = ctx.terrain.getMapHeight();
  for (const ai of ctx.aiPlayers) ai.setMapDimensions(mapW, mapH);
  ctx.fogOfWar.reinitialize();
  ctx.minimapRenderer.renderTerrain();
  ctx.scene.setMapBounds(mapW * 2, mapH * 2);
  ctx.movement.setMapBounds(mapW * 2, mapH * 2);
  ctx.movement.setTerrain(ctx.terrain);

  // --- LOAD MODELS ---
  updateLoading(45, 'Loading model manifest...');
  await ctx.modelManager.loadManifest();

  updateLoading(50, 'Loading unit models...');
  const allUnitNames = [...gameRules.units.keys()];
  await ctx.unitRenderer.preloadModels(allUnitNames, (done, total, name) => {
    updateLoading(50 + Math.round((done / total) * 25), `Loading unit models... (${done}/${total})`, name);
  });

  updateLoading(75, 'Loading building models...');
  const factionPrefixes = ['AT', 'HK', 'OR', 'FR', 'IM', 'IX', 'TL', 'GU', 'IN'];
  const allBuildingNames = [...gameRules.buildings.keys()].filter(name => {
    const def = gameRules.buildings.get(name)!;
    const art = artMap.get(name);
    return art?.xaf && def.cost > 0 && factionPrefixes.some(p => name.startsWith(p));
  });
  await ctx.unitRenderer.preloadBuildingModels(allBuildingNames, (done, total, name) => {
    updateLoading(75 + Math.round((done / total) * 13), `Loading building models... (${done}/${total})`, name);
  });
  ctx.unitRenderer.resolvePendingModels();

  updateLoading(88, 'Rendering icons...', 'Production thumbnails');
  const iconNames = [...allUnitNames, ...allBuildingNames].map(n => artMap.get(n)?.xaf ?? n);
  await ctx.iconRenderer.renderIcons(iconNames, ctx.modelManager);

  updateLoading(88, 'Loading audio samples...', 'Sound effects');
  await audioManager.preloadSfx();
  updateLoading(89, 'Loading voice lines...', house.name + ' faction voices');
  await audioManager.preloadVoices(house.prefix);
  updateLoading(90, 'Loading dialog lines...', 'Advisor callouts');
  audioManager.initDialog();
  await audioManager.preloadDialog(house.prefix);

  updateLoading(92, 'Spawning bases...', 'Placing starting structures');

  // --- REGISTER EVENT HANDLERS & TICK ---
  registerEventHandlers(ctx);
  registerTickHandler(ctx);

  // --- PAUSE MENU ---
  const pauseMenu = new PauseMenu({
    audioManager,
    selectionPanel: ctx.selectionPanel,
    gameRules,
    getTickCount: () => ctx.game.getTickCount(),
    setSpeed: (speed: number) => ctx.game.setSpeed(speed),
    pause: () => ctx.game.pause(),
    buildSaveData: () => ctx.buildSaveData(),
    setScrollSpeed: (m: number) => ctx.input.setScrollSpeed(m),
    setFogEnabled: (v: boolean) => ctx.fogOfWar.setEnabled(v),
    isFogEnabled: () => ctx.fogOfWar.isEnabled(),
    setDamageNumbers: (v: boolean) => ctx.damageNumbers.setEnabled(v),
    isDamageNumbers: () => ctx.damageNumbers.isEnabled(),
    setRangeCircles: (v: boolean) => ctx.unitRenderer.setRangeCircleEnabled(v),
    isRangeCircles: () => ctx.unitRenderer.isRangeCircleEnabled(),
  });

  registerInputHandlers(ctx, pauseMenu);
  setupGameUI(ctx);

  // --- SPAWN OR RESTORE ---
  const world = ctx.game.getWorld();
  ctx.harvestSystem.setBuildingContext(world, typeRegistry.buildingTypeNames);

  if (savedGame) {
    restoreFromSave(ctx, savedGame);
  } else {
    spawnFreshGame(ctx);
  }

  // --- DIALOG MANAGER ---
  const dialogManager = audioManager.getDialogManager();
  if (dialogManager) {
    dialogManager.setPlayerFaction(house.prefix);
    dialogManager.wireEvents(0, (eid: number) => Owner.playerId[eid]);
    dialogManager.setHarvesterChecker(
      (eid: number) => { try { return hasComponent(ctx.game.getWorld(), Harvester, eid); } catch { return false; } },
      0,
      (eid: number) => Owner.playerId[eid]
    );
  }

  // --- START ---
  ctx.game.start();
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
  (window as any).game = ctx.game;
  (window as any).rules = gameRules;
  (window as any).fogOfWar = ctx.fogOfWar;
  (window as any).spawnUnit = (name: string, owner: number, x: number, z: number) => ctx.spawnUnit(ctx.game.getWorld(), name, owner, x, z);
  (window as any).spawnBuilding = (name: string, owner: number, x: number, z: number) => ctx.spawnBuilding(ctx.game.getWorld(), name, owner, x, z);
  (window as any).sandworm = ctx.sandwormSystem;
  (window as any).debug = {
    modelReport() {
      const report = ctx.modelManager.getLoadReport();
      console.log(`%cModel Load Report`, 'font-size:14px;font-weight:bold;color:#0af');
      console.log(`  Loaded: ${report.loaded.length} | Failed: ${report.failed.length} | Total: ${report.total}`);
      if (report.loaded.length > 0) {
        console.log('%cLoaded models:', 'color:#4f4');
        for (const name of report.loaded) {
          const result = ctx.modelManager.getLoadResults().get(name);
          console.log(`  + ${name} -> ${result?.url ?? '?'}`);
        }
      }
      if (report.failed.length > 0) {
        console.log('%cFailed models:', 'color:#f44;font-weight:bold');
        for (const name of report.failed) {
          const result = ctx.modelManager.getLoadResults().get(name);
          console.log(`  - ${name}: ${result?.error ?? 'unknown'}`);
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
        runEvalChecklist(ctx.modelManager, gameRules, artMap, ctx.productionSystem, ctx.unitRenderer);
      } catch (e) {
        console.warn('EvalChecklist module not available:', e);
      }
    },
  };
}

main().catch(console.error);
