/**
 * Builds the STR[N] string table used by .tok scripts.
 *
 * The .tok bytecode uses a single-byte index (0-127) to reference type names.
 * Based on cross-referencing decompiled missions with known game behavior:
 *   - Indices 0-99 map to units (in rules.txt [UnitTypes] merged order)
 *   - Indices 100-127 map to buildings (first 28 from [BuildingTypes])
 *
 * The building mapping for 100+ is provisional — the exact ordering
 * hasn't been fully verified from GAME.EXE. Type resolution failures
 * are logged to help identify mapping issues during testing.
 */

import type { TypeRegistry } from '../../../core/TypeRegistry';

/** Build the string table: units first (0-99), then buildings (100-127). */
export function buildStringTable(typeRegistry: TypeRegistry): string[] {
  const table: string[] = [];
  for (const name of typeRegistry.unitTypeNames) {
    table.push(name);
  }
  for (const name of typeRegistry.buildingTypeNames) {
    table.push(name);
  }
  return table;
}
