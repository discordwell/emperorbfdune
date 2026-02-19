import { Owner, Health, BuildingType, buildingQuery, unitQuery, type World } from '../core/ECS';
import type { AudioManager } from '../audio/AudioManager';

export type VictoryCondition = 'annihilate' | 'conyard' | 'survival';
export type GameOutcome = 'playing' | 'victory' | 'defeat';

/** Tracks per-player game statistics */
export class GameStats {
  private playerCount: number;
  // Per-player stats arrays (dynamic length)
  unitsBuilt: number[];
  unitsLost: number[];
  buildingsBuilt: number[];
  buildingsLost: number[];
  creditsEarned: number[];
  creditsSpent: number[];
  damageDealt: number[];

  // Time-series data for graphs (sampled every ~10 seconds / 250 ticks)
  creditHistory: number[][]; // per-player credit balance over time
  unitCountHistory: number[][]; // per-player unit count over time
  timestamps: number[] = []; // tick values for x-axis

  constructor(playerCount = 2) {
    this.playerCount = playerCount;
    this.unitsBuilt = new Array(playerCount).fill(0);
    this.unitsLost = new Array(playerCount).fill(0);
    this.buildingsBuilt = new Array(playerCount).fill(0);
    this.buildingsLost = new Array(playerCount).fill(0);
    this.creditsEarned = new Array(playerCount).fill(0);
    this.creditsSpent = new Array(playerCount).fill(0);
    this.damageDealt = new Array(playerCount).fill(0);
    this.creditHistory = Array.from({ length: playerCount }, () => []);
    this.unitCountHistory = Array.from({ length: playerCount }, () => []);
  }

  recordUnitBuilt(owner: number): void { if (owner < this.playerCount) this.unitsBuilt[owner]++; }
  recordUnitLost(owner: number): void { if (owner < this.playerCount) this.unitsLost[owner]++; }
  recordBuildingBuilt(owner: number): void { if (owner < this.playerCount) this.buildingsBuilt[owner]++; }
  recordBuildingLost(owner: number): void { if (owner < this.playerCount) this.buildingsLost[owner]++; }
  recordCreditsEarned(owner: number, amount: number): void { if (owner < this.playerCount) this.creditsEarned[owner] += amount; }
  recordCreditsSpent(owner: number, amount: number): void { if (owner < this.playerCount) this.creditsSpent[owner] += amount; }
  recordDamage(owner: number, amount: number): void { if (owner < this.playerCount) this.damageDealt[owner] += amount; }

  /** Call every 250 ticks to sample time-series data */
  sample(tick: number, credits: number[], unitCounts: number[]): void {
    this.timestamps.push(tick);
    for (let i = 0; i < this.playerCount; i++) {
      this.creditHistory[i].push(credits[i] ?? 0);
      this.unitCountHistory[i].push(unitCounts[i] ?? 0);
    }
  }

  /** Get aggregated stats for all enemy players (everyone except player 0) */
  getEnemyAggregate(): { unitsBuilt: number; unitsLost: number; buildingsBuilt: number; buildingsLost: number; creditsEarned: number; creditsSpent: number; damageDealt: number; creditHistory: number[]; unitCountHistory: number[] } {
    const agg = { unitsBuilt: 0, unitsLost: 0, buildingsBuilt: 0, buildingsLost: 0, creditsEarned: 0, creditsSpent: 0, damageDealt: 0, creditHistory: [] as number[], unitCountHistory: [] as number[] };
    for (let i = 1; i < this.playerCount; i++) {
      agg.unitsBuilt += this.unitsBuilt[i];
      agg.unitsLost += this.unitsLost[i];
      agg.buildingsBuilt += this.buildingsBuilt[i];
      agg.buildingsLost += this.buildingsLost[i];
      agg.creditsEarned += this.creditsEarned[i];
      agg.creditsSpent += this.creditsSpent[i];
      agg.damageDealt += this.damageDealt[i];
    }
    // Aggregate time-series: sum all enemy histories
    const len = this.timestamps.length;
    for (let t = 0; t < len; t++) {
      let creditSum = 0, unitSum = 0;
      for (let i = 1; i < this.playerCount; i++) {
        creditSum += this.creditHistory[i][t] ?? 0;
        unitSum += this.unitCountHistory[i][t] ?? 0;
      }
      agg.creditHistory.push(creditSum);
      agg.unitCountHistory.push(unitSum);
    }
    return agg;
  }
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
  private onDefeatCallback: (() => void) | null = null;
  private onCampaignContinue: (() => void) | null = null;
  private victoryCondition: VictoryCondition = 'annihilate';
  // Building type names for ConYard check (set externally)
  private buildingTypeNames: string[] = [];
  private survivalTicks = 0; // Ticks to survive (0 = disabled)
  private objectiveLabel = '';

