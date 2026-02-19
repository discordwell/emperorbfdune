import * as THREE from 'three';
import type { AudioManager } from '../audio/AudioManager';
import type { Difficulty } from './HouseSelect';
import { CampaignMap3D } from './CampaignMap3D';
import {
  getTerritories, getInitialOwnership, getEnemyHouses,
  getTerritoryName, JUMP_POINTS, HOMEWORLDS,
  type HousePrefix, type TerritoryOwner, type CampaignTerritory,
} from '../campaign/CampaignData';
import { CampaignPhaseManager, type PhaseState } from '../campaign/CampaignPhaseManager';
import { SubHouseSystem, type SubHouseState, type AllianceSubHouse } from '../campaign/SubHouseSystem';
import { lookupMiniBriefing } from '../campaign/MissionConfig';

export interface Territory {
  id: number;
  name: string;
  x: number; // % position on map (for fallback 2D rendering)
  y: number;
  owner: 'player' | 'enemy' | 'enemy2' | 'neutral';
  ownerHouse: TerritoryOwner;
  adjacent: number[];
  mapSeed: number;
  difficulty: 'easy' | 'normal' | 'hard';
  description: string;
  isHomeworld: boolean;
  homeworldOf?: HousePrefix;
  subHouseIndicator?: AllianceSubHouse;
}

export interface CampaignState {
  version: number;
  house: string;
  housePrefix: HousePrefix;
  enemyHouse: string;
  enemyPrefix: HousePrefix;
  enemy2House: string;
  enemy2Prefix: HousePrefix;
  territories: Territory[];
  currentAct: number;
  missionsWon: number;
  phaseState: PhaseState;
  subHouseState: SubHouseState;
  ownership: Record<number, TerritoryOwner>;
}

const SAVE_KEY = 'ebfd_campaign';
const SAVE_VERSION = 2;

// Approximate 2D positions for 36 territories (% coordinates for fallback rendering)
const TERRITORY_2D_POSITIONS: Record<number, { x: number; y: number }> = {
  1:  { x: 15, y: 8 },   2:  { x: 25, y: 12 },  3:  { x: 18, y: 18 },
  4:  { x: 32, y: 18 },  5:  { x: 28, y: 25 },  6:  { x: 20, y: 30 },
  7:  { x: 40, y: 20 },  8:  { x: 38, y: 30 },  9:  { x: 30, y: 35 },
  10: { x: 22, y: 38 },  11: { x: 18, y: 42 },  12: { x: 48, y: 25 },
  13: { x: 46, y: 33 },  14: { x: 42, y: 40 },  15: { x: 35, y: 45 },
  16: { x: 25, y: 48 },  17: { x: 17, y: 52 },  18: { x: 55, y: 35 },
  19: { x: 52, y: 45 },  20: { x: 45, y: 50 },  21: { x: 40, y: 55 },
  22: { x: 32, y: 55 },  23: { x: 22, y: 58 },  24: { x: 62, y: 45 },
  25: { x: 58, y: 53 },  26: { x: 52, y: 58 },  27: { x: 45, y: 60 },
  28: { x: 38, y: 62 },  29: { x: 35, y: 68 },  30: { x: 28, y: 68 },
  31: { x: 32, y: 75 },  32: { x: 65, y: 55 },  33: { x: 70, y: 50 },
  34: { x: 8,  y: 3 },   35: { x: 38, y: 82 },  36: { x: 78, y: 48 },
};

// Colors per house
const HOUSE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  AT: { bg: '#1a2a5a', border: '#4488cc', text: '#88bbff' },
  HK: { bg: '#3a1a1a', border: '#cc4444', text: '#ff8888' },
  OR: { bg: '#1a3a2a', border: '#44cc88', text: '#88ffcc' },
  neutral: { bg: '#333333', border: '#555555', text: '#888888' },
};

