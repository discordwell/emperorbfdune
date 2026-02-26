import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OriginalGameController } from './OriginalGameController.js';
import type { InputStep } from '../qemu/input-sequences.js';
import { QEMU_TO_MAC_KEYCODE } from './keycode-map.js';
import { WINE_CONFIG } from './wine-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_TOOL = path.resolve(__dirname, '..', 'wine', 'capture-window');

export type SessionOp =
  | { type: 'capture'; path: string }
  | { type: 'click'; gameX: number; gameY: number }
  | { type: 'wait'; ms: number };

/**
 * Runs the original Emperor: Battle for Dune via Wine on macOS.
 *
 * Uses:
 * - `wine explorer /desktop=...` to launch in a virtual desktop
 * - `capture-window` (Swift/ScreenCaptureKit) for D3D screenshot capture
 *   (screencapture -l and CGWindowListCreateImage return blank for Wine's
 *   Vulkan/Metal D3D surfaces; ScreenCaptureKit display capture filtered to
 *   Wine's app only, with brief activation for D3D buffer rendering)
 * - Focus management: Wine's D3D only renders when frontmost. Each capture
 *   briefly activates Wine (~2s), captures, and the last one restores the
 *   previous app. Activation per-capture is required because the capture
 *   tool process launch itself disrupts macOS focus.
 * - `osascript` (AppleScript) for keyboard input
 * - Python/Quartz CGWindowListCopyWindowInfo for window ID discovery
 */
export class WineBackend implements OriginalGameController {
  private proc: ChildProcess | null = null;
  private windowId: number | null = null;
  private desktopName = 'Emperor';

