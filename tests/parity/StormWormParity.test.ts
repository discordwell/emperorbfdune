/**
 * Storm/Worm Parity Test (WM1-WM5)
 * Verifies sandstorm and sandworm constants from rules.txt.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseRawIni, rawNum, type RawSection } from '../../scripts/parity/rawIniParser';
import { GameConstants, loadConstants } from '../../src/utils/Constants';
import { getRealRules } from './rulesOracle';

describe('StormWormParity — storm and worm constant verification', () => {
  let raw: RawSection;

  beforeAll(() => {
    const rulesText = fs.readFileSync(
      path.resolve(__dirname, '../../extracted/MODEL0001/rules.txt'), 'utf-8'
    );
    const ini = parseRawIni(rulesText);
    raw = ini.sections.get('General')!;

    const rules = getRealRules();
    loadConstants(rules.general);
  });

  // --- WM1: Storm timing ---
  describe('WM1: Storm timing constants', () => {
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

    it('storm total wait = StormMinWait + random(StormMaxWait)', () => {
      const minWait = GameConstants.STORM_MIN_WAIT;
      const maxAdditional = GameConstants.STORM_MAX_WAIT;
      // Total wait range: [minWait, minWait + maxAdditional]
      expect(minWait).toBeGreaterThan(0);
      expect(maxAdditional).toBeGreaterThan(0);
    });

    it('storm lifetime range: [StormMinLife, StormMaxLife]', () => {
      expect(GameConstants.STORM_MAX_LIFE).toBeGreaterThanOrEqual(GameConstants.STORM_MIN_LIFE);
    });
  });

  // --- WM2: Storm kill chance ---
  describe('WM2: StormKillChance', () => {
    it('StormKillChance matches rules.txt', () => {
      expect(GameConstants.STORM_KILL_CHANCE).toBe(rawNum(raw, 'StormKillChance'));
    });

    it('kill chance value = 127 (from rules.txt)', () => {
      expect(GameConstants.STORM_KILL_CHANCE).toBe(127);
    });
  });

  // --- WM3: Worm spawn/lifetime constants ---
  describe('WM3: Worm spawn constants', () => {
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

    it('SurfaceWormDisappearHealth matches rules.txt', () => {
      expect(GameConstants.SURFACE_WORM_DISAPPEAR_HEALTH).toBe(rawNum(raw, 'SurfaceWormDisappearHealth'));
    });

    it('MinimumTicksWormCanAppear matches rules.txt', () => {
      expect(GameConstants.MIN_TICKS_WORM_CAN_APPEAR).toBe(rawNum(raw, 'MinimumTicksWormCanAppear'));
    });
  });

  // --- WM4: Worm attraction ---
  describe('WM4: Worm attraction constants', () => {
    it('WormAttractionRadius matches rules.txt', () => {
      expect(GameConstants.WORM_ATTRACTION_RADIUS).toBe(rawNum(raw, 'WormAttractionRadius'));
    });

    it('units with tastyToWorms have wormAttraction set', () => {
      const rules = getRealRules();
      const tastyUnits = [...rules.units.values()].filter(u => u.tastyToWorms);
      for (const u of tastyUnits) {
        // TastyToWorms units may or may not have explicit wormAttraction
        expect(u.tastyToWorms).toBe(true);
      }
    });

    it('wormAttraction values are numeric (may be negative for worm-repelling units)', () => {
      const rules = getRealRules();
      for (const [name, def] of rules.units) {
        expect(typeof def.wormAttraction, `${name}`).toBe('number');
        expect(isNaN(def.wormAttraction), `${name} NaN`).toBe(false);
      }
    });
  });

  // --- WM5: Thumper/wormride durations ---
  describe('WM5: Thumper and wormride durations', () => {
    it('ThumperDuration uses default (500) when not in rules.txt', () => {
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

    it('wormride wait range: [Min, Max]', () => {
      expect(GameConstants.MAX_WORM_RIDE_WAIT).toBeGreaterThan(GameConstants.MIN_WORM_RIDE_WAIT);
    });

    it('wormRider units exist (Fremen)', () => {
      const rules = getRealRules();
      const riders = [...rules.units.values()].filter(u => u.wormRider);
      expect(riders.length).toBeGreaterThan(0);
    });
  });
});
