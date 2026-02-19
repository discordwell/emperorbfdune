import type { GameRules } from '../config/RulesParser';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { ArtEntry } from '../config/ArtIniParser';
import type { UnitDef } from '../config/UnitDefs';
import type { BuildingDef } from '../config/BuildingDefs';
import { DISPLAY_NAMES, getDisplayName } from '../config/DisplayNames';

type BuildCallback = (typeName: string, isBuilding: boolean) => void;
type ConcreteCallback = () => void;

const HOTKEYS = ['q', 'e', 'r', 'f', 't', 'y'];

export class Sidebar {
  private container: HTMLElement;
  private rules: GameRules;
  private production: ProductionSystem;
  private artMap: Map<string, ArtEntry>;
  private onBuild: BuildCallback;
  private onConcreteClick: ConcreteCallback | null = null;
  private playerId = 0;
  private currentTab: 'Buildings' | 'Units' | 'Infantry' | 'Starport' = 'Buildings';
  private progressBar: HTMLDivElement | null = null;

  private factionPrefix: string;
  private subhousePrefix: string;
  private tooltip: HTMLElement | null;
  // Maps hotkey letter to { name, isBuilding } for current tab
  private hotkeyMap = new Map<string, { name: string; isBuilding: boolean }>();
  // Icon data URLs from 3D model renders
  private iconMap = new Map<string, string>();

  constructor(rules: GameRules, production: ProductionSystem, artMap: Map<string, ArtEntry>, onBuild: BuildCallback, factionPrefix = 'AT', subhousePrefix = '') {
    this.container = document.getElementById('sidebar')!;
    this.rules = rules;
    this.production = production;
    this.artMap = artMap;
    this.onBuild = onBuild;
    this.factionPrefix = factionPrefix;
    this.subhousePrefix = subhousePrefix;
    this.tooltip = document.getElementById('tooltip');
    this.render();
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** Set production icons rendered from 3D models */
  setIcons(icons: Map<string, string>): void {
    this.iconMap = icons;
    this.render(); // Re-render with icons
  }

  setConcreteCallback(cb: ConcreteCallback): void {
    this.onConcreteClick = cb;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // Don't fire in text inputs or when help overlay is shown
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const help = document.getElementById('help-overlay');
    if (help && help.style.display !== 'none') return;

    const entry = this.hotkeyMap.get(e.key.toLowerCase());
    if (entry) {
      // Shift+hotkey: queue 5 at once
      const count = e.shiftKey ? 5 : 1;
      for (let i = 0; i < count; i++) {
        this.onBuild(entry.name, entry.isBuilding);
      }
    }
  };

  private render(): void {
    this.container.innerHTML = '';

    // Tabs
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;border-bottom:1px solid #444;';
    const tabs = ['Buildings', 'Units', 'Infantry'] as ('Buildings' | 'Units' | 'Infantry' | 'Starport')[];
    // Add Starport tab if player has offers
    const starportOffers = this.production.getStarportOffers(this.factionPrefix);
    if (starportOffers.length > 0) tabs.push('Starport');

    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.textContent = tab;
      btn.style.cssText = `flex:1;padding:6px;background:${tab === this.currentTab ? '#2a2a4e' : '#111'};color:#ccc;border:none;cursor:pointer;font-size:11px;`;
      btn.onclick = () => { this.currentTab = tab; this.render(); };
      tabBar.appendChild(btn);
    }
    this.container.appendChild(tabBar);

    // Progress bar with label
    const progressWrap = document.createElement('div');
    progressWrap.style.cssText = 'margin:2px 4px;';
    const progressLabel = document.createElement('div');
    progressLabel.id = 'production-label';
    progressLabel.style.cssText = 'font-size:10px;color:#aaa;text-align:center;height:14px;line-height:14px;';
    progressWrap.appendChild(progressLabel);
    this.progressBar = document.createElement('div');
    this.progressBar.style.cssText = 'height:4px;background:#222;';
    const progressFill = document.createElement('div');
    progressFill.id = 'production-progress';
    progressFill.style.cssText = 'height:100%;background:#0f0;width:0%;transition:width 0.1s;';
    this.progressBar.appendChild(progressFill);
    progressWrap.appendChild(this.progressBar);
    this.container.appendChild(progressWrap);

    // Queue display
    const queueWrap = document.createElement('div');
    queueWrap.style.cssText = 'padding:2px 4px;';
    this.renderQueue(queueWrap);
    this.container.appendChild(queueWrap);

    // Items grid
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:2px;padding:4px;';

    this.hotkeyMap.clear();
    if (this.currentTab === 'Buildings') {
      this.renderBuildingItems(grid);
    } else if (this.currentTab === 'Starport') {
      this.renderStarportItems(grid);
    } else {
      this.renderUnitItems(grid, this.currentTab === 'Infantry');
    }

    this.container.appendChild(grid);
  }

