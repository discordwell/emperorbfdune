#!/usr/bin/env npx tsx
/**
 * wine-nav-test.ts — Test TCP-based navigation through Emperor's menus.
 *
 * Connects to the DInput hook's TCP interface and issues commands to navigate:
 *   Title screen → Skip video → Single Player → House Select → Campaign Map
 *
 * Usage:
 *   npx tsx tools/visual-oracle/wine-nav-test.ts
 */

import net from 'node:net';

const PORT = 18890;
const HOST = '0.0.0.0';

interface PollState {
  raw: string;
  state: number;
  gds: number;
  gdd: number;
  gas: number;
  hwnd: boolean;
  pk: number;
  pb: number;
  se: number;  // screenEntryPending
  mc: number;  // menuClick count
  so: number;  // screenOpen trace stage
  rc: number;  // reset count
  gc: number;  // game click count
}

function parsePoll(line: string): PollState | null {
  if (!line.startsWith('poll ')) return null;
  const get = (key: string): number => {
    const re = new RegExp(`${key}=(-?[\\d.]+)`);
    const m = line.match(re);
    return m ? parseFloat(m[1]) : 0;
  };
  return {
    raw: line,
    state: get('state'),
    gds: get('gds'),
    gdd: get('gdd'),
    gas: get('gas'),
    hwnd: get('hwnd') === 1,
    pk: get('pk'),
    pb: get('pb'),
    se: get('se'),
    mc: get('mc'),
    so: get('so'),
    rc: get('rc'),
    gc: get('gc'),
  };
}

// Command queue with response tracking
type QueueEntry = {
  command: string;
  resolve: (response: string) => void;
  timeout: ReturnType<typeof setTimeout>;
};

class HookClient {
  private server: net.Server;
  private queue: QueueEntry[] = [];
  private pollCount = 0;
  private lastPoll: PollState | null = null;

  constructor(private port: number) {
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.port, HOST, () => {
        console.log(`[nav] TCP server listening on ${HOST}:${this.port}`);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket) {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;

        if (trimmed.startsWith('poll ')) {
          this.pollCount++;
          this.lastPoll = parsePoll(trimmed);

          if (this.pollCount <= 3 || this.pollCount % 10 === 0) {
            console.log(`[poll#${this.pollCount}] state=${this.lastPoll?.state} gdd=${this.lastPoll?.gdd} gas=${this.lastPoll?.gas} pk=${this.lastPoll?.pk}`);
          }

          // Send next command or "none"
          if (this.queue.length > 0) {
            const entry = this.queue.shift()!;
            console.log(`[nav] >>> ${entry.command}`);
            socket.write(`${entry.command}\n`);
          } else {
            socket.write('none\n');
          }
        } else if (trimmed.startsWith('RESP:') || trimmed.startsWith('MEM:') ||
                   trimmed.startsWith('poked') || trimmed.startsWith('pokevp')) {
          console.log(`[resp] ${trimmed}`);
          // Resolve the pending command
          if (this.queue.length > 0 && this.queue[0]) {
            // Response came back before next poll — might be inline
          }
        } else {
          console.log(`[hook] ${trimmed}`);
        }
      }
    });

    socket.on('close', () => {});
    socket.on('error', () => {});
  }

  /** Send a command and wait for it to be picked up by the next poll. */
  send(command: string): Promise<string> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log(`[nav] TIMEOUT waiting for: ${command}`);
        resolve('TIMEOUT');
      }, 30000);
      this.queue.push({ command, resolve, timeout });
    });
  }

  /** Wait for N poll cycles. */
  async waitPolls(n: number): Promise<void> {
    const target = this.pollCount + n;
    while (this.pollCount < target) {
      await sleep(500);
    }
  }

  /** Get current poll state. */
  get state(): PollState | null { return this.lastPoll; }
  get polls(): number { return this.pollCount; }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const client = new HookClient(PORT);
  await client.start();

  console.log('[nav] Waiting for first hook connection...');
  while (client.polls === 0) {
    await sleep(1000);
  }
  console.log('[nav] Hook connected! Current state:', client.state?.raw?.substring(0, 100));

  // Step 1: Check current screen state
  console.log('\n=== Step 1: Read screen state ===');
  await client.send('screenstate');
  await client.waitPolls(2);

  // Step 2: Read screen entries to understand what menu items are available
  console.log('\n=== Step 2: Read screen entries ===');
  await client.send('screenentries');
  await client.waitPolls(2);

  // Step 3: Check GetAsyncKeyState diagnostics
  console.log('\n=== Step 3: GAS diagnostics ===');
  await client.send('gaslog');
  await client.waitPolls(2);

  // Step 4: Try to skip the video by sending Escape key via DInput
  console.log('\n=== Step 4: Send Escape key to skip video ===');
  await client.send('key 1');  // DIK_ESCAPE = 1
  await sleep(2000);
  await client.waitPolls(2);

  // Step 5: Check screen state again after Escape
  console.log('\n=== Step 5: Screen state after Escape ===');
  await client.send('screenstate');
  await client.waitPolls(2);
  await client.send('screenentries');
  await client.waitPolls(2);

  // Step 6: Try wmkey Escape (in case DInput key doesn't work for video)
  console.log('\n=== Step 6: Send wmkey Escape (VK_ESCAPE=27) ===');
  await client.send('wmkey 27');
  await sleep(2000);
  await client.waitPolls(2);

  // Step 7: Check state after wmkey
  console.log('\n=== Step 7: Screen state after wmkey ===');
  await client.send('screenstate');
  await client.waitPolls(2);

  // Step 8: Try the timernav approach to go directly to Campaign
  // First, try clicking "Single Player" on the title screen
  console.log('\n=== Step 8: Try click on Single Player button ===');
  // Title screen: "SINGLE PLAYER" button is approximately at game y=385
  // But first, let's try the screenentry approach
  await client.send('screenentries');
  await client.waitPolls(3);

  // Step 9: Try navigating with timernav
  console.log('\n=== Step 9: Try timernav to navigate ===');
  // First, see what named screens are available
  await client.send('readmem 5FDB70');  // CAMPAIGN_ADDR
  await client.waitPolls(2);

  // Let's try a moveclick at the Single Player button
  console.log('\n=== Step 10: moveclick at Single Player ===');
  await client.send('moveclick 400 385');
  await sleep(3000);
  await client.waitPolls(3);

  // Check screen state
  await client.send('screenstate');
  await client.waitPolls(2);
  await client.send('screenentries');
  await client.waitPolls(3);

  // Step 11: Try forceclick
  console.log('\n=== Step 11: forceclick at Single Player ===');
  await client.send('forceclick 400 385 300');
  await sleep(5000);
  await client.waitPolls(3);
  await client.send('screenstate');
  await client.waitPolls(2);

  // Keep running for a bit to observe
  console.log('\n=== Observation period (30s) ===');
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    console.log(`[${(i+1)*5}s] polls=${client.polls} state=${client.state?.state} gdd=${client.state?.gdd} gas=${client.state?.gas}`);
  }

  console.log('\n[nav] Test complete. Shutting down...');
  await client.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
