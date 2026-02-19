import {
  Position, Health, Owner, UnitType, BuildingType, Veterancy,
  Combat, Armour, Speed, Harvester,
  hasComponent, type World,
} from '../core/ECS';
import type { GameRules } from '../config/RulesParser';
import { EventBus } from '../core/EventBus';
import type { AudioManager } from '../audio/AudioManager';
import type { ProductionSystem } from '../simulation/ProductionSystem';
import type { CombatSystem } from '../simulation/CombatSystem';

type SellCallback = (eid: number) => void;
type RepairCallback = (eid: number) => void;
type UpgradeCallback = (eid: number, buildingType: string) => void;

export class SelectionPanel {
  private container: HTMLElement;
  private rules: GameRules;
  private audioManager: AudioManager;
  private selectedEntities: number[] = [];
  private world: World | null = null;
  private unitTypeNames: string[];
  private buildingTypeNames: string[];
  private onSell: SellCallback;
  private onRepair: RepairCallback;
  private onUpgrade: UpgradeCallback | null = null;
  private production: ProductionSystem | null = null;
  private combatSystem: CombatSystem | null = null;

  // Message log
  private messageLog: string[] = [];
  private messageContainer: HTMLDivElement;
  private sellConfirmEid: number | null = null;
  private sellConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private passengerCountFn: ((eid: number) => number) | null = null;
  private isRepairingFn: ((eid: number) => boolean) | null = null;
  private aircraftAmmoFn: ((eid: number) => { current: number; max: number } | null) | null = null;
  private playerFaction = 'AT';
  private panToFn: ((x: number, z: number) => void) | null = null;
  private deselectFn: ((eid: number) => void) | null = null;

  constructor(
    rules: GameRules,
    audioManager: AudioManager,
    unitTypeNames: string[],
    buildingTypeNames: string[],
    onSell: SellCallback,
    onRepair: RepairCallback
  ) {
    this.container = document.getElementById('selection-info')!;
    this.rules = rules;
    this.audioManager = audioManager;
    this.unitTypeNames = unitTypeNames;
    this.buildingTypeNames = buildingTypeNames;
    this.onSell = onSell;
    this.onRepair = onRepair;

    // Message log container
    this.messageContainer = document.createElement('div');
    this.messageContainer.style.cssText = `
      position: fixed; bottom: 130px; left: 210px;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      font-size: 12px; color: #fff;
      pointer-events: none; z-index: 15;
    `;
    document.body.appendChild(this.messageContainer);

    // Listen for events
    EventBus.on('unit:selected', ({ entityIds }) => {
      this.selectedEntities = entityIds;
      this.sellConfirmEid = null;
      this.render();
    });
    EventBus.on('unit:deselected', () => {
      this.selectedEntities = [];
      this.sellConfirmEid = null;
      this.render();
    });
    EventBus.on('unit:died', ({ entityId }) => {
      this.addMessage('Unit destroyed', '#ff4444');
    });
    EventBus.on('production:complete', ({ unitType }) => {
      const name = unitType.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
      this.addMessage(`${name} ready`, '#44ff44');
    });
    EventBus.on('harvest:delivered', ({ amount }) => {
      this.addMessage(`+${Math.floor(amount)} Solaris`, '#f0c040');
    });
  }

  setWorld(world: World): void {
    this.world = world;
  }

  setProductionSystem(prod: ProductionSystem, onUpgrade: UpgradeCallback): void {
    this.production = prod;
    this.onUpgrade = onUpgrade;
  }

  setCombatSystem(combat: CombatSystem): void {
    this.combatSystem = combat;
  }

  setPassengerCountFn(fn: (eid: number) => number): void {
    this.passengerCountFn = fn;
  }

  setRepairingFn(fn: (eid: number) => boolean): void {
    this.isRepairingFn = fn;
  }

  setAircraftAmmoFn(fn: (eid: number) => { current: number; max: number } | null): void {
    this.aircraftAmmoFn = fn;
  }

  setPlayerFaction(prefix: string): void {
    this.playerFaction = prefix;
  }

  setPanToFn(fn: (x: number, z: number) => void): void {
    this.panToFn = fn;
  }

  setDeselectFn(fn: (eid: number) => void): void {
    this.deselectFn = fn;
  }

