#!/usr/bin/env npx tsx
/**
 * Full integration test: boot Wine ONCE, navigate the entire main menu tree.
 *
 * ONE boot, ONE runSession() call = minimal focus stealing.
 * Captures at every stage to verify keyboard navigation works and D3D keeps rendering.
 *
 * Menu flow (keyboard-driven, matching skirmish-base scenario):
 *   Title screen (animated planet)
 *     → RET (dismiss intro / press play)
 *       → Main menu
 *         → RET (select first option = PLAY / SINGLE PLAYER)
 *           → House selection screen
 *             → 1 (select Atreides)
 *               → RET (confirm house)
 *                 → 2 (select Skirmish)
 *                   → Game/map screen
 *
 * If a key doesn't register, the next capture will show the same screen.
 * Compare consecutive captures to detect stuck navigation (RMSE > 0.15 = real change).
 */
import { WineBackend, type SessionOp } from './backends/WineBackend.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const wine = new WineBackend();
const captureDir = '/Users/discordwell/Projects/emperorbfdune/artifacts/visual-oracle/captures/full-session';

function cap(name: string): SessionOp {
  return { type: 'capture', path: path.join(captureDir, `${name}.png`) };
}
function key(...keys: string[]): SessionOp {
  return { type: 'key', keys };
}
function wait(ms: number): SessionOp {
  return { type: 'wait', ms };
}

async function main() {
  fs.mkdirSync(captureDir, { recursive: true });

  try {
    console.log('=== Booting Wine (one time) ===');
    await wine.boot();
    await wine.waitForDesktop();

    // Everything in ONE runSession = ONE focus steal after warmup.
    // Navigation follows the skirmish-base scenario: keyboard-driven menus.
    const ops: SessionOp[] = [
      // --- Stage 1: Title screen (after warmup completes) ---
      cap('01-title'),

      // --- Stage 2: First RET — dismiss intro / advance past title ---
      key('ret'),
      wait(3000),
      cap('02-after-first-ret'),

      // --- Stage 3: Second RET — press play / select SINGLE PLAYER ---
      key('ret'),
      wait(3000),
      cap('03-after-second-ret'),

      // --- Stage 4: Third RET — confirm / advance ---
      key('ret'),
      wait(5000),
      cap('04-after-third-ret'),

      // --- Stage 5: Select Atreides (key 1) ---
      key('1'),
      wait(3000),
      cap('05-after-house-select'),

      // --- Stage 6: Confirm house (RET) ---
      key('ret'),
      wait(3000),
      cap('06-after-house-confirm'),

      // --- Stage 7: Select Skirmish (key 2) ---
      key('2'),
      wait(5000),
      cap('07-after-skirmish'),

      // --- Stage 8: Final state ---
      wait(3000),
      cap('08-final'),
    ];

    const captureOps = ops.filter(o => o.type === 'capture');
    const keyOps = ops.filter(o => o.type === 'key');
    console.log(`\n=== Running full session (${captureOps.length} captures, ${keyOps.length} keys) ===`);
    console.log('This is ONE focus steal for the entire test.\n');

    await wine.runSession(ops);

    // Report results
    console.log('\n=== Results ===');
    const captures = ops.filter((op): op is SessionOp & { type: 'capture' } => op.type === 'capture');
    let allContent = true;
    const sizes: number[] = [];

    for (const op of captures) {
      const size = fs.existsSync(op.path) ? fs.statSync(op.path).size : 0;
      sizes.push(size);
      const name = path.basename(op.path);
      const status = size > 100_000 ? 'CONTENT' : size > 0 ? 'blank' : 'MISSING';
      if (size <= 100_000) allContent = false;
      console.log(`  ${name}: ${(size / 1024).toFixed(0)}KB [${status}]`);
    }

    // Compare consecutive captures using RMSE to detect real screen changes
    // (title screen animation has RMSE ~0.06; real navigation changes are >0.15)
    console.log('\n=== Screen changes (RMSE + pixel diff) ===');
    let navigationDetected = false;
    for (let i = 1; i < captures.length; i++) {
      const prevPath = captures[i - 1].path;
      const currPath = captures[i].path;
      if (!fs.existsSync(prevPath) || !fs.existsSync(currPath)) continue;
      if (sizes[i - 1] < 100_000 || sizes[i] < 100_000) continue;

      const prevName = path.basename(prevPath, '.png');
      const currName = path.basename(currPath, '.png');

      // RMSE (root mean square error) — more reliable than pixel count for detecting real changes
      try {
        execFileSync('compare', ['-metric', 'RMSE', prevPath, currPath, '/dev/null'], {
          timeout: 10_000,
        });
        // Exit 0 = identical images
        console.log(`  ${prevName} → ${currName}: RMSE 0.000 (identical)`);
      } catch (err: any) {
        const stderr = err.stderr?.toString().trim() || '';
        // Parse RMSE from output like "1234.56 (0.0567)"
        const rmseMatch = stderr.match(/\(([0-9.]+)\)/);
        const rmse = rmseMatch ? parseFloat(rmseMatch[1]) : -1;
        const isNavigation = rmse > 0.15;
        if (isNavigation) navigationDetected = true;
        const label = isNavigation ? 'NAVIGATION' : rmse > 0.05 ? 'animation' : 'static';
        console.log(`  ${prevName} → ${currName}: RMSE ${rmse.toFixed(4)} [${label}]`);
      }
    }

    const passCaptures = allContent;
    const passNavigation = navigationDetected;
    console.log(`\n=== Captures: ${passCaptures ? 'PASS' : 'FAIL'} — ${passCaptures ? 'all have content' : 'some blank'} ===`);
    console.log(`=== Navigation: ${passNavigation ? 'PASS' : 'FAIL'} — ${passNavigation ? 'screen changes detected' : 'NO screen changes (keys not reaching game)'} ===`);
  } finally {
    await wine.shutdown();
  }
}

main().catch(err => {
  console.error(err);
  wine.shutdown().catch(() => {});
  process.exit(1);
});
