/**
 * Campaign data module: territories, adjacency, starting positions,
 * mission catalog, difficulty config, and string loader.
 *
 * All territory IDs are 1-indexed, matching game data and mesh names.
 */

import { simRng } from '../utils/DeterministicRNG';

// ── Types ──────────────────────────────────────────────────────────

export type HousePrefix = 'AT' | 'HK' | 'OR';
export type SubHousePrefix = 'FR' | 'SA' | 'IX' | 'TL' | 'SM' | 'GU' | 'GN';
export type FactionPrefix = HousePrefix | SubHousePrefix;

export interface CampaignTerritory {
  id: number;          // 1-indexed
  nameKey: string;     // String key like "#T5" for lookup
  adjacent: number[];  // Adjacent territory IDs
  isHomeworld: boolean;
  homeworldOf?: HousePrefix; // Which house this is homeworld of
}

export type TerritoryOwner = HousePrefix | 'neutral';

export interface MissionEntry {
  house: HousePrefix;
  phase: number;        // 1, 2, or 3
  type: 'M' | 'D';     // Main or Difficulty variant
  number: number;       // Mission number within phase (maps to territory position)
  subHouse: FactionPrefix; // Sub-house or enemy involved
  filename: string;
}

export interface DifficultyConfig {
  rrDifference: Map<number, number>; // territory diff -> value
  phaseBonus: Map<number, number>;   // phase -> value
  personality: Map<number, number>;  // AI personality -> value
  randomRange: [number, number];     // [min, max]
}

// ── Territory Data ─────────────────────────────────────────────────

/** 33 Arrakis territories + 3 homeworlds = 36 total. */
const TERRITORY_DEFINITIONS: CampaignTerritory[] = [
  // Arrakis territories (1-33)
  { id: 1,  nameKey: '#T1',  adjacent: [2, 3, 34], isHomeworld: false },
  { id: 2,  nameKey: '#T2',  adjacent: [1, 3, 4, 5], isHomeworld: false },
  { id: 3,  nameKey: '#T3',  adjacent: [1, 2, 5, 6], isHomeworld: false },
  { id: 4,  nameKey: '#T4',  adjacent: [2, 5, 7, 8], isHomeworld: false },
  { id: 5,  nameKey: '#T5',  adjacent: [2, 3, 4, 6, 8, 9], isHomeworld: false },
  { id: 6,  nameKey: '#T6',  adjacent: [3, 5, 9, 10, 11], isHomeworld: false },
  { id: 7,  nameKey: '#T7',  adjacent: [4, 8, 12], isHomeworld: false },
  { id: 8,  nameKey: '#T8',  adjacent: [4, 5, 7, 9, 12, 13, 14], isHomeworld: false },
  { id: 9,  nameKey: '#T9',  adjacent: [5, 6, 8, 10, 14, 15, 16], isHomeworld: false },
  { id: 10, nameKey: '#T10', adjacent: [6, 9, 11, 16], isHomeworld: false },
  { id: 11, nameKey: '#T11', adjacent: [6, 10, 16, 17], isHomeworld: false },
  { id: 12, nameKey: '#T12', adjacent: [7, 8, 13, 18], isHomeworld: false },
  { id: 13, nameKey: '#T13', adjacent: [8, 12, 14, 18], isHomeworld: false },
  { id: 14, nameKey: '#T14', adjacent: [8, 9, 13, 15, 18, 19, 20], isHomeworld: false },
  { id: 15, nameKey: '#T15', adjacent: [9, 14, 20, 21, 28, 22, 16], isHomeworld: false },
  { id: 16, nameKey: '#T16', adjacent: [9, 10, 11, 15, 17, 22, 23], isHomeworld: false },
  { id: 17, nameKey: '#T17', adjacent: [11, 16, 23], isHomeworld: false },
  { id: 18, nameKey: '#T18', adjacent: [12, 13, 14, 19, 24], isHomeworld: false },
  { id: 19, nameKey: '#T19', adjacent: [14, 18, 20, 24, 25, 32], isHomeworld: false },
  { id: 20, nameKey: '#T20', adjacent: [14, 15, 19, 21, 25, 26, 27], isHomeworld: false },
  { id: 21, nameKey: '#T21', adjacent: [15, 20, 27, 28], isHomeworld: false },
  { id: 22, nameKey: '#T22', adjacent: [15, 16, 23, 28, 29, 30], isHomeworld: false },
  { id: 23, nameKey: '#T23', adjacent: [16, 17, 22, 30], isHomeworld: false },
  { id: 24, nameKey: '#T24', adjacent: [18, 19, 32, 33], isHomeworld: false },
  { id: 25, nameKey: '#T25', adjacent: [19, 20, 26, 32], isHomeworld: false },
  { id: 26, nameKey: '#T26', adjacent: [20, 25, 27], isHomeworld: false },
  { id: 27, nameKey: '#T27', adjacent: [20, 21, 26, 28], isHomeworld: false },
  { id: 28, nameKey: '#T28', adjacent: [15, 21, 22, 27, 29], isHomeworld: false },
  { id: 29, nameKey: '#T29', adjacent: [22, 28, 30, 31], isHomeworld: false },
  { id: 30, nameKey: '#T30', adjacent: [22, 23, 29, 31], isHomeworld: false },
  { id: 31, nameKey: '#T31', adjacent: [29, 30, 35], isHomeworld: false },
  { id: 32, nameKey: '#T32', adjacent: [19, 24, 25, 33], isHomeworld: false },
  { id: 33, nameKey: '#T33', adjacent: [24, 32, 36], isHomeworld: false },
  // Homeworlds (34-36) — connected to nearest Arrakis territory
  { id: 34, nameKey: '#T34', adjacent: [1],  isHomeworld: true, homeworldOf: 'HK' },  // Giedi Prime
  { id: 35, nameKey: '#T35', adjacent: [31], isHomeworld: true, homeworldOf: 'OR' },  // Draconis IV
  { id: 36, nameKey: '#T36', adjacent: [33], isHomeworld: true, homeworldOf: 'AT' },  // Caladan
];

