/**
 * Campaign phase state machine — exact replica of PhaseRules.txt.
 *
 * Phase progression:
 *   0 (Tutorial) -> 1 (Act 1) -> 10 (Heighliner) -> 2 (Act 2) -> 11 (Home Defense)
 *   -> [14/15 HK Civil War] -> 3 (Act 3) -> 12 (Home Attack) -> 13 (Final/Emperor Worm)
 *
 * Tech levels (1-8) tied to phase entry + capture milestones.
 */

import type { HousePrefix } from './CampaignData';

export type PhaseType = 'tutorial' | 'act' | 'heighliner' | 'homeDefense' | 'civilWar' | 'homeAttack' | 'final';

interface PhaseRule {
  battles: number;        // Required battles to advance
  captured: number;       // Required captures to advance
  maxBattles: number;     // Max battles before forced advance (0 = unlimited)
  jumpToChoice1: number;  // Next phase when requirements met
  jumpPoint: boolean;     // Must capture jump point to advance (Phase 3)
  warning: number;        // Battles without capture before warning (Phase 3)
  lose: number;           // Battles without capture before loss (Phase 3)
  type: PhaseType;
}

// Phase rules from PhaseRules.txt
const PHASE_RULES: Record<number, PhaseRule> = {
  0:  { battles: 0, captured: 0, maxBattles: 0, jumpToChoice1: 0, jumpPoint: false, warning: 0, lose: 0, type: 'tutorial' },
  1:  { battles: 2, captured: 1, maxBattles: 2, jumpToChoice1: 10, jumpPoint: false, warning: 0, lose: 0, type: 'act' },
  10: { battles: 1, captured: 0, maxBattles: 0, jumpToChoice1: 2, jumpPoint: false, warning: 0, lose: 0, type: 'heighliner' },
  2:  { battles: 2, captured: 1, maxBattles: 2, jumpToChoice1: 11, jumpPoint: false, warning: 0, lose: 0, type: 'act' },
  11: { battles: 1, captured: 0, maxBattles: 0, jumpToChoice1: 3, jumpPoint: false, warning: 0, lose: 0, type: 'homeDefense' },
  14: { battles: 1, captured: 0, maxBattles: 0, jumpToChoice1: 3, jumpPoint: false, warning: 0, lose: 0, type: 'civilWar' },
  15: { battles: 1, captured: 0, maxBattles: 0, jumpToChoice1: 3, jumpPoint: false, warning: 0, lose: 0, type: 'civilWar' },
  3:  { battles: 0, captured: 0, maxBattles: 0, jumpToChoice1: 12, jumpPoint: true, warning: 3, lose: 5, type: 'act' },
  12: { battles: 1, captured: 0, maxBattles: 0, jumpToChoice1: 13, jumpPoint: false, warning: 0, lose: 0, type: 'homeAttack' },
  13: { battles: 1, captured: 0, maxBattles: 0, jumpToChoice1: 0, jumpPoint: false, warning: 0, lose: 0, type: 'final' },
};

// Tech level rules from PhaseRules.txt
interface TechLevelRule {
  phase?: number;     // Advance when entering this phase
  captured?: number;  // Advance after N captures in current phase
}

const TECH_LEVEL_RULES: Record<number, TechLevelRule> = {
  1: { phase: 1 },
  2: { captured: 1 },
  3: { phase: 2 },
  4: { captured: 1 },
  5: { phase: 3 },
  6: { captured: 1 },
  7: { captured: 2 },
  8: { phase: 12 },
};

// ── Phase State ────────────────────────────────────────────────────

export interface PhaseState {
  currentPhase: number;
  battlesInPhase: number;
  capturesInPhase: number;
  totalBattles: number;
  totalCaptures: number;
  techLevel: number;
  jumpPointCaptured: boolean;
  battlesWithoutCapture: number; // For Phase 3 warning/lose
  isWarned: boolean;
  isLost: boolean;
  isVictory: boolean;
  civilWarChoice: 'copec' | 'gunseng' | null; // For HK civil war
  playerHouse: HousePrefix;
}

