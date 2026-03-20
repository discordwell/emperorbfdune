#!/usr/bin/env npx tsx

/**
 * GDB injection: Set gameMode=1 (Single), let game create campaign state,
 * then set house+difficulty and redirect to campaign screen.
 *
 * Flow:
 * 1. Enter game context at RA
 * 2. Patch Bink IAT
 * 3. Call Single handler (sets gameMode=1 on MainMenuManager)
 * 4. Let game run 10s (creates campaign state, shows difficulty menu)
 * 5. Interrupt, verify [0x808CDC] is set
 * 6. Set house=Atreides, difficulty=Normal
 * 7. Call campaign init + openScreen("Campaign")
 */

import path from 'node:path';
import { GdbClient } from './GdbClient.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
let QemuController: any;

async function loadDeps() {
  const qmod = await import(path.join(ROOT, 'tools/visual-oracle/qemu/QemuController.js'));
  QemuController = qmod.QemuController;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

const CAMPAIGN_STATE_PTR = 0x808CDC;
const SCREEN_MANAGER = 0x809830;
const FIND_SCREEN = 0x4D8440;
const OPEN_SCREEN = 0x4D8580;
const CAMPAIGN_INIT = 0x48EB00;
const CAMPAIGN_STR = 0x5F1200;        // "Campaign"
const MAIN_MENU_STR = 0x5FD4F8;       // "MainMenuManager"
const DIFFICULTY_NORMAL = 0x5C7FD0;
const HOUSE_ATREIDES = 0;
const RA = 0x4D3718;
const SHELLCODE_ADDR = 0x8189C0;
const BREADCRUMB_ADDR = 0x818930;
const STUB_ADDR = 0x818880;

const FAKE_BINK_ADDR = 0x818940;
const BINK_IAT: [number, number][] = [
  [0x5d0384, 0x818908], [0x5d0388, 0x818908], [0x5d038c, 0x818918],
  [0x5d0390, 0x818908], [0x5d0394, 0x818910], [0x5d0398, 0x818908],
  [0x5d039c, 0x818920], [0x5d03a0, 0x818900], [0x5d03a4, 0x818928],
  [0x5d03a8, 0x818920], [0x5d03ac, 0x818908], [0x5d03b0, 0x818908],
];

function dwordLE(val: number): number[] {
  return [val & 0xFF, (val >> 8) & 0xFF, (val >> 16) & 0xFF, (val >> 24) & 0xFF];
}
function toLEHex(val: number): string {
  const b = Buffer.alloc(4); b.writeUInt32LE(val); return b.toString('hex');
}
function toHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  await loadDeps();
  const ctrl = new QemuController();

  console.log('Connecting...');
  await ctrl.connectToExisting();
  await ctrl.qmpCommand('stop');
  await sleep(1000);
  await ctrl.qmpCommand('human-monitor-command', { 'command-line': 'gdbserver tcp::1234' });
  await sleep(2000);

  const gdb = new GdbClient();
  await gdb.connect('127.0.0.1', 1234);
  console.log('GDB connected');

  // Bink stubs
  const fakeBink = Buffer.alloc(128, 0);
  fakeBink.writeUInt32LE(320, 0); fakeBink.writeUInt32LE(240, 4);
  fakeBink.writeUInt32LE(1, 8); fakeBink.writeUInt32LE(2, 12);
  fakeBink.writeUInt32LE(15, 16); fakeBink.writeUInt32LE(1, 20);
  await gdb.writeBytes(FAKE_BINK_ADDR, fakeBink.toString('hex'));
  await gdb.writeBytes(0x818900, toHex([0xB8, ...dwordLE(FAKE_BINK_ADDR), 0xC2, 0x08, 0x00]));
  await gdb.writeBytes(0x818908, '31c0c20400');
  await gdb.writeBytes(0x818910, '31c0c21c00');
  await gdb.writeBytes(0x818918, '31c0c20c00');
  await gdb.writeBytes(0x818920, '31c0c20800');
  await gdb.writeBytes(0x818928, '31c0c3');
  for (const [a, s] of BINK_IAT) await gdb.writeDword(a, s);
  console.log('Bink stubs patched');

  // === STEP 1: Enter game context ===
  await gdb.setBreakpoint(RA);
  await gdb.continueAndWait(120000);
  await gdb.removeBreakpoint(RA);
  let hex = await gdb.readRegisters();
  if (!hex || hex.length < 80) { console.log('Reg read fail'); await gdb.detach(); return; }
  let r = gdb.parseRegisters(hex);
  console.log(`Step 1: EIP=0x${r.eip.toString(16)}`);

  // === STEP 2: Call Single handler (0x4E5090) ===
  // Replicates what the title menu click does:
  //   findScreen("MainMenuManager") → set [result+0xF0]=1, [result+0xF4]=1
  // Then the game's main loop reacts to gameMode=1 by creating campaign state
  const singleStub: number[] = [
    // push "MainMenuManager" string
    0x68, ...dwordLE(MAIN_MENU_STR),
    // mov ecx, SCREEN_MANAGER
    0xB9, ...dwordLE(SCREEN_MANAGER),
    // call FIND_SCREEN
    0xB8, ...dwordLE(FIND_SCREEN),
    0xFF, 0xD0,
    // mov byte [eax+0xF0], 1
    0xC6, 0x80, 0xF0, 0x00, 0x00, 0x00, 0x01,
    // mov dword [eax+0xF4], 1 (gameMode=Single)
    0xC7, 0x80, 0xF4, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    // INT3
    0xCC,
  ];
  await gdb.writeBytes(STUB_ADDR, toHex(singleStub));
  await gdb.writeRegister(8, toLEHex(STUB_ADDR));

  console.log('Step 2: Setting gameMode=1 (Single)...');
  const sr2 = await gdb.continueAndWait(10000);
  console.log(`Single handler done: ${sr2.substring(0, 30)}`);

  // === STEP 3: Let game run 15s to process gameMode change ===
  console.log('Step 3: Letting game process mode change (15s)...');
  gdb.continueAsync();
  await sleep(15000);

  // Interrupt
  const intReply = await gdb.interrupt(15000);
  console.log(`Interrupted: ${intReply.substring(0, 30)}`);

  // === STEP 4: Check campaign state ===
  // We might be in kernel mode after interrupt. Try reading campaign state anyway.
  // GDB memory reads work regardless of CPU mode.
  const campaignState = await gdb.readDword(CAMPAIGN_STATE_PTR);
  console.log(`Step 4: [0x808CDC] = 0x${(campaignState ?? 0).toString(16)}`);

  if (!campaignState) {
    console.log('Campaign state still NULL. Trying longer wait...');
    gdb.continueAsync();
    await sleep(30000);
    await gdb.interrupt(15000);
    const cs2 = await gdb.readDword(CAMPAIGN_STATE_PTR);
    console.log(`After 30s: [0x808CDC] = 0x${(cs2 ?? 0).toString(16)}`);
    if (!cs2) {
      console.log('Campaign state never initialized. Taking screenshot for diagnosis...');
      await gdb.detach();
      await sleep(3000);
      await ctrl.captureScreenshot('/tmp/ebfd-after-single.png');
      console.log('Screenshot saved: /tmp/ebfd-after-single.png');
      process.exit(1);
    }
  }

  const cs = (await gdb.readDword(CAMPAIGN_STATE_PTR)) ?? 0;
  console.log(`Campaign state object at 0x${cs.toString(16)}`);

  // Set difficulty and house
  await gdb.writeDword(cs + 0xD38, DIFFICULTY_NORMAL);
  await gdb.writeDword(cs + 0x52C, HOUSE_ATREIDES);
  console.log('Set difficulty=Normal, house=Atreides');

  // === STEP 5: Re-enter game context and run campaign shellcode ===
  // We need to be in user mode. Set BP at RA and continue.
  console.log('Step 5: Re-entering game context...');
  await gdb.setBreakpoint(RA);
  const sr5 = await gdb.continueAndWait(30000);
  await gdb.removeBreakpoint(RA);

  hex = await gdb.readRegisters();
  if (!hex || hex.length < 80) {
    console.log('Re-entry failed. Trying alternate approach...');
    // Maybe RA isn't hit anymore (different screen). Try direct redirect.
    // Read EIP — might be valid game code
    gdb.continueAsync();
    await sleep(2000);
    await gdb.interrupt(15000);
  }

  // Resolve USER32 for message loop
  const eLfanew = (await gdb.readDword(0x40003C)) ?? 0;
  const importRVA = (await gdb.readDword(0x400000 + eLfanew + 24 + 96 + 8)) ?? 0;
  let getMessageA = 0, dispatchMessageA = 0, translateMessage = 0;
  for (let i = 0; i < 30; i++) {
    const d = 0x400000 + importRVA + i * 20;
    const o = await gdb.readDword(d);
    const n = await gdb.readDword(d + 12);
    const f = await gdb.readDword(d + 16);
    if (n === null || f === null || (n === 0 && f === 0)) break;
    if (o === null) continue;
    const dll = await gdb.readString(0x400000 + n);
    if (dll.toLowerCase().includes('user32')) {
      const ia = 0x400000 + f; const it = 0x400000 + o;
      for (let j = 0; j < 200; j++) {
        const ie = await gdb.readDword(it + j * 4);
        if (ie === null || ie === 0) break;
        if ((ie >>> 31) === 1) continue;
        const fn = await gdb.readString(0x400000 + ie + 2);
        const rv = await gdb.readDword(ia + j * 4);
        if (rv === null) continue;
        if (fn === 'GetMessageA') getMessageA = rv;
        if (fn === 'DispatchMessageA') dispatchMessageA = rv;
        if (fn === 'TranslateMessage') translateMessage = rv;
      }
    }
  }
  if (!getMessageA) { console.log('USER32 failed'); await gdb.detach(); return; }

  // Build campaign shellcode
  const sc: number[] = [];
  sc.push(0xC7, 0x05, ...dwordLE(BREADCRUMB_ADDR), ...dwordLE(0xDEADBEEF));
  sc.push(0x81, 0xEC, 0x00, 0x02, 0x00, 0x00);
  // Campaign init
  sc.push(0x8B, 0x0D, ...dwordLE(CAMPAIGN_STATE_PTR)); // mov ecx, [campaignStatePtr]
  sc.push(0xB8, ...dwordLE(CAMPAIGN_INIT));
  sc.push(0xFF, 0xD0);
  // breadcrumb
  sc.push(0xC7, 0x05, ...dwordLE(BREADCRUMB_ADDR + 8), ...dwordLE(0xAABBCCDD));
  // openScreen("Campaign", 1)
  sc.push(0xB9, ...dwordLE(SCREEN_MANAGER));
  sc.push(0x6A, 0x01);
  sc.push(0x68, ...dwordLE(CAMPAIGN_STR));
  sc.push(0xB8, ...dwordLE(OPEN_SCREEN));
  sc.push(0xFF, 0xD0);
  // CAFEBABE
  sc.push(0xC7, 0x05, ...dwordLE(BREADCRUMB_ADDR + 4), ...dwordLE(0xCAFEBABE));
  const postCafe = sc.length;
  sc.push(0x90);
  // Message loop
  sc.push(0x83, 0xEC, 0x30);
  const loopTop = sc.length;
  sc.push(0x6A,0x00,0x6A,0x00,0x6A,0x00,0x8D,0x44,0x24,0x0C,0x50);
  sc.push(0xB8, ...dwordLE(getMessageA), 0xFF, 0xD0);
  sc.push(0x8D,0x44,0x24,0x00,0x50);
  sc.push(0xB8, ...dwordLE(translateMessage), 0xFF, 0xD0);
  sc.push(0x8D,0x44,0x24,0x00,0x50);
  sc.push(0xB8, ...dwordLE(dispatchMessageA), 0xFF, 0xD0);
  const loopEnd = sc.length;
  sc.push(0xEB, (loopTop - loopEnd - 2) & 0xFF);

  await gdb.writeBytes(SHELLCODE_ADDR, toHex(sc));
  console.log(`Shellcode: ${sc.length}B, postCAFE=${postCafe}`);

  // Execute
  await gdb.writeRegister(8, toLEHex(SHELLCODE_ADDR));
  await gdb.setBreakpoint(SHELLCODE_ADDR + postCafe);
  console.log('Running campaign shellcode...');
  const sr = await gdb.continueAndWait(120000);
  console.log(`Stop: ${sr.substring(0, 40)}`);
  await gdb.removeBreakpoint(SHELLCODE_ADDR + postCafe);

  const dead = await gdb.readDword(BREADCRUMB_ADDR);
  const cafe = await gdb.readDword(BREADCRUMB_ADDR + 4);
  const init = await gdb.readDword(BREADCRUMB_ADDR + 8);
  console.log(`DEAD=0x${(dead??0).toString(16)} INIT=0x${(init??0).toString(16)} CAFE=0x${(cafe??0).toString(16)}`);

  if (cafe === 0xCAFEBABE) {
    console.log('SUCCESS! Campaign with proper state!');
    await gdb.detach();
    await sleep(15000);
    await ctrl.captureScreenshot('/tmp/ebfd-campaign-final.png');
    console.log('Screenshot saved');
    await ctrl.qmpCommand('human-monitor-command', { 'command-line': 'savevm campaign-new-hook' });
    console.log('Snapshot: campaign-new-hook');
  } else {
    console.log('Failed');
    await gdb.detach();
    await sleep(3000);
    await ctrl.captureScreenshot('/tmp/ebfd-campaign-fail.png');
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
