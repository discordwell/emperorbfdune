import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

export const QEMU_CONFIG = {
  binary: 'qemu-system-i386',
  diskImage: path.join(ROOT, 'tools/visual-oracle/vm/emperor-win10.qcow2'),
  memory: '4G',
  display: 'std',
  qmpSocket: '/tmp/ebfd-visual-oracle-qmp.sock',
  /** VM display resolution (what Windows desktop is set to). */
  resolution: { width: 1024, height: 768 },
  /** Emperor game resolution (the game runs at 800x600). */
  gameResolution: { width: 800, height: 600 },
  cdrom: null as string | null,
  bootTimeout: 120_000,
  screenshotDir: path.join(ROOT, 'artifacts/visual-oracle/captures'),
  /** Name of the QEMU snapshot to load for instant boot. null = cold boot. */
  snapshotName: 'game-ready' as string | null,
};
