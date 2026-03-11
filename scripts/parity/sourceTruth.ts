/**
 * Source Truth Comparison Engine — compares raw INI data against RulesParser output.
 * Reports match/mismatch/derived/default_applied for every field.
 */

import { parseRawIni, rawNum, type RawIniData, type RawSection } from './rawIniParser';
import { parseRules, type GameRules, type CrateDef } from '../../src/config/RulesParser';
import { type UnitDef } from '../../src/config/UnitDefs';
import { type BuildingDef } from '../../src/config/BuildingDefs';
import { type TurretDef, type BulletDef, type WarheadDef, ARMOUR_TYPES } from '../../src/config/WeaponDefs';
import { GameConstants, loadConstants, loadSpiceMoundConfig } from '../../src/utils/Constants';

export type ComparisonStatus = 'match' | 'mismatch' | 'derived' | 'default_applied' | 'intentional_divergence';

export interface FieldComparison {
  category: string;
  entityName: string;
  field: string;
  rawValue: string | undefined;
  parsedValue: string | number | boolean | undefined;
  status: ComparisonStatus;
  note?: string;
}

export interface ParityReport {
  timestamp: string;
  totalFields: number;
  matches: number;
  mismatches: number;
  derived: number;
  defaultApplied: number;
  intentionalDivergences: number;
  fields: FieldComparison[];
}

// Known intentional divergences between raw INI and parsed values
const INTENTIONAL_DIVERGENCES: Record<string, string> = {
  'General.DEVIATE_DURATION': 'Duplicate key in rules.txt (lines ~32 and ~87). Last-wins = 500, first = 400. Parser correctly uses last value.',
};

function compare(
  category: string,
  entityName: string,
  field: string,
  rawValue: string | number | boolean | undefined,
  parsedValue: string | number | boolean | undefined,
  note?: string
): FieldComparison {
  const rawStr = rawValue !== undefined ? String(rawValue) : undefined;
  const parsedStr = parsedValue !== undefined ? String(parsedValue) : undefined;

  const divKey = `${category}.${field}`;
  if (INTENTIONAL_DIVERGENCES[divKey]) {
    return { category, entityName, field, rawValue: rawStr, parsedValue, status: 'intentional_divergence', note: INTENTIONAL_DIVERGENCES[divKey] };
  }

  if (rawStr === undefined && parsedValue !== undefined) {
    return { category, entityName, field, rawValue: rawStr, parsedValue, status: 'default_applied', note };
  }

  if (rawStr === undefined && parsedValue === undefined) {
    return { category, entityName, field, rawValue: rawStr, parsedValue, status: 'match' };
  }

  // Numeric comparison with tolerance
  const rawN = rawStr !== undefined ? parseFloat(rawStr) : NaN;
  const parsedN = typeof parsedValue === 'number' ? parsedValue : parseFloat(String(parsedValue));
  if (!isNaN(rawN) && !isNaN(parsedN)) {
    const match = Math.abs(rawN - parsedN) < 0.001;
    return { category, entityName, field, rawValue: rawStr, parsedValue, status: match ? 'match' : 'mismatch', note };
  }

  // Boolean comparison
  if (typeof parsedValue === 'boolean') {
    const rawBoolVal = rawStr?.toLowerCase() === 'true' || rawStr === '1';
    return { category, entityName, field, rawValue: rawStr, parsedValue, status: rawBoolVal === parsedValue ? 'match' : 'mismatch', note };
  }

  // String comparison (case-sensitive)
  const match = rawStr === parsedStr;
  return { category, entityName, field, rawValue: rawStr, parsedValue, status: match ? 'match' : 'mismatch', note };
}

// ---- Field mapping tables ----

