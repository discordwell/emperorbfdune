import { type UnitDef, createDefaultUnitDef } from './UnitDefs';
import { type BuildingDef, createDefaultBuildingDef } from './BuildingDefs';
import {
  type TurretDef, type BulletDef, type WarheadDef,
  createDefaultTurretDef, createDefaultBulletDef, createDefaultWarheadDef,
} from './WeaponDefs';

export interface CrateDef {
  name: string;
  size: number;
  health: number;
  terrain: string[];
  lifespan: number;
  crateGiftObject: string; // Unit type name spawned when crate is collected (or 'CASH2000' etc.)
}

export interface GameRules {
  general: Record<string, string>;
  spiceMound: Record<string, string>;
  houseTypes: string[];
  terrainTypes: string[];
  armourTypes: string[];
  units: Map<string, UnitDef>;
  buildings: Map<string, BuildingDef>;
  turrets: Map<string, TurretDef>;
  bullets: Map<string, BulletDef>;
  warheads: Map<string, WarheadDef>;
  crates: Map<string, CrateDef>;
}

type Section = { name: string; entries: [string, string][] };

function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const rawLine of text.split('\n')) {
    // Strip comments
    const commentIdx = rawLine.indexOf('//');
    const line = (commentIdx >= 0 ? rawLine.substring(0, commentIdx) : rawLine).trim();
    if (!line) continue;

    // Section header
    if (line.startsWith('[') && line.includes(']')) {
      const name = line.substring(1, line.indexOf(']'));
      current = { name, entries: [] };
      sections.push(current);
      continue;
    }

    // Key=value
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0 && current) {
      const key = line.substring(0, eqIdx).trim();
      const value = line.substring(eqIdx + 1).trim();
      current.entries.push([key, value]);
    } else if (current && line.length > 0) {
      // Bare value (list entry like in [HouseTypes])
      current.entries.push(['', line]);
    }
  }

  return sections;
}

function parseBool(v: string): boolean {
  return v.toLowerCase() === 'true' || v === '1';
}

function parseNum(v: string, fallback = 0): number {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

function parseList(v: string): string[] {
  return v.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function getEntries(section: Section): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of section.entries) {
    if (k) map.set(k, v);
  }
  return map;
}

function getListValues(section: Section): string[] {
  return section.entries.filter(([k]) => !k).map(([, v]) => v);
}

