import { describe, it, expect, beforeEach } from 'vitest';
import { SpatialGrid } from '../../src/utils/SpatialGrid';

describe('SpatialGrid', () => {
  let grid: SpatialGrid;

  beforeEach(() => {
    grid = new SpatialGrid(10); // 10-unit cells
  });

  describe('insert and getNearby', () => {
    it('returns empty array when grid is empty', () => {
      expect(grid.getNearby(0, 0)).toEqual([]);
    });

    it('finds entity in same cell', () => {
      grid.insert(1, 5, 5);
      const nearby = grid.getNearby(5, 5);
      expect(nearby).toContain(1);
    });

    it('finds entity in adjacent cell', () => {
      grid.insert(1, 15, 15); // cell (1,1)
      const nearby = grid.getNearby(5, 5); // cell (0,0), should check 3x3 around it
      expect(nearby).toContain(1);
    });

    it('does not find entity 2+ cells away', () => {
      grid.insert(1, 25, 25); // cell (2,2)
      const nearby = grid.getNearby(0, 0); // cell (0,0)
      expect(nearby).not.toContain(1);
    });

    it('finds multiple entities', () => {
      grid.insert(1, 5, 5);
      grid.insert(2, 7, 7);
      grid.insert(3, 3, 3);
      const nearby = grid.getNearby(5, 5);
      expect(nearby).toContain(1);
      expect(nearby).toContain(2);
      expect(nearby).toContain(3);
    });
  });

  describe('getInRadius', () => {
    it('returns empty for empty grid', () => {
      expect(grid.getInRadius(0, 0, 100)).toEqual([]);
    });

    it('finds entities within radius', () => {
      grid.insert(1, 0, 0);
      grid.insert(2, 5, 5);
      grid.insert(3, 50, 50);

      const result = grid.getInRadius(0, 0, 20);
      expect(result).toContain(1);
      expect(result).toContain(2);
      // Entity 3 is far away - whether it's included depends on cell span
      // At radius=20, cellSpan=ceil(20/10)=2, so checks cells -2..+2 which covers cell (5,5)
    });

    it('returns all entities for large radius', () => {
      grid.insert(1, 0, 0);
      grid.insert(2, 100, 100);
      const result = grid.getInRadius(50, 50, 200);
      expect(result).toContain(1);
      expect(result).toContain(2);
    });
  });

  describe('clear', () => {
    it('removes all entities', () => {
      grid.insert(1, 5, 5);
      grid.insert(2, 15, 15);
      grid.clear();
      expect(grid.getNearby(5, 5)).toEqual([]);
      expect(grid.getNearby(15, 15)).toEqual([]);
    });
  });

  describe('result array reuse', () => {
    it('reuses the same array reference for getNearby', () => {
      grid.insert(1, 5, 5);
      const a = grid.getNearby(5, 5);
      const b = grid.getNearby(5, 5);
      expect(a).toBe(b); // same array object
    });

    it('reuses the same array reference for getInRadius', () => {
      grid.insert(1, 5, 5);
      const a = grid.getInRadius(5, 5, 10);
      const b = grid.getInRadius(5, 5, 10);
      expect(a).toBe(b);
    });
  });

  describe('negative coordinates', () => {
    it('handles negative positions', () => {
      grid.insert(42, -5, -5);
      const nearby = grid.getNearby(-3, -3);
      expect(nearby).toContain(42);
    });
  });
});