  /** Refresh the panel display (call periodically to update dynamic info like upgrade progress, repair state) */
  refresh(): void {
    if (this.selectedEntities.length > 0) {
      this.render();
    }
  }

  addMessage(text: string, color = '#ccc'): void {
    this.messageLog.push(text);
    if (this.messageLog.length > 5) this.messageLog.shift();

    const msg = document.createElement('div');
    msg.style.cssText = `color:${color}; margin-bottom:2px; text-shadow: 0 0 4px #000; opacity: 1; transition: opacity 3s;`;
    msg.textContent = text;
    this.messageContainer.appendChild(msg);

    setTimeout(() => { msg.style.opacity = '0'; }, 3000);
    setTimeout(() => { msg.remove(); }, 6000);
  }

  private render(): void {
    if (this.selectedEntities.length === 0 || !this.world) {
      this.container.style.display = 'none';
      return;
    }

    this.container.style.display = 'flex';
    this.container.style.cssText += `
      flex-direction: row; align-items: center;
      padding: 8px 16px; gap: 12px;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      color: #ccc; font-size: 13px;
    `;

    if (this.selectedEntities.length === 1) {
      this.renderSingle(this.selectedEntities[0]);
    } else {
      this.renderMulti();
    }
  }

  private renderSingle(eid: number): void {
    if (!this.world) return;
    const isBuilding = hasComponent(this.world, BuildingType, eid);
    const isUnit = hasComponent(this.world, UnitType, eid);

    let typeName = 'Unknown';
    let def: any = null;
    if (isBuilding) {
      const typeId = BuildingType.id[eid];
      typeName = this.buildingTypeNames[typeId] ?? 'Building';
      def = this.rules.buildings.get(typeName);
    } else if (isUnit) {
      const typeId = UnitType.id[eid];
      typeName = this.unitTypeNames[typeId] ?? 'Unit';
      def = this.rules.units.get(typeName);
    }

    const displayName = typeName.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '');
    const hp = Health.current[eid];
    const maxHp = Health.max[eid];
    const hpPct = maxHp > 0 ? Math.round((hp / maxHp) * 100) : 0;
    const hpColor = hpPct > 60 ? '#0f0' : hpPct > 30 ? '#ff0' : '#f00';

    // Role tags
    let roleHtml = '';
    if (isUnit && def) {
      const tags: string[] = [];
      if (def.infantry) tags.push('<span style="color:#8cf">Infantry</span>');
      else if (def.canFly) tags.push('<span style="color:#aaf">Aircraft</span>');
      else tags.push('<span style="color:#db8">Vehicle</span>');
      if (def.stealth) tags.push('<span style="color:#8f8">Stealth</span>');
      if (def.engineer) tags.push('<span style="color:#ff0">Engineer</span>');
      if (def.crushes) tags.push('<span style="color:#fa8">Crushes</span>');
      if (def.apc && this.passengerCountFn) {
        const pCount = this.passengerCountFn(eid);
        tags.push(`<span style="color:#8ff">Transport [${pCount}/${def.passengerCapacity}]</span>`);
      }
      if (tags.length > 0) roleHtml = `<div style="font-size:10px;margin-bottom:2px;">${tags.join(' ')}</div>`;
    }

    // Harvester spice load and state display
    let harvesterHtml = '';
    if (isUnit && hasComponent(this.world, Harvester, eid)) {
      const carried = Harvester.spiceCarried[eid];
      const maxCap = Harvester.maxCapacity[eid];
      const loadPct = maxCap > 0 ? Math.round((carried / maxCap) * 100) : 0;
      const stateNames = ['Idle', 'Moving to Spice', 'Harvesting', 'Returning', 'Unloading'];
      const stateColors = ['#888', '#ff8', '#FFD700', '#4af', '#4f4'];
      const state = Harvester.state[eid];
      harvesterHtml = `
        <div style="margin-bottom:3px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:1px;">
            <span style="font-size:10px;color:#FFD700;">Spice Load:</span>
            <div style="flex:1;height:5px;background:#333;border-radius:2px;overflow:hidden;">
              <div style="height:100%;width:${loadPct}%;background:#FFD700;"></div>
            </div>
            <span style="font-size:10px;color:#FFD700;">${loadPct}%</span>
          </div>
          <span style="font-size:10px;color:${stateColors[state] ?? '#888'};">${stateNames[state] ?? 'Unknown'}</span>
        </div>`;
    }

