// Parsers and types for original Emperor: Battle for Dune AI data files
// from extracted/AI0001/

// =========================================
// Types
// =========================================

export interface TechLevelParams {
  maxAiUnits: number;
  numBuildings: number;
  buildingDelay: number;
  maintenanceDelay: number;
  maxScriptsToRunAtOnce: number;
  firstAttackDelay: number;
  gapBetweenNewScripts: number;
  unitDelay: number;
  minimumUnitsForDefence: number;
  maximumUnitsForDefence: number;
  maxTurretsAllowed: number;
}

export interface ObjectSet {
  name: string;
  objects: string[];
  formation?: number;
}

export interface StrategySendCommand {
  who: string; // team name or 'all'
  destination: string; // staging name, target name, or 'homebase'
  route: string; // 'quickest' | 'lowthreat'
  encounter: string; // 'attack' | 'avoid'
  endstate: string; // 'attack' | 'guard'
}

export interface StrategyStep {
  sends: StrategySendCommand[];
}

export interface StrategyTeam {
  name: string;
  teamType: string; // references ObjectSet name
  minUnits: number;
  maxUnits: number;
}

export interface StrategyTarget {
  name: string;
  targetType: string; // 'enemybase' | 'threat'
}

export interface StrategyStaging {
  name: string;
  relative: string; // target name
  stagingType: string; // 'front' | 'lflank' | 'rflank' | 'rear'
  distance: string; // 'close' | 'medium' | 'far'
  threat: string; // 'lowthreat' | 'highthreat'
}

export interface StrategyDescription {
  name: string;
  frequency: number;
  minTech: number;
  maxTech: number;
  house: string; // 'all' | 'atreides' | 'harkonnen' | 'ordos'
  losses: number;
  reactive: boolean;
}

export interface Strategy {
  description: StrategyDescription;
  teams: StrategyTeam[];
  targets: StrategyTarget[];
  stagings: StrategyStaging[];
  steps: StrategyStep[];
  techDir: string; // '1'-'7', 'CrossTech', 'SubHouse'
}

export interface AIStrategyParams {
  buildingRatios: { core: number; defence: number; manufacturing: number; resource: number };
  unitRatios: { foot: number; tank: number; air: number; special: number };
  startScript: string[]; // sequence of 'Resource', 'Manufacturing', 'Core', etc.
  percentageOfUnitsForDefence: number;
  defenceTacticWanderDistance: number;
  aiBuildsDefences: boolean;
  largeAttackModifier: number;
  minimumGapBetweenTurrets: number;
  maxTurretsAtLowTech: number;
  maxRefineries: number;
  firstTechLevelToBuildTurrets: number;
  minMoneyToConstructBuildings: number;
  minMoneyToStartBuildingWalls: number;
  minMoneyToBuildMaintenanceBuildings: number;
  chanceOfRetreating: number;
  firstTechLevelForReactive: number;
  unitsToBuildBeforeCreatingScoutTactic: number;
  numberOfScoutTeams: number;
  extraPower: number;
  ticksUntilTargetOld: number;
  ticksUntilAbandonForming: number;
}

export interface OriginalAIData {
  techLevels: TechLevelParams[];   // index 0..7 → tech 1..8
  strategyParams: AIStrategyParams;
  objectSets: Map<string, ObjectSet>;
  strategies: Strategy[];
}

// =========================================
// Parsers
// =========================================

/** Strip inline comments (// style) and trim whitespace */
function stripComment(line: string): string {
  const idx = line.indexOf('//');
  return (idx >= 0 ? line.slice(0, idx) : line).trim();
}

/** Parse an INI-style value, stripping trailing commas */
function parseVal(raw: string): string {
  return raw.replace(/,\s*$/, '').trim();
}