  private renderQueue(container: HTMLElement): void {
    const buildingQ = this.production.getQueue(this.playerId, true);
    const unitQ = this.production.getQueue(this.playerId, false);
    const allItems = [
      ...buildingQ.map((q, i) => ({ ...q, isBuilding: true, index: i })),
      ...unitQ.map((q, i) => ({ ...q, isBuilding: false, index: i })),
    ];
    if (allItems.length === 0) return;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:2px;flex-wrap:wrap;margin-bottom:2px;';

    for (const item of allItems) {
      const chip = document.createElement('div');
      const displayName = getDisplayName(item.typeName);
      const pct = item.progress > 0 ? ` ${Math.floor(item.progress * 100)}%` : '';
      chip.textContent = `${displayName}${pct}`;
      chip.title = 'Right-click to cancel';
      chip.style.cssText = `font-size:9px;padding:2px 4px;background:${item.progress > 0 ? '#2a3a2a' : '#1a1a2e'};color:#aaa;border:1px solid #333;cursor:pointer;border-radius:2px;`;
      chip.oncontextmenu = (e) => {
        e.preventDefault();
        if (this.production.cancelQueueItem(this.playerId, item.isBuilding, item.index)) {
          this.render();
        }
      };
      row.appendChild(chip);
    }
    container.appendChild(row);
  }

  private static getBuildingRole(name: string, def: BuildingDef): string {
    if (def.powerGenerated > 0) return 'power';
    if (def.refinery || name.includes('Silo') || name.includes('Refinery')) return 'economy';
    if (def.aiDefence || def.turretAttach) return 'defense';
    if (name.includes('Barracks') || name.includes('Factory') || name.includes('HiTech') ||
        name.includes('Starport') || name.includes('Palace') || name.includes('Hanger')) return 'production';
    if (name.includes('Research') || name.includes('Outpost') || name.includes('Radar') ||
        name.includes('IX') || name.includes('Upgrade')) return 'tech';
    return 'misc';
  }

  private static readonly ROLE_COLORS: Record<string, string> = {
    power: '#2255cc',
    economy: '#aa8822',
    production: '#228833',
    tech: '#884488',
    defense: '#aa2222',
    misc: '#444466',
    // Unit roles
    infantry: '#228833',
    vehicle: '#886633',
    aircraft: '#5555cc',
  };

  private static readonly ROLE_ORDER: Record<string, number> = {
    power: 0, economy: 1, production: 2, tech: 3, defense: 4, misc: 5,
  };

  /** Convert raw tech levels to sequential tier labels (no gaps) */
  private static getTierLabel(tierIndex: number): string {
    if (tierIndex <= 1) return 'Basic';
    return `Tier ${tierIndex}`;
  }

