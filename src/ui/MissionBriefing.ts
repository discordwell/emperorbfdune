import type { Territory } from './CampaignMap';
import { lookupBriefingText, lookupMiniBriefing, type MissionConfigData, type VictoryCondition } from '../campaign/MissionConfig';
import { getCampaignString } from '../campaign/CampaignData';

const FACTION_FLAVOR: Record<string, string> = {
  AT: 'The noble House Atreides fights with honor. For Caladan and Arrakis!',
  HK: 'House Harkonnen crushes all opposition. The spice must flow through our fists.',
  OR: 'House Ordos achieves victory through cunning. Profit above all.',
};

const VICTORY_OBJECTIVES: Record<VictoryCondition, string> = {
  conyard: 'Destroy the enemy Construction Yard to claim this territory.',
  annihilate: 'Destroy all enemy structures. The enemy will fight to the last unit.',
  survival: 'Survive the enemy onslaught. Hold your position until reinforcements arrive.',
  protect: 'Protect your base and key structures from enemy assault.',
};

const SPECIAL_MISSION_HEADERS: Record<string, string> = {
  heighliner: 'Heighliner Mission',
  homeDefense: 'Homeworld Defense',
  homeAttack: 'Homeworld Assault',
  civilWar: 'Civil War',
  final: 'The Final Battle',
};

/**
 * Show mission briefing with real text from campaign strings.
 * Falls back to generated text if no campaign string is found.
 */