export function parseTechLevels(text: string): TechLevelParams[] {
  const defaults: TechLevelParams = {
    maxAiUnits: 22, numBuildings: 7, buildingDelay: 1200,
    maintenanceDelay: 3500, maxScriptsToRunAtOnce: 2,
    firstAttackDelay: 5000, gapBetweenNewScripts: 1300,
    unitDelay: 875, minimumUnitsForDefence: 2,
    maximumUnitsForDefence: 5, maxTurretsAllowed: 0,
  };

  const levels: TechLevelParams[] = [];
  let current: TechLevelParams | null = null;

  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine);
    if (!line) continue;

    const sectionMatch = line.match(/^\[Tech(\d+)\]$/i);
    if (sectionMatch) {
      if (current) levels.push(current);
      // Each new tech inherits from tech 1 defaults (per game comments)
      current = { ...(levels[0] ?? defaults) };
      continue;
    }

    if (!current) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;

    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const val = parseVal(line.slice(eqIdx + 1));
    const num = parseInt(val, 10);
    if (isNaN(num)) continue;

    switch (key) {
      case 'maxaiunits': current.maxAiUnits = num; break;
      case 'numbuildings': current.numBuildings = num; break;
      case 'buildingdelay': current.buildingDelay = num; break;
      case 'maintenancedelay': current.maintenanceDelay = num; break;
      case 'maxscriptstorunatonce': current.maxScriptsToRunAtOnce = num; break;
      case 'firstattackdelay': current.firstAttackDelay = num; break;
      case 'gapbetweennewscripts': current.gapBetweenNewScripts = num; break;
      case 'unitdelay': current.unitDelay = num; break;
      case 'minimumunitsfordefence': current.minimumUnitsForDefence = num; break;
      case 'maximumunitsfordefence': current.maximumUnitsForDefence = num; break;
      case 'maxturretsallowed': current.maxTurretsAllowed = num; break;
    }
  }
  if (current) levels.push(current);

  return levels;
}

export function parseAIStrategyParams(text: string): AIStrategyParams {
  const params: AIStrategyParams = {
    buildingRatios: { core: 17, defence: 17, manufacturing: 40, resource: 26 },
    unitRatios: { foot: 20, tank: 80, air: 0, special: 0 },
    startScript: [],
    percentageOfUnitsForDefence: 24,
    defenceTacticWanderDistance: 29,
    aiBuildsDefences: true,
    largeAttackModifier: 100,
    minimumGapBetweenTurrets: 5,
    maxTurretsAtLowTech: 3,
    maxRefineries: 2,
    firstTechLevelToBuildTurrets: 3,
    minMoneyToConstructBuildings: 600,
    minMoneyToStartBuildingWalls: 3800,
    minMoneyToBuildMaintenanceBuildings: 1000,
    chanceOfRetreating: 50,
    firstTechLevelForReactive: 4,
    unitsToBuildBeforeCreatingScoutTactic: 3,
    numberOfScoutTeams: 3,
    extraPower: 20,
    ticksUntilTargetOld: 1200,
    ticksUntilAbandonForming: 1500,
  };

  let section = '';
  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine);
    if (!line) continue;

    const secMatch = line.match(/^\[(.+)\]$/);
    if (secMatch) {
      section = secMatch[1].toLowerCase();
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const val = parseVal(line.slice(eqIdx + 1));

    if (section === 'buildingconstructionratios') {
      const num = parseInt(val, 10);
      if (isNaN(num)) continue;
      if (key === 'core') params.buildingRatios.core = num;
      else if (key === 'defence') params.buildingRatios.defence = num;
      else if (key === 'manufacturing') params.buildingRatios.manufacturing = num;
      else if (key === 'resource') params.buildingRatios.resource = num;
    } else if (section === 'unitconstructionratios') {
      const num = parseInt(val, 10);
      if (isNaN(num)) continue;
      if (key === 'foot') params.unitRatios.foot = num;
      else if (key === 'tank') params.unitRatios.tank = num;
      else if (key === 'air') params.unitRatios.air = num;
      else if (key === 'special') params.unitRatios.special = num;
    } else if (section === 'startscript') {
      if (key === 'next') params.startScript.push(val);
    } else if (section === 'strategy') {
      const num = parseInt(val, 10);
      switch (key) {
        case 'unitstobuildbeforecreatingscouttactic': params.unitsToBuildBeforeCreatingScoutTactic = num; break;
        case 'ticksuntiltargetold': params.ticksUntilTargetOld = num; break;
        case 'numberofscoutteams': params.numberOfScoutTeams = num; break;
        case 'percentageofunitsfordefence': params.percentageOfUnitsForDefence = num; break;
        case 'defencetacticwanderdistance': params.defenceTacticWanderDistance = num; break;
        case 'aibuildsdefences': params.aiBuildsDefences = num !== 0; break;
        case 'largeattackmodifier': params.largeAttackModifier = num; break;
        case 'minimumgapbetweenturrets': params.minimumGapBetweenTurrets = num; break;
        case 'maxturretsatlowtech': params.maxTurretsAtLowTech = num; break;
        case 'maxrefineries': params.maxRefineries = num; break;
        case 'firsttechleveltobuildturrets': params.firstTechLevelToBuildTurrets = num; break;
        case 'minmoneytoconstructbuildings': params.minMoneyToConstructBuildings = num; break;
        case 'minmoneytostartbuildingwalls': params.minMoneyToStartBuildingWalls = num; break;
        case 'minmoneytobuildmaintenancebuildings': params.minMoneyToBuildMaintenanceBuildings = num; break;
        case 'chanceofretreating': params.chanceOfRetreating = num; break;
        case 'firsttechlevelforreactive': params.firstTechLevelForReactive = num; break;
        case 'extrapower': params.extraPower = num; break;
        case 'ticksuntilabandonforming': params.ticksUntilAbandonForming = num; break;
      }
    }
  }

  return params;
}

