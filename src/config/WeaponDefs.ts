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
  turretDisableIfUnitDeployed: boolean; // Turret only fires when unit is undeployed
  turretDisableIfUnitUndeployed: boolean; // Turret only fires when unit is deployed
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
  continuous: boolean; // Fires every tick while in range (flame/sonic weapons)
  minRange: number; // Minimum firing distance (game units, like maxRange)
  trajectory: boolean; // Arcing trajectory (mortar-style)
  homingDelay: number; // Ticks before homing kicks in
  antiGround: boolean; // Can target ground units
  lingerDuration: number; // Ticks of lingering damage after impact
  lingerDamage: number; // Damage per linger tick
  infantryDeathType: string; // Death animation for infantry: 'Shot', 'BlowUp', 'Burnt', 'Gassed', or '' (default/none)
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
    turretDisableIfUnitDeployed: false,
    turretDisableIfUnitUndeployed: false,
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
    continuous: false,
    minRange: 0,
    trajectory: false,
    homingDelay: 0,
    antiGround: true,
    lingerDuration: 0,
    lingerDamage: 0,
    infantryDeathType: '',
  };
}

export function createDefaultWarheadDef(name: string): WarheadDef {
  return {
    name,
    vs: Object.fromEntries(ARMOUR_TYPES.map(a => [a, 100])),
  };
}

// --- Impact Type Classification ---

/** Categories of weapon impact effects, mapped from warhead/bullet data */
export const enum ImpactType {
  Bullet = 0,     // Small yellow spark, brief flash, tiny dust puff
  Explosive = 1,  // Orange fireball with expanding smoke ring, debris
  Missile = 2,    // Medium explosion with lingering smoke trail at impact
  Sonic = 3,      // Blue/purple ripple wave expanding outward (Atreides sonic tank)
  Laser = 4,      // Red/green flash with brief beam glow at impact
  Gas = 5,        // Green cloud that lingers 1-2 seconds (Tleilaxu)
  Electric = 6,   // Blue-white sparks arcing outward (Ix/Ordos weapons)
  Flame = 7,      // Persistent ground fire effect for 1-2 seconds
}

/**
 * Classify a bullet definition into an ImpactType for visual effects.
 * Uses warhead name, bullet properties (isLaser, continuous, homing, etc.)
 * and bullet name to determine the correct visual category.
 */
export function classifyImpactType(bullet: BulletDef): ImpactType {
  const name = bullet.name.toLowerCase();
  const warhead = bullet.warhead.toLowerCase();

  // Laser weapons: IsLaser flag or Laser warhead
  if (bullet.isLaser || warhead === 'laser_w' || warhead === 'popup_w') {
    return ImpactType.Laser;
  }

  // Sonic weapons: Sound warhead (Atreides sonic tank/infantry)
  if (warhead === 'sound_w' || name.includes('sound')) {
    return ImpactType.Sonic;
  }

  // Electric/beam weapons: ORLightning/ATHawk explosion types, Beam warhead, Beserk
  if (warhead === 'beam_w' || warhead === 'strike_w'
    || name.includes('beserk') || name.includes('hawk')
    || bullet.explosionType.toLowerCase().includes('lightning')
    || bullet.explosionType.toLowerCase().includes('hawk')) {
    return ImpactType.Electric;
  }

  // Gas/chemical weapons: Gas warhead, Poison warhead, or lingering damage
  if (warhead === 'gas_w' || warhead === 'poison_w'
    || name.includes('gas') || name.includes('poison') || name.includes('contaminator')
    || (bullet.lingerDuration > 0 && bullet.lingerDamage > 0)) {
    return ImpactType.Gas;
  }

  // Flame weapons: Flame warhead + continuous or flame in name
  if (warhead === 'flame_w' && (bullet.continuous || name.includes('flame'))) {
    return ImpactType.Flame;
  }

  // Missile/rocket weapons: homing projectiles or rocket/missile in name
  if (bullet.homing || name.includes('rocket') || name.includes('missile')
    || name.includes('heat') || warhead.includes('heatair')
    || warhead.includes('heatinf') || warhead === 'devrocket_w') {
    return ImpactType.Missile;
  }

  // Explosive weapons: blast radius > 0, howitzer, mortar, trajectory weapons, barrel bombs
  if (bullet.blastRadius > 0 || bullet.trajectory
    || warhead === 'howitzer_w' || warhead === 'barrelbomb_w'
    || warhead === 'death_w' || warhead === 'detonate_w'
    || name.includes('mortar') || name.includes('howitzer') || name.includes('bomb')
    || name.includes('inkvine') || name.includes('plasma')) {
    return ImpactType.Explosive;
  }

  // Default: bullet/kinetic (pistols, machine guns, cannons, stabs, snipers)
  return ImpactType.Bullet;
}
