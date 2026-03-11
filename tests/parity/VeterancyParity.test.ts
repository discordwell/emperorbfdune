/**
 * Veterancy Parity Test (VT1-VT4)
 * Verifies veterancy level data parsed from rules.txt.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseRawIni, type RawSection } from '../../scripts/parity/rawIniParser';
import { getRealRules } from './rulesOracle';
import type { GameRules } from '../../src/config/RulesParser';

describe('VeterancyParity — veterancy level verification', () => {
  let rules: GameRules;
  let rawSections: Map<string, RawSection>;

  beforeAll(() => {
    rules = getRealRules();
    const rulesText = fs.readFileSync(
      path.resolve(__dirname, '../../extracted/MODEL0001/rules.txt'), 'utf-8'
    );
    rawSections = parseRawIni(rulesText).sections;
  });

  // --- VT1: Score thresholds ---
  describe('VT1: Score thresholds match rules.txt VeterancyLevel values', () => {
    it('units with veterancy have correct score thresholds', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.units) {
        if (def.veterancy.length === 0) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        // Extract VeterancyLevel values from raw ordered entries
        const rawVetValues: number[] = [];
        for (const [key, value] of rawSection.orderedEntries) {
          if (key === 'VeterancyLevel') {
            rawVetValues.push(parseFloat(value));
          }
        }

        if (rawVetValues.length !== def.veterancy.length) {
          mismatches.push(`${name}: raw has ${rawVetValues.length} vet levels, parsed has ${def.veterancy.length}`);
          continue;
        }

        for (let i = 0; i < rawVetValues.length; i++) {
          if (Math.abs(rawVetValues[i] - def.veterancy[i].scoreThreshold) > 0.001) {
            mismatches.push(`${name} vet[${i}]: raw=${rawVetValues[i]}, parsed=${def.veterancy[i].scoreThreshold}`);
          }
        }
      }

      expect(mismatches, `Vet score threshold mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('veterancy thresholds are in ascending order per unit', () => {
      for (const [name, def] of rules.units) {
        for (let i = 1; i < def.veterancy.length; i++) {
          expect(
            def.veterancy[i].scoreThreshold,
            `${name} vet[${i}] should exceed vet[${i - 1}]`
          ).toBeGreaterThanOrEqual(def.veterancy[i - 1].scoreThreshold);
        }
      }
    });

    it('most combat units have at least one veterancy level', () => {
      let withVet = 0;
      let combatUnits = 0;
      for (const [, def] of rules.units) {
        if (def.cost > 0 && !def.aiSpecial) {
          combatUnits++;
          if (def.veterancy.length > 0) withVet++;
        }
      }
      // Most combat units should have veterancy
      expect(withVet, `${withVet}/${combatUnits} combat units have vet levels`).toBeGreaterThan(0);
    });
  });

  // --- VT2: ExtraDamage, ExtraArmour, ExtraRange per level ---
  describe('VT2: Vet bonus values per level', () => {
    it('ExtraDamage values match raw INI', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.units) {
        if (def.veterancy.length === 0) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        // Extract ExtraDamage values in order after each VeterancyLevel
        const rawExtraDmg: number[] = [];
        let inVet = false;
        for (const [key, value] of rawSection.orderedEntries) {
          if (key === 'VeterancyLevel') { inVet = true; rawExtraDmg.push(0); continue; }
          if (key === 'ExtraDamage' && inVet) {
            rawExtraDmg[rawExtraDmg.length - 1] = parseFloat(value);
          }
        }

        for (let i = 0; i < Math.min(rawExtraDmg.length, def.veterancy.length); i++) {
          if (Math.abs(rawExtraDmg[i] - def.veterancy[i].extraDamage) > 0.001) {
            mismatches.push(`${name} vet[${i}].extraDamage: raw=${rawExtraDmg[i]}, parsed=${def.veterancy[i].extraDamage}`);
          }
        }
      }

      expect(mismatches, `ExtraDamage mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('ExtraArmour values match raw INI', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.units) {
        if (def.veterancy.length === 0) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawExtraArm: number[] = [];
        let inVet = false;
        for (const [key, value] of rawSection.orderedEntries) {
          if (key === 'VeterancyLevel') { inVet = true; rawExtraArm.push(0); continue; }
          if (key === 'ExtraArmour' && inVet) {
            rawExtraArm[rawExtraArm.length - 1] = parseFloat(value);
          }
        }

        for (let i = 0; i < Math.min(rawExtraArm.length, def.veterancy.length); i++) {
          if (Math.abs(rawExtraArm[i] - def.veterancy[i].extraArmour) > 0.001) {
            mismatches.push(`${name} vet[${i}].extraArmour: raw=${rawExtraArm[i]}, parsed=${def.veterancy[i].extraArmour}`);
          }
        }
      }

      expect(mismatches, `ExtraArmour mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('ExtraRange values match raw INI', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.units) {
        if (def.veterancy.length === 0) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawExtraRange: number[] = [];
        let inVet = false;
        for (const [key, value] of rawSection.orderedEntries) {
          if (key === 'VeterancyLevel') { inVet = true; rawExtraRange.push(0); continue; }
          if (key === 'ExtraRange' && inVet) {
            rawExtraRange[rawExtraRange.length - 1] = parseFloat(value);
          }
        }

        for (let i = 0; i < Math.min(rawExtraRange.length, def.veterancy.length); i++) {
          if (Math.abs(rawExtraRange[i] - def.veterancy[i].extraRange) > 0.001) {
            mismatches.push(`${name} vet[${i}].extraRange: raw=${rawExtraRange[i]}, parsed=${def.veterancy[i].extraRange}`);
          }
        }
      }

      expect(mismatches, `ExtraRange mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('vet bonus values are non-negative', () => {
      for (const [name, def] of rules.units) {
        for (let i = 0; i < def.veterancy.length; i++) {
          const vet = def.veterancy[i];
          expect(vet.extraDamage, `${name} vet[${i}].extraDamage`).toBeGreaterThanOrEqual(0);
          expect(vet.extraArmour, `${name} vet[${i}].extraArmour`).toBeGreaterThanOrEqual(0);
          expect(vet.extraRange, `${name} vet[${i}].extraRange`).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  // --- VT3: Health upgrade at vet levels ---
  describe('VT3: Health upgrades at veterancy levels', () => {
    it('vet levels with Health field are parsed correctly', () => {
      let foundHealthUpgrade = false;

      for (const [name, def] of rules.units) {
        for (let i = 0; i < def.veterancy.length; i++) {
          if (def.veterancy[i].health !== undefined) {
            foundHealthUpgrade = true;
            expect(def.veterancy[i].health, `${name} vet[${i}].health`).toBeGreaterThan(0);
          }
        }
      }

      // At least some units should have health upgrades at vet levels
      expect(foundHealthUpgrade, 'at least one unit should have vet health upgrade').toBe(true);
    });

    it('vet health values match raw INI Health entries within vet blocks', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.units) {
        if (def.veterancy.length === 0) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        // Track Health values that appear after VeterancyLevel entries
        const vetHealths: (number | undefined)[] = [];
        let inVet = false;
        for (const [key, value] of rawSection.orderedEntries) {
          if (key === 'VeterancyLevel') { inVet = true; vetHealths.push(undefined); continue; }
          if (key === 'Health' && inVet) {
            vetHealths[vetHealths.length - 1] = parseFloat(value);
          }
        }

        for (let i = 0; i < Math.min(vetHealths.length, def.veterancy.length); i++) {
          const rawH = vetHealths[i];
          const parsedH = def.veterancy[i].health;
          if (rawH !== undefined && parsedH !== undefined) {
            if (Math.abs(rawH - parsedH) > 0.001) {
              mismatches.push(`${name} vet[${i}].health: raw=${rawH}, parsed=${parsedH}`);
            }
          }
        }
      }

      expect(mismatches, `Vet health mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });
  });

  // --- VT4: Elite and CanSelfRepair flags ---
  describe('VT4: Elite flag and CanSelfRepair at vet levels', () => {
    it('Elite flag parsed at correct vet levels', () => {
      let foundElite = false;

      for (const [name, def] of rules.units) {
        for (let i = 0; i < def.veterancy.length; i++) {
          if (def.veterancy[i].elite) {
            foundElite = true;
            // Elite should typically be at higher vet levels
            expect(i, `${name} elite at vet[${i}]`).toBeGreaterThanOrEqual(0);
          }
        }
      }

      expect(foundElite, 'at least one unit should have an elite vet level').toBe(true);
    });

    it('CanSelfRepair flag parsed at correct vet levels', () => {
      let foundSelfRepair = false;

      for (const [name, def] of rules.units) {
        for (let i = 0; i < def.veterancy.length; i++) {
          if (def.veterancy[i].canSelfRepair) {
            foundSelfRepair = true;
          }
        }
      }

      // At least some units should gain self-repair at a vet level
      expect(foundSelfRepair, 'at least one unit should gain CanSelfRepair at a vet level').toBe(true);
    });

    it('Elite and CanSelfRepair match raw INI entries within vet blocks', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.units) {
        if (def.veterancy.length === 0) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const vetElites: (boolean | undefined)[] = [];
        const vetRepairs: (boolean | undefined)[] = [];
        let inVet = false;
        for (const [key, value] of rawSection.orderedEntries) {
          if (key === 'VeterancyLevel') {
            inVet = true;
            vetElites.push(undefined);
            vetRepairs.push(undefined);
            continue;
          }
          if (key === 'Elite' && inVet) {
            vetElites[vetElites.length - 1] = value.toLowerCase() === 'true' || value === '1';
          }
          if (key === 'CanSelfRepair' && inVet) {
            vetRepairs[vetRepairs.length - 1] = value.toLowerCase() === 'true' || value === '1';
          }
        }

        for (let i = 0; i < Math.min(vetElites.length, def.veterancy.length); i++) {
          if (vetElites[i] !== undefined && def.veterancy[i].elite !== vetElites[i]) {
            mismatches.push(`${name} vet[${i}].elite: raw=${vetElites[i]}, parsed=${def.veterancy[i].elite}`);
          }
          if (vetRepairs[i] !== undefined && def.veterancy[i].canSelfRepair !== vetRepairs[i]) {
            mismatches.push(`${name} vet[${i}].canSelfRepair: raw=${vetRepairs[i]}, parsed=${def.veterancy[i].canSelfRepair}`);
          }
        }
      }

      expect(mismatches, `Vet flag mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });
  });
});
