import * as THREE from 'three';
import { parseRules, type GameRules } from './config/RulesParser';
import { parseArtIni } from './config/ArtIniParser';
import { loadConstants, loadSpiceMoundConfig } from './utils/Constants';
import { AudioManager } from './audio/AudioManager';
import { HouseSelect, type HouseChoice, type GameMode, type Difficulty } from './ui/HouseSelect';
import { loadMap, loadMapManifest, getMapMetadata, getCampaignMapId, getSpecialMissionMapId } from './config/MapLoader';
import { CampaignMap } from './ui/CampaignMap';
import { loadCampaignStrings, loadMissionMessages, type HousePrefix, JUMP_POINTS, getForcedMission } from './campaign/CampaignData';
import { CampaignPhaseManager, loadPhaseRules } from './campaign/CampaignPhaseManager';
import { SubHouseSystem, type AllianceSubHouse } from './campaign/SubHouseSystem';
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
import { simRng } from './utils/DeterministicRNG';
import { restoreFromSave } from './core/SaveLoadSystem';
import { hasComponent, Harvester, Owner, Position, BuildingType as BT, buildingQuery, removeEntity } from './core/ECS';
import { loadDisplayNames } from './config/DisplayNames';
import { isAgentMode, getAgentConfig, pickTerritoryWithContext, startAgent, stopAgent } from './ai/CampaignAgent';
import { AIPlayer } from './ai/AIPlayer';
import { startConsoleCapture, createTelemetrySystem } from './ai/AgentTelemetry';
import { loadOriginalAIData } from './ai/OriginalAIData';
import { isEditorMode, launchEditor } from './editor/EditorEntry';

