import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { OriginalGameController } from './OriginalGameController.js';
import type { InputStep } from '../qemu/input-sequences.js';
import { QEMU_TO_MAC_KEYCODE } from './keycode-map.js';
import { WINE_CONFIG } from './wine-config.js';

/**
 * Runs the original Emperor: Battle for Dune via Wine on macOS.
 *
 * Uses:
 * - `wine explorer /desktop=...` to launch in a virtual desktop
 * - `screencapture -l <windowID>` for native macOS window capture (PNG)
 * - `osascript` (AppleScript) for keyboard input
 * - Python/Quartz CGWindowListCopyWindowInfo for window ID discovery
 */
export class WineBackend implements OriginalGameController {
  private proc: ChildProcess | null = null;
  private windowId: number | null = null;
  private desktopName = 'Emperor';

  async boot(): Promise<void> {
    if (!fs.existsSync(WINE_CONFIG.gameDir)) {
      throw new Error(
        `Wine game directory not found: ${WINE_CONFIG.gameDir}\n` +
        'Run: bash tools/visual-oracle/wine/setup-wine.sh'
      );
    }

    if (!fs.existsSync(path.join(WINE_CONFIG.gameDir, 'GAME.EXE'))) {
      throw new Error(
        `GAME.EXE not found in ${WINE_CONFIG.gameDir}\n` +
        'Run: bash tools/visual-oracle/wine/setup-wine.sh'
      );
    }

    const wineBinary = findWineBinary();
    const { width, height } = WINE_CONFIG.resolution;

    const args = [
      'explorer',
      `/desktop=${this.desktopName},${width}x${height}`,
      WINE_CONFIG.gameExeWin,
    ];

    const env = {
      ...process.env,
      WINEPREFIX: WINE_CONFIG.prefix,
    };

    console.log(`[Wine] Launching: ${wineBinary} ${args.join(' ')}`);
    this.proc = spawn(wineBinary, args, {
      stdio: 'pipe',
      env,
    });

    this.proc.on('error', (err) => {
      console.error('[Wine] Process error:', err.message);
    });

    this.proc.on('exit', (code) => {
      console.log(`[Wine] Process exited with code ${code}`);
      this.proc = null;
    });

    // Pipe Wine stderr for debugging (Wine is very chatty on stderr)
    this.proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      // Only log non-fixme lines to reduce noise
      if (line && !line.startsWith('fixme:') && !line.startsWith('warn:')) {
        console.log(`[Wine:stderr] ${line}`);
      }
    });
  }

  async waitForDesktop(timeoutMs = WINE_CONFIG.bootTimeout): Promise<void> {
    console.log('[Wine] Waiting for game window...');
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        this.windowId = findWineWindow(this.desktopName);
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
          execSync(
            `screencapture -l ${this.windowId} -x -o "${tmpPath}"`,
            { timeout: 5000 },
          );

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
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: 5000,
      });
    } catch (err) {
      console.warn(`[Wine] AppleScript key send failed: ${(err as Error).message}`);
    }
  }

  async captureScreenshot(outputPath: string): Promise<Buffer> {
    if (this.windowId === null) {
      throw new Error('No Wine window ID — call boot() and waitForDesktop() first');
    }

    // screencapture -l captures a specific window by CGWindowID, -x suppresses sound, -o no shadow
    execSync(
      `screencapture -l ${this.windowId} -x -o "${outputPath}"`,
      { timeout: 10_000 },
    );

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
    const outDir = path.join(WINE_CONFIG.screenshotDir, scenarioId, 'original');
    fs.mkdirSync(outDir, { recursive: true });

    const buffers: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const outPath = path.join(outDir, `capture-${String(i).padStart(2, '0')}.png`);
      console.log(`[Wine] Capturing screenshot ${i + 1}/${count} → ${outPath}`);
      const buf = await this.captureScreenshot(outPath);
      buffers.push(buf);
      if (i < count - 1) {
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
    // Wine processes are typically named "wine-preloader" or "wine64-preloader"
    const script = `
      tell application "System Events"
        set wineProcs to every process whose name contains "wine"
        repeat with p in wineProcs
          set frontmost of p to true
        end repeat
      end tell
    `;

    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: 3000,
      });
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
      execSync(
        `WINEPREFIX="${WINE_CONFIG.prefix}" wineserver -k 2>/dev/null || true`,
        { timeout: 5000 },
      );
    } catch {
      // wineserver may not be running
    }
  }
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Find the Wine binary on macOS. Checks common Homebrew and crossover paths. */
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
      execSync(`which "${candidate}" 2>/dev/null || test -x "${candidate}"`, {
        timeout: 3000,
      });
      return candidate;
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
 * Find the Wine virtual desktop window ID using CGWindowListCopyWindowInfo.
 * Uses a Python one-liner via the Quartz framework (built into macOS).
 */
function findWineWindow(desktopName: string): number | null {
  const pythonScript = `
import Quartz
windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID
)
for w in windows:
    name = w.get('kCGWindowName', '') or ''
    owner = w.get('kCGWindowOwnerName', '') or ''
    if '${desktopName}' in name or ('wine' in owner.lower() and w.get('kCGWindowLayer', -1) == 0):
        print(w['kCGWindowNumber'])
        break
`.trim();

  try {
    const result = execSync(
      `python3 -c "${pythonScript.replace(/"/g, '\\"')}"`,
      { timeout: 5000 },
    ).toString().trim();

    if (result) {
      return parseInt(result, 10);
    }
  } catch {
    // Window not found
  }

  return null;
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
