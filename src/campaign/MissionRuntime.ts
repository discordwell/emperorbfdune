import type { Difficulty } from '../ui/HouseSelect';
import type { PhaseType } from './CampaignPhaseManager';
import type { MissionConfigData } from './MissionConfig';

export type RuntimeVictoryCondition = 'annihilate' | 'conyard' | 'survival' | 'protect';

export interface MissionRuntimeSettings {
  victoryCondition: RuntimeVictoryCondition;
  objectiveLabel: string;
  timedObjectiveTicks: number;
  playerStartingCredits: number | null;
  aiStartingCredits: number | null;
  aiDifficulty: Difficulty | null;
  aiPersonality: number | null;
}

const SURVIVAL_MISSION_TICKS = 25 * 60 * 8; // 8 minutes at 25 TPS

function difficultyValueToPreset(value: number): Difficulty {
  if (value <= 45) return 'easy';
  if (value <= 90) return 'normal';
  return 'hard';
}

function objectiveFromCondition(
  condition: RuntimeVictoryCondition,
  specialType: MissionConfigData['specialType'] | undefined | null,
): string {
  if (condition === 'conyard') return 'Destroy the enemy Construction Yard';
  if (condition === 'survival') {
    return specialType === 'heighliner'
      ? 'Survive until reinforcements arrive'
      : 'Survive the enemy onslaught';
  }
  if (condition === 'protect') {
    return specialType === 'homeDefense'
      ? 'Protect your Construction Yard'
      : 'Protect your base';
  }
  if (specialType === 'final') return 'Defeat the Emperor Worm';
  return 'Destroy all enemy structures';
}

export function deriveMissionRuntimeSettings(params: {
  missionConfig?: MissionConfigData | null;
  phaseType?: PhaseType;
  phase?: number;
}): MissionRuntimeSettings | null {
  const { missionConfig, phaseType, phase = 1 } = params;

  if (missionConfig) {
    const condition = missionConfig.victoryCondition as RuntimeVictoryCondition;
    const timedTicks = (condition === 'survival' || condition === 'protect')
      ? SURVIVAL_MISSION_TICKS
      : 0;
    const aiCreditBonus = Math.max(0, missionConfig.difficultyValue - 45) * 15;

    return {
      victoryCondition: condition,
      objectiveLabel: objectiveFromCondition(condition, missionConfig.specialType),
      timedObjectiveTicks: timedTicks,
      playerStartingCredits: missionConfig.startingCredits,
      aiStartingCredits: missionConfig.startingCredits + aiCreditBonus,
      aiDifficulty: difficultyValueToPreset(missionConfig.difficultyValue),
      aiPersonality: missionConfig.aiPersonality,
    };
  }

  if (!phaseType) return null;

  const fallbackByPhaseType: Record<string, { c: RuntimeVictoryCondition; label: string; timed: number }> = {
    heighliner: { c: 'survival', label: 'Survive the Heighliner mission', timed: SURVIVAL_MISSION_TICKS },
    homeDefense: { c: 'protect', label: 'Defend your homeworld', timed: SURVIVAL_MISSION_TICKS },
    homeAttack: { c: 'annihilate', label: 'Destroy all enemy structures', timed: 0 },
    civilWar: { c: 'annihilate', label: 'Win the civil war', timed: 0 },
    final: { c: 'annihilate', label: 'Defeat the Emperor Worm', timed: 0 },
  };

  const special = fallbackByPhaseType[phaseType];
  if (special) {
    return {
      victoryCondition: special.c,
      objectiveLabel: special.label,
      timedObjectiveTicks: special.timed,
      playerStartingCredits: null,
      aiStartingCredits: null,
      aiDifficulty: null,
      aiPersonality: null,
    };
  }

  const vc: RuntimeVictoryCondition = phase >= 3 ? 'annihilate' : 'conyard';
  return {
    victoryCondition: vc,
    objectiveLabel: vc === 'annihilate'
      ? 'Destroy all enemy structures'
      : 'Destroy the enemy Construction Yard',
    timedObjectiveTicks: 0,
    playerStartingCredits: null,
    aiStartingCredits: null,
    aiDifficulty: null,
    aiPersonality: null,
  };
}
