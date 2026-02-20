import { describe, it, expect } from 'vitest';
import { DeterministicRNG } from '../../src/utils/DeterministicRNG';

describe('DeterministicRNG', () => {
  it('produces deterministic sequences from same seed', () => {
    const rng1 = new DeterministicRNG(42);
    const rng2 = new DeterministicRNG(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1.random()).toBe(rng2.random());
    }
  });

  it('produces different sequences from different seeds', () => {
    const rng1 = new DeterministicRNG(42);
    const rng2 = new DeterministicRNG(99);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (rng1.random() === rng2.random()) same++;
    }
    expect(same).toBeLessThan(5); // Extremely unlikely to collide often
  });

  it('random() returns values in [0, 1)', () => {
    const rng = new DeterministicRNG(123);
    for (let i = 0; i < 1000; i++) {
      const v = rng.random();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int() returns values in [min, max] inclusive', () => {
    const rng = new DeterministicRNG(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = rng.int(1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    // Should see all 6 values in 500 trials
    expect(seen.size).toBe(6);
  });

  it('float() returns values in [min, max)', () => {
    const rng = new DeterministicRNG(5);
    for (let i = 0; i < 500; i++) {
      const v = rng.float(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThan(20);
    }
  });

  it('chance() returns booleans', () => {
    const rng = new DeterministicRNG(1);
    let trueCount = 0;
    for (let i = 0; i < 1000; i++) {
      if (rng.chance(0.5)) trueCount++;
    }
    // Should be roughly 50% (with some tolerance)
    expect(trueCount).toBeGreaterThan(400);
    expect(trueCount).toBeLessThan(600);
  });

  it('pick() selects from array', () => {
    const rng = new DeterministicRNG(3);
    const arr = ['a', 'b', 'c', 'd'];
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(rng.pick(arr));
    }
    expect(seen.size).toBe(4);
  });

  it('state save/restore produces identical sequences', () => {
    const rng = new DeterministicRNG(42);
    // Advance a few steps
    for (let i = 0; i < 50; i++) rng.random();

    const state = rng.getState();
    const seq1: number[] = [];
    for (let i = 0; i < 20; i++) seq1.push(rng.random());

    // Restore and replay
    rng.setState(state);
    const seq2: number[] = [];
    for (let i = 0; i < 20; i++) seq2.push(rng.random());

    expect(seq1).toEqual(seq2);
  });

  it('reseed() resets the sequence', () => {
    const rng = new DeterministicRNG(42);
    const seq1: number[] = [];
    for (let i = 0; i < 10; i++) seq1.push(rng.random());

    rng.reseed(42);
    const seq2: number[] = [];
    for (let i = 0; i < 10; i++) seq2.push(rng.random());

    expect(seq1).toEqual(seq2);
  });

  it('has uniform distribution', () => {
    const rng = new DeterministicRNG(777);
    const buckets = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const n = 10000;
    for (let i = 0; i < n; i++) {
      const v = rng.random();
      const bucket = Math.min(9, Math.floor(v * 10));
      buckets[bucket]++;
    }
    // Each bucket should have ~1000 +/- 200
    for (const count of buckets) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });
});
