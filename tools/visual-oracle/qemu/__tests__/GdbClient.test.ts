/**
 * Unit tests for GdbClient — GDB Remote Serial Protocol client.
 * Mocks the TCP socket to verify correct protocol messages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Track the most recent mock socket created
let currentSocket: any = null;

vi.mock('node:net', async () => {
  const { EventEmitter: EE } = await import('node:events');

  class MockSocket extends EE {
    write = vi.fn();
    destroy = vi.fn();

    connect(_port: number, _host: string, cb: () => void) {
      setTimeout(cb, 5);
    }
  }

  return {
    Socket: class extends MockSocket {
      constructor() {
        super();
        currentSocket = this;
      }
    },
  };
});

import { GdbClient } from '../GdbClient.js';

/** Compute GDB checksum for a payload string. */
function checksum(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return (sum & 0xFF).toString(16).padStart(2, '0');
}

/** Simulate a GDB response packet for the given payload. */
function gdbReply(payload: string): string {
  return `$${payload}#${checksum(payload)}`;
}

/** Set up auto-reply: next write triggers a GDB response. */
function autoReply(payload: string) {
  currentSocket.write.mockImplementationOnce(() => {
    setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply(payload))), 5);
  });
}

describe('GdbClient', () => {
  let gdb: GdbClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    gdb = new GdbClient();
    await gdb.connect('127.0.0.1', 1234);
  });

  afterEach(() => {
    currentSocket?.removeAllListeners();
  });

  describe('send', () => {
    it('sends a properly framed GDB RSP packet', async () => {
      autoReply('OK');
      const resp = await gdb.send('g');
      expect(currentSocket.write).toHaveBeenCalledWith(`$g#${checksum('g')}`);
      expect(resp).toBe('OK');
    });

    it('parses response with data payload', async () => {
      autoReply('aabbccdd');
      const resp = await gdb.send('m400000,4');
      expect(resp).toBe('aabbccdd');
    });
  });

  describe('readDword', () => {
    it('reads a 32-bit little-endian value', async () => {
      autoReply('78563412');
      const val = await gdb.readDword(0x400000);
      expect(val).toBe(0x12345678);
    });

    it('returns null on error response', async () => {
      autoReply('E14');
      const val = await gdb.readDword(0x400000);
      expect(val).toBeNull();
    });

    it('returns null on short response', async () => {
      autoReply('aabb');
      const val = await gdb.readDword(0x400000);
      expect(val).toBeNull();
    });
  });

  describe('writeDword', () => {
    it('writes a 32-bit LE value to the correct address', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        expect(data).toContain('M818930,4:efbeadde');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('OK'))), 5);
      });
      const ok = await gdb.writeDword(0x818930, 0xDEADBEEF);
      expect(ok).toBe(true);
    });

    it('returns false on error', async () => {
      autoReply('E01');
      const ok = await gdb.writeDword(0x818930, 0xDEADBEEF);
      expect(ok).toBe(false);
    });

    it('handles values with bit 31 set (> 0x7FFFFFFF)', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        // 0xFFFFFFFF in LE = ffffffff
        expect(data).toContain('M818930,4:ffffffff');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('OK'))), 5);
      });
      const ok = await gdb.writeDword(0x818930, 0xFFFFFFFF);
      expect(ok).toBe(true);
    });

    it('handles 0xCAFEBABE correctly', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        // 0xCAFEBABE → LE: be ba fe ca
        expect(data).toContain('M818934,4:bebafeca');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('OK'))), 5);
      });
      const ok = await gdb.writeDword(0x818934, 0xCAFEBABE);
      expect(ok).toBe(true);
    });
  });

  describe('writeBytes', () => {
    it('writes raw hex bytes to address', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        expect(data).toContain('M818900,5:31c0c20400');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('OK'))), 5);
      });
      const ok = await gdb.writeBytes(0x818900, '31c0c20400');
      expect(ok).toBe(true);
    });
  });

  describe('readBytes', () => {
    it('reads raw hex bytes from address', async () => {
      autoReply('c7058930');
      const result = await gdb.readBytes(0x8189c0, 4);
      expect(result).toBe('c7058930');
    });
  });

  describe('interrupt', () => {
    it('sends break character and waits for stop reply', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        expect(data).toBe('\x03');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('T02'))), 5);
      });
      const resp = await gdb.interrupt(5000);
      expect(resp).toBe('T02');
    });
  });

  describe('continueAsync', () => {
    it('sends continue without waiting for reply', () => {
      gdb.continueAsync();
      expect(currentSocket.write).toHaveBeenCalledWith(`$c#${checksum('c')}`);
    });
  });

  describe('setBreakpoint / removeBreakpoint', () => {
    it('sends Z0 for software breakpoints', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        expect(data).toContain('Z0,4d3718,1');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('OK'))), 5);
      });
      const ok = await gdb.setBreakpoint(0x4D3718);
      expect(ok).toBe(true);
    });

    it('sends z0 to remove software breakpoints', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        expect(data).toContain('z0,4d3718,1');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('OK'))), 5);
      });
      const ok = await gdb.removeBreakpoint(0x4D3718);
      expect(ok).toBe(true);
    });
  });

  describe('setHwBreakpoint / removeHwBreakpoint', () => {
    it('sends Z1 for hardware breakpoints', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        expect(data).toContain('Z1,5b44fc,1');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('OK'))), 5);
      });
      const ok = await gdb.setHwBreakpoint(0x5b44fc);
      expect(ok).toBe(true);
    });

    it('sends z1 to remove hardware breakpoints', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        expect(data).toContain('z1,5b44fc,1');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('OK'))), 5);
      });
      const ok = await gdb.removeHwBreakpoint(0x5b44fc);
      expect(ok).toBe(true);
    });
  });

  describe('parseRegisters', () => {
    it('parses x86 register hex string into named registers', () => {
      const hex = [
        '01000000', // eax = 0x00000001
        '18878100', // ecx = 0x00818718
        '00000000', // edx = 0
        '00000000', // ebx = 0
        'f4fe1200', // esp = 0x0012fef4
        '00000000', // ebp = 0
        '00000000', // esi = 0
        '00000000', // edi = 0
        'c0898100', // eip = 0x008189c0
        '46020000', // eflags = 0x00000246
      ].join('');

      const regs = gdb.parseRegisters(hex);
      expect(regs.eax).toBe(1);
      expect(regs.ecx).toBe(0x00818718);
      expect(regs.esp).toBe(0x0012fef4);
      expect(regs.eip).toBe(0x008189c0);
      expect(regs.eflags).toBe(0x00000246);
    });
  });

  describe('toLEHex', () => {
    it('converts a 32-bit value to little-endian hex string', () => {
      // 0x008189c0 → LE bytes: c0 89 81 00
      expect(gdb.toLEHex(0x008189c0)).toBe('c0898100');
      expect(gdb.toLEHex(0xDEADBEEF)).toBe('efbeadde');
      expect(gdb.toLEHex(0)).toBe('00000000');
      expect(gdb.toLEHex(0xFFFFFFFF)).toBe('ffffffff');
    });
  });

  describe('continueAndWait', () => {
    it('sends continue and waits for stop reply', async () => {
      currentSocket.write.mockImplementationOnce(() => {
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('T05'))), 10);
      });
      const resp = await gdb.continueAndWait(5000);
      expect(resp).toBe('T05');
    });
  });

  describe('singleStep', () => {
    it('sends step command and returns stop reply', async () => {
      currentSocket.write.mockImplementationOnce(() => {
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('T05'))), 5);
      });
      const resp = await gdb.singleStep(5000);
      expect(resp).toBe('T05');
    });
  });

  describe('writeRegister', () => {
    it('sends P command with register number and LE value', async () => {
      currentSocket.write.mockImplementationOnce((data: string) => {
        expect(data).toContain('P8=c0898100');
        setTimeout(() => currentSocket.emit('data', Buffer.from(gdbReply('OK'))), 5);
      });
      const ok = await gdb.writeRegister(8, gdb.toLEHex(0x008189c0));
      expect(ok).toBe(true);
    });
  });

  describe('readString', () => {
    it('reads null-terminated ASCII string', async () => {
      const str = Buffer.from('USER32.dll\0padding', 'ascii');
      autoReply(str.toString('hex'));
      const result = await gdb.readString(0x400000);
      expect(result).toBe('USER32.dll');
    });

    it('returns (error) on read failure', async () => {
      autoReply('E14');
      const result = await gdb.readString(0x400000);
      expect(result).toBe('(error)');
    });
  });

  describe('detach', () => {
    it('sends detach command and destroys socket', async () => {
      autoReply('OK');
      await gdb.detach();
      expect(currentSocket.destroy).toHaveBeenCalled();
    });
  });
});
