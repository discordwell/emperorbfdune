#!/usr/bin/env npx tsx

/**
 * QEMU GDB injection: Navigate Emperor past house-select to campaign map.
 *
 * Attaches to QEMU's GDB stub, calls selectFn to pick a house, then
 * intercepts the crash handler (0x5b44fc) before ExitProcess runs.
 * Redirects EIP to shellcode that calls openScreen for the campaign map.
 *
 * Uses SW breakpoints in the shellcode to guarantee game-process context
 * before reading breadcrumbs (QEMU GDB uses virtual addresses via current
 * page table — interrupt may land in a different process).
 */

import path from 'node:path';
import fs from 'node:fs';
import * as net from 'node:net';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
let QemuController: any;

const OUT_DIR = '/tmp/qemu-houseselect';
fs.mkdirSync(OUT_DIR, { recursive: true });
const ISO_PATH = '/tmp/EMPEROR1.iso';

async function loadDeps() {
  const qmod = await import(path.join(ROOT, 'tools/visual-oracle/qemu/QemuController.js'));
  QemuController = qmod.QemuController;
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

class GdbClient {
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
  continueAsync(): void {
    this.socket?.write(`$c#${this.checksum('c')}`);
  }
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
  async readDword(addr: number): Promise<number> {
    const resp = await this.send(`m${addr.toString(16)},4`);
    if (resp.startsWith('E') || resp.length < 8) return -1;
    const bytes = resp.match(/.{2}/g)!;
    return parseInt(bytes[3] + bytes[2] + bytes[1] + bytes[0], 16);
  }
  async writeDword(addr: number, val: number): Promise<boolean> {
    const hex = val.toString(16).padStart(8, '0');
    const le = hex[6] + hex[7] + hex[4] + hex[5] + hex[2] + hex[3] + hex[0] + hex[1];
    const resp = await this.send(`M${addr.toString(16)},4:${le}`);
    return resp === 'OK';
  }
  async writeBytes(addr: number, hexBytes: string): Promise<boolean> {
    const resp = await this.send(`M${addr.toString(16)},${(hexBytes.length / 2).toString(16)}:${hexBytes}`);
    return resp === 'OK';
  }
  async readBytes(addr: number, len: number): Promise<string> {
    return this.send(`m${addr.toString(16)},${len.toString(16)}`);
  }
  async readRegisters(): Promise<string> { return this.send('g'); }
  async writeRegister(regNum: number, hexValue: string): Promise<boolean> {
    const resp = await this.send(`P${regNum.toString(16)}=${hexValue}`);
    return resp === 'OK';
  }
  async setBreakpoint(addr: number): Promise<boolean> {
    const resp = await this.send(`Z0,${addr.toString(16)},1`);
    return resp === 'OK';
  }
  async removeBreakpoint(addr: number): Promise<boolean> {
    const resp = await this.send(`z0,${addr.toString(16)},1`);
    return resp === 'OK';
  }
  async setHwBreakpoint(addr: number): Promise<boolean> {
    const resp = await this.send(`Z1,${addr.toString(16)},1`);
    return resp === 'OK';
  }
  async removeHwBreakpoint(addr: number): Promise<boolean> {
    const resp = await this.send(`z1,${addr.toString(16)},1`);
    return resp === 'OK';
  }
  parseRegisters(hex: string): Record<string, number> {
    const regs: Record<string, number> = {};
    const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];
    for (let i = 0; i < names.length; i++) {
      const offset = i * 8;
      const leHex = hex.substring(offset, offset + 8);
      if (!leHex || leHex.length < 8) continue;
      const bytes = leHex.match(/.{2}/g)!;
      regs[names[i]] = parseInt(bytes[3] + bytes[2] + bytes[1] + bytes[0], 16);
    }
    return regs;
  }
  toLEHex(val: number): string {
    const hex = (val >>> 0).toString(16).padStart(8, '0');
    return hex[6] + hex[7] + hex[4] + hex[5] + hex[2] + hex[3] + hex[0] + hex[1];
  }
  async readString(addr: number, maxLen = 64): Promise<string> {
    const hex = await this.readBytes(addr, maxLen);
    if (hex.startsWith('E')) return '(error)';
    const buf = Buffer.from(hex, 'hex');
    const end = buf.indexOf(0);
    return buf.subarray(0, end === -1 ? maxLen : end).toString('ascii');
  }
  async detach(): Promise<void> {
    try { await this.send('D'); } catch {}
    this.socket?.destroy();
    this.socket = null;
  }
}

