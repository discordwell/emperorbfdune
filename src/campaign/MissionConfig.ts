/**
 * Mission configuration generator.
 *
 * Since .tok mission scripts can't be parsed, this generates mission
 * parameters from phase type, difficulty, and territory context.
 */

import { simRng } from '../utils/DeterministicRNG';
import type { HousePrefix, FactionPrefix } from './CampaignData';
import { calculateDifficulty, getCampaignString, JUMP_POINTS, HOMEWORLDS, SPECIAL_MISSIONS } from './CampaignData';
import type { PhaseType } from './CampaignPhaseManager';
import type { AllianceSubHouse } from './SubHouseSystem';

export type VictoryCondition = 'conyard' | 'annihilate' | 'survival' | 'protect';

export interface MissionConfigData {
  victoryCondition: VictoryCondition;
  difficultyValue: number;        // Calculated difficulty (affects AI reserves/reinforcements)
  startingCredits: number;
  aiPersonality: number;           // 0-4
  enemyHouse: HousePrefix;         // Which house the AI plays
  subHousePresent: AllianceSubHouse | null; // Sub-house with units on the map
  isAttack: boolean;               // Player is attacking (vs defending)
  isSpecial: boolean;              // Heighliner/HWD/HWA/CivilWar/Final
  specialType: PhaseType | null;
  briefingKey: string;             // Key for looking up briefing text
  miniBriefingKey: string;         // Key for mini-briefing (territory hover)
  territoryName: string;
  phaseNumber: number;
  /** Mission script ID for declarative scripting (e.g., 'ATP2M15IX'). */
  scriptId?: string;
}

/** Starting credits by situation. */
const CREDITS_BY_PHASE: Record<string, number> = {
  attack_1: 5000,
  attack_2: 5000,
  attack_3: 5000,
  defend_1: 2500,
  defend_2: 2500,
  defend_3: 2500,
  heighliner: 3000,
  homeDefense: 3000,
  homeAttack: 5000,
  civilWar: 4000,
  final: 7500,
};

import type { TerritoryAttempt } from './CampaignPhaseManager';

/**
 * Select the mission script variant based on attempt history.
 * Chain: M (first) → D (replay) → Fail (after D loss) / Win (after D win, rare).
 * Falls back to earlier variants if the requested one doesn't exist in manifest.
 */
export function selectScriptVariant(
  baseScriptId: string,
  history: TerritoryAttempt | undefined,
): string {
  if (!history || history.attempts === 0) {
    // First time: M-variant (the baseScriptId already contains 'M')
    return baseScriptId;
  }

  // Extract the pattern: {HOUSE}P{PHASE}M{TERRITORY}{SUBHOUSE}
  // Replace M with D for replay variants
  const dVariant = baseScriptId.replace(/P(\d+)M(\d+)/, 'P$1D$2');
  if (dVariant === baseScriptId) {
    // Not a standard mission pattern (special mission) — no variants
    return baseScriptId;
  }

  if (history.attempts === 1 || history.lastOutcome === 'none') {
    // Second attempt → D-variant
    return dVariant;
  }

  if (history.attempts >= 2) {
    // After D-variant: Fail if lost, Win if won
    if (history.lastOutcome === 'defeat') {
      return dVariant + 'Fail';
    }
    if (history.lastOutcome === 'victory') {
      return dVariant + 'Win';
    }
    // Default to D
    return dVariant;
  }

  return baseScriptId;
}

/**
 * Generate mission configuration for a campaign battle.
 */
export function generateMissionConfig(params: {
  playerHouse: HousePrefix;
  phase: number;
  phaseType: PhaseType;
  territoryId: number;
  territoryName: string;
  enemyHouse: HousePrefix;
  isAttack: boolean;
  territoryDiff: number;        // Difference in territory count (player - enemy)
  subHousePresent: AllianceSubHouse | null;
  aiPersonality?: number;
  territoryHistory?: TerritoryAttempt;
}): MissionConfigData {
  const {
    playerHouse, phase, phaseType, territoryId, territoryName,
    enemyHouse, isAttack, territoryDiff, subHousePresent,
    aiPersonality = Math.floor(simRng.random() * 5),
  } = params;

  // Victory condition based on phase type
  let victoryCondition: VictoryCondition;
  let isSpecial = false;

  switch (phaseType) {
    case 'tutorial':
      victoryCondition = 'conyard';
      isSpecial = true;
      break;
    case 'heighliner':
      victoryCondition = 'survival';
      isSpecial = true;
      break;
    case 'homeDefense':
      victoryCondition = 'protect';
      isSpecial = true;
      break;
    case 'homeAttack':
      victoryCondition = 'annihilate';
      isSpecial = true;
      break;
    case 'civilWar':
      victoryCondition = isAttack ? 'annihilate' : 'protect';
      isSpecial = true;
      break;
    case 'final':
      victoryCondition = 'annihilate';
      isSpecial = true;
      break;
    default:
      // Standard missions: conyard for early phases, annihilate for late
      victoryCondition = phase >= 3 ? 'annihilate' : 'conyard';
      break;
  }

  // Difficulty calculation
  const difficultyValue = calculateDifficulty(territoryDiff, phase);

  // Starting credits
  let creditsKey: string;
  if (isSpecial) {
    creditsKey = phaseType;
  } else {
    creditsKey = `${isAttack ? 'attack' : 'defend'}_${Math.min(3, phase)}`;
  }
  const startingCredits = CREDITS_BY_PHASE[creditsKey] ?? 5000;

  // Briefing key construction: {HOUSE}P{PHASE}M{TERRITORY}{SUBHOUSE}
  const briefingKey = buildBriefingKey(playerHouse, phase, phaseType, territoryId, subHousePresent, enemyHouse);
  const miniBriefingKey = buildMiniBriefingKey(playerHouse, phase, phaseType, territoryId, subHousePresent, enemyHouse);

  // Script ID for .tok lookup: special missions use SPECIAL_MISSIONS names,
  // standard missions use the briefing key pattern (e.g., ATP2M15IX)
  // then apply variant selection (M → D → Fail/Win) based on territory history
  let scriptId: string;
  if (isSpecial && SPECIAL_MISSIONS[phaseType]?.[playerHouse]) {
    scriptId = SPECIAL_MISSIONS[phaseType][playerHouse];
  } else {
    scriptId = selectScriptVariant(briefingKey, params.territoryHistory);
  }

  return {
    victoryCondition,
    difficultyValue,
    startingCredits,
    aiPersonality,
    enemyHouse,
    subHousePresent,
    isAttack,
    isSpecial,
    specialType: isSpecial ? phaseType : null,
    briefingKey,
    miniBriefingKey,
    territoryName,
    phaseNumber: phase,
    scriptId,
  };
}