export function parseRules(text: string): GameRules {
  const sections = parseSections(text);
  // Merge sections with same name (rules.txt uses repeated [UnitTypes] etc.)
  const sectionMap = new Map<string, Section>();
  for (const s of sections) {
    const existing = sectionMap.get(s.name);
    if (existing) {
      existing.entries.push(...s.entries);
    } else {
      sectionMap.set(s.name, { name: s.name, entries: [...s.entries] });
    }
  }

  // General
  const generalSection = sectionMap.get('General');
  const general: Record<string, string> = {};
  if (generalSection) {
    for (const [k, v] of generalSection.entries) {
      if (k) general[k] = v;
    }
  }

  // SpiceMound section
  const spiceMoundSection = sectionMap.get('SpiceMound');
  const spiceMound: Record<string, string> = {};
  if (spiceMoundSection) {
    for (const [k, v] of spiceMoundSection.entries) {
      if (k) spiceMound[k] = v;
    }
  }

  // Declaration sections
  const houseTypes = getListValues(sectionMap.get('HouseTypes') ?? { name: '', entries: [] });
  const terrainTypes = getListValues(sectionMap.get('TerrainTypes') ?? { name: '', entries: [] });
  const armourTypes = getListValues(sectionMap.get('ArmourTypes') ?? { name: '', entries: [] });

  // Get type name lists
  const unitTypeNames = getListValues(sectionMap.get('UnitTypes') ?? { name: '', entries: [] });
  const buildingTypeNames = getListValues(sectionMap.get('BuildingTypes') ?? { name: '', entries: [] });
  const turretTypeNames = getListValues(sectionMap.get('TurretTypes') ?? { name: '', entries: [] });
  const bulletTypeNames = getListValues(sectionMap.get('BulletTypes') ?? { name: '', entries: [] });
  const warheadTypeNames = getListValues(sectionMap.get('WarheadTypes') ?? { name: '', entries: [] });

  // Global stealth timing defaults from [General] section
  const globalStealthDelay = parseNum(general['StealthDelay'] ?? '0');
  const globalStealthDelayAfterFiring = parseNum(general['StealthDelayAfterFiring'] ?? '0');

  // Parse units
  const units = new Map<string, UnitDef>();
  for (const name of unitTypeNames) {
    const section = sectionMap.get(name);
    if (!section) continue;
    const def = parseUnitDef(name, section);
    // Auto-detect deviator by name
    if (name.toLowerCase().includes('deviator')) def.deviator = true;
    // Apply global stealth delays as fallback for stealth-capable units
    if (def.stealth) {
      if (def.stealthDelay === 0) def.stealthDelay = globalStealthDelay;
      if (def.stealthDelayAfterFiring === 0) def.stealthDelayAfterFiring = globalStealthDelayAfterFiring;
    }
    units.set(name, def);
  }

  // Parse buildings
  const buildings = new Map<string, BuildingDef>();
  for (const name of buildingTypeNames) {
    const section = sectionMap.get(name);
    if (!section) continue;
    buildings.set(name, parseBuildingDef(name, section));
  }

  // Fix typos in rules.txt: normalize secondary/primary building references to match canonical names
  // e.g. "ATSMWindtrap" → "ATSmWindtrap" (original rules.txt has inconsistent casing)
  const buildingNameSet = new Set(buildings.keys());
  const lowerToCanonical = new Map<string, string>();
  for (const n of buildingNameSet) lowerToCanonical.set(n.toLowerCase(), n);
  const fixRef = (ref: string) => lowerToCanonical.get(ref.toLowerCase()) ?? ref;
  for (const def of buildings.values()) {
    if (def.primaryBuilding) def.primaryBuilding = fixRef(def.primaryBuilding);
    def.primaryBuildingAlts = def.primaryBuildingAlts.map(fixRef);
    def.secondaryBuildings = def.secondaryBuildings.map(fixRef);
  }
  for (const def of units.values()) {
    if (def.primaryBuilding) def.primaryBuilding = fixRef(def.primaryBuilding);
    def.primaryBuildingAlts = def.primaryBuildingAlts.map(fixRef);
    def.secondaryBuildings = def.secondaryBuildings.map(fixRef);
  }

  // Parse turrets
  const turrets = new Map<string, TurretDef>();
  for (const name of turretTypeNames) {
    const section = sectionMap.get(name);
    if (!section) continue;
    turrets.set(name, parseTurretDef(name, section));
  }

  // Parse bullets
  const bullets = new Map<string, BulletDef>();
  for (const name of bulletTypeNames) {
    const section = sectionMap.get(name);
    if (!section) continue;
    bullets.set(name, parseBulletDef(name, section));
  }

  // Parse warheads
  const warheads = new Map<string, WarheadDef>();
  for (const name of warheadTypeNames) {
    const section = sectionMap.get(name);
    if (!section) continue;
    warheads.set(name, parseWarheadDef(name, section));
  }

  // Parse crates
  const crateTypeNames = getListValues(sectionMap.get('CrateTypes') ?? { name: '', entries: [] });
  const crates = new Map<string, CrateDef>();
  for (const name of crateTypeNames) {
    const section = sectionMap.get(name);
    if (!section) continue;
    crates.set(name, parseCrateDef(name, section));
  }

  return { general, spiceMound, houseTypes, terrainTypes, armourTypes, units, buildings, turrets, bullets, warheads, crates };
}

