import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { QEMU_CONFIG } from './qemu-config.js';
import type { InputStep } from './input-sequences.js';

/**
 * Manages a QEMU VM via QMP (QEMU Machine Protocol).
 * Handles lifecycle: boot → input → screendump → shutdown.
 */
export class QemuController {
  private proc: ChildProcess | null = null;
  private qmpSocket: Socket | null = null;
  private qmpReady = false;
  private greetingReceived = false;
  private responseQueue: Array<{
    resolve: (val: unknown) => void;
    reject: (err: Error) => void;
  }> = [];
  private buffer = '';

  async boot(): Promise<void> {
    if (!fs.existsSync(QEMU_CONFIG.diskImage)) {
      throw new Error(
        `QEMU disk image not found: ${QEMU_CONFIG.diskImage}\n` +
        'See tools/visual-oracle/vm/README.md for setup instructions.'
      );
    }

    // Clean up stale socket
    if (fs.existsSync(QEMU_CONFIG.qmpSocket)) {
      fs.unlinkSync(QEMU_CONFIG.qmpSocket);
    }

    // Build port-forwarding string for user-mode networking
    const hostfwds = (QEMU_CONFIG.portForwards ?? [])
      .map((pf) => `hostfwd=tcp::${pf.host}-:${pf.guest}`)
      .join(',');
    const netdevArg = hostfwds
      ? `user,id=net0,${hostfwds}`
      : 'user,id=net0';

    const args = [
      '-hda', QEMU_CONFIG.diskImage,
      '-m', QEMU_CONFIG.memory,
      '-vga', QEMU_CONFIG.display,
      // VNC display backend — required for QMP input events to reach the guest.
      // -display none breaks input: QMP send-key / input-send-event / mouse_button
      // all fail to reach DirectInput inside the VM without a display backend.
      '-vnc', QEMU_CONFIG.vncDisplay ?? ':0',
      '-qmp', `unix:${QEMU_CONFIG.qmpSocket},server,nowait`,
      '-accel', 'tcg',     // software emulation (ARM Mac)
      '-cpu', QEMU_CONFIG.cpu ?? 'Conroe',
      '-smp', '1',
      '-usb',
      '-device', 'usb-tablet', // absolute mouse positioning
      '-device', QEMU_CONFIG.audio ?? 'intel-hda',
      ...(QEMU_CONFIG.audio === 'intel-hda' ? ['-device', 'hda-duplex'] : []),
      '-netdev', netdevArg,
      '-device', 'e1000,netdev=net0',
    ];

    if (QEMU_CONFIG.cdrom) {
      args.push('-cdrom', QEMU_CONFIG.cdrom);
    }

    console.log(`[QEMU] Booting VM: ${QEMU_CONFIG.binary} ${args.join(' ')}`);
    this.proc = spawn(QEMU_CONFIG.binary, args, { stdio: 'pipe' });

    this.proc.on('error', (err) => {
      console.error('[QEMU] Process error:', err.message);
    });

    this.proc.on('exit', (code) => {
      console.log(`[QEMU] Process exited with code ${code}`);
    });

    // Wait for QMP socket to become available
    await this.waitForQmpSocket();
    await this.connectQmp();
  }

