import { Owner, Health, buildingQuery, type World } from '../core/ECS';
import type { AudioManager } from '../audio/AudioManager';

export type GameOutcome = 'playing' | 'victory' | 'defeat';

/** Tracks per-player game statistics */
export class GameStats {
  // Per-player stats: [player0, player1]
  unitsBuilt = [0, 0];
  unitsLost = [0, 0];
  buildingsBuilt = [0, 0];
  buildingsLost = [0, 0];
  creditsEarned = [0, 0];
  creditsSpent = [0, 0];
  damageDealt = [0, 0];

  recordUnitBuilt(owner: number): void { if (owner < 2) this.unitsBuilt[owner]++; }
  recordUnitLost(owner: number): void { if (owner < 2) this.unitsLost[owner]++; }
  recordBuildingBuilt(owner: number): void { if (owner < 2) this.buildingsBuilt[owner]++; }
  recordBuildingLost(owner: number): void { if (owner < 2) this.buildingsLost[owner]++; }
  recordCreditsEarned(owner: number, amount: number): void { if (owner < 2) this.creditsEarned[owner] += amount; }
  recordCreditsSpent(owner: number, amount: number): void { if (owner < 2) this.creditsSpent[owner] += amount; }
  recordDamage(owner: number, amount: number): void { if (owner < 2) this.damageDealt[owner] += amount; }
}

export class VictorySystem {
  private audioManager: AudioManager;
  private localPlayerId = 0;
  private outcome: GameOutcome = 'playing';
  private overlay: HTMLDivElement | null = null;
  private checkInterval = 50; // Check every 50 ticks (~2 seconds)
  private tickCounter = 0;
  private onRestart: (() => void) | null = null;
  private graceperiodTicks = 250; // 10 seconds before checking (let game load)
  private stats: GameStats | null = null;
  private startTime = Date.now();
  private onVictoryCallback: (() => void) | null = null;

  constructor(audioManager: AudioManager, localPlayerId: number, onRestart?: () => void) {
    this.audioManager = audioManager;
    this.localPlayerId = localPlayerId;
    this.onRestart = onRestart ?? null;
  }

  setStats(stats: GameStats): void { this.stats = stats; }
  setVictoryCallback(cb: () => void): void { this.onVictoryCallback = cb; }

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
    if (this.onVictoryCallback) this.onVictoryCallback();
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

    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

    let statsHtml = '';
    if (this.stats) {
      const s = this.stats;
      const p = this.localPlayerId;
      const e = 1 - p;
      statsHtml = `
        <div style="display:grid;grid-template-columns:1fr auto auto;gap:4px 16px;font-size:14px;color:#ccc;margin-bottom:30px;text-align:right;max-width:400px;">
          <div style="text-align:left;color:#888;"></div><div style="color:#4cf;">You</div><div style="color:#f88;">Enemy</div>
          <div style="text-align:left;">Units Built</div><div>${s.unitsBuilt[p]}</div><div>${s.unitsBuilt[e]}</div>
          <div style="text-align:left;">Units Lost</div><div>${s.unitsLost[p]}</div><div>${s.unitsLost[e]}</div>
          <div style="text-align:left;">Buildings Built</div><div>${s.buildingsBuilt[p]}</div><div>${s.buildingsBuilt[e]}</div>
          <div style="text-align:left;">Buildings Lost</div><div>${s.buildingsLost[p]}</div><div>${s.buildingsLost[e]}</div>
          <div style="text-align:left;">Credits Earned</div><div>${s.creditsEarned[p].toLocaleString()}</div><div>${s.creditsEarned[e].toLocaleString()}</div>
          <div style="text-align:left;">Damage Dealt</div><div>${s.damageDealt[p].toLocaleString()}</div><div>${s.damageDealt[e].toLocaleString()}</div>
        </div>`;
    }

    this.overlay.innerHTML = `
      <div style="color:${color}; font-size:64px; font-weight:bold; text-shadow: 0 0 30px ${color}40; margin-bottom:16px;">
        ${title}
      </div>
      <div style="color:#ccc; font-size:20px; margin-bottom:8px;">
        ${message}
      </div>
      <div style="color:#888; font-size:14px; margin-bottom:24px;">Game Time: ${timeStr}</div>
      ${statsHtml}
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