function compareGeneral(raw: RawSection | undefined, rules: GameRules): FieldComparison[] {
  if (!raw) return [];

  // Load constants so GameConstants reflects rules.txt
  loadConstants(rules.general);

  const results: FieldComparison[] = [];
  const g = (iniKey: string, gcField: string, gcValue: number | boolean) => {
    const rawVal = raw.entries.get(iniKey);
    results.push(compare('General', 'GameConstants', gcField, rawVal, gcValue));
  };

  g('SpiceValue', 'SPICE_VALUE', GameConstants.SPICE_VALUE);
  g('FogRegrowRate', 'FOG_REGROW_RATE', GameConstants.FOG_REGROW_RATE);
  g('RepairRate', 'REPAIR_RATE', GameConstants.REPAIR_RATE);
  g('RearmRate', 'REARM_RATE', GameConstants.REARM_RATE);
  g('HarvReplacementDelay', 'HARV_REPLACEMENT_DELAY', GameConstants.HARV_REPLACEMENT_DELAY);
  g('MaxBuildingPlacementTileDist', 'MAX_BUILDING_PLACEMENT_TILE_DIST', GameConstants.MAX_BUILDING_PLACEMENT_TILE_DIST);
  g('MinCarryTileDist', 'MIN_CARRY_TILE_DIST', GameConstants.MIN_CARRY_TILE_DIST);
  g('BulletGravity', 'BULLET_GRAVITY', GameConstants.BULLET_GRAVITY);
  g('SuppressionDelay', 'SUPPRESSION_DELAY', GameConstants.SUPPRESSION_DELAY);
  g('SuppressionProb', 'SUPPRESSION_PROB', GameConstants.SUPPRESSION_PROB);
  g('InfRockRangeBonus', 'INF_ROCK_RANGE_BONUS', GameConstants.INF_ROCK_RANGE_BONUS);
  g('HeightRangeBonus', 'HEIGHT_RANGE_BONUS', GameConstants.HEIGHT_RANGE_BONUS);
  g('InfDamageRangeBonus', 'INF_DAMAGE_RANGE_BONUS', GameConstants.INF_DAMAGE_RANGE_BONUS);
  g('MaximumSurfaceWorms', 'MAX_SURFACE_WORMS', GameConstants.MAX_SURFACE_WORMS);
  g('ChanceOfSurfaceWorm', 'CHANCE_OF_SURFACE_WORM', GameConstants.CHANCE_OF_SURFACE_WORM);
  g('SurfaceWormMinLife', 'SURFACE_WORM_MIN_LIFE', GameConstants.SURFACE_WORM_MIN_LIFE);
  g('SurfaceWormMaxLife', 'SURFACE_WORM_MAX_LIFE', GameConstants.SURFACE_WORM_MAX_LIFE);
  g('WormAttractionRadius', 'WORM_ATTRACTION_RADIUS', GameConstants.WORM_ATTRACTION_RADIUS);
  g('GuardTileRange', 'GUARD_TILE_RANGE', GameConstants.GUARD_TILE_RANGE);
  g('StealthDelay', 'STEALTH_DELAY', GameConstants.STEALTH_DELAY);
  g('DeviateDuration', 'DEVIATE_DURATION', GameConstants.DEVIATE_DURATION);
  g('StormMinWait', 'STORM_MIN_WAIT', GameConstants.STORM_MIN_WAIT);
  g('StormMaxWait', 'STORM_MAX_WAIT', GameConstants.STORM_MAX_WAIT);
  g('StormMinLife', 'STORM_MIN_LIFE', GameConstants.STORM_MIN_LIFE);
  g('StormMaxLife', 'STORM_MAX_LIFE', GameConstants.STORM_MAX_LIFE);
  g('StormKillChance', 'STORM_KILL_CHANCE', GameConstants.STORM_KILL_CHANCE);
  g('EasyBuildCost', 'EASY_BUILD_COST', GameConstants.EASY_BUILD_COST);
  g('NormalBuildCost', 'NORMAL_BUILD_COST', GameConstants.NORMAL_BUILD_COST);
  g('HardBuildCost', 'HARD_BUILD_COST', GameConstants.HARD_BUILD_COST);
  g('EasyBuildTime', 'EASY_BUILD_TIME', GameConstants.EASY_BUILD_TIME);
  g('NormalBuildTime', 'NORMAL_BUILD_TIME', GameConstants.NORMAL_BUILD_TIME);
  g('HardBuildTime', 'HARD_BUILD_TIME', GameConstants.HARD_BUILD_TIME);
  g('ThumperDuration', 'THUMPER_DURATION', GameConstants.THUMPER_DURATION);
  g('MinWormRideWaitDelay', 'MIN_WORM_RIDE_WAIT', GameConstants.MIN_WORM_RIDE_WAIT);
  g('MaxWormRideWaitDelay', 'MAX_WORM_RIDE_WAIT', GameConstants.MAX_WORM_RIDE_WAIT);
  g('WormRiderLifespan', 'WORM_RIDER_LIFESPAN', GameConstants.WORM_RIDER_LIFESPAN);
  g('StealthDelayAfterFiring', 'STEALTH_DELAY_AFTER_FIRING', GameConstants.STEALTH_DELAY_AFTER_FIRING);
  g('HawkStrikeDuration', 'HAWK_STRIKE_DURATION', GameConstants.HAWK_STRIKE_DURATION);
  g('LightningDuration', 'LIGHTNING_DURATION', GameConstants.LIGHTNING_DURATION);
  g('CampaignAttackMoney', 'CAMPAIGN_ATTACK_MONEY', GameConstants.CAMPAIGN_ATTACK_MONEY);
  g('CampaignDefendMoney', 'CAMPAIGN_DEFEND_MONEY', GameConstants.CAMPAIGN_DEFEND_MONEY);
  g('UnitValueAttacker', 'UNIT_VALUE_ATTACKER', GameConstants.UNIT_VALUE_ATTACKER);
  g('UnitValueDefender', 'UNIT_VALUE_DEFENDER', GameConstants.UNIT_VALUE_DEFENDER);
  g('UnitValueReserves', 'UNIT_VALUE_RESERVES', GameConstants.UNIT_VALUE_RESERVES);
  g('UnitValueInitialReinforcements', 'UNIT_VALUE_INITIAL_REINFORCEMENTS', GameConstants.UNIT_VALUE_INITIAL_REINFORCEMENTS);
  g('UnitValueSubsequentReinforcements', 'UNIT_VALUE_SUBSEQUENT_REINFORCEMENTS', GameConstants.UNIT_VALUE_SUBSEQUENT_REINFORCEMENTS);
  g('TicksBetweenReinforcements', 'TICKS_BETWEEN_REINFORCEMENTS', GameConstants.TICKS_BETWEEN_REINFORCEMENTS);
  g('TicksBetweenReinforcementsVariation', 'TICKS_BETWEEN_REINFORCEMENTS_VARIATION', GameConstants.TICKS_BETWEEN_REINFORCEMENTS_VARIATION);
  g('TicksBeforeReinforcementsForMessage', 'TICKS_BEFORE_REINFORCEMENTS_MESSAGE', GameConstants.TICKS_BEFORE_REINFORCEMENTS_MESSAGE);
  g('StarportCostUpdateDelay', 'STARPORT_COST_UPDATE_DELAY', GameConstants.STARPORT_COST_UPDATE_DELAY);
  g('StarportCostVariationPercent', 'STARPORT_COST_VARIATION_PCT', GameConstants.STARPORT_COST_VARIATION_PCT);
  g('StarportMaxDeliverySingle', 'STARPORT_MAX_DELIVERY_SINGLE', GameConstants.STARPORT_MAX_DELIVERY_SINGLE);
  g('FrigateCountdown', 'FRIGATE_COUNTDOWN', GameConstants.FRIGATE_COUNTDOWN);
  g('FrigateTimeout', 'FRIGATE_TIMEOUT', GameConstants.FRIGATE_TIMEOUT);
  g('StarportStockIncreaseProb', 'STARPORT_STOCK_INCREASE_PROB', GameConstants.STARPORT_STOCK_INCREASE_PROB);
  g('StarportStockIncreaseDelay', 'STARPORT_STOCK_INCREASE_DELAY', GameConstants.STARPORT_STOCK_INCREASE_DELAY);
  g('SurfaceWormDisappearHealth', 'SURFACE_WORM_DISAPPEAR_HEALTH', GameConstants.SURFACE_WORM_DISAPPEAR_HEALTH);
  g('MinimumTicksWormCanAppear', 'MIN_TICKS_WORM_CAN_APPEAR', GameConstants.MIN_TICKS_WORM_CAN_APPEAR);
  g('RepairTileRange', 'REPAIR_TILE_RANGE', GameConstants.REPAIR_TILE_RANGE);
  g('AdvCarryallPickupEnemyDelay', 'ADV_CARRYALL_PICKUP_ENEMY_DELAY', GameConstants.ADV_CARRYALL_PICKUP_ENEMY_DELAY);
  g('CashDeliveryWhenNoSpiceAmountMin', 'CASH_NO_SPICE_AMOUNT_MIN', GameConstants.CASH_NO_SPICE_AMOUNT_MIN);
  g('CashDeliveryWhenNoSpiceAmountMax', 'CASH_NO_SPICE_AMOUNT_MAX', GameConstants.CASH_NO_SPICE_AMOUNT_MAX);
  g('CashDeliveryWhenNoSpiceFrequencyMin', 'CASH_NO_SPICE_FREQ_MIN', GameConstants.CASH_NO_SPICE_FREQ_MIN);
  g('CashDeliveryWhenNoSpiceFrequencyMax', 'CASH_NO_SPICE_FREQ_MAX', GameConstants.CASH_NO_SPICE_FREQ_MAX);

  // Boolean constants
  const rawReplicaFire = raw.entries.get('ReplicaShouldFire');
  results.push(compare('General', 'GameConstants', 'REPLICA_SHOULD_FIRE', rawReplicaFire, GameConstants.REPLICA_SHOULD_FIRE));
  g('ReplicaProjectionTime', 'REPLICA_PROJECTION_TIME', GameConstants.REPLICA_PROJECTION_TIME);
  g('ReplicaVanishTime', 'REPLICA_VANISH_TIME', GameConstants.REPLICA_VANISH_TIME);
  g('ReplicaFlickerChanceWhenMoving', 'REPLICA_FLICKER_CHANCE_MOVING', GameConstants.REPLICA_FLICKER_CHANCE_MOVING);
  g('ReplicaFlickerChanceWhenStill', 'REPLICA_FLICKER_CHANCE_STILL', GameConstants.REPLICA_FLICKER_CHANCE_STILL);

  // Derived values
  results.push({
    category: 'General', entityName: 'GameConstants', field: 'INF_ROCK_DAMAGE_MULT',
    rawValue: undefined, parsedValue: GameConstants.INF_ROCK_DAMAGE_MULT,
    status: 'derived', note: 'Derived: 1 + InfDamageRangeBonus/100',
  });
  results.push({
    category: 'General', entityName: 'GameConstants', field: 'SUPPRESSION_CHANCE',
    rawValue: undefined, parsedValue: GameConstants.SUPPRESSION_CHANCE,
    status: 'derived', note: 'Derived: 1 / SuppressionProb',
  });

  return results;
}

