import * as THREE from 'three';
import type { AudioManager } from '../audio/AudioManager';
import { CampaignMap } from './CampaignMap';
import { HouseSelect3D } from './HouseSelect3D';
import { loadMapManifest, getSkirmishMaps } from '../config/MapLoader';

export interface SubhouseChoice {
  id: string;
  name: string;
  prefix: string;
  color: string;
  description: string;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface MapChoice {
  id: string;
  name: string;
  seed: number;
  description: string;
  /** Real map ID from manifest (e.g. 'M29', 'T5') — if set, loads .bin map data */
  mapId?: string;
  /** Player count (for display) */
  players?: number;
}

export type GameMode = 'skirmish' | 'campaign' | 'observer';

export interface SkirmishOptions {
  startingCredits: number;
  unitCap: number;
  victoryCondition: 'annihilate' | 'conyard';
}

export interface OpponentConfig {
  prefix: string;
  difficulty: Difficulty;
}

export interface HouseChoice {
  id: string;
  name: string;
  prefix: string;
  color: string;
  description: string;
  enemyPrefix: string;
  enemyName: string;
  subhouse?: SubhouseChoice;
  difficulty: Difficulty;
  mapChoice?: MapChoice;
  gameMode: GameMode;
  campaignTerritoryId?: number;
  skirmishOptions?: SkirmishOptions;
  opponents?: OpponentConfig[];
}

const SUBHOUSES: SubhouseChoice[] = [
  { id: 'fremen', name: 'Fremen', prefix: 'FR', color: '#C4A44A', description: 'Desert warriors. Elite infantry and stealth.' },
  { id: 'sardaukar', name: 'Sardaukar', prefix: 'IM', color: '#8888CC', description: 'Imperial elite. Devastating heavy troops.' },
  { id: 'guild', name: 'Spacing Guild', prefix: 'GU', color: '#AA6633', description: 'Guild Navigators. NIAB tanks and makers.' },
  { id: 'ix', name: 'House Ix', prefix: 'IX', color: '#55AADD', description: 'Technologists. Projectors and infiltrators.' },
  { id: 'tleilaxu', name: 'Tleilaxu', prefix: 'TL', color: '#55AA55', description: 'Flesh-shapers. Contaminators and leeches.' },
];

const HOUSES: Omit<HouseChoice, 'difficulty' | 'gameMode'>[] = [
  {
    id: 'atreides',
    name: 'House Atreides',
    prefix: 'AT',
    color: '#0085E2',
    description: 'Noble warriors of Caladan. Strong infantry and sonic weapons.',
    enemyPrefix: 'HK',
    enemyName: 'Harkonnen',
  },
  {
    id: 'harkonnen',
    name: 'House Harkonnen',
    prefix: 'HK',
    color: '#AF2416',
    description: 'Brutal forces of Giedi Prime. Heavy armor and devastating firepower.',
    enemyPrefix: 'AT',
    enemyName: 'Atreides',
  },
  {
    id: 'ordos',
    name: 'House Ordos',
    prefix: 'OR',
    color: '#92FDCA',
    description: 'Cunning merchants of Sigma Draconis. Speed, stealth, and deception.',
    enemyPrefix: 'HK',
    enemyName: 'Harkonnen',
  },
];

export class HouseSelect {
  private overlay: HTMLDivElement;
  private audioManager: AudioManager;
  private canvas: HTMLCanvasElement | null;
  private renderer: THREE.WebGLRenderer | null;

  constructor(audioManager: AudioManager, canvas?: HTMLCanvasElement, renderer?: THREE.WebGLRenderer) {
    this.audioManager = audioManager;
    this.overlay = document.createElement('div');
    this.canvas = canvas ?? null;
    this.renderer = renderer ?? null;
  }