export function parseObjectSets(text: string): Map<string, ObjectSet> {
  const sets = new Map<string, ObjectSet>();
  let current: ObjectSet | null = null;

  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine);
    if (!line) continue;

    const upper = line.toUpperCase();
    if (upper === 'OBJECTSET') {
      current = { name: '', objects: [] };
      continue;
    }
    if (upper === 'ENDOBJECTSET') {
      if (current && current.name) {
        sets.set(current.name.toLowerCase(), current);
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx < 0) continue;
    const key = line.slice(0, eqIdx).trim().toLowerCase();
    const val = line.slice(eqIdx + 1).trim();

    if (key === 'name') {
      current.name = val.trim();
    } else if (key === 'object') {
      // Strip leading '=' typo (OREITS has Object==OREITS)
      const obj = val.replace(/^=/, '').trim();
      if (obj) current.objects.push(obj);
    } else if (key === 'formation') {
      current.formation = parseInt(val, 10);
    }
  }

  return sets;
}

export function parseStrategy(text: string, techDir: string): Strategy | null {
  const strategy: Strategy = {
    description: {
      name: '', frequency: 1, minTech: 1, maxTech: 8,
      house: 'all', losses: 100, reactive: false,
    },
    teams: [],
    targets: [],
    stagings: [],
    steps: [],
    techDir,
  };

  let section = ''; // 'description' | 'team' | 'target' | 'staging' | 'step' | 'send'
  let inStrategy = false;
  let currentTeam: StrategyTeam | null = null;
  let currentTarget: StrategyTarget | null = null;
  let currentStaging: StrategyStaging | null = null;
  let currentStep: StrategyStep | null = null;
  let currentSend: StrategySendCommand | null = null;

  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine);
    if (!line) continue;
    const upper = line.toUpperCase();

    if (upper === 'STRATEGY') { inStrategy = true; continue; }
    if (upper === 'ENDSTRATEGY') { break; }
    if (!inStrategy) continue;

    // Section transitions
    if (upper === 'DESCRIPTION') { section = 'description'; continue; }
    if (upper === 'ENDDESCRIPTION') { section = ''; continue; }
    if (upper === 'TEAM') { section = 'team'; currentTeam = { name: '', teamType: '', minUnits: 1, maxUnits: 5 }; continue; }
    if (upper === 'ENDTEAM') { if (currentTeam) strategy.teams.push(currentTeam); currentTeam = null; section = ''; continue; }
    if (upper === 'TARGET') { section = 'target'; currentTarget = { name: '', targetType: 'enemybase' }; continue; }
    if (upper === 'ENDTARGET') { if (currentTarget) strategy.targets.push(currentTarget); currentTarget = null; section = ''; continue; }
    if (upper === 'STAGING') { section = 'staging'; currentStaging = { name: '', relative: '', stagingType: 'front', distance: 'medium', threat: 'lowthreat' }; continue; }
    if (upper === 'ENDSTAGING') { if (currentStaging) strategy.stagings.push(currentStaging); currentStaging = null; section = ''; continue; }
    if (upper === 'STEP') { section = 'step'; currentStep = { sends: [] }; continue; }
    if (upper === 'ENDSTEP') { if (currentStep) strategy.steps.push(currentStep); currentStep = null; section = ''; continue; }
    if (upper === 'SEND') { section = 'send'; currentSend = { who: 'all', destination: '', route: 'quickest', encounter: 'attack', endstate: 'attack' }; continue; }
    if (upper === 'ENDSEND') { if (currentSend && currentStep) currentStep.sends.push(currentSend); currentSend = null; section = 'step'; continue; }

    // Parse key-value pairs within sections
    // Strategy files use both 'key=value' and 'key value' formats
    let key: string, val: string;
    const eqIdx = line.indexOf('=');
    if (eqIdx >= 0) {
      key = line.slice(0, eqIdx).trim().toLowerCase();
      val = line.slice(eqIdx + 1).trim();
    } else {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx < 0) continue;
      key = line.slice(0, spaceIdx).trim().toLowerCase();
      val = line.slice(spaceIdx + 1).trim();
    }

    switch (section) {
      case 'description':
        switch (key) {
          case 'name': strategy.description.name = val; break;
          case 'frequency': strategy.description.frequency = parseInt(val, 10) || 1; break;
          case 'mintech': strategy.description.minTech = parseInt(val, 10) || 1; break;
          case 'maxtech': strategy.description.maxTech = parseInt(val, 10) || 8; break;
          case 'house': strategy.description.house = val.toLowerCase(); break;
          case 'losses': strategy.description.losses = parseInt(val, 10) || 100; break;
          case 'reactive': strategy.description.reactive = val === '1'; break;
        }
        break;

      case 'team':
        if (currentTeam) {
          switch (key) {
            case 'name': currentTeam.name = val; break;
            case 'teamtype': currentTeam.teamType = val; break;
            case 'minunits': currentTeam.minUnits = parseInt(val, 10) || 1; break;
            case 'maxunits': currentTeam.maxUnits = parseInt(val, 10) || 5; break;
          }
        }
        break;

      case 'target':
        if (currentTarget) {
          switch (key) {
            case 'name': currentTarget.name = val; break;
            case 'targettype': currentTarget.targetType = val.toLowerCase(); break;
          }
        }
        break;

      case 'staging':
        if (currentStaging) {
          switch (key) {
            case 'name': currentStaging.name = val; break;
            case 'relative': currentStaging.relative = val; break;
            case 'stagingtype': currentStaging.stagingType = val.toLowerCase(); break;
            case 'distance': currentStaging.distance = val.toLowerCase(); break;
            case 'threat': currentStaging.threat = val.toLowerCase(); break;
          }
        }
        break;

      case 'send':
        if (currentSend) {
          switch (key) {
            case 'who': currentSend.who = val; break;
            case 'destination': currentSend.destination = val; break;
            case 'route': currentSend.route = val.toLowerCase(); break;
            case 'encounter': currentSend.encounter = val.toLowerCase(); break;
            case 'endstate': currentSend.endstate = val.toLowerCase(); break;
          }
        }
        break;
    }
  }

  if (!strategy.description.name) return null;
  return strategy;
}

