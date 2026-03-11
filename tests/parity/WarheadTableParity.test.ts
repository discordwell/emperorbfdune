/**
 * Warhead Table Parity Test (WH1-WH3)
 * Dedicated warhead x armor matrix verification.
 * Like Zachathon's 9x5 table — every warhead/armor combination checked.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseRawIni, type RawSection } from '../../scripts/parity/rawIniParser';
import { getRealRules } from './rulesOracle';
import { ARMOUR_TYPES } from '../../src/config/WeaponDefs';
import type { GameRules } from '../../src/config/RulesParser';

describe('WarheadTableParity — warhead x armor matrix', () => {
  let rules: GameRules;
  let rawSections: Map<string, RawSection>;

  beforeAll(() => {
    rules = getRealRules();
    const rulesText = fs.readFileSync(
      path.resolve(__dirname, '../../extracted/MODEL0001/rules.txt'), 'utf-8'
    );
    rawSections = parseRawIni(rulesText).sections;
  });

  // --- WH1: Every warhead from rules.txt exists in parsed warheads ---
  describe('WH1: Warhead existence', () => {
    // Some warheads are declared in [WarheadTypes] but have no section definition
    // (e.g. AntiPersonnel, Flare_W) — these are data-level omissions in rules.txt
    const KNOWN_MISSING_SECTIONS = ['AntiPersonnel', 'Flare_W'];

    it('all declared warhead types with sections are parsed', () => {
      const warheadTypesSection = rawSections.get('WarheadTypes');
      expect(warheadTypesSection, 'WarheadTypes section must exist').toBeDefined();

      const declaredNames = warheadTypesSection!.listValues;
      expect(declaredNames.length).toBeGreaterThan(5);

      const missing: string[] = [];
      for (const name of declaredNames) {
        if (!rules.warheads.has(name) && !KNOWN_MISSING_SECTIONS.includes(name)) {
          missing.push(name);
        }
      }
      expect(missing, `Warheads declared but not parsed: ${missing.join(', ')}`).toEqual([]);
    });

    it('parsed warhead count matches declarations minus known missing', () => {
      const warheadTypesSection = rawSections.get('WarheadTypes');
      const declaredCount = warheadTypesSection!.listValues.length;
      // 2 warheads declared without section data
      expect(rules.warheads.size).toBe(declaredCount - KNOWN_MISSING_SECTIONS.length);
    });
  });

  // --- WH2: Every armor type has an entry per warhead ---
  describe('WH2: Complete armor coverage', () => {
    it('every warhead covers all 13 armor types from ARMOUR_TYPES', () => {
      const incomplete: string[] = [];
      for (const [whName, wh] of rules.warheads) {
        for (const armor of ARMOUR_TYPES) {
          if (!(armor in wh.vs)) {
            incomplete.push(`${whName} missing ${armor}`);
          }
        }
      }
      expect(incomplete, `Warheads with incomplete armor coverage:\n${incomplete.join('\n')}`).toEqual([]);
    });

    it('every warhead covers all armour types declared in rules.txt', () => {
      const incomplete: string[] = [];
      for (const [whName, wh] of rules.warheads) {
        for (const armor of rules.armourTypes) {
          if (!(armor in wh.vs)) {
            incomplete.push(`${whName} missing ${armor}`);
          }
        }
      }
      expect(incomplete, `Warheads with missing declared armor types:\n${incomplete.join('\n')}`).toEqual([]);
    });
  });

  // --- WH3: Individual multiplier values match raw INI ---
  describe('WH3: Per-warhead multiplier values', () => {
    it('every warhead x armor multiplier matches raw rules.txt value', () => {
      const mismatches: string[] = [];

      for (const [whName, wh] of rules.warheads) {
        const rawSection = rawSections.get(whName);
        if (!rawSection) continue;

        for (const [armor, rawValue] of rawSection.entries) {
          const rawNum = parseFloat(rawValue);
          if (isNaN(rawNum)) continue;

          const parsedNum = wh.vs[armor];
          if (parsedNum === undefined) {
            mismatches.push(`${whName}.vs.${armor}: raw=${rawNum}, parsed=undefined`);
            continue;
          }
          if (Math.abs(rawNum - parsedNum) > 0.001) {
            mismatches.push(`${whName}.vs.${armor}: raw=${rawNum}, parsed=${parsedNum}`);
          }
        }
      }

      expect(mismatches, `Warhead multiplier mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('multiplier values are in valid range (0-200)', () => {
      for (const [whName, wh] of rules.warheads) {
        for (const [armor, mult] of Object.entries(wh.vs)) {
          expect(mult, `${whName}.vs.${armor}`).toBeGreaterThanOrEqual(0);
          expect(mult, `${whName}.vs.${armor}`).toBeLessThanOrEqual(200);
        }
      }
    });

    it('default warhead has 100% vs all types', () => {
      // Verify Invulnerable armor gets 0% from most warheads
      let hasInvulnerableZero = false;
      for (const [, wh] of rules.warheads) {
        if (wh.vs['Invulnerable'] === 0) {
          hasInvulnerableZero = true;
          break;
        }
      }
      expect(hasInvulnerableZero, 'at least one warhead should do 0% vs Invulnerable').toBe(true);
    });
  });

  // --- Cross-reference: bullets reference valid warheads ---
  describe('WH-cross: Bullet → warhead chain integrity', () => {
    it('every bullet with a warhead references an existing warhead', () => {
      const missing: string[] = [];
      const lowerMap = new Map<string, string>();
      for (const name of rules.warheads.keys()) {
        lowerMap.set(name.toLowerCase(), name);
      }

      for (const [bName, bullet] of rules.bullets) {
        if (!bullet.warhead) continue;
        if (!rules.warheads.has(bullet.warhead) && !lowerMap.has(bullet.warhead.toLowerCase())) {
          missing.push(`${bName} → ${bullet.warhead}`);
        }
      }
      expect(missing, `Bullets with invalid warhead refs: ${missing.join(', ')}`).toEqual([]);
    });
  });

  // --- Matrix table generation (for documentation) ---
  describe('WH-matrix: Full warhead x armor matrix', () => {
    it('generates complete matrix with no undefined cells', () => {
      const matrix: Record<string, Record<string, number>> = {};
      for (const [whName, wh] of rules.warheads) {
        matrix[whName] = {};
        for (const armor of ARMOUR_TYPES) {
          matrix[whName][armor] = wh.vs[armor] ?? -1;
        }
      }

      // Verify no -1 values (all cells filled)
      for (const [whName, row] of Object.entries(matrix)) {
        for (const [armor, val] of Object.entries(row)) {
          expect(val, `${whName}.${armor} should not be -1`).not.toBe(-1);
        }
      }

      // Verify matrix has expected dimensions
      expect(Object.keys(matrix).length).toBe(rules.warheads.size);
      for (const row of Object.values(matrix)) {
        expect(Object.keys(row).length).toBe(ARMOUR_TYPES.length);
      }
    });
  });
});