const RA = 0x4D3718;
const RA5 = RA + 5;
const FAKE_BINK_ADDR = 0x818940;
const EXIT_PROCESS_ADDR = 0x75a5214f;
const CRASH_HANDLER_CALL = 0x5b44fc;
const SHELLCODE_ADDR = 0x8189C0;
const BREADCRUMB_ADDR = 0x818930;
const PREP_SCREEN = 0x4D69D0;
const OPEN_SCREEN = 0x4D6A40;
const COMMIT_SCREEN = 0x4D5D00;
const FLUSH_QUEUE = 0x4EA190;
const CAMPAIGN_ADDR = 0x5FDB70;
const APP_ADDR = 0x818718;

const BINK_IAT: [number, number][] = [
  [0x5d0384, 0x818908], [0x5d0388, 0x818908], [0x5d038c, 0x818918],
  [0x5d0390, 0x818908], [0x5d0394, 0x818910], [0x5d0398, 0x818908],
  [0x5d039c, 0x818920], [0x5d03a0, 0x818900], [0x5d03a4, 0x818928],
  [0x5d03a8, 0x818920], [0x5d03ac, 0x818908], [0x5d03b0, 0x818908],
];

function buildFakeBinkHandle(): string {
  const buf = Buffer.alloc(128, 0);
  buf.writeUInt32LE(320, 0x00); buf.writeUInt32LE(240, 0x04);
  buf.writeUInt32LE(1, 0x08); buf.writeUInt32LE(2, 0x0C);
  buf.writeUInt32LE(15, 0x10); buf.writeUInt32LE(1, 0x14);
  return buf.toString('hex');
}

/** Emit dword as 4 little-endian bytes */
function dwordLE(val: number): number[] { return [val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF]; }
function pushDword(sc: number[], val: number): void { sc.push(0x68, ...dwordLE(val)); }
function movEcx(sc: number[], val: number): void { sc.push(0xB9, ...dwordLE(val)); }
function movEax(sc: number[], val: number): void { sc.push(0xB8, ...dwordLE(val)); }
function callEax(sc: number[]): void { sc.push(0xFF, 0xD0); }
/** mov dword [addr], imm32 */
function movToMem(sc: number[], addr: number, val: number): void { sc.push(0xC7, 0x05, ...dwordLE(addr), ...dwordLE(val)); }

