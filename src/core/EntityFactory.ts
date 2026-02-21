import type { GameRules } from '../config/RulesParser';
import type { ArtEntry } from '../config/ArtIniParser';
import type { TypeRegistry } from './TypeRegistry';
import type { TerrainRenderer } from '../rendering/TerrainRenderer';
import type { UnitRenderer } from '../rendering/UnitRenderer';
import type { CombatSystem } from '../simulation/CombatSystem';
import type { MovementSystem } from '../simulation/MovementSystem';
import type { HarvestSystem } from '../simulation/HarvestSystem';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { EffectsManager } from '../rendering/EffectsManager';
import type { AudioManager } from '../audio/AudioManager';
import type { SelectionPanel } from '../ui/SelectionPanel';
import type { Game } from './Game';
import type { GroundSplat } from './GameContext';
import { GameConstants } from '../utils/Constants';
import { worldToTile } from '../utils/MathUtils';
import { TerrainType } from '../rendering/TerrainRenderer';
import { EventBus } from './EventBus';
import {
  addEntity, addComponent, removeEntity, hasComponent,
  Position, Velocity, Rotation, Health, Owner, UnitType, Selectable,
  MoveTarget, AttackTarget, Combat, Armour, Speed, ViewRange, Renderable,
  Harvester, BuildingType, PowerSource, Veterancy, TurretRotation, Shield,
  buildingQuery,
  type World,
} from './ECS';

export interface EntityFactoryDeps {
  gameRules: GameRules;
  artMap: Map<string, ArtEntry>;
  typeRegistry: TypeRegistry;
  terrain: TerrainRenderer;
  unitRenderer: UnitRenderer;
  combatSystem: CombatSystem;
  movement: MovementSystem;
  harvestSystem: HarvestSystem;
  productionSystem: ProductionSystem;
  effectsManager: EffectsManager;
  audioManager: AudioManager;
  selectionPanel: SelectionPanel;
  game: Game;
  aircraftAmmo: Map<number, number>;
  rearmingAircraft: Set<number>;
  repairingBuildings: Set<number>;
  processedDeaths: Set<number>;
  MAX_AMMO: number;
}

