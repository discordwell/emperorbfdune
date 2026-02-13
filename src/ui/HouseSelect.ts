import type { AudioManager } from '../audio/AudioManager';

export interface HouseChoice {
  id: string;
  name: string;
  prefix: string;
  color: string;
  description: string;
  enemyPrefix: string;
  enemyName: string;
}

const HOUSES: HouseChoice[] = [
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

      for (const house of HOUSES) {
        const card = document.createElement('div');
        card.style.cssText = `
          width: 220px; padding: 24px; text-align: center;
          background: ${house.color}15;
          border: 2px solid ${house.color}44;
          cursor: pointer;
          transition: all 0.3s;
        `;

        card.innerHTML = `
          <div style="font-size:28px; font-weight:bold; color:${house.color}; margin-bottom:8px;">
            ${house.name.split(' ')[1]}
          </div>
          <div style="font-size:12px; color:${house.color}88; margin-bottom:12px;">
            ${house.name}
          </div>
          <div style="font-size:13px; color:#999; line-height:1.5;">
            ${house.description}
          </div>
        `;

        card.onmouseenter = () => {
          card.style.borderColor = house.color;
          card.style.background = `${house.color}25`;
          card.style.transform = 'translateY(-4px)';
        };
        card.onmouseleave = () => {
          card.style.borderColor = `${house.color}44`;
          card.style.background = `${house.color}15`;
          card.style.transform = 'translateY(0)';
        };
        card.onclick = () => {
          this.audioManager.playSfx('select');
          this.overlay.remove();
          resolve(house);
        };

        grid.appendChild(card);
      }

      this.overlay.appendChild(grid);

      // Controls hint
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#555; font-size:12px; margin-top:40px;';
      hint.textContent = 'WASD: Scroll | Mouse: Select/Command | M: Mute Music';
      this.overlay.appendChild(hint);

      document.body.appendChild(this.overlay);
    });
  }
}