export class CampaignPhaseManager {
  private state: PhaseState;

  constructor(playerHouse: HousePrefix) {
    this.state = {
      currentPhase: 0,
      battlesInPhase: 0,
      capturesInPhase: 0,
      totalBattles: 0,
      totalCaptures: 0,
      techLevel: 1,
      jumpPointCaptured: false,
      battlesWithoutCapture: 0,
      isWarned: false,
      isLost: false,
      isVictory: false,
      civilWarChoice: null,
      playerHouse,
    };
    // Tutorial auto-advances to Phase 1
    this.advancePhase(1);
  }

  getState(): Readonly<PhaseState> {
    return this.state;
  }

  getCurrentPhase(): number {
    return this.state.currentPhase;
  }

  getCurrentTechLevel(): number {
    return this.state.techLevel;
  }

  getPhaseType(): PhaseType {
    return PHASE_RULES[this.state.currentPhase]?.type ?? 'act';
  }

  isSpecialMission(): boolean {
    const type = this.getPhaseType();
    return type !== 'act' && type !== 'tutorial';
  }

  isGameOver(): boolean {
    return this.state.isLost || this.state.isVictory;
  }

  /** Get the campaign act (1, 2, or 3) based on current phase. */
  getAct(): number {
    const phase = this.state.currentPhase;
    if (phase <= 1 || phase === 10) return 1;
    if (phase === 2 || phase === 11 || phase === 14 || phase === 15) return 2;
    return 3;
  }

  /** Record a battle result. Returns true if phase should advance. */
  recordBattleResult(victory: boolean, capturedTerritory: boolean, capturedJumpPoint: boolean): {
    phaseAdvanced: boolean;
    newPhase: number;
    warning: boolean;
    lost: boolean;
    civilWarChoice: boolean;
  } {
    this.state.totalBattles++;
    this.state.battlesInPhase++;

    const result = {
      phaseAdvanced: false,
      newPhase: this.state.currentPhase,
      warning: false,
      lost: false,
      civilWarChoice: false,
    };

    if (!victory) {
      // Lost battle in Phase 3 tracking
      if (this.state.currentPhase === 3) {
        this.state.battlesWithoutCapture++;
        const rule = PHASE_RULES[3];
        if (rule.lose && this.state.battlesWithoutCapture >= rule.lose) {
          this.state.isLost = true;
          result.lost = true;
        } else if (rule.warning && this.state.battlesWithoutCapture >= rule.warning && !this.state.isWarned) {
          this.state.isWarned = true;
          result.warning = true;
        }
      }
      return result;
    }

    // Victory
    if (capturedTerritory) {
      this.state.totalCaptures++;
      this.state.capturesInPhase++;
      this.state.battlesWithoutCapture = 0;
      this.updateTechLevel();
    } else if (this.state.currentPhase === 3) {
      this.state.battlesWithoutCapture++;
      const rule = PHASE_RULES[3];
      if (rule.warning && this.state.battlesWithoutCapture >= rule.warning && !this.state.isWarned) {
        this.state.isWarned = true;
        result.warning = true;
      }
    }

    if (capturedJumpPoint) {
      this.state.jumpPointCaptured = true;
    }

    // Check phase advancement
    const rule = PHASE_RULES[this.state.currentPhase];
    if (!rule) return result;

    let shouldAdvance = false;

    if (rule.type === 'heighliner' || rule.type === 'homeDefense' || rule.type === 'civilWar' ||
        rule.type === 'homeAttack' || rule.type === 'final') {
      // Special missions: advance after 1 battle (win)
      shouldAdvance = this.state.battlesInPhase >= rule.battles;
    } else if (rule.jumpPoint) {
      // Phase 3: must capture jump point
      shouldAdvance = this.state.jumpPointCaptured;
    } else if (rule.type === 'act') {
      // Acts 1 & 2: need battles + captures, OR maxBattles reached
      const metRequirements = this.state.battlesInPhase >= rule.battles &&
                              this.state.capturesInPhase >= rule.captured;
      const maxReached = rule.maxBattles > 0 && this.state.battlesInPhase >= rule.maxBattles;
      shouldAdvance = metRequirements || maxReached;
    }

    if (shouldAdvance) {
      if (rule.type === 'final') {
        // Victory!
        this.state.isVictory = true;
        result.phaseAdvanced = true;
        result.newPhase = this.state.currentPhase;
        return result;
      }

      // Phase 11 (Home Defense) for Harkonnen -> civil war choice
      if (this.state.currentPhase === 11 && this.state.playerHouse === 'HK') {
        result.civilWarChoice = true;
        // Don't auto-advance; wait for civil war choice
        return result;
      }

      const nextPhase = rule.jumpToChoice1 || this.getNextMainPhase();
      this.advancePhase(nextPhase);
      result.phaseAdvanced = true;
      result.newPhase = nextPhase;
    }

    return result;
  }