function parseUnitDef(name: string, section: Section): UnitDef {
  const def = createDefaultUnitDef(name);
  const entries = section.entries;

  // Track veterancy building
  let currentVet: { scoreThreshold: number; extraDamage: number; extraArmour: number; extraRange: number; health?: number; canSelfRepair?: boolean; elite?: boolean } | null = null;

  for (const [key, value] of entries) {
    switch (key) {
      case 'House': def.house = value; break;
      case 'Cost': def.cost = parseNum(value); break;
      case 'BuildTime': def.buildTime = parseNum(value); break;
      case 'Health':
        if (currentVet) {
          currentVet.health = parseNum(value);
        } else {
          def.health = parseNum(value);
        }
        break;
      case 'Speed': def.speed = parseNum(value); break;
      case 'TurnRate': def.turnRate = parseNum(value); break;
      case 'Size': def.size = parseNum(value); break;
      case 'Armour': def.armour = value.split(',')[0].trim(); break;
      case 'Score': def.score = parseNum(value); break;
      case 'TechLevel': def.techLevel = parseNum(value); break;
      case 'ViewRange': def.viewRange = parseNum(value.split(',')[0]); break;
      case 'PrimaryBuilding': {
        const parts = value.split(',').map(s => s.trim()).filter(Boolean);
        def.primaryBuilding = parts[0] ?? '';
        def.primaryBuildingAlts = parts.slice(1);
        break;
      }
      case 'SecondaryBuilding': def.secondaryBuildings = parseList(value); break;
      case 'UnitGroup': def.unitGroup = value; break;
      case 'Terrain': def.terrain = parseList(value); break;
      case 'TurretAttach': def.turretAttach = value; break;
      case 'ExplosionType': def.explosionType = value; break;
      case 'Debris': def.debris = value; break;
      case 'ReinforcementValue': def.reinforcementValue = parseNum(value); break;
      case 'Infantry': def.infantry = parseBool(value); break;
      case 'Engineer': def.engineer = parseBool(value); break;
      case 'CanFly': def.canFly = parseBool(value); break;
      case 'Crushes': def.crushes = parseBool(value); break;
      case 'Crushable': def.crushable = parseBool(value); break;
      case 'CanBeSuppressed': def.canBeSuppressed = parseBool(value); break;
      case 'CanBeDeviated': def.canBeDeviated = parseBool(value); break;
      case 'CanBeRepaired': def.canBeRepaired = parseBool(value); break;
      case 'Starportable': def.starportable = parseBool(value); break;
      case 'TastyToWorms': def.tastyToWorms = parseBool(value); break;
      case 'WormAttraction': def.wormAttraction = parseNum(value); break;
      case 'CanMoveAnyDirection': def.canMoveAnyDirection = parseBool(value); break;
      case 'StealthedWhenStill': def.stealth = parseBool(value); break;
      case 'Stealthed': def.stealth = parseBool(value); break;
      case 'StealthDelay': def.stealthDelay = parseNum(value); break;
      case 'StealthDelayAfterFiring': def.stealthDelayAfterFiring = parseNum(value); break;
      case 'Devastator': def.selfDestruct = parseBool(value); break;
      case 'APC': if (parseBool(value)) { def.apc = true; def.passengerCapacity = 5; } break;
      case 'Ornithoptor': def.ornithopter = parseBool(value); break;
      case 'Saboteur': def.saboteur = parseBool(value); break;
      case 'Infiltrator': def.infiltrator = parseBool(value); break;
      case 'Leech': def.leech = parseBool(value); break;
      case 'CantBeLeeched': def.cantBeLeeched = parseBool(value); break;
      case 'Projector': def.projector = parseBool(value); break;
      case 'NiabTank': def.niabTank = parseBool(value); break;
      case 'TeleportSleepTime': def.teleportSleepTime = parseNum(value); break;
      case 'Kobra': def.kobra = parseBool(value); break;
      case 'Repair': def.repair = parseBool(value); break;
      case 'DustScout': def.dustScout = parseBool(value); break;
      case 'DeathHand': def.deathHand = parseBool(value); break;
      case 'HawkWeapon': def.hawkWeapon = parseBool(value); break;
      case 'BeamWeapon': def.beamWeapon = parseBool(value); break;
      case 'Resource':
        def.resource = value;
        if (value === 'WormRider') def.wormRider = true;
        break;
      case 'AiSpecial': def.aiSpecial = parseBool(value); break;
      case 'AIThreat': def.aiThreat = parseNum(value); break;
      case 'SpiceCapacity': def.spiceCapacity = parseNum(value); break;
      case 'UnloadRate': def.unloadRate = parseNum(value); break;
      case 'StormDamage': def.stormDamage = parseNum(value); break;
      case 'ShieldHealth': def.shieldHealth = parseNum(value); break;
      case 'CanSelfRepairShield': def.canSelfRepairShield = parseBool(value); break;
      case 'HitSlowDownAmount': def.hitSlowDownAmount = parseNum(value); break;
      case 'HitSlowDownDuration': def.hitSlowDownDuration = parseNum(value); break;
      case 'GetsHeightAdvantage': def.getsHeightAdvantage = parseBool(value); break;
      case 'UpgradedPrimaryRequired': def.upgradedPrimaryRequired = parseBool(value); break;
      case 'ExcludeFromSkirmishLose': def.excludeFromSkirmishLose = parseBool(value); break;
      case 'ExcludeFromCampaignLose': def.excludeFromCampaignLose = parseBool(value); break;
      case 'CountsForStats': def.countsForStats = parseBool(value); break;
      case 'SoundFile': def.soundFile = parseNum(value, -1); break;
      case 'SoundID': def.soundFile = parseNum(value, -1); break;
      case 'CrateGift': def.crateGift = parseBool(value); break;
      case 'SinkAmount': def.sinkAmount = parseNum(value); break;
      case 'SinkSpeed': def.sinkSpeed = parseNum(value); break;
      case 'GetUnitWhenBuilt': def.getUnitWhenBuilt = value; break;
      case 'Acceleration': def.acceleration = parseNum(value); break;
      case 'DeploysTo': def.deploysTo = value; break;
      case 'VeterancyLevel':
        if (currentVet) def.veterancy.push(currentVet);
        currentVet = { scoreThreshold: parseNum(value), extraDamage: 0, extraArmour: 0, extraRange: 0 };
        break;
      case 'ExtraDamage':
        if (currentVet) currentVet.extraDamage = parseNum(value);
        break;
      case 'ExtraArmour':
        if (currentVet) currentVet.extraArmour = parseNum(value);
        break;
      case 'ExtraRange':
        if (currentVet) currentVet.extraRange = parseNum(value);
        break;
      case 'CanSelfRepair':
        if (currentVet) currentVet.canSelfRepair = parseBool(value);
        else def.canSelfRepair = parseBool(value);
        break;
      case 'Elite':
        if (currentVet) currentVet.elite = parseBool(value);
        break;
    }
  }

  if (currentVet) def.veterancy.push(currentVet);

  // Derive acceleration if not explicitly set in rules.txt.
  // The original game has no Acceleration field; we infer from unit characteristics.
  // Values are in speed-units per tick. Higher = snappier response.
  if (def.acceleration === 0 && def.speed > 0) {
    if (def.canFly) {
      // Aircraft: very fast acceleration (they're already airborne)
      def.acceleration = def.speed * 0.25;
    } else if (def.infantry) {
      // Infantry: medium acceleration — they start moving fairly quickly
      def.acceleration = def.speed * 0.15;
    } else if (def.size >= 3) {
      // Heavy vehicles (size 3+): harvesters, devastators, siege tanks — lumber to start
      def.acceleration = def.speed * 0.06;
    } else if (def.size >= 2) {
      // Medium vehicles (size 2): most tanks and APCs
      def.acceleration = def.speed * 0.10;
    } else {
      // Light vehicles (size 1): trikes, quads — zip away quickly
      def.acceleration = def.speed * 0.18;
    }
  }

  return def;
}

