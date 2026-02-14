import * as THREE from 'three';
import type { AudioManager } from '../audio/AudioManager';
import type { Difficulty } from './HouseSelect';
import { CampaignMap3D } from './CampaignMap3D';

export interface Territory {
  id: number;
  name: string;
  x: number; // % position on map
  y: number;
  owner: 'player' | 'enemy' | 'neutral';
  adjacent: number[]; // IDs of connected territories
  mapSeed: number;
  difficulty: 'easy' | 'normal' | 'hard';
  description: string;
}

export interface CampaignState {
  house: string;
  housePrefix: string;
  enemyHouse: string;
  enemyPrefix: string;
  territories: Territory[];
  currentAct: number; // 1-3
  missionsWon: number;
}

const TERRITORY_TEMPLATES: Omit<Territory, 'owner'>[] = [
  { id: 0, name: 'Carthag Basin', x: 20, y: 30, adjacent: [1, 3], mapSeed: 1000, difficulty: 'easy', description: 'A wide desert basin near the Carthag spaceport. Light enemy presence.' },
  { id: 1, name: 'Habbanya Ridge', x: 40, y: 20, adjacent: [0, 2, 4], mapSeed: 1001, difficulty: 'easy', description: 'Rocky ridge with scattered spice fields. Good defensive terrain.' },
  { id: 2, name: 'Wind Pass', x: 60, y: 15, adjacent: [1, 5], mapSeed: 1002, difficulty: 'normal', description: 'A narrow canyon pass battered by constant sandstorms.' },
  { id: 3, name: 'Arrakeen Flats', x: 25, y: 55, adjacent: [0, 4, 6], mapSeed: 1003, difficulty: 'normal', description: 'Open desert near the capital. Rich spice deposits attract worms.' },
  { id: 4, name: 'Sietch Tabr', x: 50, y: 45, adjacent: [1, 3, 5, 7], mapSeed: 2000, difficulty: 'normal', description: 'Central crossroads territory. Controls access to the deep desert.' },
  { id: 5, name: 'Shield Wall', x: 70, y: 35, adjacent: [2, 4, 8], mapSeed: 2001, difficulty: 'normal', description: 'Mountainous terrain near the Shield Wall. Heavily defended.' },
  { id: 6, name: 'Spice Fields', x: 30, y: 75, adjacent: [3, 7], mapSeed: 2002, difficulty: 'hard', description: 'The richest spice fields on Arrakis. A strategic prize.' },
  { id: 7, name: 'Old Gap', x: 55, y: 70, adjacent: [4, 6, 8], mapSeed: 3000, difficulty: 'hard', description: 'Ancient rock formations hide enemy strongholds.' },
  { id: 8, name: 'Enemy Capital', x: 75, y: 65, adjacent: [5, 7], mapSeed: 3001, difficulty: 'hard', description: 'The enemy\'s main base of operations. Final battle.' },
];

export class CampaignMap {
  private overlay: HTMLDivElement;
  private audioManager: AudioManager;
  private state: CampaignState;
  private canvas: HTMLCanvasElement | undefined;
  private renderer: THREE.WebGLRenderer | undefined;