  private showTitleScreen(): Promise<void> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position:fixed;top:0;left:0;right:0;bottom:0;z-index:2000;
        background:radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        font-family:'Segoe UI',Tahoma,sans-serif;
        cursor:pointer;
      `;

      // Sand particle canvas background (DPI-aware)
      const dpr = window.devicePixelRatio || 1;
      const bgCanvas = document.createElement('canvas');
      bgCanvas.width = window.innerWidth * dpr;
      bgCanvas.height = window.innerHeight * dpr;
      bgCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;opacity:0.3;';
      overlay.appendChild(bgCanvas);
      const bgCtx = bgCanvas.getContext('2d')!;
      bgCtx.scale(dpr, dpr);

      // Floating sand particles (use CSS pixel coordinates)
      const cssW = window.innerWidth, cssH = window.innerHeight;
      const particles: { x: number; y: number; vx: number; vy: number; size: number; alpha: number }[] = [];
      for (let i = 0; i < 80; i++) {
        particles.push({
          x: Math.random() * cssW,
          y: Math.random() * cssH,
          vx: 0.5 + Math.random() * 1.5,
          vy: (Math.random() - 0.5) * 0.3,
          size: 1 + Math.random() * 3,
          alpha: 0.2 + Math.random() * 0.4,
        });
      }

      let animating = true;
      const animateParticles = () => {
        if (!animating) return;
        bgCtx.clearRect(0, 0, cssW, cssH);
        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy + Math.sin(p.x * 0.01) * 0.2;
          if (p.x > cssW) { p.x = -p.size; p.y = Math.random() * cssH; }
          bgCtx.beginPath();
          bgCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          bgCtx.fillStyle = `rgba(212, 168, 64, ${p.alpha})`;
          bgCtx.fill();
        }
        requestAnimationFrame(animateParticles);
      };
      animateParticles();

      // Content container (above particles)
      const content = document.createElement('div');
      content.style.cssText = 'position:relative;z-index:1;text-align:center;';

      // Title
      const title = document.createElement('div');
      title.style.cssText = `
        font-size:64px;font-weight:bold;color:#f0c040;
        letter-spacing:8px;text-shadow:0 0 30px #f0c04040, 0 4px 8px rgba(0,0,0,0.5);
        margin-bottom:8px;
      `;
      title.textContent = 'EMPEROR';
      content.appendChild(title);

      const subtitle = document.createElement('div');
      subtitle.style.cssText = `
        font-size:22px;color:#c08020;letter-spacing:10px;margin-bottom:48px;
        text-shadow:0 0 15px #c0802040;
      `;
      subtitle.textContent = 'BATTLE FOR DUNE';
      content.appendChild(subtitle);

      // Version line
      const version = document.createElement('div');
      version.style.cssText = 'font-size:11px;color:#555;margin-bottom:32px;';
      version.textContent = 'Web Remake';
      content.appendChild(version);

      // Play button
      const playBtn = document.createElement('div');
      playBtn.style.cssText = `
        display:inline-block;padding:14px 48px;
        border:2px solid #d4a840;color:#d4a840;
        font-size:18px;letter-spacing:4px;cursor:pointer;
        transition:all 0.3s;background:transparent;
      `;
      playBtn.textContent = 'PLAY';
      playBtn.onmouseenter = () => {
        playBtn.style.background = '#d4a84022';
        playBtn.style.borderColor = '#f0c040';
        playBtn.style.color = '#f0c040';
        playBtn.style.transform = 'scale(1.05)';
      };
      playBtn.onmouseleave = () => {
        playBtn.style.background = 'transparent';
        playBtn.style.borderColor = '#d4a840';
        playBtn.style.color = '#d4a840';
        playBtn.style.transform = 'scale(1)';
      };
      content.appendChild(playBtn);

      // Click-to-play hint
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:#444;margin-top:16px;';
      hint.textContent = 'Click anywhere to continue';
      content.appendChild(hint);

      // Pulsing animation on hint text
      const hintAnim = hint.animate([
        { opacity: 0.3 },
        { opacity: 0.8 },
        { opacity: 0.3 },
      ], { duration: 2000, iterations: Infinity });

      overlay.appendChild(content);
      document.body.appendChild(overlay);

      const proceed = () => {
        animating = false;
        hintAnim.cancel();
        this.audioManager.playSfx('select');
        overlay.style.transition = 'opacity 0.5s';
        overlay.style.opacity = '0';
        setTimeout(() => { overlay.remove(); resolve(); }, 500);
      };

      overlay.onclick = proceed;
    });
  }

  async show(): Promise<HouseChoice> {
    // Check for campaign continuation (auto-start next mission)
    const nextMission = localStorage.getItem('ebfd_campaign_next');
    const campaignState = localStorage.getItem('ebfd_campaign');
    if (nextMission && campaignState) {
      localStorage.removeItem('ebfd_campaign_next');
      try {
        const next = JSON.parse(nextMission);
        const state = JSON.parse(campaignState);

        // Validate required fields to prevent stale/malformed data from bypassing picker
        const validPrefixes = ['AT', 'HK', 'OR'];
        if (typeof next.territoryId !== 'number' ||
            typeof state.housePrefix !== 'string' ||
            !validPrefixes.includes(state.housePrefix)) {
          localStorage.removeItem('ebfd_campaign_next');
          localStorage.removeItem('ebfd_campaign');
          // fall through to normal menu
        } else {
          const houseMap: Record<string, { name: string; enemyPrefix: string; enemyName: string }> = {
            'AT': { name: 'Atreides', enemyPrefix: 'HK', enemyName: 'Harkonnen' },
            'HK': { name: 'Harkonnen', enemyPrefix: 'AT', enemyName: 'Atreides' },
            'OR': { name: 'Ordos', enemyPrefix: 'HK', enemyName: 'Harkonnen' },
          };
          const info = houseMap[state.housePrefix]!;
          return {
            id: state.housePrefix.toLowerCase(),
            name: info.name,
            prefix: state.housePrefix,
            color: '#f0c040',
            description: '',
            enemyPrefix: state.enemyPrefix ?? info.enemyPrefix,
            enemyName: state.enemyHouse ?? info.enemyName,
            difficulty: next.difficulty ?? 'normal',
            gameMode: 'campaign',
            campaignTerritoryId: next.territoryId,
            mapChoice: { id: `campaign-${next.territoryId}`, name: 'Campaign Mission', seed: next.mapSeed, description: '' },
          };
        }
      } catch {
        localStorage.removeItem('ebfd_campaign_next');
        localStorage.removeItem('ebfd_campaign');
        /* fall through to normal menu */
      }
    }

    this.audioManager.playMenuMusic();

    // Title screen
    await this.showTitleScreen();

    const forceFallback = new URLSearchParams(window.location.search).get('ui') === '2d';

    // Use 3D house selection if canvas/renderer are available (unless forced to fallback)
    let selectedHouseId: string;
    if (!forceFallback && this.canvas && this.renderer) {
      try {
        const houseSelect3D = new HouseSelect3D(this.canvas, this.renderer);
        selectedHouseId = await houseSelect3D.show();
      } catch (e) {
        console.warn('3D house select failed, using fallback:', e);
        selectedHouseId = await this.showHouseSelectFallback();
      }
    } else {
      selectedHouseId = await this.showHouseSelectFallback();
    }

    // Map selected house ID to house template
    const houseTemplate = HOUSES.find(h => h.id === selectedHouseId) ?? HOUSES[0];
    const house: HouseChoice = { ...houseTemplate, difficulty: 'normal', gameMode: 'skirmish' };

    // Continue with DOM subscreens
    return new Promise((resolve) => {
      this.showModeSelect(house, resolve);
    });
  }

  private showHouseSelectFallback(): Promise<string> {
    return new Promise((resolve) => {
      this.overlay = document.createElement('div');
      this.overlay.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        z-index: 2000;
        font-family: 'Segoe UI', Tahoma, sans-serif;
      `;

