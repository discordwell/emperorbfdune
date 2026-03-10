import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

export const QEMU_CONFIG = {
  binary: 'qemu-system-i386',
  diskImage: path.join(ROOT, 'tools/visual-oracle/vm/emperor-win7.qcow2'),
  memory: '4G',
  display: 'vmware',  // snapshot was saved with vmsvga — must match for loadvm
  cpu: 'Conroe',  // Win7 needs SSE2 (Pentium3 lacks it); uses WineD3D + Mesa llvmpipe for DDraw
  audio: 'intel-hda',  // snapshot was saved with intel-hda — must match for loadvm
  qmpSocket: '/tmp/ebfd-win7-qmp.sock',
  /** VM display resolution (what Windows desktop is set to). */
  resolution: { width: 800, height: 600 },
  /** Emperor game resolution (the game runs at 800x600). */
  gameResolution: { width: 800, height: 600 },
  cdrom: null as string | null,
  bootTimeout: 120_000,
  screenshotDir: path.join(ROOT, 'artifacts/visual-oracle/captures'),
  /** Name of the QEMU snapshot to load for instant boot. null = cold boot. */
  snapshotName: 'game-ready' as string | null,
  /** VNC display number (0 = port 5900). Required for input events to reach the guest. */
  vncDisplay: ':0',
  /** Port forwarding: host→guest mappings for the user-mode network stack. */
  portForwards: [
    { host: 8889, guest: 8889 },  // in-VM HTTP input server
  ] as Array<{ host: number; guest: number }>,
};
