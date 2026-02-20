/**
 * Deterministic PRNG using xoshiro128** algorithm.
 * Same seed = same sequence across all browsers.
 * Used for all simulation randomness to enable multiplayer lockstep and replays.
 */

export class DeterministicRNG {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number = 1) {
    // Initialize state via SplitMix32 to properly spread the seed
    let s = seed | 0;
    const sm = () => {
      s = (s + 0x9e3779b9) | 0;
      let t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      return t >>> 0;
    };
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
  }

  /** Returns a float in [0, 1) — drop-in replacement for Math.random() */
  random(): number {
    const result = this.nextU32();
    return (result >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  /** Returns a float in [min, max) */
  float(min: number, max: number): number {
    return min + this.random() * (max - min);
  }

  /** Returns true with the given probability [0, 1] */
  chance(probability: number): boolean {
    return this.random() < probability;
  }

  /** Pick a random element from an array */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.random() * arr.length)];
  }

  /** Re-initialize with a new seed */
  reseed(seed: number): void {
    let s = seed | 0;
    const sm = () => {
      s = (s + 0x9e3779b9) | 0;
      let t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      return t >>> 0;
    };
    this.s0 = sm();
    this.s1 = sm();
    this.s2 = sm();
    this.s3 = sm();
  }

  /** Get current state for serialization (save/load) */
  getState(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  /** Restore state from serialization */
  setState(state: [number, number, number, number]): void {
    [this.s0, this.s1, this.s2, this.s3] = state;
  }

  /** xoshiro128** core — mirrors reference C implementation with in-place state updates */
  private nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9);
    const t = this.s1 << 9;

    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);

    return result >>> 0;
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/**
 * Global simulation RNG instance.
 * All simulation code should use this instead of Math.random().
 * Re-seed at game start for deterministic replays.
 */
export const simRng = new DeterministicRNG(42);