export function createEntityFactory(deps: EntityFactoryDeps) {
  const {
    gameRules, artMap, typeRegistry, terrain, unitRenderer, combatSystem,
    movement, harvestSystem, productionSystem, effectsManager, audioManager,
    game,
    aircraftAmmo, rearmingAircraft, repairingBuildings, processedDeaths,
    MAX_AMMO,
  } = deps;
  // Read selectionPanel lazily from deps so it can be set after factory creation
  const getSelectionPanel = () => deps.selectionPanel;
  const { unitTypeIdMap, unitTypeNames, buildingTypeIdMap, buildingTypeNames, armourIdMap } = typeRegistry;

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
    Position.y[eid] = terrain.getHeightAt(x, z) + 0.1;
    Position.z[eid] = z;
    Rotation.y[eid] = 0;
    Health.current[eid] = def.health;
    Health.max[eid] = def.health;
    Owner.playerId[eid] = owner;
    UnitType.id[eid] = unitTypeIdMap.get(typeName) ?? 0;
    Selectable.selected[eid] = 0;
    MoveTarget.active[eid] = 0;
    AttackTarget.active[eid] = 0;
    AttackTarget.entityId[eid] = 0;
    Velocity.x[eid] = 0; Velocity.y[eid] = 0; Velocity.z[eid] = 0;
    Speed.max[eid] = def.speed;
    Speed.turnRate[eid] = def.turnRate;
    Renderable.modelId[eid] = unitTypeIdMap.get(typeName) ?? 0;
    Renderable.sceneIndex[eid] = -1;
    ViewRange.range[eid] = (def.viewRange || 5) * 2;

    if (def.turretAttach) {
      addComponent(world, Combat, eid);
      addComponent(world, TurretRotation, eid);
      TurretRotation.y[eid] = 0;
      const turret = gameRules.turrets.get(def.turretAttach);
      const bullet = turret ? gameRules.bullets.get(turret.bullet) : null;
      Combat.weaponId[eid] = 0;
      Combat.attackRange[eid] = bullet ? bullet.maxRange * 2 : 8;
      Combat.fireTimer[eid] = 0;
      Combat.rof[eid] = turret?.reloadCount ?? 30;
      if (bullet?.continuous) {
        Combat.rof[eid] = 1; // Continuous weapons fire every tick
      }
    }

    addComponent(world, Armour, eid);
    Armour.type[eid] = armourIdMap.get(def.armour) ?? 0;

    addComponent(world, Veterancy, eid);
    Veterancy.xp[eid] = 0;
    Veterancy.rank[eid] = 0;

    if (def.shieldHealth > 0) {
      addComponent(world, Shield, eid);
      Shield.current[eid] = def.shieldHealth;
      Shield.max[eid] = def.shieldHealth;
    }

    combatSystem.registerUnit(eid, typeName);

    const art = artMap.get(typeName);
    if (art?.xaf) {
      unitRenderer.setEntityModel(eid, art.xaf);
    }

    if (def.canFly) {
      movement.registerFlyer(eid);
      Position.y[eid] = 5.0;
    }

    if (def.infantry) {
      movement.registerInfantry(eid);
    }

    if (def.ornithopter) {
      aircraftAmmo.set(eid, MAX_AMMO);
    }

    if (typeName.includes('Harvester') || typeName.includes('Harv')) {
      addComponent(world, Harvester, eid);
      const spiceCap = def.spiceCapacity || 700;
      Harvester.maxCapacity[eid] = spiceCap / GameConstants.SPICE_VALUE;
      Harvester.spiceCarried[eid] = 0;
      Harvester.state[eid] = 0;
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
    Position.y[eid] = terrain.getHeightAt(x, z);
    Position.z[eid] = z;
    Rotation.y[eid] = 0;

    // Concrete slab bonus
    let healthBonus = 1.0;
    const bTile = worldToTile(x, z);
    const bHalfW = Math.max(1, Math.floor((def.occupy[0]?.length || 3) / 2));
    const bHalfH = Math.max(1, Math.floor((def.occupy.length || 3) / 2));
    let concreteCount = 0;
    let totalTiles = 0;
    for (let dtz = -bHalfH; dtz <= bHalfH; dtz++) {
      for (let dtx = -bHalfW; dtx <= bHalfW; dtx++) {
        totalTiles++;
        if (terrain.getTerrainType(bTile.tx + dtx, bTile.tz + dtz) === TerrainType.ConcreteSlab) {
          concreteCount++;
        }
      }
    }
    if (concreteCount > 0) {
      healthBonus = 1.0 + 0.5 * (concreteCount / totalTiles);
    }

    Health.current[eid] = Math.floor(def.health * healthBonus);
    Health.max[eid] = Math.floor(def.health * healthBonus);
    Owner.playerId[eid] = owner;
    BuildingType.id[eid] = buildingTypeIdMap.get(typeName) ?? 0;
    Renderable.modelId[eid] = 0;
    Renderable.sceneIndex[eid] = -1;
    Selectable.selected[eid] = 0;
    ViewRange.range[eid] = (def.viewRange || 10) * 2;

    if (def.powerGenerated > 0 || def.powerUsed > 0) {
      addComponent(world, PowerSource, eid);
      PowerSource.amount[eid] = def.powerGenerated - def.powerUsed;
    }

    if (def.turretAttach) {
      addComponent(world, Combat, eid);
      addComponent(world, TurretRotation, eid);
      TurretRotation.y[eid] = 0;
      addComponent(world, MoveTarget, eid);
      addComponent(world, AttackTarget, eid);
      addComponent(world, Velocity, eid);
      addComponent(world, Speed, eid);
      Speed.max[eid] = 0;
      Speed.turnRate[eid] = 0;
      MoveTarget.active[eid] = 0;
      AttackTarget.active[eid] = 0;
      AttackTarget.entityId[eid] = 0;
      Velocity.x[eid] = 0; Velocity.y[eid] = 0; Velocity.z[eid] = 0;
      const turret = gameRules.turrets.get(def.turretAttach);
      const bullet = turret ? gameRules.bullets.get(turret.bullet) : null;
      Combat.weaponId[eid] = 0;
      Combat.fireTimer[eid] = 0;
      Combat.attackRange[eid] = bullet ? bullet.maxRange * 2 : 12;
      Combat.rof[eid] = turret?.reloadCount ?? 45;
      if (bullet?.continuous) {
        Combat.rof[eid] = 1; // Continuous weapons fire every tick
      }
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
    if (Owner.playerId[eid] !== 0) return;

    const typeId = BuildingType.id[eid];
    const typeName = buildingTypeNames[typeId];
    const def = typeName ? gameRules.buildings.get(typeName) : null;
    const adjustedCost = typeName ? productionSystem.getAdjustedCost(0, typeName, true) : (def?.cost ?? 0);
    const hpRatio = Health.max[eid] > 0 ? Health.current[eid] / Health.max[eid] : 1;
    const refund = Math.floor(adjustedCost * 0.5 * hpRatio);

    harvestSystem.addSolaris(0, refund);
    getSelectionPanel().addMessage(`Sold for ${refund} Solaris`, '#f0c040');
    audioManager.getDialogManager()?.trigger('buildingSold');

    effectsManager.clearBuildingDamage(eid);
    repairingBuildings.delete(eid);

    if (typeName) {
      productionSystem.removePlayerBuilding(0, typeName);
    }
    combatSystem.unregisterUnit(eid);
    movement.unregisterEntity(eid);

    const bx = Position.x[eid];
    const bz = Position.z[eid];

    Health.current[eid] = 0;
    processedDeaths.add(eid);

    EventBus.emit('building:destroyed', { entityId: eid, owner: 0, x: bx, z: bz });
    movement.invalidateAllPaths();

    unitRenderer.startDeconstruction(eid, 50, () => {
      effectsManager.spawnExplosion(bx, Position.y[eid], bz, 'small');
      try { removeEntity(world, eid); } catch {}
    });
  }

  function repairBuilding(eid: number): void {
    const world = game.getWorld();
    if (!hasComponent(world, BuildingType, eid)) return;
    if (Owner.playerId[eid] !== 0) return;

    if (repairingBuildings.has(eid)) {
      repairingBuildings.delete(eid);
      getSelectionPanel().addMessage('Repair stopped', '#aaaaaa');
      return;
    }

    const hp = Health.current[eid];
    const maxHp = Health.max[eid];
    if (hp >= maxHp) {
      getSelectionPanel().addMessage('Building at full health', '#aaaaaa');
      return;
    }

    repairingBuildings.add(eid);
    audioManager.playSfx('build');
    getSelectionPanel().addMessage('Repairing...', '#44ff44');
  }

  function tickRepairs(): void {
    if (repairingBuildings.size === 0) return;

    for (const eid of repairingBuildings) {
      const world = game.getWorld();
      if (!hasComponent(world, BuildingType, eid) || Health.current[eid] <= 0) {
        repairingBuildings.delete(eid);
        continue;
      }

      const hp = Health.current[eid];
      const maxHp = Health.max[eid];
      if (hp >= maxHp) {
        repairingBuildings.delete(eid);
        getSelectionPanel().addMessage('Repair complete', '#44ff44');
        continue;
      }

      const repairAmount = Math.min(GameConstants.REPAIR_RATE, maxHp - hp);
      const typeId = BuildingType.id[eid];
      const typeName = buildingTypeNames[typeId];
      const def = typeName ? gameRules.buildings.get(typeName) : null;
      const cost = def ? Math.max(1, Math.floor(def.cost * (repairAmount / maxHp))) : 5;

      if (harvestSystem.spendSolaris(0, cost)) {
        Health.current[eid] += repairAmount;
      } else {
        repairingBuildings.delete(eid);
        getSelectionPanel().addMessage('Repair stopped: insufficient funds', '#ff4444');
        audioManager.getDialogManager()?.trigger('insufficientFunds');
      }
    }
  }

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

  return {
    spawnUnit,
    spawnBuilding,
    sellBuilding,
    repairBuilding,
    tickRepairs,
    findRefinery,
    findNearestLandingPad,
  };
}