export class CampaignMap {
  private overlay: HTMLDivElement;
  private audioManager: AudioManager;
  private state: CampaignState;
  private canvas: HTMLCanvasElement | undefined;
  private renderer: THREE.WebGLRenderer | undefined;
  private phaseManager: CampaignPhaseManager;
  private expandedThisCycle = false;
  private subHouseSystem: SubHouseSystem;

  constructor(
    audioManager: AudioManager,
    housePrefix: string,
    houseName: string,
    enemyPrefix: string,
    enemyName: string,
    canvas?: HTMLCanvasElement,
    renderer?: THREE.WebGLRenderer,
    phaseManager?: CampaignPhaseManager,
    subHouseSystem?: SubHouseSystem,
  ) {
    this.audioManager = audioManager;
    this.overlay = document.createElement('div');
    this.canvas = canvas;
    this.renderer = renderer;

    const hp = housePrefix as HousePrefix;
    const [e1, e2] = getEnemyHouses(hp);
    this.phaseManager = phaseManager ?? new CampaignPhaseManager(hp);
    this.subHouseSystem = subHouseSystem ?? new SubHouseSystem(hp);

    // Try loading saved state
    const saved = this.loadSavedState(hp);
    if (saved) {
      this.state = saved;
      this.phaseManager = CampaignPhaseManager.deserialize(saved.phaseState);
      this.subHouseSystem = SubHouseSystem.deserialize(saved.subHouseState, hp);
    } else {
      // Initialize fresh campaign
      const ownership = getInitialOwnership(hp);
      const territories = this.buildTerritoryList(hp, ownership);

      const enemyHouseNames: Record<HousePrefix, string> = {
        AT: 'Atreides', HK: 'Harkonnen', OR: 'Ordos',
      };

      this.state = {
        version: SAVE_VERSION,
        house: houseName,
        housePrefix: hp,
        enemyHouse: enemyHouseNames[e1],
        enemyPrefix: e1,
        enemy2House: enemyHouseNames[e2],
        enemy2Prefix: e2,
        territories,
        currentAct: this.phaseManager.getAct(),
        missionsWon: 0,
        phaseState: this.phaseManager.serialize(),
        subHouseState: this.subHouseSystem.serialize(),
        ownership: Object.fromEntries(ownership),
      };
    }
  }

  private buildTerritoryList(playerHouse: HousePrefix, ownership: Map<number, TerritoryOwner>): Territory[] {
    const campaignTerritories = getTerritories();
    return campaignTerritories.map(ct => {
      const owner = ownership.get(ct.id) ?? 'neutral';
      const pos = TERRITORY_2D_POSITIONS[ct.id] ?? { x: 50, y: 50 };
      const diff = this.getTerritoryDifficulty(ct.id, playerHouse, ownership);

      return {
        id: ct.id,
        name: getTerritoryName(ct.id),
        x: pos.x,
        y: pos.y,
        owner: this.ownerToDisplay(owner, playerHouse),
        ownerHouse: owner,
        adjacent: ct.adjacent,
        mapSeed: ct.id * 1000 + 42,
        difficulty: diff,
        description: '',
        isHomeworld: ct.isHomeworld,
        homeworldOf: ct.homeworldOf,
      };
    });
  }

  private ownerToDisplay(owner: TerritoryOwner, playerHouse: HousePrefix): 'player' | 'enemy' | 'enemy2' | 'neutral' {
    if (owner === playerHouse) return 'player';
    if (owner === 'neutral') return 'neutral';
    const [e1] = getEnemyHouses(playerHouse);
    return owner === e1 ? 'enemy' : 'enemy2';
  }

  private getTerritoryDifficulty(
    id: number, playerHouse: HousePrefix, ownership: Map<number, TerritoryOwner>,
  ): 'easy' | 'normal' | 'hard' {
    const phase = this.phaseManager.getCurrentPhase();
    if (phase <= 1) return 'easy';
    if (phase >= 3) return 'hard';
    return 'normal';
  }

  getPhaseManager(): CampaignPhaseManager {
    return this.phaseManager;
  }

  getSubHouseSystem(): SubHouseSystem {
    return this.subHouseSystem;
  }

  getState(): CampaignState {
    return this.state;
  }

