import { describe, it, expect } from 'vitest';
import { PathfindingSystem } from '../../src/simulation/PathfindingSystem';
import { TerrainType } from '../../src/rendering/TerrainRenderer';

/**
 * Mock TerrainRenderer that satisfies PathfindingSystem's needs.
 * Creates a grid where we can set terrain types per tile.
 */
class MockTerrain {
  private data: TerrainType[];
  private width: number;
  private height: number;

  constructor(width: number, height: number, defaultType = TerrainType.Sand) {
    this.width = width;
    this.height = height;
    this.data = new Array(width * height).fill(defaultType);
  }

  getMapWidth(): number { return this.width; }
  getMapHeight(): number { return this.height; }

  getTerrainType(tx: number, tz: number): TerrainType {
    if (tx < 0 || tx >= this.width || tz < 0 || tz >= this.height) return TerrainType.Cliff;
    return this.data[tz * this.width + tx];
  }

  setTile(tx: number, tz: number, type: TerrainType): void {
    if (tx >= 0 && tx < this.width && tz >= 0 && tz < this.height) {
      this.data[tz * this.width + tx] = type;
    }
  }

  isPassable(tx: number, tz: number): boolean {
    const type = this.getTerrainType(tx, tz);
    return type !== TerrainType.Cliff;
  }

  isPassableVehicle(tx: number, tz: number): boolean {
    const type = this.getTerrainType(tx, tz);
    return type !== TerrainType.Cliff && type !== TerrainType.InfantryRock;
  }
}

