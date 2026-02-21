import * as THREE from 'three';
import type { GameContext } from './GameContext';
import { simRng } from '../utils/DeterministicRNG';
import { GameConstants } from '../utils/Constants';
import { tileToWorld } from '../utils/MathUtils';
import { EventBus } from './EventBus';
import {
  hasComponent, removeEntity,
  Position, Health, Owner, UnitType,
  MoveTarget, AttackTarget, Veterancy,
  Harvester, BuildingType, Shield,
  unitQuery, buildingQuery,
} from './ECS';

export function registerEventHandlers(ctx: GameContext): void {
  const {
    gameRules, typeRegistry, game, scene, terrain, unitRenderer,
    combatSystem, movement, commandManager, harvestSystem, productionSystem,
    effectsManager, audioManager, minimapRenderer, selectionManager,
    selectionPanel, abilitySystem, buildingPlacement, victorySystem,
    gameStats, aiPlayers,
    aircraftAmmo, rearmingAircraft, descendingUnits, dyingTilts,
    processedDeaths, repairingBuildings, groundSplats, bloomMarkers,
    MAX_AMMO,
  } = ctx;
  const { unitTypeNames, buildingTypeNames } = typeRegistry;
  const opponents = ctx.opponents;
  const house = ctx.house;

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

  // Unit death handler
  EventBus.on('unit:died', ({ entityId }) => {
    if (processedDeaths.has(entityId)) return;
    processedDeaths.add(entityId);
    const world = game.getWorld();
    const isBuilding = hasComponent(world, BuildingType, entityId);
    const x = Position.x[entityId];
    const y = Position.y[entityId];
    const z = Position.z[entityId];
    const deadOwner = Owner.playerId[entityId];

    const deadTypeName = isBuilding
      ? buildingTypeNames[BuildingType.id[entityId]]
      : unitTypeNames[UnitType.id[entityId]];
    const deadDef = isBuilding
      ? gameRules.buildings.get(deadTypeName ?? '')
      : gameRules.units.get(deadTypeName ?? '');
    if (deadDef?.countsForStats !== false) {
      if (isBuilding) gameStats.recordBuildingLost(deadOwner);
      else gameStats.recordUnitLost(deadOwner);
    }

    combatSystem.unregisterUnit(entityId);
    movement.unregisterEntity(entityId);
    commandManager.unregisterEntity(entityId);
    effectsManager.clearBuildingDamage(entityId);

    aircraftAmmo.delete(entityId);
    rearmingAircraft.delete(entityId);
    descendingUnits.delete(entityId);
    repairingBuildings.delete(entityId);
    abilitySystem.handleUnitDeath(entityId);

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
    const deathColor = deadOwner === 0 ? '#ff6600' : '#ff2222';
    minimapRenderer.flashPing(x, z, deathColor);
    if (explosionSize === 'large') scene.shake(0.4);
    else if (explosionSize === 'medium') scene.shake(0.15);
    if (isBuilding) {
      EventBus.emit('building:destroyed', { entityId, owner: deadOwner, x, z });
      movement.invalidateAllPaths();
    }

    // Death animation (units tilt, buildings collapse with shrink effect)
    const hasDeathClip = unitRenderer.playDeathAnim(entityId);
    const obj = unitRenderer.getEntityObject(entityId);
    if (obj && !hasDeathClip) {
      dyingTilts.set(entityId, { obj, tiltDir: Math.random() * Math.PI * 2, startTick: game.getTickCount(), startY: obj.position.y, isBuilding });
    }

    // Clean up building from production prerequisites
    if (isBuilding) {
      const typeId = BuildingType.id[entityId];
      const typeName = buildingTypeNames[typeId];
      if (typeName) {
        productionSystem.removePlayerBuilding(Owner.playerId[entityId], typeName);
      }

      // Spawn infantry survivors
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
            const sx = x + (simRng.random() - 0.5) * 4;
            const sz = z + (simRng.random() - 0.5) * 4;
            ctx.spawnUnit(world, infantryType, deadOwner, sx, sz);
          }
          EventBus.emit('building:survivors', { x, z, count, owner: deadOwner });
          if (deadOwner === 0) {
            selectionPanel.addMessage(`${count} survivor${count > 1 ? 's' : ''} emerged from wreckage`, '#88cc88');
          }
        }
      }
    }

    // Auto-replace harvesters
    const owner = Owner.playerId[entityId];
    if (owner === 0 && hasComponent(world, Harvester, entityId)) {
      const typeId = UnitType.id[entityId];
      const harvTypeName = unitTypeNames[typeId];
      if (harvTypeName && ctx.findRefinery(world, 0)) {
        const delayTicks = GameConstants.HARV_REPLACEMENT_DELAY;
        selectionPanel.addMessage(`Harvester lost - replacement in ${Math.round(delayTicks / 25)}s`, '#ff8800');
        ctx.deferAction(delayTicks, () => {
          try {
            if (ctx.findRefinery(game.getWorld(), 0)) {
              if (productionSystem.startProduction(0, harvTypeName, false)) {
                selectionPanel.addMessage('Replacement harvester queued', '#44ff44');
              }
            }
          } catch { /* game may have ended */ }
        });
      }
    }

    ctx.deferAction(13, () => {
      try { removeEntity(game.getWorld(), entityId); } catch {}
    });
  });

  // Veterancy promotion
  EventBus.on('unit:promoted', ({ entityId, rank }) => {
    if (Owner.playerId[entityId] === 0) {
      const rankNames = ['', 'Veteran', 'Elite', 'Heroic'];
      selectionPanel.addMessage(`Unit promoted to ${rankNames[rank]}!`, '#ffd700');
      audioManager.playSfx('select');
    }
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
  EventBus.on('bloom:warning', ({ x, z }) => {
    selectionPanel.addMessage('Spice bloom forming...', '#ff8800');
    const geo = new THREE.RingGeometry(1.5, 3.0, 16);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff6600, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.1, z);
    scene.scene.add(mesh);
    bloomMarkers.set(`${Math.floor(x)},${Math.floor(z)}`, { mesh, ticks: 0 });
  });
  EventBus.on('bloom:tremor', ({ x, z, intensity }) => {
    effectsManager.spawnExplosion(x + (simRng.random() - 0.5) * 4, 0, z + (simRng.random() - 0.5) * 4, 'small');
    const key = `${Math.floor(x)},${Math.floor(z)}`;
    const marker = bloomMarkers.get(key);
    if (marker) {
      marker.ticks = 0;
      (marker.mesh.material as THREE.MeshBasicMaterial).opacity = 0.3 + intensity * 0.5;
      const scale = 1.0 + intensity * 0.5;
      marker.mesh.scale.set(scale, scale, scale);
    }
  });
  EventBus.on('bloom:eruption', ({ x, z }) => {
    effectsManager.spawnExplosion(x, 0.5, z, 'large');
    scene.shake(0.3);
    selectionPanel.addMessage('Spice bloom erupted! New spice field detected.', '#ff8800');
    audioManager.playSfx('worm');
    minimapRenderer.flashPing(x, z, '#ff8800');
    terrain.updateSpiceVisuals();
    const key = `${Math.floor(x)},${Math.floor(z)}`;
    const marker = bloomMarkers.get(key);
    if (marker) {
      scene.scene.remove(marker.mesh);
      marker.mesh.geometry.dispose();
      (marker.mesh.material as THREE.Material).dispose();
      bloomMarkers.delete(key);
    }
  });

  // Cash fallback notification
  EventBus.on('spice:cashFallback', ({ amount }) => {
    selectionPanel.addMessage(`Emergency spice reserves: +${amount} credits`, '#FFD700');
  });

  // Under-attack notifications (throttled)
  let lastAttackNotifyTime = 0;
  const attackFlashEl = document.getElementById('attack-flash');
  EventBus.on('unit:damaged', ({ entityId, x, z, isBuilding }) => {
    if (Owner.playerId[entityId] !== 0) return;
    const now = Date.now();
    if (now - lastAttackNotifyTime < 5000) return;
    lastAttackNotifyTime = now;
    if (isBuilding) {
      selectionPanel.addMessage('Base under attack!', '#ff2222');
      minimapRenderer.flashPing(x, z, '#ff2222');
    } else {
      selectionPanel.addMessage('Units under attack!', '#ff6644');
    }
    audioManager.playSfx('underattack');
    const minimapEl = document.getElementById('minimap-container');
    if (minimapEl) {
      minimapEl.classList.remove('under-attack');
      void minimapEl.offsetWidth;
      minimapEl.classList.add('under-attack');
    }
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

  // Rally line
  EventBus.on('unit:selected', ({ entityIds }) => {
    const w = game.getWorld();
    if (!w) return;
    const rally = commandManager.getRallyPoint(0);
    if (!rally) { effectsManager.hideRallyLine(); return; }
    const bldg = entityIds.find((eid: number) => hasComponent(w, BuildingType, eid) && Owner.playerId[eid] === 0);
    if (bldg !== undefined) {
      effectsManager.showRallyLine(Position.x[bldg], Position.z[bldg], rally.x, rally.z);
    } else {
      effectsManager.hideRallyLine();
    }
  });
  EventBus.on('unit:deselected', () => {
    effectsManager.hideRallyLine();
  });

  // Projectile visuals
  EventBus.on('combat:fire', ({ attackerX, attackerZ, targetX, targetZ, weaponType, attackerEntity, targetEntity }) => {
    let color = 0xffaa00;
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
        const owner = Owner.playerId[attackerEntity];
        const pad = ctx.findNearestLandingPad(game.getWorld(), owner, attackerX, attackerZ);
        if (pad) {
          MoveTarget.x[attackerEntity] = pad.x;
          MoveTarget.z[attackerEntity] = pad.z;
          MoveTarget.active[attackerEntity] = 1;
          AttackTarget.active[attackerEntity] = 0;
          rearmingAircraft.add(attackerEntity);
          combatSystem.setSuppressed(attackerEntity, true);
          if (owner === 0) selectionPanel.addMessage('Aircraft returning to rearm', '#88aaff');
        } else {
          MoveTarget.active[attackerEntity] = 0;
          AttackTarget.active[attackerEntity] = 0;
          combatSystem.setSuppressed(attackerEntity, true);
          rearmingAircraft.add(attackerEntity);
        }
      }
    }

    // Deviator & contaminator abilities
    if (attackerEntity !== undefined && targetEntity !== undefined) {
      abilitySystem.handleCombatHit(attackerEntity, targetEntity);
    }

    // InkVine Catapult: create toxic ground splat
    if (wt.includes('inkvine') && attackerEntity !== undefined) {
      groundSplats.push({
        x: targetX, z: targetZ,
        ticksLeft: 1000,
        ownerPlayerId: Owner.playerId[attackerEntity],
        type: 'inkvine',
      });
      effectsManager.spawnGroundSplat(targetX, targetZ, 'inkvine');
    }
  });

  // AoE blast visual effects
  EventBus.on('combat:blast', ({ x, z, radius }) => {
    const size: 'small' | 'medium' | 'large' = radius <= 2 ? 'small' : radius <= 5 ? 'medium' : 'large';
    effectsManager.spawnExplosion(x, 0, z, size);
  });

  // Death Hand missile fallout
  EventBus.on('superweapon:fired', ({ owner, type, x, z }) => {
    if (type === 'HKPalace') {
      groundSplats.push({ x, z, ticksLeft: 1000, ownerPlayerId: owner, type: 'fallout' });
      effectsManager.spawnGroundSplat(x, z, 'fallout');
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

    // Handle upgrade completions
    if (unitType.endsWith(' Upgrade')) {
      const baseName = unitType.replace(' Upgrade', '');
      if (owner === 0) {
        const displayName = baseName.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
        selectionPanel.addMessage(`${displayName} upgraded!`, '#ffcc00');
        audioManager.playSfx('build');
      }
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

    const isBuildingType = gameRules.buildings.has(unitType);

    const prodDef = isBuildingType
      ? gameRules.buildings.get(unitType)
      : gameRules.units.get(unitType);
    if (prodDef?.countsForStats !== false) {
      if (isBuildingType) gameStats.recordBuildingBuilt(owner);
      else gameStats.recordUnitBuilt(owner);
    }

    if (owner === 0) {
      const displayName = unitType.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
      selectionPanel.addMessage(`${displayName} ready`, '#44ff44');
      audioManager.playSfx('select');
    }

    if (isBuildingType) {
      if (owner === 0) {
        const placeDef = gameRules.buildings.get(unitType);
        if (placeDef?.wall) {
          // Wall: use drag-to-build mode, spawning each tile individually
          // First tile is covered by production cost; subsequent tiles charge per-tile
          const wallCostPerTile = placeDef.cost;
          let firstTileFree = true;
          buildingPlacement.startWallPlacement(unitType, placeDef.terrain, (tiles) => {
            const w2 = game.getWorld();
            let placed = 0;
            for (const t of tiles) {
              if (!firstTileFree && harvestSystem.getSolaris(0) < wallCostPerTile) {
                if (placed === 0) selectionPanel.addMessage('Insufficient funds', '#ff4444');
                break;
              }
              const worldPos = tileToWorld(t.tx, t.tz);
              const eid = ctx.spawnBuilding(w2, unitType, 0, worldPos.x, worldPos.z);
              if (eid >= 0) {
                if (firstTileFree) {
                  firstTileFree = false;
                } else {
                  harvestSystem.addSolaris(0, -wallCostPerTile);
                }
                EventBus.emit('building:placed', { entityId: eid, buildingType: unitType, owner: 0 });
                const duration = Math.max(15, Math.floor((placeDef.buildTime ?? 60) * 0.3));
                unitRenderer.startConstruction(eid, duration);
                const wallEid = eid;
                ctx.deferAction(duration, () => {
                  if (Health.current[wallEid] <= 0) return;
                  EventBus.emit('building:completed', { entityId: wallEid, playerId: 0, typeName: unitType });
                });
                placed++;
                // Update occupied tiles so subsequent tiles in this line don't overlap
                buildingPlacement.updateOccupiedTiles(w2);
              }
            }
            if (placed > 0) movement.invalidateAllPaths();
          });
        } else {
          const buildingFootprints = new Map<string, { w: number; h: number }>();
          for (const [name, def] of gameRules.buildings) {
            const h = def.occupy.length || 3;
            const w = def.occupy[0]?.length || 3;
            buildingFootprints.set(name, { w, h });
          }
          const fp = buildingFootprints.get(unitType) ?? { w: 3, h: 3 };
          buildingPlacement.startPlacement(unitType, fp.w, fp.h, placeDef?.terrain);
        }
      } else {
        const bDef = gameRules.buildings.get(unitType);
        const ownerAi = aiPlayers[owner - 1];
        if (bDef && ownerAi) {
          const pos = ownerAi.getNextBuildingPlacement(unitType, bDef);
          const aiBldgEid = ctx.spawnBuilding(world, unitType, owner, pos.x, pos.z);
          movement.invalidateAllPaths();
          if (aiBldgEid >= 0) {
            EventBus.emit('building:placed', { entityId: aiBldgEid, buildingType: unitType, owner });
            EventBus.emit('building:completed', { entityId: aiBldgEid, playerId: owner, typeName: unitType });
          }
          if (bDef.getUnitWhenBuilt) {
            ctx.spawnUnit(world, bDef.getUnitWhenBuilt, owner, pos.x + 3, pos.z + 3);
          }
        }
      }
    } else {
      const uDef2 = gameRules.units.get(unitType);
      let fromStarport = false;
      let starportX = 0, starportZ = 0;

      let baseX = 55, baseZ = 55;
      const spawnBuildings = buildingQuery(world);
      let found = false;

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
      const x = baseX + (simRng.random() - 0.5) * 10;
      const z = baseZ + (simRng.random() - 0.5) * 10;
      const eid = ctx.spawnUnit(world, unitType, owner, x, z);

      // Starport arrival: descent animation
      if (fromStarport && eid >= 0) {
        Position.y[eid] = 15;
        MoveTarget.active[eid] = 0;
        combatSystem.setSuppressed(eid, true);
        descendingUnits.set(eid, { startTick: game.getTickCount(), duration: 25 });
        effectsManager.spawnExplosion(starportX, 8, starportZ, 'small');
        if (owner === 0) {
          audioManager.playSfx('build');
          selectionPanel.addMessage('Starport delivery arriving!', '#88aaff');
        }
      }

      // Atreides veterancy bonus
      if (eid >= 0) {
        const ownerPrefix = owner === 0 ? house.prefix : (opponents[owner - 1]?.prefix ?? house.enemyPrefix);
        if (ownerPrefix === 'AT') {
          const uDef = gameRules.units.get(unitType);
          if (uDef?.infantry && productionSystem.isUpgraded(owner, `${ownerPrefix}Barracks`)) {
            if (hasComponent(world, Veterancy, eid) && Veterancy.rank[eid] < 1) {
              const threshold = uDef.veterancy?.[0]?.scoreThreshold ?? 1;
              combatSystem.addXp(eid, threshold);
            }
          }
        }
      }

      // Send to rally point
      if (owner === 0 && eid >= 0 && !fromStarport) {
        const rally = commandManager.getRallyPoint(0);
        if (rally) {
          MoveTarget.x[eid] = rally.x;
          MoveTarget.z[eid] = rally.z;
          MoveTarget.active[eid] = 1;
        }
      }

      // Flash minimap ping
      if (owner === 0 && eid >= 0) {
        minimapRenderer.flashPing(Position.x[eid], Position.z[eid], '#44ff44');
      }

      // AI auto-deploys MCVs
      if (owner !== 0 && eid >= 0 && unitType.endsWith('MCV')) {
        const prefix = unitType.substring(0, 2);
        const conYardName = `${prefix}ConYard`;
        if (gameRules.buildings.has(conYardName)) {
          const ownerAi = aiPlayers[owner - 1];
          const aiBase = ownerAi ? ownerAi.getBasePosition() : { x: 200, z: 200 };
          const deployX = aiBase.x + (simRng.random() - 0.5) * 10;
          const deployZ = aiBase.z + (simRng.random() - 0.5) * 10;
          Health.current[eid] = 0;
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
          const conYardEid = ctx.spawnBuilding(world, conYardName, owner, deployX, deployZ);
          if (conYardEid >= 0) {
            EventBus.emit('building:completed', { entityId: conYardEid, playerId: owner, typeName: conYardName });
          }
          movement.invalidateAllPaths();
        }
      }
    }
  });

  // Event queue listeners for death/worm/attack
  EventBus.on('unit:died', ({ entityId }) => {
    ctx.pushGameEvent(Position.x[entityId], Position.z[entityId], 'death');
  });
  EventBus.on('worm:emerge', ({ x, z }) => { ctx.pushGameEvent(x, z, 'worm'); });
  let lastAttackEventTime = 0;
  EventBus.on('unit:damaged', ({ entityId, x, z }) => {
    if (Owner.playerId[entityId] !== 0) return;
    const now = Date.now();
    if (now - lastAttackEventTime < 3000) return;
    lastAttackEventTime = now;
    ctx.pushGameEvent(x, z, 'attack');
  });
}
