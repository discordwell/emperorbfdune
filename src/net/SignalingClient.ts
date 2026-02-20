/**
 * WebSocket signaling client for WebRTC connection establishment.
 * Handles lobby creation/joining, peer discovery, and SDP/ICE relay.
 */

export interface LobbyInfo {
  id: string;
  name: string;
  host: string;
  players: Array<{ id: string; name: string; ready: boolean; house?: string }>;
  maxPlayers: number;
  mapId?: string;
  gameMode?: string;
}

export interface SignalingEvents {
  onRegistered: (playerId: string) => void;
  onLobbyCreated: (lobby: LobbyInfo) => void;
  onLobbyJoined: (lobby: LobbyInfo) => void;
  onLobbyUpdated: (lobby: LobbyInfo) => void;
  onLobbyList: (lobbies: LobbyInfo[]) => void;
  onPeerOffer: (peerId: string, offer: RTCSessionDescriptionInit) => void;
  onPeerAnswer: (peerId: string, answer: RTCSessionDescriptionInit) => void;
  onPeerIce: (peerId: string, candidate: RTCIceCandidateInit) => void;
  onGameStart: (settings: { seed: number; tick: number }) => void;
  onError: (message: string) => void;
  onDisconnected: () => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private events: SignalingEvents;
  private playerId = '';
  private playerName = '';
  private serverUrl = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(events: SignalingEvents) {
    this.events = events;
  }

  /** Connect to signaling server */
  connect(serverUrl: string, playerName: string): void {
    this.playerName = playerName;
    this.serverUrl = serverUrl;
    this.ws = new WebSocket(serverUrl);

    this.ws.onopen = () => {
      this.send({ type: 'register', name: playerName });
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.events.onDisconnected();
      // Auto-reconnect only if not intentionally disconnected
      if (this.playerName) {
        this.reconnectTimer = setTimeout(() => {
          if (this.playerName) this.connect(this.serverUrl, this.playerName);
        }, 3000);
      }
    };

    this.ws.onerror = () => {
      this.events.onError('Connection to signaling server failed');
    };
  }

  /** Disconnect from signaling server */
  disconnect(): void {
    // Clear name first to prevent reconnect
    this.playerName = '';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'registered':
        this.playerId = msg.id;
        this.events.onRegistered(msg.id);
        break;
      case 'lobby:created':
        this.events.onLobbyCreated(msg.lobby);
        break;
      case 'lobby:joined':
        this.events.onLobbyJoined(msg.lobby);
        break;
      case 'lobby:updated':
        this.events.onLobbyUpdated(msg.lobby);
        break;
      case 'lobby:list':
        this.events.onLobbyList(msg.lobbies);
        break;
      case 'peer:offer':
        this.events.onPeerOffer(msg.from, msg.offer);
        break;
      case 'peer:answer':
        this.events.onPeerAnswer(msg.from, msg.answer);
        break;
      case 'peer:ice':
        this.events.onPeerIce(msg.from, msg.candidate);
        break;
      case 'game:start':
        this.events.onGameStart(msg.settings);
        break;
      case 'error':
        this.events.onError(msg.message);
        break;
    }
  }

  private send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // --- Lobby operations ---

  createLobby(name: string, maxPlayers: number, mapId?: string): void {
    this.send({ type: 'lobby:create', name, maxPlayers, mapId });
  }

  joinLobby(lobbyId: string): void {
    this.send({ type: 'lobby:join', lobbyId });
  }

  leaveLobby(): void {
    this.send({ type: 'lobby:leave' });
  }

  listLobbies(): void {
    this.send({ type: 'lobby:list' });
  }

  setReady(ready: boolean): void {
    this.send({ type: 'lobby:ready', ready });
  }

  setHouse(house: string): void {
    this.send({ type: 'lobby:house', house });
  }

  /** Host starts the game */
  startGame(): void {
    this.send({ type: 'game:start' });
  }

  // --- WebRTC signaling relay ---

  sendOffer(peerId: string, offer: RTCSessionDescriptionInit): void {
    this.send({ type: 'peer:offer', to: peerId, offer });
  }

  sendAnswer(peerId: string, answer: RTCSessionDescriptionInit): void {
    this.send({ type: 'peer:answer', to: peerId, answer });
  }

  sendIceCandidate(peerId: string, candidate: RTCIceCandidateInit): void {
    this.send({ type: 'peer:ice', to: peerId, candidate });
  }

  // --- Getters ---

  getPlayerId(): string {
    return this.playerId;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
