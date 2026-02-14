export interface TurretDef {
  name: string;
  bullet: string;
  reloadCount: number;
  muzzleFlash: string;
  minYRotation: number;
  maxYRotation: number;
  yRotationAngle: number;
  minXRotation: number;
  maxXRotation: number;
  xRotationAngle: number;
  nextJoint: string;
}

export interface BulletDef {
  name: string;
  maxRange: number;
  damage: number;
  speed: number;
  turnRate: number;
  warhead: string;
  explosionType: string;
  debris: string;
  homing: boolean;
  antiAircraft: boolean;
  isLaser: boolean;
  blowUp: boolean;
  blastRadius: number; // 0 = single target, game units where 32 = 1 tile
  reduceDamageWithDistance: boolean; // Linear falloff from center to edge
  damageFriendly: boolean; // Whether AoE damages friendly units
  friendlyDamageAmount: number; // 0-100, percentage of damage applied to friendlies
}

// Warhead damage multipliers per armor type (percentage 0-100)
export interface WarheadDef {
  name: string;
  vs: Record<string, number>;
}

export const ARMOUR_TYPES = [
  'None', 'Earplugs', 'BPV', 'Light', 'Medium', 'Heavy',
  'Concrete', 'Walls', 'Building', 'CY', 'Harvester',
  'Invulnerable', 'Aircraft',
] as const;

export function createDefaultTurretDef(name: string): TurretDef {
  return {
    name,
    bullet: '',
    reloadCount: 30,
    muzzleFlash: '',
    minYRotation: -180,
    maxYRotation: 180,
    yRotationAngle: 4,
    minXRotation: -90,
    maxXRotation: 90,
    xRotationAngle: 4,
    nextJoint: '',
  };
}

export function createDefaultBulletDef(name: string): BulletDef {
  return {
    name,
    maxRange: 5,
    damage: 100,
    speed: 20,
    turnRate: 0,
    warhead: '',
    explosionType: 'ShellHit',
    debris: '',
    homing: false,
    antiAircraft: false,
    isLaser: false,
    blowUp: false,
    blastRadius: 0,
    reduceDamageWithDistance: true,
    damageFriendly: false,
    friendlyDamageAmount: 0,
  };
}

export function createDefaultWarheadDef(name: string): WarheadDef {
  return {
    name,
    vs: Object.fromEntries(ARMOUR_TYPES.map(a => [a, 100])),
  };
}
