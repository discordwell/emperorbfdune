/**
 * General Constants Parity Test (GN1-GN10)
 * Verifies every [General] value from rules.txt loads correctly into GameConstants.
 * The linchpin test — catches all General section issues.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseRawIni, rawNum, type RawSection } from '../../scripts/parity/rawIniParser';
import { GameConstants, loadConstants } from '../../src/utils/Constants';
import { getRealRules } from './rulesOracle';

describe('GeneralConstantsParity — [General] section verification', () => {
  let raw: RawSection;

  beforeAll(() => {
    // Load via independent raw parser
    const rulesText = fs.readFileSync(
      path.resolve(__dirname, '../../extracted/MODEL0001/rules.txt'), 'utf-8'
    );
    const ini = parseRawIni(rulesText);
    raw = ini.sections.get('General')!;
    expect(raw, '[General] section must exist in rules.txt').toBeDefined();

    // Load via RulesParser to populate GameConstants
    const rules = getRealRules();
    loadConstants(rules.general);
  });

  // --- GN1: Core economy constants ---
  describe('GN1: SpiceValue, RepairRate, RearmRate', () => {
    it('SpiceValue matches rules.txt', () => {
      expect(GameConstants.SPICE_VALUE).toBe(rawNum(raw, 'SpiceValue'));
    });

    it('RepairRate matches rules.txt', () => {
      expect(GameConstants.REPAIR_RATE).toBe(rawNum(raw, 'RepairRate'));
    });

    it('RearmRate matches rules.txt', () => {
      expect(GameConstants.REARM_RATE).toBe(rawNum(raw, 'RearmRate'));
    });

    it('FogRegrowRate matches rules.txt', () => {
      expect(GameConstants.FOG_REGROW_RATE).toBe(rawNum(raw, 'FogRegrowRate'));
    });

    it('HarvReplacementDelay matches rules.txt', () => {
      expect(GameConstants.HARV_REPLACEMENT_DELAY).toBe(rawNum(raw, 'HarvReplacementDelay'));
    });

    it('BulletGravity matches rules.txt', () => {
      expect(GameConstants.BULLET_GRAVITY).toBe(rawNum(raw, 'BulletGravity'));
    });
  });

  // --- GN2: Suppression constants ---
  describe('GN2: Suppression constants', () => {
    it('SuppressionDelay matches rules.txt', () => {
      expect(GameConstants.SUPPRESSION_DELAY).toBe(rawNum(raw, 'SuppressionDelay'));
    });

    it('SuppressionProb matches rules.txt', () => {
      expect(GameConstants.SUPPRESSION_PROB).toBe(rawNum(raw, 'SuppressionProb'));
    });

    it('SUPPRESSION_CHANCE is derived correctly (1/SuppressionProb)', () => {
      const prob = rawNum(raw, 'SuppressionProb')!;
      expect(GameConstants.SUPPRESSION_CHANCE).toBeCloseTo(1 / prob, 6);
    });
  });

  // --- GN3: Terrain bonuses ---
  describe('GN3: Terrain bonuses', () => {
    it('InfRockRangeBonus matches rules.txt', () => {
      expect(GameConstants.INF_ROCK_RANGE_BONUS).toBe(rawNum(raw, 'InfRockRangeBonus'));
    });

    it('HeightRangeBonus matches rules.txt', () => {
      expect(GameConstants.HEIGHT_RANGE_BONUS).toBe(rawNum(raw, 'HeightRangeBonus'));
    });

    it('InfDamageRangeBonus matches rules.txt', () => {
      expect(GameConstants.INF_DAMAGE_RANGE_BONUS).toBe(rawNum(raw, 'InfDamageRangeBonus'));
    });

    it('INF_ROCK_DAMAGE_MULT is derived correctly (1 + bonus/100)', () => {
      const bonus = rawNum(raw, 'InfDamageRangeBonus')!;
      expect(GameConstants.INF_ROCK_DAMAGE_MULT).toBeCloseTo(1 + bonus / 100, 6);
    });
  });

  // --- GN4: Difficulty multipliers ---
  describe('GN4: Difficulty multipliers', () => {
    it('EasyBuildCost matches rules.txt', () => {
      expect(GameConstants.EASY_BUILD_COST).toBe(rawNum(raw, 'EasyBuildCost'));
    });

    it('NormalBuildCost matches rules.txt', () => {
      expect(GameConstants.NORMAL_BUILD_COST).toBe(rawNum(raw, 'NormalBuildCost'));
    });

    it('HardBuildCost matches rules.txt', () => {
      expect(GameConstants.HARD_BUILD_COST).toBe(rawNum(raw, 'HardBuildCost'));
    });

    it('EasyBuildTime matches rules.txt', () => {
      expect(GameConstants.EASY_BUILD_TIME).toBe(rawNum(raw, 'EasyBuildTime'));
    });

    it('NormalBuildTime matches rules.txt', () => {
      expect(GameConstants.NORMAL_BUILD_TIME).toBe(rawNum(raw, 'NormalBuildTime'));
    });

    it('HardBuildTime matches rules.txt', () => {
      expect(GameConstants.HARD_BUILD_TIME).toBe(rawNum(raw, 'HardBuildTime'));
    });
  });

  // --- GN5: Storm constants ---
  describe('GN5: Storm constants', () => {
    it('StormMinWait matches rules.txt', () => {
      expect(GameConstants.STORM_MIN_WAIT).toBe(rawNum(raw, 'StormMinWait'));
    });

    it('StormMaxWait matches rules.txt', () => {
      expect(GameConstants.STORM_MAX_WAIT).toBe(rawNum(raw, 'StormMaxWait'));
    });

    it('StormMinLife matches rules.txt', () => {
      expect(GameConstants.STORM_MIN_LIFE).toBe(rawNum(raw, 'StormMinLife'));
    });

    it('StormMaxLife matches rules.txt', () => {
      expect(GameConstants.STORM_MAX_LIFE).toBe(rawNum(raw, 'StormMaxLife'));
    });

    it('StormKillChance matches rules.txt', () => {
      expect(GameConstants.STORM_KILL_CHANCE).toBe(rawNum(raw, 'StormKillChance'));
    });
  });

  // --- GN6: Worm constants ---
  describe('GN6: Worm constants', () => {
    it('MaximumSurfaceWorms matches rules.txt', () => {
      expect(GameConstants.MAX_SURFACE_WORMS).toBe(rawNum(raw, 'MaximumSurfaceWorms'));
    });

    it('ChanceOfSurfaceWorm matches rules.txt', () => {
      expect(GameConstants.CHANCE_OF_SURFACE_WORM).toBe(rawNum(raw, 'ChanceOfSurfaceWorm'));
    });

    it('SurfaceWormMinLife matches rules.txt', () => {
      expect(GameConstants.SURFACE_WORM_MIN_LIFE).toBe(rawNum(raw, 'SurfaceWormMinLife'));
    });

    it('SurfaceWormMaxLife matches rules.txt', () => {
      expect(GameConstants.SURFACE_WORM_MAX_LIFE).toBe(rawNum(raw, 'SurfaceWormMaxLife'));
    });

    it('WormAttractionRadius matches rules.txt', () => {
      expect(GameConstants.WORM_ATTRACTION_RADIUS).toBe(rawNum(raw, 'WormAttractionRadius'));
    });

    it('SurfaceWormDisappearHealth matches rules.txt', () => {
      expect(GameConstants.SURFACE_WORM_DISAPPEAR_HEALTH).toBe(rawNum(raw, 'SurfaceWormDisappearHealth'));
    });

    it('MinimumTicksWormCanAppear matches rules.txt', () => {
      expect(GameConstants.MIN_TICKS_WORM_CAN_APPEAR).toBe(rawNum(raw, 'MinimumTicksWormCanAppear'));
    });

    it('ThumperDuration uses default (500) when not in rules.txt', () => {
      // ThumperDuration is not present in rules.txt [General] — uses default 500
      const rawVal = rawNum(raw, 'ThumperDuration');
      if (rawVal !== undefined) {
        expect(GameConstants.THUMPER_DURATION).toBe(rawVal);
      } else {
        expect(GameConstants.THUMPER_DURATION).toBe(500);
      }
    });

    it('MinWormRideWaitDelay matches rules.txt', () => {
      expect(GameConstants.MIN_WORM_RIDE_WAIT).toBe(rawNum(raw, 'MinWormRideWaitDelay'));
    });

    it('MaxWormRideWaitDelay matches rules.txt', () => {
      expect(GameConstants.MAX_WORM_RIDE_WAIT).toBe(rawNum(raw, 'MaxWormRideWaitDelay'));
    });

    it('WormRiderLifespan matches rules.txt', () => {
      expect(GameConstants.WORM_RIDER_LIFESPAN).toBe(rawNum(raw, 'WormRiderLifespan'));
    });
  });

  // --- GN7: Starport constants ---
  describe('GN7: Starport constants', () => {
    it('StarportCostUpdateDelay matches rules.txt', () => {
      expect(GameConstants.STARPORT_COST_UPDATE_DELAY).toBe(rawNum(raw, 'StarportCostUpdateDelay'));
    });

    it('StarportCostVariationPercent matches rules.txt', () => {
      expect(GameConstants.STARPORT_COST_VARIATION_PCT).toBe(rawNum(raw, 'StarportCostVariationPercent'));
    });

    it('StarportMaxDeliverySingle matches rules.txt', () => {
      expect(GameConstants.STARPORT_MAX_DELIVERY_SINGLE).toBe(rawNum(raw, 'StarportMaxDeliverySingle'));
    });

    it('FrigateCountdown matches rules.txt', () => {
      expect(GameConstants.FRIGATE_COUNTDOWN).toBe(rawNum(raw, 'FrigateCountdown'));
    });

    it('FrigateTimeout matches rules.txt', () => {
      expect(GameConstants.FRIGATE_TIMEOUT).toBe(rawNum(raw, 'FrigateTimeout'));
    });

    it('StarportStockIncreaseProb matches rules.txt', () => {
      expect(GameConstants.STARPORT_STOCK_INCREASE_PROB).toBe(rawNum(raw, 'StarportStockIncreaseProb'));
    });

    it('StarportStockIncreaseDelay matches rules.txt', () => {
      expect(GameConstants.STARPORT_STOCK_INCREASE_DELAY).toBe(rawNum(raw, 'StarportStockIncreaseDelay'));
    });
  });

  // --- GN8: Campaign constants ---
  describe('GN8: Campaign constants', () => {
    it('CampaignAttackMoney matches rules.txt', () => {
      expect(GameConstants.CAMPAIGN_ATTACK_MONEY).toBe(rawNum(raw, 'CampaignAttackMoney'));
    });

    it('CampaignDefendMoney matches rules.txt', () => {
      expect(GameConstants.CAMPAIGN_DEFEND_MONEY).toBe(rawNum(raw, 'CampaignDefendMoney'));
    });

    it('UnitValueAttacker matches rules.txt', () => {
      expect(GameConstants.UNIT_VALUE_ATTACKER).toBe(rawNum(raw, 'UnitValueAttacker'));
    });

    it('UnitValueDefender matches rules.txt', () => {
      expect(GameConstants.UNIT_VALUE_DEFENDER).toBe(rawNum(raw, 'UnitValueDefender'));
    });

    it('UnitValueReserves matches rules.txt', () => {
      expect(GameConstants.UNIT_VALUE_RESERVES).toBe(rawNum(raw, 'UnitValueReserves'));
    });

    it('UnitValueInitialReinforcements matches rules.txt', () => {
      expect(GameConstants.UNIT_VALUE_INITIAL_REINFORCEMENTS).toBe(rawNum(raw, 'UnitValueInitialReinforcements'));
    });

    it('UnitValueSubsequentReinforcements matches rules.txt', () => {
      expect(GameConstants.UNIT_VALUE_SUBSEQUENT_REINFORCEMENTS).toBe(rawNum(raw, 'UnitValueSubsequentReinforcements'));
    });

    it('TicksBetweenReinforcements matches rules.txt', () => {
      expect(GameConstants.TICKS_BETWEEN_REINFORCEMENTS).toBe(rawNum(raw, 'TicksBetweenReinforcements'));
    });

    it('TicksBetweenReinforcementsVariation matches rules.txt', () => {
      expect(GameConstants.TICKS_BETWEEN_REINFORCEMENTS_VARIATION).toBe(rawNum(raw, 'TicksBetweenReinforcementsVariation'));
    });

    it('TicksBeforeReinforcementsForMessage matches rules.txt', () => {
      expect(GameConstants.TICKS_BEFORE_REINFORCEMENTS_MESSAGE).toBe(rawNum(raw, 'TicksBeforeReinforcementsForMessage'));
    });

    it('CashDeliveryWhenNoSpiceAmountMin matches rules.txt', () => {
      expect(GameConstants.CASH_NO_SPICE_AMOUNT_MIN).toBe(rawNum(raw, 'CashDeliveryWhenNoSpiceAmountMin'));
    });

    it('CashDeliveryWhenNoSpiceAmountMax matches rules.txt', () => {
      expect(GameConstants.CASH_NO_SPICE_AMOUNT_MAX).toBe(rawNum(raw, 'CashDeliveryWhenNoSpiceAmountMax'));
    });

    it('CashDeliveryWhenNoSpiceFrequencyMin matches rules.txt', () => {
      expect(GameConstants.CASH_NO_SPICE_FREQ_MIN).toBe(rawNum(raw, 'CashDeliveryWhenNoSpiceFrequencyMin'));
    });

    it('CashDeliveryWhenNoSpiceFrequencyMax matches rules.txt', () => {
      expect(GameConstants.CASH_NO_SPICE_FREQ_MAX).toBe(rawNum(raw, 'CashDeliveryWhenNoSpiceFrequencyMax'));
    });
  });

  // --- GN9: Stealth/ability durations ---
  describe('GN9: Stealth/ability durations', () => {
    it('StealthDelay matches rules.txt', () => {
      expect(GameConstants.STEALTH_DELAY).toBe(rawNum(raw, 'StealthDelay'));
    });

    it('StealthDelayAfterFiring matches rules.txt', () => {
      expect(GameConstants.STEALTH_DELAY_AFTER_FIRING).toBe(rawNum(raw, 'StealthDelayAfterFiring'));
    });

    it('HawkStrikeDuration matches rules.txt', () => {
      expect(GameConstants.HAWK_STRIKE_DURATION).toBe(rawNum(raw, 'HawkStrikeDuration'));
    });

    it('LightningDuration matches rules.txt', () => {
      expect(GameConstants.LIGHTNING_DURATION).toBe(rawNum(raw, 'LightningDuration'));
    });

    it('DeviateDuration uses last-wins value (500, not 400)', () => {
      // rules.txt has DeviateDuration=400 then DeviateDuration=500 — last wins
      expect(GameConstants.DEVIATE_DURATION).toBe(500);
    });

    it('GuardTileRange matches rules.txt', () => {
      expect(GameConstants.GUARD_TILE_RANGE).toBe(rawNum(raw, 'GuardTileRange'));
    });

    it('MaxBuildingPlacementTileDist matches rules.txt', () => {
      expect(GameConstants.MAX_BUILDING_PLACEMENT_TILE_DIST).toBe(rawNum(raw, 'MaxBuildingPlacementTileDist'));
    });

    it('MinCarryTileDist matches rules.txt', () => {
      expect(GameConstants.MIN_CARRY_TILE_DIST).toBe(rawNum(raw, 'MinCarryTileDist'));
    });

    it('AdvCarryallPickupEnemyDelay matches rules.txt', () => {
      expect(GameConstants.ADV_CARRYALL_PICKUP_ENEMY_DELAY).toBe(rawNum(raw, 'AdvCarryallPickupEnemyDelay'));
    });

    it('RepairTileRange matches rules.txt', () => {
      expect(GameConstants.REPAIR_TILE_RANGE).toBe(rawNum(raw, 'RepairTileRange'));
    });
  });

  // --- GN10: Replica/hologram constants ---
  describe('GN10: Replica/hologram constants', () => {
    it('ReplicaShouldFire matches rules.txt', () => {
      const raw_val = raw.entries.get('ReplicaShouldFire');
      const expected = raw_val?.toLowerCase() === 'true' || raw_val === '1';
      expect(GameConstants.REPLICA_SHOULD_FIRE).toBe(expected);
    });

    it('ReplicaProjectionTime matches rules.txt', () => {
      expect(GameConstants.REPLICA_PROJECTION_TIME).toBe(rawNum(raw, 'ReplicaProjectionTime'));
    });

    it('ReplicaVanishTime matches rules.txt', () => {
      expect(GameConstants.REPLICA_VANISH_TIME).toBe(rawNum(raw, 'ReplicaVanishTime'));
    });

    it('ReplicaFlickerChanceWhenMoving matches rules.txt', () => {
      expect(GameConstants.REPLICA_FLICKER_CHANCE_MOVING).toBe(rawNum(raw, 'ReplicaFlickerChanceWhenMoving'));
    });

    it('ReplicaFlickerChanceWhenStill matches rules.txt', () => {
      expect(GameConstants.REPLICA_FLICKER_CHANCE_STILL).toBe(rawNum(raw, 'ReplicaFlickerChanceWhenStill'));
    });
  });
});
