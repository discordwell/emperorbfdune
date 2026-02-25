import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VISUAL_ORACLE_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(VISUAL_ORACLE_DIR, '..', '..');

const prefix = path.join(VISUAL_ORACLE_DIR, 'wine', 'prefix');

export const WINE_CONFIG = {
  /** Wine prefix directory (contains the virtual C: drive). */
  prefix,

  /** Path to launcher.exe inside the Wine prefix (Windows-style). */
  launcherExeWin: 'C:\\Westwood\\Emperor\\launcher.exe',

  /** Path to game install dir inside Wine prefix (Unix-style, for file checks). */
  gameDir: path.join(prefix, 'drive_c', 'Westwood', 'Emperor'),

  /** Virtual desktop resolution. */
  resolution: { width: 1024, height: 768 },

  /** Timeout waiting for game window to appear. */
  bootTimeout: 30_000,

  /** Timeout waiting for game to finish loading (screenshot size check). */
  loadTimeout: 60_000,

  /** Minimum PNG screenshot size (bytes) indicating game has loaded. */
  minScreenshotSize: 50_000,

  /** Directory for saving captured screenshots. */
  screenshotDir: path.join(ROOT, 'artifacts', 'visual-oracle', 'captures'),

  /** Path to ISOs directory. */
  isosDir: path.join(ROOT, 'isos'),
};
