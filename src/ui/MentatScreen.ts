/**
 * MentatScreen — In-game encyclopedia showing unit and building stats.
 * Accessible from the pause menu. Displays all faction units/buildings
 * with detailed combat statistics drawn from game rules.
 */

import type { GameRules } from '../config/RulesParser';
import type { UnitDef } from '../config/UnitDefs';
import type { BuildingDef } from '../config/BuildingDefs';
import { getDisplayName, getFactionPrefix, getFactionName, stripFactionPrefix } from '../config/DisplayNames';

const FACTION_COLORS: Record<string, string> = {
  'AT': '#4488ff',
  'HK': '#ff4444',
  'OR': '#44cc44',
  'FR': '#cc8844',
  'IM': '#aa44aa',
  'IX': '#44aaaa',
  'TL': '#aa8866',
  'GU': '#888888',
};

const FACTIONS = ['AT', 'HK', 'OR', 'FR', 'IM', 'IX', 'TL', 'GU'];

type Tab = 'units' | 'buildings';

export class MentatScreen {
  private panel: HTMLDivElement | null = null;
  private rules: GameRules;
  private selectedFaction = 'AT';
  private selectedTab: Tab = 'units';
  private selectedItem: string | null = null;

  constructor(rules: GameRules) {
    this.rules = rules;
  }

  show(container: HTMLDivElement): void {
    container.innerHTML = '';
    this.panel = document.createElement('div');
    this.panel.style.cssText = `
      width:100%;height:100%;display:flex;flex-direction:column;
      color:#ccc;font-family:'Segoe UI',Tahoma,sans-serif;
    `;
    this.render();
    container.appendChild(this.panel);
  }

  private render(): void {
    if (!this.panel) return;
    this.panel.innerHTML = '';

    // Title
    const title = document.createElement('div');
    title.style.cssText = 'text-align:center;font-size:20px;font-weight:bold;color:#d4a840;padding:8px 0 4px;';
    title.textContent = 'MENTAT DATABASE';
    this.panel.appendChild(title);

    // Faction selector row
    const factionRow = document.createElement('div');
    factionRow.style.cssText = 'display:flex;justify-content:center;gap:4px;padding:4px 8px;flex-wrap:wrap;';
    for (const f of FACTIONS) {
      const btn = document.createElement('button');
      const isActive = f === this.selectedFaction;
      const color = FACTION_COLORS[f] ?? '#888';
      btn.textContent = getFactionName(f);
      btn.style.cssText = `
        padding:4px 10px;border:1px solid ${isActive ? color : '#444'};
        background:${isActive ? color + '33' : '#111'};
        color:${isActive ? color : '#888'};cursor:pointer;font-size:11px;
      `;
      btn.onclick = () => { this.selectedFaction = f; this.selectedItem = null; this.render(); };
      factionRow.appendChild(btn);
    }
    this.panel.appendChild(factionRow);

    // Tab row (Units / Buildings)
    const tabRow = document.createElement('div');
    tabRow.style.cssText = 'display:flex;justify-content:center;gap:8px;padding:4px 8px;';
    for (const tab of ['units', 'buildings'] as Tab[]) {
      const btn = document.createElement('button');
      const isActive = tab === this.selectedTab;
      btn.textContent = tab === 'units' ? 'Units' : 'Buildings';
      btn.style.cssText = `
        padding:4px 16px;border:1px solid ${isActive ? '#d4a840' : '#444'};
        background:${isActive ? '#d4a84022' : '#111'};
        color:${isActive ? '#d4a840' : '#888'};cursor:pointer;font-size:12px;
      `;
      btn.onclick = () => { this.selectedTab = tab; this.selectedItem = null; this.render(); };
      tabRow.appendChild(btn);
    }
    this.panel.appendChild(tabRow);

    // Content area: list on left, detail on right
    const content = document.createElement('div');
    content.style.cssText = 'display:flex;flex:1;overflow:hidden;padding:4px 8px 8px;gap:8px;min-height:0;';

    // Item list
    const list = document.createElement('div');
    list.style.cssText = 'width:180px;overflow-y:auto;border:1px solid #333;background:#0a0a0a;';

    const items = this.getFilteredItems();
    for (const [name] of items) {
      const row = document.createElement('div');
      const isSelected = name === this.selectedItem;
      const fColor = FACTION_COLORS[this.selectedFaction] ?? '#888';
      row.style.cssText = `
        padding:5px 8px;cursor:pointer;font-size:11px;
        border-bottom:1px solid #1a1a1a;
        background:${isSelected ? fColor + '22' : 'transparent'};
        color:${isSelected ? fColor : '#aaa'};
      `;
      row.textContent = getDisplayName(name);
      row.onmouseenter = () => { if (!isSelected) row.style.background = '#1a1a2a'; };
      row.onmouseleave = () => { if (!isSelected) row.style.background = 'transparent'; };
      row.onclick = () => { this.selectedItem = name; this.render(); };
      list.appendChild(row);
    }
    content.appendChild(list);

    // Detail panel
    const detail = document.createElement('div');
    detail.style.cssText = 'flex:1;overflow-y:auto;border:1px solid #333;background:#0a0a0a;padding:12px;';

    if (this.selectedItem) {
      if (this.selectedTab === 'units') {
        this.renderUnitDetail(detail, this.selectedItem);
      } else {
        this.renderBuildingDetail(detail, this.selectedItem);
      }
    } else {
      detail.innerHTML = '<div style="color:#555;text-align:center;padding-top:40px;">Select an entry to view details</div>';
    }
    content.appendChild(detail);
    this.panel.appendChild(content);
  }

