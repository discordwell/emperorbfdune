/**
 * Shared sidebar layout constants for the original Emperor: Battle for Dune.
 * Used by both WineAdapter and QemuAdapter to translate production actions
 * into sidebar clicks at the correct screen coordinates.
 *
 * The game runs at 800x600. The sidebar occupies x=600-800.
 */

import type { HousePrefix } from '../brain/BuildOrders.js';

/**
 * Sidebar layout coordinates at 800x600 resolution.
 * The sidebar occupies x=600-800, starts at y=32 (below resource bar).
 */
export const SIDEBAR = {
  // Tab buttons
  tabs: {
    buildings: { x: 625, y: 72 },
    units: { x: 675, y: 72 },
    infantry: { x: 725, y: 72 },
    starport: { x: 775, y: 72 },
  },
  // Grid items: 2 columns, ~50px row height starting at y=124
  gridItem: (index: number) => {
    const row = Math.floor(index / 2);
    const col = index % 2;
    return {
      x: col === 0 ? 651 : 749,
      y: 124 + row * 50,
    };
  },
  /** Maximum visible y before items scroll off-screen */
  maxVisibleY: 550,
} as const;

/**
 * Sidebar production item ordering per tab.
 * These map building/unit type names to their grid position index in the sidebar.
 * Ordering matches the original game's sidebar layout (sorted by tech level, then role).
 */
export const BUILDING_ORDER: Record<HousePrefix, string[]> = {
  AT: [
    'ATSmWindtrap', 'ATWall', 'ATRefinery', 'ATBarracks', 'ATFactory',
    'ATOutpost', 'ATRocketTurret', 'ATPillbox', 'ATHanger', 'ATHelipad',
    'ATStarport', 'ATPalace',
  ],
  HK: [
    'HKSmWindtrap', 'HKWall', 'HKRefinery', 'HKBarracks', 'HKFactory',
    'HKOutpost', 'HKFlameTurret', 'HKGunTurret', 'HKHanger', 'HKHelipad',
    'HKStarport', 'HKPalace',
  ],
  OR: [
    'ORSmWindtrap', 'ORWall', 'ORRefinery', 'ORBarracks', 'ORFactory',
    'OROutpost', 'ORGasTurret', 'ORPopUpTurret', 'ORHanger',
    'ORStarport', 'ORPalace',
  ],
};

export const INFANTRY_ORDER: Record<HousePrefix, string[]> = {
  AT: ['ATScout', 'ATInfantry', 'ATSniper', 'ATMilitia', 'ATKindjal', 'ATEngineer'],
  HK: ['HKScout', 'HKLightInf', 'HKTrooper', 'HKFlamer', 'HKEngineer'],
  OR: ['ORScout', 'ORChemical', 'ORAATrooper', 'ORMortar', 'ORSaboteur', 'OREngineer'],
};

export const VEHICLE_ORDER: Record<HousePrefix, string[]> = {
  AT: ['ATTrike', 'Harvester', 'ATMongoose', 'ATOrni', 'ATADVCarryall'],
  HK: ['HKBuzzsaw', 'Harvester', 'HKAssault', 'HKFlame', 'HKMissile', 'HKDevastator', 'HKGunship'],
  OR: ['ORDustScout', 'Harvester', 'ORLaserTank', 'ORKobra', 'ORDeviator', 'OREITS'],
};
