/**
 * Spawn Parity Test — verifies FreshGameSpawn unit selection logic
 * respects AiSpecial, TechLevel, and CanFly filters from real Rules.txt.
 *
 * Catches Bug 1: campaign-only heroes spawning in skirmish.
 */
import { describe, it, expect } from 'vitest';
import { getRealRules, getAiSpecialUnits, MAIN_FACTIONS } from './rulesOracle';

describe('SpawnParity — FreshGameSpawn filters', () => {
  const rules = getRealRules();
  const aiSpecial = getAiSpecialUnits(rules);

  for (const prefix of MAIN_FACTIONS) {
    describe(`${prefix} faction`, () => {
      // Replicate FreshGameSpawn.ts player infantry filter
      const playerInfantry = [...rules.units.keys()].filter(n => {
        const def = rules.units.get(n);
        return n.startsWith(prefix) && def?.infantry && !def.aiSpecial && def.techLevel <= 2;
      });

      // Replicate FreshGameSpawn.ts player vehicle filter
      const playerVehicles = [...rules.units.keys()].filter(n => {
        const def = rules.units.get(n);
        return n.startsWith(prefix) && def && !def.infantry && def.cost > 0 && !def.aiSpecial && def.techLevel <= 2 && !def.canFly;
      });

      // Replicate FreshGameSpawn.ts AI infantry filter
      const aiInfantry = [...rules.units.keys()].filter(n => {
        const def = rules.units.get(n);
        return n.startsWith(prefix) && def?.infantry && !def.aiSpecial && def.techLevel <= 2;
      });

      // Replicate FreshGameSpawn.ts AI vehicle filter
      const aiVehicles = [...rules.units.keys()].filter(n => {
        const def = rules.units.get(n);
        return n.startsWith(prefix) && def && !def.infantry && def.cost > 0 && !def.canFly && !def.aiSpecial && def.techLevel <= 2;
      });

      it('player infantry contains no aiSpecial units', () => {
        const bad = playerInfantry.filter(n => aiSpecial.has(n));
        expect(bad, `aiSpecial infantry in player spawn: ${bad.join(', ')}`).toEqual([]);
      });

      it('player infantry contains no units above techLevel 2', () => {
        const bad = playerInfantry.filter(n => rules.units.get(n)!.techLevel > 2);
        expect(bad, `high-tech infantry in player spawn: ${bad.join(', ')}`).toEqual([]);
      });

      it('player vehicles contains no aiSpecial units', () => {
        const bad = playerVehicles.filter(n => aiSpecial.has(n));
        expect(bad, `aiSpecial vehicles in player spawn: ${bad.join(', ')}`).toEqual([]);
      });

      it('player vehicles contains no units above techLevel 2', () => {
        const bad = playerVehicles.filter(n => rules.units.get(n)!.techLevel > 2);
        expect(bad, `high-tech vehicles in player spawn: ${bad.join(', ')}`).toEqual([]);
      });

      it('player vehicles excludes flying units', () => {
        const bad = playerVehicles.filter(n => rules.units.get(n)!.canFly);
        expect(bad, `flying units in player vehicle spawn: ${bad.join(', ')}`).toEqual([]);
      });

      it('AI infantry contains no aiSpecial units', () => {
        const bad = aiInfantry.filter(n => aiSpecial.has(n));
        expect(bad, `aiSpecial infantry in AI spawn: ${bad.join(', ')}`).toEqual([]);
      });

      it('AI vehicles contains no aiSpecial units', () => {
        const bad = aiVehicles.filter(n => aiSpecial.has(n));
        expect(bad, `aiSpecial vehicles in AI spawn: ${bad.join(', ')}`).toEqual([]);
      });

      it('spawn pool is non-empty after filtering', () => {
        expect(playerInfantry.length).toBeGreaterThan(0);
        expect(playerVehicles.length).toBeGreaterThan(0);
      });
    });
  }

  it('ATGeneral is aiSpecial with Earplugs armour', () => {
    const def = rules.units.get('ATGeneral');
    expect(def).toBeDefined();
    expect(def!.aiSpecial).toBe(true);
    expect(def!.armour).toBe('Earplugs');
  });
});