  constructor(audioManager: AudioManager, housePrefix: string, houseName: string, enemyPrefix: string, enemyName: string, canvas?: HTMLCanvasElement, renderer?: THREE.WebGLRenderer) {
    this.audioManager = audioManager;
    this.overlay = document.createElement('div');
    this.canvas = canvas;
    this.renderer = renderer;

    // Initialize territories
    const territories: Territory[] = TERRITORY_TEMPLATES.map(t => ({
      ...t,
      owner: t.id <= 1 ? 'player' as const : t.id >= 7 ? 'enemy' as const : 'neutral' as const,
    }));

    this.state = {
      house: houseName,
      housePrefix,
      enemyHouse: enemyName,
      enemyPrefix,
      territories,
      currentAct: 1,
      missionsWon: 0,
    };

    // Load saved campaign if exists
    const saved = localStorage.getItem('ebfd_campaign');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.housePrefix === housePrefix) {
          this.state = parsed;
        }
      } catch { /* ignore corrupt save */ }
    }
  }

  saveCampaign(): void {
    localStorage.setItem('ebfd_campaign', JSON.stringify(this.state));
  }

  recordVictory(territoryId: number): void {
    const t = this.state.territories.find(t => t.id === territoryId);
    if (t) {
      t.owner = 'player';
      this.state.missionsWon++;
      // Update act based on progress
      const playerCount = this.state.territories.filter(t => t.owner === 'player').length;
      if (playerCount >= 7) this.state.currentAct = 3;
      else if (playerCount >= 4) this.state.currentAct = 2;
    }
    this.saveCampaign();
  }

  isVictory(): boolean {
    return this.state.territories.every(t => t.owner === 'player');
  }

  /** Show the campaign map and return the chosen territory + difficulty */
  async show(): Promise<{ territory: Territory; difficulty: Difficulty; mapSeed: number } | null> {
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

    // Fallback: DOM-based campaign map
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

      const title = document.createElement('div');
      title.style.cssText = 'color:#d4a840;font-size:28px;font-weight:bold;margin-bottom:4px;letter-spacing:2px;';
      title.textContent = `${this.state.house} Campaign`;
      this.overlay.appendChild(title);

      const actText = document.createElement('div');
      actText.style.cssText = 'color:#888;font-size:14px;margin-bottom:20px;';
      const actNames = ['', 'Establishing Control', 'Desert War', 'Final Assault'];
      actText.textContent = `Act ${this.state.currentAct}: ${actNames[this.state.currentAct]} | Territories: ${this.state.territories.filter(t => t.owner === 'player').length}/${this.state.territories.length}`;
      this.overlay.appendChild(actText);

      const mapContainer = document.createElement('div');
      mapContainer.style.cssText = `
        position:relative;width:600px;height:400px;
        background:radial-gradient(ellipse at 40% 50%, #2a1f0a 0%, #0a0800 70%);
        border:2px solid #444;border-radius:4px;overflow:hidden;
      `;

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '600');
      svg.setAttribute('height', '400');
      svg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';

      for (const t of this.state.territories) {
        for (const adjId of t.adjacent) {
          if (adjId > t.id) {
            const adj = this.state.territories.find(a => a.id === adjId);
            if (!adj) continue;
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', String(t.x * 6));
            line.setAttribute('y1', String(t.y * 4));
            line.setAttribute('x2', String(adj.x * 6));
            line.setAttribute('y2', String(adj.y * 4));
            line.setAttribute('stroke', '#333');
            line.setAttribute('stroke-width', '2');
            svg.appendChild(line);
          }
        }
      }
      mapContainer.appendChild(svg);

      for (const t of this.state.territories) {
        const node = document.createElement('div');
        const isAttackable = t.owner !== 'player' && t.adjacent.some(
          adjId => this.state.territories.find(a => a.id === adjId)?.owner === 'player'
        );

        let bgColor = '#333';
        let borderColor = '#555';
        let textColor = '#888';
        if (t.owner === 'player') {
          bgColor = '#1a3a1a';
          borderColor = '#4a4';
          textColor = '#8f8';
        } else if (t.owner === 'enemy') {
          bgColor = '#3a1a1a';
          borderColor = '#a44';
          textColor = '#f88';
        }
        if (isAttackable) {
          borderColor = '#ff8800';
          textColor = '#ffcc44';
        }

        node.style.cssText = `
          position:absolute;left:${t.x * 6 - 40}px;top:${t.y * 4 - 18}px;
          width:80px;text-align:center;padding:4px;
          background:${bgColor};border:2px solid ${borderColor};
          border-radius:4px;cursor:${isAttackable ? 'pointer' : 'default'};
          transition:all 0.2s;
        `;
        node.innerHTML = `
          <div style="font-size:11px;font-weight:bold;color:${textColor};">${t.name}</div>
          <div style="font-size:9px;color:#666;">${t.owner === 'player' ? 'Controlled' : t.owner === 'enemy' ? 'Enemy' : 'Neutral'}</div>
        `;

        if (isAttackable) {
          node.onmouseenter = () => {
            node.style.borderColor = '#ffcc00';
            node.style.transform = 'scale(1.1)';
            node.style.zIndex = '5';
            descEl.textContent = `${t.name}: ${t.description} [${t.difficulty.toUpperCase()}]`;
          };
          node.onmouseleave = () => {
            node.style.borderColor = '#ff8800';
            node.style.transform = 'scale(1)';
            node.style.zIndex = '1';
            descEl.textContent = 'Select an adjacent territory to attack.';
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

      const descEl = document.createElement('div');
      descEl.style.cssText = 'color:#aaa;font-size:13px;margin-top:12px;max-width:500px;text-align:center;min-height:20px;';
      descEl.textContent = 'Select an adjacent territory to attack.';
      this.overlay.appendChild(descEl);

      const backBtn = document.createElement('button');
      backBtn.textContent = 'Back to Menu';
      backBtn.style.cssText = 'margin-top:16px;padding:8px 20px;background:#1a1a3e;border:1px solid #444;color:#888;cursor:pointer;font-size:13px;';
      backBtn.onclick = () => {
        this.overlay.remove();
        resolve(null);
      };
      this.overlay.appendChild(backBtn);

      document.body.appendChild(this.overlay);
    });
  }
}