  private renderBuildingItems(grid: HTMLElement): void {
    const prefix = this.factionPrefix;
    const subPrefix = this.subhousePrefix;
    let hotkeyIdx = 0;

    // Concrete slab button (always available)
    if (this.onConcreteClick) {
      const concreteBtn = document.createElement('button');
      concreteBtn.style.cssText = 'padding:6px 4px;background:linear-gradient(135deg,#1a2a4e,#1a1a3e);border:1px solid #444;color:#ddd;cursor:pointer;font-size:10px;text-align:center;display:flex;align-items:center;gap:4px;';
      concreteBtn.innerHTML = `<span style="display:inline-block;width:14px;height:14px;background:#666;border-radius:2px;flex-shrink:0;"></span><span style="flex:1;text-align:left;"><span style="font-size:11px;font-weight:bold">Concrete</span><br><span style="color:#f0c040;font-size:10px">$20</span></span>`;
      concreteBtn.onclick = () => this.onConcreteClick?.();
      concreteBtn.onmouseenter = () => { concreteBtn.style.borderColor = '#0f0'; };
      concreteBtn.onmouseleave = () => { concreteBtn.style.borderColor = '#444'; };
      grid.appendChild(concreteBtn);
    }

    // Collect and sort buildings by tech tier, then role, then cost
    const buildings: { name: string; def: BuildingDef }[] = [];
    for (const [name, def] of this.rules.buildings) {
      const validPrefix = name.startsWith(prefix) || (subPrefix && name.startsWith(subPrefix));
      if (!validPrefix) continue;
      if (name.startsWith('IN')) continue;
      // Filter out civilian/decorative buildings (IN-prefix after faction prefix)
      const strippedCheck = name.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
      if (strippedCheck.startsWith('IN')) continue;
      // Filter out campaign-only structures and auto-placed sub-buildings
      if (strippedCheck === 'FactoryFrigate' || strippedCheck === 'RefineryDock') continue;
      if (def.cost <= 0) continue;
      buildings.push({ name, def });
    }

    buildings.sort((a, b) => {
      const tierA = Math.max(a.def.techLevel, 1);
      const tierB = Math.max(b.def.techLevel, 1);
      if (tierA !== tierB) return tierA - tierB;
      const roleA = Sidebar.ROLE_ORDER[Sidebar.getBuildingRole(a.name, a.def)] ?? 5;
      const roleB = Sidebar.ROLE_ORDER[Sidebar.getBuildingRole(b.name, b.def)] ?? 5;
      if (roleA !== roleB) return roleA - roleB;
      return a.def.cost - b.def.cost;
    });

    // Compute sequential tier indices (collapse gaps in tech levels)
    const rawTiers = [...new Set(buildings.map(b => Math.max(b.def.techLevel, 1)))].sort((a, b) => a - b);
    const tierIndexMap = new Map<number, number>();
    rawTiers.forEach((t, i) => tierIndexMap.set(t, i + 1));

    // Render with tier separators
    let lastTier = -1;
    for (const { name, def } of buildings) {
      const rawTier = Math.max(def.techLevel, 1);
      const tier = tierIndexMap.get(rawTier) ?? rawTier;
      if (rawTier !== lastTier) {
        lastTier = rawTier;
        const sep = document.createElement('div');
        const label = Sidebar.getTierLabel(tier);
        sep.style.cssText = 'grid-column:1/-1;padding:3px 4px;font-size:9px;color:#888;border-bottom:1px solid #333;text-transform:uppercase;letter-spacing:1px;margin-top:2px;';
        sep.textContent = label;
        grid.appendChild(sep);
      }

      const canBuild = this.production.canBuild(this.playerId, name, true);
      const hotkey = hotkeyIdx < HOTKEYS.length ? HOTKEYS[hotkeyIdx] : undefined;
      const role = Sidebar.getBuildingRole(name, def);
      const adjustedCost = this.production.getAdjustedCost(this.playerId, name, true);
      const item = this.createBuildItem(name, adjustedCost, canBuild, true, hotkey, role);
      grid.appendChild(item);
      if (hotkey && canBuild) {
        this.hotkeyMap.set(hotkey, { name, isBuilding: true });
      }
      hotkeyIdx++;
    }
  }

  private static getUnitRole(name: string, def: UnitDef): string {
    if (name.includes('Harv') || name.includes('harvester')) return 'economy';
    if (def.infantry) return 'infantry';
    if (def.canFly) return 'aircraft';
    if (def.engineer) return 'tech';
    return 'vehicle';
  }

