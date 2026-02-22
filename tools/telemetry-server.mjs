#!/usr/bin/env node
/**
 * Agent telemetry server — receives game state POSTs and writes to a JSON file.
 * Usage: node tools/telemetry-server.mjs
 * Listens on port 8081, writes to artifacts/agent-telemetry.json
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 8081;
const OUT_DIR = path.resolve('artifacts');
const OUT_FILE = path.join(OUT_DIR, 'agent-telemetry.json');
const LOG_FILE = path.join(OUT_DIR, 'agent-console.log');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

let latest = { ts: 0, status: 'waiting' };
let consoleBuffer = [];
const MAX_CONSOLE_LINES = 500;

const server = http.createServer((req, res) => {
  // CORS headers for localhost cross-origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/telemetry') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        data.receivedAt = new Date().toISOString();
        latest = data;
        fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400);
        res.end('{"error":"bad json"}');
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/console') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { lines } = JSON.parse(body);
        if (Array.isArray(lines)) {
          for (const line of lines) {
            consoleBuffer.push(line);
            if (consoleBuffer.length > MAX_CONSOLE_LINES) consoleBuffer.shift();
          }
          fs.writeFileSync(LOG_FILE, consoleBuffer.join('\n') + '\n');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"bad json"}');
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/telemetry') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latest, null, 2));
    return;
  }

  if (req.method === 'GET' && req.url === '/console') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(consoleBuffer.join('\n'));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`Agent telemetry server on http://localhost:${PORT}`);
  console.log(`  POST /telemetry  — game state updates`);
  console.log(`  POST /console    — console log lines`);
  console.log(`  GET  /telemetry  — latest state`);
  console.log(`  GET  /console    — console buffer`);
  console.log(`  Output: ${OUT_FILE}`);
});
