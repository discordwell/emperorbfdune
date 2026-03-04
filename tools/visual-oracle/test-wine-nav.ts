#!/usr/bin/env npx tsx
/**
 * Wine menu navigation test: AppleScript keys for menus, DInput for gameplay.
 *
 * Key insight: during Bink video playback (between menus), D3D surface goes blank
 * and DInput isn't polled. AppleScript key codes reach the game via System Events
 * → IOKit HID → macdrv → DirectInput, and work during all game states.
 *
 * After videos end, D3D rendering resumes and we can capture again.
 */
import { WineBackend, type SessionOp } from './backends/WineBackend.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const wine = new WineBackend();
const captureDir = '/Users/discordwell/Projects/emperorbfdune/artifacts/visual-oracle/captures/wine-nav';

function cap(name: string): SessionOp {
  return { type: 'capture', path: path.join(captureDir, `${name}.png`) };
}
function wait(ms: number): SessionOp {
  return { type: 'wait', ms };
}

/** Send a key via AppleScript System Events (works during video playback) */
function sendAppleScriptKey(keyCode: number, delay = 500): void {
  const script = `
    tell application "System Events"
      key code ${keyCode}
    end tell
  `;
  try {
    execFileSync('osascript', ['-e', script], { timeout: 3000 });
  } catch (e: any) {
    console.warn(`[AppleScript] Key code ${keyCode} failed: ${e.message}`);
  }
  // Small delay after key
  if (delay > 0) {
    execFileSync('sleep', [String(delay / 1000)], { timeout: delay + 1000 });
  }
}

// macOS key codes
const KEY_RETURN = 36;
const KEY_ESCAPE = 53;
const KEY_1 = 18;
const KEY_2 = 19;
const KEY_3 = 20;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  fs.mkdirSync(captureDir, { recursive: true });

  try {
    console.log('=== Booting Wine ===');
    await wine.boot();
    await wine.waitForDesktop();

    // Step 1: Capture title screen (warmup included)
    console.log('\n=== Step 1: Capture title screen ===');
    await wine.runSession([cap('01-title')]);
    checkCapture('01-title');

    // Step 2: Click SINGLE PLAYER via AppleScript Return key
    // (Game is still frontmost from capture session)
    console.log('\n=== Step 2: Press RETURN to select Single Player ===');
    // Re-focus Wine before AppleScript key
    execFileSync('osascript', ['-e', `
      tell application "System Events"
        set wineProcs to every process whose name contains "wine"
        repeat with p in wineProcs
          set frontmost of p to true
        end repeat
      end tell
    `], { timeout: 3000 });
    await sleep(500);
    sendAppleScriptKey(KEY_RETURN);
    console.log('  Sent RETURN, waiting 3s for transition...');
    await sleep(3000);

    // Capture — might be blank (video playing)
    await wine.runSession([cap('02-after-sp')]);
    checkCapture('02-after-sp');

    // Step 3: Skip intro video with ESC
    console.log('\n=== Step 3: ESC to skip video ===');
    sendAppleScriptKey(KEY_ESCAPE);
    console.log('  Sent ESC, waiting 5s...');
    await sleep(5000);
    await wine.runSession([cap('03-after-esc')]);
    checkCapture('03-after-esc');

    // Step 4: Another ESC if still in video
    console.log('\n=== Step 4: Another ESC + wait ===');
    sendAppleScriptKey(KEY_ESCAPE);
    await sleep(5000);
    await wine.runSession([cap('04-after-esc2')]);
    checkCapture('04-after-esc2');

    // Step 5: Try pressing RETURN to advance menu
    console.log('\n=== Step 5: RETURN to advance ===');
    sendAppleScriptKey(KEY_RETURN);
    await sleep(3000);
    await wine.runSession([cap('05-after-ret')]);
    checkCapture('05-after-ret');

    // Step 6: Press 1 (select Atreides if on house select)
    console.log('\n=== Step 6: Press 1 (Atreides) ===');
    sendAppleScriptKey(KEY_1);
    await sleep(3000);
    await wine.runSession([cap('06-after-1')]);
    checkCapture('06-after-1');

    // Step 7: RETURN to confirm, ESC to skip video
    console.log('\n=== Step 7: RETURN + ESC skip ===');
    sendAppleScriptKey(KEY_RETURN);
    await sleep(2000);
    sendAppleScriptKey(KEY_ESCAPE);
    await sleep(5000);
    await wine.runSession([cap('07-after-confirm')]);
    checkCapture('07-after-confirm');

    // Step 8: Press 2 (Skirmish if on mode select)
    console.log('\n=== Step 8: Press 2 (Skirmish) ===');
    sendAppleScriptKey(KEY_2);
    await sleep(5000);
    await wine.runSession([cap('08-skirmish')]);
    checkCapture('08-skirmish');

    // Step 9: Wait for game to load
    console.log('\n=== Step 9: Wait 15s for game load ===');
    await sleep(15000);
    await wine.runSession([cap('09-game')]);
    checkCapture('09-game');

    // Step 10: One more capture after 10s
    console.log('\n=== Step 10: Final capture ===');
    await sleep(10000);
    await wine.runSession([cap('10-final')]);
    checkCapture('10-final');

    console.log('\n=== Done! ===');
  } finally {
    await wine.shutdown();
  }
}

function checkCapture(name: string) {
  const p = path.join(captureDir, `${name}.png`);
  if (fs.existsSync(p)) {
    const size = fs.statSync(p).size;
    const label = size > 100_000 ? 'CONTENT' : size > 0 ? 'blank' : 'MISSING';
    console.log(`  ${name}.png: ${(size / 1024).toFixed(0)}KB [${label}]`);
  } else {
    console.log(`  ${name}.png: MISSING`);
  }
}

main().catch(err => {
  console.error(err);
  wine.shutdown().catch(() => {});
  process.exit(1);
});
