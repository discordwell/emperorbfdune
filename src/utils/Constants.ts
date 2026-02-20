// Constants extracted from rules.txt [General] section at startup
// These are set once during initialization and treated as immutable

export const GameConstants = {
  SPICE_VALUE: 200,
  FOG_REGROW_RATE: 10,
  REPAIR_RATE: 12,
  REARM_RATE: 50,
  HARV_REPLACEMENT_DELAY: 1000,
  MAX_BUILDING_PLACEMENT_TILE_DIST: 6,
  MIN_CARRY_TILE_DIST: 10,
  BULLET_GRAVITY: 1.0,
  SUPPRESSION_DELAY: 200,
  SUPPRESSION_PROB: 5,
  INF_ROCK_RANGE_BONUS: 2,
  HEIGHT_RANGE_BONUS: 1,
  INF_DAMAGE_RANGE_BONUS: 50,
  MAX_SURFACE_WORMS: 1,
  CHANCE_OF_SURFACE_WORM: 6000,
  SURFACE_WORM_MIN_LIFE: 600,
  SURFACE_WORM_MAX_LIFE: 1000,
  WORM_ATTRACTION_RADIUS: 32,
  GUARD_TILE_RANGE: 12,
  STEALTH_DELAY: 30,
  DEVIATE_DURATION: 500,
  // Spice mound / bloom mechanics (from rules.txt [SpiceMound] + [General])
  SPICE_MOUND_MIN_DURATION: 1000, // Min ticks before mound bursts
  SPICE_MOUND_RANDOM_DURATION: 500, // Randomness added to mound lifespan
  SPICE_BLOOM_RADIUS: 6, // Radius of spice bloom patch (in tiles)
  SPICE_MOUND_REGROW_MIN: 200, // Min delay before mound starts regrowing
  SPICE_MOUND_REGROW_MAX: 2000, // Max delay before mound starts regrowing
  SPICE_BLOOM_DAMAGE: 200, // Damage to nearby units on eruption (with linear falloff from center)
  SPICE_BLOOM_DAMAGE_RADIUS: 12, // Bloom damage radius in world units (matches 6-tile bloom radius)
  SPICE_SPREAD_INTERVAL: 100, // Ticks between spread attempts
  SPICE_SPREAD_CHANCE: 0.03, // Chance per spice tile per spread tick
  SPICE_GROWTH_RATE: 0.002, // Density increase per growth tick
  CASH_NO_SPICE_AMOUNT_MIN: 10000,
  CASH_NO_SPICE_AMOUNT_MAX: 20000,
  CASH_NO_SPICE_FREQ_MIN: 4000,
  CASH_NO_SPICE_FREQ_MAX: 8000,
  // Sandstorm mechanics (from rules.txt [General])
  STORM_MIN_WAIT: 7500,
  STORM_MAX_WAIT: 1500,
  STORM_MIN_LIFE: 2000,
  STORM_MAX_LIFE: 2500,
  STORM_KILL_CHANCE: 127,
  // Difficulty multipliers (percentage values from rules.txt [General])
  EASY_BUILD_COST: 50,
  NORMAL_BUILD_COST: 100,
  HARD_BUILD_COST: 125,
  EASY_BUILD_TIME: 75,
  NORMAL_BUILD_TIME: 100,
  HARD_BUILD_TIME: 125,
};

export function loadConstants(general: Record<string, string>): void {
  const g = (key: string, fallback: number): number => {
    const v = general[key];
    return v !== undefined ? parseFloat(v) : fallback;
  };

  GameConstants.SPICE_VALUE = g('SpiceValue', 200);
  GameConstants.FOG_REGROW_RATE = g('FogRegrowRate', 10);
  GameConstants.REPAIR_RATE = g('RepairRate', 12);
  GameConstants.REARM_RATE = g('RearmRate', 50);
  GameConstants.HARV_REPLACEMENT_DELAY = g('HarvReplacementDelay', 1000);
  GameConstants.MAX_BUILDING_PLACEMENT_TILE_DIST = g('MaxBuildingPlacementTileDist', 6);
  GameConstants.MIN_CARRY_TILE_DIST = g('MinCarryTileDist', 10);
  GameConstants.BULLET_GRAVITY = g('BulletGravity', 1.0);
  GameConstants.SUPPRESSION_DELAY = g('SuppressionDelay', 200);
  GameConstants.SUPPRESSION_PROB = g('SuppressionProb', 5);
  GameConstants.INF_ROCK_RANGE_BONUS = g('InfRockRangeBonus', 2);
  GameConstants.HEIGHT_RANGE_BONUS = g('HeightRangeBonus', 1);
  GameConstants.INF_DAMAGE_RANGE_BONUS = g('InfDamageRangeBonus', 50);
  GameConstants.MAX_SURFACE_WORMS = g('MaximumSurfaceWorms', 1);
  GameConstants.CHANCE_OF_SURFACE_WORM = g('ChanceOfSurfaceWorm', 6000);
  GameConstants.SURFACE_WORM_MIN_LIFE = g('SurfaceWormMinLife', 600);
  GameConstants.SURFACE_WORM_MAX_LIFE = g('SurfaceWormMaxLife', 1000);
  GameConstants.WORM_ATTRACTION_RADIUS = g('WormAttractionRadius', 32);
  GameConstants.GUARD_TILE_RANGE = g('GuardTileRange', 12);
  GameConstants.STEALTH_DELAY = g('StealthDelay', 30);
  GameConstants.DEVIATE_DURATION = g('DeviateDuration', 500);
  GameConstants.CASH_NO_SPICE_AMOUNT_MIN = g('CashDeliveryWhenNoSpiceAmountMin', 10000);
  GameConstants.CASH_NO_SPICE_AMOUNT_MAX = g('CashDeliveryWhenNoSpiceAmountMax', 20000);
  GameConstants.CASH_NO_SPICE_FREQ_MIN = g('CashDeliveryWhenNoSpiceFrequencyMin', 4000);
  GameConstants.CASH_NO_SPICE_FREQ_MAX = g('CashDeliveryWhenNoSpiceFrequencyMax', 8000);
  GameConstants.STORM_MIN_WAIT = g('StormMinWait', 7500);
  GameConstants.STORM_MAX_WAIT = g('StormMaxWait', 1500);
  GameConstants.STORM_MIN_LIFE = g('StormMinLife', 2000);
  GameConstants.STORM_MAX_LIFE = g('StormMaxLife', 2500);
  GameConstants.STORM_KILL_CHANCE = g('StormKillChance', 127);
  GameConstants.EASY_BUILD_COST = g('EasyBuildCost', 50);
  GameConstants.NORMAL_BUILD_COST = g('NormalBuildCost', 100);
  GameConstants.HARD_BUILD_COST = g('HardBuildCost', 125);
  GameConstants.EASY_BUILD_TIME = g('EasyBuildTime', 75);
  GameConstants.NORMAL_BUILD_TIME = g('NormalBuildTime', 100);
  GameConstants.HARD_BUILD_TIME = g('HardBuildTime', 125);
}