function compareSpiceMound(raw: RawSection | undefined, rules: GameRules): FieldComparison[] {
  if (!raw) return [];

  loadSpiceMoundConfig(rules.spiceMound);

  const results: FieldComparison[] = [];
  const g = (iniKey: string, gcField: string, gcValue: number) => {
    const rawVal = raw.entries.get(iniKey);
    results.push(compare('SpiceMound', 'GameConstants', gcField, rawVal, gcValue));
  };

  g('Size', 'SPICE_MOUND_MIN_DURATION', GameConstants.SPICE_MOUND_MIN_DURATION);
  g('Cost', 'SPICE_MOUND_RANDOM_DURATION', GameConstants.SPICE_MOUND_RANDOM_DURATION);
  g('BlastRadius', 'SPICE_BLOOM_RADIUS', GameConstants.SPICE_BLOOM_RADIUS);
  g('MinRange', 'SPICE_MOUND_REGROW_MIN', GameConstants.SPICE_MOUND_REGROW_MIN);
  g('MaxRange', 'SPICE_MOUND_REGROW_MAX', GameConstants.SPICE_MOUND_REGROW_MAX);
  g('Health', 'SPICE_MOUND_HEALTH', GameConstants.SPICE_MOUND_HEALTH);
  g('SpiceCapacity', 'SPICE_MOUND_CAPACITY', GameConstants.SPICE_MOUND_CAPACITY);
  g('BuildTime', 'SPICE_MOUND_APPEAR_DELAY', GameConstants.SPICE_MOUND_APPEAR_DELAY);

  // Derived
  results.push({
    category: 'SpiceMound', entityName: 'GameConstants', field: 'SPICE_BLOOM_DAMAGE',
    rawValue: undefined, parsedValue: GameConstants.SPICE_BLOOM_DAMAGE,
    status: 'derived', note: 'Derived: equals SPICE_MOUND_HEALTH',
  });
  results.push({
    category: 'SpiceMound', entityName: 'GameConstants', field: 'SPICE_BLOOM_DAMAGE_RADIUS',
    rawValue: undefined, parsedValue: GameConstants.SPICE_BLOOM_DAMAGE_RADIUS,
    status: 'derived', note: 'Derived: SPICE_BLOOM_RADIUS * TILE_SIZE',
  });

  return results;
}