async function main() {
  await loadDeps();
  const ctrl = new QemuController();

  try {
    await ctrl.boot();
    await ctrl.loadSnapshot('house-v5');
    console.log('Loaded house-v5');

    await ctrl.qmpCommand('human-monitor-command',
      { 'command-line': `change ide1-cd0 ${ISO_PATH}` });
    await sleep(10000);

    await ctrl.qmpCommand('stop');
    await sleep(1000);
    await ctrl.qmpCommand('human-monitor-command', { 'command-line': 'gdbserver tcp::1234' });
    await sleep(2000);
    const gdb = new GdbClient();
    await gdb.connect('127.0.0.1', 1234);

    // Bink stubs
    await gdb.writeBytes(FAKE_BINK_ADDR, buildFakeBinkHandle());
    const bo = [0xB8, FAKE_BINK_ADDR & 0xFF, (FAKE_BINK_ADDR >> 8) & 0xFF, (FAKE_BINK_ADDR >> 16) & 0xFF, (FAKE_BINK_ADDR >> 24) & 0xFF, 0xC2, 0x08, 0x00];
    await gdb.writeBytes(0x818900, bo.map(b => b.toString(16).padStart(2, '0')).join(''));
    await gdb.writeBytes(0x818908, '31c0c20400');
    await gdb.writeBytes(0x818910, '31c0c21c00');
    await gdb.writeBytes(0x818918, '31c0c20c00');
    await gdb.writeBytes(0x818920, '31c0c20800');
    await gdb.writeBytes(0x818928, '31c0c3');
    for (const [a, s] of BINK_IAT) await gdb.writeDword(a, s);

    // Enter game context
    await gdb.setBreakpoint(RA);
    await gdb.continueAndWait(120000);
    await gdb.removeBreakpoint(RA);
    const regs1 = gdb.parseRegisters(await gdb.readRegisters());
    if (regs1.eip >= 0x80000000) { console.log('Wrong context'); await gdb.detach(); return; }
    console.log('In game context');

    // Resolve USER32 imports
    const eLfanew = await gdb.readDword(0x400000 + 0x3C);
    const importRVA = await gdb.readDword(0x400000 + eLfanew + 24 + 96 + 8);
    const importVA = 0x400000 + importRVA;
    let getMessageA = 0, dispatchMessageA = 0, translateMessage = 0;
    for (let i = 0; i < 30; i++) {
      const d = importVA + i * 20;
      const o = await gdb.readDword(d); const n = await gdb.readDword(d + 12); const f = await gdb.readDword(d + 16);
      if (n === 0 && f === 0) break;
      const dll = await gdb.readString(0x400000 + n);
      if (dll.toLowerCase().includes('user32')) {
        const ia = 0x400000 + f; const it = 0x400000 + o;
        for (let j = 0; j < 200; j++) {
          const ie = await gdb.readDword(it + j * 4);
          if (ie === 0) break; if ((ie >>> 31) === 1) continue;
          const fn = await gdb.readString(0x400000 + ie + 2);
          const rv = await gdb.readDword(ia + j * 4);
          if (fn === 'GetMessageA') getMessageA = rv;
          if (fn === 'DispatchMessageA') dispatchMessageA = rv;
          if (fn === 'TranslateMessage') translateMessage = rv;
        }
      }
    }
    console.log(`GetMessageA=0x${getMessageA.toString(16)} Dispatch=0x${dispatchMessageA.toString(16)} Translate=0x${translateMessage.toString(16)}`);
    if (!getMessageA || !dispatchMessageA || !translateMessage) {
      console.log('Failed to resolve USER32 imports');
      await gdb.detach(); return;
    }

    // === FULL SHELLCODE ===
    const sc: number[] = [];
    // DEADBEEF breadcrumb
    movToMem(sc, BREADCRUMB_ADDR, 0xDEADBEEF); // offset 0, 10B
    // sub esp, 0x200 — move stack down 512 bytes for safety (within committed stack)
    sc.push(0x81, 0xEC, 0x00, 0x02, 0x00, 0x00); // offset 10, 6B
    // prepScreen(campaign)
    movEcx(sc, APP_ADDR); pushDword(sc, CAMPAIGN_ADDR); movEax(sc, PREP_SCREEN); callEax(sc);
    // openScreen(campaign, 1)
    movEcx(sc, APP_ADDR); sc.push(0x6A, 0x01); pushDword(sc, CAMPAIGN_ADDR); movEax(sc, OPEN_SCREEN); callEax(sc);
    // commitScreen(0)
    movEcx(sc, APP_ADDR); sc.push(0x6A, 0x00); movEax(sc, COMMIT_SCREEN); callEax(sc);
    // flushScreenQueue()
    movEax(sc, FLUSH_QUEUE); callEax(sc);
    // CAFEBABE breadcrumb (marks all calls completed)
    const cafeOffset = sc.length;
    movToMem(sc, BREADCRUMB_ADDR + 4, 0xCAFEBABE); // 10B
    // After CAFEBABE: marker for breakpoint
    const postCafeOffset = sc.length;
    // Message loop
    sc.push(0x83, 0xEC, 0x30); // sub esp, 48 for MSG struct
    const loopTop = sc.length;
    sc.push(0x6A,0x00,0x6A,0x00,0x6A,0x00,0x8D,0x44,0x24,0x0C,0x50);
    movEax(sc, getMessageA); callEax(sc);
    sc.push(0x8D,0x44,0x24,0x00,0x50);
    movEax(sc, translateMessage); callEax(sc);
    sc.push(0x8D,0x44,0x24,0x00,0x50);
    movEax(sc, dispatchMessageA); callEax(sc);
    const loopEnd = sc.length;
    const rel = loopTop - loopEnd - 2;
    if (rel >= -128) sc.push(0xEB, rel & 0xFF);
    else { sc.push(0xE9); const r32=loopTop-(loopEnd+5); sc.push(r32&0xFF,(r32>>8)&0xFF,(r32>>16)&0xFF,(r32>>24)&0xFF); }

    await gdb.writeBytes(SHELLCODE_ADDR, sc.map(b => b.toString(16).padStart(2, '0')).join(''));
    await gdb.writeDword(BREADCRUMB_ADDR, 0);
    await gdb.writeDword(BREADCRUMB_ADDR + 4, 0);
    console.log(`Shellcode ${sc.length}B, CAFE@offset${cafeOffset}, postCAFE@offset${postCafeOffset}`);

    const CAFE_BP_ADDR = SHELLCODE_ADDR + postCafeOffset;
    console.log(`Post-CAFE BP addr: 0x${CAFE_BP_ADDR.toString(16)}`);

    // selectFn
    console.log('\n=== selectFn ===');
    const screenAddr = await gdb.readDword(0x818718);
    await gdb.writeDword(screenAddr + 0x18, 0);
    await gdb.writeDword(0x817C0C, screenAddr);
    const sa = regs1.esp - 0x1000;
    const ss: number[] = [];
    ss.push(0x9C, 0x60);
    movEcx(ss, screenAddr);
    ss.push(0x8B,0x01,0x8B,0x40,0x3C,0x6A,0x03,0xFF,0xD0);
    ss.push(0x61, 0x9D, 0x3D, 0x1E, 0x00, 0x07, 0x80, 0xE9);
    const jo = RA5 - (sa + ss.length + 4);
    ss.push(jo&0xFF,(jo>>8)&0xFF,(jo>>16)&0xFF,(jo>>24)&0xFF);
    await gdb.writeBytes(sa, ss.map(b => b.toString(16).padStart(2, '0')).join(''));
    await gdb.writeRegister(8, gdb.toLEHex(sa));
    await gdb.setBreakpoint(RA5);
    await gdb.continueAndWait(120000);
    await gdb.removeBreakpoint(RA5);
    console.log('selectFn complete');

    // === HW breakpoints ===
    console.log('\n=== HW BPs ===');
    await gdb.setHwBreakpoint(CRASH_HANDLER_CALL);
    await gdb.setHwBreakpoint(EXIT_PROCESS_ADDR);

    let hitType = '';
    const t0 = Date.now();

    for (let attempt = 0; attempt < 200; attempt++) {
      if ((Date.now() - t0) > 300000) break;
      await gdb.continueAndWait(300000);
      const regs = gdb.parseRegisters(await gdb.readRegisters());
      const eip = regs.eip >>> 0;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

      if (eip === CRASH_HANDLER_CALL) {
        console.log(`[${attempt}] CRASH HANDLER [${elapsed}s]`);
        hitType = 'crash';
        break;
      } else if (eip === EXIT_PROCESS_ADDR) {
        const gc = await gdb.readBytes(SHELLCODE_ADDR, 4);
        if (gc.startsWith('E')) {
          console.log(`  [${attempt}] skip non-game [${elapsed}s]`);
          await gdb.singleStep();
          continue;
        }
        const exitCode = await gdb.readDword(regs.esp + 4);
        console.log(`[${attempt}] GAME ExitProcess code=0x${(exitCode>>>0).toString(16)} [${elapsed}s]`);
        hitType = 'exit';
        break;
      } else {
        console.log(`  [${attempt}] unexpected EIP=0x${eip.toString(16)} [${elapsed}s]`);
        await gdb.singleStep();
      }
    }

    if (!hitType) {
      console.log('Timeout');
      await gdb.removeHwBreakpoint(CRASH_HANDLER_CALL);
      await gdb.removeHwBreakpoint(EXIT_PROCESS_ADDR);
      await gdb.detach();
      await ctrl.qmpCommand('human-monitor-command', { 'command-line': 'gdbserver none' });
      await ctrl.qmpCommand('cont');
      return;
    }

    // Remove HW BPs, set SW BPs, redirect
    await gdb.removeHwBreakpoint(CRASH_HANDLER_CALL);
    await gdb.removeHwBreakpoint(EXIT_PROCESS_ADDR);

    // SW BP at shellcode start
    await gdb.setBreakpoint(SHELLCODE_ADDR);
    await gdb.writeRegister(8, gdb.toLEHex(SHELLCODE_ADDR));

    // Continue to SW BP (immediate — EIP is at shellcode)
    console.log('Continuing to shellcode BP...');
    await gdb.continueAndWait(30000);
    const bpRegs = gdb.parseRegisters(await gdb.readRegisters());
    console.log(`At shellcode: EIP=0x${(bpRegs.eip>>>0).toString(16)} ESP=0x${(bpRegs.esp>>>0).toString(16)}`);
    await gdb.removeBreakpoint(SHELLCODE_ADDR);

    // Single-step: DEADBEEF write
    await gdb.singleStep();
    const bc1 = await gdb.readDword(BREADCRUMB_ADDR);
    console.log(`After DEADBEEF step: bc1=0x${(bc1>>>0).toString(16)}`);

    if (bc1 !== 0xDEADBEEF) {
      console.log('DEADBEEF write failed!');
      await gdb.detach();
      await ctrl.qmpCommand('human-monitor-command', { 'command-line': 'gdbserver none' });
      await ctrl.qmpCommand('cont');
      return;
    }

    // Now set SW BP at post-CAFEBABE address
    console.log(`Setting BP at post-CAFE: 0x${CAFE_BP_ADDR.toString(16)}`);
    await gdb.setBreakpoint(CAFE_BP_ADDR);

    // Continue — openScreen calls will execute
    console.log('Executing openScreen calls...');
    const openResp = await gdb.continueAndWait(180000); // 3 min timeout for TCG
    const openRegs = gdb.parseRegisters(await gdb.readRegisters());
    const openEip = openRegs.eip >>> 0;
    console.log(`After openScreen: EIP=0x${openEip.toString(16)} response=${openResp.substring(0, 40)}`);

    await gdb.removeBreakpoint(CAFE_BP_ADDR);

    if (openEip === CAFE_BP_ADDR) {
      // CAFEBABE BP fired — all calls completed!
      const bc2 = await gdb.readDword(BREADCRUMB_ADDR + 4);
      console.log(`bc2=0x${(bc2>>>0).toString(16)}`);

      // Read current screen pointer — did it change?
      const newScreen = await gdb.readDword(APP_ADDR);
      console.log(`Screen after openScreen: 0x${(newScreen>>>0).toString(16)}`);

      console.log('\n*** ALL openScreen CALLS COMPLETED! ***');

      // Continue into message loop
      gdb.continueAsync();
      console.log('Entering message loop, waiting 20s...');
      await sleep(20000);

      // Detach and take screenshot
      await gdb.interrupt(10000);
      await gdb.detach();
      await ctrl.qmpCommand('human-monitor-command', { 'command-line': 'gdbserver none' });
      await ctrl.qmpCommand('cont');
      await sleep(5000);
      await ctrl.captureScreenshot(path.join(OUT_DIR, 'v45-campaign.png'));

      // Save snapshot
      await ctrl.qmpCommand('stop');
      await ctrl.saveSnapshot('campaign-v45');
      console.log('*** SAVED campaign-v45 ***');
      await ctrl.qmpCommand('cont');

    } else {
      // Timeout or unexpected stop — openScreen may have crashed
      console.log('openScreen calls may have crashed');

      // Check if we're in game context
      const gc = await gdb.readBytes(SHELLCODE_ADDR, 4);
      console.log(`Game context check: ${gc}`);

      if (gc.startsWith('E')) {
        console.log('Process likely dead (can\'t read game memory)');
        // Try reading from a known kernel address to confirm we're just in wrong context
        console.log('Setting SW BP in game code to force context switch...');
        // Use the game's main loop address or a frequently-hit location
        // Actually, if the process is dead, no game code BP will fire
        // Let's just check breadcrumbs
      } else {
        // In game context — check what went wrong
        const curBc1 = await gdb.readDword(BREADCRUMB_ADDR);
        const curBc2 = await gdb.readDword(BREADCRUMB_ADDR + 4);
        const curEip = openEip;
        console.log(`State: bc1=0x${(curBc1>>>0).toString(16)} bc2=0x${(curBc2>>>0).toString(16)} EIP=0x${curEip.toString(16)}`);

        // Single-step a few times to see where we are
        for (let i = 0; i < 5; i++) {
          await gdb.singleStep();
          const r = gdb.parseRegisters(await gdb.readRegisters());
          console.log(`  step ${i}: EIP=0x${(r.eip>>>0).toString(16)} ESP=0x${(r.esp>>>0).toString(16)}`);
        }
      }

      await gdb.detach();
      await ctrl.qmpCommand('human-monitor-command', { 'command-line': 'gdbserver none' });
      await ctrl.qmpCommand('cont');
    }

    await ctrl.captureScreenshot(path.join(OUT_DIR, 'v45-final.png'));
  } finally {
    await ctrl.shutdown();
  }
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : String(err)); process.exit(1); });
