import type { Territory } from '../ui/CampaignMap';
import type { CampaignPhaseManager } from '../campaign/CampaignPhaseManager';
import { JUMP_POINTS, type HousePrefix } from '../campaign/CampaignData';

const AGENT_KEY = 'ebfd_agent';

export interface AgentConfig {
  house: HousePrefix;
  strategy: 'balanced';
  civilWarChoice: 'copec' | 'gunseng';
  missionCount: number;
}

export function isAgentMode(): boolean {
  return localStorage.getItem(AGENT_KEY) !== null;
}

export function getAgentConfig(): AgentConfig | null {
  const raw = localStorage.getItem(AGENT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return null;
  }
}

export function startAgent(house: string): void {
  const hp = house.toUpperCase() as HousePrefix;
  if (hp !== 'AT' && hp !== 'HK' && hp !== 'OR') {
    console.error('[Agent] Invalid house. Use AT, HK, or OR.');
    return;
  }
  const config: AgentConfig = {
    house: hp,
    strategy: 'balanced',
    civilWarChoice: 'copec',
    missionCount: 0,
  };
  // Clear any existing campaign state so agent starts fresh
  localStorage.removeItem('ebfd_campaign');
  localStorage.removeItem('ebfd_campaign_next');
  localStorage.setItem(AGENT_KEY, JSON.stringify(config));
  console.log(`[Agent] Starting as House ${hp}. Reloading...`);
  window.location.reload();
}

export function stopAgent(): void {
  localStorage.removeItem(AGENT_KEY);
  console.log('[Agent] Agent mode disabled. Reloading...');
  window.location.reload();
}

/**
 * Pick a territory to attack based on strategy:
 * - Phase 3+: prioritize enemy jump-point territories
 * - Otherwise: pick territory with most adjacent player-owned neighbors (safest expansion)
 * - Tiebreak: lowest territory ID (deterministic)
 */
export function pickTerritoryWithContext(
  attackable: Territory[],
  allTerritories: Territory[],
  phaseManager: CampaignPhaseManager,
  playerHouse: HousePrefix,
): Territory {
  if (attackable.length === 0) {
    throw new Error('[Agent] No attackable territories');
  }

  const phase = phaseManager.getCurrentPhase();

  // Phase 3+: prioritize jump points
  if (phase >= 3) {
    const playerJP = JUMP_POINTS[playerHouse];
    const jpIds = new Set(
      Object.values(JUMP_POINTS).filter(jp => jp !== playerJP)
    );
    const jpTargets = attackable.filter(t => jpIds.has(t.id));
    if (jpTargets.length > 0) {
      console.log(`[Agent] Phase ${phase}: prioritizing jump-point territories`);
      attackable = jpTargets;
    }
  }

  // Build a set of player-owned territory IDs for adjacency scoring
  const playerIds = new Set(
    allTerritories.filter(t => t.owner === 'player').map(t => t.id)
  );

  let best: Territory = attackable[0];
  let bestScore = -1;

  for (const t of attackable) {
    const adjacentPlayerCount = t.adjacent.filter(adjId => playerIds.has(adjId)).length;
    const diffScore = t.difficulty === 'easy' ? 3 : t.difficulty === 'normal' ? 2 : 1;
    const score = adjacentPlayerCount * 10 + diffScore;
    if (score > bestScore || (score === bestScore && t.id < best.id)) {
      best = t;
      bestScore = score;
    }
  }

  return best;
}
