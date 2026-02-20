import type { GameRules } from '../config/RulesParser';

export interface TypeRegistry {
  unitTypeIdMap: Map<string, number>;
  unitTypeNames: string[];
  buildingTypeIdMap: Map<string, number>;
  buildingTypeNames: string[];
  armourIdMap: Map<string, number>;
}

export function buildTypeRegistries(gameRules: GameRules): TypeRegistry {
  const unitTypeIdMap = new Map<string, number>();
  const unitTypeNames: string[] = [];
  const buildingTypeIdMap = new Map<string, number>();
  const buildingTypeNames: string[] = [];
  const armourIdMap = new Map<string, number>();

  let idx = 0;
  for (const name of gameRules.units.keys()) {
    unitTypeIdMap.set(name, idx);
    unitTypeNames.push(name);
    idx++;
  }
  idx = 0;
  for (const name of gameRules.buildings.keys()) {
    buildingTypeIdMap.set(name, idx);
    buildingTypeNames.push(name);
    idx++;
  }
  idx = 0;
  for (const armour of gameRules.armourTypes) {
    armourIdMap.set(armour, idx);
    idx++;
  }

  return { unitTypeIdMap, unitTypeNames, buildingTypeIdMap, buildingTypeNames, armourIdMap };
}
