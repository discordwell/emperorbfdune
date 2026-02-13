import type { GameRules } from '../config/RulesParser';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { ArtEntry } from '../config/ArtIniParser';

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

  constructor(rules: GameRules, production: ProductionSystem, artMap: Map<string, ArtEntry>, onBuild: BuildCallback) {
    this.container = document.getElementById('sidebar')!;
    this.rules = rules;
    this.production = production;
    this.artMap = artMap;
    this.onBuild = onBuild;
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
    // Filter buildings for current player's house
    const house = 'Atreides'; // TODO: dynamic
    const prefix = 'AT';

    for (const [name, def] of this.rules.buildings) {
      // Only show buildings for this house + sub-houses, skip scenery/incidental
      const validPrefix = name.startsWith(prefix) || name.startsWith('GU') || name.startsWith('IX') || name.startsWith('FR') || name.startsWith('IM') || name.startsWith('TL');
      if (!validPrefix) continue;
      if (name.startsWith('IN')) continue; // Skip incidental/scenery
      if (def.cost <= 0) continue;
      if (def.house && def.house !== 'Atreides' && def.house !== 'Ix' && def.house !== 'Tleilaxu' && def.house !== 'Fremen' && def.house !== 'Imperial' && def.house !== 'Guild') continue;

      const canBuild = this.production.canBuild(this.playerId, name, true);
      const item = this.createBuildItem(name, def.cost, canBuild, true);
      grid.appendChild(item);
    }
  }

  private renderUnitItems(grid: HTMLElement, infantryOnly: boolean): void {
    const prefix = 'AT';

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

    if (enabled) {
      item.onmouseenter = () => { item.style.borderColor = '#0f0'; };
      item.onmouseleave = () => { item.style.borderColor = '#444'; };
      item.onclick = () => this.onBuild(name, isBuilding);
    }

    return item;
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