  private renderUnitItems(grid: HTMLElement, infantryOnly: boolean): void {
    const prefix = this.factionPrefix;
    const subPrefix = this.subhousePrefix;
    let hotkeyIdx = 0;

    // Collect and sort units by cost
    const units: { name: string; def: UnitDef }[] = [];
    for (const [name, def] of this.rules.units) {
      if (!name.startsWith(prefix) && !(subPrefix && name.startsWith(subPrefix))) continue;
      if (def.cost <= 0) continue;
      if (infantryOnly && !def.infantry) continue;
      if (!infantryOnly && def.infantry) continue;
      units.push({ name, def });
    }
    units.sort((a, b) => a.def.cost - b.def.cost);

    for (const { name, def } of units) {
      const canBuild = this.production.canBuild(this.playerId, name, false);
      const hotkey = hotkeyIdx < HOTKEYS.length ? HOTKEYS[hotkeyIdx] : undefined;
      const role = Sidebar.getUnitRole(name, def);
      const adjustedCost = this.production.getAdjustedCost(this.playerId, name, false);
      const item = this.createBuildItem(name, adjustedCost, canBuild, false, hotkey, role);
      grid.appendChild(item);
      if (hotkey && canBuild) {
        this.hotkeyMap.set(hotkey, { name, isBuilding: false });
      }
      hotkeyIdx++;
    }
  }

  private renderStarportItems(grid: HTMLElement): void {
    const offers = this.production.getStarportOffers(this.factionPrefix);
    for (const { name, price } of offers) {
      const def = this.rules.units.get(name);
      if (!def) continue;
      const canAfford = this.production.canBuild(this.playerId, name, false);
      const displayName = getDisplayName(name);
      const baseCost = def.cost;
      const priceDelta = price - baseCost;
      const priceColor = priceDelta <= 0 ? '#4f4' : priceDelta > baseCost * 0.3 ? '#f44' : '#ff8';

      const item = document.createElement('button');
      item.style.cssText = `
        padding:4px;background:${canAfford ? '#1a1a3e' : '#0a0a15'};
        border:1px solid ${canAfford ? '#444' : '#222'};color:${canAfford ? '#ddd' : '#555'};
        cursor:${canAfford ? 'pointer' : 'default'};font-size:10px;text-align:center;
      `;
      item.innerHTML = `<div style="font-size:11px;font-weight:bold">${displayName}</div><div style="color:${priceColor};font-size:10px">$${price}</div>`;

      if (canAfford) {
        item.onclick = () => {
          if (this.production.buyFromStarport(this.playerId, name)) {
            this.render();
          }
        };
        item.onmouseenter = () => { item.style.borderColor = '#0f0'; };
        item.onmouseleave = () => { item.style.borderColor = '#444'; };
      }

      grid.appendChild(item);
    }
  }