function compareUnit(name: string, raw: RawSection | undefined, def: UnitDef): FieldComparison[] {
  if (!raw) return [];
  const results: FieldComparison[] = [];
  const cat = 'Unit';

  const n = (iniKey: string, field: string, val: number) => {
    results.push(compare(cat, name, field, raw.entries.get(iniKey), val));
  };
  const s = (iniKey: string, field: string, val: string) => {
    results.push(compare(cat, name, field, raw.entries.get(iniKey), val));
  };
  const b = (iniKey: string, field: string, val: boolean) => {
    results.push(compare(cat, name, field, raw.entries.get(iniKey), val));
  };

  s('House', 'house', def.house);
  n('Cost', 'cost', def.cost);
  n('BuildTime', 'buildTime', def.buildTime);
  n('Speed', 'speed', def.speed);
  n('TurnRate', 'turnRate', def.turnRate);
  n('Size', 'size', def.size);
  n('Score', 'score', def.score);
  n('TechLevel', 'techLevel', def.techLevel);
  n('StormDamage', 'stormDamage', def.stormDamage);
  n('ShieldHealth', 'shieldHealth', def.shieldHealth);
  n('HitSlowDownAmount', 'hitSlowDownAmount', def.hitSlowDownAmount);
  n('HitSlowDownDuration', 'hitSlowDownDuration', def.hitSlowDownDuration);
  n('SpiceCapacity', 'spiceCapacity', def.spiceCapacity);
  n('UnloadRate', 'unloadRate', def.unloadRate);
  n('WormAttraction', 'wormAttraction', def.wormAttraction);
  n('AIThreat', 'aiThreat', def.aiThreat);
  n('ReinforcementValue', 'reinforcementValue', def.reinforcementValue);

  // Health — note: rules.txt may have Health inside vet levels too
  // Only compare base health (first Health before VeterancyLevel)
  const healthEntries = raw.orderedEntries.filter(([k]) => k === 'Health');
  const vetEntries = raw.orderedEntries.filter(([k]) => k === 'VeterancyLevel');
  const baseHealth = vetEntries.length > 0
    ? healthEntries.find(([, ], i) => {
        const idx = raw.orderedEntries.indexOf(healthEntries[i]);
        const firstVetIdx = raw.orderedEntries.findIndex(([k]) => k === 'VeterancyLevel');
        return idx < firstVetIdx;
      })
    : healthEntries[0];
  if (baseHealth) {
    results.push(compare(cat, name, 'health', baseHealth[1], def.health));
  } else if (healthEntries.length > 0 && vetEntries.length === 0) {
    results.push(compare(cat, name, 'health', healthEntries[0][1], def.health));
  }

  b('Infantry', 'infantry', def.infantry);
  b('Engineer', 'engineer', def.engineer);
  b('CanFly', 'canFly', def.canFly);
  b('Crushes', 'crushes', def.crushes);
  b('Crushable', 'crushable', def.crushable);
  b('CanBeSuppressed', 'canBeSuppressed', def.canBeSuppressed);
  b('CanBeDeviated', 'canBeDeviated', def.canBeDeviated);
  b('CanBeRepaired', 'canBeRepaired', def.canBeRepaired);
  b('Starportable', 'starportable', def.starportable);
  b('TastyToWorms', 'tastyToWorms', def.tastyToWorms);
  b('CanMoveAnyDirection', 'canMoveAnyDirection', def.canMoveAnyDirection);
  b('AiSpecial', 'aiSpecial', def.aiSpecial);
  b('Devastator', 'selfDestruct', def.selfDestruct);
  b('APC', 'apc', def.apc);
  b('Ornithoptor', 'ornithopter', def.ornithopter);
  b('Saboteur', 'saboteur', def.saboteur);
  b('Infiltrator', 'infiltrator', def.infiltrator);
  b('Leech', 'leech', def.leech);
  b('CantBeLeeched', 'cantBeLeeched', def.cantBeLeeched);
  b('Projector', 'projector', def.projector);
  b('NiabTank', 'niabTank', def.niabTank);
  b('Kobra', 'kobra', def.kobra);
  b('Repair', 'repair', def.repair);
  b('DustScout', 'dustScout', def.dustScout);
  b('DeathHand', 'deathHand', def.deathHand);
  b('HawkWeapon', 'hawkWeapon', def.hawkWeapon);
  b('BeamWeapon', 'beamWeapon', def.beamWeapon);
  b('GetsHeightAdvantage', 'getsHeightAdvantage', def.getsHeightAdvantage);
  b('CrateGift', 'crateGift', def.crateGift);
  b('UpgradedPrimaryRequired', 'upgradedPrimaryRequired', def.upgradedPrimaryRequired);
  b('ExcludeFromSkirmishLose', 'excludeFromSkirmishLose', def.excludeFromSkirmishLose);
  b('ExcludeFromCampaignLose', 'excludeFromCampaignLose', def.excludeFromCampaignLose);

  // Armour (comma-separated: type, terrainBonus, terrainType)
  const rawArmour = raw.entries.get('Armour');
  if (rawArmour) {
    const armParts = rawArmour.split(',').map(s => s.trim());
    results.push(compare(cat, name, 'armour', armParts[0], def.armour));
    if (armParts.length >= 3) {
      results.push(compare(cat, name, 'armourTerrainBonus', armParts[1], def.armourTerrainBonus));
      results.push(compare(cat, name, 'armourTerrainType', armParts[2], def.armourTerrainType));
    }
  }

  // ViewRange (comma-separated: base | base,extended | base,extended,terrain)
  const rawVR = raw.entries.get('ViewRange');
  if (rawVR) {
    const vrParts = rawVR.split(',').map(s => s.trim());
    results.push(compare(cat, name, 'viewRange', vrParts[0], def.viewRange));
    if (vrParts.length >= 2) {
      results.push(compare(cat, name, 'viewRangeExtended', vrParts[1], def.viewRangeExtended));
      if (vrParts.length >= 3) {
        results.push(compare(cat, name, 'viewRangeExtendedTerrain', vrParts[2], def.viewRangeExtendedTerrain));
      }
    }
  }

  s('TurretAttach', 'turretAttach', def.turretAttach);
  s('ExplosionType', 'explosionType', def.explosionType);
  s('UnitGroup', 'unitGroup', def.unitGroup);
  s('Resource', 'resource', def.resource);

  // Acceleration is derived, mark accordingly
  const rawAccel = raw.entries.get('Acceleration');
  if (rawAccel) {
    results.push(compare(cat, name, 'acceleration', rawAccel, def.acceleration));
  } else if (def.acceleration > 0) {
    results.push({
      category: cat, entityName: name, field: 'acceleration',
      rawValue: undefined, parsedValue: def.acceleration,
      status: 'derived', note: 'Derived from speed + unit characteristics',
    });
  }

  return results;
}

