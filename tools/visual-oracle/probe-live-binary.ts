#!/usr/bin/env npx tsx

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QemuController } from './qemu/QemuController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'artifacts', 'visual-oracle', 'probes');

type ConnectionRecord = {
  index: number;
  poll: string | null;
  command: string | null;
  responses: string[];
  rawLines: string[];
};

class HookProbeServer {
  private readonly port: number;
  private server: net.Server | null = null;
  private readonly queue: string[];
  private extraPollsRemaining: number;
  private readonly connections: ConnectionRecord[] = [];
  private pendingCommand: string | null = null;
  private resolved = false;
  private settleTimer: NodeJS.Timeout | null = null;
  private resolveDone: ((records: ConnectionRecord[]) => void) | null = null;

  constructor(port: number, commands: string[], extraPolls: number) {
    this.port = port;
    this.queue = [...commands];
    this.extraPollsRemaining = extraPolls;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleSocket(socket));
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => resolve());
    });
  }

  async waitForCompletion(timeoutMs: number): Promise<ConnectionRecord[]> {
    if (this.queue.length === 0 && this.pendingCommand === null && this.connections.length > 0) {
      return this.connections;
    }

    return new Promise<ConnectionRecord[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for hook probe completion`));
      }, timeoutMs);

      this.resolveDone = (records) => {
        clearTimeout(timeout);
        resolve(records);
      };
    });
  }

  get remainingCommands(): string[] {
    return [...this.queue];
  }

  async stop(): Promise<void> {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handleSocket(socket: net.Socket): void {
    const record: ConnectionRecord = {
      index: this.connections.length,
      poll: null,
      command: null,
      responses: [],
      rawLines: [],
    };
    this.connections.push(record);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;
        record.rawLines.push(trimmed);

        if (record.poll === null && trimmed.startsWith('poll ')) {
          record.poll = trimmed;
          const cmd = this.nextCommand();
          record.command = cmd === 'none' ? null : cmd;
          this.pendingCommand = record.command;
          socket.write(`${cmd}\n`);
          continue;
        }

        if (record.poll === null && trimmed === 'poll') {
          record.poll = trimmed;
          const cmd = this.nextCommand();
          record.command = cmd === 'none' ? null : cmd;
          this.pendingCommand = record.command;
          socket.write(`${cmd}\n`);
          continue;
        }

        record.responses.push(trimmed);
      }
    });

    socket.on('close', () => {
      if (record.command !== null) {
        this.pendingCommand = null;
      }
      this.maybeResolve();
    });

    socket.on('error', () => {
      this.maybeResolve();
    });
  }

  private maybeResolve(): void {
    if (this.resolved) return;
    if (this.queue.length > 0) return;
    if (this.extraPollsRemaining > 0) return;
    if (this.pendingCommand !== null) return;

    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
    }
    this.settleTimer = setTimeout(() => {
      if (this.resolved) return;
      this.resolved = true;
      this.resolveDone?.(this.connections);
    }, 1500);
  }

  private nextCommand(): string {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (this.extraPollsRemaining > 0) {
      this.extraPollsRemaining -= 1;
    }
    return 'none';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.snapshot) {
    throw new Error('Usage: probe-live-binary.ts --snapshot <name> --cmd "<command>" [--cmd "<command>"] [--qmp-move <x> <y>] [--save-snapshot <name>] [--out <path>]');
  }
  if (args.commands.length === 0) {
    throw new Error('At least one --cmd is required');
  }

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });

  const server = new HookProbeServer(18890, args.commands, args.extraPolls);
  const controller = new QemuController();

  try {
    console.log(`[probe] starting TCP hook probe on port 18890`);
    await server.start();

    console.log(`[probe] booting VM and loading snapshot "${args.snapshot}"`);
    await controller.boot();
    await controller.loadSnapshot(args.snapshot);

    if (args.cdromPath) {
      await controller.changeCD(args.cdromPath);
      await sleep(1000);
    }

    for (const runCommand of args.runCommands) {
      console.log(`[probe] run dialog: ${runCommand}`);
      await openRunDialog(controller);
      await typeText(controller, runCommand);
      await controller.sendKey(['ret']);
      await sleep(args.runWaitMs);
    }

    if (args.finalWaitMs > 0) {
      console.log(`[probe] final wait: ${args.finalWaitMs}ms`);
      await sleep(args.finalWaitMs);
    }

    for (const keyChord of args.sendKeys) {
      console.log(`[probe] send key: ${keyChord.join('+')}`);
      await controller.sendKey(keyChord);
      await sleep(args.sendKeyWaitMs);
    }

    if (args.qmpMoveX !== null && args.qmpMoveY !== null) {
      console.log(`[probe] qmp mouse move: (${args.qmpMoveX}, ${args.qmpMoveY})`);
      await controller.mouseMove(args.qmpMoveX, args.qmpMoveY);
      await sleep(args.qmpMoveWaitMs);
    }

    if (args.captureDir) {
      fs.mkdirSync(args.captureDir, { recursive: true });
      const beforePath = path.join(args.captureDir, 'before.png');
      await controller.captureScreenshot(beforePath);
      console.log(`[probe] captured ${beforePath}`);
    }

    if (args.saveSnapshotName) {
      await controller.saveSnapshot(args.saveSnapshotName);
    }

    const records = await server.waitForCompletion(args.timeoutMs);

    if (args.afterWaitMs > 0) {
      await sleep(args.afterWaitMs);
    }

    let afterCapturePath: string | null = null;
    if (args.captureDir) {
      afterCapturePath = path.join(args.captureDir, 'after.png');
      await controller.captureScreenshot(afterCapturePath);
      console.log(`[probe] captured ${afterCapturePath}`);
    }

    const output = {
      snapshot: args.snapshot,
      issuedCommands: args.commands,
      remainingCommands: server.remainingCommands,
      extraPolls: args.extraPolls,
      captureDir: args.captureDir,
      afterCapturePath,
      records,
      capturedAt: new Date().toISOString(),
    };

    fs.writeFileSync(args.outPath, JSON.stringify(output, null, 2));
    console.log(`[probe] wrote ${records.length} connection records to ${args.outPath}`);

    for (const record of records) {
      console.log(`\n[probe] connection #${record.index}`);
      console.log(`  poll: ${record.poll ?? '<none>'}`);
      console.log(`  cmd: ${record.command ?? 'none'}`);
      if (record.responses.length === 0) {
        console.log('  resp: <none>');
      } else {
        for (const line of record.responses) {
          console.log(`  resp: ${line}`);
        }
      }
    }
  } finally {
    await server.stop();
    await controller.shutdown();
  }
}

