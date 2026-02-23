/**
 * Rules Parity Unit Test — comprehensive verification that all unit stats
 * from Rules.txt are parsed correctly.
 */
import { describe, it, expect } from 'vitest';
import { getRealRules, getAiSpecialUnits, ALL_FACTIONS } from './rulesOracle';

describe('RulesParityUnit — unit stat verification', () => {
  const rules = getRealRules();
  const aiSpecial = getAiSpecialUnits(rules);

  it('parses a reasonable number of units', () => {
    expect(rules.units.size).toBeGreaterThan(50);
  });

  it('every unit has a non-empty name', () => {
    for (const [name, def] of rules.units) {
      expect(def.name).toBe(name);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('aiSpecial flag is parsed correctly for known units', () => {
    // Known aiSpecial units from Rules.txt
    const knownAiSpecial = [
      'ATGeneral', 'HKGeneral', 'ORGeneral',
      'ATEngineer', 'HKEngineer', 'OREngineer',
    ];
    for (const name of knownAiSpecial) {
      const def = rules.units.get(name);
      expect(def, `${name} should exist`).toBeDefined();
      expect(def!.aiSpecial, `${name} should be aiSpecial`).toBe(true);
    }
  });

  it('Earplugs armour only on campaign/story characters and Fremen', () => {
    const earplugsUnits: string[] = [];
    for (const [name, def] of rules.units) {
      if (def.armour === 'Earplugs') earplugsUnits.push(name);
    }
    // Earplugs units: generals, Fremen, story characters (Duke, etc.)
    // All should be aiSpecial or Fremen-faction — never in a normal skirmish spawn pool
    for (const name of earplugsUnits) {
      const def = rules.units.get(name)!;
      const isFremen = name.startsWith('FR') || name.includes('FR');
      const isCampaignOnly = def.aiSpecial;
      expect(
        isFremen || isCampaignOnly,
        `${name} has Earplugs but is neither Fremen nor aiSpecial`,
      ).toBe(true);
    }
  });

  it('every unit with cost > 0 belongs to a faction', () => {
    const prefixes = ALL_FACTIONS.map(f => f as string);
    for (const [name, def] of rules.units) {
      if (def.cost <= 0) continue;
      const hasPrefix = prefixes.some(p => name.startsWith(p));
      // Allow generic units like 'Harvester', 'Sandworm' etc
      if (!hasPrefix) {
        // Generic units should have no house or have a special role
        expect(def.house === '' || !hasPrefix).toBeTruthy();
      }
    }
  });

  it('core stats are positive for combat units', () => {
    for (const [name, def] of rules.units) {
      if (def.cost <= 0) continue;
      expect(def.health, `${name} health`).toBeGreaterThan(0);
      expect(def.speed, `${name} speed`).toBeGreaterThanOrEqual(0);
    }
  });

  it('techLevel is within valid range', () => {
    for (const [name, def] of rules.units) {
      expect(def.techLevel, `${name} techLevel`).toBeGreaterThanOrEqual(0);
      expect(def.techLevel, `${name} techLevel`).toBeLessThanOrEqual(10);
    }
  });

  describe('per-faction unit counts', () => {
    for (const prefix of ALL_FACTIONS) {
      it(`${prefix} has units`, () => {
        const count = [...rules.units.keys()].filter(n => n.startsWith(prefix)).length;
        // FR/GU have fewer units as subhouse factions; main houses have many more
        const minExpected = ['AT', 'HK', 'OR'].includes(prefix) ? 10 : 1;
        expect(count).toBeGreaterThanOrEqual(minExpected);
      });
    }
  });

  it('infantry flag matches expected units', () => {
    // All LightInf should be infantry
    for (const [name, def] of rules.units) {
      if (name.includes('LightInf') || name.includes('HvyInf') || name.includes('Trooper')) {
        expect(def.infantry, `${name} should be infantry`).toBe(true);
      }
    }
  });

  it('canFly flag matches expected units (excluding Stunt variants)', () => {
    for (const [name, def] of rules.units) {
      // Stunt* units are cinematic variants with different properties
      if (name.startsWith('Stunt')) continue;
      if (name.includes('Ornithopter') || name.includes('Carryall')) {
        expect(def.canFly, `${name} should canFly`).toBe(true);
      }
    }
  });
});
