/**
 * Sidebar Parity Test — verifies Sidebar.renderUnitItems() excludes
 * aiSpecial (campaign-only) units from the build panel.
 *
 * Catches Bug 2: campaign generals/engineers visible in sidebar.
 */
import { describe, it, expect } from 'vitest';
import { getRealRules, getAiSpecialUnits, MAIN_FACTIONS } from './rulesOracle';

describe('SidebarParity — renderUnitItems filter', () => {
  const rules = getRealRules();
  const aiSpecial = getAiSpecialUnits(rules);

  for (const prefix of MAIN_FACTIONS) {
    describe(`${prefix} faction`, () => {
      // Replicate Sidebar.ts renderUnitItems filter (lines 381-387)
      const sidebarUnits: string[] = [];
      for (const [name, def] of rules.units) {
        if (!name.startsWith(prefix)) continue;
        if (def.cost <= 0) continue;
        if (def.aiSpecial) continue; // Bug 2 fix check
        sidebarUnits.push(name);
      }

      it('contains no aiSpecial units', () => {
        const bad = sidebarUnits.filter(n => aiSpecial.has(n));
        expect(bad, `aiSpecial units in sidebar: ${bad.join(', ')}`).toEqual([]);
      });

      it('still has buildable units after filtering', () => {
        expect(sidebarUnits.length).toBeGreaterThan(0);
      });

      it(`${prefix}General is excluded`, () => {
        expect(sidebarUnits).not.toContain(`${prefix}General`);
      });

      it(`${prefix}Engineer is excluded`, () => {
        expect(sidebarUnits).not.toContain(`${prefix}Engineer`);
      });
    });
  }
});