      const title = document.createElement('div');
      title.style.cssText = `
        color: #d4a840; font-size: 48px; font-weight: bold;
        text-shadow: 0 0 20px #d4a84040;
        margin-bottom: 8px; letter-spacing: 4px;
      `;
      title.textContent = 'EMPEROR';
      this.overlay.appendChild(title);

      const subtitle = document.createElement('div');
      subtitle.style.cssText = `
        color: #888; font-size: 18px;
        margin-bottom: 48px; letter-spacing: 2px;
      `;
      subtitle.textContent = 'BATTLE FOR DUNE';
      this.overlay.appendChild(subtitle);

      const chooseText = document.createElement('div');
      chooseText.style.cssText = 'color:#aaa; font-size:16px; margin-bottom:24px;';
      chooseText.textContent = 'Choose Your House';
      this.overlay.appendChild(chooseText);

      const grid = document.createElement('div');
      grid.style.cssText = 'display:flex; gap:24px;';

      for (const houseTemplate of HOUSES) {
        const card = this.createCard(houseTemplate.name.split(' ')[1], houseTemplate.name, houseTemplate.description, houseTemplate.color, 220);
        card.onclick = () => {
          this.audioManager.playSfx('select');
          this.overlay.remove();
          resolve(houseTemplate.id);
        };
        grid.appendChild(card);
      }

      this.overlay.appendChild(grid);

      if (localStorage.getItem('ebfd_save')) {
        const loadBtn = document.createElement('button');
        loadBtn.textContent = 'Load Saved Game';
        loadBtn.style.cssText = 'margin-top:24px;padding:10px 24px;background:#1a1a3e;border:1px solid #444;color:#8cf;cursor:pointer;font-size:14px;';
        loadBtn.onclick = () => {
          localStorage.setItem('ebfd_load', '1');
          window.location.reload();
        };
        this.overlay.appendChild(loadBtn);
      }

      const hint = document.createElement('div');
      hint.style.cssText = 'color:#555; font-size:12px; margin-top:24px;';
      hint.textContent = 'WASD: Scroll | Mouse: Select/Command | M: Mute Music';
      this.overlay.appendChild(hint);