function compareBuilding(name: string, raw: RawSection | undefined, def: BuildingDef): FieldComparison[] {
  if (!raw) return [];
  const results: FieldComparison[] = [];
  const cat = 'Building';

  const n = (iniKey: string, field: string, val: number) => {
    results.push(compare(cat, name, field, raw.entries.get(iniKey), val));
  };
  const s = (iniKey: string, field: string, val: string) => {
    results.push(compare(cat, name, field, raw.entries.get(iniKey), val));
  };
  const b = (iniKey: string, field: string, val: boolean) => {
    results.push(compare(cat, name, field, raw.entries.get(iniKey), val));
  };

  s('House', 'house', def.house);
  s('Group', 'group', def.group);
  n('Cost', 'cost', def.cost);
  n('BuildTime', 'buildTime', def.buildTime);
  n('Health', 'health', def.health);
  n('Score', 'score', def.score);
  n('TechLevel', 'techLevel', def.techLevel);
  n('ViewRange', 'viewRange', def.viewRange);
  n('PowerUsed', 'powerUsed', def.powerUsed);
  n('PowerGenerated', 'powerGenerated', def.powerGenerated);
  n('StormDamage', 'stormDamage', def.stormDamage);
  n('UpgradeCost', 'upgradeCost', def.upgradeCost);
  n('UpgradeTechLevel', 'upgradeTechLevel', def.upgradeTechLevel);
  n('RoofHeight', 'roofHeight', def.roofHeight);
  n('UnstealthRange', 'unstealthRange', def.unstealthRange);
  n('NumInfantryWhenGone', 'numInfantryWhenGone', def.numInfantryWhenGone);

  const rawArmour = raw.entries.get('Armour');
  if (rawArmour) {
    results.push(compare(cat, name, 'armour', rawArmour.split(',')[0].trim(), def.armour));
  }

  s('TurretAttach', 'turretAttach', def.turretAttach);
  s('ExplosionType', 'explosionType', def.explosionType);
  s('GetUnitWhenBuilt', 'getUnitWhenBuilt', def.getUnitWhenBuilt);

  b('Wall', 'wall', def.wall);
  b('Refinery', 'refinery', def.refinery);
  b('Dockable', 'dockable', def.dockable);
  b('CanBeEngineered', 'canBeEngineered', def.canBeEngineered);
  b('DisableWithLowPower', 'disableWithLowPower', def.disableWithLowPower);
  b('PopupTurret', 'popupTurret', def.popupTurret);
  b('Outpost', 'outpost', def.outpost);
  b('HideUnitOnRadar', 'hideOnRadar', def.hideOnRadar);
  b('CanBePrimary', 'canBePrimary', def.canBePrimary);
  b('UpgradedPrimaryRequired', 'upgradedPrimaryRequired', def.upgradedPrimaryRequired);
  b('AiResource', 'aiResource', def.aiResource);
  b('AiDefence', 'aiDefence', def.aiDefence);
  b('AiCritical', 'aiCritical', def.aiCritical);
  b('ExcludeFromSkirmishLose', 'excludeFromSkirmishLose', def.excludeFromSkirmishLose);
  b('ExcludeFromCampaignLose', 'excludeFromCampaignLose', def.excludeFromCampaignLose);

  return results;
}