    // Aircraft ammo display
    let ammoHtml = '';
    if (isUnit && this.aircraftAmmoFn) {
      const ammoInfo = this.aircraftAmmoFn(eid);
      if (ammoInfo) {
        const ammoPct = ammoInfo.max > 0 ? Math.round((ammoInfo.current / ammoInfo.max) * 100) : 0;
        const ammoColor = ammoInfo.current > 0 ? '#88aaff' : '#ff4444';
        const statusText = ammoInfo.current <= 0 ? ' (Rearming)' : '';
        ammoHtml = `
          <div style="margin-bottom:3px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:1px;">
              <span style="font-size:10px;color:${ammoColor};">Ammo:</span>
              <div style="flex:1;height:5px;background:#333;border-radius:2px;overflow:hidden;">
                <div style="height:100%;width:${ammoPct}%;background:${ammoColor};"></div>
              </div>
              <span style="font-size:10px;color:${ammoColor};">${ammoInfo.current}/${ammoInfo.max}${statusText}</span>
            </div>
          </div>`;
      }
    }

    // Stats row
    let statsHtml = '';
    const statStyle = 'display:inline-block;margin-right:12px;font-size:11px;';
    const labelStyle = 'color:#888;';
    const valStyle = 'color:#ddd;';

    if (hasComponent(this.world, Combat, eid)) {
      const range = Math.round(Combat.attackRange[eid]);
      const rof = Combat.rof[eid];
      const dps = rof > 0 ? (25 / rof).toFixed(1) : '0';
      statsHtml += `<span style="${statStyle}"><span style="${labelStyle}">Range:</span> <span style="${valStyle}">${range}</span></span>`;
      statsHtml += `<span style="${statStyle}"><span style="${labelStyle}">DPS:</span> <span style="${valStyle}">${dps}</span></span>`;
    }
    if (hasComponent(this.world, Speed, eid) && Speed.max[eid] > 0) {
      const spd = Speed.max[eid].toFixed(1);
      statsHtml += `<span style="${statStyle}"><span style="${labelStyle}">Speed:</span> <span style="${valStyle}">${spd}</span></span>`;
    }
    if (hasComponent(this.world, Armour, eid)) {
      const armourIdx = Armour.type[eid];
      const armourName = this.rules.armourTypes[armourIdx] ?? 'None';
      statsHtml += `<span style="${statStyle}"><span style="${labelStyle}">Armor:</span> <span style="${valStyle}">${armourName}</span></span>`;
    }
    if (isBuilding && def) {
      if (def.powerGenerated > 0) statsHtml += `<span style="${statStyle}"><span style="color:#4f4">Power: +${def.powerGenerated}</span></span>`;
      if (def.powerUsed > 0) statsHtml += `<span style="${statStyle}"><span style="color:#f66">Power: -${def.powerUsed}</span></span>`;
    }

    // Veterancy
    let vetHtml = '';
    if (hasComponent(this.world, Veterancy, eid)) {
      const rank = Veterancy.rank[eid];
      const xp = Veterancy.xp[eid];
      if (rank > 0) {
        const rankNames = ['', 'Veteran', 'Elite', 'Heroic'];
        const rankColors = ['', '#CD7F32', '#C0C0C0', '#FFD700'];
        vetHtml = `<span style="font-size:11px;color:${rankColors[rank]};font-weight:bold;">${rankNames[rank]} (${xp} kills)</span>`;
      }
    }

    // Combat effectiveness (damage degradation indicator for non-Harkonnen)
    let effectivenessHtml = '';
    const unitFaction = typeName.substring(0, 2);
    if (isUnit && hasComponent(this.world, Combat, eid) && hpPct < 100 && unitFaction !== 'HK') {
      const hpRatio = maxHp > 0 ? hp / maxHp : 1;
      const effectiveness = Math.round((0.5 + hpRatio * 0.5) * 100);
      const effColor = effectiveness > 85 ? '#4f4' : effectiveness > 65 ? '#ff8' : '#f88';
      effectivenessHtml = `<span style="font-size:10px;color:${effColor};" title="Damaged units deal less damage (Harkonnen immune)">Combat: ${effectiveness}%</span>`;
    }