  async boot(): Promise<void> {
    if (this.proc) {
      throw new Error('Wine already running — call shutdown() or resetGuest() first');
    }

    if (!fs.existsSync(WINE_CONFIG.gameDir)) {
      throw new Error(
        `Wine game directory not found: ${WINE_CONFIG.gameDir}\n` +
        'Run: bash tools/visual-oracle/wine/setup-wine.sh'
      );
    }

    const launcherPath = path.join(WINE_CONFIG.gameDir, 'launcher.exe');
    if (!fs.existsSync(launcherPath)) {
      throw new Error(
        `launcher.exe not found in ${WINE_CONFIG.gameDir}\n` +
        'Run: bash tools/visual-oracle/wine/setup-wine.sh'
      );
    }

    if (!fs.existsSync(path.join(WINE_CONFIG.gameDir, 'GAME.EXE'))) {
      throw new Error(
        `GAME.EXE not found in ${WINE_CONFIG.gameDir}\n` +
        'Run: bash tools/visual-oracle/wine/setup-wine.sh'
      );
    }

    if (!fs.existsSync(CAPTURE_TOOL)) {
      throw new Error(
        `capture-window tool not found at ${CAPTURE_TOOL}\n` +
        'Build: cd tools/visual-oracle/wine && swiftc -O -o capture-window capture-window.swift ' +
        '-framework ScreenCaptureKit -framework CoreGraphics -framework ImageIO -framework AppKit'
      );
    }

    const wineBinary = findWineBinary();
    const { width, height } = WINE_CONFIG.resolution;

    const args = [
      'explorer',
      `/desktop=${this.desktopName},${width}x${height}`,
      WINE_CONFIG.launcherExeWin,
    ];

    const env = {
      ...process.env,
      WINEPREFIX: WINE_CONFIG.prefix,
    };

    console.log(`[Wine] Launching: ${wineBinary} ${args.join(' ')}`);
    this.proc = spawn(wineBinary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    // Drain stdout to prevent pipe buffer deadlock
    this.proc.stdout?.resume();

    this.proc.on('error', (err) => {
      console.error('[Wine] Process error:', err.message);
    });

    // Track this specific process to avoid race with resetGuest():
    // if the old process's exit fires after boot() sets a new this.proc,
    // we must not nullify the new reference.
    const thisProc = this.proc;
    this.proc.on('exit', (code) => {
      console.log(`[Wine] Process exited with code ${code}`);
      if (this.proc === thisProc) {
        this.proc = null;
      }
    });

    // Pipe Wine stderr for debugging (Wine is very chatty on stderr)
    this.proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      // Filter noise: fixme/warn, MoltenVK extension listings, Vulkan info
      if (!line) return;
      if (line.startsWith('fixme:') || line.startsWith('warn:')) return;
      if (line.startsWith('[mvk-info]') || line.startsWith('[mvk-warn]')) return;
      if (line.startsWith('\tVK_') || line.startsWith('\t\t')) return;
      if (line.includes('Vulkan extensions') || line.includes('Vulkan version')) return;
      if (line.includes('GPU Family') || line.includes('GPU device') || line.includes('GPU memory')) return;
      if (line.includes('Metal Shading Language') || line.includes('pipelineCacheUUID')) return;
      if (line.includes('vendorID') || line.includes('deviceID')) return;
      console.log(`[Wine:stderr] ${line}`);
    });
  }

  async waitForDesktop(timeoutMs = WINE_CONFIG.bootTimeout): Promise<void> {
    console.log('[Wine] Waiting for game window...');
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        this.windowId = findWineWindow();
        if (this.windowId !== null) {
          console.log(`[Wine] Found window ID: ${this.windowId}`);

          // Now wait for the game to actually load (screenshot size heuristic)
          await this.waitForGameLoad();
          return;
        }
      } catch {
        // Window not found yet
      }
      await sleep(1000);
    }
    throw new Error(`Wine game window did not appear within ${timeoutMs}ms`);
  }

  private async waitForGameLoad(): Promise<void> {
    // Wine's D3D (MoltenVK/Metal) only renders when Wine is macOS frontmost.
    // D3D SetDisplayMode resizes the window from 1024x768→800x600 only when
    // frontmost. The Metal surface needs ~10-15s of continuous foreground time
    // before it starts presenting frames to ScreenCaptureKit.
    //
    // CRITICAL: The long wait must happen INSIDE the Swift capture tool process.
    // When the Swift process exits, macOS restores focus to Terminal, so
    // TypeScript-side sleeps do NOT keep Wine frontmost.
    //
    // Strategy: wait 15s for game to init D3D, then run a single batchOps
    // with a 10s internal wait + verification capture (1 focus steal, ~15s).
    console.log('[Wine] Waiting 20s for game to init D3D...');
    await sleep(20_000);

    if (this.windowId !== null) {
      const tmpPath = '/tmp/ebfd-wine-warmup.png';

      for (let attempt = 1; attempt <= 3; attempt++) {
        // Run warmup inside a single Swift process: activate, wait 10s
        // (Wine stays frontmost the entire time), capture, restore.
        const waitMs = attempt === 1 ? 10_000 : 15_000;
        console.log(`[Wine] Warmup ${attempt}/3: activate + ${waitMs / 1000}s hold + capture...`);
        batchOps(this.windowId, [
          `wait:${waitMs}`,
          `capture:${tmpPath}`,
        ]);

        const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
        console.log(`[Wine] Warmup capture: ${size} bytes`);
        try { fs.unlinkSync(tmpPath); } catch {}

        if (size > 100_000) {
          console.log('[Wine] D3D rendering confirmed');
          break;
        }

        if (attempt < 3) {
          console.log('[Wine] Blank capture, retrying in 5s...');
          await sleep(5_000);
        } else {
          console.log('[Wine] WARNING: D3D not rendering after 3 attempts');
        }
      }
    } else {
      console.log('[Wine] Waiting 30s for game to load...');
      await sleep(30_000);
    }

    console.log('[Wine] Game load complete');
  }

  async executeInputSequence(steps: InputStep[]): Promise<void> {
    for (const step of steps) {
      if (step.action === 'wait') {
        console.log(`[Wine] Waiting ${step.ms}ms${step.comment ? ` (${step.comment})` : ''}`);
        await sleep(step.ms || 1000);
      } else if (step.action === 'key' && step.keys) {
        console.log(`[Wine] Sending keys: ${step.keys.join('+')}${step.comment ? ` (${step.comment})` : ''}`);
        await this.sendKey(step.keys);
        await sleep(200);
      } else if (step.action === 'click' && step.x !== undefined && step.y !== undefined) {
        console.log(`[Wine] Clicking (${step.x}, ${step.y})${step.comment ? ` (${step.comment})` : ''}`);
        await this.sendClick(step.x, step.y);
      }
    }
  }

  async sendKey(keys: string[]): Promise<void> {
    // Focus the Wine window first
    await this.focusWindow();

    // Separate modifiers from regular keys
    const modifiers: string[] = [];
    const regularKeys: string[] = [];

    for (const key of keys) {
      const code = QEMU_TO_MAC_KEYCODE[key];
      if (code === undefined) {
        console.warn(`[Wine] Unknown keycode: ${key}, skipping`);
        continue;
      }
      if (code < 0) {
        modifiers.push(key);
      } else {
        regularKeys.push(key);
      }
    }

    if (regularKeys.length === 0) return;

    // Build AppleScript for the key press
    const keyCode = QEMU_TO_MAC_KEYCODE[regularKeys[0]];
    const modifierClause = buildModifierClause(modifiers);

    const script = `
      tell application "System Events"
        key code ${keyCode}${modifierClause}
      end tell
    `;

    try {
      execFileSync('osascript', ['-e', script], { timeout: 5000 });
    } catch (err) {
      console.warn(`[Wine] AppleScript key send failed: ${(err as Error).message}`);
    }
  }

  /**
   * Click at game-space coordinates. Uses the batch capture tool so that
   * activate → click → capture → restore happens in one process (no focus gap).
   * Returns the post-click screenshot as a Buffer, or null if capture path not provided.
   */
  async sendClick(gameX: number, gameY: number, capturePath?: string): Promise<Buffer | null> {
    if (this.windowId === null) {
      throw new Error('No Wine window ID — call boot() and waitForDesktop() first');
    }

    const bounds = getWineWindowBounds();
    if (!bounds) {
      console.warn('[Wine] Cannot find Wine window on screen — click skipped');
      return null;
    }

    // Game coords map 1:1 to window point coords (800x600 game → 800x600 window)
    const screenX = Math.round(bounds.x + gameX);
    const screenY = Math.round(bounds.y + gameY);
    console.log(`[Wine:click] Game (${gameX}, ${gameY}) → Screen (${screenX}, ${screenY}) [window ${bounds.width}x${bounds.height} at (${bounds.x},${bounds.y})]`);

    const outPath = capturePath || '/tmp/ebfd-click-capture.png';

    try {
      batchCapture(this.windowId, [outPath], 0, {
        click: { x: screenX, y: screenY },
        waitAfterClick: 2000,
      });
    } catch (err) {
      console.warn(`[Wine:click] Capture tool failed: ${(err as Error).message}`);
    }

    if (capturePath && fs.existsSync(capturePath)) {
      return fs.readFileSync(capturePath);
    }
    return null;
  }

  async captureScreenshot(outputPath: string): Promise<Buffer> {
    if (this.windowId === null) {
      throw new Error('No Wine window ID — call boot() and waitForDesktop() first');
    }

    // Single capture: activate Wine, capture, restore previous app
    batchOps(this.windowId, [`capture:${outputPath}`]);

    if (!fs.existsSync(outputPath)) {
      throw new Error(
        `Screenshot file not created at ${outputPath} — ` +
        `window ID ${this.windowId} may be stale`
      );
    }

    return fs.readFileSync(outputPath);
  }

  async captureMultiple(
    scenarioId: string,
    count: number,
    intervalMs: number,
  ): Promise<Buffer[]> {
    if (this.windowId === null) {
      throw new Error('No Wine window ID — call boot() and waitForDesktop() first');
    }

    const outDir = path.join(WINE_CONFIG.screenshotDir, scenarioId, 'original');
    fs.mkdirSync(outDir, { recursive: true });

    // Batch mode: activate once, take all captures, restore once.
    // This minimizes focus stealing to 1 activation per batch (~3s total).
    const outputPaths: string[] = [];
    for (let i = 0; i < count; i++) {
      outputPaths.push(path.join(outDir, `capture-${String(i).padStart(2, '0')}.png`));
    }

    console.log(`[Wine] Batch capturing ${count} screenshots (1 focus steal)...`);
    batchCapture(this.windowId, outputPaths, intervalMs);

    const buffers: Buffer[] = [];
    for (const outPath of outputPaths) {
      if (!fs.existsSync(outPath)) {
        throw new Error(`Screenshot file not created: ${outPath}`);
      }
      buffers.push(fs.readFileSync(outPath));
    }
    return buffers;
  }

  /**
   * Execute all captures and clicks in ONE focus steal.
   * Activates Wine once, runs all ops sequentially, restores focus once.
   *
   * Ops: { type: 'capture', path: string } | { type: 'click', gameX, gameY } | { type: 'wait', ms }
   */
  async runSession(ops: SessionOp[]): Promise<void> {
    if (this.windowId === null) {
      throw new Error('No Wine window ID — call boot() and waitForDesktop() first');
    }

    const batchOpsStr: string[] = [];
    for (const op of ops) {
      switch (op.type) {
        case 'capture':
          // Ensure directory exists
          fs.mkdirSync(path.dirname(op.path), { recursive: true });
          batchOpsStr.push(`capture:${op.path}`);
          break;
        case 'click':
          // Use gameclick: — Swift tool translates to screen coords using
          // fresh window bounds queried AFTER activation (no TOCTOU race)
          console.log(`[Wine:session] Click game (${op.gameX},${op.gameY})`);
          batchOpsStr.push(`gameclick:${op.gameX};${op.gameY}`);
          break;
        case 'wait':
          batchOpsStr.push(`wait:${op.ms}`);
          break;
      }
    }

    const captureCount = batchOpsStr.filter(o => o.startsWith('capture:')).length;
    console.log(`[Wine:session] Running ${ops.length} ops (${captureCount} captures) — 1 focus steal`);
    batchOps(this.windowId, batchOpsStr);
  }

  async resetGuest(): Promise<void> {
    console.log('[Wine] Resetting — killing game and relaunching...');

    // Kill existing Wine processes
    await this.killWine();
    this.windowId = null;

    // Brief pause for cleanup
    await sleep(2000);

    // Relaunch
    await this.boot();
    await this.waitForDesktop();
  }

  async shutdown(): Promise<void> {
    console.log('[Wine] Shutting down...');
    await this.killWine();
    this.proc = null;
    this.windowId = null;
    console.log('[Wine] Shut down');
  }

  private async focusWindow(): Promise<void> {
    if (this.windowId === null) return;

    // Use AppleScript to bring the Wine window to front by process name
    const script = `
      tell application "System Events"
        set wineProcs to every process whose name contains "wine"
        repeat with p in wineProcs
          set frontmost of p to true
        end repeat
      end tell
    `;

    try {
      execFileSync('osascript', ['-e', script], { timeout: 3000 });
      // Small delay after focus
      await sleep(100);
    } catch {
      // Focus failed — Wine window may still be foreground, continue
    }
  }

  private async killWine(): Promise<void> {
    // Kill our spawned Wine process
    if (this.proc) {
      const pid = this.proc.pid;
      this.proc.kill('SIGTERM');
      await sleep(1000);
      // Check if process actually exited (proc.killed only means .kill() was called)
      if (pid) {
        try {
          process.kill(pid, 0); // test if still alive
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process already exited
        }
      }
    }

    // Also kill any lingering Wine processes from our prefix
    try {
      const wineserverBin = findWineBinary().replace(/\/wine$/, '/wineserver');
      execFileSync(wineserverBin, ['-k'], {
        timeout: 5000,
        env: { ...process.env, WINEPREFIX: WINE_CONFIG.prefix },
      });
    } catch {
      // wineserver may not be running
    }
  }
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find the Wine binary on macOS. Returns an absolute path. */
function findWineBinary(): string {
  const candidates = [
    'wine',
    'wine64',
    '/usr/local/bin/wine',
    '/opt/homebrew/bin/wine',
    '/opt/homebrew/bin/wine64',
    '/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine',
    '/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine',
  ];

  for (const candidate of candidates) {
    try {
      if (candidate.startsWith('/')) {
        // Absolute path — check if executable
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } else {
        // Bare name — resolve to absolute path via `which`
        const resolved = execFileSync('which', [candidate], { timeout: 3000 })
          .toString().trim();
        if (resolved) return resolved;
      }
    } catch {
      continue;
    }
  }

  throw new Error(
    'Wine not found. Install via: brew install --cask wine-stable\n' +
    'Or see: https://wiki.winehq.org/Download'
  );
}

