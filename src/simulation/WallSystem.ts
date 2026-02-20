import {
  Position, Health, Owner, BuildingType, buildingQuery,
  hasComponent, type World,
} from '../core/ECS';
import { worldToTile } from '../utils/MathUtils';
import type { GameRules } from '../config/RulesParser';

/**
 * WallSystem manages wall segment placement, auto-connection, and pathfinding integration.
 * Walls are 1x1 buildings that auto-connect to adjacent wall segments visually.
 */
export class WallSystem {
  private rules: GameRules;
  private buildingTypeNames: string[] = [];
  // Wall tiles: "tx,tz" -> entityId (living walls only)
  private wallTiles = new Map<string, number>();

  constructor(rules: GameRules) {
    this.rules = rules;
  }

  setBuildingTypeNames(names: string[]): void {
    this.buildingTypeNames = names;
  }

  /** Rebuild wall tile map from world state */
  updateWallTiles(world: World): void {
    this.wallTiles.clear();
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      if (Health.current[eid] <= 0) continue;
      const typeId = BuildingType.id[eid];
      const typeName = this.buildingTypeNames[typeId] ?? '';
      const def = this.rules.buildings.get(typeName);
      if (!def?.wall) continue;
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      this.wallTiles.set(`${tile.tx},${tile.tz}`, eid);
    }
  }

  /** Check if a tile has a wall */
  hasWall(tx: number, tz: number): boolean {
    return this.wallTiles.has(`${tx},${tz}`);
  }

  /** Get the wall entity at a tile */
  getWallAt(tx: number, tz: number): number | undefined {
    return this.wallTiles.get(`${tx},${tz}`);
  }

  /**
   * Get wall connection bitmask for a tile (for choosing wall model variant).
   * Bit 0 = north (tz-1), Bit 1 = east (tx+1), Bit 2 = south (tz+1), Bit 3 = west (tx-1)
   * Returns 0-15 indicating which neighbors are also walls.
   */
  getConnectionMask(tx: number, tz: number): number {
    let mask = 0;
    if (this.hasWall(tx, tz - 1)) mask |= 1; // North
    if (this.hasWall(tx + 1, tz)) mask |= 2; // East
    if (this.hasWall(tx, tz + 1)) mask |= 4; // South
    if (this.hasWall(tx - 1, tz)) mask |= 8; // West
    return mask;
  }

  /**
   * Calculate wall segments for a drag line from (startTx, startTz) to (endTx, endTz).
   * Returns list of tile coords for wall placement (Bresenham line).
   */
  getWallLine(startTx: number, startTz: number, endTx: number, endTz: number): { tx: number; tz: number }[] {
    const tiles: { tx: number; tz: number }[] = [];

    // Bresenham's line algorithm for axis-aligned and diagonal lines
    let dx = Math.abs(endTx - startTx);
    let dz = Math.abs(endTz - startTz);
    const sx = startTx < endTx ? 1 : -1;
    const sz = startTz < endTz ? 1 : -1;
    let err = dx - dz;
    let tx = startTx;
    let tz = startTz;

    while (true) {
      tiles.push({ tx, tz });
      if (tx === endTx && tz === endTz) break;
      const e2 = 2 * err;
      if (e2 > -dz) {
        err -= dz;
        tx += sx;
      }
      if (e2 < dx) {
        err += dx;
        tz += sz;
      }
    }

    return tiles;
  }

  /**
   * Check which tiles in a wall line are valid for placement.
   * Returns only tiles where a wall can actually be built.
   */
  filterValidPlacements(
    tiles: { tx: number; tz: number }[],
    occupiedTiles: Set<string>,
    ownedTiles: Set<string>,
    isTerrainValid: (tx: number, tz: number) => boolean,
    maxPlacementDist: number,
  ): { tx: number; tz: number; valid: boolean }[] {
    return tiles.map(t => {
      const key = `${t.tx},${t.tz}`;

      // Already has a wall or building
      if (occupiedTiles.has(key)) return { ...t, valid: false };

      // Terrain check
      if (!isTerrainValid(t.tx, t.tz)) return { ...t, valid: false };

      // Proximity to owned buildings (or other valid wall tiles in this line)
      let nearOwned = false;
      for (const owned of ownedTiles) {
        const [bx, bz] = owned.split(',').map(Number);
        if (Math.abs(bx - t.tx) + Math.abs(bz - t.tz) <= maxPlacementDist + 3) {
          nearOwned = true;
          break;
        }
      }

      return { ...t, valid: nearOwned };
    });
  }

  /** Get the wall type name for a faction prefix (e.g. 'AT' -> 'ATWall') */
  getWallTypeName(factionPrefix: string): string | null {
    // Try faction-specific wall first
    const name = `${factionPrefix}Wall`;
    if (this.rules.buildings.has(name)) return name;
    // Try Ix wall (sub-house)
    if (this.rules.buildings.has('IXWall')) return 'IXWall';
    return null;
  }
}
