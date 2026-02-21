export interface BuildingDef {
  name: string;
  house: string;
  group: string;
  cost: number;
  buildTime: number;
  health: number;
  armour: string;
  score: number;
  techLevel: number;
  viewRange: number;
  powerUsed: number;
  powerGenerated: number;
  primaryBuilding: string;
  primaryBuildingAlts: string[]; // OR alternatives (e.g. walls require ANY faction's ConYard)
  secondaryBuildings: string[];
  terrain: string[];
  turretAttach: string;
  explosionType: string;
  stormDamage: number;

  // Footprint
  occupy: string[][];
  deployTiles: { x: number; y: number; angle: number }[];

  // Flags
  wall: boolean; // Single-tile wall segment (drag-to-build, auto-connect)
  refinery: boolean;
  canBeEngineered: boolean;
  disableWithLowPower: boolean;
  upgradable: boolean;
  upgradeCost: number;
  upgradeTechLevel: number;

  // Production
  upgradedPrimaryRequired: boolean; // Requires primary building to be upgraded

  // Special
  getUnitWhenBuilt: string;
  numInfantryWhenGone: number;
  roofHeight: number;
  unstealthRange: number;

  // Radar
  outpost: boolean; // Enables minimap/radar when owned
  hideOnRadar: boolean; // Don't show this building on minimap (decorations)

  // Loss condition exclusions
  excludeFromSkirmishLose: boolean;
  excludeFromCampaignLose: boolean;

  // Statistics
  countsForStats: boolean;

  // AI
  aiResource: boolean;
  aiDefence: boolean;
  aiCritical: boolean;
}

export function createDefaultBuildingDef(name: string): BuildingDef {
  return {
    name,
    house: '',
    group: '',
    cost: 0,
    buildTime: 0,
    health: 1000,
    armour: 'Building',
    score: 1,
    techLevel: 0,
    viewRange: 5,
    powerUsed: 0,
    powerGenerated: 0,
    primaryBuilding: '',
    primaryBuildingAlts: [],
    secondaryBuildings: [],
    terrain: ['Rock'],
    turretAttach: '',
    explosionType: 'BigExplosion',
    stormDamage: 0,
    occupy: [],
    deployTiles: [],
    wall: false,
    refinery: false,
    canBeEngineered: true,
    disableWithLowPower: false,
    upgradable: false,
    upgradeCost: 0,
    upgradeTechLevel: 0,
    upgradedPrimaryRequired: false,
    getUnitWhenBuilt: '',
    numInfantryWhenGone: 0,
    roofHeight: 80,
    unstealthRange: 0,
    outpost: false,
    hideOnRadar: false,
    excludeFromSkirmishLose: false,
    excludeFromCampaignLose: false,
    countsForStats: true,
    aiResource: false,
    aiDefence: false,
    aiCritical: false,
  };
}