/**
 * Find the Wine D3D game window ("Dune") using CGWindowListCopyWindowInfo.
 * Only matches a window named exactly "Dune" owned by a Wine process.
 * Returns null if not found yet (the D3D window appears after launcher.exe
 * completes IPC handoff to GAME.EXE).
 */
function findWineWindow(): number | null {
  const pythonScript = `
import Quartz
windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID
)
for w in windows:
    name = w.get('kCGWindowName', '') or ''
    owner = w.get('kCGWindowOwnerName', '') or ''
    if name == 'Dune' and 'wine' in owner.lower():
        print(w['kCGWindowNumber'])
        exit()
`.trim();

  try {
    const result = execFileSync('python3', ['-c', pythonScript], {
      timeout: 5000,
    }).toString().trim();

    if (result) {
      return parseInt(result, 10);
    }
  } catch {
    // Window not found
  }

  return null;
}

/**
 * Execute a batch of operations with a SINGLE activation/restore cycle.
 * Operations: capture, click, wait — all within one focus steal.
 *
 * Uses the --ops format: "capture:/path,click:x;y,wait:ms"
 */
function batchOps(
  windowId: number,
  ops: string[],
  opts: { activate?: boolean; restore?: boolean } = { activate: true, restore: true },
): void {
  const args = ['--batch',
    '--windowid', String(windowId),
    '--ops', ops.join(','),
  ];
  if (opts.activate !== false) args.push('--activate');
  if (opts.restore !== false) args.push('--restore');

  // Estimate timeout: 15s base + sum of waits + 5s per capture
  const captureCount = ops.filter(o => o.startsWith('capture:')).length;
  const waitSum = ops
    .filter(o => o.startsWith('wait:'))
    .reduce((sum, o) => sum + parseInt(o.split(':')[1] || '0', 10), 0);
  const timeout = 15_000 + captureCount * 5000 + waitSum;

  const result = execFileSync(CAPTURE_TOOL, args, { timeout }).toString().trim();
  if (result) {
    for (const line of result.split('\n')) {
      console.log(`[Wine:capture] ${line}`);
    }
  }
}