/**
 * Build briefing text key for full briefing.
 * Pattern: {HOUSE}P{PHASE}M{NUMBER}{SUBHOUSE}
 */
function buildBriefingKey(
  house: HousePrefix, phase: number, phaseType: PhaseType,
  territoryId: number, subHouse: AllianceSubHouse | null, enemy: HousePrefix,
): string {
  // Special mission briefing keys
  if (phaseType === 'homeDefense') {
    return `${house}HWD`;
  }
  if (phaseType === 'heighliner') {
    return `${house}Heighliner`;
  }
  if (phaseType === 'homeAttack') {
    return `${house}HWA`;
  }
  if (phaseType === 'civilWar') {
    return `${house}CivilWar`;
  }
  if (phaseType === 'final') {
    return `${house}Final`;
  }

  // Standard mission: try sub-house first, then enemy, then generic
  const suffix = subHouse ?? enemy ?? 'GN';
  return `${house}P${phase}M${territoryId}${suffix}`;
}

/**
 * Build mini-briefing key (shown on territory hover).
 * Tries: key + "Mini", key + "MB", then falls back to full briefing key.
 */
function buildMiniBriefingKey(
  house: HousePrefix, phase: number, phaseType: PhaseType,
  territoryId: number, subHouse: AllianceSubHouse | null, enemy: HousePrefix,
): string {
  // Special missions
  if (phaseType === 'homeDefense') return `${house}HWDmb`;
  if (phaseType === 'heighliner') return `${house}HeighlinerMini`;
  if (phaseType === 'homeAttack') return `${house}HWAmb`;
  if (phaseType === 'civilWar') return `${house}CivilWarmb`;
  if (phaseType === 'final') return `${house}FinalMini`;

  const suffix = subHouse ?? enemy ?? 'GN';
  return `${house}P${phase}M${territoryId}${suffix}Mini`;
}

/**
 * Look up briefing text with case-insensitive fallback.
 * Tries multiple key patterns:
 * 1. Exact key
 * 2. Key with "Mini" suffix (for mini-briefing)
 * 3. Key with "MB" suffix
 * 4. Base key without sub-house suffix
 */
export function lookupBriefingText(key: string): string | null {
  // Try exact key
  let text = getCampaignString(key);
  if (text) return text;

  // Try with "Mini" suffix
  text = getCampaignString(key + 'Mini');
  if (text) return text;

  // Try with "MB" suffix
  text = getCampaignString(key + 'MB');
  if (text) return text;

  // Try stripping sub-house suffix and searching
  const baseMatch = key.match(/^((?:AT|HK|OR)P\d+M\d+)/i);
  if (baseMatch) {
    const base = baseMatch[1];
    // Try with just the base
    text = getCampaignString(base);
    if (text) return text;
  }

  return null;
}

/**
 * Look up mini-briefing text with fallback chain.
 */
export function lookupMiniBriefing(key: string): string | null {
  let text = getCampaignString(key);
  if (text) return text;

  // Try replacing "Mini" with "MB"
  text = getCampaignString(key.replace(/Mini$/, 'MB'));
  if (text) return text;

  // Try without the Mini/MB suffix entirely
  text = getCampaignString(key.replace(/(?:Mini|MB)$/, ''));
  if (text) return text;

  return null;
}

/**
 * Get the special mission name for the current phase.
 */
export function getSpecialMissionName(house: HousePrefix, phaseType: PhaseType): string {
  const missions = SPECIAL_MISSIONS[phaseType];
  if (!missions) return '';
  return missions[house] ?? '';
}
