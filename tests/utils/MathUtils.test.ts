import { describe, it, expect } from 'vitest';
import {
  TILE_SIZE, tileToWorld, worldToTile, distance2D, distanceSq2D,
  angleBetween, lerpAngle, lerp, clamp, randomInt, randomFloat,
} from '../../src/utils/MathUtils';

describe('TILE_SIZE', () => {
  it('equals 2', () => {
    expect(TILE_SIZE).toBe(2);
  });
});

describe('tileToWorld', () => {
  it('converts tile (0,0) to world (0,0)', () => {
    expect(tileToWorld(0, 0)).toEqual({ x: 0, z: 0 });
  });

  it('converts tile (5,3) to world (10,6)', () => {
    expect(tileToWorld(5, 3)).toEqual({ x: 10, z: 6 });
  });

  it('handles negative tiles', () => {
    expect(tileToWorld(-1, -2)).toEqual({ x: -2, z: -4 });
  });
});

describe('worldToTile', () => {
  it('converts world (0,0) to tile (0,0)', () => {
    expect(worldToTile(0, 0)).toEqual({ tx: 0, tz: 0 });
  });

  it('converts world (10,6) to tile (5,3)', () => {
    expect(worldToTile(10, 6)).toEqual({ tx: 5, tz: 3 });
  });

  it('floors fractional coordinates', () => {
    expect(worldToTile(3.5, 5.9)).toEqual({ tx: 1, tz: 2 });
  });

  it('handles negative world coords', () => {
    expect(worldToTile(-1, -3)).toEqual({ tx: -1, tz: -2 });
  });
});

describe('distance2D', () => {
  it('returns 0 for same point', () => {
    expect(distance2D(5, 5, 5, 5)).toBe(0);
  });

  it('calculates horizontal distance', () => {
    expect(distance2D(0, 0, 3, 0)).toBe(3);
  });

  it('calculates vertical distance', () => {
    expect(distance2D(0, 0, 0, 4)).toBe(4);
  });

  it('calculates diagonal (3-4-5 triangle)', () => {
    expect(distance2D(0, 0, 3, 4)).toBe(5);
  });
});

describe('distanceSq2D', () => {
  it('returns squared distance', () => {
    expect(distanceSq2D(0, 0, 3, 4)).toBe(25);
  });

  it('returns 0 for same point', () => {
    expect(distanceSq2D(1, 1, 1, 1)).toBe(0);
  });
});

describe('angleBetween', () => {
  it('returns 0 for due north (positive Z)', () => {
    expect(angleBetween(0, 0, 0, 1)).toBeCloseTo(0, 5);
  });

  it('returns PI/2 for due east (positive X)', () => {
    expect(angleBetween(0, 0, 1, 0)).toBeCloseTo(Math.PI / 2, 5);
  });

  it('returns PI for due south', () => {
    expect(angleBetween(0, 0, 0, -1)).toBeCloseTo(Math.PI, 5);
  });
});

describe('lerpAngle', () => {
  it('interpolates angles correctly', () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 5);
  });

  it('wraps around PI boundary', () => {
    const result = lerpAngle(Math.PI * 0.9, -Math.PI * 0.9, 0.5);
    expect(Math.abs(result)).toBeCloseTo(Math.PI, 1);
  });

  it('returns start at t=0', () => {
    expect(lerpAngle(1, 2, 0)).toBeCloseTo(1, 5);
  });

  it('returns end at t=1', () => {
    expect(lerpAngle(1, 2, 1)).toBeCloseTo(2, 5);
  });
});

describe('lerp', () => {
  it('returns start at t=0', () => {
    expect(lerp(10, 20, 0)).toBe(10);
  });

  it('returns end at t=1', () => {
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it('returns midpoint at t=0.5', () => {
    expect(lerp(0, 100, 0.5)).toBe(50);
  });

  it('extrapolates beyond 0-1', () => {
    expect(lerp(0, 10, 2)).toBe(20);
  });
});

describe('clamp', () => {
  it('returns value when in range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to min', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('clamps to max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('handles equal min and max', () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});

describe('randomInt', () => {
  it('returns values within range', () => {
    for (let i = 0; i < 100; i++) {
      const v = randomInt(0, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(5);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('returns exact value when min equals max', () => {
    expect(randomInt(7, 7)).toBe(7);
  });
});

describe('randomFloat', () => {
  it('returns values within range', () => {
    for (let i = 0; i < 100; i++) {
      const v = randomFloat(1.0, 2.0);
      expect(v).toBeGreaterThanOrEqual(1.0);
      expect(v).toBeLessThan(2.0);
    }
  });
});