  private createBuildItem(name: string, cost: number, enabled: boolean, isBuilding: boolean, hotkey?: string, role?: string): HTMLElement {
    // Get block reason for unavailable items
    const blockReason = !enabled ? this.production.getBuildBlockReason(this.playerId, name, isBuilding) : null;
    const isCostBlock = blockReason?.reason === 'cost';
    const isPrereqBlock = blockReason?.reason === 'prereq' || blockReason?.reason === 'tech';

    const item = document.createElement('button');
    const roleColor = role ? (Sidebar.ROLE_COLORS[role] ?? '#444466') : '#444466';

    item.style.cssText = `
      padding:0;background:${enabled ? '#1a1a3e' : '#0a0a15'};
      border:1px solid ${enabled ? '#444' : '#222'};color:${enabled ? '#ddd' : '#555'};
      cursor:${enabled ? 'pointer' : 'default'};font-size:10px;text-align:left;
      position:relative;display:flex;align-items:stretch;overflow:hidden;
      ${isCostBlock ? 'opacity:0.7;' : ''}
    `;

    // Short display name (strip house prefix)
    const displayName = getDisplayName(name);

    // Colored role indicator bar + content
    const iconOpacity = enabled ? '1' : '0.4';
    const costColor = isCostBlock ? '#b8942a' : (enabled ? '#f0c040' : '#665520');
    const hotkeyBadge = hotkey ? `<span style="position:absolute;top:1px;right:3px;font-size:9px;color:${enabled ? '#8cf' : '#335'};font-weight:bold;">${hotkey.toUpperCase()}</span>` : '';
    const repeatBadge = !isBuilding && this.production.isOnRepeat(this.playerId, name)
      ? '<span style="position:absolute;bottom:1px;right:3px;font-size:9px;color:#4f4;">&#x21bb;</span>' : '';

    // Lock icon for prereq/tech blocks
    const lockIcon = isPrereqBlock ? '<span style="font-size:10px;color:#f44;margin-right:2px;">&#x1F512;</span>' : '';
    const blockDetailName = blockReason?.detail ? (DISPLAY_NAMES[blockReason.detail] ?? blockReason.detail) : '';
    const blockDetail = (isPrereqBlock && blockDetailName)
      ? `<div style="font-size:8px;color:#a44;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Need: ${blockDetailName}</div>` : '';

    // Look up 3D model icon
    const art = this.artMap.get(name);
    const iconKey = art?.xaf ?? name;
    const iconUrl = this.iconMap.get(iconKey);
    const iconHtml = iconUrl
      ? `<img src="${iconUrl}" width="36" height="36" style="flex-shrink:0;opacity:${iconOpacity};image-rendering:auto;border-right:1px solid #333;" />`
      : `<div style="width:6px;background:${roleColor};opacity:${iconOpacity};flex-shrink:0;"></div>`;

    item.innerHTML = `
      ${iconHtml}
      <div style="padding:4px 4px;flex:1;min-width:0;">
        ${hotkeyBadge}${repeatBadge}
        <div style="font-size:11px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${lockIcon}${displayName}</div>
        <div style="color:${costColor};font-size:10px;">$${cost}</div>
        ${blockDetail}
      </div>
    `;

    // Tooltip on hover
    item.onmouseenter = (e) => {
      if (enabled) item.style.borderColor = '#0f0';
      this.showTooltip(name, isBuilding, e.clientX, e.clientY, hotkey);
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
      item.onclick = (e: MouseEvent) => {
        // Ctrl+click: toggle repeat mode (units only)
        if ((e.ctrlKey || e.metaKey) && !isBuilding) {
          this.production.toggleRepeat(this.playerId, name);
          this.onBuild(name, isBuilding); // Queue at least one
          this.render(); // Refresh to show repeat indicator
          return;
        }
        // Shift-click: queue 5 at once
        const count = e.shiftKey ? 5 : 1;
        for (let i = 0; i < count; i++) {
          this.onBuild(name, isBuilding);
        }
      };
    }

    return item;
  }