function compareTurret(name: string, raw: RawSection | undefined, def: TurretDef): FieldComparison[] {
  if (!raw) return [];
  const results: FieldComparison[] = [];
  const cat = 'Turret';

  results.push(compare(cat, name, 'bullet', raw.entries.get('Bullet'), def.bullet));
  results.push(compare(cat, name, 'reloadCount', raw.entries.get('ReloadCount'), def.reloadCount));
  results.push(compare(cat, name, 'muzzleFlash', raw.entries.get('TurretMuzzleFlash'), def.muzzleFlash));
  results.push(compare(cat, name, 'minYRotation', raw.entries.get('TurretMinYRotation'), def.minYRotation));
  results.push(compare(cat, name, 'maxYRotation', raw.entries.get('TurretMaxYRotation'), def.maxYRotation));
  results.push(compare(cat, name, 'yRotationAngle', raw.entries.get('TurretYRotationAngle'), def.yRotationAngle));
  results.push(compare(cat, name, 'nextJoint', raw.entries.get('TurretNextJoint'), def.nextJoint));

  return results;
}

function compareBullet(name: string, raw: RawSection | undefined, def: BulletDef): FieldComparison[] {
  if (!raw) return [];
  const results: FieldComparison[] = [];
  const cat = 'Bullet';

  const n = (iniKey: string, field: string, val: number) => {
    results.push(compare(cat, name, field, raw.entries.get(iniKey), val));
  };
  const b = (iniKey: string, field: string, val: boolean) => {
    results.push(compare(cat, name, field, raw.entries.get(iniKey), val));
  };

  n('MaxRange', 'maxRange', def.maxRange);
  n('Damage', 'damage', def.damage);
  n('Speed', 'speed', def.speed);
  n('TurnRate', 'turnRate', def.turnRate);
  results.push(compare(cat, name, 'warhead', raw.entries.get('Warhead'), def.warhead));
  n('BlastRadius', 'blastRadius', def.blastRadius);
  n('FriendlyDamageAmount', 'friendlyDamageAmount', def.friendlyDamageAmount);
  n('MinRange', 'minRange', def.minRange);
  n('HomingDelay', 'homingDelay', def.homingDelay);
  n('LingerDuration', 'lingerDuration', def.lingerDuration);
  n('LingerDamage', 'lingerDamage', def.lingerDamage);

  b('Homing', 'homing', def.homing);
  b('AntiAircraft', 'antiAircraft', def.antiAircraft);
  b('IsLaser', 'isLaser', def.isLaser);
  b('BlowUp', 'blowUp', def.blowUp);
  b('ReduceDamageWithDistance', 'reduceDamageWithDistance', def.reduceDamageWithDistance);
  b('DamageFriendly', 'damageFriendly', def.damageFriendly);
  b('Continuous', 'continuous', def.continuous);
  b('Trajectory', 'trajectory', def.trajectory);
  b('AntiGround', 'antiGround', def.antiGround);

  return results;
}