  private getFilteredItems(): [string, UnitDef | BuildingDef][] {
    const prefix = this.selectedFaction;
    if (this.selectedTab === 'units') {
      return [...this.rules.units.entries()]
        .filter(([name, def]) => name.startsWith(prefix) && def.cost > 0)
        .sort((a, b) => a[1].techLevel - b[1].techLevel || a[1].cost - b[1].cost);
    } else {
      return [...this.rules.buildings.entries()]
        .filter(([name, def]) => {
          if (!name.startsWith(prefix)) return false;
          if (def.cost <= 0) return false;
          const stripped = stripFactionPrefix(name);
          if (stripped.startsWith('IN')) return false; // civilian
          if (stripped === 'FactoryFrigate' || stripped === 'RefineryDock') return false;
          return true;
        })
        .sort((a, b) => a[1].techLevel - b[1].techLevel || a[1].cost - b[1].cost);
    }
  }

  private renderUnitDetail(container: HTMLElement, name: string): void {
    const def = this.rules.units.get(name);
    if (!def) { container.innerHTML = '<div style="color:#555;">Not found</div>'; return; }

    const fColor = FACTION_COLORS[this.selectedFaction] ?? '#888';
    const displayName = getDisplayName(name);

    // Weapon info
    let weaponInfo = '';
    if (def.turretAttach) {
      const turret = this.rules.turrets.get(def.turretAttach);
      if (turret) {
        const bullet = this.rules.bullets.get(turret.bullet);
        if (bullet) {
          const warhead = this.rules.warheads.get(bullet.warhead);
          weaponInfo = `
            <div style="margin-top:12px;border-top:1px solid #333;padding-top:8px;">
              <div style="color:${fColor};font-size:13px;font-weight:bold;margin-bottom:6px;">Weapon</div>
              ${this.statRow('Damage', `${bullet.damage}`)}
              ${this.statRow('Range', `${bullet.maxRange.toFixed(1)}`)}
              ${turret.reloadCount > 0 ? this.statRow('Fire Rate', `${(25 / turret.reloadCount).toFixed(1)}/s`) : ''}
              ${bullet.blastRadius > 0 ? this.statRow('Blast Radius', `${(bullet.blastRadius / 32).toFixed(1)} tiles`) : ''}
              ${bullet.homing ? this.statRow('Tracking', 'Yes') : ''}
              ${bullet.antiAircraft ? this.statRow('Anti-Air', 'Yes') : ''}
              ${bullet.isLaser ? this.statRow('Type', 'Laser (instant)') : ''}
            </div>
          `;

          // Armor effectiveness
          if (warhead && Object.keys(warhead.vs).length > 0) {
            const vsEntries = Object.entries(warhead.vs)
              .filter(([, pct]) => pct !== 100)
              .sort((a, b) => b[1] - a[1]);
            if (vsEntries.length > 0) {
              weaponInfo += `
                <div style="margin-top:8px;">
                  <div style="color:#888;font-size:10px;margin-bottom:4px;">Damage vs Armor:</div>
                  ${vsEntries.map(([armor, pct]) => {
                    const barColor = pct > 100 ? '#4a4' : pct < 50 ? '#a44' : '#aa8';
                    return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">
                      <span style="width:70px;font-size:10px;color:#888;text-align:right;">${armor}</span>
                      <div style="flex:1;height:8px;background:#1a1a1a;position:relative;">
                        <div style="width:${Math.min(pct, 200) / 2}%;height:100%;background:${barColor};"></div>
                      </div>
                      <span style="width:30px;font-size:10px;color:${barColor};">${pct}%</span>
                    </div>`;
                  }).join('')}
                </div>
              `;
            }
          }
        }
      }
    }

    // Abilities
    const abilities: string[] = [];
    if (def.stealth) abilities.push('Stealth');
    if (def.selfDestruct) abilities.push('Self-Destruct');
    if (def.deviator) abilities.push('Deviator (converts enemies)');
    if (def.apc) abilities.push(`APC (carries ${def.passengerCapacity})`);
    if (def.ornithopter) abilities.push('Ornithopter');
    if (def.saboteur) abilities.push('Saboteur');
    if (def.infiltrator) abilities.push('Infiltrator');
    if (def.leech) abilities.push('Leech (parasitize vehicles)');
    if (def.projector) abilities.push('Holographic Projector');
    if (def.niabTank) abilities.push('Teleportation');
    if (def.kobra) abilities.push('Deploy Mode (extended range)');
    if (def.repair) abilities.push('Repair Vehicle');
    if (def.wormRider) abilities.push('Worm Rider');
    if (def.engineer) abilities.push('Engineer (capture buildings)');
    if (def.canFly) abilities.push('Flying');
    if (def.crushes) abilities.push('Crushes Infantry');

    container.innerHTML = `
      <div style="color:${fColor};font-size:18px;font-weight:bold;margin-bottom:2px;">${displayName}</div>
      <div style="color:#666;font-size:10px;margin-bottom:12px;">${getFactionName(this.selectedFaction)} — Tech Level ${def.techLevel}</div>

      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:140px;">
          <div style="color:${fColor};font-size:13px;font-weight:bold;margin-bottom:6px;">Stats</div>
          ${this.statRow('Cost', `${def.cost}`)}
          ${this.statRow('Health', `${def.health}`)}
          ${this.statRow('Speed', `${def.speed.toFixed(1)}`)}
          ${this.statRow('Armor', def.armour)}
          ${this.statRow('Sight', `${def.viewRange}`)}
          ${this.statRow('Build Time', `${(def.buildTime / 25).toFixed(1)}s`)}
        </div>
      </div>

      ${abilities.length > 0 ? `
        <div style="margin-top:12px;border-top:1px solid #333;padding-top:8px;">
          <div style="color:${fColor};font-size:13px;font-weight:bold;margin-bottom:6px;">Abilities</div>
          ${abilities.map(a => `<div style="font-size:11px;color:#aaa;padding:2px 0;">• ${a}</div>`).join('')}
        </div>
      ` : ''}

      ${weaponInfo}
    `;
  }

  private renderBuildingDetail(container: HTMLElement, name: string): void {
    const def = this.rules.buildings.get(name);
    if (!def) { container.innerHTML = '<div style="color:#555;">Not found</div>'; return; }

    const fColor = FACTION_COLORS[this.selectedFaction] ?? '#888';
    const displayName = getDisplayName(name);

    // Power info
    let powerInfo = '';
    if (def.powerGenerated > 0) {
      powerInfo = this.statRow('Power Generated', `+${def.powerGenerated}`);
    } else if (def.powerUsed > 0) {
      powerInfo = this.statRow('Power Used', `-${def.powerUsed}`);
    }

    // Weapon info for turrets
    let weaponInfo = '';
    if (def.turretAttach) {
      const turret = this.rules.turrets.get(def.turretAttach);
      if (turret) {
        const bullet = this.rules.bullets.get(turret.bullet);
        if (bullet) {
          weaponInfo = `
            <div style="margin-top:12px;border-top:1px solid #333;padding-top:8px;">
              <div style="color:${fColor};font-size:13px;font-weight:bold;margin-bottom:6px;">Weapon</div>
              ${this.statRow('Damage', `${bullet.damage}`)}
              ${this.statRow('Range', `${bullet.maxRange.toFixed(1)}`)}
              ${turret.reloadCount > 0 ? this.statRow('Fire Rate', `${(25 / turret.reloadCount).toFixed(1)}/s`) : ''}
              ${bullet.antiAircraft ? this.statRow('Anti-Air', 'Yes') : ''}
            </div>
          `;
        }
      }
    }

    // Features
    const features: string[] = [];
    if (def.refinery) features.push('Spice Refinery — processes harvested spice');
    if (def.getUnitWhenBuilt) features.push(`Includes free ${getDisplayName(def.getUnitWhenBuilt)}`);
    if (def.upgradable) features.push(`Upgradable (${def.upgradeCost} credits)`);

    container.innerHTML = `
      <div style="color:${fColor};font-size:18px;font-weight:bold;margin-bottom:2px;">${displayName}</div>
      <div style="color:#666;font-size:10px;margin-bottom:12px;">${getFactionName(this.selectedFaction)} — Tech Level ${def.techLevel}</div>

      <div style="display:flex;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:140px;">
          <div style="color:${fColor};font-size:13px;font-weight:bold;margin-bottom:6px;">Stats</div>
          ${this.statRow('Cost', `${def.cost}`)}
          ${this.statRow('Health', `${def.health}`)}
          ${this.statRow('Armor', def.armour)}
          ${this.statRow('Sight', `${def.viewRange}`)}
          ${this.statRow('Build Time', `${(def.buildTime / 25).toFixed(1)}s`)}
          ${powerInfo}
        </div>
      </div>

      ${features.length > 0 ? `
        <div style="margin-top:12px;border-top:1px solid #333;padding-top:8px;">
          <div style="color:${fColor};font-size:13px;font-weight:bold;margin-bottom:6px;">Features</div>
          ${features.map(f => `<div style="font-size:11px;color:#aaa;padding:2px 0;">• ${f}</div>`).join('')}
        </div>
      ` : ''}

      ${weaponInfo}
    `;
  }

  private statRow(label: string, value: string): string {
    return `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:11px;">
      <span style="color:#888;">${label}</span>
      <span style="color:#ccc;">${value}</span>
    </div>`;
  }
}