  private showTooltip(name: string, isBuilding: boolean, x: number, y: number, hotkey?: string): void {
    if (!this.tooltip) return;

    const def = isBuilding
      ? this.rules.buildings.get(name)
      : this.rules.units.get(name);
    if (!def) return;

    const displayName = getDisplayName(name);
    const hotkeyHint = hotkey ? ` <span style="color:#8cf;font-size:10px;">[${hotkey.toUpperCase()}]</span>` : '';
    let html = `<div style="font-weight:bold;color:#fff;margin-bottom:4px;">${displayName}${hotkeyHint}</div>`;

    // Role tags
    const tags: string[] = [];
    if (!isBuilding) {
      const u = def as UnitDef;
      if (u.infantry) tags.push('<span style="color:#8cf">Infantry</span>');
      else if (u.canFly) tags.push('<span style="color:#aaf">Aircraft</span>');
      else tags.push('<span style="color:#db8">Vehicle</span>');
      if (u.turretAttach) tags.push('<span style="color:#f88">Combat</span>');
      if (u.engineer) tags.push('<span style="color:#ff0">Engineer</span>');
      if (u.stealth) tags.push('<span style="color:#8f8">Stealth</span>');
      if (u.selfDestruct) tags.push('<span style="color:#f44">Self-Destruct</span>');
      if (u.deviator) tags.push('<span style="color:#f8f">Deviator</span>');
      if (u.crushes) tags.push('<span style="color:#fa8">Crushes Infantry</span>');
      if (name.includes('Harv') || name.includes('harvester')) tags.push('<span style="color:#fd0">Harvester</span>');
    } else {
      const b = def as BuildingDef;
      if (b.refinery) tags.push('<span style="color:#fd0">Refinery</span>');
      if (b.aiDefence) tags.push('<span style="color:#f88">Defense</span>');
      if (b.powerGenerated > 0) tags.push('<span style="color:#4f4">Power</span>');
      if (b.upgradable) tags.push('<span style="color:#8cf">Upgradable</span>');
    }
    if (tags.length > 0) html += `<div style="font-size:10px;margin-bottom:3px;">${tags.join(' ')}</div>`;

    const adjustedCost = this.production.getAdjustedCost(this.playerId, name, isBuilding);
    const costMult = this.production.getCostMultiplier(this.playerId);
    const costSuffix = costMult !== 1.0 ? ` <span style="color:#aaa;font-size:9px;">(${Math.round(costMult * 100)}%)</span>` : '';
    html += `<div style="color:#f0c040;">Cost: $${adjustedCost}${costSuffix}</div>`;
    html += `<div>HP: ${def.health} &middot; Armor: ${def.armour}</div>`;
    const buildSecs = Math.round(def.buildTime / 25);
    html += `<div>Build: ${buildSecs}s</div>`;

    if (!isBuilding) {
      const unitDef = def as UnitDef;
      html += `<div>Speed: ${unitDef.speed.toFixed(1)} &middot; Range: ${unitDef.viewRange}</div>`;
      if (unitDef.starportable) html += `<div style="color:#aaa;font-size:10px;">Available at Starport</div>`;
    } else {
      const bDef = def as BuildingDef;
      if (bDef.powerGenerated > 0) html += `<div style="color:#4f4;">Power: +${bDef.powerGenerated}</div>`;
      if (bDef.powerUsed > 0) html += `<div style="color:#f66;">Power: -${bDef.powerUsed}</div>`;
      if (bDef.getUnitWhenBuilt) {
        const unitName = getDisplayName(bDef.getUnitWhenBuilt);
        html += `<div style="color:#8cf;font-size:10px;">Spawns: ${unitName}</div>`;
      }
      if (bDef.upgradable) {
        const upgraded = this.production.isUpgraded(this.playerId, name);
        html += `<div style="color:${upgraded ? '#4f4' : '#aaa'};font-size:10px;">Upgrade: $${bDef.upgradeCost}${upgraded ? ' (Done)' : ''}</div>`;
      }
    }

    // Requirements
    const reqs: string[] = [];
    if (def.primaryBuilding) {
      const reqName = getDisplayName(def.primaryBuilding);
      reqs.push(reqName);
    }
    if (def.secondaryBuildings) {
      for (const sb of def.secondaryBuildings) {
        reqs.push(getDisplayName(sb));
      }
    }
    if (reqs.length > 0) {
      const canBuild = this.production.canBuild(this.playerId, name, isBuilding);
      const reqColor = canBuild ? '#4f4' : '#f44';
      html += `<div style="color:${reqColor};margin-top:3px;font-size:10px;">Requires: ${reqs.join(', ')}</div>`;
    }

    if (def.techLevel > 0) {
      const playerTech = this.production.getPlayerTechLevel(this.playerId);
      const techMet = def.techLevel <= playerTech;
      html += `<div style="color:${techMet ? '#4f4' : '#f66'};font-size:10px;">Tech Level: ${def.techLevel}${techMet ? '' : ` (have ${playerTech})`}</div>`;
    }

    html += `<div style="color:#555;font-size:9px;margin-top:3px;">Shift+click: build 5${!isBuilding ? ' | Ctrl+click: toggle repeat' : ''}</div>`;

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

    const fill = document.getElementById('production-progress');
    const label = document.getElementById('production-label');

    // Show the active production item
    const prog = buildingProg ?? unitProg;
    if (fill) {
      fill.style.width = prog ? `${prog.progress * 100}%` : '0%';
    }
    if (label) {
      if (prog) {
        const displayName = getDisplayName(prog.typeName);
        label.textContent = `${displayName} ${Math.floor(prog.progress * 100)}%`;
      } else {
        label.textContent = '';
      }
    }
  }

  refresh(): void {
    this.render();
  }
}
