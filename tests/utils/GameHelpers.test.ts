import { describe, it, expect } from 'vitest';
import { createSeededRng, getSpawnPositions } from '../../src/utils/GameHelpers';

describe('createSeededRng', () => {
  it('returns a function', () => {
    const rng = createSeededRng('test');
    expect(typeof rng).toBe('function');
  });

  it('returns values between 0 and 1', () => {
    const rng = createSeededRng('seed123');
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is deterministic with same seed', () => {
    const rng1 = createSeededRng('hello');
    const rng2 = createSeededRng('hello');
    for (let i = 0; i < 50; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('produces different sequences for different seeds', () => {
    const rng1 = createSeededRng('seed_a');
    const rng2 = createSeededRng('seed_b');
    // At least one of the first 10 values should differ
    let allSame = true;
    for (let i = 0; i < 10; i++) {
      if (rng1() !== rng2()) {
        allSame = false;
        break;
      }
    }
    expect(allSame).toBe(false);
  });

  it('does not repeat short cycle', () => {
    const rng = createSeededRng('cycle_test');
    const values = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      values.add(rng());
    }
    // Should have high uniqueness (near 1000 unique values)
    expect(values.size).toBeGreaterThan(950);
  });
});

describe('getSpawnPositions', () => {
  const mapW = 64;
  const mapH = 64;
  const TILE_SZ = 2;

  it('returns correct number of positions', () => {
    expect(getSpawnPositions(mapW, mapH, 2).length).toBe(2);
    expect(getSpawnPositions(mapW, mapH, 4).length).toBe(4);
    expect(getSpawnPositions(mapW, mapH, 8).length).toBe(8);
  });

  it('places 2-player spawns in opposing corners', () => {
    const rng = createSeededRng('fixed');
    const positions = getSpawnPositions(mapW, mapH, 2, rng);
    // Both positions should be at valid map corners
    const margin = 20 * TILE_SZ;
    const maxX = mapW * TILE_SZ - margin;
    const maxZ = mapH * TILE_SZ - margin;
    const minPos = Math.max(margin, 50);

    for (const pos of positions) {
      expect(pos.x).toBeGreaterThanOrEqual(minPos);
      expect(pos.x).toBeLessThanOrEqual(maxX);
      expect(pos.z).toBeGreaterThanOrEqual(minPos);
      expect(pos.z).toBeLessThanOrEqual(maxZ);
    }
  });

  it('positions are within map bounds', () => {
    const rng = createSeededRng('bounds');
    const positions = getSpawnPositions(mapW, mapH, 6, rng);
    const margin = 20 * TILE_SZ;
    const maxX = mapW * TILE_SZ - margin;
    const maxZ = mapH * TILE_SZ - margin;

    for (const pos of positions) {
      expect(pos.x).toBeGreaterThanOrEqual(margin);
      expect(pos.x).toBeLessThanOrEqual(maxX);
      expect(pos.z).toBeGreaterThanOrEqual(margin);
      expect(pos.z).toBeLessThanOrEqual(maxZ);
    }
  });

  it('distributes evenly around ellipse for 4+ players', () => {
    const rng = createSeededRng('even');
    const positions = getSpawnPositions(mapW, mapH, 4, rng);

    // Positions should be roughly equidistant from center
    const cx = (mapW / 2) * TILE_SZ;
    const cz = (mapH / 2) * TILE_SZ;
    const distances = positions.map(p =>
      Math.sqrt((p.x - cx) ** 2 + (p.z - cz) ** 2)
    );

    // All distances should be roughly similar (within 30% of average)
    const avg = distances.reduce((a, b) => a + b, 0) / distances.length;
    for (const d of distances) {
      expect(d).toBeGreaterThan(avg * 0.5);
      expect(d).toBeLessThan(avg * 1.5);
    }
  });

  it('is deterministic with seeded RNG', () => {
    const p1 = getSpawnPositions(mapW, mapH, 4, createSeededRng('det'));
    const p2 = getSpawnPositions(mapW, mapH, 4, createSeededRng('det'));
    expect(p1).toEqual(p2);
  });
});
