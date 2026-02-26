#!/usr/bin/env npx tsx
/**
 * Test clicking through the game's main menu.
 *
 * Focus management:
 *   Boot: 30s fixed timer, ZERO focus steals.
 *   All ops: ONE runSession() call = ONE focus steal for everything.
 *
 * Button positions (game coords at 800x600, from pixel analysis):
 *   SINGLE PLAYER: (404, 407)
 *   MULTI PLAYER:  ~(405, 469)
 */
import { WineBackend, type SessionOp } from './backends/WineBackend.js';
import fs from 'node:fs';
import path from 'node:path';

const wine = new WineBackend();

async function main() {
  try {
    console.log('=== Booting Wine (30s load, ZERO focus steals) ===');
    await wine.boot();
    await wine.waitForDesktop();

    const captureDir = '/Users/discordwell/Projects/emperorbfdune/artifacts/visual-oracle/captures';

    // ALL operations in ONE focus steal: title captures → click → post-click captures
    const ops: SessionOp[] = [
      // 3 title screen captures (1s between each)
      { type: 'capture', path: path.join(captureDir, 'session/title-00.png') },
      { type: 'wait', ms: 1000 },
      { type: 'capture', path: path.join(captureDir, 'session/title-01.png') },
      { type: 'wait', ms: 1000 },
      { type: 'capture', path: path.join(captureDir, 'session/title-02.png') },

      // Click SINGLE PLAYER and wait for transition
      { type: 'click', gameX: 404, gameY: 407 },
      { type: 'wait', ms: 3000 },

      // 2 post-click captures to see what happened
      { type: 'capture', path: path.join(captureDir, 'session/after-click-00.png') },
      { type: 'wait', ms: 1000 },
      { type: 'capture', path: path.join(captureDir, 'session/after-click-01.png') },
    ];

    console.log('\n=== Running session (1 TOTAL focus steal) ===');
    await wine.runSession(ops);

    // Check results
    for (const op of ops) {
      if (op.type === 'capture') {
        const size = fs.existsSync(op.path) ? fs.statSync(op.path).size : 0;
        const name = path.basename(op.path);
        const status = size > 100_000 ? 'CONTENT' : size > 0 ? 'blank' : 'MISSING';
        console.log(`  ${name}: ${size} bytes [${status}]`);
      }
    }

    console.log('\n=== Done (1 focus steal total) ===');
  } finally {
    await wine.shutdown();
  }
}

main().catch(err => {
  console.error(err);
  wine.shutdown().catch(() => {});
  process.exit(1);
});
