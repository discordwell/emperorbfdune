import type { Territory } from './CampaignMap';

// Lore flavor text per difficulty tier
const BRIEFING_INTROS: Record<string, string[]> = {
  easy: [
    'Our scouts have located a weakly defended region. A swift strike will secure it.',
    'Intelligence reports light enemy presence. Move in and establish a foothold.',
    'The enemy has left this territory undermanned. Seize the opportunity.',
  ],
  normal: [
    'The enemy has fortified this position. Expect moderate resistance.',
    'Our spies report defensive emplacements and regular patrols. Prepare accordingly.',
    'This territory is contested. Both sides have committed significant forces.',
  ],
  hard: [
    'Heavy enemy fortifications detected. This will be a grueling battle.',
    'The enemy has concentrated their elite forces here. Expect no mercy.',
    'Our intelligence suggests overwhelming enemy presence. Victory will require skill.',
  ],
};

const FACTION_FLAVOR: Record<string, string> = {
  AT: 'The noble House Atreides fights with honor. For Caladan and Arrakis!',
  HK: 'House Harkonnen crushes all opposition. The spice must flow through our fists.',
  OR: 'House Ordos achieves victory through cunning. Profit above all.',
};

const OBJECTIVE_TEXT: Record<string, string> = {
  easy: 'Destroy the enemy Construction Yard to claim this territory.',
  normal: 'Destroy the enemy Construction Yard. Expect reinforcements.',
  hard: 'Destroy all enemy structures. The enemy will fight to the last unit.',
};

export function showMissionBriefing(
  territory: Territory,
  houseName: string,
  housePrefix: string,
  enemyHouseName: string,
  objectiveOverride?: string,
): Promise<void> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;
      background:rgba(0,0,0,0.95);display:flex;flex-direction:column;
      align-items:center;justify-content:center;z-index:2500;
      font-family:'Segoe UI',Tahoma,sans-serif;
    `;

    // Panel
    const panel = document.createElement('div');
    panel.style.cssText = `
      background:linear-gradient(180deg, #1a1a2e 0%, #0a0a15 100%);
      border:2px solid #444;border-radius:6px;padding:32px 48px;
      max-width:520px;width:90%;text-align:center;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'color:#d4a840;font-size:12px;letter-spacing:3px;text-transform:uppercase;margin-bottom:4px;';
    header.textContent = 'Mission Briefing';
    panel.appendChild(header);

    // Territory name
    const name = document.createElement('div');
    name.style.cssText = 'color:#fff;font-size:28px;font-weight:bold;margin-bottom:16px;';
    name.textContent = territory.name;
    panel.appendChild(name);

    // Difficulty badge
    const diffColors: Record<string, string> = { easy: '#4f4', normal: '#ff8', hard: '#f44' };
    const diffBadge = document.createElement('div');
    diffBadge.style.cssText = `display:inline-block;padding:3px 12px;border:1px solid ${diffColors[territory.difficulty]};color:${diffColors[territory.difficulty]};font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-bottom:16px;border-radius:2px;`;
    diffBadge.textContent = territory.difficulty;
    panel.appendChild(diffBadge);

    // Description
    const desc = document.createElement('div');
    desc.style.cssText = 'color:#aaa;font-size:14px;line-height:1.5;margin-bottom:16px;';
    desc.textContent = territory.description;
    panel.appendChild(desc);

    // Briefing flavor text
    const intros = BRIEFING_INTROS[territory.difficulty] ?? BRIEFING_INTROS.normal;
    const intro = intros[Math.floor(Math.random() * intros.length)];
    const briefing = document.createElement('div');
    briefing.style.cssText = 'color:#c8b060;font-size:13px;font-style:italic;margin-bottom:20px;line-height:1.4;';
    briefing.textContent = `"${intro}"`;
    panel.appendChild(briefing);

    // Intel section
    const intel = document.createElement('div');
    intel.style.cssText = 'text-align:left;margin-bottom:20px;padding:12px;background:rgba(0,0,0,0.3);border:1px solid #333;border-radius:3px;';
    intel.innerHTML = `
      <div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Intelligence Report</div>
      <div style="color:#ccc;font-size:12px;margin-bottom:4px;">Your House: <span style="color:#4af;font-weight:bold;">${houseName}</span></div>
      <div style="color:#ccc;font-size:12px;margin-bottom:4px;">Enemy: <span style="color:#f88;font-weight:bold;">${enemyHouseName}</span></div>
      <div style="color:#ccc;font-size:12px;margin-bottom:8px;">Objective: <span style="color:#ff8;">${objectiveOverride ?? OBJECTIVE_TEXT[territory.difficulty] ?? OBJECTIVE_TEXT.normal}</span></div>
      <div style="color:#666;font-size:11px;">${FACTION_FLAVOR[housePrefix] ?? ''}</div>
    `;
    panel.appendChild(intel);

    // Begin button
    const btn = document.createElement('button');
    btn.textContent = 'Begin Mission';
    btn.style.cssText = `
      padding:12px 40px;background:#2a1a00;border:2px solid #d4a840;
      color:#d4a840;cursor:pointer;font-size:16px;font-weight:bold;
      letter-spacing:2px;transition:all 0.2s;
    `;
    btn.onmouseenter = () => { btn.style.background = '#3a2a10'; btn.style.borderColor = '#ffcc44'; btn.style.color = '#ffcc44'; };
    btn.onmouseleave = () => { btn.style.background = '#2a1a00'; btn.style.borderColor = '#d4a840'; btn.style.color = '#d4a840'; };
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      overlay.remove();
      resolve();
    };
    btn.onclick = dismiss;
    panel.appendChild(btn);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Auto-focus for keyboard
    btn.focus();
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') dismiss();
    });
  });
}