// =========================================
// Strategy file manifest (static game data)
// =========================================

const STRATEGY_FILES: Record<string, string[]> = {
  '1': [
    'Gen_InfantryThreatAttack.txt',
    'Gen_InfantryWorthAttack.txt',
    'Gen_LargeInfantryAttack.txt',
  ],
  '2': [
    'Gen_CliffDefence.txt', 'Gen_CliffPatrol.txt',
    'Gen_InfantryBaseAttack1.txt', 'Gen_InfantryVInfantry.txt',
    'Gen_T1TankFodder1.txt', 'Gen_T1TankFodder2.txt', 'Gen_T1TankFodder3.txt',
    'Gen_T1ThreatAttack.txt', 'Gen_T1TurretFodder1.txt', 'Gen_T1ValleyPatrol.txt',
    'Gen_T2TankFodder1.txt', 'Gen_TankBaseAttackLeft.txt',
    'Gen_TankBaseAttackRight.txt', 'Gen_TankVTank.txt',
  ],
  '3': [
    'AT_MongooseHeight.txt',
    'Gen_CliffDefence.txt', 'Gen_CliffPatrol.txt',
    'Gen_Engineer.txt', 'Gen_EngineerRight.txt',
    'Gen_InfantryBaseAttack1.txt', 'Gen_InfantryVInfantry.txt',
    'Gen_MixedWorthAttack.txt',
    'Gen_T1TankFodder1.txt', 'Gen_T1TankFodder2.txt', 'Gen_T1TurretFodder1.txt',
    'Gen_T2TankFodder1.txt',
    'Gen_TankBaseAttackLeft.txt', 'Gen_TankBaseAttackRight.txt',
    'Gen_TankFodder3.txt', 'Gen_TankVTank.txt',
    'Gen_ThreatAttack.txt', 'Gen_ValleyPatrol.txt',
    'HK_AssaultWaves.txt', 'OR_ValleyLaserPatrol.txt',
  ],
  '4': [
    'AT_CliffPatrolKindjal.txt', 'AT_EngineerAttack.txt',
    'AT_EngineerAttackLeft.txt', 'AT_EngineerAttackRight.txt',
    'AT_InfantryApcAttackRight.txt', 'AT_MixedWorthAttack.txt', 'AT_MongooseHeight.txt',
    'Gen_CliffDefence.txt', 'Gen_Flanks.txt',
    'Gen_InfantryThreatAttack.txt', 'Gen_PincerWorth.txt',
    'Gen_RangeSupportAttack.txt',
    'Gen_TankThreatAttack.txt', 'Gen_TankWorthAttack.txt',
    'Gen_TankWorthLeft.txt', 'Gen_TankWorthRear.txt', 'Gen_TankWorthRight.txt',
    'Gen_ValleyPatrol.txt', 'Gen_Waves.txt',
    'HK_AssaultWaves.txt', 'HK_EngineerRear.txt', 'HK_EngineerRight.txt',
    'HK_FlamerTankThreatAttack.txt', 'HK_FlamerThreatAttack.txt', 'HK_MixedWorthAttack.txt',
    'OR_CliffPatrolMortar.txt', 'OR_EngineerAttack.txt',
    'OR_EngineerAttackLeft.txt', 'OR_EngineerAttackRight.txt',
    'OR_InfantryApcAttackRight.txt', 'OR_MixedWorthAttack.txt', 'OR_ValleyLaserPatrol.txt',
  ],
  '5': [
    'AT_CliffPatrolKindjal.txt', 'AT_EngineerAttackLeft.txt',
    'AT_EngineerAttackRear.txt', 'AT_EngineerAttackRight.txt',
    'AT_InfantryApcAttackRight.txt', 'AT_MinoWorthAttack.txt',
    'AT_MongooseHeight.txt', 'AT_TankWorthAttackRepair.txt',
    'Gen_AirAttackThreat.txt', 'Gen_AircraftWorthAttack.txt',
    'Gen_CliffDefence.txt', 'Gen_EngineerCounters.txt', 'Gen_Flanks.txt',
    'Gen_InfantryThreatAttack.txt', 'Gen_PincerWorth.txt',
    'Gen_RangeSupportAttack.txt', 'Gen_T5TankAirAttack.txt', 'Gen_T5TankAttack.txt',
    'Gen_TankThreatAttack.txt', 'Gen_TankWorthAttack.txt',
    'Gen_TankWorthLeft.txt', 'Gen_TankWorthRear.txt', 'Gen_TankWorthRight.txt',
    'Gen_Waves.txt',
    'HK_AssaultWaves.txt', 'HK_EngineerRear.txt', 'HK_EngineerRight.txt',
    'HK_FlamerTankThreatAttack.txt', 'HK_FlamerThreatAttack.txt', 'Hk_InkFire.txt',
    'HK_MissileWorthAttack.txt',
    'OR_CliffDefenceKobra.txt', 'OR_CliffPatrolKobra.txt', 'OR_CliffPatrolMortar.txt',
    'OR_EITSAttack.txt', 'OR_EngineerAttackLeft.txt',
    'OR_EngineerAttackRear.txt', 'OR_EngineerAttackRight.txt',
    'OR_InfantryApcAttackRight.txt', 'OR_SaboteurWaves.txt', 'OR_ValleyLaserPatrol.txt',
  ],
  '6': [
    'AT_CliffPatrolKindjal.txt', 'AT_EngineerAttackLeft.txt',
    'AT_EngineerAttackRear.txt', 'AT_InfantryApcAttackRight.txt',
    'AT_MinoWorthAttack.txt', 'AT_MongooseHeight.txt', 'AT_TankWorthAttackRepair.txt',
    'Gen_ADPDefend.txt', 'Gen_AdvCarryallAttack.txt', 'Gen_AirAndLand.txt',
    'Gen_AirAttackThreat.txt', 'Gen_AircraftHarvesterAttack.txt', 'Gen_AircraftWorthAttack.txt',
    'Gen_CliffDefence.txt', 'Gen_EngineerCounters.txt', 'Gen_Flanks.txt',
    'Gen_InfantryThreatAttack.txt', 'Gen_PincerWorth.txt',
    'Gen_RangeSupportAttack.txt', 'Gen_T5TankAirAttack.txt', 'Gen_T5TankAttack.txt',
    'Gen_TankThreatAttack.txt', 'Gen_TankWorthAttack.txt',
    'Gen_TankWorthLeft.txt', 'Gen_TankWorthRear.txt', 'Gen_TankWorthRight.txt',
    'Gen_Waves.txt',
    'HK_AssaultWaves.txt', 'HK_EngineerRear.txt', 'HK_EngineerRight.txt',
    'HK_FlamerTankThreatAttack.txt', 'HK_FlamerThreatAttack.txt', 'Hk_InkFire.txt',
    'HK_MissileWorthAttack.txt',
    'OR_CliffDefenceKobra.txt', 'OR_CliffPatrolKobra.txt', 'OR_CliffPatrolMortar.txt',
    'OR_EITSAttack.txt', 'OR_EngineerAttackRear.txt', 'OR_EngineerAttackRight.txt',
    'OR_InfantryApcAttackRight.txt', 'OR_SaboteurWaves.txt', 'OR_ValleyLaserPatrol.txt',
  ],
  '7': [
    'AT_CliffPatrolKindjal.txt', 'AT_EngineerAttackLeft.txt',
    'AT_EngineerAttackRear.txt', 'AT_InfantryApcAttackRight.txt',
    'AT_MinoWorthAttack.txt', 'AT_MongooseHeight.txt',
    'AT_SonicTankThreatAttack.txt', 'AT_TankWorthAttackRepair.txt',
    'Gen_ADPDefend.txt', 'Gen_AdvCarryallAttack.txt',
    'Gen_AdvTankThreatAttack.txt', 'Gen_AdvTankWorthAttack.txt',
    'Gen_AirAndLand.txt', 'Gen_AirAttackThreat.txt',
    'Gen_AircraftHarvesterAttack.txt', 'Gen_AircraftWorthAttack.txt',
    'Gen_AnyLargeAttack.txt', 'Gen_CliffDefence.txt', 'Gen_CliffPatrol.txt',
    'Gen_EngineerCounters.txt', 'Gen_Flanks.txt',
    'Gen_HarvesterHunters.txt', 'Gen_InfantryThreatAttack.txt',
    'Gen_PincerWorth.txt', 'Gen_RangeSupportAttack.txt',
    'Gen_T2TankWorthLarge.txt', 'Gen_T3TankWorthLarge.txt',
    'Gen_T5TankAirAttack.txt', 'Gen_T5TankAttack.txt',
    'Gen_TankThreatAttack.txt', 'Gen_TankWorthAttack.txt',
    'Gen_TankWorthAttackBig.txt', 'Gen_TankWorthLeft.txt',
    'Gen_TankWorthRear.txt', 'Gen_TankWorthRight.txt',
    'Gen_TurretAttack.txt', 'Gen_UnitDrop.txt', 'Gen_Waves.txt',
    'HK_AssaultWaves.txt', 'HK_DevastatorWorthAttack.txt',
    'HK_EngineerRear.txt', 'HK_EngineerRight.txt',
    'HK_FlamerTankThreatAttack.txt', 'HK_FlamerThreatAttack.txt',
    'Hk_InkFire.txt', 'HK_MissileWorthAttack.txt',
    'OR_CliffDefenceKobra.txt', 'OR_CliffPatrolKobra.txt', 'OR_CliffPatrolMortar.txt',
    'OR_DeviatorThreatAttack.txt', 'OR_EITSAttack.txt',
    'OR_EngineerAttackRear.txt', 'OR_EngineerAttackRight.txt',
    'OR_InfantryApcAttackRight.txt', 'OR_SaboteurWaves.txt', 'OR_ValleyLaserPatrol.txt',
  ],
  'CrossTech': [
    'Gen_AnyAttack.txt', 'Gen_BasicSmallTankAttack.txt', 'Gen_LargeInfantryAttack.txt',
  ],
  'SubHouse': [
    'GU_NiabTank.txt', 'IM_ADVSardaukar.txt', 'IX_Infiltrator.txt',
    'TL_Contaminator.txt', 'TL_Leech.txt',
  ],
};

