import * as THREE from 'three';
import type { GameContext } from './GameContext';
import { GameConstants } from '../utils/Constants';
import { worldToTile } from '../utils/MathUtils';
import { TerrainType } from '../rendering/TerrainRenderer';
import { EventBus } from './EventBus';
import {
  hasComponent,
  Position, Health, Owner, UnitType,
  MoveTarget, AttackTarget, Harvester,
  BuildingType, PowerSource, Veterancy,
  unitQuery, buildingQuery,
} from './ECS';

export function registerTickHandler(ctx: GameContext): void {
  const {
    gameRules, typeRegistry, game, scene, terrain, unitRenderer,
    combatSystem, movement, commandManager, harvestSystem, productionSystem,
    effectsManager, audioManager, minimapRenderer, fogOfWar, damageNumbers,
    sandwormSystem, abilitySystem, superweaponSystem, victorySystem,
    selectionManager, selectionPanel, buildingPlacement, pathfinder,
    aiPlayers,
    aircraftAmmo, rearmingAircraft, descendingUnits, dyingTilts,
    processedDeaths, repairingBuildings, groundSplats, bloomMarkers,
    activeCrates, deferredActions,
    MAX_AMMO,
  } = ctx;
  const { unitTypeNames, buildingTypeNames } = typeRegistry;
  const totalPlayers = ctx.totalPlayers;
  const house = ctx.house;

  // UI elements
  const powerEl = document.getElementById('power-status');
  const powerBarGen = document.getElementById('power-bar-gen');
  const powerBarUse = document.getElementById('power-bar-use');
  const unitCountEl = document.getElementById('unit-count');
  const unitBreakdownEl = document.getElementById('unit-breakdown');
  const commandModeEl = document.getElementById('command-mode');
  const lowPowerEl = document.getElementById('low-power-warning');
  const controlGroupsEl = document.getElementById('control-groups');
  const techLevelEl = document.getElementById('tech-level');
  const musicTrackEl = document.getElementById('music-track');

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
    if (victorySystem.hasTimedObjective()) {
      const barContainer = document.createElement('div');
      barContainer.style.cssText = `margin-top:3px;height:4px;background:#222;border-radius:2px;overflow:hidden;`;
      objectiveBarFillEl = document.createElement('div');
      objectiveBarFillEl.style.cssText = `height:100%;width:0%;background:linear-gradient(90deg,#f44,#ff8,#4f4);transition:width 0.5s;`;
      barContainer.appendChild(objectiveBarFillEl);
      objectiveEl.appendChild(barContainer);
    }
    document.body.appendChild(objectiveEl);
  }

  EventBus.on('game:tick', () => {
    processedDeaths.clear();
    const world = game.getWorld();
    const currentTick = game.getTickCount();

    // Process deferred actions
    for (let i = deferredActions.length - 1; i >= 0; i--) {
      if (currentTick >= deferredActions[i].tick) {
        deferredActions[i].action();
        deferredActions.splice(i, 1);
      }
    }

    // Process starport descent animations
    for (const [eid, desc] of descendingUnits) {
      if (Health.current[eid] <= 0 || !hasComponent(world, Position, eid)) {
        descendingUnits.delete(eid);
        continue;
      }
      const elapsed = currentTick - desc.startTick;
      const progress = Math.min(elapsed / desc.duration, 1);
      const groundY = terrain.getHeightAt(Position.x[eid], Position.z[eid]) + 0.1;
      Position.y[eid] = groundY + (15 - groundY) * (1 - progress);
      if (progress >= 1) {
        Position.y[eid] = groundY;
        combatSystem.setSuppressed(eid, false);
        descendingUnits.delete(eid);
        if (Owner.playerId[eid] === 0) {
          const rally = commandManager.getRallyPoint(0);
          if (rally) {
            MoveTarget.x[eid] = rally.x;
            MoveTarget.z[eid] = rally.z;
            MoveTarget.active[eid] = 1;
          }
        }
      }
    }

    // Process death tilt animations
    for (const [eid, tilt] of dyingTilts) {
      const frame = currentTick - tilt.startTick + 1;
      const maxFrames = tilt.isBuilding ? 12 : 8;
      if (!tilt.obj.parent || frame > maxFrames) {
        dyingTilts.delete(eid);
        continue;
      }
      if (tilt.isBuilding) {
        // Buildings: shrink vertically and sink into ground
        const t = frame / maxFrames;
        tilt.obj.scale.y = Math.max(0.05, 1 - t * 0.8);
        tilt.obj.position.y = tilt.startY - t * 1.5;
        // Slight tilt for visual interest
        tilt.obj.rotation.x = Math.sin(tilt.tiltDir) * t * 0.15;
        tilt.obj.rotation.z = Math.cos(tilt.tiltDir) * t * 0.15;
      } else {
        tilt.obj.rotation.x = Math.sin(tilt.tiltDir) * frame * 0.1;
        tilt.obj.rotation.z = Math.cos(tilt.tiltDir) * frame * 0.1;
        tilt.obj.position.y = tilt.startY - frame * 0.05;
      }
    }

    productionSystem.update();
    productionSystem.updateStarportPrices();

    // Continuous building repair
    if (currentTick % 10 === 0) {
      ctx.tickRepairs();
    }

    superweaponSystem.update(world, currentTick);

    // Dust trails for moving ground units
    if (currentTick % 3 === 0) {
      const dustUnits = unitQuery(world);
      for (const eid of dustUnits) {
        if (Health.current[eid] <= 0) continue;
        if (MoveTarget.active[eid] !== 1) continue;
        const typeId = UnitType.id[eid];
        const typeName = unitTypeNames[typeId];
        const def = typeName ? gameRules.units.get(typeName) : null;
        if (!def || def.canFly || def.infantry) continue;
        effectsManager.spawnDustPuff(Position.x[eid], Position.z[eid]);
      }
    }

    unitRenderer.update(world);
    unitRenderer.tickConstruction();
    // Construction dust particles
    if (currentTick % 4 === 0) {
      for (const [eid] of unitRenderer.getConstructingEntities()) {
        if (!hasComponent(world, Position, eid)) continue;
        const cx = Position.x[eid] + (Math.random() - 0.5) * 4;
        const cz = Position.z[eid] + (Math.random() - 0.5) * 4;
        effectsManager.spawnDustPuff(cx, cz);
      }
    }
    unitRenderer.tickDeconstruction();
    unitRenderer.tickDeathAnimations();

    // Check radar state
    if (currentTick % 50 === 0) {
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
    effectsManager.update(40);
    effectsManager.updateWormVisuals(sandwormSystem.getWorms(), 40);
    if (currentTick % 50 === 0) terrain.flushSpiceVisuals();
    if (currentTick % 25 === 0) scene.updateDayNightCycle(currentTick);
    damageNumbers.update();

    // Clean up stale bloom markers
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
    const camPos = scene.getCameraTarget();
    audioManager.updateListenerPosition(camPos.x, camPos.z);

    // Update timed objective
    if (objectiveEl && victorySystem.hasTimedObjective()) {
      const progress = victorySystem.getSurvivalProgress();
      if (progress > 0 && progress < 1) {
        const remaining = victorySystem.getTimedObjectiveRemainingSeconds();
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const textSpan = objectiveEl.querySelector('span');
        if (textSpan) {
          textSpan.textContent = `Objective: ${victorySystem.getObjectiveLabel()} (${mins}:${secs.toString().padStart(2, '0')} remaining)`;
        }
        objectiveEl.style.borderColor = progress > 0.7 ? '#4f4' : progress > 0.4 ? '#ff8' : '#f44';
        if (objectiveBarFillEl) objectiveBarFillEl.style.width = `${Math.round(progress * 100)}%`;
      }
    }
    commandManager.setWorld(world);
    commandManager.updateWaypoints();

    // Update waypoint path lines
    if (currentTick % 10 === 0) {
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

    effectsManager.updateSpiceShimmer(terrain);

    buildingPlacement.updateOccupiedTiles(world);
    pathfinder.updateBlockedTiles(buildingPlacement.getOccupiedTiles());
    if (currentTick % 10 === 0) ctx.wallSystem.updateWallTiles(world);
    selectionPanel.setWorld(world);
    if (currentTick % 10 === 0) selectionPanel.refresh();

    // Command mode indicator
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

    // Update power and unit count every 25 ticks
    if (currentTick % 25 === 0) {
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

      if (idleHarvesters > 0 && currentTick % 125 === 0) {
        selectionPanel.addMessage(`${idleHarvesters} harvester${idleHarvesters > 1 ? 's' : ''} idle`, '#ff8800');
      }

      if (powerEl) {
        powerEl.textContent = `${powerGen}/${powerUsed}`;
        const sufficient = powerGen >= powerUsed;
        powerEl.style.color = sufficient ? '#4f4' : '#f44';
        const total = (powerGen + powerUsed) || 1;
        if (powerBarGen) powerBarGen.style.width = `${(powerGen / total) * 100}%`;
        if (powerBarUse) powerBarUse.style.width = `${(powerUsed / total) * 100}%`;
      }
      if (unitCountEl) unitCountEl.textContent = `${unitCount}`;
      if (unitBreakdownEl) {
        const parts: string[] = [];
        if (combatCount > 0) parts.push(`${combatCount} combat`);
        if (harvesterCount > 0) parts.push(`${harvesterCount} harv`);
        if (aircraftCount > 0) parts.push(`${aircraftCount} air`);
        unitBreakdownEl.textContent = parts.length > 0 ? `(${parts.join(', ')})` : '';
      }
      if (techLevelEl) {
        const techLevel = productionSystem.getPlayerTechLevel(0);
        techLevelEl.textContent = `${techLevel}`;
        techLevelEl.style.color = techLevel >= 3 ? '#FFD700' : techLevel >= 2 ? '#8cf' : '#aaa';
      }

      // Control group badges
      if (controlGroupsEl && currentTick % 25 === 0) {
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

      // Power affects gameplay
      const lowPower = powerGen < powerUsed;
      const powerMult = lowPower ? 0.5 : 1.0;
      if (lowPowerEl) lowPowerEl.style.display = lowPower ? 'block' : 'none';
      productionSystem.setPowerMultiplier(0, powerMult);
      combatSystem.setPowerMultiplier(0, powerMult);

      // Disable buildings with disableWithLowPower flag
      for (const eid of buildings) {
        if (Owner.playerId[eid] !== 0) continue;
        if (Health.current[eid] <= 0) continue;
        const typeId = BuildingType.id[eid];
        const bName = buildingTypeNames[typeId];
        const bDef = bName ? gameRules.buildings.get(bName) : null;
        if (bDef?.disableWithLowPower) {
          combatSystem.setDisabledBuilding(eid, lowPower);
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

      if (lowPower && powerUsed > 0 && currentTick % 250 === 0) {
        audioManager.playSfx('powerlow');
        audioManager.getDialogManager()?.trigger('lowPower');
        selectionPanel.addMessage('Low power! Build more Windtraps', '#ff4444');
      }

      // Music track display
      if (musicTrackEl) {
        const trackName = audioManager.getCurrentTrackName();
        musicTrackEl.textContent = trackName ? `♪ ${trackName}` : '';
      }

      // AI power calculations
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

      // Check for Hanger buildings
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

      // Building degradation
      if (currentTick % 250 === 0) {
        for (const eid of buildings) {
          if (Health.current[eid] <= 0) continue;
          const typeId = BuildingType.id[eid];
          const bName = buildingTypeNames[typeId] ?? '';
          if (bName.includes('Wall') || bName.includes('Windtrap') || bName.includes('SmWindtrap')) continue;
          const bTile = worldToTile(Position.x[eid], Position.z[eid]);
          let hasConcrete = false;
          for (let dtz = -1; dtz <= 1; dtz++) {
            for (let dtx = -1; dtx <= 1; dtx++) {
              if (terrain.getTerrainType(bTile.tx + dtx, bTile.tz + dtz) === TerrainType.ConcreteSlab) {
                hasConcrete = true;
                break;
              }
            }
            if (hasConcrete) break;
          }
          if (!hasConcrete) {
            const dmg = Math.max(1, Math.floor(Health.max[eid] * 0.01));
            Health.current[eid] = Math.max(1, Health.current[eid] - dmg);
          }
        }
      }

      // Building damage visual states
      for (const eid of buildings) {
        if (Health.current[eid] <= 0) continue;
        const ratio = Health.max[eid] > 0 ? Health.current[eid] / Health.max[eid] : 1;
        if (repairingBuildings.has(eid) && currentTick % 8 === 0) {
          const bx = Position.x[eid] + (Math.random() - 0.5) * 3;
          const bz = Position.z[eid] + (Math.random() - 0.5) * 3;
          effectsManager.spawnRepairSparkle(bx, 1 + Math.random() * 2, bz);
        }
        effectsManager.updateBuildingDamage(
          eid, Position.x[eid], Position.y[eid], Position.z[eid], ratio
        );
      }
    }

    // Ability system update
    abilitySystem.update(world, currentTick);

    // Aircraft rearming
    if (currentTick % GameConstants.REARM_RATE === 5 && rearmingAircraft.size > 0) {
      for (const eid of rearmingAircraft) {
        if (Health.current[eid] <= 0) { rearmingAircraft.delete(eid); aircraftAmmo.delete(eid); continue; }
        const owner = Owner.playerId[eid];
        const blds = buildingQuery(world);
        let nearPad = false;
        for (const bid of blds) {
          if (Owner.playerId[bid] !== owner || Health.current[bid] <= 0) continue;
          const bName = buildingTypeNames[BuildingType.id[bid]] ?? '';
          if (!bName.includes('Helipad') && !bName.includes('LandPad') && !bName.includes('Hanger')) continue;
          const dx = Position.x[eid] - Position.x[bid];
          const dz = Position.z[eid] - Position.z[bid];
          if (dx * dx + dz * dz < 25) { nearPad = true; break; }
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
          const pad = ctx.findNearestLandingPad(world, owner, Position.x[eid], Position.z[eid]);
          if (pad) {
            MoveTarget.x[eid] = pad.x;
            MoveTarget.z[eid] = pad.z;
            MoveTarget.active[eid] = 1;
          }
        }
      }
    }

    // Crate drops
    if (currentTick % 1000 === 500 && activeCrates.size < 3) {
      const crateTypes = ['credits', 'veterancy', 'heal'];
      const type = crateTypes[Math.floor(Math.random() * crateTypes.length)];
      const cx = 20 + Math.random() * (terrain.getMapWidth() * 2 - 40);
      const cz = 20 + Math.random() * (terrain.getMapHeight() * 2 - 40);
      const crateId = ctx.nextCrateId++;
      activeCrates.set(crateId, { x: cx, z: cz, type });
      effectsManager.spawnCrate(crateId, cx, cz, type);
    }

    // Crate collection
    if (currentTick % 10 === 0 && activeCrates.size > 0) {
      const allUnits = unitQuery(world);
      for (const [crateId, crate] of activeCrates) {
        let collected = false;
        for (const eid of allUnits) {
          if (Health.current[eid] <= 0) continue;
          const dx = Position.x[eid] - crate.x;
          const dz = Position.z[eid] - crate.z;
          if (dx * dx + dz * dz < 4.0) {
            const owner = Owner.playerId[eid];
            if (crate.type === 'credits') {
              harvestSystem.addSolaris(owner, 500);
              if (owner === 0) selectionPanel.addMessage('+500 Solaris!', '#ffd700');
            } else if (crate.type === 'veterancy') {
              combatSystem.addXp(eid, 100);
              if (owner === 0) selectionPanel.addMessage('Unit experience boost!', '#44ff44');
            } else if (crate.type === 'heal') {
              for (const other of allUnits) {
                if (Owner.playerId[other] !== owner) continue;
                if (Health.current[other] <= 0) continue;
                const ox = Position.x[other] - crate.x;
                const oz = Position.z[other] - crate.z;
                if (ox * ox + oz * oz < 100) {
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

    // Sandstorm events
    if (!effectsManager.isSandstormActive()) {
      ctx.stormWaitTimer--;
      if (ctx.stormWaitTimer <= 0) {
        effectsManager.startSandstorm();
        selectionPanel.addMessage('Sandstorm approaching!', '#ff8844');
        const stormDuration = GameConstants.STORM_MIN_LIFE +
          Math.floor(Math.random() * (GameConstants.STORM_MAX_LIFE - GameConstants.STORM_MIN_LIFE));
        const stormEnd = currentTick + stormDuration;
        ctx.stormWaitTimer = GameConstants.STORM_MIN_WAIT +
          Math.floor(Math.random() * GameConstants.STORM_MAX_WAIT);
        const stormDamage = () => {
          if (game.getTickCount() >= stormEnd) {
            effectsManager.stopSandstorm();
            selectionPanel.addMessage('Sandstorm subsided', '#aaa');
            EventBus.off('game:tick', stormDamage);
            ctx.activeStormListener = null;
            return;
          }
          const stormUnits = unitQuery(world);
          for (const eid of stormUnits) {
            if (Health.current[eid] <= 0) continue;
            const typeId = UnitType.id[eid];
            const tName = unitTypeNames[typeId];
            const uDef = tName ? gameRules.units.get(tName) : null;
            if (uDef?.canFly) continue;
            const stormTile = worldToTile(Position.x[eid], Position.z[eid]);
            const terrType = terrain.getTerrainType(stormTile.tx, stormTile.tz);
            if (terrType === TerrainType.Sand || terrType === TerrainType.Dunes) {
              if (Math.floor(Math.random() * GameConstants.STORM_KILL_CHANCE) === 0) {
                Health.current[eid] = 0;
                EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
              }
            }
          }
        };
        ctx.activeStormListener = stormDamage;
        EventBus.on('game:tick', stormDamage);
      }
    }

    // InkVine ground splat DoT
    if (currentTick % 25 === 0 && groundSplats.length > 0) {
      const splatRadius = 6;
      const splatRadiusSq = splatRadius * splatRadius;
      const allUnits = unitQuery(world);
      for (let i = groundSplats.length - 1; i >= 0; i--) {
        const splat = groundSplats[i];
        splat.ticksLeft -= 25;
        if (splat.ticksLeft <= 0) {
          groundSplats.splice(i, 1);
          effectsManager.removeGroundSplat(splat.x, splat.z);
          continue;
        }
        const dmg = splat.type === 'inkvine' ? 3 : 15;
        for (const eid of allUnits) {
          if (Health.current[eid] <= 0) continue;
          if (Owner.playerId[eid] === splat.ownerPlayerId) continue;
          const typeId = UnitType.id[eid];
          const tName = unitTypeNames[typeId];
          const uDef = tName ? gameRules.units.get(tName) : null;
          if (splat.type === 'inkvine' && !uDef?.infantry) continue;
          const dx = Position.x[eid] - splat.x;
          const dz = Position.z[eid] - splat.z;
          if (dx * dx + dz * dz < splatRadiusSq) {
            Health.current[eid] = Math.max(0, Health.current[eid] - dmg);
            if (Health.current[eid] <= 0) {
              EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
            }
          }
        }
        if (splat.ticksLeft < 100) {
          effectsManager.fadeGroundSplat(splat.x, splat.z, splat.ticksLeft / 100);
        }
      }
    }

    // Sample stats
    if (currentTick % 250 === 0) {
      const allU = unitQuery(world);
      const unitCounts = new Array(totalPlayers).fill(0);
      for (const uid of allU) {
        if (Health.current[uid] <= 0) continue;
        const o = Owner.playerId[uid];
        if (o < totalPlayers) unitCounts[o]++;
      }
      const credits = [];
      for (let i = 0; i < totalPlayers; i++) credits.push(harvestSystem.getSolaris(i));
      ctx.gameStats.sample(currentTick, credits, unitCounts);
    }

    // Autosave
    if (currentTick > 0 && currentTick % 3000 === 0 && victorySystem.getOutcome() === 'playing') {
      const autoSaveData = ctx.buildSaveData();
      localStorage.setItem('ebfd_autosave', JSON.stringify(autoSaveData));
      localStorage.setItem('ebfd_autosave_time', new Date().toLocaleString());
      selectionPanel.addMessage('Autosaved', '#888');
    }

    // Pause on victory/defeat
    if (victorySystem.getOutcome() !== 'playing' && !game.isPaused()) {
      game.pause();
    }
  });
}
