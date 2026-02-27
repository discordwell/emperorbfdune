/**
 * House-specific build order templates.
 * Maps from AIPlayer.ts build phases to oracle's declarative format.
 */

export interface BuildOrderStep {
  typeName: string;
  /** When true, this is a structure; when false, it's a unit */
  isBuilding: true;
}

export type HousePrefix = 'AT' | 'HK' | 'OR';

/**
 * Returns the build order for a given house prefix.
 * Phases 0-9 match AIPlayer.ts; beyond that, the RuleEngine
 * uses dynamic decisions (more refineries, factories, etc.)
 */
export function getBuildOrder(prefix: HousePrefix): BuildOrderStep[] {
  return [
    { typeName: `${prefix}SmWindtrap`, isBuilding: true },   // 0: first power
    { typeName: `${prefix}Refinery`, isBuilding: true },      // 1: economy
    { typeName: `${prefix}Barracks`, isBuilding: true },      // 2: infantry production
    { typeName: `${prefix}Factory`, isBuilding: true },       // 3: vehicle production
    { typeName: `${prefix}Outpost`, isBuilding: true },       // 4: radar / upgrades
    { typeName: `${prefix}SmWindtrap`, isBuilding: true },    // 5: second power
    { typeName: `${prefix}SmWindtrap`, isBuilding: true },    // 6: third power
    { typeName: `${prefix}Refinery`, isBuilding: true },      // 7: second refinery
    { typeName: `${prefix}Hanger`, isBuilding: true },        // 8: aircraft
    { typeName: `${prefix}SmWindtrap`, isBuilding: true },    // 9: fourth power
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
 * Default unit pools per house. Used by RuleEngine when no rules data is available.
 * These are the most common units you'd train in each category.
 */
export function getDefaultUnitPool(prefix: HousePrefix): {
  infantry: string[];
  vehicles: string[];
  aircraft: string[];
} {
  switch (prefix) {
    case 'AT':
      return {
        infantry: ['ATLightInf', 'ATInfantry', 'ATKindjal', 'ATSniper'],
        vehicles: ['ATMongoose', 'ATMirage', 'ATSonicTank'],
        aircraft: ['ATOrnithopter'],
      };
    case 'HK':
      return {
        infantry: ['HKLightInf', 'HKInfantry', 'HKFlamer'],
        vehicles: ['HKBuzzsaw', 'HKAssaultTank', 'HKMissile', 'HKDevastator'],
        aircraft: ['HKGunship'],
      };
    case 'OR':
      return {
        infantry: ['ORLightInf', 'ORInfantry', 'ORChemTroop'],
        vehicles: ['ORDust', 'ORLaser', 'ORKobra'],
        aircraft: [],
      };
    default:
      return { infantry: [], vehicles: [], aircraft: [] };
  }
}
