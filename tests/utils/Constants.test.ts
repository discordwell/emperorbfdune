import { describe, it, expect, beforeEach } from 'vitest';
import { GameConstants, loadConstants } from '../../src/utils/Constants';

describe('GameConstants', () => {
  it('has correct default values', () => {
    expect(GameConstants.SPICE_VALUE).toBe(200);
    expect(GameConstants.REPAIR_RATE).toBe(12);
    expect(GameConstants.MAX_SURFACE_WORMS).toBe(1);
    expect(GameConstants.STEALTH_DELAY).toBe(30);
    expect(GameConstants.DEVIATE_DURATION).toBe(500);
  });

  it('has difficulty multiplier defaults', () => {
    expect(GameConstants.EASY_BUILD_COST).toBe(50);
    expect(GameConstants.NORMAL_BUILD_COST).toBe(100);
    expect(GameConstants.HARD_BUILD_COST).toBe(125);
    expect(GameConstants.EASY_BUILD_TIME).toBe(75);
    expect(GameConstants.NORMAL_BUILD_TIME).toBe(100);
    expect(GameConstants.HARD_BUILD_TIME).toBe(125);
  });
});

describe('loadConstants', () => {
  // Save original values
  const origSpiceValue = GameConstants.SPICE_VALUE;
  const origRepairRate = GameConstants.REPAIR_RATE;

  beforeEach(() => {
    // Reset to defaults
    GameConstants.SPICE_VALUE = 200;
    GameConstants.REPAIR_RATE = 12;
  });

  it('loads values from general section', () => {
    loadConstants({ SpiceValue: '500', RepairRate: '25' });
    expect(GameConstants.SPICE_VALUE).toBe(500);
    expect(GameConstants.REPAIR_RATE).toBe(25);
  });

  it('uses fallback when key is missing', () => {
    loadConstants({});
    expect(GameConstants.SPICE_VALUE).toBe(200);
    expect(GameConstants.REPAIR_RATE).toBe(12);
  });

  it('handles all known general section keys', () => {
    loadConstants({
      FogRegrowRate: '15',
      RearmRate: '75',
      GuardTileRange: '20',
      StealthDelay: '50',
      DeviateDuration: '750',
      MaximumSurfaceWorms: '3',
      WormAttractionRadius: '48',
      StormMinWait: '5000',
      StormMaxWait: '3000',
      StormKillChance: '200',
      EasyBuildCost: '40',
      HardBuildTime: '150',
    });

    expect(GameConstants.FOG_REGROW_RATE).toBe(15);
    expect(GameConstants.REARM_RATE).toBe(75);
    expect(GameConstants.GUARD_TILE_RANGE).toBe(20);
    expect(GameConstants.STEALTH_DELAY).toBe(50);
    expect(GameConstants.DEVIATE_DURATION).toBe(750);
    expect(GameConstants.MAX_SURFACE_WORMS).toBe(3);
    expect(GameConstants.WORM_ATTRACTION_RADIUS).toBe(48);
    expect(GameConstants.STORM_MIN_WAIT).toBe(5000);
    expect(GameConstants.STORM_MAX_WAIT).toBe(3000);
    expect(GameConstants.STORM_KILL_CHANCE).toBe(200);
    expect(GameConstants.EASY_BUILD_COST).toBe(40);
    expect(GameConstants.HARD_BUILD_TIME).toBe(150);
  });
});
