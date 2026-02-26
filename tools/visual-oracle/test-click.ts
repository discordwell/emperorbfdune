#!/usr/bin/env npx tsx
/**
 * Test clicking through the game's main menu.
 *
 * Focus management:
 *   Boot: ~30s fixed timer + warmup retries.
 *   All ops: ONE runSession() call = ONE focus steal for everything.
 *
 * Button positions (game coords at 800x600, measured from screenshot pixel analysis):
 *   SINGLE PLAYER: (405, 420)
 *   MULTI PLAYER:  ~(412, 482)
 */
import { WineBackend, type SessionOp } from './backends/WineBackend.js';
import fs from 'node:fs';
import path from 'node:path';

const wine = new WineBackend();

async function main() {
  try {
    console.log('=== Booting Wine ===');
    await wine.boot();
    await wine.waitForDesktop();

    const captureDir = '/Users/discordwell/Projects/emperorbfdune/artifacts/visual-oracle/captures';

    // ALL operations in ONE focus steal: title capture → single click → post-click captures
    const ops: SessionOp[] = [
      // Title screen capture
      { type: 'capture', path: path.join(captureDir, 'session/title-00.png') },

      // Click SINGLE PLAYER (single click via Wine API — no triple-click, no retry)
      { type: 'click', gameX: 405, gameY: 420 },

      // Long wait for menu transition — D3D screen changes need time to render
      { type: 'wait', ms: 8000 },

      // Post-click captures — should show SINGLE PLAYER submenu
      { type: 'capture', path: path.join(captureDir, 'session/after-click-00.png') },
      { type: 'wait', ms: 3000 },
      { type: 'capture', path: path.join(captureDir, 'session/after-click-01.png') },
    ];

    console.log('\n=== Running session (1 focus steal) ===');
    await wine.runSession(ops);

    // Check results
    const captures = ops.filter((op): op is SessionOp & { type: 'capture' } => op.type === 'capture');
    let allContent = true;
    for (const op of captures) {
      const size = fs.existsSync(op.path) ? fs.statSync(op.path).size : 0;
      const name = path.basename(op.path);
      const status = size > 100_000 ? 'CONTENT' : size > 0 ? 'blank' : 'MISSING';
      if (size <= 100_000) allContent = false;
      console.log(`  ${name}: ${size} bytes [${status}]`);
    }

    console.log(`\n=== ${allContent ? 'PASS' : 'FAIL'} ===`);
  } finally {
    await wine.shutdown();
  }
}

main().catch(err => {
  console.error(err);
  wine.shutdown().catch(() => {});
  process.exit(1);
});
