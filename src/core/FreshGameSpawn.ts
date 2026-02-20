import type { GameContext } from './GameContext';
import { createSeededRng, getSpawnPositions } from '../utils/GameHelpers';
import {
  addComponent,
  Harvester,
} from './ECS';

export function spawnFreshGame(ctx: GameContext): void {
  const {
    game, gameRules, typeRegistry, terrain, aiPlayers, opponents, house,
    totalPlayers, activeMapId, scene,
  } = ctx;
  const { unitTypeNames } = typeRegistry;
  const world = game.getWorld();

  // Distribute spawn positions for all players
  let spawnRandom = Math.random;
  if (activeMapId) {
    spawnRandom = createSeededRng(`${activeMapId}|${house.prefix}|${house.enemyPrefix}|${totalPlayers}`);
  } else if (house.mapChoice) {
    spawnRandom = createSeededRng(`${house.mapChoice.seed}|${house.prefix}|${house.enemyPrefix}|${totalPlayers}`);
  }
  const spawnPositions = getSpawnPositions(terrain.getMapWidth(), terrain.getMapHeight(), totalPlayers, spawnRandom);
  const playerBase = spawnPositions[0];

  // Update all AI targets/bases to match spawn positions
  for (let i = 0; i < aiPlayers.length; i++) {
    const aiBase = spawnPositions[i + 1];
    aiPlayers[i].setBasePosition(aiBase.x, aiBase.z);
    aiPlayers[i].setTargetPosition(playerBase.x, playerBase.z);
  }

  // Player base
  const px = house.prefix;
  ctx.spawnBuilding(world, `${px}ConYard`, 0, playerBase.x, playerBase.z);
  ctx.spawnBuilding(world, `${px}SmWindtrap`, 0, playerBase.x + 6, playerBase.z);
  ctx.spawnBuilding(world, `${px}Barracks`, 0, playerBase.x - 6, playerBase.z);
  ctx.spawnBuilding(world, `${px}Factory`, 0, playerBase.x, playerBase.z + 6);
  ctx.spawnBuilding(world, `${px}Refinery`, 0, playerBase.x + 6, playerBase.z + 6);

  // Starting player units
  const playerInfantry = [...gameRules.units.keys()].filter(n => n.startsWith(px) && gameRules.units.get(n)?.infantry);
  const playerVehicles = [...gameRules.units.keys()].filter(n => n.startsWith(px) && !gameRules.units.get(n)?.infantry && gameRules.units.get(n)!.cost > 0);

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
      }
    }
  }

  // AI bases
  for (let i = 0; i < opponents.length; i++) {
    const aiBase = spawnPositions[i + 1];
    const ex = opponents[i].prefix;
    const owner = i + 1;

    ctx.spawnBuilding(world, `${ex}ConYard`, owner, aiBase.x, aiBase.z);
    ctx.spawnBuilding(world, `${ex}SmWindtrap`, owner, aiBase.x + 6, aiBase.z);
    ctx.spawnBuilding(world, `${ex}Barracks`, owner, aiBase.x - 6, aiBase.z);
    ctx.spawnBuilding(world, `${ex}Factory`, owner, aiBase.x, aiBase.z + 6);
    ctx.spawnBuilding(world, `${ex}SmWindtrap`, owner, aiBase.x + 6, aiBase.z + 6);
    ctx.spawnBuilding(world, `${ex}Refinery`, owner, aiBase.x - 6, aiBase.z + 6);

    const enemyInfantry = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && gameRules.units.get(n)?.infantry);
    const enemyVehicles = [...gameRules.units.keys()].filter(n => n.startsWith(ex) && !gameRules.units.get(n)?.infantry && gameRules.units.get(n)!.cost > 0 && !gameRules.units.get(n)!.canFly);

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

  // Camera starts at player base
  scene.cameraTarget.set(playerBase.x, 0, playerBase.z);
  scene.updateCameraPosition();
}