    // Attack-move / escort status (escort takes priority over attack-move)
    let statusHtml = '';
    if (isUnit && this.combatSystem) {
      const escortTarget = this.combatSystem.getEscortTarget(eid);
      if (escortTarget !== undefined) {
        statusHtml = '<span style="font-size:10px;color:#8cf;font-weight:bold;">ESCORTING</span>';
      } else if (this.combatSystem.isAttackMove(eid)) {
        statusHtml = '<span style="font-size:10px;color:#ff8800;font-weight:bold;">ATTACK-MOVE</span>';
      }
    }

    // Stance display for units
    let stanceHtml = '';
    if (isUnit && this.combatSystem && hasComponent(this.world!, Combat, eid)) {
      const stance = this.combatSystem.getStance(eid);
      const stanceNames = ['Aggressive', 'Defensive', 'Hold Position'];
      const stanceColors = ['#f44', '#4af', '#888'];
      const stanceIcons = ['\u2694', '\u26e8', '\u2693']; // crossed swords, shield, anchor
      stanceHtml = `<span id="stance-btn" style="font-size:11px;color:${stanceColors[stance]};cursor:pointer;">${stanceIcons[stance]} ${stanceNames[stance]}</span> <span style="font-size:9px;color:#666;">(V)</span>`;
    }

    // Upgrade progress bar (for buildings with active upgrade)
    let upgradeProgressHtml = '';
    if (isBuilding && this.production) {
      const upProg = this.production.getUpgradeProgress(0, typeName);
      if (upProg) {
        const pct = Math.round(upProg.progress * 100);
        upgradeProgressHtml = `
          <div style="margin-bottom:3px;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:1px;">
              <span style="font-size:10px;color:#88f;">Upgrading:</span>
              <div style="flex:1;height:5px;background:#222;border-radius:2px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#44f,#88f);transition:width 0.3s;"></div>
              </div>
              <span style="font-size:10px;color:#88f;">${pct}%</span>
            </div>
          </div>`;
      } else if (this.production.isUpgraded(0, typeName)) {
        upgradeProgressHtml = `<div style="font-size:10px;color:#4f4;margin-bottom:2px;">&#x2713; Upgraded</div>`;
      }
    }

    let buttons = '';
    if (isBuilding) {
      // Check if building can be upgraded
      const bDef = def as import('../config/BuildingDefs').BuildingDef | null;
      const canUpgrade = bDef?.upgradable && this.production && !this.production.isUpgraded(0, typeName)
        && this.production.canUpgrade(0, typeName);
      // Don't show upgrade button if upgrade is already in progress
      const upgradeInProgress = this.production?.getUpgradeProgress(0, typeName) != null;
      const adjustedUpgradeCost = bDef
        ? (this.production ? Math.round(bDef.upgradeCost * this.production.getCostMultiplier(0)) : bDef.upgradeCost)
        : 0;
      const upgradeBtn = (canUpgrade && !upgradeInProgress)
        ? `<button id="upgrade-btn" style="padding:4px 12px;background:#111144;border:1px solid #44f;color:#88f;cursor:pointer;font-size:11px;">Upgrade $${adjustedUpgradeCost}</button>`
        : '';
      const sellHpRatio = maxHp > 0 ? hp / maxHp : 1;
      const refund = def ? Math.floor(def.cost * 0.5 * sellHpRatio) : 0;
      const isSellConfirm = this.sellConfirmEid === eid;
      const sellLabel = isSellConfirm ? `Confirm Sell ($${refund})` : `Sell ($${refund})`;
      const sellBg = isSellConfirm ? '#661111' : '#441111';
      const sellBorder = isSellConfirm ? '#ff4' : '#f44';
      const sellColor = isSellConfirm ? '#ff4' : '#f88';
      buttons = `
        ${upgradeBtn}
        <button id="sell-btn" style="padding:4px 12px;background:${sellBg};border:1px solid ${sellBorder};color:${sellColor};cursor:pointer;font-size:11px;">${sellLabel}</button>
        <button id="repair-btn" style="padding:4px 12px;background:${this.isRepairingFn?.(eid) ? '#225522' : '#114411'};border:1px solid ${this.isRepairingFn?.(eid) ? '#8f8' : '#4f4'};color:${this.isRepairingFn?.(eid) ? '#afa' : '#8f8'};cursor:pointer;font-size:11px;">${this.isRepairingFn?.(eid) ? 'Repairing...' : 'Repair'}</button>
      `;
    }

