export interface VeterancyLevel {
  scoreThreshold: number;
  extraDamage: number;
  extraArmour: number;
  extraRange: number;
  health?: number;
  canSelfRepair?: boolean;
  elite?: boolean;
}

export interface UnitDef {
  name: string;
  house: string;
  cost: number;
  buildTime: number;
  health: number;
  speed: number;
  turnRate: number;
  size: number;
  armour: string;
  score: number;
  techLevel: number;
  viewRange: number;
  primaryBuilding: string;
  secondaryBuildings: string[];
  unitGroup: string;
  terrain: string[];
  turretAttach: string;
  explosionType: string;
  debris: string;
  reinforcementValue: number;

  // Flags
  infantry: boolean;
  canFly: boolean;
  crushes: boolean;
  crushable: boolean;
  canBeSuppressed: boolean;
  canBeDeviated: boolean;
  canBeRepaired: boolean;
  starportable: boolean;
  tastyToWorms: boolean;
  wormAttraction: number;
  canMoveAnyDirection: boolean;

  // AI
  aiSpecial: boolean;
  aiThreat: number;

  // Veterancy
  veterancy: VeterancyLevel[];

  // Damage effects
  stormDamage: number;
  hitSlowDownAmount: number;
  hitSlowDownDuration: number;

  // Special
  getUnitWhenBuilt?: string;
  deploysTo?: string;
}

export function createDefaultUnitDef(name: string): UnitDef {
  return {
    name,
    house: '',
    cost: 0,
    buildTime: 0,
    health: 100,
    speed: 1,
    turnRate: 0.1,
    size: 1,
    armour: 'None',
    score: 1,
    techLevel: 0,
    viewRange: 5,
    primaryBuilding: '',
    secondaryBuildings: [],
    unitGroup: '',
    terrain: ['Sand', 'Rock'],
    turretAttach: '',
    explosionType: 'Explosion',
    debris: '',
    reinforcementValue: 1,
    infantry: false,
    canFly: false,
    crushes: false,
    crushable: false,
    canBeSuppressed: false,
    canBeDeviated: true,
    canBeRepaired: true,
    starportable: false,
    tastyToWorms: false,
    wormAttraction: 0,
    canMoveAnyDirection: false,
    aiSpecial: false,
    aiThreat: 0,
    veterancy: [],
    stormDamage: 0,
    hitSlowDownAmount: 0,
    hitSlowDownDuration: 0,
  };
}