export function getTerritories(): CampaignTerritory[] {
  return TERRITORY_DEFINITIONS.map(t => ({ ...t, adjacent: [...t.adjacent] }));
}

export function getTerritory(id: number): CampaignTerritory | undefined {
  return TERRITORY_DEFINITIONS.find(t => t.id === id);
}

// ── Starting Positions ─────────────────────────────────────────────

/** Jump points per house (the Arrakis territory near their homeworld). */
export const JUMP_POINTS: Record<HousePrefix, number> = {
  AT: 33,  // ATJumpPoint from Forced Missions.txt (uses 32 0-indexed, =33 1-indexed)
  HK: 1,   // HKJumpPoint = 0 -> territory 1 (1-indexed)
  OR: 31,  // ORJumpPoint = 30 -> territory 31 (1-indexed)
};

/** Homeworld territory ID per house. */
export const HOMEWORLDS: Record<HousePrefix, number> = {
  HK: 34,
  OR: 35,
  AT: 36,
};

/** Starting territories per house (near their jump point/homeworld). */
export const STARTING_TERRITORIES: Record<HousePrefix, number[]> = {
  HK: [1, 2, 3, 4],       // Northern Arrakis
  AT: [33, 32, 24],        // Southern Arrakis
  OR: [31, 30, 29, 23],    // Eastern Arrakis
};

/** Get the two enemy houses for the given player house. */
export function getEnemyHouses(playerHouse: HousePrefix): [HousePrefix, HousePrefix] {
  switch (playerHouse) {
    case 'AT': return ['HK', 'OR'];
    case 'HK': return ['AT', 'OR'];
    case 'OR': return ['AT', 'HK'];
  }
}

/** Build initial territory ownership map. */
export function getInitialOwnership(playerHouse: HousePrefix): Map<number, TerritoryOwner> {
  const [enemy1, enemy2] = getEnemyHouses(playerHouse);
  const ownership = new Map<number, TerritoryOwner>();

  // All territories start neutral
  for (const t of TERRITORY_DEFINITIONS) {
    ownership.set(t.id, 'neutral');
  }

  // Assign starting territories
  for (const id of STARTING_TERRITORIES[playerHouse]) {
    ownership.set(id, playerHouse);
  }
  for (const id of STARTING_TERRITORIES[enemy1]) {
    ownership.set(id, enemy1);
  }
  for (const id of STARTING_TERRITORIES[enemy2]) {
    ownership.set(id, enemy2);
  }

  // Assign homeworlds
  ownership.set(HOMEWORLDS[playerHouse], playerHouse);
  ownership.set(HOMEWORLDS[enemy1], enemy1);
  ownership.set(HOMEWORLDS[enemy2], enemy2);

  return ownership;
}

// ── Fallback Territory Names ───────────────────────────────────────

/** Hardcoded names for territories whose strings are commented out in the game data. */
export const FALLBACK_TERRITORY_NAMES: Record<string, string> = {
  '#T1': 'Harkonnen Stronghold',
  '#T31': 'Ordos Stronghold',
  '#T33': 'Atreides Stronghold',
};

// ── Mission Catalog ────────────────────────────────────────────────