function compareWarhead(name: string, raw: RawSection | undefined, def: WarheadDef): FieldComparison[] {
  if (!raw) return [];
  const results: FieldComparison[] = [];
  const cat = 'Warhead';

  for (const [armour, value] of raw.entries) {
    const parsed = def.vs[armour];
    results.push(compare(cat, name, `vs.${armour}`, value, parsed));
  }

  return results;
}

function compareCrate(name: string, raw: RawSection | undefined, def: CrateDef): FieldComparison[] {
  if (!raw) return [];
  const results: FieldComparison[] = [];
  const cat = 'Crate';

  results.push(compare(cat, name, 'size', raw.entries.get('Size'), def.size));
  results.push(compare(cat, name, 'health', raw.entries.get('Health'), def.health));
  results.push(compare(cat, name, 'lifespan', raw.entries.get('Lifespan'), def.lifespan));
  results.push(compare(cat, name, 'crateGiftObject', raw.entries.get('CrateGiftObject'), def.crateGiftObject));

  return results;
}

/** Run the full source truth comparison */
export function runComparison(rulesText: string): ParityReport {
  const raw = parseRawIni(rulesText);
  const rules = parseRules(rulesText);

  // Case-insensitive section lookup (matches RulesParser fix for Cal50_B → [cal50_B] etc.)
  const lowerRawSections = new Map<string, RawSection>();
  for (const [k, v] of raw.sections) {
    const lower = k.toLowerCase();
    if (!lowerRawSections.has(lower)) lowerRawSections.set(lower, v);
  }
  const getRawSection = (name: string): RawSection | undefined =>
    raw.sections.get(name) ?? lowerRawSections.get(name.toLowerCase());

  const fields: FieldComparison[] = [];

  // General
  fields.push(...compareGeneral(raw.sections.get('General'), rules));

  // SpiceMound
  fields.push(...compareSpiceMound(raw.sections.get('SpiceMound'), rules));

  // Units
  for (const [name, def] of rules.units) {
    fields.push(...compareUnit(name, getRawSection(name), def));
  }

  // Buildings
  for (const [name, def] of rules.buildings) {
    fields.push(...compareBuilding(name, getRawSection(name), def));
  }

  // Turrets
  for (const [name, def] of rules.turrets) {
    fields.push(...compareTurret(name, getRawSection(name), def));
  }

  // Bullets
  for (const [name, def] of rules.bullets) {
    fields.push(...compareBullet(name, getRawSection(name), def));
  }

  // Warheads
  for (const [name, def] of rules.warheads) {
    fields.push(...compareWarhead(name, getRawSection(name), def));
  }

  // Crates
  for (const [name, def] of rules.crates) {
    fields.push(...compareCrate(name, getRawSection(name), def));
  }

  const matches = fields.filter(f => f.status === 'match').length;
  const mismatches = fields.filter(f => f.status === 'mismatch').length;
  const derived = fields.filter(f => f.status === 'derived').length;
  const defaultApplied = fields.filter(f => f.status === 'default_applied').length;
  const intentionalDivergences = fields.filter(f => f.status === 'intentional_divergence').length;

  return {
    timestamp: new Date().toISOString(),
    totalFields: fields.length,
    matches,
    mismatches,
    derived,
    defaultApplied,
    intentionalDivergences,
    fields,
  };
}
