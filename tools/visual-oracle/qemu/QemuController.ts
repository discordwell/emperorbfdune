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

    const args = [
      '-hda', QEMU_CONFIG.diskImage,
      '-m', QEMU_CONFIG.memory,
      '-vga', QEMU_CONFIG.display,
      '-display', 'none',  // headless — we use screendump
      '-qmp', `unix:${QEMU_CONFIG.qmpSocket},server,nowait`,
      '-accel', 'tcg',     // software emulation (ARM Mac)
      '-cpu', 'pentium3',  // era-appropriate CPU
      '-smp', '1',
      '-usb',
      '-device', 'usb-tablet', // absolute mouse positioning
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

  private async qmpCommand(execute: string, args?: Record<string, unknown>): Promise<unknown> {
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
   * Execute a sequence of input steps (keys + waits) from a scenario definition.
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
