import {
  Position, Health, Owner, UnitType, BuildingType, Veterancy,
  Combat, Armour, Speed,
  hasComponent, type World,
} from '../core/ECS';
import type { GameRules } from '../config/RulesParser';
import { EventBus } from '../core/EventBus';
import type { AudioManager } from '../audio/AudioManager';
import type { ProductionSystem } from '../simulation/ProductionSystem';

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

  // Message log
  private messageLog: string[] = [];
  private messageContainer: HTMLDivElement;

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
      this.render();
    });
    EventBus.on('unit:deselected', () => {
      this.selectedEntities = [];
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

    // Stats row
    let statsHtml = '';
    const statStyle = 'display:inline-block;margin-right:12px;font-size:11px;';
    const labelStyle = 'color:#888;';
    const valStyle = 'color:#ddd;';

    if (hasComponent(this.world, Combat, eid)) {
      const range = Math.round(Combat.attackRange[eid]);
      statsHtml += `<span style="${statStyle}"><span style="${labelStyle}">Range:</span> <span style="${valStyle}">${range}</span></span>`;
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

    let buttons = '';
    if (isBuilding) {
      // Check if building can be upgraded
      const bDef = def as import('../config/BuildingDefs').BuildingDef | null;
      const canUpgrade = bDef?.upgradable && this.production && !this.production.isUpgraded(0, typeName)
        && this.production.canUpgrade(0, typeName);
      const upgradeBtn = canUpgrade
        ? `<button id="upgrade-btn" style="padding:4px 12px;background:#111144;border:1px solid #44f;color:#88f;cursor:pointer;font-size:11px;">Upgrade $${bDef!.upgradeCost}</button>`
        : '';
      buttons = `
        ${upgradeBtn}
        <button id="sell-btn" style="padding:4px 12px;background:#441111;border:1px solid #f44;color:#f88;cursor:pointer;font-size:11px;">Sell</button>
        <button id="repair-btn" style="padding:4px 12px;background:#114411;border:1px solid #4f4;color:#8f8;cursor:pointer;font-size:11px;">Repair</button>
      `;
    }

    this.container.innerHTML = `
      <div style="flex:1;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">
          <span style="font-size:16px;font-weight:bold;color:#fff;">${displayName}</span>
          ${vetHtml}
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <div style="flex:1;height:6px;background:#333;border-radius:3px;overflow:hidden;">
            <div style="height:100%;width:${hpPct}%;background:${hpColor};"></div>
          </div>
          <span style="font-size:11px;color:${hpColor};">${Math.ceil(hp)}/${maxHp}</span>
        </div>
        <div>${statsHtml}</div>
      </div>
      <div style="display:flex;gap:6px;">${buttons}</div>
    `;

    // Wire up buttons
    const sellBtn = document.getElementById('sell-btn');
    if (sellBtn) {
      sellBtn.onclick = () => {
        this.audioManager.playSfx('sell');
        this.onSell(eid);
      };
    }
    const repairBtn = document.getElementById('repair-btn');
    if (repairBtn) {
      repairBtn.onclick = () => {
        this.audioManager.playSfx('build');
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
  }

  private renderMulti(): void {
    const count = this.selectedEntities.length;
    this.container.innerHTML = `
      <div style="flex:1;">
        <div style="font-size:14px;font-weight:bold;color:#fff;">${count} units selected</div>
        <div style="font-size:11px;color:#888;">Right-click to move, A for attack-move</div>
      </div>
    `;
  }
}