function parseBuildingDef(name: string, section: Section): BuildingDef {
  const def = createDefaultBuildingDef(name);

  for (const [key, value] of section.entries) {
    switch (key) {
      case 'House': def.house = value; break;
      case 'Group': def.group = value; break;
      case 'Cost': def.cost = parseNum(value); break;
      case 'BuildTime': def.buildTime = parseNum(value); break;
      case 'Health': def.health = parseNum(value); break;
      case 'Armour': def.armour = value.split(',')[0].trim(); break;
      case 'Score': def.score = parseNum(value); break;
      case 'TechLevel': def.techLevel = parseNum(value); break;
      case 'ViewRange': def.viewRange = parseNum(value); break;
      case 'PowerUsed': def.powerUsed = parseNum(value); break;
      case 'PowerGenerated': def.powerGenerated = parseNum(value); break;
      case 'PrimaryBuilding': {
        const parts = value.split(',').map(s => s.trim()).filter(Boolean);
        def.primaryBuilding = parts[0] ?? '';
        def.primaryBuildingAlts = parts.slice(1);
        break;
      }
      case 'SecondaryBuilding': def.secondaryBuildings = parseList(value); break;
      case 'Terrain': def.terrain = parseList(value); break;
      case 'TurretAttach': def.turretAttach = value; break;
      case 'ExplosionType': def.explosionType = value; break;
      case 'StormDamage': def.stormDamage = parseNum(value); break;
      case 'Occupy': def.occupy.push(value.split('')); break;
      case 'DeployTile': {
        // Format can be "x,y" or "x,y x2,y2" or "x,y, x2,y2" (multiple tiles per line)
        const tileTokens = value.split(/\s+/).filter(s => s.length > 0);
        for (const token of tileTokens) {
          // Remove trailing commas from tokens like "3,7,"
          const clean = token.replace(/,$/, '');
          const parts = clean.split(',');
          if (parts.length >= 2) {
            def.deployTiles.push({ x: parseNum(parts[0]), y: parseNum(parts[1]), angle: 0 });
          }
        }
        break;
      }
      case 'DeployAngle': {
        const last = def.deployTiles[def.deployTiles.length - 1];
        if (last) last.angle = parseNum(value);
        break;
      }
      case 'Wall': def.wall = parseBool(value); break;
      case 'Refinery': def.refinery = parseBool(value); break;
      case 'Dockable': def.dockable = parseBool(value); break;
      case 'CanBeEngineered': def.canBeEngineered = parseBool(value); break;
      case 'DisableWithLowPower': def.disableWithLowPower = parseBool(value); break;
      case 'GetUnitWhenBuilt': def.getUnitWhenBuilt = value; break;
      case 'NumInfantryWhenGone': def.numInfantryWhenGone = parseNum(value); break;
      case 'RoofHeight': def.roofHeight = parseNum(value); break;
      case 'UnstealthRange': def.unstealthRange = parseNum(value); break;
      case 'AiResource': def.aiResource = parseBool(value); break;
      case 'AiDefence': def.aiDefence = parseBool(value); break;
      case 'AiCritical': def.aiCritical = parseBool(value); break;
      case 'PopupTurret': def.popupTurret = parseBool(value); break;
      case 'Outpost': def.outpost = parseBool(value); break;
      case 'HideUnitOnRadar': def.hideOnRadar = parseBool(value); break;
      case 'UpgradeCost': def.upgradeCost = parseNum(value); def.upgradable = true; break;
      case 'UpgradeTechLevel': def.upgradeTechLevel = parseNum(value); break;
      case 'CanBePrimary': def.canBePrimary = parseBool(value); break;
      case 'UpgradedPrimaryRequired': def.upgradedPrimaryRequired = parseBool(value); break;
      case 'ExcludeFromSkirmishLose': def.excludeFromSkirmishLose = parseBool(value); break;
      case 'ExcludeFromCampaignLose': def.excludeFromCampaignLose = parseBool(value); break;
      case 'CountsForStats': def.countsForStats = parseBool(value); break;
    }
  }

  return def;
}

