#!/usr/bin/env npx tsx
/**
 * Calibration: click at known positions and capture cursor to determine
 * the actual coordinate mapping between macOS screen coords and Wine game coords.
 */
import { WineBackend, type SessionOp } from './backends/WineBackend.js';
import fs from 'node:fs';
import path from 'node:path';

const wine = new WineBackend();
const captureDir = '/Users/discordwell/Projects/emperorbfdune/artifacts/visual-oracle/captures/calibrate';

async function main() {
  try {
    console.log('=== Booting Wine ===');
    await wine.boot();
    await wine.waitForDesktop();

    // Click at 5 widely-spaced positions and capture after each.
    // The captures have showsCursor=true so we can see where the cursor ACTUALLY is.
    const positions = [
      { gameX: 100, gameY: 100, label: 'topleft' },
      { gameX: 700, gameY: 100, label: 'topright' },
      { gameX: 400, gameY: 300, label: 'center' },
      { gameX: 100, gameY: 500, label: 'bottomleft' },
      { gameX: 700, gameY: 500, label: 'bottomright' },
    ];

    const ops: SessionOp[] = [];
    for (const pos of positions) {
      ops.push({ type: 'click', gameX: pos.gameX, gameY: pos.gameY });
      ops.push({ type: 'wait', ms: 500 });
      ops.push({ type: 'capture', path: path.join(captureDir, `${pos.label}-g${pos.gameX}_${pos.gameY}.png`) });
    }

    console.log('\n=== Running calibration ===');
    await wine.runSession(ops);

    for (const op of ops) {
      if (op.type !== 'capture') continue;
      const size = fs.existsSync(op.path) ? fs.statSync(op.path).size : 0;
      console.log(`  ${path.basename(op.path)}: ${size} bytes`);
    }
  } finally {
    await wine.shutdown();
  }
}

main().catch(err => {
  console.error(err);
  wine.shutdown().catch(() => {});
  process.exit(1);
});
