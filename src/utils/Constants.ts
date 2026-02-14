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
  GameConstants.EASY_BUILD_COST = g('EasyBuildCost', 50);
  GameConstants.NORMAL_BUILD_COST = g('NormalBuildCost', 100);
  GameConstants.HARD_BUILD_COST = g('HardBuildCost', 125);
  GameConstants.EASY_BUILD_TIME = g('EasyBuildTime', 75);
  GameConstants.NORMAL_BUILD_TIME = g('NormalBuildTime', 100);
  GameConstants.HARD_BUILD_TIME = g('HardBuildTime', 125);
}
