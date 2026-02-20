/**
 * Manages the overall multiplayer session lifecycle.
 * Coordinates signaling, peer connections, and game state.
 */

import { PeerConnection, type PeerMessage } from './PeerConnection';
import { SignalingClient, type LobbyInfo, type SignalingEvents } from './SignalingClient';

export type SessionState = 'disconnected' | 'lobby' | 'connecting' | 'playing';

export interface SessionEvents {
  onStateChanged: (state: SessionState) => void;
  onLobbyUpdated: (lobby: LobbyInfo) => void;
  onLobbyList: (lobbies: LobbyInfo[]) => void;
  onGameMessage: (peerId: string, data: PeerMessage) => void;
  onAllPeersConnected: (seed: number) => void;
  onPeerDisconnected: (peerId: string) => void;
  onError: (message: string) => void;
}

const CONNECTION_TIMEOUT = 15000; // 15 seconds to connect all peers

export class SessionManager {
  private signaling: SignalingClient;
  private peers = new Map<string, PeerConnection>();
  private events: SessionEvents;
  private state: SessionState = 'disconnected';
  private currentLobby: LobbyInfo | null = null;
  private localPlayerId = '';
  private gameSeed = 0;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  // Buffer ICE candidates for peers not yet created
  private pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();

  constructor(events: SessionEvents) {
    this.events = events;

    const sigEvents: SignalingEvents = {
      onRegistered: (playerId) => {
        this.localPlayerId = playerId;
      },
      onLobbyCreated: (lobby) => {
        this.currentLobby = lobby;
        this.setState('lobby');
        events.onLobbyUpdated(lobby);
      },
      onLobbyJoined: (lobby) => {
        this.currentLobby = lobby;
        this.setState('lobby');
        events.onLobbyUpdated(lobby);
      },
      onLobbyUpdated: (lobby) => {
        this.currentLobby = lobby;
        events.onLobbyUpdated(lobby);
      },
      onLobbyList: (lobbies) => {
        events.onLobbyList(lobbies);
      },
      onPeerOffer: async (peerId, offer) => {
        try {
          const peer = this.getOrCreatePeer(peerId, false);
          const answer = await peer.createAnswer(offer);
          this.signaling.sendAnswer(peerId, answer);
        } catch (err) {
          events.onError(`Failed to handle offer from ${peerId}`);
        }
      },
      onPeerAnswer: async (peerId, answer) => {
        try {
          const peer = this.peers.get(peerId);
          if (peer) await peer.setAnswer(answer);
        } catch (err) {
          events.onError(`Failed to handle answer from ${peerId}`);
        }
      },
      onPeerIce: async (peerId, candidate) => {
        try {
          const peer = this.peers.get(peerId);
          if (peer) {
            await peer.addIceCandidate(candidate);
          } else {
            // Buffer for when peer is created
            let buf = this.pendingIceCandidates.get(peerId);
            if (!buf) {
              buf = [];
              this.pendingIceCandidates.set(peerId, buf);
            }
            buf.push(candidate);
          }
        } catch (err) {
          // ICE candidate failures are non-fatal
        }
      },
      onGameStart: (settings) => {
        this.gameSeed = settings.seed;
        this.initiatePeerConnections();
      },
      onError: (message) => {
        events.onError(message);
      },
      onDisconnected: () => {
        if (this.state !== 'playing') {
          this.setState('disconnected');
        }
      },
    };

    this.signaling = new SignalingClient(sigEvents);
  }

  /** Connect to signaling server and enter lobby browser */
  connect(serverUrl: string, playerName: string): void {
    this.signaling.connect(serverUrl, playerName);
  }

  /** Disconnect from everything */
  disconnect(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    for (const peer of this.peers.values()) {
      peer.close();
    }
    this.peers.clear();
    this.pendingIceCandidates.clear();
    this.signaling.disconnect();
    this.currentLobby = null;
    this.setState('disconnected');
  }

  createLobby(name: string, maxPlayers: number, mapId?: string): void {
    this.signaling.createLobby(name, maxPlayers, mapId);
  }

  joinLobby(lobbyId: string): void {
    this.signaling.joinLobby(lobbyId);
  }

  leaveLobby(): void {
    this.signaling.leaveLobby();
    this.currentLobby = null;
    this.setState('disconnected');
  }

  listLobbies(): void {
    this.signaling.listLobbies();
  }

  setReady(ready: boolean): void {
    this.signaling.setReady(ready);
  }

  setHouse(house: string): void {
    this.signaling.setHouse(house);
  }

  /** Host starts the game (seed generated server-side) */
  startGame(): void {
    this.signaling.startGame();
  }

  broadcast(data: PeerMessage): void {
    for (const peer of this.peers.values()) {
      peer.send(data);
    }
  }

  sendTo(peerId: string, data: PeerMessage): boolean {
    const peer = this.peers.get(peerId);
    return peer?.send(data) ?? false;
  }

  getState(): SessionState {
    return this.state;
  }

  getLobby(): LobbyInfo | null {
    return this.currentLobby;
  }

  getPlayerId(): string {
    return this.localPlayerId;
  }

  getConnectedPeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.isConnected()) count++;
    }
    return count;
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.events.onStateChanged(state);
  }

  private getOrCreatePeer(peerId: string, isInitiator: boolean): PeerConnection {
    let peer = this.peers.get(peerId);
    if (peer && peer.isConnected()) return peer;
    // Close stale peer if exists
    if (peer) peer.close();

    peer = new PeerConnection(
      peerId,
      isInitiator,
      (id, data) => this.events.onGameMessage(id, data),
      (id, status) => {
        if (status === 'connected') {
          this.checkAllConnected();
        } else if (status === 'disconnected' || status === 'failed') {
          this.events.onPeerDisconnected(id);
        }
      },
      (id, candidate) => {
        this.signaling.sendIceCandidate(id, candidate);
      },
    );
    this.peers.set(peerId, peer);

    // Flush any buffered ICE candidates for this peer
    const buffered = this.pendingIceCandidates.get(peerId);
    if (buffered) {
      for (const c of buffered) {
        peer.addIceCandidate(c).catch(() => {});
      }
      this.pendingIceCandidates.delete(peerId);
    }

    return peer;
  }

  private async initiatePeerConnections(): Promise<void> {
    if (!this.currentLobby) return;
    this.setState('connecting');

    // Set connection timeout
    this.connectTimeout = setTimeout(() => {
      if (this.state === 'connecting') {
        this.events.onError('Connection timeout - could not reach all peers');
        this.setState('lobby');
      }
    }, CONNECTION_TIMEOUT);

    // Create offers in parallel
    const offerPromises = this.currentLobby.players
      .filter((p) => p.id !== this.localPlayerId && p.id > this.localPlayerId)
      .map(async (player) => {
        try {
          const peer = this.getOrCreatePeer(player.id, true);
          const offer = await peer.createOffer();
          this.signaling.sendOffer(player.id, offer);
        } catch (err) {
          this.events.onError(`Failed to create offer for ${player.name}`);
        }
      });

    await Promise.all(offerPromises);
  }

  private checkAllConnected(): void {
    if (!this.currentLobby) return;
    const expectedPeers = this.currentLobby.players.length - 1;
    if (this.getConnectedPeerCount() >= expectedPeers) {
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      this.setState('playing');
      this.events.onAllPeersConnected(this.gameSeed);
    }
  }
}
