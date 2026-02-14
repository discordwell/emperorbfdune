import type { ModelManager } from '../rendering/ModelManager';
import type { GameRules } from '../config/RulesParser';
import type { ArtEntry } from '../config/ArtIniParser';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { UnitRenderer } from '../rendering/UnitRenderer';

interface CheckItem {
  category: string;
  name: string;
  check: () => boolean | string;
}

export function runEvalChecklist(
  modelManager: ModelManager,
  rules: GameRules,
  artMap: Map<string, ArtEntry>,
  production: ProductionSystem,
  _unitRenderer: UnitRenderer,
): void {
  const factionPrefixes = ['AT', 'HK', 'OR'];

  const checks: CheckItem[] = [
    // --- Models ---
    {
      category: 'Models',
      name: 'Model manifest loaded',
      check: () => {
        const report = modelManager.getLoadReport();
        return report.total > 0 ? true : 'No models tracked';
      },
    },
    ...factionPrefixes.map(prefix => ({
      category: 'Models',
      name: `${prefix} building models load`,
      check: () => {
        const report = modelManager.getLoadReport();
        const bNames = [...rules.buildings.keys()].filter(n => n.startsWith(prefix));
        const withArt = bNames.filter(n => artMap.get(n)?.xaf);
        const loaded = withArt.filter(n => {
          const xaf = artMap.get(n)!.xaf;
          return report.loaded.includes(xaf);
        });
        return loaded.length === withArt.length
          ? true
          : `${loaded.length}/${withArt.length} loaded`;
      },
    })),
    {
      category: 'Models',
      name: 'No failed model loads',
      check: () => {
        const report = modelManager.getLoadReport();
        return report.failed.length === 0
          ? true
          : `${report.failed.length} failed: ${report.failed.slice(0, 3).join(', ')}${report.failed.length > 3 ? '...' : ''}`;
      },
    },

    // --- UI ---
    {
      category: 'UI',
      name: 'Build menu has items',
      check: () => {
        const sidebar = document.getElementById('sidebar');
        const buttons = sidebar?.querySelectorAll('button');
        return buttons && buttons.length > 3
          ? true
          : `Only ${buttons?.length ?? 0} buttons`;
      },
    },
    {
      category: 'UI',
      name: 'Tier separators shown',
      check: () => {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return 'No sidebar';
        const seps = sidebar.querySelectorAll('div[style*="grid-column"]');
        return seps.length > 0 ? true : 'No separators found';
      },
    },
    {
      category: 'UI',
      name: 'Minimap canvas exists',
      check: () => {
        const minimap = document.getElementById('minimap-canvas');
        return minimap ? true : 'No minimap canvas';
      },
    },

    // --- Gameplay ---
    {
      category: 'Gameplay',
      name: 'Tech tree gating works',
      check: () => {
        // Tech level 1 items should be buildable with starting buildings,
        // tech 3+ should not be
        const t1 = [...rules.buildings.entries()].find(([, d]) => d.techLevel <= 1 && d.cost > 0);
        const t3 = [...rules.buildings.entries()].find(([, d]) => d.techLevel >= 3 && d.cost > 0);
        if (!t1 || !t3) return 'No items to test';
        const reason3 = production.getBuildBlockReason(0, t3[0], true);
        return reason3 !== null ? true : 'Tech 3 item has no block reason';
      },
    },
    {
      category: 'Gameplay',
      name: 'Art mappings cover all faction buildings',
      check: () => {
        let missing = 0;
        let total = 0;
        for (const prefix of factionPrefixes) {
          for (const [name] of rules.buildings) {
            if (!name.startsWith(prefix)) continue;
            total++;
            if (!artMap.get(name)?.xaf) missing++;
          }
        }
        return missing === 0 ? true : `${missing}/${total} missing xaf`;
      },
    },

    // --- Audio ---
    {
      category: 'Audio',
      name: 'Music tracks available',
      check: () => {
        const audioEl = document.querySelector('audio');
        return audioEl ? true : 'No audio element found (may use Web Audio API)';
      },
    },
  ];

  // Run and display results
  console.log('%c=== EVALUATION CHECKLIST ===', 'font-size:16px;font-weight:bold;color:#0af');
  const results: { category: string; name: string; pass: boolean; detail: string }[] = [];

  for (const check of checks) {
    try {
      const result = check.check();
      const pass = result === true;
      const detail = typeof result === 'string' ? result : (pass ? 'OK' : 'FAIL');
      results.push({ category: check.category, name: check.name, pass, detail });
    } catch (e) {
      results.push({ category: check.category, name: check.name, pass: false, detail: `Error: ${e}` });
    }
  }

  // Group by category
  const categories = [...new Set(results.map(r => r.category))];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const passed = catResults.filter(r => r.pass).length;
    console.log(`%c${cat} (${passed}/${catResults.length})`, 'font-weight:bold;color:#aaf');
    for (const r of catResults) {
      const icon = r.pass ? '%c PASS ' : '%c FAIL ';
      const color = r.pass ? 'background:#040;color:#0f0' : 'background:#400;color:#f44';
      console.log(`  ${icon} ${r.name}: ${r.detail}`, color);
    }
  }

  const totalPassed = results.filter(r => r.pass).length;
  console.log(`%cTotal: ${totalPassed}/${results.length} checks passed`, `font-weight:bold;color:${totalPassed === results.length ? '#0f0' : '#fa0'}`);
}
