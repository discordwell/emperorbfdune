import type { AudioManager } from '../audio/AudioManager';
import { CampaignMap } from './CampaignMap';

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
}

export type GameMode = 'skirmish' | 'campaign';

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

  constructor(audioManager: AudioManager) {
    this.audioManager = audioManager;
    this.overlay = document.createElement('div');
  }

  show(): Promise<HouseChoice> {
    return new Promise((resolve) => {
      this.audioManager.playMenuMusic();
      this.showHouseSelect(resolve);
    });
  }

  private showHouseSelect(resolve: (house: HouseChoice) => void): void {
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: radial-gradient(ellipse at center, #1a0f00 0%, #000 80%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 2000;
      font-family: 'Segoe UI', Tahoma, sans-serif;
    `;

    // Title
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

    // Choose your house
    const chooseText = document.createElement('div');
    chooseText.style.cssText = 'color:#aaa; font-size:16px; margin-bottom:24px;';
    chooseText.textContent = 'Choose Your House';
    this.overlay.appendChild(chooseText);

    // House cards
    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:24px;';

    for (const houseTemplate of HOUSES) {
      const card = this.createCard(houseTemplate.name.split(' ')[1], houseTemplate.name, houseTemplate.description, houseTemplate.color, 220);
      card.onclick = () => {
        this.audioManager.playSfx('select');
        this.overlay.remove();
        this.showModeSelect({ ...houseTemplate, difficulty: 'normal', gameMode: 'skirmish' }, resolve);
      };
      grid.appendChild(card);
    }

    this.overlay.appendChild(grid);

    // Load saved game button
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

    // Controls hint
    const hint = document.createElement('div');
    hint.style.cssText = 'color:#555; font-size:12px; margin-top:24px;';
    hint.textContent = 'WASD: Scroll | Mouse: Select/Command | M: Mute Music';
    this.overlay.appendChild(hint);

    document.body.appendChild(this.overlay);
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

    const campaignCard = this.createCard('Campaign', '', 'Conquer Arrakis territory by territory. 9 missions with increasing difficulty.', '#d4a840', 220);
    campaignCard.onclick = () => {
      this.audioManager.playSfx('select');
      this.overlay.remove();
      house.gameMode = 'campaign';
      this.showSubhouseSelect(house, resolve);
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
          this.showMapSelect(house, resolve);
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
    const campaign = new CampaignMap(this.audioManager, house.prefix, house.name, house.enemyPrefix, house.enemyName);
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

  private showMapSelect(house: HouseChoice, resolve: (house: HouseChoice) => void): void {
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

    const maps: MapChoice[] = [
      { id: 'desert', name: 'Open Desert', seed: 1000, description: 'Wide open terrain with scattered rock outcrops. Classic Arrakis warfare.' },
      { id: 'canyon', name: 'Canyon Pass', seed: 1001, description: 'Narrow canyon passages between towering cliffs. Ideal for ambushes.' },
      { id: 'plateau', name: 'Rocky Plateau', seed: 1002, description: 'Elevated rocky terrain with limited sand. Defensible positions.' },
      { id: 'ridge', name: 'Spice Ridge', seed: 1003, description: 'A central rock ridge divides the map. Control the high ground.' },
      { id: 'random', name: 'Random', seed: Math.floor(Math.random() * 10000), description: 'A randomly generated battlefield. Every battle is unique.' },
    ];

    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex; gap:16px; flex-wrap:wrap; justify-content:center; max-width:900px;';

    const mapColors: Record<string, string> = {
      desert: '#D4A840', canyon: '#8B6B3E', plateau: '#6B7B5B', ridge: '#A08050', random: '#888888',
    };

    for (const map of maps) {
      const color = mapColors[map.id] ?? '#888';
      const card = this.createCard(map.name, '', map.description, color, 160);
      card.onclick = () => {
        this.audioManager.playSfx('select');
        house.mapChoice = map;
        this.overlay.remove();
        resolve(house);
      };
      grid.appendChild(card);
    }

    this.overlay.appendChild(grid);
    document.body.appendChild(this.overlay);
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
