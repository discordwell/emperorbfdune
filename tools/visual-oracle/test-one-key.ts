#!/usr/bin/env npx tsx
/**
 * Minimal test: boot Wine, capture title, send ONE input, capture result.
 * Used to determine what each input does to the game state.
 *
 * Usage:
 *   npx tsx tools/visual-oracle/test-one-key.ts [keyName]
 *     keyName: ret, esc, 1, 2, 3, spc (default: ret)
 *   npx tsx tools/visual-oracle/test-one-key.ts click <x> <y>
 *     Sends a click at game-space coordinates (800x600)
 */
import { WineBackend, type SessionOp } from './backends/WineBackend.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const wine = new WineBackend();
const captureDir = '/Users/discordwell/Projects/emperorbfdune/artifacts/visual-oracle/captures/one-key';

// Parse args: either "click x y" or "keyName"
const isClick = process.argv[2] === 'click';
const clickX = isClick ? parseInt(process.argv[3] || '400') : 0;
const clickY = isClick ? parseInt(process.argv[4] || '300') : 0;
const keyName = isClick ? `click-${clickX}-${clickY}` : (process.argv[2] || 'ret');

async function main() {
  fs.mkdirSync(captureDir, { recursive: true });

  try {
    console.log('=== Booting Wine ===');
    await wine.boot();
    await wine.waitForDesktop();
    // Extra wait for game to fully init D3D (SetDisplayMode needs time after window appears)
    console.log('Waiting 10s for D3D init...');
    await new Promise(r => setTimeout(r, 10_000));

    const beforePath = path.join(captureDir, `before-${keyName}.png`);
    const afterPath = path.join(captureDir, `after-${keyName}.png`);
    const after2Path = path.join(captureDir, `after2-${keyName}.png`);

    const inputOp: SessionOp = isClick
      ? { type: 'click', gameX: clickX, gameY: clickY }
      : { type: 'key', keys: [keyName] };

    const ops: SessionOp[] = [
      { type: 'capture', path: beforePath },
      inputOp,
      { type: 'wait', ms: 3000 },
      { type: 'capture', path: afterPath },
      { type: 'wait', ms: 3000 },
      { type: 'capture', path: after2Path },
    ];

    console.log(`\n=== Sending ${isClick ? `click at (${clickX},${clickY})` : `key: ${keyName}`} ===`);
    await wine.runSession(ops);

    // Report
    const beforeSize = fs.existsSync(beforePath) ? fs.statSync(beforePath).size : 0;
    const afterSize = fs.existsSync(afterPath) ? fs.statSync(afterPath).size : 0;
    const after2Size = fs.existsSync(after2Path) ? fs.statSync(after2Path).size : 0;

    console.log(`\n=== Results ===`);
    console.log(`  before: ${(beforeSize / 1024).toFixed(0)}KB`);
    console.log(`  after:  ${(afterSize / 1024).toFixed(0)}KB`);
    console.log(`  after2: ${(after2Size / 1024).toFixed(0)}KB`);

    // RMSE comparison
    if (beforeSize > 100_000 && afterSize > 100_000) {
      try {
        execFileSync('magick', ['compare', '-metric', 'RMSE', beforePath, afterPath, '/dev/null'], { timeout: 10_000 });
        console.log('  before→after: IDENTICAL');
      } catch (err: any) {
        const rmse = err.stderr?.toString().trim() || '';
        console.log(`  before→after RMSE: ${rmse}`);
      }
    }

    // Resolution check
    for (const [label, p] of [['before', beforePath], ['after', afterPath], ['after2', after2Path]] as const) {
      if (fs.existsSync(p)) {
        try {
          const info = execFileSync('magick', ['identify', '-format', '%wx%h', p], { timeout: 5000 }).toString().trim();
          console.log(`  ${label} resolution: ${info}`);
        } catch {}
      }
    }

    console.log('\nCaptures saved to:', captureDir);
    console.log('Open them to see what the input did!');
  } finally {
    await wine.shutdown();
  }
}

main().catch(err => {
  console.error(err);
  wine.shutdown().catch(() => {});
  process.exit(1);
});
