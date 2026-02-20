/**
 * Multiplayer lobby UI for creating/joining games.
 */

import { SessionManager, type SessionState } from '../net/SessionManager';
import type { LobbyInfo } from '../net/SignalingClient';
import type { PeerMessage } from '../net/PeerConnection';

export interface LobbyCallbacks {
  onGameStart: (seed: number, playerSlot: number, totalPlayers: number) => void;
  onCancel: () => void;
}

const HOUSES = [
  { prefix: 'AT_', name: 'Atreides', color: '#4488ff' },
  { prefix: 'HK_', name: 'Harkonnen', color: '#ff4444' },
  { prefix: 'OR_', name: 'Ordos', color: '#44cc44' },
];

/** Escape HTML entities to prevent XSS */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export class LobbyScreen {
  private container: HTMLDivElement;
  private session: SessionManager;
  private callbacks: LobbyCallbacks;
  private currentLobby: LobbyInfo | null = null;
  private lobbyListData: LobbyInfo[] = [];
  private selectedHouse = 'AT_';
  private view: 'browser' | 'lobby' = 'browser';

  constructor(callbacks: LobbyCallbacks) {
    this.callbacks = callbacks;
    this.container = document.createElement('div');
    this.container.id = 'lobby-screen';
    this.container.style.cssText = `
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(0,0,0,0.95); color: #ccc;
      font-family: 'Trebuchet MS', sans-serif;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
    `;

    this.session = new SessionManager({
      onStateChanged: (state) => this.onStateChanged(state),
      onLobbyUpdated: (lobby) => {
        this.currentLobby = lobby;
        this.view = 'lobby';
        this.render();
      },
      onLobbyList: (lobbies) => {
        this.lobbyListData = lobbies;
        this.render();
      },
      onGameMessage: (peerId, data) => this.onGameMessage(peerId, data),
      onAllPeersConnected: (seed) => {
        if (this.currentLobby) {
          const myId = this.session.getPlayerId();
          const playerSlot = this.currentLobby.players.findIndex((p) => p.id === myId);
          this.callbacks.onGameStart(seed, Math.max(0, playerSlot), this.currentLobby.players.length);
          this.hide();
        }
      },
      onPeerDisconnected: (_peerId) => {
        // TODO: handle mid-game disconnect
      },
      onError: (message) => {
        this.showError(message);
      },
    });
  }

  show(serverUrl?: string): void {
    document.body.appendChild(this.container);
    this.view = 'browser';
    this.render();

    if (serverUrl) {
      const name = `Player${Math.floor(Math.random() * 9999)}`;
      this.session.connect(serverUrl, name);
    }
  }

  hide(): void {
    this.container.remove();
  }

  private render(): void {
    if (this.view === 'browser') {
      this.renderBrowser();
    } else {
      this.renderLobby();
    }
  }

  private renderBrowser(): void {
    this.container.innerHTML = `
      <div style="width: 600px; max-height: 80vh; overflow: auto;">
        <h1 style="color: #d4a843; text-align: center; margin-bottom: 20px;">MULTIPLAYER</h1>
        <div style="display: flex; gap: 10px; margin-bottom: 20px;">
          <button id="lobby-create" style="${btnStyle}">Create Game</button>
          <button id="lobby-refresh" style="${btnStyle}">Refresh</button>
          <button id="lobby-back" style="${btnStyle}">Back</button>
        </div>
        <div id="lobby-list" style="background: rgba(0,0,0,0.5); border: 1px solid #555; border-radius: 4px; min-height: 200px; padding: 10px;">
          ${this.lobbyListData.length === 0
            ? '<p style="text-align: center; color: #666;">No games found. Create one!</p>'
            : this.lobbyListData.map((l) => `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; border-bottom: 1px solid #333; cursor: pointer;">
                <span style="color: #d4a843;">${esc(l.name)}</span>
                <span style="color: #888;">${l.players.length}/${l.maxPlayers}</span>
                <button style="${btnSmall}" data-join="${esc(l.id)}">Join</button>
              </div>
            `).join('')
          }
        </div>
      </div>
    `;

    this.container.querySelector('#lobby-create')?.addEventListener('click', () => {
      const name = prompt('Game name:');
      if (name) this.session.createLobby(name, 4);
    });
    this.container.querySelector('#lobby-refresh')?.addEventListener('click', () => {
      this.session.listLobbies();
    });
    this.container.querySelector('#lobby-back')?.addEventListener('click', () => {
      this.session.disconnect();
      this.callbacks.onCancel();
      this.hide();
    });
    this.container.querySelectorAll('[data-join]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lobbyId = (btn as HTMLElement).dataset.join!;
        this.session.joinLobby(lobbyId);
      });
    });
  }

  private renderLobby(): void {
    const lobby = this.currentLobby;
    if (!lobby) return;
    const myId = this.session.getPlayerId();
    const isHost = lobby.host === myId;

    this.container.innerHTML = `
      <div style="width: 500px;">
        <h2 style="color: #d4a843; text-align: center;">${esc(lobby.name)}</h2>
        <div style="background: rgba(0,0,0,0.5); border: 1px solid #555; border-radius: 4px; padding: 15px; margin: 15px 0;">
          ${lobby.players.map((p) => {
            const houseInfo = HOUSES.find((h) => h.prefix === p.house);
            return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #333;">
              <span>${esc(p.name)} ${p.id === lobby.host ? '(Host)' : ''}</span>
              <span style="color: ${houseInfo?.color ?? '#888'};">
                ${houseInfo?.name ?? 'No house'}
              </span>
              <span style="color: ${p.ready ? '#4c4' : '#c44'};">${p.ready ? 'Ready' : 'Not Ready'}</span>
            </div>
          `;
          }).join('')}
        </div>
        <div style="display: flex; gap: 8px; margin-bottom: 15px;">
          ${HOUSES.map((h) => `
            <button data-house="${h.prefix}" style="${btnStyle} ${this.selectedHouse === h.prefix ? 'border: 2px solid ' + h.color : ''}">${h.name}</button>
          `).join('')}
        </div>
        <div style="display: flex; gap: 10px; justify-content: center;">
          <button id="lobby-ready" style="${btnStyle}">Toggle Ready</button>
          ${isHost ? `<button id="lobby-start" style="${btnStyle} background: #2a5a2a;">Start Game</button>` : ''}
          <button id="lobby-leave" style="${btnStyle}">Leave</button>
        </div>
      </div>
    `;

    this.container.querySelectorAll('[data-house]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedHouse = (btn as HTMLElement).dataset.house!;
        this.session.setHouse(this.selectedHouse);
        this.render();
      });
    });

    this.container.querySelector('#lobby-ready')?.addEventListener('click', () => {
      const me = lobby.players.find((p) => p.id === myId);
      this.session.setReady(!(me?.ready ?? false));
    });

    this.container.querySelector('#lobby-start')?.addEventListener('click', () => {
      this.session.startGame();
    });

    this.container.querySelector('#lobby-leave')?.addEventListener('click', () => {
      this.session.leaveLobby();
      this.view = 'browser';
      this.render();
    });
  }

  private onStateChanged(state: SessionState): void {
    if (state === 'disconnected' && this.view === 'lobby') {
      this.view = 'browser';
      this.currentLobby = null;
      this.render();
    }
  }

  private onGameMessage(_peerId: string, _data: PeerMessage): void {
    // Handle in-game messages (delegated to LockstepManager)
  }

  private showError(message: string): void {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      background: #600; color: #fff; padding: 10px 20px; border-radius: 4px;
      z-index: 9999; font-size: 14px;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  getSession(): SessionManager {
    return this.session;
  }
}

const btnStyle = `
  padding: 8px 16px; background: #333; color: #ccc; border: 1px solid #555;
  border-radius: 4px; cursor: pointer; font-size: 14px;
  font-family: 'Trebuchet MS', sans-serif;
`;

const btnSmall = `
  padding: 4px 10px; background: #2a3a2a; color: #8c8; border: 1px solid #4a4;
  border-radius: 3px; cursor: pointer; font-size: 12px;
`;
