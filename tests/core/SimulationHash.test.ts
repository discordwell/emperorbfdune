import { describe, it, expect } from 'vitest';
import { SimulationHashTracker } from '../../src/core/SimulationHash';

describe('SimulationHashTracker', () => {
  it('records and retrieves hashes', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 0xDEADBEEF);
    tracker.record(50, 0xCAFEBABE);

    expect(tracker.getHash(25)).toBe(0xDEADBEEF);
    expect(tracker.getHash(50)).toBe(0xCAFEBABE);
    expect(tracker.getHash(75)).toBeNull();
  });

  it('returns null for unrecorded ticks', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 0x12345678);
    expect(tracker.getHash(10)).toBeNull(); // Not recorded
    expect(tracker.getHash(25)).toBe(0x12345678);
  });

  it('handles non-contiguous tick numbers (every 25 ticks)', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(0, 100);
    tracker.record(25, 200);
    tracker.record(50, 300);

    expect(tracker.getHash(0)).toBe(100);
    expect(tracker.getHash(25)).toBe(200);
    expect(tracker.getHash(50)).toBe(300);
    expect(tracker.getHash(1)).toBeNull(); // Not a recorded tick
    expect(tracker.getHash(26)).toBeNull();
  });

  it('evicts old entries beyond maxAge', () => {
    const tracker = new SimulationHashTracker(100); // maxAge=100 ticks
    tracker.record(0, 100);
    tracker.record(25, 200);
    tracker.record(50, 300);
    tracker.record(75, 400);
    tracker.record(100, 500); // Tick 0 should be evicted (100 - 0 >= 100)

    expect(tracker.getHash(0)).toBeNull(); // Evicted
    expect(tracker.getHash(100)).toBe(500);
  });

  it('verifies matching hashes', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 0xABCD);

    expect(tracker.verify(25, 0xABCD)).toBe('match');
    expect(tracker.verify(25, 0x1234)).toBe('mismatch');
    expect(tracker.verify(99, 0xABCD)).toBe('unavailable');
  });

  it('tracks latest tick', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 100);
    expect(tracker.getLatestTick()).toBe(25);
    tracker.record(50, 200);
    expect(tracker.getLatestTick()).toBe(50);
  });

  it('resets cleanly', () => {
    const tracker = new SimulationHashTracker(1000);
    tracker.record(25, 0xABCD);
    tracker.reset();
    expect(tracker.getHash(25)).toBeNull();
  });
});
