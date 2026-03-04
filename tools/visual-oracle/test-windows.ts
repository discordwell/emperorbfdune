#!/usr/bin/env npx tsx
/**
 * Diagnostic: list all Wine windows while the game is running.
 */
import { WineBackend } from './backends/WineBackend.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_TOOL = path.resolve(__dirname, 'wine', 'capture-window');

const wine = new WineBackend();

async function main() {
  try {
    console.log('=== Booting Wine ===');
    await wine.boot();
    await wine.waitForDesktop();

    const script = `
import Quartz
windows = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID)
for w in windows:
    owner = w.get('kCGWindowOwnerName', '') or ''
    name = w.get('kCGWindowName', '') or ''
    if 'wine' in owner.lower() or 'dune' in name.lower() or 'emperor' in name.lower():
        b = w.get('kCGWindowBounds', {})
        layer = w.get('kCGWindowLayer', 0)
        wid = w.get('kCGWindowNumber', 0)
        onscreen = w.get('kCGWindowIsOnscreen', False)
        print(f'WID={wid} name="{name}" owner="{owner}" bounds=({b.get("X",0)},{b.get("Y",0)},{b.get("Width",0)},{b.get("Height",0)}) layer={layer} onscreen={onscreen}')
`.trim();
    console.log('\n=== Wine windows (before activation) ===');
    console.log(execFileSync('python3', ['-c', script], { timeout: 5000 }).toString());

    console.log('=== capture-window --find-wine ===');
    try {
      console.log(execFileSync(CAPTURE_TOOL, ['--find-wine'], { timeout: 10000 }).toString());
    } catch (e) { console.log('Error:', (e as Error).message); }

  } finally {
    await wine.shutdown();
  }
}

main().catch(err => {
  console.error(err);
  wine.shutdown().catch(() => {});
  process.exit(1);
});
