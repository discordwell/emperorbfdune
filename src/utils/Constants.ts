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
  // Combat
  SANDSTORM_DAMAGE_MULT: 0.7,
  INF_ROCK_DAMAGE_MULT: 1.5, // derived: 1 + InfDamageRangeBonus/100
  DAMAGE_DEGRADATION_MIN: 0.5,
  VET_DAMAGE_FALLBACK: [1.0, 1.15, 1.30, 1.50] as number[],
  VET_DEFENSE_FALLBACK: [1.0, 0.9, 0.8, 0.7] as number[],
  SUPPRESSION_CHANCE: 0.2,
  SUPPRESSION_SPEED_MULT: 0.5,
  STEALTHED_DETECT_RANGE: 4,
  // Sandworm
  THUMPER_DURATION: 500,
  WORM_ROAM_SPEED: 0.3,
  WORM_HUNT_SPEED: 0.6,
  WORM_MOUNTED_SPEED: 0.8,
  WORM_EMERGE_TICKS: 25,
  WORM_MOUNTED_MIN_LIFE: 1500,
  WORM_HARVESTER_ATTRACTION: 0.5,
  WORM_TASTY_ATTRACTION: 0.3,
  WORM_SPICE_DESTROY_RATE: 0.1,
  MIN_WORM_RIDE_WAIT: 100,
  MAX_WORM_RIDE_WAIT: 2000,
  WORM_RIDER_LIFESPAN: 1000,
  // Abilities
  STEALTH_DELAY_AFTER_FIRING: 10,
  HAWK_STRIKE_DURATION: 500,
  LIGHTNING_DURATION: 300,
  // Starport
  STARPORT_COST_UPDATE_DELAY: 1500,
  STARPORT_COST_VARIATION_PCT: 40,
  STARPORT_MAX_DELIVERY_SINGLE: 6,
  FRIGATE_COUNTDOWN: 2500,
  FRIGATE_TIMEOUT: 1000,
  // Worm (additional)
  SURFACE_WORM_DISAPPEAR_HEALTH: 25,
  MIN_TICKS_WORM_CAN_APPEAR: 1000,
  // Repair
  REPAIR_TILE_RANGE: 10,
  // Carryall
  ADV_CARRYALL_PICKUP_ENEMY_DELAY: 60,
  // Replica/Hologram
  REPLICA_SHOULD_FIRE: true as boolean,
  REPLICA_PROJECTION_TIME: 20,
  REPLICA_VANISH_TIME: 5,
  REPLICA_FLICKER_CHANCE_MOVING: 0,
  REPLICA_FLICKER_CHANCE_STILL: 0,
  // Fog
  DEFAULT_UNIT_VIEW_RANGE: 10,
  DEFAULT_BUILDING_VIEW_RANGE: 20,
  // Campaign
  CAMPAIGN_ATTACK_MONEY: 5000,
  CAMPAIGN_DEFEND_MONEY: 2500,
};

export function loadConstants(general: Record<string, string>): void {
  const g = (key: string, fallback: number): number => {
    const v = general[key];
    return v !== undefined ? parseFloat(v) : fallback;
  };
  const gb = (key: string, fallback: boolean): boolean => {
    const v = general[key];
    return v !== undefined ? (v.toLowerCase() === 'true' || v === '1') : fallback;
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
  // Combat: derive values from parsed rules
  GameConstants.INF_ROCK_DAMAGE_MULT = 1 + GameConstants.INF_DAMAGE_RANGE_BONUS / 100;
  GameConstants.SUPPRESSION_CHANCE = 1 / GameConstants.SUPPRESSION_PROB;
  // Sandworm
  GameConstants.THUMPER_DURATION = g('ThumperDuration', 500);
  GameConstants.MIN_WORM_RIDE_WAIT = g('MinWormRideWaitDelay', 100);
  GameConstants.MAX_WORM_RIDE_WAIT = g('MaxWormRideWaitDelay', 2000);
  GameConstants.WORM_RIDER_LIFESPAN = g('WormRiderLifespan', 1000);
  // Abilities
  GameConstants.STEALTH_DELAY_AFTER_FIRING = g('StealthDelayAfterFiring', 10);
  GameConstants.HAWK_STRIKE_DURATION = g('HawkStrikeDuration', 500);
  GameConstants.LIGHTNING_DURATION = g('LightningDuration', 300);
  // Campaign
  GameConstants.CAMPAIGN_ATTACK_MONEY = g('CampaignAttackMoney', 5000);
  GameConstants.CAMPAIGN_DEFEND_MONEY = g('CampaignDefendMoney', 2500);
  // Starport
  GameConstants.STARPORT_COST_UPDATE_DELAY = g('StarportCostUpdateDelay', 1500);
  GameConstants.STARPORT_COST_VARIATION_PCT = g('StarportCostVariationPercent', 40);
  GameConstants.STARPORT_MAX_DELIVERY_SINGLE = g('StarportMaxDeliverySingle', 6);
  GameConstants.FRIGATE_COUNTDOWN = g('FrigateCountdown', 2500);
  GameConstants.FRIGATE_TIMEOUT = g('FrigateTimeout', 1000);
  // Worm (additional)
  GameConstants.SURFACE_WORM_DISAPPEAR_HEALTH = g('SurfaceWormDisappearHealth', 25);
  GameConstants.MIN_TICKS_WORM_CAN_APPEAR = g('MinimumTicksWormCanAppear', 1000);
  // Repair
  GameConstants.REPAIR_TILE_RANGE = g('RepairTileRange', 10);
  // Carryall
  GameConstants.ADV_CARRYALL_PICKUP_ENEMY_DELAY = g('AdvCarryallPickupEnemyDelay', 60);
  // Replica/Hologram
  GameConstants.REPLICA_SHOULD_FIRE = gb('ReplicaShouldFire', true);
  GameConstants.REPLICA_PROJECTION_TIME = g('ReplicaProjectionTime', 20);
  GameConstants.REPLICA_VANISH_TIME = g('ReplicaVanishTime', 5);
  GameConstants.REPLICA_FLICKER_CHANCE_MOVING = g('ReplicaFlickerChanceWhenMoving', 0);
  GameConstants.REPLICA_FLICKER_CHANCE_STILL = g('ReplicaFlickerChanceWhenStill', 0);
}
