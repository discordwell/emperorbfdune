#!/usr/bin/env npx tsx
/**
 * wine-probe.ts — Simple TCP probe server for Wine-hosted Emperor.
 * Starts a TCP server on port 18890, waits for the hook to connect,
 * and issues commands from the command line.
 *
 * Usage:
 *   npx tsx wine-probe.ts "screenentry Campaign" "menupump 3"
 *
 * The hook connects every ~2s, sends poll state, expects a command.
 * We feed commands in order, then "none" for remaining polls.
 */

import net from 'node:net';

const commands = process.argv.slice(2);
if (commands.length === 0) {
  commands.push('none');
}

const queue = [...commands];
let connectionIndex = 0;

const server = net.createServer((socket) => {
  const connIdx = connectionIndex++;
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;

      if (trimmed.startsWith('poll ')) {
        console.log(`[${connIdx}] ${trimmed}`);
        const cmd = queue.length > 0 ? queue.shift()! : 'none';
        console.log(`[${connIdx}] >>> ${cmd}`);
        socket.write(`${cmd}\n`);
      } else {
        console.log(`[${connIdx}] resp: ${trimmed}`);
      }
    }
  });

  socket.on('close', () => {
    console.log(`[${connIdx}] disconnected`);
  });

  socket.on('error', () => {});
});

server.listen(18890, '0.0.0.0', () => {
  console.log('[server] Listening on port 18890');
  console.log(`[server] Commands queued: ${commands.join(', ')}`);
  console.log('[server] Waiting for hook connections...');
});