/** Convenience: batch capture N screenshots (single activation). */
function batchCapture(
  windowId: number,
  outputPaths: string[],
  delayMs: number,
  opts?: { click?: { x: number; y: number }; waitAfterClick?: number },
): void {
  const ops: string[] = [];

  if (opts?.click) {
    ops.push(`click:${opts.click.x};${opts.click.y}`);
    ops.push(`wait:${opts.waitAfterClick || 2000}`);
  }

  for (let i = 0; i < outputPaths.length; i++) {
    ops.push(`capture:${outputPaths[i]}`);
    if (i < outputPaths.length - 1 && delayMs > 0) {
      ops.push(`wait:${delayMs}`);
    }
  }

  batchOps(windowId, ops);
}

/** Build the AppleScript modifier clause for key code commands. */
function buildModifierClause(modifiers: string[]): string {
  if (modifiers.length === 0) return '';

  const mapped = modifiers.map((m) => {
    switch (m) {
      case 'shift': return 'shift down';
      case 'ctrl': return 'control down';
      case 'alt': return 'option down';
      default: return null;
    }
  }).filter(Boolean);

  if (mapped.length === 0) return '';
  return ` using {${mapped.join(', ')}}`;
}

/**
 * Get the Wine "Dune" window's screen-space bounds from macOS.
 * Returns {x, y, width, height} in macOS screen points.
 */
function getWineWindowBounds(): { x: number; y: number; width: number; height: number } | null {
  const script = `
import Quartz, json
windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID
)
for w in windows:
    name = w.get('kCGWindowName', '') or ''
    owner = w.get('kCGWindowOwnerName', '') or ''
    if name == 'Dune' and 'wine' in owner.lower():
        b = w['kCGWindowBounds']
        print(json.dumps({"x": b["X"], "y": b["Y"], "width": b["Width"], "height": b["Height"]}))
        exit()
`.trim();

  try {
    const result = execFileSync('python3', ['-c', script], { timeout: 5000 }).toString().trim();
    if (result) return JSON.parse(result);
  } catch {
    // Window not found
  }
  return null;
}

