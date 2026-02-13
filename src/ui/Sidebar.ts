import type { GameRules } from '../config/RulesParser';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { ArtEntry } from '../config/ArtIniParser';
import type { UnitDef } from '../config/UnitDefs';
import type { BuildingDef } from '../config/BuildingDefs';

type BuildCallback = (typeName: string, isBuilding: boolean) => void;

export class Sidebar {
  private container: HTMLElement;
  private rules: GameRules;
  private production: ProductionSystem;
  private artMap: Map<string, ArtEntry>;
  private onBuild: BuildCallback;
  private playerId = 0;
  private currentTab: 'Buildings' | 'Units' | 'Infantry' = 'Buildings';
  private progressBar: HTMLDivElement | null = null;

  private factionPrefix: string;
  private tooltip: HTMLElement | null;

  constructor(rules: GameRules, production: ProductionSystem, artMap: Map<string, ArtEntry>, onBuild: BuildCallback, factionPrefix = 'AT') {
    this.container = document.getElementById('sidebar')!;
    this.rules = rules;
    this.production = production;
    this.artMap = artMap;
    this.onBuild = onBuild;
    this.factionPrefix = factionPrefix;
    this.tooltip = document.getElementById('tooltip');
    this.render();
  }

  private render(): void {
    this.container.innerHTML = '';

    // Tabs
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;border-bottom:1px solid #444;';
    for (const tab of ['Buildings', 'Units', 'Infantry'] as const) {
      const btn = document.createElement('button');
      btn.textContent = tab;
      btn.style.cssText = `flex:1;padding:6px;background:${tab === this.currentTab ? '#2a2a4e' : '#111'};color:#ccc;border:none;cursor:pointer;font-size:11px;`;
      btn.onclick = () => { this.currentTab = tab; this.render(); };
      tabBar.appendChild(btn);
    }
    this.container.appendChild(tabBar);

    // Progress bar
    this.progressBar = document.createElement('div');
    this.progressBar.style.cssText = 'height:4px;background:#222;margin:2px 4px;';
    const progressFill = document.createElement('div');
    progressFill.id = 'production-progress';
    progressFill.style.cssText = 'height:100%;background:#0f0;width:0%;transition:width 0.1s;';
    this.progressBar.appendChild(progressFill);
    this.container.appendChild(this.progressBar);

    // Items grid
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px;padding:4px;';

    if (this.currentTab === 'Buildings') {
      this.renderBuildingItems(grid);
    } else {
      this.renderUnitItems(grid, this.currentTab === 'Infantry');
    }

    this.container.appendChild(grid);
  }

  private renderBuildingItems(grid: HTMLElement): void {
    const prefix = this.factionPrefix;

    for (const [name, def] of this.rules.buildings) {
      const validPrefix = name.startsWith(prefix) || name.startsWith('GU') || name.startsWith('IX') || name.startsWith('FR') || name.startsWith('IM') || name.startsWith('TL');
      if (!validPrefix) continue;
      if (name.startsWith('IN')) continue;
      if (def.cost <= 0) continue;

      const canBuild = this.production.canBuild(this.playerId, name, true);
      const item = this.createBuildItem(name, def.cost, canBuild, true);
      grid.appendChild(item);
    }
  }

  private renderUnitItems(grid: HTMLElement, infantryOnly: boolean): void {
    const prefix = this.factionPrefix;

    for (const [name, def] of this.rules.units) {
      if (!name.startsWith(prefix)) continue;
      if (def.cost <= 0) continue;
      if (infantryOnly && !def.infantry) continue;
      if (!infantryOnly && def.infantry) continue;

      const canBuild = this.production.canBuild(this.playerId, name, false);
      const item = this.createBuildItem(name, def.cost, canBuild, false);
      grid.appendChild(item);
    }
  }

  private createBuildItem(name: string, cost: number, enabled: boolean, isBuilding: boolean): HTMLElement {
    const item = document.createElement('button');
    item.style.cssText = `
      padding:4px;background:${enabled ? '#1a1a3e' : '#0a0a15'};
      border:1px solid ${enabled ? '#444' : '#222'};color:${enabled ? '#ddd' : '#555'};
      cursor:${enabled ? 'pointer' : 'default'};font-size:10px;text-align:center;
    `;
    // Short display name (strip house prefix)
    const displayName = name.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
    item.innerHTML = `<div style="font-size:11px;font-weight:bold">${displayName}</div><div style="color:#f0c040;font-size:10px">$${cost}</div>`;

    // Tooltip on hover
    item.onmouseenter = (e) => {
      if (enabled) item.style.borderColor = '#0f0';
      this.showTooltip(name, isBuilding, e.clientX, e.clientY);
    };
    item.onmouseleave = () => {
      if (enabled) item.style.borderColor = '#444';
      this.hideTooltip();
    };
    item.onmousemove = (e) => {
      if (this.tooltip && this.tooltip.style.display !== 'none') {
        this.tooltip.style.left = (e.clientX - 260) + 'px';
        this.tooltip.style.top = e.clientY + 'px';
      }
    };

    if (enabled) {
      item.onclick = () => this.onBuild(name, isBuilding);
    }

    return item;
  }

  private showTooltip(name: string, isBuilding: boolean, x: number, y: number): void {
    if (!this.tooltip) return;

    const def = isBuilding
      ? this.rules.buildings.get(name)
      : this.rules.units.get(name);
    if (!def) return;

    const displayName = name.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
    let html = `<div style="font-weight:bold;color:#fff;margin-bottom:4px;">${displayName}</div>`;
    html += `<div style="color:#f0c040;">Cost: $${def.cost}</div>`;
    html += `<div>HP: ${def.health}</div>`;
    html += `<div>Build Time: ${def.buildTime} ticks</div>`;

    if (!isBuilding) {
      const unitDef = def as UnitDef;
      html += `<div>Speed: ${unitDef.speed.toFixed(1)}</div>`;
      if (unitDef.turretAttach) html += `<div style="color:#f88;">Armed</div>`;
      if (unitDef.infantry) html += `<div style="color:#8cf;">Infantry</div>`;
      if (unitDef.canFly) html += `<div style="color:#aaf;">Aircraft</div>`;
    } else {
      const bDef = def as BuildingDef;
      if (bDef.powerGenerated > 0) html += `<div style="color:#4f4;">Power: +${bDef.powerGenerated}</div>`;
      if (bDef.powerUsed > 0) html += `<div style="color:#f44;">Power: -${bDef.powerUsed}</div>`;
    }

    if (def.primaryBuilding) {
      html += `<div style="color:#888;margin-top:4px;font-size:10px;">Requires: ${def.primaryBuilding.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '')}</div>`;
    }

    this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = (x - 260) + 'px';
    this.tooltip.style.top = y + 'px';
  }

  private hideTooltip(): void {
    if (this.tooltip) {
      this.tooltip.style.display = 'none';
    }
  }

  updateProgress(): void {
    const buildingProg = this.production.getQueueProgress(this.playerId, true);
    const unitProg = this.production.getQueueProgress(this.playerId, false);
    const prog = buildingProg ?? unitProg;

    const fill = document.getElementById('production-progress');
    if (fill) {
      fill.style.width = prog ? `${prog.progress * 100}%` : '0%';
    }
  }

  refresh(): void {
    this.render();
  }
}
