/**
 * WebSocket signaling server for Emperor: Battle for Dune multiplayer.
 * Handles lobby management and WebRTC SDP/ICE relay.
 *
 * Run: npx tsx server/signaling.ts
 * Default port: 8080 (override with PORT env var)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';

const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB

interface Player {
  id: string;
  name: string;
  ws: WebSocket;
  lobbyId: string | null;
  ready: boolean;
  house: string;
}

interface Lobby {
  id: string;
  name: string;
  hostId: string;
  maxPlayers: number;
  mapId: string;
  players: string[]; // player IDs
}

const players = new Map<string, Player>();
const lobbies = new Map<string, Lobby>();

function genId(): string {
  return randomBytes(12).toString('hex');
}

function sanitize(s: string, maxLen = 32): string {
  return String(s).replace(/[<>&"']/g, '').slice(0, maxLen);
}

function send(ws: WebSocket, data: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendToPlayer(playerId: string, data: any): void {
  const player = players.get(playerId);
  if (player) send(player.ws, data);
}

function getLobbyInfo(lobby: Lobby): any {
  return {
    id: lobby.id,
    name: lobby.name,
    host: lobby.hostId,
    players: lobby.players.map((pid) => {
      const p = players.get(pid);
      return { id: pid, name: p?.name ?? '?', ready: p?.ready ?? false, house: p?.house };
    }),
    maxPlayers: lobby.maxPlayers,
    mapId: lobby.mapId,
  };
}

function broadcastLobbyUpdate(lobby: Lobby): void {
  const info = getLobbyInfo(lobby);
  for (const pid of lobby.players) {
    sendToPlayer(pid, { type: 'lobby:updated', lobby: info });
  }
}

function removePlayerFromLobby(player: Player): void {
  if (!player.lobbyId) return;
  const lobby = lobbies.get(player.lobbyId);
  player.lobbyId = null;
  player.ready = false;
  if (!lobby) return;

  lobby.players = lobby.players.filter((id) => id !== player.id);
  if (lobby.players.length === 0) {
    lobbies.delete(lobby.id);
  } else {
    if (lobby.hostId === player.id) {
      lobby.hostId = lobby.players[0];
    }
    broadcastLobbyUpdate(lobby);
  }
}

/** Check if two player IDs are in the same lobby */
function inSameLobby(id1: string, id2: string): boolean {
  const p1 = players.get(id1);
  const p2 = players.get(id2);
  return !!(p1?.lobbyId && p2?.lobbyId && p1.lobbyId === p2.lobbyId);
}

const VALID_HOUSES = new Set(['AT_', 'HK_', 'OR_']);

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE_SIZE });

wss.on('connection', (ws) => {
  let playerId = '';

  ws.on('message', (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'register': {
        playerId = genId();
        const player: Player = {
          id: playerId,
          name: sanitize(msg.name || 'Player', 24),
          ws,
          lobbyId: null,
          ready: false,
          house: '',
        };
        players.set(playerId, player);
        send(ws, { type: 'registered', id: playerId });
        break;
      }

      case 'lobby:create': {
        const player = players.get(playerId);
        if (!player) break;
        removePlayerFromLobby(player);

        const lobby: Lobby = {
          id: genId(),
          name: sanitize(msg.name || `${player.name}'s Game`, 48),
          hostId: playerId,
          maxPlayers: Math.max(2, Math.min(8, parseInt(msg.maxPlayers) || 4)),
          mapId: sanitize(msg.mapId || '', 64),
          players: [playerId],
        };
        lobbies.set(lobby.id, lobby);
        player.lobbyId = lobby.id;
        player.ready = false;
        send(ws, { type: 'lobby:created', lobby: getLobbyInfo(lobby) });
        break;
      }

      case 'lobby:join': {
        const player = players.get(playerId);
        if (!player) break;
        const lobby = lobbies.get(msg.lobbyId);
        if (!lobby) {
          send(ws, { type: 'error', message: 'Lobby not found' });
          break;
        }
        if (lobby.players.length >= lobby.maxPlayers) {
          send(ws, { type: 'error', message: 'Lobby is full' });
          break;
        }

        removePlayerFromLobby(player);
        lobby.players.push(playerId);
        player.lobbyId = lobby.id;
        player.ready = false;
        send(ws, { type: 'lobby:joined', lobby: getLobbyInfo(lobby) });
        broadcastLobbyUpdate(lobby);
        break;
      }

      case 'lobby:leave': {
        const player = players.get(playerId);
        if (player) removePlayerFromLobby(player);
        break;
      }

      case 'lobby:list': {
        const list = Array.from(lobbies.values()).map(getLobbyInfo);
        send(ws, { type: 'lobby:list', lobbies: list });
        break;
      }

      case 'lobby:ready': {
        const player = players.get(playerId);
        if (!player || !player.lobbyId) break;
        player.ready = !!msg.ready;
        const lobby = lobbies.get(player.lobbyId);
        if (lobby) broadcastLobbyUpdate(lobby);
        break;
      }

      case 'lobby:house': {
        const player = players.get(playerId);
        if (!player || !player.lobbyId) break;
        const house = String(msg.house || '');
        player.house = VALID_HOUSES.has(house) ? house : '';
        const lobby = lobbies.get(player.lobbyId);
        if (lobby) broadcastLobbyUpdate(lobby);
        break;
      }

      case 'game:start': {
        const player = players.get(playerId);
        if (!player || !player.lobbyId) break;
        const lobby = lobbies.get(player.lobbyId);
        if (!lobby || lobby.hostId !== playerId) break;

        // Validate all non-host players are ready
        const allReady = lobby.players.every((pid) => {
          return pid === playerId || players.get(pid)?.ready;
        });
        if (!allReady) {
          send(ws, { type: 'error', message: 'Not all players are ready' });
          break;
        }

        // Generate seed server-side for fairness
        const seed = parseInt(randomBytes(4).toString('hex'), 16);
        for (const pid of lobby.players) {
          sendToPlayer(pid, {
            type: 'game:start',
            settings: { seed, tick: 0 },
          });
        }
        break;
      }

      // WebRTC signaling relay - validate lobby membership
      case 'peer:offer': {
        if (!inSameLobby(playerId, msg.to)) break;
        sendToPlayer(msg.to, { type: 'peer:offer', from: playerId, offer: msg.offer });
        break;
      }
      case 'peer:answer': {
        if (!inSameLobby(playerId, msg.to)) break;
        sendToPlayer(msg.to, { type: 'peer:answer', from: playerId, answer: msg.answer });
        break;
      }
      case 'peer:ice': {
        if (!inSameLobby(playerId, msg.to)) break;
        sendToPlayer(msg.to, { type: 'peer:ice', from: playerId, candidate: msg.candidate });
        break;
      }
    }
  });

  ws.on('close', () => {
    const player = players.get(playerId);
    if (player) {
      removePlayerFromLobby(player);
      players.delete(playerId);
    }
  });
});

console.log(`Emperor: Battle for Dune signaling server listening on port ${PORT}`);
