/**
 * WebRTC peer-to-peer data channel manager.
 * Handles reliable ordered data channel for lockstep game commands.
 */

export interface PeerMessage {
  type: string;
  [key: string]: unknown;
}

export type PeerEventHandler = (peerId: string, data: PeerMessage) => void;
export type PeerStatusHandler = (peerId: string, status: 'connected' | 'disconnected' | 'failed') => void;

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export class PeerConnection {
  private connection: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private onMessage: PeerEventHandler;
  private onStatus: PeerStatusHandler;
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private connected = false;
  readonly peerId: string;
  readonly isInitiator: boolean;

  constructor(
    peerId: string,
    isInitiator: boolean,
    onMessage: PeerEventHandler,
    onStatus: PeerStatusHandler,
    private onIceCandidate: (peerId: string, candidate: RTCIceCandidateInit) => void,
  ) {
    this.peerId = peerId;
    this.isInitiator = isInitiator;
    this.onMessage = onMessage;
    this.onStatus = onStatus;

    this.connection = new RTCPeerConnection(RTC_CONFIG);

    this.connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.onIceCandidate(peerId, event.candidate.toJSON());
      }
    };

    this.connection.onconnectionstatechange = () => {
      const state = this.connection.connectionState;
      if (state === 'disconnected' || state === 'closed') {
        this.connected = false;
        this.onStatus(peerId, 'disconnected');
      } else if (state === 'failed') {
        this.connected = false;
        this.onStatus(peerId, 'failed');
      }
    };

    if (isInitiator) {
      this.dataChannel = this.connection.createDataChannel('game', {
        ordered: true,
      });
      this.setupDataChannel(this.dataChannel);
    } else {
      this.connection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel(this.dataChannel);
      };
    }
  }

  private setupDataChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      if (!this.connected) {
        this.connected = true;
        this.onStatus(this.peerId, 'connected');
      }
    };

    channel.onclose = () => {
      this.connected = false;
      this.onStatus(this.peerId, 'disconnected');
    };

    channel.onmessage = (event) => {
      if (typeof event.data !== 'string' || event.data.length > 65536) return;
      try {
        const data = JSON.parse(event.data) as PeerMessage;
        this.onMessage(this.peerId, data);
      } catch {
        // Ignore malformed messages
      }
    };
  }

  /** Create an SDP offer (initiator only) */
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    const offer = await this.connection.createOffer();
    await this.connection.setLocalDescription(offer);
    return offer;
  }

  /** Create an SDP answer (non-initiator) */
  async createAnswer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.connection.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionSet = true;
    await this.flushPendingCandidates();
    const answer = await this.connection.createAnswer();
    await this.connection.setLocalDescription(answer);
    return answer;
  }

  /** Set the remote SDP answer (initiator) */
  async setAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.connection.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionSet = true;
    await this.flushPendingCandidates();
  }

  /** Add an ICE candidate from the remote peer. Buffers if remote description not set yet. */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.connection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private async flushPendingCandidates(): Promise<void> {
    for (const c of this.pendingCandidates) {
      await this.connection.addIceCandidate(new RTCIceCandidate(c));
    }
    this.pendingCandidates = [];
  }

  /** Send a message to this peer */
  send(data: PeerMessage): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') return false;
    this.dataChannel.send(JSON.stringify(data));
    return true;
  }

  /** Check if the data channel is open */
  isConnected(): boolean {
    return this.connected && this.dataChannel?.readyState === 'open';
  }

  /** Close the connection */
  close(): void {
    this.connected = false;
    this.dataChannel?.close();
    this.connection.close();
  }
}