  saveCampaign(): void {
    this.state.phaseState = this.phaseManager.serialize();
    this.state.subHouseState = this.subHouseSystem.serialize();
    this.state.currentAct = this.phaseManager.getAct();
    localStorage.setItem(SAVE_KEY, JSON.stringify(this.state));
  }

  private loadSavedState(expectedHouse: HousePrefix): CampaignState | null {
    const saved = localStorage.getItem(SAVE_KEY);
    if (!saved) return null;
    try {
      const parsed = JSON.parse(saved) as CampaignState;
      if (parsed.housePrefix !== expectedHouse) return null;
      if (parsed.version !== SAVE_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  recordDefeat(): void {
    this.expandedThisCycle = false; // Allow expansion next time map is shown
    this.saveCampaign();
  }

  recordVictory(territoryId: number): void {
    this.expandedThisCycle = false;
    const t = this.state.territories.find(t => t.id === territoryId);
    if (t) {
      t.owner = 'player';
      t.ownerHouse = this.state.housePrefix;
      this.state.ownership[territoryId] = this.state.housePrefix;
      this.state.missionsWon++;
    }
    this.saveCampaign();
  }

  /** AI enemies capture a neutral territory between missions. */
  expandEnemyTerritory(): void {
    const enemyPrefixes = [this.state.enemyPrefix, this.state.enemy2Prefix];
    for (const prefix of enemyPrefixes) {
      const ownedIds = this.state.territories
        .filter(t => t.ownerHouse === prefix)
        .map(t => t.id);

      // Find neutral territories adjacent to enemy holdings
      const candidates: number[] = [];
      for (const ownedId of ownedIds) {
        const t = this.state.territories.find(t => t.id === ownedId);
        if (!t) continue;
        for (const adjId of t.adjacent) {
          const adj = this.state.territories.find(t => t.id === adjId);
          if (adj && adj.ownerHouse === 'neutral' && !adj.isHomeworld) {
            candidates.push(adjId);
          }
        }
      }

      if (candidates.length > 0) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        const t = this.state.territories.find(t => t.id === pick);
        if (t) {
          t.ownerHouse = prefix;
          t.owner = this.ownerToDisplay(prefix, this.state.housePrefix);
          this.state.ownership[pick] = prefix;
        }
      }
    }
  }

  /** Get territories the player must defend (enemy adjacent to player territory). */
  getDefendableTerritories(): Territory[] {
    return this.state.territories.filter(t =>
      t.owner === 'player' && !t.isHomeworld &&
      t.adjacent.some(adjId => {
        const adj = this.state.territories.find(a => a.id === adjId);
        return adj && (adj.owner === 'enemy' || adj.owner === 'enemy2');
      })
    );
  }

  /** Get territories the player can attack. */
  getAttackableTerritories(): Territory[] {
    return this.state.territories.filter(t =>
      t.owner !== 'player' && !t.isHomeworld &&
      t.adjacent.some(adjId =>
        this.state.territories.find(a => a.id === adjId)?.owner === 'player'
      )
    );
  }

  /** Check if player has captured the relevant jump point. */
  hasJumpPoint(): boolean {
    // Check if player owns any non-own jump point
    for (const [house, jpId] of Object.entries(JUMP_POINTS)) {
      if (house === this.state.housePrefix) continue;
      const t = this.state.territories.find(t => t.id === jpId);
      if (t && t.owner === 'player') return true;
    }
    return false;
  }

  isVictory(): boolean {
    return this.phaseManager.getState().isVictory;
  }

  /** Get the enemy house that owns a specific territory. */
  getTerritoryEnemy(territoryId: number): HousePrefix {
    const t = this.state.territories.find(t => t.id === territoryId);
    if (!t || t.ownerHouse === 'neutral' || t.ownerHouse === this.state.housePrefix) {
      return this.state.enemyPrefix; // Default enemy
    }
    return t.ownerHouse;
  }

  /** Show the campaign map and return the chosen territory + difficulty */
  async show(): Promise<{ territory: Territory; difficulty: Difficulty; mapSeed: number } | null> {
    // AI expands between missions (only once per mission cycle)
    if (!this.expandedThisCycle) {
      this.expandEnemyTerritory();
      this.saveCampaign();
      this.expandedThisCycle = true;
    }

    // Use 3D campaign map if canvas/renderer available
    if (this.canvas && this.renderer) {
      try {
        const map3D = new CampaignMap3D(this.canvas, this.renderer, this.state);
        const territoryId = await map3D.show();
        if (territoryId === null) return null;
        const territory = this.state.territories.find(t => t.id === territoryId);
        if (!territory) return null;
        return { territory, difficulty: territory.difficulty, mapSeed: territory.mapSeed };
      } catch (e) {
        console.warn('3D campaign map failed, using fallback:', e);
      }
    }

    return this.showFallback();
  }

  private showFallback(): Promise<{ territory: Territory; difficulty: Difficulty; mapSeed: number } | null> {
    return new Promise(resolve => {
      this.overlay = document.createElement('div');
      this.overlay.style.cssText = `
        position:fixed;top:0;left:0;right:0;bottom:0;
        background:radial-gradient(ellipse at center, #1a1500 0%, #000 80%);
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        z-index:2000;font-family:'Segoe UI',Tahoma,sans-serif;
      `;

      // Title bar
      const title = document.createElement('div');
      title.style.cssText = 'color:#d4a840;font-size:24px;font-weight:bold;margin-bottom:2px;letter-spacing:2px;';
      title.textContent = 'STRATEGIC BATTLE MAP';
      this.overlay.appendChild(title);

      const actText = document.createElement('div');
      actText.style.cssText = 'color:#888;font-size:13px;margin-bottom:12px;';
      const act = this.phaseManager.getAct();
      const phase = this.phaseManager.getCurrentPhase();
      const playerCount = this.state.territories.filter(t => t.owner === 'player').length;
      const totalArrakis = 33;
      actText.textContent = `${this.state.house} Campaign | Act ${act} (Phase ${phase}) | Tech Level ${this.phaseManager.getCurrentTechLevel()} | Territories: ${playerCount}/${totalArrakis}`;
      this.overlay.appendChild(actText);

      // Map container
      const mapContainer = document.createElement('div');
      mapContainer.style.cssText = `
        position:relative;width:700px;height:500px;
        background:radial-gradient(ellipse at 40% 50%, #2a1f0a 0%, #0a0800 70%);
        border:2px solid #444;border-radius:4px;overflow:hidden;
      `;

      // Connection lines
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '700');
      svg.setAttribute('height', '500');
      svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';

      const drawnEdges = new Set<string>();
      for (const t of this.state.territories) {
        // Hide homeworlds unless Phase 3+
        if (t.isHomeworld && phase < 3) continue;
        for (const adjId of t.adjacent) {
          const edgeKey = [Math.min(t.id, adjId), Math.max(t.id, adjId)].join('-');
          if (drawnEdges.has(edgeKey)) continue;
          drawnEdges.add(edgeKey);
          const adj = this.state.territories.find(a => a.id === adjId);
          if (!adj) continue;
          if (adj.isHomeworld && phase < 3) continue;
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', String(t.x * 7));
          line.setAttribute('y1', String(t.y * 5));
          line.setAttribute('x2', String(adj.x * 7));
          line.setAttribute('y2', String(adj.y * 5));
          line.setAttribute('stroke', '#333');
          line.setAttribute('stroke-width', '1');
          svg.appendChild(line);
        }
      }
      mapContainer.appendChild(svg);

      const descEl = document.createElement('div');
      descEl.style.cssText = 'color:#aaa;font-size:12px;margin-top:10px;max-width:600px;text-align:center;min-height:20px;';
      descEl.textContent = 'Select a territory to attack.';

      // Territory nodes
      for (const t of this.state.territories) {
        if (t.isHomeworld && phase < 3) continue;

        const isAttackable = t.owner !== 'player' && !t.isHomeworld &&
          t.adjacent.some(adjId => this.state.territories.find(a => a.id === adjId)?.owner === 'player');

        const isJumpPoint = Object.values(JUMP_POINTS).includes(t.id) && t.id !== JUMP_POINTS[this.state.housePrefix];

        const colors = HOUSE_COLORS[t.ownerHouse] ?? HOUSE_COLORS.neutral;
        let borderColor = colors.border;
        let textColor = colors.text;
        if (isAttackable) {
          borderColor = '#ff8800';
          textColor = '#ffcc44';
        }

        const node = document.createElement('div');
        node.style.cssText = `
          position:absolute;left:${t.x * 7 - 30}px;top:${t.y * 5 - 14}px;
          width:60px;text-align:center;padding:3px;
          background:${colors.bg};border:1px solid ${borderColor};
          border-radius:3px;cursor:${isAttackable ? 'pointer' : 'default'};
          transition:all 0.2s;font-size:9px;
        `;

        let statusText = t.owner === 'player' ? 'Ours' :
          t.ownerHouse !== 'neutral' ? t.ownerHouse : '';
        if (isJumpPoint && phase >= 3) statusText += ' [JP]';

        node.innerHTML = `
          <div style="font-size:9px;font-weight:bold;color:${textColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.name}</div>
          <div style="font-size:8px;color:#666;">${statusText}</div>
        `;

        if (isAttackable) {
          node.onmouseenter = () => {
            node.style.borderColor = '#ffcc00';
            node.style.transform = 'scale(1.15)';
            node.style.zIndex = '5';
            // Try mini-briefing
            const miniKey = `${this.state.housePrefix}P${phase}M${t.id}`;
            const mini = lookupMiniBriefing(miniKey + 'Mini') ?? lookupMiniBriefing(miniKey + 'MB');
            descEl.textContent = mini ?? `${t.name} [${t.difficulty.toUpperCase()}] - ${t.ownerHouse} territory`;
          };
          node.onmouseleave = () => {
            node.style.borderColor = '#ff8800';
            node.style.transform = 'scale(1)';
            node.style.zIndex = '1';
            descEl.textContent = 'Select a territory to attack.';
          };
          node.onclick = () => {
            this.audioManager.playSfx('select');
            this.overlay.remove();
            resolve({ territory: t, difficulty: t.difficulty, mapSeed: t.mapSeed });
          };
        }

        mapContainer.appendChild(node);
      }

      this.overlay.appendChild(mapContainer);
      this.overlay.appendChild(descEl);

      // Legend
      const legend = document.createElement('div');
      legend.style.cssText = 'display:flex;gap:16px;margin-top:8px;';
      const legendItems: [string, string][] = [
        [HOUSE_COLORS[this.state.housePrefix]?.border ?? '#4488cc', this.state.house],
        [HOUSE_COLORS[this.state.enemyPrefix]?.border ?? '#cc4444', this.state.enemyHouse],
        [HOUSE_COLORS[this.state.enemy2Prefix]?.border ?? '#44cc88', this.state.enemy2House],
        ['#555555', 'Neutral'],
        ['#ff8800', 'Attackable'],
      ];
      for (const [color, label] of legendItems) {
        const item = document.createElement('div');
        item.style.cssText = `font-size:10px;color:#888;display:flex;align-items:center;gap:4px;`;
        item.innerHTML = `<span style="width:10px;height:10px;background:${color};display:inline-block;border-radius:2px;"></span>${label}`;
        legend.appendChild(item);
      }
      this.overlay.appendChild(legend);

      const backBtn = document.createElement('button');
      backBtn.textContent = 'Back to Menu';
      backBtn.style.cssText = 'margin-top:12px;padding:8px 20px;background:#1a1a3e;border:1px solid #444;color:#888;cursor:pointer;font-size:13px;';
      backBtn.onclick = () => {
        this.overlay.remove();
        resolve(null);
      };
      this.overlay.appendChild(backBtn);

      document.body.appendChild(this.overlay);
    });
  }
}