  private async waitForQmpSocket(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(QEMU_CONFIG.qmpSocket)) return;
      await sleep(500);
    }
    throw new Error('QMP socket did not appear within 30s');
  }

  private async connectQmp(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.qmpSocket = createConnection(QEMU_CONFIG.qmpSocket);

      this.qmpSocket.on('error', (err) => {
        reject(new Error(`QMP connection error: ${err.message}`));
      });

      this.qmpSocket.on('data', (data) => {
        this.buffer += data.toString();
        this.processQmpBuffer();
      });

      // QMP sends a greeting, then we must negotiate capabilities.
      // We wait for the greeting to be parsed by processQmpBuffer,
      // then send qmp_capabilities and wait for its response.
      this.qmpSocket.once('connect', async () => {
        // Wait for greeting to arrive and be processed
        const deadline = Date.now() + 10_000;
        while (!this.greetingReceived && Date.now() < deadline) {
          await sleep(100);
        }
        if (!this.greetingReceived) {
          reject(new Error('QMP greeting not received within 10s'));
          return;
        }

        // Negotiate capabilities using the proper response queue
        this.qmpReady = true;
        await this.qmpCommand('qmp_capabilities');
        console.log('[QEMU] QMP connected and ready');
        resolve();
      });
    });
  }

  private processQmpBuffer(): void {
    // QMP sends newline-delimited JSON
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        // Handle QMP greeting (first message, has QMP key)
        if (msg.QMP) {
          this.greetingReceived = true;
          console.log('[QEMU] QMP greeting received');
          continue;
        }

        if (msg.return !== undefined || msg.error) {
          const handler = this.responseQueue.shift();
          if (handler) {
            if (msg.error) {
              handler.reject(new Error(`QMP error: ${JSON.stringify(msg.error)}`));
            } else {
              handler.resolve(msg.return);
            }
          }
        }
        // Events (like STOP, RESUME) are logged but not queued
        if (msg.event) {
          console.log(`[QEMU] Event: ${msg.event}`);
        }
      } catch {
        // Partial JSON, will be completed on next data event
      }
    }
  }

  private sendRaw(obj: unknown): void {
    this.qmpSocket?.write(JSON.stringify(obj) + '\n');
  }

  async qmpCommand(execute: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.qmpReady) throw new Error('QMP not ready');

    return new Promise((resolve, reject) => {
      this.responseQueue.push({ resolve, reject });
      const cmd: Record<string, unknown> = { execute };
      if (args) cmd.arguments = args;
      this.sendRaw(cmd);
    });
  }

  /**
   * Send keyboard input to the VM guest.
   * Key names follow QEMU conventions: 'ret', 'esc', 'a'-'z', '1'-'9', etc.
   */
  async sendKey(keys: string[]): Promise<void> {
    const qemuKeys = keys.map((k) => ({ type: 'qcode', data: k }));
    await this.qmpCommand('send-key', { keys: qemuKeys });
  }

  /**
   * Connect to an already-running QEMU VM via its QMP socket.
   * Skips booting — just establishes the QMP connection.
   */
  async connectToExisting(): Promise<void> {
    if (!fs.existsSync(QEMU_CONFIG.qmpSocket)) {
      throw new Error(
        `QMP socket not found: ${QEMU_CONFIG.qmpSocket}\n` +
        'Is the QEMU VM already running?'
      );
    }
    await this.connectQmp();
  }

  /**
   * Detect the current guest framebuffer size from a screendump.
   * Returns {width, height} read from the PPM header.
   */
  async getFramebufferSize(): Promise<{ width: number; height: number }> {
    const tmpPath = '/tmp/ebfd-fb-probe.ppm';
    await this.qmpCommand('screendump', { filename: tmpPath });
    await sleep(300);
    const buf = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    // Parse PPM header: "P6\n<width> <height>\n<maxval>\n..."
    let offset = 0;
    let line = readLine(buf, offset);
    offset += line.length + 1;
    // Skip comments
    let dimLine = readLine(buf, offset);
    while (dimLine.startsWith('#')) {
      offset += dimLine.length + 1;
      dimLine = readLine(buf, offset);
    }
    const [width, height] = dimLine.trim().split(/\s+/).map(Number);
    return { width, height };
  }

  /**
   * Move the mouse to absolute screen coordinates via usb-tablet device.
   * Coordinates are in VM display pixels (e.g. 0-799 for 800px wide).
   * QMP input-send-event uses 0-32767 range for absolute positioning.
   * @param fbSize - Actual framebuffer dimensions. If omitted, uses QEMU_CONFIG.resolution.
   */
  async mouseMove(x: number, y: number, fbSize?: { width: number; height: number }): Promise<void> {
    const res = fbSize ?? QEMU_CONFIG.resolution;
    const absX = Math.round((x / res.width) * 32767);
    const absY = Math.round((y / res.height) * 32767);
    await this.qmpCommand('input-send-event', {
      events: [
        { type: 'abs', data: { axis: 'x', value: absX } },
        { type: 'abs', data: { axis: 'y', value: absY } },
      ],
    });
  }

  /**
   * Click at absolute screen coordinates.
   *
   * Uses a two-device approach proven to work with DirectInput games:
   * 1. Position cursor via usb-tablet (input-send-event abs) — generates WM_MOUSEMOVE
   * 2. Click via HMP mouse_button command — generates WM_LBUTTONDOWN/UP
   *
   * input-send-event btn does NOT generate WM_LBUTTONDOWN that DirectInput
   * NONEXCLUSIVE mode reads, so we must use the HMP mouse_button path instead.
   *
   * @param x - X position in framebuffer pixels
   * @param y - Y position in framebuffer pixels
   * @param button - 'left' | 'right' | 'middle'. Default: 'left'
   * @param fbSize - Actual framebuffer dimensions. If omitted, uses QEMU_CONFIG.resolution.
   */
  async mouseClick(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle' = 'left',
    fbSize?: { width: number; height: number },
  ): Promise<void> {
    // 1. Move cursor to target position via usb-tablet absolute positioning
    await this.mouseMove(x, y, fbSize);
    await sleep(50);

    // 2. Click via HMP mouse_button (PS/2 path that generates WM_LBUTTONDOWN)
    // mouse_button takes a bitmask: bit 0 = left, bit 1 = middle, bit 2 = right
    const btnMask = button === 'left' ? 1 : button === 'middle' ? 2 : 4;
    await this.qmpCommand('human-monitor-command', {
      'command-line': `mouse_button ${btnMask}`,
    });
    await sleep(100);
    // Release all buttons
    await this.qmpCommand('human-monitor-command', {
      'command-line': 'mouse_button 0',
    });
  }

  /**
   * Load a VM snapshot (created with `savevm` in QEMU monitor).
   * Uses human-monitor-command since loadvm is an HMP command, not native QMP.
   */
  async loadSnapshot(name: string): Promise<void> {
    console.log(`[QEMU] Loading snapshot "${name}"...`);
    await this.qmpCommand('human-monitor-command', { 'command-line': `loadvm ${name}` });
    console.log(`[QEMU] Snapshot "${name}" loaded`);
  }

  /**
   * Save a VM snapshot for instant restore later.
   * Uses human-monitor-command since savevm is an HMP command.
   */
  async saveSnapshot(name: string): Promise<void> {
    console.log(`[QEMU] Saving snapshot "${name}"...`);
    await this.qmpCommand('human-monitor-command', { 'command-line': `savevm ${name}` });
    // savevm can take several seconds for large RAM
    await sleep(3000);
    console.log(`[QEMU] Snapshot "${name}" saved`);
  }

  /**
   * Change the CD/DVD disc in the VM's IDE CD-ROM drive.
   * @param isoPath - Absolute path to the ISO file on the host
   */
  async changeCD(isoPath: string): Promise<void> {
    console.log(`[QEMU] Changing CD to: ${isoPath}`);
    await this.qmpCommand('human-monitor-command', {
      'command-line': `change ide1-cd0 ${isoPath}`,
    });
    console.log('[QEMU] CD changed');
  }

  /**
   * Eject the CD/DVD from the VM's IDE CD-ROM drive.
   */
  async ejectCD(): Promise<void> {
    console.log('[QEMU] Ejecting CD...');
    await this.qmpCommand('human-monitor-command', {
      'command-line': 'eject ide1-cd0',
    });
    console.log('[QEMU] CD ejected');
  }

  /**
   * Capture the guest framebuffer as a PPM file, then convert to PNG.
   * Returns the PNG buffer.
   */
  async captureScreenshot(outputPath: string): Promise<Buffer> {
    const ppmPath = outputPath.replace(/\.png$/, '.ppm');
    await this.qmpCommand('screendump', { filename: ppmPath });
    // Small delay for file write to complete
    await sleep(500);
    const pngBuf = ppmToPng(fs.readFileSync(ppmPath));
    fs.writeFileSync(outputPath, pngBuf);
    // Clean up PPM
    fs.unlinkSync(ppmPath);
    return pngBuf;
  }

  /**
   * Execute a sequence of input steps (keys + waits + clicks) from a scenario definition.
   */
  async executeInputSequence(steps: InputStep[]): Promise<void> {
    for (const step of steps) {
      if (step.action === 'wait') {
        console.log(`[QEMU] Waiting ${step.ms}ms${step.comment ? ` (${step.comment})` : ''}`);
        await sleep(step.ms || 1000);
      } else if (step.action === 'key' && step.keys) {
        console.log(`[QEMU] Sending keys: ${step.keys.join('+')}${step.comment ? ` (${step.comment})` : ''}`);
        await this.sendKey(step.keys);
        await sleep(200); // small delay between keypresses
      } else if (step.action === 'click' && step.x !== undefined && step.y !== undefined) {
        console.log(`[QEMU] Clicking (${step.x}, ${step.y})${step.comment ? ` (${step.comment})` : ''}`);
        await this.mouseClick(step.x, step.y);
        await sleep(200);
      }
    }
  }

  /**
   * Capture multiple screenshots at an interval.
   * Returns array of PNG buffers.
   */
  async captureMultiple(
    scenarioId: string,
    count: number,
    intervalMs: number,
  ): Promise<Buffer[]> {
    const outDir = path.join(QEMU_CONFIG.screenshotDir, scenarioId, 'original');
    fs.mkdirSync(outDir, { recursive: true });

    const buffers: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const outPath = path.join(outDir, `capture-${String(i).padStart(2, '0')}.png`);
      console.log(`[QEMU] Capturing screenshot ${i + 1}/${count} → ${outPath}`);
      const buf = await this.captureScreenshot(outPath);
      buffers.push(buf);
      if (i < count - 1) {
        await sleep(intervalMs);
      }
    }
    return buffers;
  }

  /**
   * Wait for the VM desktop to be responsive.
   * Uses a heuristic: send a benign key and check that screendump works.
   */
  async waitForDesktop(timeoutMs = QEMU_CONFIG.bootTimeout): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const tmpPath = '/tmp/ebfd-visual-oracle-probe.ppm';
    console.log('[QEMU] Waiting for desktop...');

    while (Date.now() < deadline) {
      try {
        await this.qmpCommand('screendump', { filename: tmpPath });
        await sleep(500);
        if (fs.existsSync(tmpPath)) {
          const stat = fs.statSync(tmpPath);
          // A valid PPM with 1024x768 resolution is > 2MB
          if (stat.size > 100_000) {
            fs.unlinkSync(tmpPath);
            console.log('[QEMU] Desktop appears ready');
            return;
          }
        }
      } catch {
        // Not ready yet
      }
      await sleep(3000);
    }
    throw new Error(`Desktop did not become ready within ${timeoutMs}ms`);
  }

  /**
   * Reset the guest OS without restarting the QEMU process.
   * Equivalent to pressing the reset button — reboots the guest
   * and waits for the desktop to be ready again.
   */
  async resetGuest(): Promise<void> {
    console.log('[QEMU] Resetting guest OS...');
    await this.qmpCommand('system_reset');
    // Wait for the guest to reboot and become responsive
    await this.waitForDesktop();
  }

  /**
   * Close the QMP socket without shutting down the VM.
   * Use when disconnecting from a VM you didn't boot.
   */
  disconnectQmp(): void {
    this.qmpSocket?.destroy();
    this.qmpSocket = null;
    this.qmpReady = false;
  }

  async shutdown(): Promise<void> {
    console.log('[QEMU] Shutting down VM...');
    try {
      await this.qmpCommand('system_powerdown');
      await sleep(2000);
    } catch {
      // Ignore errors during shutdown
    }

    this.qmpSocket?.destroy();
    this.qmpSocket = null;

    if (this.proc) {
      this.proc.kill('SIGTERM');
      await sleep(1000);
      if (!this.proc.killed) {
        this.proc.kill('SIGKILL');
      }
      this.proc = null;
    }

    // Clean up socket file
    if (fs.existsSync(QEMU_CONFIG.qmpSocket)) {
      fs.unlinkSync(QEMU_CONFIG.qmpSocket);
    }

    console.log('[QEMU] VM shut down');
  }
}

