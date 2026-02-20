/**
 * Sub-house alliance system.
 *
 * In campaign mode, sub-house alliances are earned through missions,
 * not picked upfront. After winning a mission featuring a sub-house,
 * the player can choose to ally with them.
 *
 * Constraints:
 * - Max 2 active alliances
 * - Ix and Tleilaxu are mutually exclusive
 * - Alliances unlock sub-house units in the sidebar
 */

import type { HousePrefix, FactionPrefix } from './CampaignData';
import { getSubHousesForPhase, getMissionsForSubHouse } from './CampaignData';

export type AllianceSubHouse = 'FR' | 'SA' | 'IX' | 'TL' | 'GU';

export interface SubHouseAlliance {
  subHouse: AllianceSubHouse;
  earnedInPhase: number;
  earnedAtTerritory: number;
}

export interface SubHouseState {
  alliances: SubHouseAlliance[];
  offeredAlliance: AllianceSubHouse | null; // Pending offer after mission
  offeredPhase: number;                     // Phase when offer was made
  offeredTerritory: number;                 // Territory when offer was made
  declinedOffers: AllianceSubHouse[];       // Previously declined sub-houses
}

const MUTUAL_EXCLUSIONS: Record<AllianceSubHouse, AllianceSubHouse | null> = {
  IX: 'TL',
  TL: 'IX',
  FR: null,
  SA: null,
  GU: null,
};

const MAX_ALLIANCES = 2;

export class SubHouseSystem {
  private state: SubHouseState;
  private playerHouse: HousePrefix;

  constructor(playerHouse: HousePrefix) {
    this.playerHouse = playerHouse;
    this.state = {
      alliances: [],
      offeredAlliance: null,
      offeredPhase: 0,
      offeredTerritory: 0,
      declinedOffers: [],
    };
  }

  getState(): Readonly<SubHouseState> {
    return this.state;
  }

  getAlliances(): ReadonlyArray<SubHouseAlliance> {
    return this.state.alliances;
  }

  hasAlliance(subHouse: AllianceSubHouse): boolean {
    return this.state.alliances.some(a => a.subHouse === subHouse);
  }

  getAllianceCount(): number {
    return this.state.alliances.length;
  }

  /** Check if a sub-house can be allied with (not excluded, not at max). */
  canAlly(subHouse: AllianceSubHouse): boolean {
    if (this.hasAlliance(subHouse)) return false;
    if (this.state.alliances.length >= MAX_ALLIANCES) return false;

    // Check mutual exclusion
    const excluded = MUTUAL_EXCLUSIONS[subHouse];
    if (excluded && this.hasAlliance(excluded)) return false;

    return true;
  }

  /**
   * Check if a territory has a sub-house mission for the current house/phase.
   * Returns the sub-house prefix if found, null otherwise.
   */
  getSubHouseForTerritory(phase: number, missionNumber: number): FactionPrefix | null {
    const missions = getSubHousesForPhase(this.playerHouse, phase);
    // Look through all sub-houses for this mission number
    for (const sh of missions) {
      const shMissions = getMissionsForSubHouse(this.playerHouse, phase, sh);
      for (const m of shMissions) {
        if (m.number === missionNumber) return sh;
      }
    }
    return null;
  }

  /**
   * Check if a mission involves a sub-house (based on briefing key pattern).
   * Returns the sub-house prefix if the mission has sub-house involvement.
   */
  getMissionSubHouse(phase: number, territoryId: number): AllianceSubHouse | null {
    const subHouses = getSubHousesForPhase(this.playerHouse, phase);
    for (const sh of subHouses) {
      if (isAllianceSubHouse(sh)) {
        const missions = getMissionsForSubHouse(this.playerHouse, phase, sh);
        for (const m of missions) {
          if (m.number === territoryId) return sh as AllianceSubHouse;
        }
      }
    }
    return null;
  }

  /**
   * After winning a sub-house mission, offer an alliance.
   * Returns the sub-house being offered, or null if already allied/can't ally.
   */
  offerAlliance(subHouse: AllianceSubHouse, phase: number, territory: number): AllianceSubHouse | null {
    if (!this.canAlly(subHouse)) return null;
    if (this.state.declinedOffers.includes(subHouse)) return null;

    this.state.offeredAlliance = subHouse;
    this.state.offeredPhase = phase;
    this.state.offeredTerritory = territory;
    return subHouse;
  }

  /** Accept the current alliance offer. Uses stored phase/territory from when offer was made. */
  acceptAlliance(): boolean {
    const sub = this.state.offeredAlliance;
    if (!sub || !this.canAlly(sub)) {
      this.state.offeredAlliance = null;
      return false;
    }

    this.state.alliances.push({
      subHouse: sub,
      earnedInPhase: this.state.offeredPhase,
      earnedAtTerritory: this.state.offeredTerritory,
    });
    this.state.offeredAlliance = null;
    return true;
  }

  /** Decline the current alliance offer. */
  declineAlliance(): void {
    if (this.state.offeredAlliance) {
      this.state.declinedOffers.push(this.state.offeredAlliance);
      this.state.offeredAlliance = null;
    }
  }

  /** Map alliance sub-house IDs to the actual unit/building prefix used in rules.txt */
  private static readonly UNIT_PREFIX: Record<AllianceSubHouse, string> = {
    FR: 'FR', SA: 'IM', IX: 'IX', TL: 'TL', GU: 'GU',
  };

  /** Get sub-house unit prefixes that should be available to the player. */
  getUnlockedPrefixes(): string[] {
    return this.state.alliances.map(a => SubHouseSystem.UNIT_PREFIX[a.subHouse]);
  }

  // ── Serialization ──────────────────────────────────────────────

  serialize(): SubHouseState {
    return {
      alliances: [...this.state.alliances],
      offeredAlliance: this.state.offeredAlliance,
      offeredPhase: this.state.offeredPhase,
      offeredTerritory: this.state.offeredTerritory,
      declinedOffers: [...this.state.declinedOffers],
    };
  }

  static deserialize(data: SubHouseState, playerHouse: HousePrefix): SubHouseSystem {
    const sys = new SubHouseSystem(playerHouse);
    sys.state = {
      alliances: [...data.alliances],
      offeredAlliance: data.offeredAlliance,
      offeredPhase: data.offeredPhase ?? 0,
      offeredTerritory: data.offeredTerritory ?? 0,
      declinedOffers: [...data.declinedOffers],
    };
    return sys;
  }
}

function isAllianceSubHouse(prefix: FactionPrefix): prefix is AllianceSubHouse {
  return prefix === 'FR' || prefix === 'SA' || prefix === 'IX' || prefix === 'TL' || prefix === 'GU';
}
