#!/usr/bin/env npx tsx
/**
 * QUICK VERIFICATION: DInput hook click test.
 *
 * REQUIRES: Wine frontmost for ~30 seconds. Do not touch keyboard/mouse!
 *
 * Tests: boot → warmup → 15s title → click SP → capture.
 * If hook works: title screen disappears after click (blank = video loading).
 * If hook fails: title screen persists after click.
 */
import { WineBackend, type SessionOp } from './backends/WineBackend.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const wine = new WineBackend();
const captureDir = '/Users/discordwell/Projects/emperorbfdune/artifacts/visual-oracle/captures/cd-nav-test';

function cap(name: string): SessionOp {
  return { type: 'capture', path: path.join(captureDir, `${name}.png`) };
}

let caffeinateProc: ChildProcess | null = null;
function startCaffeinate(): void {
  caffeinateProc = spawn('caffeinate', ['-u', '-d', '-i', '-s'], { stdio: 'ignore' });
}
function stopCaffeinate(): void {
  if (caffeinateProc) { caffeinateProc.kill(); caffeinateProc = null; }
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
    console.log('=== Quick DInput Hook Verification ===');
    console.log('*** DO NOT TOUCH KEYBOARD/MOUSE FOR 30 SECONDS ***\n');
    await wine.boot();
    await wine.waitForDesktop();

    // Click SP via DInput hook (mouse_event in NON-EXCLUSIVE mode)
    await wine.runSession([
      { type: 'wait', ms: 8000 },    // Wait for title screen
      cap('50-before-click'),
      { type: 'click', gameX: 400, gameY: 385 },
      { type: 'wait', ms: 5000 },
      cap('51-after-click-5s'),
    ]);

    console.log('\n=== Results ===');
    const before = checkCapture('50-before-click');
    const after = checkCapture('51-after-click-5s');

    // Check hook log
    const logPath = path.join(wine['constructor' as any] ? '' : '',
      '/Users/discordwell/Projects/emperorbfdune/tools/visual-oracle/wine/prefix/drive_c/Westwood/Emperor/dinput-hook.log');
    if (fs.existsSync(logPath)) {
      const log = fs.readFileSync(logPath, 'utf-8');
      console.log('\n=== DInput Hook Log ===');
      console.log(log);

      if (log.includes('mouse_event CLICK')) {
        console.log('\n*** mouse_event CLICK sent! ***');
      } else if (log.includes('Click complete')) {
        console.log('\n*** CLICK REGISTERED via GetDeviceState! ***');
      } else if (log.includes('GetDeviceData')) {
        const gdDataCount = (log.match(/GetDeviceData/g) || []).length;
        console.log(`\n*** GetDeviceData: ${gdDataCount}+ calls ***`);
      } else if (log.includes('Wake thread')) {
        console.log('\n*** Wake thread running but no GetDeviceData calls ***');
        console.log('*** Game may not be polling DInput at all during title screen ***');
      } else {
        console.log('\n*** NO INPUT CALLS — Wine likely did not have foreground ***');
        console.log('*** Please retry and do not touch keyboard/mouse ***');
      }
    }

    if (before.label === 'CONTENT' && after.label !== 'CONTENT') {
      console.log('\n*** SUCCESS: Title screen changed after click! ***');
    } else if (before.label === 'CONTENT' && after.label === 'CONTENT') {
      if (Math.abs(before.size - after.size) > 50000) {
        console.log('\n*** SUCCESS: Screen changed significantly after click! ***');
      } else {
        console.log('\n*** CLICK DID NOT REGISTER (title persists) ***');
      }
    } else if (before.label === 'blank') {
      console.log('\n*** D3D NOT RENDERING — Wine did not have foreground ***');
    }
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