/**
 * Mission filename patterns derived from 230 .tok files.
 * Format: {HOUSE}P{PHASE}{TYPE}{NUMBER}{SUBHOUSE}[Fail|Win].tok
 *
 * D = Difficulty variant (with Fail/Win variants)
 * M = Main mission (unique scripted mission)
 */
const MISSION_FILENAMES: string[] = [
  // Atreides Phase 1
  'ATP1M1FR','ATP1M3SA','ATP1M4FR','ATP1M6FR','ATP1M7FR','ATP1M9GN',
  'ATP1M11OR','ATP1M12GN','ATP1M16AT','ATP1M18SA','ATP1M19GN',
  // Atreides Phase 2
  'ATP2M1FR','ATP2M3SA','ATP2M4IX','ATP2M7FR','ATP2M11SM','ATP2M13IX','ATP2M16TL','ATP2M19IX',
  // Atreides Phase 3
  'ATP3M1FR','ATP3M3FR','ATP3M5TL','ATP3M8TL','ATp3M10FR',
  // Harkonnen Phase 1
  'HKP1M1FR','HKP1M2FR','HKP1M4SA','HKP1M5SA','HKP1M6SA','HKP1M7HK',
  'HKP1M10OR','HKP1M11GN','HKP1M15HK','HKP1M17SA','HKP1M18GN',
  // Harkonnen Phase 2
  'HKP2M9IX','HKP2M12SM','HKP2M14IX','HKP2M16IX','HKP2M17TL','HKP2M20TL','HKP2M21TL',
  // Harkonnen Phase 3
  'HKP3M3TL','HKP3M5HK','HKP3M8SA','HKP3M10FR',
  // Ordos Phase 1
  'ORP1M1FR','ORP1M3SA','ORP1M4HK','ORP1M5FR','ORP1M6SA','ORP1M9GN',
  'ORP1M13OR','ORP1M15SA','ORP1M16GN',
  // Ordos Phase 2
  'ORP2M4OR','ORP2M5SM','ORP2M6TL','ORP2M7IX','ORP2M9TL',
  'ORP2M14IX','ORP2M15IX','ORP2M17IX','ORP2M18TL',
  // Ordos Phase 3
  'ORP3M2TL','ORP3M5FR','ORP3M6SA','ORP3M10TL','ORP3M11FR',
];

/** Parse a mission filename into structured data. */
function parseMissionFilename(filename: string): MissionEntry | null {
  // Regex: {HOUSE}P{PHASE}{TYPE}{NUMBER}{SUBHOUSE}
  const match = filename.match(/^(AT|HK|OR)[Pp](\d+)([MDmd])(\d+)(FR|SA|IX|TL|SM|GU|GN|OR|AT|HK)$/i);
  if (!match) return null;
  return {
    house: match[1].toUpperCase() as HousePrefix,
    phase: parseInt(match[2]),
    type: match[3].toUpperCase() as 'M' | 'D',
    number: parseInt(match[4]),
    subHouse: match[5].toUpperCase() as FactionPrefix,
    filename,
  };
}

let _missionCatalog: MissionEntry[] | null = null;

/** Get parsed mission catalog (cached). */
export function getMissionCatalog(): MissionEntry[] {
  if (_missionCatalog) return _missionCatalog;
  _missionCatalog = [];
  for (const name of MISSION_FILENAMES) {
    const entry = parseMissionFilename(name);
    if (entry) _missionCatalog.push(entry);
  }
  return _missionCatalog;
}

/** Get missions for a specific house and phase. */
export function getMissionsForPhase(house: HousePrefix, phase: number): MissionEntry[] {
  return getMissionCatalog().filter(m => m.house === house && m.phase === phase);
}

/** Get sub-houses that appear in missions for a house/phase. */
export function getSubHousesForPhase(house: HousePrefix, phase: number): FactionPrefix[] {
  const missions = getMissionsForPhase(house, phase);
  const subs = new Set<FactionPrefix>();
  for (const m of missions) {
    // Only include alliable sub-houses, not main houses, guild navigators, or smugglers
    if (m.subHouse !== 'AT' && m.subHouse !== 'HK' && m.subHouse !== 'OR' && m.subHouse !== 'GN' && m.subHouse !== 'SM') {
      subs.add(m.subHouse);
    }
  }
  return [...subs];
}

/** Get missions involving a specific sub-house. */
export function getMissionsForSubHouse(house: HousePrefix, phase: number, subHouse: FactionPrefix): MissionEntry[] {
  return getMissionsForPhase(house, phase).filter(m => m.subHouse === subHouse);
}

// ── Difficulty Config ──────────────────────────────────────────────

