/** Shared display name mapping for unit/building internal names → friendly names */

export const DISPLAY_NAMES: Record<string, string> = {
  // Buildings
  'SmWindtrap': 'Wind Trap',
  'ConYard': 'Con. Yard',
  'RocketTurret': 'Rocket Turret',
  'PillBox': 'Pillbox',
  'GunTurret': 'Gun Turret',
  'FlameTurret': 'Flame Turret',
  'GasTurret': 'Gas Turret',
  'PopUpTurret': 'Pop-Up Turret',
  'RefineryDock': 'Refinery Pad',
  'Helipad': 'Landing Pad',
  'Hanger': 'Hangar',
  // Units
  'LightInfantry': 'Light Infantry',
  'SandBike': 'Sand Bike',
  'SonicTank': 'Sonic Tank',
  'MissileTank': 'Missile Tank',
  'AssaultTank': 'Assault Tank',
  'FlameTank': 'Flame Tank',
  'LaserTank': 'Laser Tank',
  'DustScout': 'Dust Scout',
  'RepairVehicle': 'Repair Vehicle',
  'AirDrone': 'Air Drone',
  'AdvCarryall': 'Adv. Carryall',
  'AATrooper': 'AA Trooper',
  'ChemTrooper': 'Chem Trooper',
  'MortarInf': 'Mortar Infantry',
  'KindjalInf': 'Kindjal Infantry',
  'FlamerInf': 'Flamethrower',
  'InkvineGun': 'Inkvine Catapult',
  'Inkvine': 'Inkvine Catapult',
  'AirDefensePlatform': 'Air Defense Platform',
  'EyeInTheSky': 'Eye In The Sky',
  'FremenWarrior': 'Fremen Warrior',
  'FremenFedaykin': 'Fremen Fedaykin',
  'ImpSardaukar': 'Imperial Sardaukar',
  'ImpSardElite': 'Sardaukar Elite',
  'NIABTank': 'NIAB Tank',
};

const FACTION_PREFIX = /^(AT|HK|OR|GU|IX|FR|IM|TL)/;

/** Get a human-friendly display name for an internal unit/building name */
export function getDisplayName(internalName: string): string {
  const stripped = internalName.replace(FACTION_PREFIX, '');
  return DISPLAY_NAMES[stripped] ?? stripped.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Strip faction prefix from an internal name */
export function stripFactionPrefix(name: string): string {
  return name.replace(FACTION_PREFIX, '');
}

/** Get the faction prefix (AT, HK, OR, etc.) or empty string */
export function getFactionPrefix(name: string): string {
  const match = name.match(FACTION_PREFIX);
  return match?.[1] ?? '';
}

const FACTION_NAMES: Record<string, string> = {
  'AT': 'Atreides',
  'HK': 'Harkonnen',
  'OR': 'Ordos',
  'FR': 'Fremen',
  'IM': 'Sardaukar',
  'IX': 'Ix',
  'TL': 'Tleilaxu',
  'GU': 'Guild',
};

/** Get the full faction name from a prefix */
export function getFactionName(prefix: string): string {
  return FACTION_NAMES[prefix] ?? prefix;
}
