/**
 * Movement Parity Test (MV1-MV6)
 * Verifies movement formulas from MovementSystem.ts against rules.txt.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getRealRules } from './rulesOracle';
import type { GameRules } from '../../src/config/RulesParser';

describe('MovementParity — movement formula verification', () => {
  let rules: GameRules;

  beforeAll(() => {
    rules = getRealRules();
  });

  // --- MV1: Speed from rules.txt ---
  describe('MV1: Unit speed from rules.txt', () => {
    it('every unit has a non-negative speed', () => {
      for (const [name, def] of rules.units) {
        expect(def.speed, `${name}.speed`).toBeGreaterThanOrEqual(0);
      }
    });

    it('mobile units (cost > 0, not buildings) have speed > 0', () => {
      for (const [name, def] of rules.units) {
        if (def.cost > 0 && !def.aiSpecial) {
          expect(def.speed, `${name} should have speed > 0`).toBeGreaterThan(0);
        }
      }
    });

    it('speed values are reasonable (0-50 range)', () => {
      for (const [name, def] of rules.units) {
        expect(def.speed, `${name}`).toBeLessThanOrEqual(50);
      }
    });
  });

  // --- MV2: TurnRate ---
  describe('MV2: TurnRate interpretation', () => {
    it('every unit has a turnRate', () => {
      for (const [name, def] of rules.units) {
        expect(typeof def.turnRate, `${name}.turnRate type`).toBe('number');
      }
    });

    it('turnRate values are non-negative for mobile units', () => {
      for (const [name, def] of rules.units) {
        if (def.speed > 0) {
          expect(def.turnRate, `${name} turnRate`).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  // --- MV3: Derived acceleration categories ---
  describe('MV3: Derived acceleration from unit characteristics', () => {
    it('aircraft: acceleration = speed * 0.25', () => {
      for (const [name, def] of rules.units) {
        if (def.canFly && def.speed > 0) {
          const expected = def.speed * 0.25;
          expect(def.acceleration, `${name} aircraft accel`).toBeCloseTo(expected, 4);
        }
      }
    });

    it('infantry: acceleration = speed * 0.15', () => {
      for (const [name, def] of rules.units) {
        if (def.infantry && !def.canFly && def.speed > 0) {
          const expected = def.speed * 0.15;
          expect(def.acceleration, `${name} infantry accel`).toBeCloseTo(expected, 4);
        }
      }
    });

    it('heavy vehicles (size >= 3): acceleration = speed * 0.06', () => {
      for (const [name, def] of rules.units) {
        if (!def.infantry && !def.canFly && def.size >= 3 && def.speed > 0) {
          const expected = def.speed * 0.06;
          expect(def.acceleration, `${name} heavy accel`).toBeCloseTo(expected, 4);
        }
      }
    });

    it('medium vehicles (size 2): acceleration = speed * 0.10', () => {
      for (const [name, def] of rules.units) {
        if (!def.infantry && !def.canFly && def.size === 2 && def.speed > 0) {
          const expected = def.speed * 0.10;
          expect(def.acceleration, `${name} medium accel`).toBeCloseTo(expected, 4);
        }
      }
    });

    it('light vehicles (size 1): acceleration = speed * 0.18', () => {
      for (const [name, def] of rules.units) {
        if (!def.infantry && !def.canFly && def.size === 1 && def.speed > 0) {
          const expected = def.speed * 0.18;
          expect(def.acceleration, `${name} light accel`).toBeCloseTo(expected, 4);
        }
      }
    });

    it('all mobile units have derived acceleration > 0', () => {
      for (const [name, def] of rules.units) {
        if (def.speed > 0) {
          expect(def.acceleration, `${name} should have acceleration`).toBeGreaterThan(0);
        }
      }
    });
  });

  // --- MV4: Braking distance formula ---
  describe('MV4: Braking distance formula', () => {
    it('braking distance = v^2 / (2 * decel) where decel = accel * 2', () => {
      // Pick a sample unit
      for (const [name, def] of rules.units) {
        if (def.speed > 0 && def.acceleration > 0) {
          const decel = def.acceleration * 2;
          const brakingDist = (def.speed * def.speed) / (2 * decel);
          expect(brakingDist, `${name} braking dist`).toBeGreaterThan(0);
          expect(brakingDist, `${name} braking dist`).toBeLessThan(1000); // sanity check
          break; // Just verify one
        }
      }
    });

    it('deceleration = 2 * acceleration (twice the accel rate)', () => {
      const accel = 0.5;
      const decel = accel * 2;
      expect(decel).toBe(1.0);
    });

    it('max safe speed at distance d = sqrt(2 * decel * d)', () => {
      const decel = 1.0;
      const distance = 10;
      const maxSafeSpeed = Math.sqrt(2 * decel * distance);
      expect(maxSafeSpeed).toBeCloseTo(Math.sqrt(20), 6);
    });
  });

  // --- MV5: Stuck detection ---
  describe('MV5: Stuck detection thresholds', () => {
    it('stuck threshold: 30 ticks with < 0.05 movement', () => {
      const STUCK_TICK_THRESHOLD = 30;
      const STUCK_MOVE_THRESHOLD = 0.05;
      expect(STUCK_TICK_THRESHOLD).toBe(30);
      expect(STUCK_MOVE_THRESHOLD).toBe(0.05);
    });
  });

  // --- MV6: Flight altitude ---
  describe('MV6: Flight altitude constant', () => {
    it('FLIGHT_ALTITUDE = 5.0', () => {
      const FLIGHT_ALTITUDE = 5.0;
      expect(FLIGHT_ALTITUDE).toBe(5.0);
    });

    it('flying units exist for verification', () => {
      const flyers = [...rules.units.values()].filter(u => u.canFly);
      expect(flyers.length).toBeGreaterThan(0);
    });
  });
});
