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
  primaryBuildingAlts: string[];
  secondaryBuildings: string[];
  unitGroup: string;
  terrain: string[];
  turretAttach: string;
  explosionType: string;
  debris: string;
  reinforcementValue: number;

  // Flags
  engineer: boolean;
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

  // Abilities
  stealth: boolean;
  stealthDelay: number; // ticks idle before becoming stealthed (0 = use default 75)
  stealthDelayAfterFiring: number; // ticks after firing before re-stealthing (0 = use default 125)
  selfDestruct: boolean;
  deviator: boolean;
  apc: boolean;
  passengerCapacity: number;
  ornithopter: boolean; // needs rearming at landing pad
  saboteur: boolean; // auto-suicide on building contact
  infiltrator: boolean; // reveals stealthed enemies + suicide-attacks buildings
  leech: boolean; // parasitizes enemy vehicles, drains into new Leeches
  cantBeLeeched: boolean; // immune to Leech
  projector: boolean; // creates holographic copies of units
  niabTank: boolean; // can teleport
  teleportSleepTime: number; // ticks before teleported unit can act
  kobra: boolean; // deploys to extend range
  repair: boolean; // repair vehicle - heals nearby friendly vehicles
  dustScout: boolean; // can burrow underground on sand terrain
  wormRider: boolean; // can mount sandworms (Fremen)

  // AI
  aiSpecial: boolean;
  aiThreat: number;

  // Veterancy
  veterancy: VeterancyLevel[];

  // Shields (Ordos)
  shieldHealth: number;
  canSelfRepair: boolean; // unit-level self-repair (always active, no veterancy needed)
  canSelfRepairShield: boolean; // shield regeneration

  // Damage effects
  stormDamage: number;
  hitSlowDownAmount: number;
  hitSlowDownDuration: number;

  // Terrain bonuses
  getsHeightAdvantage: boolean; // Gets range/damage bonuses on elevated terrain

  // Audio
  soundFile: number; // SoundID for voice lines (-1 = none)

  // Superweapon flags
  deathHand: boolean; // DeathHand missile unit
  hawkWeapon: boolean; // Hawk airstrike unit
  beamWeapon: boolean; // Chaos Lightning beam unit
  resource: string; // Resource field (bullet/FX name for superweapons)

  // Loss condition exclusions
  excludeFromSkirmishLose: boolean;
  excludeFromCampaignLose: boolean;

  // Statistics
  countsForStats: boolean;

  // Production
  upgradedPrimaryRequired: boolean; // Requires primary building to be upgraded

  // Harvesting
  spiceCapacity: number; // Maximum cash value of spice carried (default 700)
  unloadRate: number; // Spice units transferred per tick at refinery (from rules.txt, default 2)

  // Crate drops
  crateGift: boolean; // When destroyed, drops a crate containing a random gift

  // Sand sinking (visual effect)
  sinkAmount: number; // How far the unit sinks into sand (game units)
  sinkSpeed: number; // How fast the unit sinks (game units per tick)

  // Movement dynamics
  acceleration: number; // Speed units gained per tick (0 = instant)

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
    primaryBuildingAlts: [],
    secondaryBuildings: [],
    unitGroup: '',
    terrain: ['Sand', 'Rock'],
    turretAttach: '',
    explosionType: 'Explosion',
    debris: '',
    reinforcementValue: 1,
    engineer: false,
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
    stealth: false,
    stealthDelay: 0,
    stealthDelayAfterFiring: 0,
    selfDestruct: false,
    deviator: false,
    apc: false,
    passengerCapacity: 0,
    ornithopter: false,
    saboteur: false,
    infiltrator: false,
    leech: false,
    cantBeLeeched: false,
    projector: false,
    niabTank: false,
    teleportSleepTime: 93,
    kobra: false,
    repair: false,
    dustScout: false,
    wormRider: false,
    aiSpecial: false,
    aiThreat: 0,
    veterancy: [],
    soundFile: -1,
    deathHand: false,
    hawkWeapon: false,
    beamWeapon: false,
    resource: '',
    shieldHealth: 0,
    canSelfRepair: false,
    canSelfRepairShield: false,
    stormDamage: 0,
    hitSlowDownAmount: 0,
    hitSlowDownDuration: 0,
    getsHeightAdvantage: true, // Default: most units get height advantage
    excludeFromSkirmishLose: false,
    excludeFromCampaignLose: false,
    countsForStats: true,
    upgradedPrimaryRequired: false,
    spiceCapacity: 700,
    unloadRate: 2, // rules.txt default: UnloadRate = 2
    crateGift: false,
    sinkAmount: 0,
    sinkSpeed: 0,
    acceleration: 0, // 0 = derive from unit characteristics at parse time
  };
}