function parseTurretDef(name: string, section: Section): TurretDef {
  const def = createDefaultTurretDef(name);
  const entries = getEntries(section);

  def.bullet = entries.get('Bullet') ?? '';
  def.reloadCount = parseNum(entries.get('ReloadCount') ?? '30');
  def.muzzleFlash = entries.get('TurretMuzzleFlash') ?? '';
  def.minYRotation = parseNum(entries.get('TurretMinYRotation') ?? '-180');
  def.maxYRotation = parseNum(entries.get('TurretMaxYRotation') ?? '180');
  def.yRotationAngle = parseNum(entries.get('TurretYRotationAngle') ?? '4');
  def.minXRotation = parseNum(entries.get('TurretMinXRotation') ?? '-90');
  def.maxXRotation = parseNum(entries.get('TurretMaxXRotation') ?? '90');
  def.xRotationAngle = parseNum(entries.get('TurretXRotationAngle') ?? '4');
  def.nextJoint = entries.get('TurretNextJoint') ?? '';
  def.turretDisableIfUnitDeployed = parseBool(entries.get('TurretDisableIfUnitDeployed') ?? 'false');
  def.turretDisableIfUnitUndeployed = parseBool(entries.get('TurretDisableIfUnitUndeployed') ?? 'false');

  return def;
}