const DIFFICULTY_CONFIG: DifficultyConfig = {
  rrDifference: new Map([
    [-6, -25], [-5, -10], [-4, 10], [-3, 20], [-2, 30], [-1, 40],
    [0, 45], [1, 60], [2, 75], [3, 90], [4, 100], [5, 110],
    [6, 120], [7, 125], [8, 130], [9, 135], [10, 140],
  ]),
  phaseBonus: new Map([
    [0, 5], [1, 2], [2, -2], [3, -5],
  ]),
  personality: new Map([
    [0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
  ]),
  randomRange: [-10, 10],
};

export function getDifficultyConfig(): DifficultyConfig {
  return DIFFICULTY_CONFIG;
}

/**
 * Calculate mission difficulty value.
 * Formula: RRDifference[territoryDiff] + Phase[phase] + random(-10, 10)
 */
export function calculateDifficulty(territoryDiff: number, phase: number): number {
  const rr = DIFFICULTY_CONFIG.rrDifference.get(
    Math.max(-6, Math.min(10, territoryDiff))
  ) ?? 45;
  const phaseBonus = DIFFICULTY_CONFIG.phaseBonus.get(
    Math.min(3, phase)
  ) ?? 0;
  const [rMin, rMax] = DIFFICULTY_CONFIG.randomRange;
  const rand = Math.floor(simRng.random() * (rMax - rMin + 1)) + rMin;
  return rr + phaseBonus + rand;
}

// ── Forced Missions ────────────────────────────────────────────────

export interface ForcedMission {
  territory: number;
  playerHouse: HousePrefix;
  missionName: string;
}

/** Jump point rebellion missions — forced when capturing a jump point. */
export const FORCED_ATTACK_MISSIONS: ForcedMission[] = [
  { territory: 33, playerHouse: 'OR', missionName: 'ATJump_reb2' },
  { territory: 33, playerHouse: 'HK', missionName: 'ATJump_reb' },
  { territory: 1,  playerHouse: 'AT', missionName: 'HKJump_reb2' },
  { territory: 1,  playerHouse: 'OR', missionName: 'HKJump_reb' },
  { territory: 31, playerHouse: 'AT', missionName: 'ORJump_reb' },
  { territory: 31, playerHouse: 'HK', missionName: 'ORJump2_reb' },
];

/** Get forced mission for a territory/house combination, if any. */
export function getForcedMission(territory: number, playerHouse: HousePrefix): ForcedMission | undefined {
  return FORCED_ATTACK_MISSIONS.find(
    fm => fm.territory === territory && fm.playerHouse === playerHouse
  );
}

// ── Special Mission Names ──────────────────────────────────────────

export const SPECIAL_MISSIONS: Record<string, Record<HousePrefix, string>> = {
  heighliner: {
    AT: 'Atreides Heighliner Mission',
    HK: 'HHK Heighliner Mission',
    OR: 'Ordos Heighliner Mission',
  },
  homeDefense: {
    AT: 'DAT Save The Duke',
    HK: 'HHK Civil War Defence Mission', // HK gets civil war instead
    OR: 'Ordos Homeworld Defense',
  },
  homeAttack: {
    AT: 'T36 Atreides Homeworld Assault',
    HK: 'Harkonnen homeworld assault_AT', // variant per enemy
    OR: 'Ordos homeworld assault',
  },
  civilWar: {
    AT: '', // only HK has civil war
    HK: 'HHK Civil War Attack Mission',
    OR: '',
  },
  final: {
    AT: 'ATENDMission',
    HK: 'HKENDMission',
    OR: 'ORENDMission',
  },
};

/** Second score badge (default enemy shown in initial phases). */
export const SECOND_SCORE_BADGE: Record<HousePrefix, HousePrefix> = {
  AT: 'OR',
  HK: 'AT',
  OR: 'HK',
};

// ── String Loading ─────────────────────────────────────────────────

let _campaignStrings: Record<string, string> | null = null;

/** Load campaign strings from JSON. Cached after first load. */
export async function loadCampaignStrings(): Promise<Record<string, string>> {
  if (_campaignStrings) return _campaignStrings;
  const resp = await fetch('/assets/data/campaign-strings.json');
  _campaignStrings = await resp.json();
  return _campaignStrings!;
}

/** Get a campaign string by key, with case-insensitive fallback. */
export function getCampaignString(key: string): string | undefined {
  if (!_campaignStrings) return undefined;
  // Direct match
  if (_campaignStrings[key] !== undefined) return _campaignStrings[key];
  // Case-insensitive search
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(_campaignStrings)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Get territory name by ID, using strings data with fallbacks. */
export function getTerritoryName(id: number): string {
  const key = `#T${id}`;
  const name = getCampaignString(key);
  if (name) return name;
  if (FALLBACK_TERRITORY_NAMES[key]) return FALLBACK_TERRITORY_NAMES[key];
  return `Territory ${id}`;
}