async function main() {
  // Check for ?mode=editor to launch standalone map editor (no game systems)
  if (isEditorMode()) {
    await launchEditor();
    return;
  }

  // Check for ?agent=XX URL param to start agent mode (without reload)
  const urlParams = new URLSearchParams(window.location.search);
  const agentParam = urlParams.get('agent')?.toUpperCase();

  // Start console capture ASAP so loading errors are captured
  if (agentParam || isAgentMode()) {
    startConsoleCapture();
  }

  if (agentParam && (agentParam === 'AT' || agentParam === 'HK' || agentParam === 'OR')) {
    // Always force-set config when URL param is present
    if (!isAgentMode()) {
      localStorage.removeItem('ebfd_campaign');
      localStorage.removeItem('ebfd_campaign_next');
    }
    localStorage.setItem('ebfd_agent', JSON.stringify({
      house: agentParam, strategy: 'balanced', civilWarChoice: 'copec',
      missionCount: getAgentConfig()?.missionCount ?? 0,
    }));
    console.log(`[Agent] Activated via URL param: House ${agentParam}`);
  }
  const isAgent = isAgentMode();
  const agentConfig = getAgentConfig();
  if (isAgent) console.log('[Agent] Mode detected. Config:', JSON.stringify(agentConfig));
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
  loadSpiceMoundConfig(gameRules.spiceMound);

  // Load extracted game data (display names, etc.) — non-blocking
  loadDisplayNames();

  // Load original AI data files in background (non-blocking)
  const originalAIDataPromise = loadOriginalAIData().catch(err => {
    console.warn('[OriginalAI] Failed to load AI data:', err);
    return null;
  });

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

    if (house.gameMode === 'campaign') { await loadCampaignStrings(); await loadMissionMessages(); await loadPhaseRules(); }
    const loadScreen = document.getElementById('loading-screen');
    if (loadScreen) loadScreen.style.display = 'flex';
  } else if (isAgent && agentConfig) {
    // --- AGENT MODE: bypass all UI ---
    console.log('[Agent] Entering agent mode bypass. Config:', agentConfig);
    try {
    await loadCampaignStrings();
    await loadMissionMessages();
    await loadPhaseRules();

    const nextMission = localStorage.getItem('ebfd_campaign_next');
    if (nextMission) {
      // Auto-continue path: ebfd_campaign_next already set from previous mission
      localStorage.removeItem('ebfd_campaign_next');
      const next = JSON.parse(nextMission);
      const rawCampaign = localStorage.getItem('ebfd_campaign');
      if (!rawCampaign) { stopAgent(); return; }
      const campaignState = JSON.parse(rawCampaign);
      const houseMap: Record<string, { name: string; enemyPrefix: string; enemyName: string }> = {
        'AT': { name: 'Atreides', enemyPrefix: 'HK', enemyName: 'Harkonnen' },
        'HK': { name: 'Harkonnen', enemyPrefix: 'AT', enemyName: 'Atreides' },
        'OR': { name: 'Ordos', enemyPrefix: 'HK', enemyName: 'Harkonnen' },
      };
      const info = houseMap[campaignState.housePrefix] ?? houseMap['AT'];
      house = {
        id: campaignState.housePrefix.toLowerCase(),
        name: info.name,
        prefix: campaignState.housePrefix,
        color: '#f0c040',
        description: '',
        enemyPrefix: campaignState.enemyPrefix ?? info.enemyPrefix,
        enemyName: campaignState.enemyHouse ?? info.enemyName,
        difficulty: next.difficulty ?? 'normal',
        gameMode: 'campaign',
        campaignTerritoryId: next.territoryId,
        mapChoice: { id: `campaign-${next.territoryId}`, name: 'Campaign Mission', seed: next.mapSeed, description: '' },
      };
    } else {
      // First mission or fresh start: create campaign, pick territory
      const hp = agentConfig.house;
      const houseNames: Record<string, { name: string; enemyPrefix: string; enemyName: string }> = {
        'AT': { name: 'Atreides', enemyPrefix: 'HK', enemyName: 'Harkonnen' },
        'HK': { name: 'Harkonnen', enemyPrefix: 'AT', enemyName: 'Atreides' },
        'OR': { name: 'Ordos', enemyPrefix: 'HK', enemyName: 'Harkonnen' },
      };
      const hInfo = houseNames[hp] ?? houseNames['AT'];
      const campaign = new CampaignMap(audioManager, hp, hInfo.name, hInfo.enemyPrefix, hInfo.enemyName);
      const attackable = campaign.getAttackableTerritories();
      const picked = pickTerritoryWithContext(
        attackable,
        campaign.getState().territories,
        campaign.getPhaseManager(),
        hp,
      );
      campaign.saveCampaign();

      const phase = campaign.getPhaseManager().getCurrentPhase();
      const playerCount = campaign.getState().territories.filter(t => t.owner === 'player').length;
      console.log(`[Agent] Active: House ${hInfo.name} | Phase ${phase} | Tech ${campaign.getPhaseManager().getCurrentTechLevel()} | ${playerCount}/33 territories`);
      console.log(`[Agent] Selected territory: ${picked.name} (id=${picked.id}, difficulty=${picked.difficulty})`);

      house = {
        id: hp.toLowerCase(),
        name: hInfo.name,
        prefix: hp,
        color: '#f0c040',
        description: '',
        enemyPrefix: hInfo.enemyPrefix,
        enemyName: hInfo.enemyName,
        difficulty: picked.difficulty,
        gameMode: 'campaign',
        campaignTerritoryId: picked.id,
        mapChoice: { id: `campaign-${picked.id}`, name: picked.name, seed: picked.mapSeed, description: '' },
      };
    }

    const loadScreenEl = document.getElementById('loading-screen');
    if (loadScreenEl) loadScreenEl.style.display = 'flex';
    } catch (err) {
      console.error('[Agent] Error in agent startup, falling back to manual:', err);
      stopAgent();
      return;
    }
  } else {
    const loadScreenEl = document.getElementById('loading-screen');
    const uiOverlay = document.getElementById('ui-overlay');
    if (loadScreenEl) loadScreenEl.style.display = 'none';
    if (uiOverlay) uiOverlay.style.display = 'none';
    const houseSelect = new HouseSelect(audioManager, sharedRenderer ? gameCanvas : undefined, sharedRenderer ?? undefined);
    house = await houseSelect.show();
    if (uiOverlay) uiOverlay.style.display = '';

    if (house.gameMode === 'campaign') { await loadCampaignStrings(); await loadMissionMessages(); await loadPhaseRules(); }

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
            // Detect sub-house involvement for this mission
            let subHousePresent: AllianceSubHouse | null = null;
            if (cState.subHouseState) {
              const tempSubSys = SubHouseSystem.deserialize(cState.subHouseState, cState.housePrefix as HousePrefix);
              subHousePresent = tempSubSys.getMissionSubHouse(phaseManager.getCurrentPhase(), house.campaignTerritoryId!) ?? null;
            }
            missionConfig = generateMissionConfig({
              playerHouse: cState.housePrefix as HousePrefix,
              phase: phaseManager.getCurrentPhase(),
              phaseType: phaseManager.getPhaseType(),
              territoryId: house.campaignTerritoryId,
              territoryName: territory.name,
              enemyHouse,
              isAttack: territory.owner !== 'player',
              territoryDiff: playerCount - enemyCount,
              subHousePresent,
            });
            activeMissionConfig = missionConfig;
            house.enemyPrefix = enemyHouse;
            const enemyNames: Record<string, string> = { AT: 'Atreides', HK: 'Harkonnen', OR: 'Ordos' };
            house.enemyName = enemyNames[enemyHouse] ?? house.enemyName;
          }
        } catch { /* use defaults */ }
      }
      activeMissionConfig = missionConfig ?? null;

      if (!isAgent) {
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
    }

    if (loadScreenEl) loadScreenEl.style.display = 'flex';
  }

  console.log(`Playing as ${house.name} vs ${house.enemyName}`);
  audioManager.setPlayerFaction(house.prefix);
  audioManager.startGameMusic();
  audioManager.startAmbientWind();
  if (isAgent) audioManager.toggleMute();

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
        const subSys2 = campaign.getSubHouseSystem();
        const missionSH = subSys2.getMissionSubHouse(phase, house.campaignTerritoryId!) ?? null;
        activeMissionConfig = generateMissionConfig({
          playerHouse: cState.housePrefix as HousePrefix,
          phase, phaseType,
          territoryId: house.campaignTerritoryId,
          territoryName: territory.name,
          enemyHouse,
          isAttack: territory.owner !== 'player',
          territoryDiff: playerCount - enemyCount,
          subHousePresent: missionSH,
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

  // Await original AI data (loaded in background during house selection)
  const originalAIData = await originalAIDataPromise;

  // Seed deterministic RNG before system init so storm timer etc. use correct seed
  // Hash map ID string into a numeric seed (simple DJB2 hash)
  let mapIdSeed = activeMapId ? 5381 : 0;
  if (activeMapId) {
    for (let i = 0; i < activeMapId.length; i++) {
      mapIdSeed = ((mapIdSeed << 5) + mapIdSeed + activeMapId.charCodeAt(i)) | 0;
    }
  }
  const rngSeed = house.mapChoice?.seed ?? (mapIdSeed || Date.now());
  simRng.reseed(rngSeed);

  const ctx = initializeSystems({
    gameRules, artMap, typeRegistry, house, audioManager,
    sharedRenderer,
    activeMissionConfig, activeMapId, missionRuntime, originalAIData,
  });

  // Wire campaign callbacks to victory system
  if (missionRuntime) {
    ctx.victorySystem.setVictoryCondition(missionRuntime.victoryCondition);
    ctx.victorySystem.setObjectiveLabel(missionRuntime.objectiveLabel);
    ctx.victorySystem.setSurvivalTicks(missionRuntime.timedObjectiveTicks);
    ctx.victorySystem.setProtectedBuildingToken('ConYard');

    const techLevel = phaseManagerRef!.getCurrentTechLevel();
    ctx.productionSystem.setOverrideTechLevel(0, techLevel);

    // Track battle result for civil war handling in campaign continue
    let lastBattleResult: { civilWarChoice: boolean } | null = null;

    ctx.victorySystem.setVictoryCallback(() => {
      const targetTerritory = campaignRef!.getState().territories.find(t => t.id === house.campaignTerritoryId);
      const capturedTerritory = targetTerritory ? targetTerritory.owner !== 'player' : true;
      const playerJP = JUMP_POINTS[house.prefix as HousePrefix];
      const isJumpPoint = Object.values(JUMP_POINTS).some(jp => jp === house.campaignTerritoryId && jp !== playerJP);

      // Capture phase BEFORE recordBattleResult (which may advance the phase)
      const missionPhase = phaseManagerRef!.getCurrentPhase();
      campaignRef!.recordVictory(house.campaignTerritoryId!);
      lastBattleResult = phaseManagerRef!.recordBattleResult(true, capturedTerritory, isJumpPoint);

      // Check for sub-house alliance offer using the pre-battle phase
      const subSys = campaignRef!.getSubHouseSystem();
      const missionSubHouse = subSys.getMissionSubHouse(missionPhase, house.campaignTerritoryId!);
      if (missionSubHouse) {
        subSys.offerAlliance(missionSubHouse, missionPhase, house.campaignTerritoryId!);
      }

      // Check for forced jump-point rebellion mission
      const forced = getForcedMission(house.campaignTerritoryId!, house.prefix as HousePrefix);
      if (forced) {
        localStorage.setItem('ebfd_forced_mission', forced.missionName);
      }

      campaignRef!.saveCampaign();
    });

    ctx.victorySystem.setDefeatCallback(() => {
      phaseManagerRef!.recordBattleResult(false, false, false);
      campaignRef!.recordDefeat();
    });

    ctx.victorySystem.setCampaignContinue(async () => {
      // --- AGENT: auto-handle campaign continue ---
      if (isAgent && agentConfig) {
        const phState = phaseManagerRef!.getState();

        if (phState.isVictory) {
          console.log('[Agent] CAMPAIGN COMPLETE! House ' + house.name + ' has conquered Arrakis!');
          stopAgent();
          return;
        }
        if (phState.isLost) {
          console.log('[Agent] CAMPAIGN LOST. House ' + house.name + ' has fallen.');
          stopAgent();
          return;
        }

        const outcome = ctx.victorySystem.getOutcome();
        console.log(`[Agent] Mission ${outcome}. Auto-continuing...`);

        // Auto civil war choice (HK only)
        if (lastBattleResult?.civilWarChoice && house.prefix === 'HK') {
          phaseManagerRef!.setCivilWarChoice(agentConfig.civilWarChoice);
          campaignRef!.saveCampaign();
          console.log(`[Agent] Civil war choice: ${agentConfig.civilWarChoice}`);
        }

        // Auto-accept alliance offers
        const agentSubSys = campaignRef!.getSubHouseSystem();
        const agentPending = agentSubSys.getState().offeredAlliance;
        if (agentPending) {
          agentSubSys.acceptAlliance();
          campaignRef!.saveCampaign();
          console.log(`[Agent] Alliance offer from ${agentPending}: ACCEPTED`);
        }

        // Pick next territory
        const attackable = campaignRef!.getAttackableTerritories();
        if (attackable.length === 0) {
          console.log('[Agent] No attackable territories remaining. Stopping.');
          stopAgent();
          return;
        }

        const picked = pickTerritoryWithContext(
          attackable,
          campaignRef!.getState().territories,
          phaseManagerRef!,
          house.prefix as HousePrefix,
        );
        console.log(`[Agent] Selected territory: ${picked.name} (id=${picked.id})`);

        // Update agent config with incremented mission count
        agentConfig.missionCount++;
        localStorage.setItem('ebfd_agent', JSON.stringify(agentConfig));

        localStorage.setItem('ebfd_campaign_next', JSON.stringify({
          territoryId: picked.id, difficulty: picked.difficulty, mapSeed: picked.mapSeed,
        }));
        window.location.reload();
        return;
      }

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

      // Handle Harkonnen civil war choice
      if (lastBattleResult?.civilWarChoice && house.prefix === 'HK') {
        const civilWarChoice = await showCivilWarChoice();
        phaseManagerRef!.setCivilWarChoice(civilWarChoice);
        campaignRef!.saveCampaign();
      }

      // Handle sub-house alliance offer
      const subSys = campaignRef!.getSubHouseSystem();
      const pendingOffer = subSys.getState().offeredAlliance;
      if (pendingOffer) {
        const accepted = await showAllianceOffer(pendingOffer);
        if (accepted) {
          subSys.acceptAlliance();
        } else {
          subSys.declineAlliance();
        }
        campaignRef!.saveCampaign();
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

  // Pass campaign alliance prefixes to sidebar
  if (campaignRef) {
    const alliances = campaignRef.getSubHouseSystem().getUnlockedPrefixes();
    if (alliances.length > 0) {
      ctx.sidebar.setSubhousePrefixes(alliances);
    }
  }

  // Apply skirmish/campaign/observer credits
  const desiredCreditsByPlayer = new Map<number, number>();
  if (house.skirmishOptions && (house.gameMode === 'skirmish' || house.gameMode === 'observer')) {
    const opts = house.skirmishOptions;
    if (!savedGame) {
      if (house.gameMode !== 'observer') desiredCreditsByPlayer.set(0, opts.startingCredits);
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
  if (!savedGame && (house.gameMode === 'skirmish' || house.gameMode === 'observer')) {
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

      // Load original XBF terrain mesh (required)
      await ctx.terrain.loadTerrainMesh(realMapId);
      console.log(`XBF terrain: ${realMapId}`);

      // Load map metadata (spawn points, script points, entrances, etc.)
      const manifest = await loadMapManifest();
      const manifestEntry = manifest[realMapId];
      if (manifestEntry) {
        ctx.mapMetadata = getMapMetadata(manifestEntry);
        const sp = ctx.mapMetadata.spawnPoints.length;
        const sc = ctx.mapMetadata.scriptPoints.filter(p => p !== null).length;
        const en = ctx.mapMetadata.entrances.length;
        console.log(`Map metadata: ${sp} spawns, ${sc} scripts, ${en} entrances`);

        // Place SpiceMound 3D models at spice field centers
        if (ctx.mapMetadata.spiceFields.length > 0) {
          await ctx.terrain.placeSpiceMounds(ctx.mapMetadata.spiceFields);
        }

        // Apply per-map lighting from test.lit
        if (manifestEntry.lighting) {
          ctx.scene.setMapLighting(manifestEntry.lighting);
        }
      }
    }
  }
  if (!mapLoaded) {
    throw new Error(`Failed to load map data for: ${realMapId ?? 'unknown'}`);
  }

  // Update systems with actual map dimensions
  const mapW = ctx.terrain.getMapWidth(), mapH = ctx.terrain.getMapHeight();
  for (const ai of ctx.aiPlayers) ai.setMapDimensions(mapW, mapH);
  ctx.fogOfWar.reinitialize();
  ctx.minimapRenderer.renderTerrain();
  ctx.scene.setMapBounds(mapW * 2, mapH * 2);
  ctx.movement.setMapBounds(mapW * 2, mapH * 2);
  ctx.movement.setTerrain(ctx.terrain);
  // Send terrain data to pathfinding worker
  ctx.asyncPathfinder.sendTerrainData();

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

  // --- MISSION SCRIPT INITIALIZATION ---
  // Must happen before restore so script state can be restored alongside entities.
  // Try .tok bytecode interpreter first, then fall back to JSON declarative scripts.
  // Check for forced rebellion mission override (set when capturing a jump point)
  const forcedScript = localStorage.getItem('ebfd_forced_mission');
  if (forcedScript) {
    localStorage.removeItem('ebfd_forced_mission');
  }
  const scriptId = forcedScript ?? ctx.activeMissionConfig?.scriptId ?? savedGame?.scriptId;
  if (scriptId) {
    const { loadTokScript, loadMissionScript } = await import('./campaign/scripting/MissionScriptLoader');

    // Try .tok interpreter first
    const tokBuffer = await loadTokScript(scriptId);
    if (tokBuffer) {
      const { TokInterpreter } = await import('./campaign/scripting/tok/TokInterpreter');
      const interpreter = new TokInterpreter();
      interpreter.init(ctx, tokBuffer, scriptId);
      ctx.missionScriptRunner = interpreter;
    } else {
      // Fall back to JSON declarative script
      const { MissionScriptRunner } = await import('./campaign/scripting/MissionScriptRunner');
      const script = await loadMissionScript(scriptId);
      if (script) {
        const runner = new MissionScriptRunner();
        ctx.missionScriptRunner = runner;
        // skipGameSetup=true for saved games: only loads structure, avoids
        // setting credits/victory/spawns that would conflict with restore
        runner.init(ctx, script, !!savedGame);
        console.log(`[MissionScript] Loaded script: ${script.id} (${script.name})`);
      }
    }
  }

  if (savedGame) {
    restoreFromSave(ctx, savedGame);
  } else {
    spawnFreshGame(ctx);
  }

  // --- AGENT MODE: add AIPlayer for player 0 ---
  if (isAgent && agentConfig) {
    // Use the same spawn positions as the enemy AI — read from the existing AI players
    // AI player 0 (enemy) targets the player base and has its own base position.
    // Our agent is the reverse: base = where AI targets (player base), target = AI's base.
    let agentBaseX = 128, agentBaseZ = 128;
    let agentTargetX = 64, agentTargetZ = 64;

    // Read ConYard positions from spawned entities
    const agentWorld = ctx.game.getWorld();
    const agentBuildings = buildingQuery(agentWorld);
    let foundBase = false, foundTarget = false;
    for (const eid of agentBuildings) {
      const bName = typeRegistry.buildingTypeNames[BT.id[eid]] ?? '';
      if (!bName.includes('ConYard')) continue;
      const px = Position.x[eid], pz = Position.z[eid];
      const owner = Owner.playerId[eid];
      console.log(`[Agent] Found ConYard: ${bName} owner=${owner} pos=(${px}, ${pz})`);
      if (owner === 0 && !foundBase) {
        agentBaseX = px;
        agentBaseZ = pz;
        foundBase = true;
      } else if (owner !== 0 && !foundTarget) {
        agentTargetX = px;
        agentTargetZ = pz;
        foundTarget = true;
      }
    }
    // Fallback: read enemy AI's base position directly
    if (!foundTarget && ctx.aiPlayers.length > 0) {
      const enemyBase = ctx.aiPlayers[0].getBasePosition();
      agentTargetX = enemyBase.x;
      agentTargetZ = enemyBase.z;
      foundTarget = true;
      console.log(`[Agent] Using enemy AI base position as target: (${enemyBase.x}, ${enemyBase.z})`);
    }
    if (!foundBase) console.warn('[Agent] WARNING: Could not find player 0 ConYard!');
    if (!foundTarget) console.warn('[Agent] WARNING: Could not find any enemy target!');

    console.log(`[Agent] Base: (${agentBaseX}, ${agentBaseZ}), Target: (${agentTargetX}, ${agentTargetZ})`);

    const agentAI = new AIPlayer(gameRules, ctx.combatSystem, 0, agentBaseX, agentBaseZ, agentTargetX, agentTargetZ);
    agentAI.setUnitPool(house.prefix);
    agentAI.setDifficulty('hard');
    agentAI.setPersonality(2); // balanced
    agentAI.setProductionSystem(ctx.productionSystem, ctx.harvestSystem);
    agentAI.setBuildingTypeNames(typeRegistry.buildingTypeNames);
    agentAI.setUnitTypeNames(typeRegistry.unitTypeNames);
    agentAI.setSpatialGrid(ctx.movement.getSpatialGrid());
    agentAI.setMapDimensions(mapW, mapH);
    agentAI.setSpawnCallback((eid, typeName, owner, x, z) => {
      const w = ctx.game.getWorld();
      removeEntity(w, eid);
      ctx.spawnUnit(w, typeName, owner, x, z);
    });

    ctx.game.addSystem(agentAI);
    ctx.agentAI = agentAI;

    // Agent UI: disable fog, show label
    ctx.fogOfWar.setEnabled(false);
    const agentLabel = document.createElement('div');
    agentLabel.id = 'agent-label';
    agentLabel.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);color:#f0c040;font-size:14px;font-family:inherit;z-index:100;pointer-events:none;text-shadow:0 1px 3px #000;letter-spacing:2px;';
    agentLabel.textContent = `[AGENT] ${house.name} — Mission ${agentConfig.missionCount + 1}`;
    document.body.appendChild(agentLabel);

    // Agent telemetry: report game state to telemetry server + document.title
    const telemetry = createTelemetrySystem(ctx, agentConfig);
    ctx.game.addSystem(telemetry);

    console.log(`[Agent] Mission started. Playing as ${house.name} | Territory: ${house.campaignTerritoryId}`);
  }

  // --- OBSERVER MODE SETUP ---
  if (house.gameMode === 'observer') {
    // Disable fog of war — spectator sees everything
    ctx.fogOfWar.setEnabled(false);
    // Hide sidebar (no player production in observer mode)
    const sidebarEl = document.getElementById('sidebar');
    if (sidebarEl) sidebarEl.style.display = 'none';
    // Hide solaris/power display
    const solaris = document.getElementById('solaris');
    if (solaris) solaris.style.display = 'none';
    // Disable victory/defeat checks for player 0 (spectator)
    ctx.victorySystem.setEnabled(false);
    // Show observer label
    const observerLabel = document.createElement('div');
    observerLabel.id = 'observer-label';
    observerLabel.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);color:#88cc88;font-size:14px;font-family:inherit;z-index:100;pointer-events:none;text-shadow:0 1px 3px #000;letter-spacing:2px;';
    observerLabel.textContent = 'OBSERVER MODE';
    document.body.appendChild(observerLabel);
    console.log('Observer mode: watching AI battle. WASD to scroll, M to mute.');
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
  if (isAgent) ctx.game.setHeadless(true); // Use setInterval for background-tab-safe ticking
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

  // --- AGENT: auto-click victory/defeat screen after outcome ---
  if (isAgent) {
    let agentFired = false;
    ctx.game.addSystem({
      update(_world: any, _dt: number) {
        if (agentFired) return;
        const outcome = ctx.victorySystem.getOutcome();
        if (outcome !== 'playing') {
          agentFired = true;
          console.log(`[Agent] Mission ${outcome}. Auto-clicking continue in 3s...`);
          const tryClick = (attempts: number) => {
            const btn = [...document.querySelectorAll('button')]
              .find(b => b.textContent === 'Continue Campaign');
            if (btn) {
              btn.click();
            } else if (attempts > 0) {
              // Retry — victory screen may not have rendered yet
              setTimeout(() => tryClick(attempts - 1), 1000);
            } else {
              console.error('[Agent] Continue button not found after retries, reloading...');
              window.location.reload();
            }
          };
          setTimeout(() => tryClick(5), 3000);
        }
      },
    });
  }

  // Debug helpers
  (window as any).game = ctx.game;
  (window as any).rules = gameRules;
  (window as any).fogOfWar = ctx.fogOfWar;
  (window as any).spawnUnit = (name: string, owner: number, x: number, z: number) => ctx.spawnUnit(ctx.game.getWorld(), name, owner, x, z);
  (window as any).spawnBuilding = (name: string, owner: number, x: number, z: number) => ctx.spawnBuilding(ctx.game.getWorld(), name, owner, x, z);
  (window as any).sandworm = ctx.sandwormSystem;
  (window as any).startAgent = startAgent;
  (window as any).stopAgent = stopAgent;
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

/** Show Harkonnen civil war choice dialog. Returns 'copec' or 'gunseng'. */
function showCivilWarChoice(): Promise<'copec' | 'gunseng'> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:3000;font-family:inherit;';
    overlay.innerHTML = `
      <div style="color:#ff4444;font-size:36px;font-weight:bold;margin-bottom:12px;">HARKONNEN CIVIL WAR</div>
      <div style="color:#ccc;font-size:16px;margin-bottom:8px;max-width:500px;text-align:center;">
        The Harkonnen family is divided. You must choose your allegiance.
      </div>
      <div style="color:#888;font-size:14px;margin-bottom:24px;max-width:500px;text-align:center;">
        This choice determines which faction you will face in the civil war.
      </div>
      <div style="display:flex;gap:20px;"></div>
    `;
    const btnContainer = overlay.querySelector('div:last-child')!;

    const makeBtn = (label: string, desc: string, choice: 'copec' | 'gunseng', color: string) => {
      const btn = document.createElement('button');
      btn.style.cssText = `padding:16px 32px;font-size:16px;background:${color}22;border:2px solid ${color};color:#fff;cursor:pointer;min-width:180px;text-align:center;`;
      btn.innerHTML = `<div style="font-weight:bold;margin-bottom:4px;">${label}</div><div style="font-size:12px;color:#aaa;">${desc}</div>`;
      btn.onclick = () => { overlay.remove(); resolve(choice); };
      btn.onmouseenter = () => { btn.style.background = `${color}44`; };
      btn.onmouseleave = () => { btn.style.background = `${color}22`; };
      return btn;
    };

    btnContainer.appendChild(makeBtn('House Copec', 'Attack the Copec stronghold', 'copec', '#cc4444'));
    btnContainer.appendChild(makeBtn('House Gunseng', 'Attack the Gunseng fortress', 'gunseng', '#cc8844'));
    document.body.appendChild(overlay);
  });
}

const SUB_HOUSE_NAMES: Record<AllianceSubHouse, string> = {
  FR: 'Fremen', SA: 'Sardaukar', IX: 'Ixian', TL: 'Tleilaxu', GU: 'Guild',
};

/** Show sub-house alliance offer. Returns true if accepted. */
function showAllianceOffer(subHouse: AllianceSubHouse): Promise<boolean> {
  return new Promise((resolve) => {
    const name = SUB_HOUSE_NAMES[subHouse] ?? subHouse;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:3000;font-family:inherit;';
    overlay.innerHTML = `
      <div style="color:#d4a843;font-size:32px;font-weight:bold;margin-bottom:12px;">ALLIANCE OFFER</div>
      <div style="color:#ccc;font-size:16px;margin-bottom:8px;max-width:480px;text-align:center;">
        The ${name} offer their allegiance. Accepting will unlock their units and buildings.
      </div>
      <div style="color:#888;font-size:13px;margin-bottom:24px;text-align:center;">
        You may hold at most 2 alliances. Some alliances are mutually exclusive.
      </div>
      <div style="display:flex;gap:16px;"></div>
    `;
    const btnContainer = overlay.querySelector('div:last-child')!;

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = `Accept ${name} Alliance`;
    acceptBtn.style.cssText = 'padding:12px 28px;font-size:15px;background:#2a5a2a;border:2px solid #4c4;color:#fff;cursor:pointer;';
    acceptBtn.onclick = () => { overlay.remove(); resolve(true); };
    acceptBtn.onmouseenter = () => { acceptBtn.style.background = '#3a7a3a'; };
    acceptBtn.onmouseleave = () => { acceptBtn.style.background = '#2a5a2a'; };

    const declineBtn = document.createElement('button');
    declineBtn.textContent = 'Decline';
    declineBtn.style.cssText = 'padding:12px 28px;font-size:15px;background:#333;border:2px solid #666;color:#ccc;cursor:pointer;';
    declineBtn.onclick = () => { overlay.remove(); resolve(false); };

    btnContainer.appendChild(acceptBtn);
    btnContainer.appendChild(declineBtn);
    document.body.appendChild(overlay);
  });
}

main().catch(console.error);