export function showMissionBriefing(
  territory: Territory,
  houseName: string,
  housePrefix: string,
  enemyHouseName: string,
  objectiveOverride?: string,
  missionConfig?: MissionConfigData,
): Promise<'accept' | 'resign'> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;top:0;left:0;right:0;bottom:0;
      background:rgba(0,0,0,0.95);display:flex;flex-direction:column;
      align-items:center;justify-content:center;z-index:2500;
      font-family:'Segoe UI',Tahoma,sans-serif;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      background:linear-gradient(180deg, #1a1a2e 0%, #0a0a15 100%);
      border:2px solid #444;border-radius:6px;padding:32px 48px;
      max-width:560px;width:90%;text-align:center;
    `;

    // Header: "Mentat's Briefing" or special mission type
    const headerLabel = missionConfig?.isSpecial && missionConfig.specialType
      ? SPECIAL_MISSION_HEADERS[missionConfig.specialType] ?? "Mentat's Briefing"
      : getCampaignString('BriefingTitle') ?? "Mentat's Briefing";

    const header = document.createElement('div');
    header.style.cssText = 'color:#d4a840;font-size:12px;letter-spacing:3px;text-transform:uppercase;margin-bottom:4px;';
    header.textContent = headerLabel;
    panel.appendChild(header);

    // Territory name
    const name = document.createElement('div');
    name.style.cssText = 'color:#fff;font-size:28px;font-weight:bold;margin-bottom:12px;';
    name.textContent = territory.name;
    panel.appendChild(name);

    // Phase/Tech info if campaign
    if (missionConfig) {
      const phaseInfo = document.createElement('div');
      phaseInfo.style.cssText = 'color:#888;font-size:11px;margin-bottom:12px;';
      phaseInfo.textContent = `Phase ${missionConfig.phaseNumber} | ${missionConfig.isAttack ? 'Attack' : 'Defend'} Mission`;
      panel.appendChild(phaseInfo);
    }

    // Difficulty badge
    const diffColors: Record<string, string> = { easy: '#4f4', normal: '#ff8', hard: '#f44' };
    const diffBadge = document.createElement('div');
    diffBadge.style.cssText = `display:inline-block;padding:3px 12px;border:1px solid ${diffColors[territory.difficulty]};color:${diffColors[territory.difficulty]};font-size:11px;letter-spacing:1px;text-transform:uppercase;margin-bottom:16px;border-radius:2px;`;
    diffBadge.textContent = territory.difficulty;
    panel.appendChild(diffBadge);

    // Briefing text — try real campaign strings first
    let briefingText: string | null = null;
    if (missionConfig) {
      briefingText = lookupBriefingText(missionConfig.briefingKey);
    }

    if (briefingText) {
      const briefing = document.createElement('div');
      briefing.style.cssText = 'color:#c8b060;font-size:13px;font-style:italic;margin-bottom:20px;line-height:1.5;text-align:left;';
      briefing.textContent = briefingText;
      panel.appendChild(briefing);
    } else if (territory.description) {
      const desc = document.createElement('div');
      desc.style.cssText = 'color:#aaa;font-size:14px;line-height:1.5;margin-bottom:16px;';
      desc.textContent = territory.description;
      panel.appendChild(desc);
    }

    // Intel section
    const objective = objectiveOverride ??
      (missionConfig ? VICTORY_OBJECTIVES[missionConfig.victoryCondition] : null) ??
      VICTORY_OBJECTIVES.conyard;

    const intel = document.createElement('div');
    intel.style.cssText = 'text-align:left;margin-bottom:20px;padding:12px;background:rgba(0,0,0,0.3);border:1px solid #333;border-radius:3px;';

    let intelContent = `
      <div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Intelligence Report</div>
      <div style="color:#ccc;font-size:12px;margin-bottom:4px;">Your House: <span style="color:#4af;font-weight:bold;">${houseName}</span></div>
      <div style="color:#ccc;font-size:12px;margin-bottom:4px;">Enemy: <span style="color:#f88;font-weight:bold;">${enemyHouseName}</span></div>
    `;

    if (missionConfig?.subHousePresent) {
      const subNames: Record<string, string> = {
        FR: 'Fremen', SA: 'Sardaukar', IX: 'Ixian', TL: 'Tleilaxu', SM: 'Smuggler', GU: 'Guild',
      };
      intelContent += `<div style="color:#ccc;font-size:12px;margin-bottom:4px;">Sub-House: <span style="color:#ff8;font-weight:bold;">${subNames[missionConfig.subHousePresent] ?? missionConfig.subHousePresent}</span></div>`;
    }

    if (missionConfig) {
      intelContent += `<div style="color:#ccc;font-size:12px;margin-bottom:4px;">Starting Credits: <span style="color:#ff8;">${missionConfig.startingCredits.toLocaleString()}</span></div>`;
    }

    intelContent += `
      <div style="color:#ccc;font-size:12px;margin-bottom:8px;">Objective: <span style="color:#ff8;">${objective}</span></div>
      <div style="color:#666;font-size:11px;">${FACTION_FLAVOR[housePrefix] ?? ''}</div>
    `;

    intel.innerHTML = intelContent;
    panel.appendChild(intel);

    // Buttons: ACCEPT and RESIGN
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:16px;justify-content:center;';

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = getCampaignString('BriefingAccept') ?? 'ACCEPT';
    acceptBtn.style.cssText = `
      padding:12px 36px;background:#2a1a00;border:2px solid #d4a840;
      color:#d4a840;cursor:pointer;font-size:16px;font-weight:bold;
      letter-spacing:2px;transition:all 0.2s;
    `;
    acceptBtn.onmouseenter = () => { acceptBtn.style.background = '#3a2a10'; acceptBtn.style.borderColor = '#ffcc44'; acceptBtn.style.color = '#ffcc44'; };
    acceptBtn.onmouseleave = () => { acceptBtn.style.background = '#2a1a00'; acceptBtn.style.borderColor = '#d4a840'; acceptBtn.style.color = '#d4a840'; };

    const resignBtn = document.createElement('button');
    resignBtn.textContent = getCampaignString('BriefingResign') ?? 'RESIGN';
    resignBtn.style.cssText = `
      padding:12px 24px;background:#1a1a1a;border:2px solid #555;
      color:#888;cursor:pointer;font-size:14px;
      letter-spacing:1px;transition:all 0.2s;
    `;
    resignBtn.onmouseenter = () => { resignBtn.style.borderColor = '#888'; resignBtn.style.color = '#aaa'; };
    resignBtn.onmouseleave = () => { resignBtn.style.borderColor = '#555'; resignBtn.style.color = '#888'; };

    let dismissed = false;
    const dismiss = (result: 'accept' | 'resign') => {
      if (dismissed) return;
      dismissed = true;
      overlay.remove();
      resolve(result);
    };

    acceptBtn.onclick = () => dismiss('accept');
    resignBtn.onclick = () => dismiss('resign');

    btnRow.appendChild(acceptBtn);
    btnRow.appendChild(resignBtn);
    panel.appendChild(btnRow);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    acceptBtn.focus();
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') dismiss('accept');
      if (e.key === 'Escape') dismiss('resign');
    });
  });
}
