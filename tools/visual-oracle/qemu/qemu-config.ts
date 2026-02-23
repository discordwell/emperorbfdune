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
  resolution: { width: 1024, height: 768 },
  cdrom: null as string | null,
  bootTimeout: 120_000,
  screenshotDir: path.join(ROOT, 'artifacts/visual-oracle/captures'),
};