function parseBulletDef(name: string, section: Section): BulletDef {
  const def = createDefaultBulletDef(name);
  const entries = getEntries(section);

  def.maxRange = parseNum(entries.get('MaxRange') ?? '5');
  def.damage = parseNum(entries.get('Damage') ?? '100');
  def.speed = parseNum(entries.get('Speed') ?? '20');
  def.turnRate = parseNum(entries.get('TurnRate') ?? '0');
  def.warhead = entries.get('Warhead') ?? '';
  def.explosionType = entries.get('ExplosionType') ?? 'ShellHit';
  def.debris = entries.get('Debris') ?? '';
  def.homing = parseBool(entries.get('Homing') ?? 'false');
  def.antiAircraft = parseBool(entries.get('AntiAircraft') ?? 'false');
  def.isLaser = parseBool(entries.get('IsLaser') ?? 'false');
  def.blowUp = parseBool(entries.get('BlowUp') ?? 'false');
  def.blastRadius = parseNum(entries.get('BlastRadius') ?? '0');
  def.reduceDamageWithDistance = parseBool(entries.get('ReduceDamageWithDistance') ?? 'true');
  def.damageFriendly = parseBool(entries.get('DamageFriendly') ?? 'false');
  def.friendlyDamageAmount = parseNum(entries.get('FriendlyDamageAmount') ?? '0');
  def.continuous = parseBool(entries.get('Continuous') ?? 'false');
  def.minRange = parseNum(entries.get('MinRange') ?? '0');
  def.trajectory = parseBool(entries.get('Trajectory') ?? 'false');
  def.homingDelay = parseNum(entries.get('HomingDelay') ?? '0');
  def.antiGround = parseBool(entries.get('AntiGround') ?? 'true');
  def.lingerDuration = parseNum(entries.get('LingerDuration') ?? '0');
  def.lingerDamage = parseNum(entries.get('LingerDamage') ?? '0');

  // Infantry death type: mutually exclusive boolean flags in rules.txt
  // Shot, BlowUp, Burnt, Gassed determine which death animation plays
  if (parseBool(entries.get('Shot') ?? 'false')) def.infantryDeathType = 'Shot';
  else if (parseBool(entries.get('BlowUp') ?? 'false')) def.infantryDeathType = 'BlowUp';
  else if (parseBool(entries.get('Burnt') ?? 'false')) def.infantryDeathType = 'Burnt';
  else if (parseBool(entries.get('Gassed') ?? 'false')) def.infantryDeathType = 'Gassed';

  return def;
}

function parseWarheadDef(name: string, section: Section): WarheadDef {
  const def = createDefaultWarheadDef(name);
  const entries = getEntries(section);

  for (const [armourType, value] of entries) {
    def.vs[armourType] = parseNum(value);
  }

  return def;
}

function parseCrateDef(name: string, section: Section): CrateDef {
  const entries = getEntries(section);
  return {
    name,
    size: parseNum(entries.get('Size') ?? '2'),
    health: parseNum(entries.get('Health') ?? '0'),
    terrain: parseList(entries.get('Terrain') ?? 'Rock, Sand'),
    lifespan: parseNum(entries.get('Lifespan') ?? '10000'),
    crateGiftObject: entries.get('CrateGiftObject') ?? '',
  };
}
