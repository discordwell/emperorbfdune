/**
 * Spice Mound Parity Test (SM1-SM4)
 * Verifies all 8 SpiceMound constants + derived values.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseRawIni, rawNum, type RawSection } from '../../scripts/parity/rawIniParser';
import { GameConstants, loadSpiceMoundConfig } from '../../src/utils/Constants';
import { TILE_SIZE } from '../../src/utils/MathUtils';
import { getRealRules } from './rulesOracle';

describe('SpiceMoundParity — [SpiceMound] section verification', () => {
  let raw: RawSection;

  beforeAll(() => {
    const rulesText = fs.readFileSync(
      path.resolve(__dirname, '../../extracted/MODEL0001/rules.txt'), 'utf-8'
    );
    const ini = parseRawIni(rulesText);
    raw = ini.sections.get('SpiceMound')!;
    expect(raw, '[SpiceMound] section must exist').toBeDefined();

    const rules = getRealRules();
    loadSpiceMoundConfig(rules.spiceMound);
  });

  // --- SM1: Duration constants ---
  describe('SM1: Mound duration constants', () => {
    it('SPICE_MOUND_MIN_DURATION matches Size field', () => {
      expect(GameConstants.SPICE_MOUND_MIN_DURATION).toBe(rawNum(raw, 'Size'));
    });

    it('SPICE_MOUND_RANDOM_DURATION matches Cost field', () => {
      expect(GameConstants.SPICE_MOUND_RANDOM_DURATION).toBe(rawNum(raw, 'Cost'));
    });

    it('total lifetime range: [Size, Size+Cost]', () => {
      const min = GameConstants.SPICE_MOUND_MIN_DURATION;
      const max = min + GameConstants.SPICE_MOUND_RANDOM_DURATION;
      expect(max).toBeGreaterThan(min);
    });
  });

  // --- SM2: Bloom radius and health ---
  describe('SM2: Bloom radius and health', () => {
    it('SPICE_BLOOM_RADIUS matches BlastRadius field', () => {
      expect(GameConstants.SPICE_BLOOM_RADIUS).toBe(rawNum(raw, 'BlastRadius'));
    });

    it('SPICE_MOUND_HEALTH matches Health field', () => {
      expect(GameConstants.SPICE_MOUND_HEALTH).toBe(rawNum(raw, 'Health'));
    });

    it('SPICE_MOUND_CAPACITY matches SpiceCapacity field', () => {
      expect(GameConstants.SPICE_MOUND_CAPACITY).toBe(rawNum(raw, 'SpiceCapacity'));
    });

    it('SPICE_MOUND_APPEAR_DELAY matches BuildTime field', () => {
      expect(GameConstants.SPICE_MOUND_APPEAR_DELAY).toBe(rawNum(raw, 'BuildTime'));
    });
  });

  // --- SM3: Regrow cooldown ---
  describe('SM3: Regrow cooldown constants', () => {
    it('SPICE_MOUND_REGROW_MIN matches MinRange field', () => {
      expect(GameConstants.SPICE_MOUND_REGROW_MIN).toBe(rawNum(raw, 'MinRange'));
    });

    it('SPICE_MOUND_REGROW_MAX matches MaxRange field', () => {
      expect(GameConstants.SPICE_MOUND_REGROW_MAX).toBe(rawNum(raw, 'MaxRange'));
    });

    it('regrow range: [MinRange, MaxRange]', () => {
      expect(GameConstants.SPICE_MOUND_REGROW_MAX).toBeGreaterThan(GameConstants.SPICE_MOUND_REGROW_MIN);
    });
  });

  // --- SM4: Derived values ---
  describe('SM4: Derived bloom damage and radius', () => {
    it('SPICE_BLOOM_DAMAGE = SPICE_MOUND_HEALTH', () => {
      expect(GameConstants.SPICE_BLOOM_DAMAGE).toBe(GameConstants.SPICE_MOUND_HEALTH);
    });

    it('SPICE_BLOOM_DAMAGE_RADIUS = SPICE_BLOOM_RADIUS * TILE_SIZE', () => {
      expect(GameConstants.SPICE_BLOOM_DAMAGE_RADIUS).toBe(GameConstants.SPICE_BLOOM_RADIUS * TILE_SIZE);
    });

    it('TILE_SIZE is 2 world units per tile', () => {
      expect(TILE_SIZE).toBe(2);
    });
  });
});