    this.container.innerHTML = `
      <div style="flex:1;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">
          <span style="font-size:16px;font-weight:bold;color:#fff;">${displayName}</span>
          ${vetHtml}
        </div>
        ${roleHtml}
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <div style="flex:1;height:6px;background:#333;border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${hpPct}%;background:${hpColor};"></div>
          </div>
          <span style="font-size:11px;color:${hpColor};">${Math.ceil(hp)}/${maxHp}</span>
        </div>
        ${harvesterHtml}
        ${ammoHtml}
        ${upgradeProgressHtml}
        <div>${statsHtml}</div>
        ${effectivenessHtml || statusHtml ? `<div style="margin-top:2px;display:flex;gap:10px;">${effectivenessHtml}${statusHtml}</div>` : ''}
        ${stanceHtml ? `<div style="margin-top:2px;">${stanceHtml}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;">${buttons}</div>
    `;

    // Wire up buttons
    const sellBtn = document.getElementById('sell-btn');
    if (sellBtn) {
      sellBtn.onclick = () => {
        if (this.sellConfirmEid === eid) {
          // Second click - confirm sell
          if (this.sellConfirmTimer) clearTimeout(this.sellConfirmTimer);
          this.sellConfirmEid = null;
          this.sellConfirmTimer = null;
          this.audioManager.playSfx('sell');
          this.onSell(eid);
        } else {
          // First click - enter confirm state
          this.sellConfirmEid = eid;
          if (this.sellConfirmTimer) clearTimeout(this.sellConfirmTimer);
          this.sellConfirmTimer = setTimeout(() => {
            this.sellConfirmEid = null;
            this.sellConfirmTimer = null;
            this.render();
          }, 3000);
          this.render();
        }
      };
    }
    const repairBtn = document.getElementById('repair-btn');
    if (repairBtn) {
      repairBtn.onclick = () => {
        this.onRepair(eid);
      };
    }
    const upgradeBtn = document.getElementById('upgrade-btn');
    if (upgradeBtn) {
      upgradeBtn.onclick = () => {
        this.audioManager.playSfx('build');
        this.onUpgrade?.(eid, typeName);
      };
    }
    const stanceBtn = document.getElementById('stance-btn');
    if (stanceBtn && this.combatSystem) {
      stanceBtn.onclick = () => {
        const current = this.combatSystem!.getStance(eid);
        const next = (current + 1) % 3;
        this.combatSystem!.setStance(eid, next);
        this.audioManager.playSfx('select');
        this.render();
      };
    }
  }

  private renderMulti(): void {
    if (!this.world) return;
    const count = this.selectedEntities.length;

    // Group units by type for summary
    const typeCounts = new Map<string, number>();
    let totalHp = 0, totalMaxHp = 0;
    for (const eid of this.selectedEntities) {
      const isUnit = hasComponent(this.world, UnitType, eid);
      let name = 'Unit';
      if (isUnit) {
        const typeId = UnitType.id[eid];
        name = this.unitTypeNames[typeId]?.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '') ?? 'Unit';
      }
      typeCounts.set(name, (typeCounts.get(name) ?? 0) + 1);
      totalHp += Health.current[eid];
      totalMaxHp += Health.max[eid];
    }

    // Build group summary (e.g. "4x LightInf, 2x Buzzsaw")
    const groups = [...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, ct]) => `<span style="color:#aaa;">${ct}x</span> <span style="color:#ddd;">${name}</span>`)
      .join('<span style="color:#444;"> | </span>');
    const moreTypes = typeCounts.size > 4 ? `<span style="color:#666;"> +${typeCounts.size - 4} types</span>` : '';

    // Overall health bar
    const avgRatio = totalMaxHp > 0 ? totalHp / totalMaxHp : 1;
    const avgColor = avgRatio > 0.6 ? '#0f0' : avgRatio > 0.3 ? '#ff0' : '#f00';

    // Build portrait grid (max 20 shown)
    let gridHtml = '';
    const shown = this.selectedEntities.slice(0, 20);
    for (const eid of shown) {
      const isUnit = hasComponent(this.world, UnitType, eid);
      let name = 'Unit';
      if (isUnit) {
        const typeId = UnitType.id[eid];
        name = this.unitTypeNames[typeId]?.replace(/^(AT|HK|OR|GU|IX|FR|IM|TL)/, '') ?? 'Unit';
      }
      const hp = Health.current[eid];
      const maxHp = Health.max[eid];
      const ratio = maxHp > 0 ? hp / maxHp : 1;
      const barColor = ratio > 0.6 ? '#0f0' : ratio > 0.3 ? '#ff0' : '#f00';
      const initial = name.charAt(0).toUpperCase();

      gridHtml += `
        <div class="unit-portrait" data-eid="${eid}" style="width:32px;text-align:center;font-size:9px;color:#aaa;cursor:pointer;" title="${name} — Click: pan, Ctrl+Click: deselect">
          <div style="width:28px;height:28px;margin:0 auto 2px;background:#1a1a3e;border:1px solid #444;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;color:#fff;">${initial}</div>
          <div style="width:28px;height:3px;margin:0 auto;background:#333;">
            <div style="height:100%;width:${Math.round(ratio * 100)}%;background:${barColor};"></div>
          </div>
        </div>
      `;
    }

    const moreText = count > 20 ? `<span style="color:#888;font-size:10px;">+${count - 20} more</span>` : '';

    // Dominant stance for multi-selection
    let stanceHtml = '';
    if (this.combatSystem) {
      const stanceCounts = [0, 0, 0];
      for (const eid of this.selectedEntities) {
        if (hasComponent(this.world!, Combat, eid)) {
          stanceCounts[this.combatSystem.getStance(eid)]++;
        }
      }
      const totalCombat = stanceCounts[0] + stanceCounts[1] + stanceCounts[2];
      if (totalCombat > 0) {
        const stanceNames = ['Aggressive', 'Defensive', 'Hold'];
        const stanceColors = ['#f44', '#4af', '#888'];
        const stanceIcons = ['\u2694', '\u26e8', '\u2693'];
        const dominant = stanceCounts.indexOf(Math.max(...stanceCounts));
        const allSame = stanceCounts[dominant] === totalCombat;
        stanceHtml = `<div style="font-size:11px;margin-bottom:2px;"><span style="color:${stanceColors[dominant]};">${stanceIcons[dominant]} ${stanceNames[dominant]}${allSame ? '' : ' (mixed)'}</span> <span style="color:#666;font-size:9px;">(V)</span></div>`;
      }
    }

    this.container.innerHTML = `
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:bold;color:#fff;margin-bottom:2px;">${count} units selected</div>
        <div style="font-size:11px;margin-bottom:4px;">${groups}${moreTypes}</div>
        ${stanceHtml}
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <div style="flex:1;height:4px;background:#333;border-radius:2px;overflow:hidden;">
            <div style="height:100%;width:${Math.round(avgRatio * 100)}%;background:${avgColor};"></div>
          </div>
          <span style="font-size:10px;color:${avgColor};">${Math.round(avgRatio * 100)}%</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:2px;">${gridHtml}${moreText}</div>
      </div>
    `;

    // Wire up portrait click handlers
    const portraits = this.container.querySelectorAll('.unit-portrait');
    portraits.forEach((el) => {
      const eid = parseInt((el as HTMLElement).dataset.eid ?? '0', 10);
      (el as HTMLElement).addEventListener('click', (ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          // Ctrl+click: remove from selection
          if (this.deselectFn) this.deselectFn(eid);
        } else {
          // Click: pan camera to unit
          if (this.panToFn && this.world && hasComponent(this.world, Position, eid)) {
            this.panToFn(Position.x[eid], Position.z[eid]);
          }
        }
      });
      // Hover highlight
      (el as HTMLElement).addEventListener('mouseenter', () => {
        (el.querySelector('div') as HTMLElement).style.borderColor = '#88f';
      });
      (el as HTMLElement).addEventListener('mouseleave', () => {
        (el.querySelector('div') as HTMLElement).style.borderColor = '#444';
      });
    });
  }
}