  constructor(audioManager: AudioManager, localPlayerId: number, onRestart?: () => void) {
    this.audioManager = audioManager;
    this.localPlayerId = localPlayerId;
    this.onRestart = onRestart ?? null;
  }

  setStats(stats: GameStats): void { this.stats = stats; }
  setVictoryCallback(cb: () => void): void { this.onVictoryCallback = cb; }
  setDefeatCallback(cb: () => void): void { this.onDefeatCallback = cb; }
  setVictoryCondition(cond: VictoryCondition): void { this.victoryCondition = cond; }
  setCampaignContinue(cb: () => void): void { this.onCampaignContinue = cb; }
  setBuildingTypeNames(names: string[]): void { this.buildingTypeNames = names; }
  setSurvivalTicks(ticks: number): void { this.survivalTicks = ticks; }
  setObjectiveLabel(label: string): void { this.objectiveLabel = label; }
  getObjectiveLabel(): string { return this.objectiveLabel; }
  getSurvivalProgress(): number {
    if (this.survivalTicks <= 0 || this.tickCounter < this.graceperiodTicks) return 0;
    return Math.min(1, (this.tickCounter - this.graceperiodTicks) / this.survivalTicks);
  }

  getOutcome(): GameOutcome {
    return this.outcome;
  }

  update(world: World): void {
    if (this.outcome !== 'playing') return;

    this.tickCounter++;
    if (this.tickCounter < this.graceperiodTicks) return;
    if (this.tickCounter % this.checkInterval !== 0) return;

    // Check if player is still alive (always needed)
    const buildings = buildingQuery(world);
    let playerAlive = false;
    let enemyAlive = false;

    if (this.victoryCondition === 'conyard') {
      for (const eid of buildings) {
        if (Health.current[eid] <= 0) continue;
        const typeId = BuildingType.id[eid];
        const typeName = this.buildingTypeNames[typeId] ?? '';
        if (!typeName.includes('ConYard')) continue;
        if (Owner.playerId[eid] === this.localPlayerId) playerAlive = true;
        else enemyAlive = true;
      }
    } else {
      // Annihilate: check both buildings and units
      for (const eid of buildings) {
        if (Health.current[eid] <= 0) continue;
        if (Owner.playerId[eid] === this.localPlayerId) playerAlive = true;
        else enemyAlive = true;
      }
      const units = unitQuery(world);
      for (const eid of units) {
        if (Health.current[eid] <= 0) continue;
        if (Owner.playerId[eid] === this.localPlayerId) playerAlive = true;
        else enemyAlive = true;
      }
    }

    // Defeat: player has no buildings
    if (!playerAlive) {
      this.triggerDefeat();
      return;
    }

    // Survival mode: win after surviving N ticks
    if (this.victoryCondition === 'survival') {
      const elapsed = this.tickCounter - this.graceperiodTicks;
      if (this.survivalTicks > 0 && elapsed >= this.survivalTicks) {
        this.triggerVictory();
      }
      return;
    }

    // Normal victory: enemy has no buildings
    if (!enemyAlive) {
      this.triggerVictory();
    }
  }

  private triggerVictory(): void {
    this.outcome = 'victory';
    this.audioManager.playSfx('victory');
    this.audioManager.playVictoryMusic();
    this.audioManager.getDialogManager()?.trigger('victory');
    if (this.onVictoryCallback) this.onVictoryCallback();
    this.showScreen('VICTORY', 'You have conquered the enemy!', '#00ff44');
  }

  private triggerDefeat(): void {
    this.outcome = 'defeat';
    this.audioManager.playSfx('defeat');
    this.audioManager.getDialogManager()?.trigger('defeat');
    if (this.onDefeatCallback) this.onDefeatCallback();
    this.showScreen('DEFEAT', 'Your base has been destroyed.', '#ff2222');
  }

