import { Owner, Health, buildingQuery, type World } from '../core/ECS';
import type { AudioManager } from '../audio/AudioManager';

export type GameOutcome = 'playing' | 'victory' | 'defeat';

export class VictorySystem {
  private audioManager: AudioManager;
  private localPlayerId = 0;
  private outcome: GameOutcome = 'playing';
  private overlay: HTMLDivElement | null = null;
  private checkInterval = 50; // Check every 50 ticks (~2 seconds)
  private tickCounter = 0;
  private onRestart: (() => void) | null = null;
  private graceperiodTicks = 250; // 10 seconds before checking (let game load)

  constructor(audioManager: AudioManager, localPlayerId: number, onRestart?: () => void) {
    this.audioManager = audioManager;
    this.localPlayerId = localPlayerId;
    this.onRestart = onRestart ?? null;
  }

  getOutcome(): GameOutcome {
    return this.outcome;
  }

  update(world: World): void {
    if (this.outcome !== 'playing') return;

    this.tickCounter++;
    if (this.tickCounter < this.graceperiodTicks) return;
    if (this.tickCounter % this.checkInterval !== 0) return;

    const buildings = buildingQuery(world);
    let playerHasBuildings = false;
    let enemyHasBuildings = false;

    for (const eid of buildings) {
      if (Health.current[eid] <= 0) continue;
      if (Owner.playerId[eid] === this.localPlayerId) {
        playerHasBuildings = true;
      } else {
        enemyHasBuildings = true;
      }
      if (playerHasBuildings && enemyHasBuildings) return; // Both alive, keep playing
    }

    if (!playerHasBuildings && this.tickCounter > this.graceperiodTicks) {
      this.triggerDefeat();
    } else if (!enemyHasBuildings && this.tickCounter > this.graceperiodTicks) {
      this.triggerVictory();
    }
  }

  private triggerVictory(): void {
    this.outcome = 'victory';
    this.audioManager.playSfx('victory');
    this.audioManager.playVictoryMusic();
    this.showScreen('VICTORY', 'You have conquered the enemy!', '#00ff44');
  }

  private triggerDefeat(): void {
    this.outcome = 'defeat';
    this.audioManager.playSfx('defeat');
    this.showScreen('DEFEAT', 'Your base has been destroyed.', '#ff2222');
  }

  private showScreen(title: string, message: string, color: string): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.85);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 1000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      animation: fadeIn 1s ease;
    `;

    this.overlay.innerHTML = `
      <div style="color:${color}; font-size:64px; font-weight:bold; text-shadow: 0 0 30px ${color}40; margin-bottom:16px;">
        ${title}
      </div>
      <div style="color:#ccc; font-size:20px; margin-bottom:40px;">
        ${message}
      </div>
      <button id="restart-btn" style="
        padding: 12px 40px; font-size: 18px;
        background: ${color}33; border: 2px solid ${color};
        color: #fff; cursor: pointer;
        font-family: inherit;
        transition: background 0.2s;
      ">Play Again</button>
    `;

    document.body.appendChild(this.overlay);

    const btn = document.getElementById('restart-btn');
    if (btn) {
      btn.onmouseenter = () => btn.style.background = `${color}66`;
      btn.onmouseleave = () => btn.style.background = `${color}33`;
      btn.onclick = () => {
        if (this.onRestart) {
          this.onRestart();
        } else {
          window.location.reload();
        }
      };
    }
  }
}
