import type { GameContext } from './GameContext';
import { createSeededRng, getSpawnPositions } from '../utils/GameHelpers';
import { simRng } from '../utils/DeterministicRNG';
import { TILE_SIZE } from '../utils/MathUtils';
import {
  addComponent,
  Harvester,
} from './ECS';

export function spawnFreshGame(ctx: GameContext): void {
  const {
    game, gameRules, typeRegistry, terrain, aiPlayers, opponents, house,
    totalPlayers, activeMapId, scene, mapMetadata,
  } = ctx;
  const { unitTypeNames } = typeRegistry;
  const world = game.getWorld();

  // Distribute spawn positions for all players
  const isObserver = house.gameMode === 'observer';
  const spawnCount = isObserver ? aiPlayers.length : totalPlayers;

  let spawnPositions: { x: number; z: number }[];

  // Use real spawn points from map metadata when available
  if (mapMetadata && mapMetadata.spawnPoints.length >= spawnCount) {
    spawnPositions = mapMetadata.spawnPoints.slice(0, spawnCount).map(pt => ({
      x: pt.x * TILE_SIZE,
      z: pt.z * TILE_SIZE,
    }));
    console.log(`Using ${spawnCount} real spawn points from map metadata`);
  } else {
    // Fall back to procedural ellipse placement
    let spawnRandom = () => simRng.random();
    if (activeMapId) {
      spawnRandom = createSeededRng(`${activeMapId}|${house.prefix}|${house.enemyPrefix}|${totalPlayers}`);
    } else if (house.mapChoice) {
      spawnRandom = createSeededRng(`${house.mapChoice.seed}|${house.prefix}|${house.enemyPrefix}|${totalPlayers}`);
    }
    spawnPositions = getSpawnPositions(terrain.getMapWidth(), terrain.getMapHeight(), spawnCount, spawnRandom);
  }
  const playerBase = spawnPositions[0];
  const aiOffset = isObserver ? 0 : 1; // AI positions start at index 0 in observer, 1 otherwise

  // Update all AI targets/bases to match spawn positions
  for (let i = 0; i < aiPlayers.length; i++) {
    const aiBase = spawnPositions[i + aiOffset];
    aiPlayers[i].setBasePosition(aiBase.x, aiBase.z);
    if (isObserver) {
      // In observer mode, AIs target each other in round-robin
      const targetIdx = (i + 1) % aiPlayers.length;
      const targetBase = spawnPositions[targetIdx + aiOffset];
      aiPlayers[i].setTargetPosition(targetBase.x, targetBase.z);
    } else {
      aiPlayers[i].setTargetPosition(playerBase.x, playerBase.z);
    }
  }

  // Player base (skip in observer mode — player is just a spectator)
  if (!isObserver) {
    const px = house.prefix;
    ctx.spawnBuilding(world, `${px}ConYard`, 0, playerBase.x, playerBase.z);
    ctx.spawnBuilding(world, `${px}SmWindtrap`, 0, playerBase.x + 6, playerBase.z);
    ctx.spawnBuilding(world, `${px}Barracks`, 0, playerBase.x - 6, playerBase.z);
    ctx.spawnBuilding(world, `${px}Factory`, 0, playerBase.x, playerBase.z + 6);
    ctx.spawnBuilding(world, `${px}Refinery`, 0, playerBase.x + 6, playerBase.z + 6);

    // Starting player units — exclude campaign-only (aiSpecial), high-tech, and flying
    const playerInfantry = [...gameRules.units.keys()].filter(n => {
      const def = gameRules.units.get(n);
      return n.startsWith(px) && def?.infantry && !def.aiSpecial && def.techLevel <= 2;
    });
    const playerVehicles = [...gameRules.units.keys()].filter(n => {
      const def = gameRules.units.get(n);
      return n.startsWith(px) && def && !def.infantry && def.cost > 0 && !def.aiSpecial && def.techLevel <= 2 && !def.canFly;
    });

    for (let i = 0; i < 3 && i < playerInfantry.length; i++) {
      ctx.spawnUnit(world, playerInfantry[i], 0, playerBase.x - 5 + i * 2, playerBase.z + 10);
    }
    for (let i = 0; i < 4 && i < playerVehicles.length; i++) {
      ctx.spawnUnit(world, playerVehicles[i], 0, playerBase.x + 3 + i * 2, playerBase.z + 12);
    }

    // Harvester
    const harvTypes = [...gameRules.units.keys()].filter(n =>
      (n.startsWith(px) || n === 'Harvester') && (n.includes('Harv') || n.includes('harvester'))
    );
    if (harvTypes.length > 0) {
      ctx.spawnUnit(world, harvTypes[0], 0, playerBase.x + 10, playerBase.z + 8);
    } else {
      const fallbackVehicle = playerVehicles[0];
      if (fallbackVehicle) {
        const harvEid = ctx.spawnUnit(world, fallbackVehicle, 0, playerBase.x + 10, playerBase.z + 8);
        if (harvEid >= 0) {
          addComponent(world, Harvester, harvEid);
          Harvester.maxCapacity[harvEid] = 1.0;
          Harvester.spiceCarried[harvEid] = 0;
          Harvester.state[harvEid] = 0;
          Harvester.refineryEntity[harvEid] = 0;
          Harvester.unloadRate[harvEid] = 2 / 200; // Default UnloadRate=2, normalized by SPICE_VALUE
        }
      }
    }
  }

  // AI bases
  for (let i = 0; i < opponents.length; i++) {
    const aiBase = spawnPositions[i + aiOffset];
    const ex = opponents[i].prefix;
    const owner = i + 1;

    ctx.spawnBuilding(world, `${ex}ConYard`, owner, aiBase.x, aiBase.z);
    ctx.spawnBuilding(world, `${ex}SmWindtrap`, owner, aiBase.x + 6, aiBase.z);
    ctx.spawnBuilding(world, `${ex}Barracks`, owner, aiBase.x - 6, aiBase.z);
    ctx.spawnBuilding(world, `${ex}Factory`, owner, aiBase.x, aiBase.z + 6);
    ctx.spawnBuilding(world, `${ex}SmWindtrap`, owner, aiBase.x + 6, aiBase.z + 6);
    ctx.spawnBuilding(world, `${ex}Refinery`, owner, aiBase.x - 6, aiBase.z + 6);

    const enemyInfantry = [...gameRules.units.keys()].filter(n => {
      const def = gameRules.units.get(n);
      return n.startsWith(ex) && def?.infantry && !def.aiSpecial && def.techLevel <= 2;
    });
    const enemyVehicles = [...gameRules.units.keys()].filter(n => {
      const def = gameRules.units.get(n);
      return n.startsWith(ex) && def && !def.infantry && def.cost > 0 && !def.canFly && !def.aiSpecial && def.techLevel <= 2;
    });

    for (let j = 0; j < 3 && j < enemyInfantry.length; j++) {
      ctx.spawnUnit(world, enemyInfantry[j], owner, aiBase.x - 5 + j * 2, aiBase.z + 10);
    }
    for (let j = 0; j < 3 && j < enemyVehicles.length; j++) {
      ctx.spawnUnit(world, enemyVehicles[j], owner, aiBase.x + 1 + j * 2, aiBase.z + 12);
    }

    const enemyHarvTypes = [...gameRules.units.keys()].filter(n =>
      (n.startsWith(ex) || n === 'Harvester') && (n.includes('Harv') || n.includes('harvester'))
    );
    if (enemyHarvTypes.length > 0) {
      ctx.spawnUnit(world, enemyHarvTypes[0], owner, aiBase.x - 5, aiBase.z + 12);
    }
  }

  // Camera starts at player base (or first AI base in observer mode)
  if (isObserver && spawnPositions.length > 0) {
    const aiBase = spawnPositions[0];
    scene.cameraTarget.set(aiBase.x, 0, aiBase.z);
  } else {
    scene.cameraTarget.set(playerBase.x, 0, playerBase.z);
  }
  scene.updateCameraPosition();
}
