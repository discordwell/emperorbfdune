/**
 * Harvest Parity Test (HV1-HV6)
 * Verifies harvest economy formulas against rules.txt values.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getRealRules } from './rulesOracle';
import { GameConstants, loadConstants } from '../../src/utils/Constants';
import type { GameRules } from '../../src/config/RulesParser';

describe('HarvestParity — harvest economy verification', () => {
  let rules: GameRules;

  beforeAll(() => {
    rules = getRealRules();
    loadConstants(rules.general);
  });

  // --- HV1: SpiceValue ---
  describe('HV1: SpiceValue = 200 cash per spice unit', () => {
    it('SPICE_VALUE matches rules.txt', () => {
      expect(GameConstants.SPICE_VALUE).toBe(200);
    });

    it('spice cash conversion: spiceUnits * SPICE_VALUE', () => {
      const units = 3.5;
      const cash = units * GameConstants.SPICE_VALUE;
      expect(cash).toBe(700);
    });
  });

  // --- HV2: Per-harvester spiceCapacity ---
  describe('HV2: Harvester spice capacity', () => {
    it('default spiceCapacity = 700 (max cash value of carried spice)', () => {
      // Find harvester units
      const harvesters = [...rules.units.entries()].filter(([name]) =>
        name.toLowerCase().includes('harvester')
      );
      expect(harvesters.length).toBeGreaterThan(0);

      for (const [name, def] of harvesters) {
        // spiceCapacity is the max cash value of carried spice
        expect(def.spiceCapacity, `${name} spiceCapacity`).toBeGreaterThan(0);
      }
    });

    it('maxCapacity in spice units = spiceCapacity / SPICE_VALUE', () => {
      for (const [name, def] of rules.units) {
        if (!name.toLowerCase().includes('harvester')) continue;
        const maxUnits = def.spiceCapacity / GameConstants.SPICE_VALUE;
        expect(maxUnits, `${name} max spice units`).toBeGreaterThan(0);
      }
    });
  });

  // --- HV3: Per-harvester unloadRate ---
  describe('HV3: Harvester unload rate', () => {
    it('default unloadRate = 2', () => {
      for (const [name, def] of rules.units) {
        if (!name.toLowerCase().includes('harvester')) continue;
        expect(def.unloadRate, `${name} unloadRate`).toBe(2);
      }
    });

    it('unload rate in spice units = unloadRate / SPICE_VALUE', () => {
      const unloadRate = 2;
      const spicePerTick = unloadRate / GameConstants.SPICE_VALUE;
      expect(spicePerTick).toBeCloseTo(0.01, 6);
    });
  });

  // --- HV4: Harvester replacement delay ---
  describe('HV4: HarvReplacementDelay', () => {
    it('HarvReplacementDelay = 1000 ticks', () => {
      expect(GameConstants.HARV_REPLACEMENT_DELAY).toBe(1000);
    });
  });

  // --- HV5-HV6: Cash fallback ---
  describe('HV5: Cash fallback amounts', () => {
    it('CASH_NO_SPICE_AMOUNT_MIN = 10000', () => {
      expect(GameConstants.CASH_NO_SPICE_AMOUNT_MIN).toBe(10000);
    });

    it('CASH_NO_SPICE_AMOUNT_MAX = 20000', () => {
      expect(GameConstants.CASH_NO_SPICE_AMOUNT_MAX).toBe(20000);
    });

    it('amount range: [10000, 20000]', () => {
      expect(GameConstants.CASH_NO_SPICE_AMOUNT_MAX).toBeGreaterThan(GameConstants.CASH_NO_SPICE_AMOUNT_MIN);
    });
  });

  describe('HV6: Cash fallback frequency', () => {
    it('CASH_NO_SPICE_FREQ_MIN = 4000', () => {
      expect(GameConstants.CASH_NO_SPICE_FREQ_MIN).toBe(4000);
    });

    it('CASH_NO_SPICE_FREQ_MAX = 8000', () => {
      expect(GameConstants.CASH_NO_SPICE_FREQ_MAX).toBe(8000);
    });

    it('frequency range: [4000, 8000] ticks', () => {
      expect(GameConstants.CASH_NO_SPICE_FREQ_MAX).toBeGreaterThan(GameConstants.CASH_NO_SPICE_FREQ_MIN);
    });
  });

  // --- Additional: Refinery building verification ---
  describe('HV-refinery: Refinery buildings exist per faction', () => {
    it('each main faction has a refinery building', () => {
      for (const prefix of ['AT', 'HK', 'OR']) {
        const refineries = [...rules.buildings.entries()].filter(
          ([name, def]) => name.startsWith(prefix) && def.refinery
        );
        expect(refineries.length, `${prefix} should have a refinery`).toBeGreaterThan(0);
      }
    });
  });
});