  private showScreen(title: string, message: string, color: string): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.9);
      display: flex; flex-direction: column;
      align-items: center; justify-content: flex-start;
      overflow-y: auto;
      z-index: 1000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      padding: 40px 20px;
    `;

    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;

    const container = document.createElement('div');
    container.style.cssText = 'display:flex;flex-direction:column;align-items:center;max-width:600px;width:100%;';

    // Title with entrance animation
    const titleEl = document.createElement('div');
    titleEl.style.cssText = `color:${color};font-size:56px;font-weight:bold;text-shadow:0 0 30px ${color}40;margin-bottom:8px;opacity:0;transform:scale(0.5);transition:opacity 0.8s,transform 0.8s;letter-spacing:6px;`;
    titleEl.textContent = title;
    container.appendChild(titleEl);
    requestAnimationFrame(() => { titleEl.style.opacity = '1'; titleEl.style.transform = 'scale(1)'; });

    // Message
    const msgEl = document.createElement('div');
    msgEl.style.cssText = 'color:#ccc;font-size:18px;margin-bottom:4px;';
    msgEl.textContent = message;
    container.appendChild(msgEl);

    // Time
    const timeEl = document.createElement('div');
    timeEl.style.cssText = 'color:#888;font-size:14px;margin-bottom:24px;';
    timeEl.textContent = `Game Time: ${timeStr}`;
    container.appendChild(timeEl);

    if (this.stats) {
      const s = this.stats;
      const p = this.localPlayerId;

      // Stats table with bar visualization (aggregated enemies)
      container.appendChild(this.createStatsSection(s, p));

      // Graphs
      if (s.timestamps.length > 2) {
        container.appendChild(this.createGraphSection(s, p));
      }
    }

    // Button row
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:16px;margin-top:24px;';

    // Campaign continue button (on victory or defeat in campaign mode)
    if (this.onCampaignContinue) {
      const campaignBtn = document.createElement('button');
      campaignBtn.style.cssText = `
        padding:14px 48px;font-size:18px;
        background:#f0c04022;border:2px solid #f0c040;
        color:#fff;cursor:pointer;font-family:inherit;
        transition:background 0.2s;
      `;
      campaignBtn.textContent = 'Continue Campaign';
      campaignBtn.onmouseenter = () => campaignBtn.style.background = '#f0c04055';
      campaignBtn.onmouseleave = () => campaignBtn.style.background = '#f0c04022';
      campaignBtn.onclick = () => {
        if (this.overlay) this.overlay.remove();
        this.onCampaignContinue!();
      };
      btnRow.appendChild(campaignBtn);
    }

    // Play Again / Restart button
    const btn = document.createElement('button');
    btn.style.cssText = `
      padding:14px 48px;font-size:18px;
      background:${color}22;border:2px solid ${color};
      color:#fff;cursor:pointer;font-family:inherit;
      transition:background 0.2s;
    `;
    btn.textContent = this.onCampaignContinue ? 'Restart Mission' : 'Play Again';
    btn.onmouseenter = () => btn.style.background = `${color}55`;
    btn.onmouseleave = () => btn.style.background = `${color}22`;
    btn.onclick = () => {
      if (this.onRestart) {
        this.onRestart();
      } else {
        window.location.reload();
      }
    };
    btnRow.appendChild(btn);
    container.appendChild(btnRow);

    this.overlay.appendChild(container);
    document.body.appendChild(this.overlay);
  }

  private createStatsSection(s: GameStats, p: number): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText = 'width:100%;margin-bottom:20px;';

    const eAgg = s.getEnemyAggregate();
    const rows = [
      { label: 'Units Built', pVal: s.unitsBuilt[p], eVal: eAgg.unitsBuilt },
      { label: 'Units Lost', pVal: s.unitsLost[p], eVal: eAgg.unitsLost },
      { label: 'Buildings Built', pVal: s.buildingsBuilt[p], eVal: eAgg.buildingsBuilt },
      { label: 'Buildings Lost', pVal: s.buildingsLost[p], eVal: eAgg.buildingsLost },
      { label: 'Credits Earned', pVal: s.creditsEarned[p], eVal: eAgg.creditsEarned },
      { label: 'Credits Spent', pVal: s.creditsSpent[p], eVal: eAgg.creditsSpent },
      { label: 'Damage Dealt', pVal: s.damageDealt[p], eVal: eAgg.damageDealt },
    ];

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:grid;grid-template-columns:1fr 60px 1fr 60px;gap:4px;font-size:12px;color:#666;margin-bottom:6px;padding:0 4px;';
    header.innerHTML = '<div style="text-align:right;color:#4cf;">You</div><div></div><div></div><div style="color:#f88;">Enemies</div>';
    section.appendChild(header);

    for (const row of rows) {
      const maxVal = Math.max(row.pVal, row.eVal, 1);
      const pPct = (row.pVal / maxVal) * 100;
      const ePct = (row.eVal / maxVal) * 100;

      const rowEl = document.createElement('div');
      rowEl.style.cssText = 'display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin-bottom:3px;';

      // Player bar (right-aligned, grows left)
      const pBar = document.createElement('div');
      pBar.style.cssText = 'height:16px;display:flex;align-items:center;justify-content:flex-end;';
      pBar.innerHTML = `
        <span style="color:#aaa;font-size:11px;margin-right:4px;">${row.pVal.toLocaleString()}</span>
        <div style="width:${pPct}%;min-width:2px;height:100%;background:linear-gradient(to right,transparent,#44ccff);border-radius:2px;"></div>
      `;
      rowEl.appendChild(pBar);

      // Label
      const labelEl = document.createElement('div');
      labelEl.style.cssText = 'color:#999;font-size:11px;text-align:center;white-space:nowrap;min-width:90px;';
      labelEl.textContent = row.label;
      rowEl.appendChild(labelEl);

      // Enemy bar (left-aligned, grows right)
      const eBar = document.createElement('div');
      eBar.style.cssText = 'height:16px;display:flex;align-items:center;';
      eBar.innerHTML = `
        <div style="width:${ePct}%;min-width:2px;height:100%;background:linear-gradient(to left,transparent,#ff8888);border-radius:2px;"></div>
        <span style="color:#aaa;font-size:11px;margin-left:4px;">${row.eVal.toLocaleString()}</span>
      `;
      rowEl.appendChild(eBar);

      section.appendChild(rowEl);
    }

    return section;
  }

  private createGraphSection(s: GameStats, p: number): HTMLElement {
    const section = document.createElement('div');
    section.style.cssText = 'width:100%;';

    const eAgg = s.getEnemyAggregate();

    // Credits over time graph
    section.appendChild(this.createGraph(
      'Credits Over Time',
      s.timestamps,
      s.creditHistory[p],
      eAgg.creditHistory,
      260, 120
    ));

    // Unit count over time graph
    section.appendChild(this.createGraph(
      'Army Size Over Time',
      s.timestamps,
      s.unitCountHistory[p],
      eAgg.unitCountHistory,
      260, 120
    ));

    return section;
  }

  private createGraph(
    title: string,
    xValues: number[],
    pValues: number[],
    eValues: number[],
    width: number,
    height: number,
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'margin-bottom:16px;';

    const label = document.createElement('div');
    label.style.cssText = 'color:#888;font-size:12px;margin-bottom:4px;text-align:center;';
    label.textContent = title;
    wrapper.appendChild(label);

    const canvas = document.createElement('canvas');
    canvas.width = width * 2; // Retina
    canvas.height = height * 2;
    canvas.style.cssText = `width:${width}px;height:${height}px;display:block;margin:0 auto;background:#111;border:1px solid #333;border-radius:3px;`;
    wrapper.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return wrapper;

    ctx.scale(2, 2);

    const pad = { top: 8, right: 8, bottom: 18, left: 40 };
    const gw = width - pad.left - pad.right;
    const gh = height - pad.top - pad.bottom;

    const allVals = [...pValues, ...eValues];
    const maxVal = Math.max(...allVals, 1);
    const minVal = 0;

    const n = xValues.length;
    if (n < 2) return wrapper;

    // Grid lines
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (gh * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + gw, y);
      ctx.stroke();

      // Y-axis labels
      const val = maxVal - (maxVal * i) / 4;
      ctx.fillStyle = '#555';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(Math.round(val)), pad.left - 4, y + 3);
    }

    // X-axis labels (time in minutes)
    ctx.fillStyle = '#555';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    const totalTicks = xValues[n - 1] - xValues[0];
    for (let i = 0; i <= 3; i++) {
      const tickVal = xValues[0] + (totalTicks * i) / 3;
      const x = pad.left + (gw * i) / 3;
      const mins = Math.floor(tickVal / (25 * 60));
      ctx.fillText(`${mins}m`, x, height - 4);
    }

    // Draw lines
    const drawLine = (values: number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = pad.left + (gw * i) / (n - 1);
        const y = pad.top + gh - (gh * (values[i] - minVal)) / (maxVal - minVal);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    drawLine(pValues, '#44ccff');
    drawLine(eValues, '#ff8888');

    // Legend
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#44ccff';
    ctx.textAlign = 'left';
    ctx.fillText('You', pad.left + 4, pad.top + 10);
    ctx.fillStyle = '#ff8888';
    ctx.fillText('Enemy', pad.left + 30, pad.top + 10);

    return wrapper;
  }
}