  /** Set Harkonnen civil war choice and advance to appropriate phase. */
  setCivilWarChoice(choice: 'copec' | 'gunseng'): void {
    this.state.civilWarChoice = choice;
    const nextPhase = choice === 'copec' ? 14 : 15;
    this.advancePhase(nextPhase);
  }

  private advancePhase(newPhase: number): void {
    this.state.currentPhase = newPhase;
    this.state.battlesInPhase = 0;
    this.state.capturesInPhase = 0;
    this.state.jumpPointCaptured = false;
    this.state.isWarned = false;
    this.updateTechLevel();
  }

  private getNextMainPhase(): number {
    // Fallback progression
    switch (this.state.currentPhase) {
      case 0: return 1;
      case 1: return 10;
      case 10: return 2;
      case 2: return 11;
      case 11: return 3;
      case 14: return 3;
      case 15: return 3;
      case 3: return 12;
      case 12: return 13;
      default: return this.state.currentPhase;
    }
  }

  /** Map non-monotonic phase IDs to a monotonic progression index for tech level comparison.
   *  Phase progression: 0->1->10->2->11->[14/15]->3->12->13
   *  Monotonic order:   0  1  2   3  4    5       6  7   8  */
  private static readonly PHASE_ORDER: Record<number, number> = {
    0: 0, 1: 1, 10: 2, 2: 3, 11: 4, 14: 5, 15: 5, 3: 6, 12: 7, 13: 8,
  };

  private updateTechLevel(): void {
    // Check each tech level in order
    const currentOrder = CampaignPhaseManager.PHASE_ORDER[this.state.currentPhase] ?? 0;
    for (let level = this.state.techLevel + 1; level <= 8; level++) {
      const rule = TECH_LEVEL_RULES[level];
      if (!rule) continue;

      let achieved = false;
      if (rule.phase !== undefined) {
        // Compare using monotonic ordering, not raw phase IDs
        const requiredOrder = CampaignPhaseManager.PHASE_ORDER[rule.phase] ?? 0;
        achieved = currentOrder >= requiredOrder;
      }
      if (rule.captured !== undefined && !achieved) {
        achieved = this.state.capturesInPhase >= rule.captured;
      }

      if (achieved) {
        this.state.techLevel = level;
      } else {
        break; // Tech levels must be achieved in order
      }
    }
  }

  // ── Serialization ──────────────────────────────────────────────

  serialize(): PhaseState {
    return { ...this.state };
  }

  static deserialize(data: PhaseState): CampaignPhaseManager {
    const mgr = new CampaignPhaseManager(data.playerHouse);
    Object.assign(mgr.state, data);
    return mgr;
  }
}
