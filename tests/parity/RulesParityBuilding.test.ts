/**
 * Rules Parity Building Test — verification that building stats
 * from Rules.txt are parsed correctly.
 */
import { describe, it, expect } from 'vitest';
import { getRealRules, MAIN_FACTIONS } from './rulesOracle';

describe('RulesParityBuilding — building stat verification', () => {
  const rules = getRealRules();

  it('parses a reasonable number of buildings', () => {
    expect(rules.buildings.size).toBeGreaterThan(20);
  });

  it('every building has a non-empty name', () => {
    for (const [name, def] of rules.buildings) {
      expect(def.name).toBe(name);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('cost and health are positive for constructible buildings', () => {
    for (const [name, def] of rules.buildings) {
      if (def.cost <= 0) continue;
      expect(def.health, `${name} health`).toBeGreaterThan(0);
    }
  });

  it('techLevel is within valid range', () => {
    for (const [name, def] of rules.buildings) {
      expect(def.techLevel, `${name} techLevel`).toBeGreaterThanOrEqual(0);
      expect(def.techLevel, `${name} techLevel`).toBeLessThanOrEqual(10);
    }
  });

  describe('per-faction buildings', () => {
    for (const prefix of MAIN_FACTIONS) {
      it(`${prefix} has ConYard, Barracks, Factory, Refinery`, () => {
        expect(rules.buildings.has(`${prefix}ConYard`), `${prefix}ConYard`).toBe(true);
        expect(rules.buildings.has(`${prefix}Barracks`), `${prefix}Barracks`).toBe(true);
        expect(rules.buildings.has(`${prefix}Factory`), `${prefix}Factory`).toBe(true);
        expect(rules.buildings.has(`${prefix}Refinery`), `${prefix}Refinery`).toBe(true);
      });

      it(`${prefix} Refinery has getUnitWhenBuilt → harvester`, () => {
        const ref = rules.buildings.get(`${prefix}Refinery`);
        expect(ref).toBeDefined();
        expect(ref!.getUnitWhenBuilt).toBeTruthy();
        expect(ref!.getUnitWhenBuilt.toLowerCase()).toContain('harv');
      });

      it(`${prefix} Refinery has refinery flag`, () => {
        const ref = rules.buildings.get(`${prefix}Refinery`);
        expect(ref!.refinery).toBe(true);
      });
    }
  });

  it('power buildings generate power', () => {
    for (const [name, def] of rules.buildings) {
      if (name.includes('Windtrap') || name.includes('windtrap')) {
        expect(def.powerGenerated, `${name} should generate power`).toBeGreaterThan(0);
      }
    }
  });

  it('walls have wall flag', () => {
    for (const [name, def] of rules.buildings) {
      if (name.includes('Wall') && !name.includes('Walls')) {
        expect(def.wall, `${name} should have wall flag`).toBe(true);
      }
    }
  });
});
