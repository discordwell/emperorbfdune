/**
 * TCP command server for DInput hook injection.
 *
 * The DInput hook inside the game polls 10.0.2.2:18890 every 2 seconds.
 * It sends "poll\n" and expects one of:
 *   - "click X Y\n" — inject a click at game coordinates (X, Y)
 *   - "key SCANCODE\n" — inject a key press
 *   - "none\n" — no pending command
 *
 * This server queues commands and serves them one at a time.
 *
 * Usage as module:
 *   import { TcpCommandServer } from './tcp-cmd-server.js';
 *   const server = new TcpCommandServer(18890);
 *   await server.start();
 *   await server.click(400, 385);  // queues a click, resolves when hook picks it up
 *   await server.stop();
 *
 * Usage as CLI:
 *   npx tsx tcp-cmd-server.ts
 *   Then type commands: "click 400 385", "key 28" (Enter = scancode 0x1C = 28)
 */

import * as net from 'node:net';
import * as readline from 'node:readline';

interface PendingCommand {
  command: string;
  resolve: () => void;
}

export class TcpCommandServer {
  private server: net.Server | null = null;
  private queue: PendingCommand[] = [];
  private port: number;

  constructor(port = 18890) {
    this.port = port;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        let buffer = '';
        socket.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === 'poll') {
              if (this.queue.length > 0) {
                const cmd = this.queue.shift()!;
                socket.write(cmd.command + '\n');
                console.log(`[TCP] Served: ${cmd.command}`);
                cmd.resolve();
              } else {
                socket.write('none\n');
              }
            }
          }
        });

        socket.on('error', () => { /* ignore client disconnect errors */ });
      });

      this.server.on('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[TCP] Command server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /** Queue a click command. Resolves when the hook picks it up. */
  click(x: number, y: number): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ command: `click ${x} ${y}`, resolve });
      console.log(`[TCP] Queued: click ${x} ${y} (queue depth: ${this.queue.length})`);
    });
  }

  /** Queue a key command. */
  key(scancode: number): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ command: `key ${scancode}`, resolve });
      console.log(`[TCP] Queued: key ${scancode} (queue depth: ${this.queue.length})`);
    });
  }

  /** Queue a raw command string. */
  raw(cmd: string): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ command: cmd, resolve });
    });
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
        this.server = null;
      });
    }
  }
}

// CLI mode
if (process.argv[1]?.endsWith('tcp-cmd-server.ts') || process.argv[1]?.endsWith('tcp-cmd-server.js')) {
  const server = new TcpCommandServer(18890);
  await server.start();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('cmd> ');
  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    const parts = trimmed.split(/\s+/);
    if (parts[0] === 'click' && parts.length === 3) {
      const x = parseInt(parts[1]);
      const y = parseInt(parts[2]);
      console.log(`Queuing click at (${x}, ${y})...`);
      server.click(x, y).then(() => {
        console.log(`Click at (${x}, ${y}) picked up by hook`);
        rl.prompt();
      });
    } else if (parts[0] === 'key' && parts.length === 2) {
      const sc = parseInt(parts[1]);
      server.key(sc).then(() => {
        console.log(`Key ${sc} picked up by hook`);
        rl.prompt();
      });
    } else if (parts[0] === 'quit' || parts[0] === 'exit') {
      await server.stop();
      process.exit(0);
    } else {
      console.log('Commands: click X Y, key SCANCODE, quit');
    }
    rl.prompt();
  });
}
