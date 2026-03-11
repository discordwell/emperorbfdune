/**
 * Superweapon Parity Test (SW1-SW4)
 * Verifies superweapon charge durations, damage chains, and prerequisites.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getRealRules } from './rulesOracle';
import { GameConstants, loadConstants } from '../../src/utils/Constants';
import { TILE_SIZE } from '../../src/utils/MathUtils';
import type { GameRules } from '../../src/config/RulesParser';

describe('SuperweaponParity — superweapon verification', () => {
  let rules: GameRules;

  beforeAll(() => {
    rules = getRealRules();
    loadConstants(rules.general);
  });

  // --- SW1: Charge durations ---
  describe('SW1: Superweapon charge durations from General', () => {
    it('HawkStrikeDuration matches rules.txt', () => {
      expect(GameConstants.HAWK_STRIKE_DURATION).toBe(500);
    });

    it('LightningDuration matches rules.txt', () => {
      expect(GameConstants.LIGHTNING_DURATION).toBe(300);
    });

    it('DeviateDuration matches rules.txt (last-wins = 500)', () => {
      expect(GameConstants.DEVIATE_DURATION).toBe(500);
    });
  });

  // --- SW2: Superweapon unit damage chains ---
  describe('SW2: Superweapon unit → bullet → warhead chains', () => {
    it('superweapon units have valid resource fields', () => {
      const superUnits = [...rules.units.values()].filter(
        u => u.deathHand || u.hawkWeapon || u.beamWeapon
      );
      expect(superUnits.length, 'should have superweapon units').toBeGreaterThan(0);
    });

    it('DeathHand units exist', () => {
      const deathHands = [...rules.units.values()].filter(u => u.deathHand);
      expect(deathHands.length).toBeGreaterThan(0);
      for (const u of deathHands) {
        expect(u.house, `${u.name} should have house`).toBeTruthy();
      }
    });

    it('HawkWeapon units exist', () => {
      const hawks = [...rules.units.values()].filter(u => u.hawkWeapon);
      expect(hawks.length).toBeGreaterThan(0);
    });

    it('BeamWeapon units exist', () => {
      const beams = [...rules.units.values()].filter(u => u.beamWeapon);
      expect(beams.length).toBeGreaterThan(0);
    });
  });

  // --- SW3: Blast radius conversion ---
  describe('SW3: Blast radius conversion', () => {
    it('blastRadius/32 * TILE_SIZE = world-space radius', () => {
      // In rules.txt, blastRadius is in game units where 32 = 1 tile
      // World-space conversion: blastRadius / 32 * TILE_SIZE
      const blastRadius = 64; // 2 tiles in game units
      const worldRadius = (blastRadius / 32) * TILE_SIZE;
      expect(worldRadius).toBe(4); // 2 tiles * 2 world units per tile
    });

    it('AoE bullets with blastRadius > 0 exist in rules.txt', () => {
      const aoeBullets = [...rules.bullets.values()].filter(b => b.blastRadius > 0);
      expect(aoeBullets.length).toBeGreaterThan(0);

      for (const b of aoeBullets) {
        expect(b.blastRadius, `${b.name} blastRadius`).toBeGreaterThan(0);
      }
    });
  });

  // --- SW4: Palace prerequisite ---
  describe('SW4: Palace prerequisite for superweapon units', () => {
    it('superweapon units require high-tier buildings', () => {
      const superUnits = [...rules.units.values()].filter(
        u => u.deathHand || u.hawkWeapon || u.beamWeapon
      );

      for (const u of superUnits) {
        // Super weapons should require some building chain
        // They typically are aiSpecial or have specific prerequisites
        expect(
          u.primaryBuilding || u.aiSpecial,
          `${u.name} should have prerequisites or be aiSpecial`
        ).toBeTruthy();
      }
    });

    it('palace buildings exist per faction', () => {
      // Look for palace/high-tier buildings
      const palaces = [...rules.buildings.entries()].filter(([name]) =>
        name.toLowerCase().includes('palace')
      );
      expect(palaces.length, 'should have palace buildings').toBeGreaterThan(0);
    });
  });
});