// --- PPM → PNG conversion ---

/**
 * Minimal PPM (P6 binary) to PNG converter.
 * PPM format: "P6\n<width> <height>\n<maxval>\n<RGB bytes>"
 * PNG encoding uses the pngjs library.
 */
function ppmToPng(ppmData: Buffer): Buffer {
  // Parse PPM header
  let offset = 0;

  // Read "P6"
  const magic = readLine(ppmData, offset);
  offset += magic.length + 1;
  if (magic.trim() !== 'P6') {
    throw new Error(`Expected PPM P6 format, got: ${magic.trim()}`);
  }

  // Skip comments
  let dimLine = readLine(ppmData, offset);
  offset += dimLine.length + 1;
  while (dimLine.startsWith('#')) {
    dimLine = readLine(ppmData, offset);
    offset += dimLine.length + 1;
  }

  // Parse dimensions
  const [width, height] = dimLine.trim().split(/\s+/).map(Number);

  // Parse max value
  const maxLine = readLine(ppmData, offset);
  offset += maxLine.length + 1;
  const _maxVal = parseInt(maxLine.trim(), 10);

  // Remaining bytes are raw RGB
  const rgbData = ppmData.subarray(offset);

  // Build PNG using minimal IHDR + IDAT + IEND
  // We use pngjs if available, otherwise fall back to raw construction
  return buildPng(width, height, rgbData);
}

function readLine(buf: Buffer, offset: number): string {
  let end = offset;
  while (end < buf.length && buf[end] !== 0x0a) end++;
  return buf.subarray(offset, end).toString('ascii');
}

/**
 * Build a PNG from raw RGB data using the pngjs library.
 */
function buildPng(width: number, height: number, rgbData: Buffer): Buffer {
  const png = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 3;
      const dstIdx = (y * width + x) * 4;
      png.data[dstIdx + 0] = rgbData[srcIdx + 0]; // R
      png.data[dstIdx + 1] = rgbData[srcIdx + 1]; // G
      png.data[dstIdx + 2] = rgbData[srcIdx + 2]; // B
      png.data[dstIdx + 3] = 255;                  // A
    }
  }

  return PNG.sync.write(png);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
