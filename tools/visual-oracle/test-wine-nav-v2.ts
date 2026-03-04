#!/usr/bin/env npx tsx
/**
 * Wine menu navigation v2: Let video play to completion.
 *
 * KEY DISCOVERY: wmkey ESC skips the video but CANCELS the action,
 * returning to the title screen. We need to let the video play naturally.
 *
 * Strategy: Click SINGLE PLAYER → wait 3+ minutes → capture
 * All in one mega-session so Wine stays frontmost and D3D mode persists.
 *
 * The intro videos are I00_F00E.BIK through I00_F05E.BIK (~115MB total).
 * At typical Bink bitrates, this could be 1-3 minutes per segment.
 * The game may play just one segment or several in sequence.
 */
import { WineBackend, type SessionOp } from './backends/WineBackend.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

const wine = new WineBackend();
const captureDir = '/Users/discordwell/Projects/emperorbfdune/artifacts/visual-oracle/captures/wine-nav-v2';

function cap(name: string): SessionOp {
  return { type: 'capture', path: path.join(captureDir, `${name}.png`) };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

let caffeinateProc: ChildProcess | null = null;
function startCaffeinate(): void {
  caffeinateProc = spawn('caffeinate', ['-u', '-d', '-i', '-s'], { stdio: 'ignore' });
  console.log(`[caffeinate] Started (pid=${caffeinateProc.pid})`);
}
function stopCaffeinate(): void {
  if (caffeinateProc) {
    caffeinateProc.kill();
    caffeinateProc = null;
    console.log('[caffeinate] Stopped');
  }
}

function wakeDisplay(): void {
  try {
    execFileSync('caffeinate', ['-u', '-t', '2'], { timeout: 5000 });
  } catch { /* ignore */ }
}

function checkCapture(name: string): { size: number; label: string } {
  const p = path.join(captureDir, `${name}.png`);
  if (fs.existsSync(p)) {
    const size = fs.statSync(p).size;
    const label = size > 100_000 ? 'CONTENT' : size > 0 ? 'blank' : 'MISSING';
    console.log(`  ${name}.png: ${(size / 1024).toFixed(0)}KB [${label}]`);
    return { size, label };
  }
  console.log(`  ${name}.png: MISSING`);
  return { size: 0, label: 'MISSING' };
}

async function main() {
  fs.mkdirSync(captureDir, { recursive: true });
  startCaffeinate();

  try {
    console.log('=== Booting Wine ===');
    await wine.boot();
    await wine.waitForDesktop();

    // ─── Step 1: Title screen ───
    console.log('\n=== Step 1: Title screen ===');
    wakeDisplay();
    await sleep(500);
    await wine.runSession([cap('01-title')]);
    checkCapture('01-title');

    // ─── Step 2: MEGA SESSION ───
    // Click SINGLE PLAYER, then wait for video to finish naturally.
    // NO keys pressed — ESC cancels the action.
    // Captures at intervals to see when D3D rendering resumes.
    console.log('\n=== Step 2: Click + wait for video (NO ESC) ===');
    console.log('  Videos may take 1-5 minutes. Capturing at intervals.');
    wakeDisplay();
    await sleep(500);

    const megaOps: SessionOp[] = [
      // Click SINGLE PLAYER
      { type: 'click', gameX: 400, gameY: 415 },
      // Capture during video (blank expected — Bink invisible to SCKit)
      { type: 'wait', ms: 5000 },
      cap('02-at-5s'),
      // Wait and capture at intervals — NO keys, just patience
      { type: 'wait', ms: 25000 },
      cap('03-at-30s'),
      { type: 'wait', ms: 30000 },
      cap('04-at-60s'),
      { type: 'wait', ms: 30000 },
      cap('05-at-90s'),
      { type: 'wait', ms: 30000 },
      cap('06-at-120s'),
      { type: 'wait', ms: 30000 },
      cap('07-at-150s'),
      { type: 'wait', ms: 30000 },
      cap('08-at-180s'),
      { type: 'wait', ms: 60000 },
      cap('09-at-240s'),
      { type: 'wait', ms: 60000 },
      cap('10-at-300s'),
    ];

    await wine.runSession(megaOps);

    // ─── Results ───
    console.log('\n=== Results ===');
    const captures = [
      '02-at-5s', '03-at-30s', '04-at-60s', '05-at-90s',
      '06-at-120s', '07-at-150s', '08-at-180s', '09-at-240s', '10-at-300s',
    ];
    let firstContent: string | null = null;
    for (const name of captures) {
      const result = checkCapture(name);
      if (result.label === 'CONTENT' && !firstContent) {
        firstContent = name;
        console.log(`  *** FIRST CONTENT: ${name} ***`);
      }
    }

    if (firstContent) {
      console.log(`\n*** Video ended and D3D resumed at ${firstContent}! ***`);
      console.log('The game should now be at the house selection screen.');
    } else {
      console.log('\n*** No D3D content found even after 5 minutes ***');
      console.log('The video may be very long or the game is stuck.');
    }

    console.log('\n=== Done! ===');
    console.log('Check captures in:', captureDir);
  } finally {
    await wine.shutdown();
    stopCaffeinate();
  }
}

main().catch(err => {
  console.error(err);
  wine.shutdown().catch(() => {});
  stopCaffeinate();
  process.exit(1);
});