      document.body.appendChild(this.overlay);
    });
  }

  private showModeSelect(house: HouseChoice, resolve: (house: HouseChoice) => void): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 2000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
    `;

    const headerText = document.createElement('div');
    headerText.style.cssText = `color:${house.color}; font-size:24px; font-weight:bold; margin-bottom:24px;`;
    headerText.textContent = house.name;
    this.overlay.appendChild(headerText);

    const chooseText = document.createElement('div');
    chooseText.style.cssText = 'color:#aaa; font-size:16px; margin-bottom:24px;';
    chooseText.textContent = 'Select Game Mode';
    this.overlay.appendChild(chooseText);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:24px;';

    const campaignCard = this.createCard('Campaign', '', 'Conquer 33 Arrakis territories across 3 acts. Earn sub-house alliances through missions.', '#d4a840', 220);
    campaignCard.onclick = () => {
      this.audioManager.playSfx('select');
      this.overlay.remove();
      house.gameMode = 'campaign';
      // Campaign mode: skip sub-house selection (alliances earned in-game)
      // Auto-assign both enemies based on player house
      const enemies: Record<string, { prefix: string; name: string; prefix2: string; name2: string }> = {
        AT: { prefix: 'HK', name: 'Harkonnen', prefix2: 'OR', name2: 'Ordos' },
        HK: { prefix: 'AT', name: 'Atreides', prefix2: 'OR', name2: 'Ordos' },
        OR: { prefix: 'HK', name: 'Harkonnen', prefix2: 'AT', name2: 'Atreides' },
      };
      const e = enemies[house.prefix] ?? enemies.AT;
      house.enemyPrefix = e.prefix;
      house.enemyName = e.name;
      this.showDifficultySelect(house, resolve);
    };
    grid.appendChild(campaignCard);

    const skirmishCard = this.createCard('Skirmish', '', 'Single battle against AI. Choose your map, difficulty, and subhouse ally.', '#88aacc', 220);
    skirmishCard.onclick = () => {
      this.audioManager.playSfx('select');
      this.overlay.remove();
      house.gameMode = 'skirmish';
      this.showSubhouseSelect(house, resolve);
    };
    grid.appendChild(skirmishCard);

    const observerCard = this.createCard('Observer', '', 'Watch AI houses battle each other. Free camera, no fog of war.', '#88cc88', 220);
    observerCard.onclick = () => {
      this.audioManager.playSfx('select');
      this.overlay.remove();
      house.gameMode = 'observer';
      this.showObserverSetup(house, resolve);
    };
    grid.appendChild(observerCard);

    this.overlay.appendChild(grid);
    document.body.appendChild(this.overlay);
  }

  private showDifficultySelect(house: HouseChoice, resolve: (house: HouseChoice) => void): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 2000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
    `;

    const headerText = document.createElement('div');
    headerText.style.cssText = `color:${house.color}; font-size:24px; font-weight:bold; margin-bottom:8px;`;
    headerText.textContent = house.name;
    this.overlay.appendChild(headerText);

    const sub = house.subhouse;
    if (sub) {
      const subText = document.createElement('div');
      subText.style.cssText = `color:${sub.color}; font-size:14px; margin-bottom:16px;`;
      subText.textContent = `Allied with ${sub.name}`;
      this.overlay.appendChild(subText);
    }

    const chooseText = document.createElement('div');
    chooseText.style.cssText = 'color:#aaa; font-size:16px; margin-bottom:24px;';
    chooseText.textContent = 'Select Difficulty';
    this.overlay.appendChild(chooseText);

    const difficulties: { id: Difficulty; label: string; desc: string; color: string }[] = [
      { id: 'easy', label: 'Easy', desc: 'AI builds slowly and attacks less often.', color: '#44cc44' },
      { id: 'normal', label: 'Normal', desc: 'Balanced AI opponent.', color: '#cccc44' },
      { id: 'hard', label: 'Hard', desc: 'AI gets resource bonus and attacks aggressively.', color: '#cc4444' },
    ];

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:16px;';

    for (const diff of difficulties) {
      const card = this.createCard(diff.label, '', diff.desc, diff.color, 180);
      card.onclick = () => {
        this.audioManager.playSfx('select');
        house.difficulty = diff.id;
        this.overlay.remove();
        if (house.gameMode === 'campaign') {
          this.showCampaignMap(house, resolve);
        } else {
          this.showSkirmishOptions(house, resolve);
        }
      };
      grid.appendChild(card);
    }

    this.overlay.appendChild(grid);
    document.body.appendChild(this.overlay);
  }

  private showSubhouseSelect(house: HouseChoice, resolve: (house: HouseChoice) => void): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 2000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
    `;

    const headerText = document.createElement('div');
    headerText.style.cssText = `color:${house.color}; font-size:24px; font-weight:bold; margin-bottom:8px;`;
    headerText.textContent = house.name;
    this.overlay.appendChild(headerText);

    const chooseText = document.createElement('div');
    chooseText.style.cssText = 'color:#aaa; font-size:16px; margin-bottom:24px;';
    chooseText.textContent = 'Choose Your Subhouse Ally';
    this.overlay.appendChild(chooseText);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:16px; flex-wrap:wrap; justify-content:center; max-width:800px;';

    for (const sub of SUBHOUSES) {
      const card = this.createCard(sub.name, sub.name, sub.description, sub.color, 160);
      card.onclick = () => {
        this.audioManager.playSfx('select');
        house.subhouse = sub;
        this.overlay.remove();
        this.showDifficultySelect(house, resolve);
      };
      grid.appendChild(card);
    }

    this.overlay.appendChild(grid);

    // Skip option
    const skipBtn = document.createElement('button');
    skipBtn.textContent = 'No Subhouse';
    skipBtn.style.cssText = 'margin-top:20px;padding:8px 20px;background:transparent;border:1px solid #444;color:#888;cursor:pointer;font-size:13px;';
    skipBtn.onclick = () => {
      this.audioManager.playSfx('select');
      this.overlay.remove();
      this.showDifficultySelect(house, resolve);
    };
    this.overlay.appendChild(skipBtn);

    document.body.appendChild(this.overlay);
  }

  private async showCampaignMap(house: HouseChoice, resolve: (house: HouseChoice) => void): Promise<void> {
    const campaign = new CampaignMap(this.audioManager, house.prefix, house.name, house.enemyPrefix, house.enemyName, this.canvas ?? undefined, this.renderer ?? undefined);
    const result = await campaign.show();
    if (result) {
      house.campaignTerritoryId = result.territory.id;
      house.mapChoice = { id: `campaign-${result.territory.id}`, name: result.territory.name, seed: result.mapSeed, description: result.territory.description };
      // Campaign territory difficulty overrides player selection for harder territories
      if (result.difficulty === 'hard' && house.difficulty !== 'hard') {
        house.difficulty = 'hard';
      } else if (result.difficulty === 'normal' && house.difficulty === 'easy') {
        house.difficulty = 'normal';
      }
      resolve(house);
    } else {
      // User went back - show difficulty select again
      this.showDifficultySelect(house, resolve);
    }
  }

  private showSkirmishOptions(house: HouseChoice, resolve: (house: HouseChoice) => void): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 2000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
    `;

    const headerText = document.createElement('div');
    headerText.style.cssText = `color:${house.color}; font-size:24px; font-weight:bold; margin-bottom:16px;`;
    headerText.textContent = 'Skirmish Options';
    this.overlay.appendChild(headerText);

    const panel = document.createElement('div');
    panel.style.cssText = 'background:#11111188;border:1px solid #444;padding:24px 32px;border-radius:4px;min-width:320px;';

    let credits = 5000;
    let unitCap = 50;
    let victory: 'annihilate' | 'conyard' = 'annihilate';

    // Starting credits
    const creditsRow = document.createElement('div');
    creditsRow.style.cssText = 'margin-bottom:16px;';
    const creditsLabel = document.createElement('div');
    creditsLabel.style.cssText = 'color:#ccc;font-size:13px;margin-bottom:6px;';
    creditsLabel.textContent = 'Starting Credits';
    creditsRow.appendChild(creditsLabel);
    const creditsBtns = document.createElement('div');
    creditsBtns.style.cssText = 'display:flex;gap:4px;';
    for (const { label, value } of [
      { label: '3,000', value: 3000 }, { label: '5,000', value: 5000 },
      { label: '10,000', value: 10000 }, { label: '20,000', value: 20000 },
    ]) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = `flex:1;padding:6px;background:#111;border:1px solid ${value === credits ? '#d4a840' : '#444'};color:#ccc;cursor:pointer;font-size:12px;`;
      btn.onclick = () => {
        credits = value;
        creditsBtns.querySelectorAll('button').forEach(b => (b as HTMLElement).style.borderColor = '#444');
        btn.style.borderColor = '#d4a840';
      };
      creditsBtns.appendChild(btn);
    }
    creditsRow.appendChild(creditsBtns);
    panel.appendChild(creditsRow);

    // Unit cap
    const capRow = document.createElement('div');
    capRow.style.cssText = 'margin-bottom:16px;';
    const capLabel = document.createElement('div');
    capLabel.style.cssText = 'color:#ccc;font-size:13px;margin-bottom:6px;';
    capLabel.textContent = 'Unit Cap';
    capRow.appendChild(capLabel);
    const capBtns = document.createElement('div');
    capBtns.style.cssText = 'display:flex;gap:4px;';
    for (const { label, value } of [
      { label: '25', value: 25 }, { label: '50', value: 50 },
      { label: '100', value: 100 }, { label: 'Unlimited', value: 999 },
    ]) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = `flex:1;padding:6px;background:#111;border:1px solid ${value === unitCap ? '#d4a840' : '#444'};color:#ccc;cursor:pointer;font-size:12px;`;
      btn.onclick = () => {
        unitCap = value;
        capBtns.querySelectorAll('button').forEach(b => (b as HTMLElement).style.borderColor = '#444');
        btn.style.borderColor = '#d4a840';
      };
      capBtns.appendChild(btn);
    }
    capRow.appendChild(capBtns);
    panel.appendChild(capRow);

    // Victory condition
    const vicRow = document.createElement('div');
    vicRow.style.cssText = 'margin-bottom:20px;';
    const vicLabel = document.createElement('div');
    vicLabel.style.cssText = 'color:#ccc;font-size:13px;margin-bottom:6px;';
    vicLabel.textContent = 'Victory Condition';
    vicRow.appendChild(vicLabel);
    const vicBtns = document.createElement('div');
    vicBtns.style.cssText = 'display:flex;gap:4px;';
    for (const { label, value, desc } of [
      { label: 'Destroy All', value: 'annihilate' as const, desc: 'Destroy all enemy buildings' },
      { label: 'Destroy ConYard', value: 'conyard' as const, desc: 'Destroy enemy Construction Yard' },
    ]) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = desc;
      btn.style.cssText = `flex:1;padding:6px;background:#111;border:1px solid ${value === victory ? '#d4a840' : '#444'};color:#ccc;cursor:pointer;font-size:12px;`;
      btn.onclick = () => {
        victory = value;
        vicBtns.querySelectorAll('button').forEach(b => (b as HTMLElement).style.borderColor = '#444');
        btn.style.borderColor = '#d4a840';
      };
      vicBtns.appendChild(btn);
    }
    vicRow.appendChild(vicBtns);
    panel.appendChild(vicRow);

    // Start button
    const startBtn = document.createElement('button');
    startBtn.textContent = 'Continue';
    startBtn.style.cssText = `display:block;width:100%;padding:10px;background:${house.color}33;border:2px solid ${house.color};color:#fff;cursor:pointer;font-size:16px;font-weight:bold;`;
    startBtn.onmouseenter = () => { startBtn.style.background = `${house.color}66`; };
    startBtn.onmouseleave = () => { startBtn.style.background = `${house.color}33`; };
    startBtn.onclick = () => {
      this.audioManager.playSfx('select');
      house.skirmishOptions = { startingCredits: credits, unitCap, victoryCondition: victory };
      this.overlay.remove();
      this.showMapSelect(house, resolve);
    };
    panel.appendChild(startBtn);

    this.overlay.appendChild(panel);
    document.body.appendChild(this.overlay);
  }

  private async showMapSelect(house: HouseChoice, resolve: (house: HouseChoice) => void): Promise<void> {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 2000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
    `;

    const headerText = document.createElement('div');
    headerText.style.cssText = `color:${house.color}; font-size:24px; font-weight:bold; margin-bottom:16px;`;
    headerText.textContent = house.name;
    this.overlay.appendChild(headerText);

    const chooseText = document.createElement('div');
    chooseText.style.cssText = 'color:#aaa; font-size:16px; margin-bottom:24px;';
    chooseText.textContent = 'Select Battlefield';
    this.overlay.appendChild(chooseText);

    // Load real maps from manifest, fall back to proc-gen presets
    const maps: MapChoice[] = [];
    try {
      const manifest = await loadMapManifest();
      const skirmishMaps = getSkirmishMaps(manifest);
      for (const [mapId, entry] of skirmishMaps) {
        maps.push({
          id: mapId,
          name: entry.name,
          seed: 0,
          description: `${entry.w}×${entry.h} — ${entry.players} players`,
          mapId: mapId,
          players: entry.players,
        });
      }
    } catch (e) {
      console.warn('Failed to load map manifest, using proc-gen fallback:', e);
    }

    // Always add a random proc-gen option at the end
    maps.push({
      id: 'random',
      name: 'Random (Procedural)',
      seed: Math.floor(Math.random() * 10000),
      description: 'A randomly generated battlefield. Every battle is unique.',
    });

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:12px; flex-wrap:wrap; justify-content:center; max-width:1000px; max-height:60vh; overflow-y:auto; padding:8px;';

    // Group maps by player count
    const playerCounts = [...new Set(maps.filter(m => m.players).map(m => m.players!))].sort();

    for (const count of playerCounts) {
      const groupLabel = document.createElement('div');
      groupLabel.style.cssText = 'width:100%; color:#C4A44A; font-size:14px; font-weight:bold; margin-top:8px; border-bottom:1px solid #333; padding-bottom:4px;';
      groupLabel.textContent = `${count}-Player Maps`;
      grid.appendChild(groupLabel);

      const groupMaps = maps.filter(m => m.players === count);
      for (const map of groupMaps) {
        const card = this.createMapCard(map, '#A08050');
        card.onclick = () => {
          this.audioManager.playSfx('select');
          house.mapChoice = map;
          this.overlay.remove();
          const maxPlayers = map.players ?? 2;
          if (maxPlayers > 2 && house.gameMode !== 'observer') {
            this.showOpponentSelect(house, maxPlayers, resolve);
          } else {
            resolve(house);
          }
        };
        grid.appendChild(card);
      }
    }

    // Add random/proc-gen option
    const randomMap = maps.find(m => m.id === 'random')!;
    const randomLabel = document.createElement('div');
    randomLabel.style.cssText = 'width:100%; color:#888; font-size:14px; font-weight:bold; margin-top:8px; border-bottom:1px solid #333; padding-bottom:4px;';
    randomLabel.textContent = 'Procedural Generation';
    grid.appendChild(randomLabel);

    const randomCard = this.createCard(randomMap.name, '', randomMap.description, '#888888', 150);
    randomCard.onclick = () => {
      this.audioManager.playSfx('select');
      house.mapChoice = randomMap;
      this.overlay.remove();
      resolve(house);
    };
    grid.appendChild(randomCard);

    this.overlay.appendChild(grid);
    document.body.appendChild(this.overlay);
  }

  private showOpponentSelect(house: HouseChoice, maxPlayers: number, resolve: (house: HouseChoice) => void): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 2000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
    `;

    const headerText = document.createElement('div');
    headerText.style.cssText = `color:${house.color}; font-size:24px; font-weight:bold; margin-bottom:8px;`;
    headerText.textContent = house.name;
    this.overlay.appendChild(headerText);

    const mapText = document.createElement('div');
    mapText.style.cssText = 'color:#888; font-size:14px; margin-bottom:16px;';
    mapText.textContent = house.mapChoice?.name ?? 'Unknown Map';
    this.overlay.appendChild(mapText);

    const chooseText = document.createElement('div');
    chooseText.style.cssText = 'color:#aaa; font-size:16px; margin-bottom:24px;';
    chooseText.textContent = 'Number of Opponents';
    this.overlay.appendChild(chooseText);

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:12px; flex-wrap:wrap; justify-content:center;';

    const maxOpponents = maxPlayers - 1;
    const enemyHouses = HOUSES.filter(h => h.id !== house.id);

    for (let count = 1; count <= maxOpponents; count++) {
      const desc = count === 1 ? '1v1 Classic' : `1v${count} — ${count} AI enemies`;
      const color = count === 1 ? '#88aacc' : count <= 3 ? '#ccaa44' : '#cc4444';
      const card = this.createCard(`${count}`, '', desc, color, 120);
      card.onclick = () => {
        this.audioManager.playSfx('select');
        // Assign opponents: cycle through enemy houses
        const opponents: OpponentConfig[] = [];
        for (let i = 0; i < count; i++) {
          const enemyHouse = enemyHouses[i % enemyHouses.length];
          opponents.push({ prefix: enemyHouse.prefix, difficulty: house.difficulty });
        }
        house.opponents = opponents;
        // Keep enemyPrefix/enemyName for backward compat (first opponent)
        const prefixToName: Record<string, string> = { AT: 'Atreides', HK: 'Harkonnen', OR: 'Ordos' };
        house.enemyPrefix = opponents[0].prefix;
        house.enemyName = prefixToName[opponents[0].prefix] ?? house.enemyName;
        this.overlay.remove();
        resolve(house);
      };
      grid.appendChild(card);
    }

    this.overlay.appendChild(grid);
    document.body.appendChild(this.overlay);
  }

  private showObserverSetup(house: HouseChoice, resolve: (house: HouseChoice) => void): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 2000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
    `;

    const headerText = document.createElement('div');
    headerText.style.cssText = 'color:#88cc88; font-size:24px; font-weight:bold; margin-bottom:8px;';
    headerText.textContent = 'Observer Mode';
    this.overlay.appendChild(headerText);

    const subText = document.createElement('div');
    subText.style.cssText = 'color:#888; font-size:14px; margin-bottom:24px;';
    subText.textContent = 'Select matchup to observe';
    this.overlay.appendChild(subText);

    const matchups = [
      { label: 'Atreides vs Harkonnen', houses: ['AT', 'HK'], color: '#6699cc' },
      { label: 'Atreides vs Ordos', houses: ['AT', 'OR'], color: '#6699aa' },
      { label: 'Harkonnen vs Ordos', houses: ['HK', 'OR'], color: '#cc6666' },
      { label: 'Free-for-All (3 Houses)', houses: ['AT', 'HK', 'OR'], color: '#cc9944' },
    ];

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:12px; flex-wrap:wrap; justify-content:center;';

    for (const matchup of matchups) {
      const card = this.createCard(matchup.label, '', `AI-controlled ${matchup.houses.length} player battle`, matchup.color, 200);
      card.onclick = () => {
        this.audioManager.playSfx('select');
        // Set up opponents — all are AI
        const prefixToName: Record<string, string> = { AT: 'Atreides', HK: 'Harkonnen', OR: 'Ordos' };
        house.opponents = matchup.houses.map(prefix => ({ prefix, difficulty: 'normal' as Difficulty }));
        house.enemyPrefix = matchup.houses[0];
        house.enemyName = prefixToName[matchup.houses[0]] ?? 'Unknown';
        this.overlay.remove();
        this.showObserverDifficulty(house, resolve);
      };
      grid.appendChild(card);
    }

    this.overlay.appendChild(grid);
    document.body.appendChild(this.overlay);
  }

  private showObserverDifficulty(house: HouseChoice, resolve: (house: HouseChoice) => void): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 2000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
    `;

    const headerText = document.createElement('div');
    headerText.style.cssText = 'color:#88cc88; font-size:24px; font-weight:bold; margin-bottom:8px;';
    headerText.textContent = 'Observer Mode';
    this.overlay.appendChild(headerText);

    const chooseText = document.createElement('div');
    chooseText.style.cssText = 'color:#aaa; font-size:16px; margin-bottom:24px;';
    chooseText.textContent = 'AI Difficulty';
    this.overlay.appendChild(chooseText);

    const difficulties: { id: Difficulty; label: string; desc: string; color: string }[] = [
      { id: 'easy', label: 'Easy', desc: 'AI builds slowly. Longer matches.', color: '#44cc44' },
      { id: 'normal', label: 'Normal', desc: 'Balanced AI opponents.', color: '#cccc44' },
      { id: 'hard', label: 'Hard', desc: 'Aggressive AI. Fast-paced battles.', color: '#cc4444' },
    ];

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:16px;';

    for (const diff of difficulties) {
      const card = this.createCard(diff.label, '', diff.desc, diff.color, 180);
      card.onclick = () => {
        this.audioManager.playSfx('select');
        house.difficulty = diff.id;
        if (house.opponents) {
          for (const opp of house.opponents) opp.difficulty = diff.id;
        }
        this.overlay.remove();
        this.showSkirmishOptions(house, resolve);
      };
      grid.appendChild(card);
    }

    this.overlay.appendChild(grid);
    document.body.appendChild(this.overlay);
  }

  private createMapCard(map: MapChoice, color: string): HTMLDivElement {
    const card = document.createElement('div');
    card.style.cssText = `
      width: 150px; padding: 8px; text-align: center;
      background: ${color}15;
      border: 2px solid ${color}44;
      cursor: pointer;
      transition: all 0.3s;
    `;
    // Thumbnail
    const thumbUrl = map.mapId ? `/assets/maps/${map.mapId}.thumb.png` : null;
    const thumbHtml = thumbUrl
      ? `<img src="${thumbUrl}" width="128" height="128" style="display:block;margin:0 auto 6px;image-rendering:pixelated;border:1px solid ${color}44;background:#111;" onerror="this.style.display='none'" />`
      : `<div style="width:128px;height:128px;margin:0 auto 6px;background:#111;border:1px solid ${color}44;display:flex;align-items:center;justify-content:center;color:#555;font-size:32px;">?</div>`;
    card.innerHTML = `
      ${thumbHtml}
      <div style="font-size:13px; font-weight:bold; color:${color}; margin-bottom:4px;">${map.name}</div>
      <div style="font-size:11px; color:#999;">${map.description}</div>
    `;
    card.onmouseenter = () => {
      card.style.borderColor = color;
      card.style.background = `${color}25`;
      card.style.transform = 'translateY(-4px)';
    };
    card.onmouseleave = () => {
      card.style.borderColor = `${color}44`;
      card.style.background = `${color}15`;
      card.style.transform = 'translateY(0)';
    };
    return card;
  }

  private createCard(title: string, subtitle: string, desc: string, color: string, width: number): HTMLDivElement {
    const card = document.createElement('div');
    card.style.cssText = `
      width: ${width}px; padding: 20px; text-align: center;
      background: ${color}15;
      border: 2px solid ${color}44;
      cursor: pointer;
      transition: all 0.3s;
    `;
    card.innerHTML = `
      <div style="font-size:22px; font-weight:bold; color:${color}; margin-bottom:6px;">${title}</div>
      <div style="font-size:11px; color:${color}88; margin-bottom:10px;">${subtitle}</div>
      <div style="font-size:12px; color:#999; line-height:1.4;">${desc}</div>
    `;
    card.onmouseenter = () => {
      card.style.borderColor = color;
      card.style.background = `${color}25`;
      card.style.transform = 'translateY(-4px)';
    };
    card.onmouseleave = () => {
      card.style.borderColor = `${color}44`;
      card.style.background = `${color}15`;
      card.style.transform = 'translateY(0)';
    };
    return card;
  }
}
