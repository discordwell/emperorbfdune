/**
 * GDB Remote Serial Protocol client for QEMU's GDB stub.
 *
 * Connects via TCP to QEMU's gdbserver and provides typed methods for:
 * - Memory read/write (bytes, dwords, strings)
 * - Register read/write with named parsing (x86)
 * - Software and hardware breakpoints
 * - Continue, single-step, interrupt
 *
 * All memory operations use virtual addresses resolved through the guest's
 * current page table. After interrupt, the CPU may be in a different process
 * context — use software breakpoints in known game code to guarantee context.
 */

import * as net from 'node:net';

/** Parsed x86 register set from GDB 'g' response. */
export interface X86Registers {
  eax: number;
  ecx: number;
  edx: number;
  ebx: number;
  esp: number;
  ebp: number;
  esi: number;
  edi: number;
  eip: number;
  eflags: number;
}

export class GdbClient {
  private socket: net.Socket | null = null;

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.connect(port, host, () => resolve());
      this.socket.on('error', reject);
    });
  }

  private checksum(s: string): string {
    let sum = 0;
    for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
    return (sum & 0xFF).toString(16).padStart(2, '0');
  }

  /** Send a GDB RSP command and wait for the response packet. */
  async send(cmd: string, timeout = 5000): Promise<string> {
    return new Promise((resolve) => {
      if (!this.socket) { resolve(''); return; }
      let buf = '';
      const handler = (chunk: Buffer) => {
        buf += chunk.toString();
        const m = buf.match(/\$([^#]*)#[0-9a-fA-F]{2}/);
        if (m) { this.socket!.removeListener('data', handler); resolve(m[1]); }
      };
      this.socket.on('data', handler);
      this.socket.write(`$${cmd}#${this.checksum(cmd)}`);
      setTimeout(() => { this.socket?.removeListener('data', handler); resolve(buf); }, timeout);
    });
  }

  /** Continue execution and wait for a stop reply (T/S/W packet). */
  async continueAndWait(timeout = 120000): Promise<string> {
    return new Promise((resolve) => {
      if (!this.socket) { resolve(''); return; }
      let buf = '';
      const handler = (chunk: Buffer) => {
        buf += chunk.toString();
        const m = buf.match(/\$([TSW][0-9a-fA-F]{2}[^#]*)#[0-9a-fA-F]{2}/);
        if (m) { this.socket!.removeListener('data', handler); resolve(m[1]); }
      };
      this.socket.on('data', handler);
      this.socket.write(`$c#${this.checksum('c')}`);
      setTimeout(() => { this.socket?.removeListener('data', handler); resolve(buf); }, timeout);
    });
  }

  /** Single-step one instruction and wait for stop reply. */
  async singleStep(timeout = 10000): Promise<string> {
    return new Promise((resolve) => {
      if (!this.socket) { resolve(''); return; }
      let buf = '';
      const handler = (chunk: Buffer) => {
        buf += chunk.toString();
        const m = buf.match(/\$([TSW][0-9a-fA-F]{2}[^#]*)#[0-9a-fA-F]{2}/);
        if (m) { this.socket!.removeListener('data', handler); resolve(m[1]); }
      };
      this.socket.on('data', handler);
      this.socket.write(`$s#${this.checksum('s')}`);
      setTimeout(() => { this.socket?.removeListener('data', handler); resolve(buf); }, timeout);
    });
  }

  /** Send continue without waiting for reply. */
  continueAsync(): void {
    this.socket?.write(`$c#${this.checksum('c')}`);
  }

  /** Send break (\x03) and wait for stop reply. */
  async interrupt(timeout = 15000): Promise<string> {
    return new Promise((resolve) => {
      if (!this.socket) { resolve(''); return; }
      let buf = '';
      const handler = (chunk: Buffer) => {
        buf += chunk.toString();
        const m = buf.match(/\$([TSW][0-9a-fA-F]{2}[^#]*)#[0-9a-fA-F]{2}/);
        if (m) { this.socket!.removeListener('data', handler); resolve(m[1]); }
      };
      this.socket.on('data', handler);
      this.socket.write('\x03');
      setTimeout(() => { this.socket?.removeListener('data', handler); resolve(buf); }, timeout);
    });
  }

  /**
   * Read a 32-bit little-endian value from guest memory.
   * Returns null if the read fails (wrong process context, unmapped page, etc.).
   */
  async readDword(addr: number): Promise<number | null> {
    const resp = await this.send(`m${addr.toString(16)},4`);
    if (resp.startsWith('E') || resp.length < 8) return null;
    const bytes = resp.match(/.{2}/g)!;
    return parseInt(bytes[3] + bytes[2] + bytes[1] + bytes[0], 16);
  }

  /** Write a 32-bit little-endian value to guest memory. */
  async writeDword(addr: number, val: number): Promise<boolean> {
    const hex = val.toString(16).padStart(8, '0');
    const le = hex[6] + hex[7] + hex[4] + hex[5] + hex[2] + hex[3] + hex[0] + hex[1];
    const resp = await this.send(`M${addr.toString(16)},4:${le}`);
    return resp === 'OK';
  }

  /** Write raw hex bytes to guest memory. */
  async writeBytes(addr: number, hexBytes: string): Promise<boolean> {
    const resp = await this.send(`M${addr.toString(16)},${(hexBytes.length / 2).toString(16)}:${hexBytes}`);
    return resp === 'OK';
  }

  /** Read raw hex bytes from guest memory. */
  async readBytes(addr: number, len: number): Promise<string> {
    return this.send(`m${addr.toString(16)},${len.toString(16)}`);
  }

  /** Read all general-purpose registers as a hex string. */
  async readRegisters(): Promise<string> { return this.send('g'); }

  /** Write a single register by number (x86: 0=eax, 1=ecx, ..., 8=eip). */
  async writeRegister(regNum: number, hexValue: string): Promise<boolean> {
    const resp = await this.send(`P${regNum.toString(16)}=${hexValue}`);
    return resp === 'OK';
  }

  /** Set a software breakpoint (Z0). */
  async setBreakpoint(addr: number): Promise<boolean> {
    const resp = await this.send(`Z0,${addr.toString(16)},1`);
    return resp === 'OK';
  }

  /** Remove a software breakpoint (z0). */
  async removeBreakpoint(addr: number): Promise<boolean> {
    const resp = await this.send(`z0,${addr.toString(16)},1`);
    return resp === 'OK';
  }

  /** Set a hardware breakpoint (Z1) using CPU debug registers. */
  async setHwBreakpoint(addr: number): Promise<boolean> {
    const resp = await this.send(`Z1,${addr.toString(16)},1`);
    return resp === 'OK';
  }

  /** Remove a hardware breakpoint (z1). */
  async removeHwBreakpoint(addr: number): Promise<boolean> {
    const resp = await this.send(`z1,${addr.toString(16)},1`);
    return resp === 'OK';
  }

  /** Parse the hex string from readRegisters() into named x86 registers. */
  parseRegisters(hex: string): X86Registers {
    const regs: Record<string, number> = {};
    const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];
    for (let i = 0; i < names.length; i++) {
      const offset = i * 8;
      const leHex = hex.substring(offset, offset + 8);
      if (!leHex || leHex.length < 8) continue;
      const bytes = leHex.match(/.{2}/g)!;
      regs[names[i]] = parseInt(bytes[3] + bytes[2] + bytes[1] + bytes[0], 16);
    }
    return regs as unknown as X86Registers;
  }

  /** Convert a 32-bit value to little-endian hex string (for writeRegister). */
  toLEHex(val: number): string {
    const hex = (val >>> 0).toString(16).padStart(8, '0');
    return hex[6] + hex[7] + hex[4] + hex[5] + hex[2] + hex[3] + hex[0] + hex[1];
  }

  /** Read a null-terminated ASCII string from guest memory. Returns '(error)' on failure. */
  async readString(addr: number, maxLen = 64): Promise<string> {
    const hex = await this.readBytes(addr, maxLen);
    if (hex.startsWith('E')) return '(error)';
    const buf = Buffer.from(hex, 'hex');
    const end = buf.indexOf(0);
    return buf.subarray(0, end === -1 ? maxLen : end).toString('ascii');
  }

  /** Detach from the GDB stub and close the TCP connection. */
  async detach(): Promise<void> {
    try { await this.send('D'); } catch { /* ignore */ }
    this.socket?.destroy();
    this.socket = null;
  }
}