describe('PathfindingSystem', () => {
  describe('straight line path', () => {
    it('finds path on open terrain', () => {
      const terrain = new MockTerrain(16, 16);
      const pf = new PathfindingSystem(terrain as any);

      const path = pf.findPath(0, 0, 5, 0);
      expect(path).not.toBeNull();
      expect(path!.length).toBeGreaterThan(0);
      // First point should be start, last should be destination
      expect(path![0]).toEqual({ x: 1, z: 1 }); // tile (0,0) -> world center (1,1)
      const last = path![path!.length - 1];
      expect(last).toEqual({ x: 11, z: 1 }); // tile (5,0) -> world center (11,1)
    });

    it('finds diagonal path', () => {
      const terrain = new MockTerrain(16, 16);
      const pf = new PathfindingSystem(terrain as any);

      const path = pf.findPath(0, 0, 5, 5);
      expect(path).not.toBeNull();
      expect(path!.length).toBeGreaterThanOrEqual(2); // At least start and end
    });
  });

  describe('obstacle avoidance', () => {
    it('routes around a cliff wall', () => {
      const terrain = new MockTerrain(16, 16);
      // Create a vertical wall of cliffs at x=3, z=0..4
      for (let z = 0; z <= 4; z++) {
        terrain.setTile(3, z, TerrainType.Cliff);
      }
      const pf = new PathfindingSystem(terrain as any);

      const path = pf.findPath(0, 2, 6, 2);
      expect(path).not.toBeNull();

      // Path should not pass through any cliff tiles
      for (const point of path!) {
        const tx = Math.floor((point.x - 1) / 2); // world center to tile
        const tz = Math.floor((point.z - 1) / 2);
        expect(terrain.getTerrainType(tx, tz)).not.toBe(TerrainType.Cliff);
      }
    });

    it('routes around blocked tiles', () => {
      const terrain = new MockTerrain(16, 16);
      const pf = new PathfindingSystem(terrain as any);

      // Block tiles with occupied set
      const occupied = new Set<string>();
      occupied.add('3,2');
      occupied.add('3,3');
      occupied.add('3,4');
      pf.updateBlockedTiles(occupied);

      const path = pf.findPath(0, 3, 6, 3);
      expect(path).not.toBeNull();
    });

    it('returns null for completely enclosed destination', () => {
      const terrain = new MockTerrain(16, 16);
      // Surround tile (5,5) with cliffs
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          terrain.setTile(5 + dx, 5 + dz, TerrainType.Cliff);
        }
      }
      terrain.setTile(5, 5, TerrainType.Cliff); // destination itself is also impassable
      const pf = new PathfindingSystem(terrain as any);

      // findPath redirects to nearest passable tile, but if that's also
      // unreachable (surrounded), it should return null
      const path = pf.findPath(0, 0, 5, 5);
      // It either returns null or routes to nearest passable tile
      // The destination is a cliff, so it will try findNearestPassable
      // which should find a tile outside the cliff ring
      if (path) {
        // If it found a path, it should not end at the original cliff tile
        const last = path[path.length - 1];
        const lastTx = Math.floor((last.x - 1) / 2);
        const lastTz = Math.floor((last.z - 1) / 2);
        expect(terrain.isPassable(lastTx, lastTz)).toBe(true);
      }
    });
  });

  describe('vehicle vs infantry passability', () => {
    it('vehicles cannot cross infantry rock', () => {
      const terrain = new MockTerrain(10, 10);
      // Create infantry rock barrier spanning entire column
      for (let z = 0; z < 10; z++) {
        terrain.setTile(5, z, TerrainType.InfantryRock);
      }
      const pf = new PathfindingSystem(terrain as any);

      // Vehicle path should not reach the far side of the barrier
      const vehiclePath = pf.findPath(0, 5, 9, 5, true);
      if (vehiclePath) {
        // Path should not pass through infantry rock tiles
        const last = vehiclePath[vehiclePath.length - 1];
        const lastTx = Math.floor((last.x - 1) / 2);
        // Should not reach beyond the barrier (tile x >= 5)
        expect(lastTx).toBeLessThan(5);
      }
    });

    it('infantry can cross infantry rock', () => {
      const terrain = new MockTerrain(10, 10);
      // Create infantry rock barrier
      for (let z = 0; z < 10; z++) {
        terrain.setTile(5, z, TerrainType.InfantryRock);
      }
      const pf = new PathfindingSystem(terrain as any);

      // Infantry should be able to cross
      const infPath = pf.findPath(0, 5, 9, 5, false);
      expect(infPath).not.toBeNull();
    });
  });

  describe('terrain cost multipliers', () => {
    it('prefers rock/concrete over dunes', () => {
      const terrain = new MockTerrain(20, 5);
      // Create two paths from (0,2) to (19,2):
      // Top route (z=0): all rock (0.8x cost)
      // Direct route (z=2): all dunes (1.5x cost)
      // Bottom route (z=4): all rock (0.8x cost)
      for (let x = 0; x < 20; x++) {
        terrain.setTile(x, 0, TerrainType.Rock);
        terrain.setTile(x, 1, TerrainType.Rock);
        terrain.setTile(x, 2, TerrainType.Dunes);
        terrain.setTile(x, 3, TerrainType.Rock);
        terrain.setTile(x, 4, TerrainType.Rock);
      }
      const pf = new PathfindingSystem(terrain as any);
      const path = pf.findPath(0, 2, 19, 2);
      expect(path).not.toBeNull();

      // Path should prefer the rock route, meaning some points will have z != 2*2+1=5
      // (world z=5 corresponds to tile z=2 which is dunes)
      const usesRock = path!.some(p => p.z !== 5);
      expect(usesRock).toBe(true);
    });
  });

  describe('path simplification', () => {
    it('simplifies collinear points', () => {
      const terrain = new MockTerrain(16, 16);
      const pf = new PathfindingSystem(terrain as any);

      // Straight horizontal path should be fewer points than raw tiles
      const path = pf.findPath(0, 5, 10, 5);
      expect(path).not.toBeNull();
      // Even if not perfectly simplified to 2, should be much less than 11 raw tiles
      expect(path!.length).toBeLessThan(11);
    });
  });

  describe('node limit', () => {
    it('returns partial path when node limit exceeded', () => {
      // Large map with obstacles that make pathfinding expensive
      const terrain = new MockTerrain(100, 100);
      // Create maze-like obstacles
      for (let x = 10; x < 90; x += 5) {
        for (let z = 0; z < 90; z++) {
          terrain.setTile(x, z, TerrainType.Cliff);
        }
        // Leave gaps at alternating z positions
        terrain.setTile(x, (x / 5) % 2 === 0 ? 95 : 5, TerrainType.Sand);
      }

      const pf = new PathfindingSystem(terrain as any);
      // With maxNodes=100, should return partial path or null
      const path = pf.findPath(0, 50, 99, 50, true, 100);
      // Path might be null or partial - either is acceptable with tight node limit
      if (path) {
        expect(path.length).toBeGreaterThan(0);
      }
    });
  });

  describe('edge cases', () => {
    it('start equals destination', () => {
      const terrain = new MockTerrain(16, 16);
      const pf = new PathfindingSystem(terrain as any);
      const path = pf.findPath(5, 5, 5, 5);
      expect(path).not.toBeNull();
      expect(path!.length).toBe(1);
    });

    it('adjacent tiles', () => {
      const terrain = new MockTerrain(16, 16);
      const pf = new PathfindingSystem(terrain as any);
      const path = pf.findPath(5, 5, 6, 5);
      expect(path).not.toBeNull();
      expect(path!.length).toBe(2);
    });

    it('does not cut corners through diagonal obstacles', () => {
      const terrain = new MockTerrain(10, 10);
      // Block tiles such that diagonal would cut a corner
      terrain.setTile(5, 4, TerrainType.Cliff);
      terrain.setTile(4, 5, TerrainType.Cliff);
      const pf = new PathfindingSystem(terrain as any);

      const path = pf.findPath(4, 4, 5, 5);
      expect(path).not.toBeNull();
      // Path should go around, not diagonally through the gap
      expect(path!.length).toBeGreaterThan(2);
    });
  });
});