// =========================================
// Loader
// =========================================

export async function loadOriginalAIData(): Promise<OriginalAIData> {
  const basePath = '/extracted/AI0001';

  // Fetch config files in parallel
  const [difficultyRes, aiIniRes, objectSetsRes] = await Promise.all([
    fetch(`${basePath}/ai_difficulty.ini`),
    fetch(`${basePath}/ai.ini`),
    fetch(`${basePath}/objectsets.txt`),
  ]);

  if (!difficultyRes.ok || !aiIniRes.ok || !objectSetsRes.ok) {
    throw new Error(`Failed to fetch AI config files: difficulty=${difficultyRes.status} ai=${aiIniRes.status} objectsets=${objectSetsRes.status}`);
  }

  const [difficultyText, aiIniText, objectSetsText] = await Promise.all([
    difficultyRes.text(),
    aiIniRes.text(),
    objectSetsRes.text(),
  ]);

  const techLevels = parseTechLevels(difficultyText);
  const strategyParams = parseAIStrategyParams(aiIniText);
  const objectSets = parseObjectSets(objectSetsText);

  // Fetch all strategy files in parallel
  const fetchPromises: Promise<{ text: string; dir: string } | null>[] = [];
  for (const [dir, files] of Object.entries(STRATEGY_FILES)) {
    for (const file of files) {
      fetchPromises.push(
        fetch(`${basePath}/${dir}/${file}`)
          .then(res => res.ok ? res.text().then(text => ({ text, dir })) : null)
          .catch(() => null)
      );
    }
  }

  const results = await Promise.all(fetchPromises);
  const strategies: Strategy[] = [];

  for (const result of results) {
    if (!result) continue;
    const strategy = parseStrategy(result.text, result.dir);
    if (strategy) strategies.push(strategy);
  }

  console.log(`[OriginalAI] Loaded: ${techLevels.length} tech levels, ${objectSets.size} object sets, ${strategies.length} strategies`);

  return { techLevels, strategyParams, objectSets, strategies };
}
