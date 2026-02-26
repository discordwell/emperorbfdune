import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OriginalGameController } from './OriginalGameController.js';
import type { InputStep } from '../qemu/input-sequences.js';
import { QEMU_TO_MAC_KEYCODE } from './keycode-map.js';
import { WINE_CONFIG } from './wine-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_TOOL = path.resolve(__dirname, '..', 'wine', 'capture-window');

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
    console.log('[Wine] Waiting for game to load...');
    const deadline = Date.now() + WINE_CONFIG.loadTimeout;
    const tmpPath = '/tmp/ebfd-wine-probe.png';

    while (Date.now() < deadline) {
      try {
        if (this.windowId !== null) {
          // Probe capture: activate + restore each time (brief flicker during boot)
          captureWineWindow(this.windowId, tmpPath, { activate: true, restore: true });

          if (fs.existsSync(tmpPath)) {
            const stat = fs.statSync(tmpPath);
            if (stat.size > WINE_CONFIG.minScreenshotSize) {
              fs.unlinkSync(tmpPath);
              console.log('[Wine] Game appears loaded');
              return;
            }
            fs.unlinkSync(tmpPath);
          }
        }
      } catch {
        // Not ready yet
      }
      await sleep(2000);
    }
    console.warn('[Wine] Game load timeout — proceeding anyway');
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

  async captureScreenshot(outputPath: string): Promise<Buffer> {
    if (this.windowId === null) {
      throw new Error('No Wine window ID — call boot() and waitForDesktop() first');
    }

    // Single capture: activate Wine, capture, restore previous app
    captureWineWindow(this.windowId, outputPath, { activate: true, restore: true });

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

    // Each capture activates Wine (1s wait for D3D render), captures, then
    // the last one restores the previous app. Activation is needed per-capture
    // because the capture-window process launch itself can disrupt macOS focus.
    const buffers: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const isLast = i === count - 1;
      const outPath = path.join(outDir, `capture-${String(i).padStart(2, '0')}.png`);
      console.log(`[Wine] Capturing screenshot ${i + 1}/${count} → ${outPath}`);

      captureWineWindow(this.windowId, outPath, {
        activate: true,
        restore: isLast,
      });

      if (!fs.existsSync(outPath)) {
        throw new Error(`Screenshot file not created: ${outPath}`);
      }
      buffers.push(fs.readFileSync(outPath));

      if (!isLast) {
        await sleep(intervalMs);
      }
    }
    return buffers;
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
 * Capture a Wine window using ScreenCaptureKit via the capture-window tool.
 *
 * Wine's D3D surface only renders to the capture buffer when frontmost.
 * Use `activate: true` to bring Wine to front before capture, and
 * `restore: true` to return focus to the previous app afterward.
 *
 * For batch captures: activate on first, restore on last → one focus-steal.
 */
function captureWineWindow(
  windowId: number,
  outputPath: string,
  opts: { activate?: boolean; restore?: boolean } = {},
): void {
  const args = ['--wine-only'];
  if (opts.activate) args.push('--activate');
  if (opts.restore) args.push('--restore');
  args.push(String(windowId), outputPath);

  execFileSync(CAPTURE_TOOL, args, { timeout: 15_000 });
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
