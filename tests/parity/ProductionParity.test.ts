/**
 * Production Parity Test — verifies ProductionSystem blocks aiSpecial units.
 *
 * Catches Bug 3: aiSpecial units (generals, engineers, superweapons) can be
 * built by player if they have the prerequisite buildings and tech level.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ProductionSystem } from '../../src/simulation/ProductionSystem';
import { getRealRules, getAiSpecialUnits, MAIN_FACTIONS } from './rulesOracle';
import { MockHarvestSystem } from './mockHarvestSystem';
import { EventBus } from '../../src/core/EventBus';

describe('ProductionParity — aiSpecial units are unbuildable', () => {
  const rules = getRealRules();
  const aiSpecial = getAiSpecialUnits(rules);

  let harvest: MockHarvestSystem;
  let production: ProductionSystem;

  beforeEach(() => {
    EventBus.clear();
    harvest = new MockHarvestSystem();
    production = new ProductionSystem(rules, harvest as any);
  });

  for (const prefix of MAIN_FACTIONS) {
    describe(`${prefix} faction`, () => {
      beforeEach(() => {
        // Give player unlimited money
        harvest.addSolaris(0, 1_000_000);

        // Give player ALL buildings of this faction to max out prerequisites
        for (const [name] of rules.buildings) {
          if (name.startsWith(prefix)) {
            production.addPlayerBuilding(0, name);
          }
        }

        // Override tech level to max so tech checks don't mask the aiSpecial bug
        production.setOverrideTechLevel(0, 99);
      });

      it('blocks every aiSpecial unit from production', () => {
        const buildable: string[] = [];
        for (const [name, def] of rules.units) {
          if (!name.startsWith(prefix)) continue;
          if (!def.aiSpecial) continue;
          if (production.canBuild(0, name, false)) {
            buildable.push(name);
          }
        }
        expect(buildable, `aiSpecial units buildable: ${buildable.join(', ')}`).toEqual([]);
      });

      it('still allows normal units', () => {
        let normalBuildable = 0;
        for (const [name, def] of rules.units) {
          if (!name.startsWith(prefix)) continue;
          if (def.aiSpecial) continue;
          if (def.cost <= 0) continue;
          if (production.canBuild(0, name, false)) {
            normalBuildable++;
          }
        }
        expect(normalBuildable).toBeGreaterThan(0);
      });
    });
  }

  it('aiSpecial count matches Rules.txt (sanity check)', () => {
    expect(aiSpecial.size).toBeGreaterThan(10);
  });
});