function parseArgs(argv: string[]) {
  const commands: string[] = [];
  let snapshot = '';
  let outPath = '';
  let timeoutMs = 45_000;
  let extraPolls = 0;
  let captureDir = '';
  let afterWaitMs = 0;
  let cdromPath = '';
  let qmpMoveX: number | null = null;
  let qmpMoveY: number | null = null;
  let qmpMoveWaitMs = 500;
  const runCommands: string[] = [];
  let runWaitMs = 4000;
  let finalWaitMs = 0;
  let saveSnapshotName = '';
  const sendKeys: string[][] = [];
  let sendKeyWaitMs = 1000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--snapshot') {
      snapshot = argv[++i] ?? '';
    } else if (arg === '--cmd') {
      const cmd = argv[++i] ?? '';
      if (!cmd) throw new Error('--cmd requires a value');
      commands.push(cmd);
    } else if (arg === '--out') {
      outPath = argv[++i] ?? '';
    } else if (arg === '--timeout-ms') {
      timeoutMs = Number(argv[++i] ?? '0');
    } else if (arg === '--extra-polls') {
      extraPolls = Number(argv[++i] ?? '0');
    } else if (arg === '--capture-dir') {
      captureDir = argv[++i] ?? '';
    } else if (arg === '--after-wait-ms') {
      afterWaitMs = Number(argv[++i] ?? '0');
    } else if (arg === '--cdrom') {
      cdromPath = argv[++i] ?? '';
    } else if (arg === '--qmp-move') {
      qmpMoveX = Number(argv[++i] ?? 'NaN');
      qmpMoveY = Number(argv[++i] ?? 'NaN');
      if (Number.isNaN(qmpMoveX) || Number.isNaN(qmpMoveY)) {
        throw new Error('--qmp-move requires X and Y');
      }
    } else if (arg === '--qmp-move-wait-ms') {
      qmpMoveWaitMs = Number(argv[++i] ?? '0');
    } else if (arg === '--run') {
      const command = argv[++i] ?? '';
      if (!command) throw new Error('--run requires a value');
      runCommands.push(command);
    } else if (arg === '--run-wait-ms') {
      runWaitMs = Number(argv[++i] ?? '0');
    } else if (arg === '--final-wait-ms') {
      finalWaitMs = Number(argv[++i] ?? '0');
    } else if (arg === '--save-snapshot') {
      saveSnapshotName = argv[++i] ?? '';
    } else if (arg === '--send-key') {
      const value = argv[++i] ?? '';
      if (!value) throw new Error('--send-key requires a value');
      sendKeys.push(value.split('+'));
    } else if (arg === '--send-key-wait-ms') {
      sendKeyWaitMs = Number(argv[++i] ?? '0');
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (!outPath) {
    const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '').replace('T', '-').replace('Z', '');
    outPath = path.join(DEFAULT_OUT_DIR, `${snapshot || 'snapshot'}-${stamp}.json`);
  }

  return {
    snapshot,
    commands,
    outPath,
    timeoutMs,
    extraPolls,
    captureDir,
    afterWaitMs,
    cdromPath,
    qmpMoveX,
    qmpMoveY,
    qmpMoveWaitMs,
    runCommands,
    runWaitMs,
    finalWaitMs,
    saveSnapshotName,
    sendKeys,
    sendKeyWaitMs,
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openRunDialog(controller: QemuController): Promise<void> {
  await controller.sendKey(['meta_l', 'r']);
  await sleep(1000);
}

async function typeText(controller: QemuController, text: string): Promise<void> {
  for (const char of text) {
    const keys = mapCharToKeys(char);
    await controller.sendKey(keys);
    await sleep(100);
  }
}

function mapCharToKeys(char: string): string[] {
  if (/^[a-z0-9]$/.test(char)) {
    return [char];
  }

  switch (char) {
    case ':':
      return ['shift', 'semicolon'];
    case '\\':
      return ['backslash'];
    case '.':
      return ['dot'];
    case ' ':
      return ['spc'];
    case '-':
      return ['minus'];
    case '_':
      return ['shift', 'minus'];
    case '/':
      return ['slash'];
    default:
      throw new Error(`Unsupported run-dialog character: ${JSON.stringify(char)}`);
  }
}
