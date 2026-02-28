/**
 * House-specific build order templates and unit pools.
 * Type names must match the canonical names from rules.txt sections.
 */

export interface BuildOrderStep {
  typeName: string;
  /** When true, this is a structure; when false, it's a unit */
  isBuilding: true;
}

export type HousePrefix = 'AT' | 'HK' | 'OR';

/**
 * Returns the build order for a given house prefix.
 * The RuleEngine walks this list against ownedBuildingTypes each tick,
 * returning the first entry that isn't yet satisfied.
 *
 * Note: player starts with ConYard + SmWindtrap + Barracks + Factory + Refinery,
 * so early entries will be skipped in fresh skirmish games.
 */
export function getBuildOrder(prefix: HousePrefix): BuildOrderStep[] {
  return [
    { typeName: `${prefix}SmWindtrap`, isBuilding: true },   // 0: first power
    { typeName: `${prefix}Refinery`, isBuilding: true },      // 1: economy
    { typeName: `${prefix}Barracks`, isBuilding: true },      // 2: infantry production
    { typeName: `${prefix}Factory`, isBuilding: true },       // 3: vehicle production
    { typeName: `${prefix}Outpost`, isBuilding: true },       // 4: radar
    { typeName: `${prefix}SmWindtrap`, isBuilding: true },    // 5: second power
    { typeName: `${prefix}SmWindtrap`, isBuilding: true },    // 6: third power
    { typeName: `${prefix}Refinery`, isBuilding: true },      // 7: second refinery
    { typeName: `${prefix}SmWindtrap`, isBuilding: true },    // 8: fourth power
    { typeName: `${prefix}Hanger`, isBuilding: true },        // 9: aircraft (tech 5)
    { typeName: `${prefix}SmWindtrap`, isBuilding: true },    // 10: fifth power
    { typeName: `${prefix}Starport`, isBuilding: true },      // 11: starport (tech 7)
  ];
}

/** Unit composition targets by role (proportion of total army) */
export const COMPOSITION_GOAL = {
  antiVeh: 0.4,
  antiInf: 0.3,
  antiBldg: 0.2,
  scout: 0.1,
};

/**
 * Default unit pools per house — only includes units that are actually
 * buildable in skirmish (not campaign-only/aiSpecial).
 * Ordered from cheapest/most available to most expensive.
 */
export function getDefaultUnitPool(prefix: HousePrefix): {
  infantry: string[];
  vehicles: string[];
  aircraft: string[];
} {
  switch (prefix) {
    case 'AT':
      return {
        // ATScout (tech 1), ATInfantry (tech 1), ATSniper (tech 1), ATMilitia (tech 1)
        // ATKindjal requires upgraded Barracks
        infantry: ['ATScout', 'ATInfantry', 'ATSniper', 'ATMilitia'],
        // ATTrike (tech 1) — ATMongoose needs tech 3
        vehicles: ['ATTrike'],
        // ATOrni needs Hanger (tech 5)
        aircraft: ['ATOrni'],
      };
    case 'HK':
      return {
        // HKScout, HKLightInf, HKTrooper, HKFlamer
        infantry: ['HKScout', 'HKLightInf', 'HKTrooper', 'HKFlamer'],
        // HKBuzzsaw (tech 1), HKAssault, HKFlame, HKInkVine
        vehicles: ['HKBuzzsaw', 'HKAssault', 'HKFlame'],
        // HKGunship needs Hanger
        aircraft: ['HKGunship'],
      };
    case 'OR':
      return {
        // ORScout, ORChemical, ORAATrooper, ORMortar
        infantry: ['ORScout', 'ORChemical', 'ORAATrooper', 'ORMortar'],
        // ORDustScout, ORLaserTank, ORKobra
        vehicles: ['ORDustScout', 'ORLaserTank'],
        aircraft: [],
      };
    default:
      return { infantry: [], vehicles: [], aircraft: [] };
  }
}

/**
 * Harvester type name — shared across all houses (no prefix).
 */
export const HARVESTER_TYPE = 'Harvester';
