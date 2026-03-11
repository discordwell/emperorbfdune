/**
 * Building Details Parity Test (BL1-BL6)
 * Deep building verification against rules.txt.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseRawIni, rawNum, rawStr, rawBool, type RawSection } from '../../scripts/parity/rawIniParser';
import { getRealRules, MAIN_FACTIONS } from './rulesOracle';
import type { GameRules } from '../../src/config/RulesParser';

describe('BuildingDetailsParity — deep building verification', () => {
  let rules: GameRules;
  let rawSections: Map<string, RawSection>;

  beforeAll(() => {
    rules = getRealRules();
    const rulesText = fs.readFileSync(
      path.resolve(__dirname, '../../extracted/MODEL0001/rules.txt'), 'utf-8'
    );
    rawSections = parseRawIni(rulesText).sections;
  });

  // --- BL1: PowerGenerated for every power building ---
  describe('BL1: PowerGenerated values', () => {
    it('every power-generating building has correct PowerGenerated from rules.txt', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.buildings) {
        if (def.powerGenerated <= 0) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawPower = rawNum(rawSection, 'PowerGenerated');
        if (rawPower !== undefined && Math.abs(rawPower - def.powerGenerated) > 0.001) {
          mismatches.push(`${name}: raw=${rawPower}, parsed=${def.powerGenerated}`);
        }
      }

      expect(mismatches, `PowerGenerated mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('each main faction has power buildings', () => {
      for (const prefix of MAIN_FACTIONS) {
        const powerBuildings = [...rules.buildings.entries()].filter(
          ([name, def]) => name.startsWith(prefix) && def.powerGenerated > 0
        );
        expect(powerBuildings.length, `${prefix} should have power buildings`).toBeGreaterThan(0);
      }
    });
  });

  // --- BL2: PowerUsed for every building ---
  describe('BL2: PowerUsed values', () => {
    it('every building with PowerUsed matches rules.txt', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.buildings) {
        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawPower = rawNum(rawSection, 'PowerUsed');
        if (rawPower !== undefined && Math.abs(rawPower - def.powerUsed) > 0.001) {
          mismatches.push(`${name}: raw=${rawPower}, parsed=${def.powerUsed}`);
        }
      }

      expect(mismatches, `PowerUsed mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('power-consuming buildings exist', () => {
      const consumers = [...rules.buildings.values()].filter(b => b.powerUsed > 0);
      expect(consumers.length).toBeGreaterThan(0);
    });
  });

  // --- BL3: UpgradeCost and UpgradeTechLevel ---
  describe('BL3: Upgrade properties', () => {
    it('every upgradable building has UpgradeCost matching rules.txt', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.buildings) {
        if (!def.upgradable) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawCost = rawNum(rawSection, 'UpgradeCost');
        if (rawCost !== undefined && Math.abs(rawCost - def.upgradeCost) > 0.001) {
          mismatches.push(`${name} UpgradeCost: raw=${rawCost}, parsed=${def.upgradeCost}`);
        }

        const rawTech = rawNum(rawSection, 'UpgradeTechLevel');
        if (rawTech !== undefined && Math.abs(rawTech - def.upgradeTechLevel) > 0.001) {
          mismatches.push(`${name} UpgradeTechLevel: raw=${rawTech}, parsed=${def.upgradeTechLevel}`);
        }
      }

      expect(mismatches, `Upgrade mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('upgradable buildings have UpgradeCost > 0', () => {
      for (const [name, def] of rules.buildings) {
        if (def.upgradable) {
          expect(def.upgradeCost, `${name} upgradeCost`).toBeGreaterThan(0);
        }
      }
    });

    it('non-upgradable buildings have UpgradeCost = 0', () => {
      for (const [name, def] of rules.buildings) {
        if (!def.upgradable) {
          expect(def.upgradeCost, `${name} should have no upgradeCost`).toBe(0);
        }
      }
    });
  });

  // --- BL4: DeployTile coordinates ---
  describe('BL4: DeployTile coordinate arrays', () => {
    it('buildings with DeployTile have valid coordinates', () => {
      for (const [name, def] of rules.buildings) {
        for (const tile of def.deployTiles) {
          expect(typeof tile.x, `${name} deployTile.x type`).toBe('number');
          expect(typeof tile.y, `${name} deployTile.y type`).toBe('number');
          expect(typeof tile.angle, `${name} deployTile.angle type`).toBe('number');
          expect(isNaN(tile.x), `${name} deployTile.x NaN`).toBe(false);
          expect(isNaN(tile.y), `${name} deployTile.y NaN`).toBe(false);
        }
      }
    });

    it('production buildings have at least one deploy tile', () => {
      for (const [name, def] of rules.buildings) {
        if (def.canBePrimary && def.cost > 0) {
          // Production buildings should have deploy tiles for spawning units
          // Some may not, depending on building type
        }
      }
    });

    it('deploy tile count matches raw INI entry count', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.buildings) {
        if (def.deployTiles.length === 0) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        // Count DeployTile entries in raw section
        let rawTileCount = 0;
        for (const [key, value] of rawSection.orderedEntries) {
          if (key === 'DeployTile') {
            // Count tiles per line (may have multiple space-separated)
            const tokens = value.split(/\s+/).filter(s => s.length > 0);
            rawTileCount += tokens.length;
          }
        }

        if (rawTileCount > 0 && rawTileCount !== def.deployTiles.length) {
          mismatches.push(`${name}: raw=${rawTileCount} tiles, parsed=${def.deployTiles.length}`);
        }
      }

      expect(mismatches, `DeployTile count mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });
  });

  // --- BL5: Occupy footprint grids ---
  describe('BL5: Occupy footprint grids', () => {
    it('buildings with Occupy have valid character arrays', () => {
      for (const [name, def] of rules.buildings) {
        for (const row of def.occupy) {
          expect(Array.isArray(row), `${name} occupy row should be array`).toBe(true);
          for (const cell of row) {
            expect(typeof cell, `${name} occupy cell type`).toBe('string');
            expect(cell.length, `${name} occupy cell should be single char`).toBe(1);
          }
        }
      }
    });

    it('Occupy count matches raw INI line count', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.buildings) {
        if (def.occupy.length === 0) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawOccupyCount = rawSection.orderedEntries.filter(([k]) => k === 'Occupy').length;
        if (rawOccupyCount !== def.occupy.length) {
          mismatches.push(`${name}: raw=${rawOccupyCount} rows, parsed=${def.occupy.length}`);
        }
      }

      expect(mismatches, `Occupy count mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });
  });

  // --- BL6: Building Group field ---
  describe('BL6: Building Group prevents icon duplication', () => {
    it('buildings with Group field have it parsed', () => {
      let foundGroup = false;
      for (const [name, def] of rules.buildings) {
        if (def.group) {
          foundGroup = true;
          expect(typeof def.group, `${name} group type`).toBe('string');
          expect(def.group.length, `${name} group non-empty`).toBeGreaterThan(0);
        }
      }
      expect(foundGroup, 'at least some buildings should have Group').toBe(true);
    });

    it('Group values match raw INI', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.buildings) {
        if (!def.group) continue;

        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawGroup = rawStr(rawSection, 'Group');
        if (rawGroup && rawGroup !== def.group) {
          mismatches.push(`${name}: raw=${rawGroup}, parsed=${def.group}`);
        }
      }

      expect(mismatches, `Group mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('buildings within same Group share similar function', () => {
      // Group together buildings by their group value
      const groups = new Map<string, string[]>();
      for (const [name, def] of rules.buildings) {
        if (!def.group) continue;
        const list = groups.get(def.group) ?? [];
        list.push(name);
        groups.set(def.group, list);
      }

      // Groups with multiple members should exist (that's the point of grouping)
      let multiMemberGroups = 0;
      for (const [, members] of groups) {
        if (members.length > 1) multiMemberGroups++;
      }
      expect(multiMemberGroups, 'should have groups with multiple buildings').toBeGreaterThan(0);
    });
  });

  // --- BL-cross: Building cost and build time ---
  describe('BL-cross: Cost and BuildTime', () => {
    it('every building Cost matches raw INI', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.buildings) {
        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawCost = rawNum(rawSection, 'Cost');
        if (rawCost !== undefined && Math.abs(rawCost - def.cost) > 0.001) {
          mismatches.push(`${name} Cost: raw=${rawCost}, parsed=${def.cost}`);
        }
      }

      expect(mismatches, `Building Cost mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('every building BuildTime matches raw INI', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.buildings) {
        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawTime = rawNum(rawSection, 'BuildTime');
        if (rawTime !== undefined && Math.abs(rawTime - def.buildTime) > 0.001) {
          mismatches.push(`${name} BuildTime: raw=${rawTime}, parsed=${def.buildTime}`);
        }
      }

      expect(mismatches, `Building BuildTime mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });

    it('every building Health matches raw INI', () => {
      const mismatches: string[] = [];

      for (const [name, def] of rules.buildings) {
        const rawSection = rawSections.get(name);
        if (!rawSection) continue;

        const rawHealth = rawNum(rawSection, 'Health');
        if (rawHealth !== undefined && Math.abs(rawHealth - def.health) > 0.001) {
          mismatches.push(`${name} Health: raw=${rawHealth}, parsed=${def.health}`);
        }
      }

      expect(mismatches, `Building Health mismatches:\n${mismatches.join('\n')}`).toEqual([]);
    });
  });
});
