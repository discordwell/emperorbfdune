#!/usr/bin/env npx tsx
/**
 * QEMU integration test: boot VM → capture title screen → click Single Player → verify screen change.
 *
 * Prerequisites:
 * - qemu-system-i386 installed (brew install qemu)
 * - VM disk image at tools/visual-oracle/vm/emperor-win10.qcow2
 * - Optionally, a 'game-ready' snapshot (created with QEMU monitor `savevm game-ready`)
 *
 * Usage:
 *   npx tsx tools/visual-oracle/test-qemu-nav.ts
 *   npx tsx tools/visual-oracle/test-qemu-nav.ts --cold   # skip snapshot, cold boot
 */

import fs from 'node:fs';
import path from 'node:path';
import { QemuController } from './qemu/QemuController.js';
import { QEMU_CONFIG } from './qemu/qemu-config.js';

const CAPTURE_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../../artifacts/visual-oracle/captures/qemu-nav',
);

const coldBoot = process.argv.includes('--cold');

async function main() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const controller = new QemuController();

  try {
    // Phase 1: Boot
    console.log('=== Phase 1: Boot VM ===');
    await controller.boot();

    if (!coldBoot && QEMU_CONFIG.snapshotName) {
      console.log(`Loading snapshot "${QEMU_CONFIG.snapshotName}"...`);
      await controller.loadSnapshot(QEMU_CONFIG.snapshotName);
      await sleep(3000);
    } else {
      console.log('Cold boot — waiting for desktop...');
      await controller.waitForDesktop();
    }

    // Phase 2: Capture title screen
    console.log('\n=== Phase 2: Capture title screen ===');
    const titlePath = path.join(CAPTURE_DIR, '01-title.png');
    const titleBuf = await controller.captureScreenshot(titlePath);
    console.log(`Title screenshot: ${titlePath} (${titleBuf.length} bytes)`);

    // Phase 3: Click Single Player
    // Emperor title screen at 800x600: "SINGLE PLAYER" button is ~center-x, y≈385
    // Scale from game coords (800x600) to VM display coords
    const scaleX = QEMU_CONFIG.resolution.width / QEMU_CONFIG.gameResolution.width;
    const scaleY = QEMU_CONFIG.resolution.height / QEMU_CONFIG.gameResolution.height;
    const clickX = Math.round(400 * scaleX);
    const clickY = Math.round(385 * scaleY);

    console.log(`\n=== Phase 3: Click Single Player at VM coords (${clickX}, ${clickY}) ===`);
    await controller.mouseClick(clickX, clickY);
    await sleep(2000);

    // Phase 4: Capture result
    console.log('\n=== Phase 4: Capture after click ===');
    const afterPath = path.join(CAPTURE_DIR, '02-after-click.png');
    const afterBuf = await controller.captureScreenshot(afterPath);
    console.log(`After-click screenshot: ${afterPath} (${afterBuf.length} bytes)`);

    // Phase 5: Compare — if screen changed, click was received
    const sameSize = titleBuf.length === afterBuf.length;
    const bytesEqual = titleBuf.equals(afterBuf);
    console.log(`\n=== Phase 5: Comparison ===`);
    console.log(`Same PNG size: ${sameSize}`);
    console.log(`Byte-identical: ${bytesEqual}`);

    if (bytesEqual) {
      console.log('\nWARNING: Screenshots are identical — click may not have registered.');
      console.log('Possible causes:');
      console.log('  - Game not on title screen (need snapshot or manual navigation)');
      console.log('  - Click coordinates wrong for this resolution');
      console.log('  - usb-tablet device not working (check QEMU args)');
    } else {
      console.log('\nSUCCESS: Screen changed after click — input is working!');
    }

    // Phase 6: Try a second click (e.g., Campaign or Skirmish) to verify continued input
    console.log('\n=== Phase 6: Second click test ===');
    // Click roughly center of screen for next menu item
    const click2X = Math.round(400 * scaleX);
    const click2Y = Math.round(300 * scaleY);
    await controller.mouseClick(click2X, click2Y);
    await sleep(2000);

    const finalPath = path.join(CAPTURE_DIR, '03-second-click.png');
    const finalBuf = await controller.captureScreenshot(finalPath);
    console.log(`Second click screenshot: ${finalPath} (${finalBuf.length} bytes)`);

    const secondChanged = !afterBuf.equals(finalBuf);
    console.log(`Screen changed after second click: ${secondChanged}`);

    console.log('\n=== Done ===');
    console.log(`All captures saved to: ${CAPTURE_DIR}`);
  } catch (err) {
    console.error('Test failed:', err);
  } finally {
    await controller.shutdown();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
