/**
 * SampleBank - Loads and plays sampled audio (OGG files) via Web Audio API.
 * Provides caching, batch preloading, pitch/volume variation, and cooldown.
 */
export class SampleBank {
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  private ctx: AudioContext;
  private masterGain: GainNode;

  constructor(ctx: AudioContext, destination?: AudioNode) {
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.masterGain.connect(destination ?? ctx.destination);
  }

  /** Set master volume for all sample playback (0-1). */
  setVolume(v: number): void {
    this.masterGain.gain.value = Math.max(0, Math.min(1, v));
  }

  /**
   * Batch-preload a list of audio file paths.
   * Failures are silently ignored so missing files don't break the game.
   */
  async preload(paths: string[]): Promise<void> {
    await Promise.all(paths.map(p => this.load(p)));
  }

  /**
   * Load a single audio file and cache the decoded AudioBuffer.
   * Returns null on failure (network error, decode error, etc.).
   */
  async load(path: string): Promise<AudioBuffer | null> {
    // Already decoded
    if (this.buffers.has(path)) {
      return this.buffers.get(path)!;
    }
    // Already in-flight
    if (this.loading.has(path)) {
      return this.loading.get(path)!;
    }

    const promise = this.fetchAndDecode(path);
    this.loading.set(path, promise);
    const buffer = await promise;
    this.loading.delete(path);

    if (buffer) {
      this.buffers.set(path, buffer);
    }
    return buffer;
  }

  private async fetchAndDecode(path: string): Promise<AudioBuffer | null> {
    try {
      const response = await fetch(path);
      if (!response.ok) return null;
      const arrayBuffer = await response.arrayBuffer();
      return await this.ctx.decodeAudioData(arrayBuffer);
    } catch {
      // Network or decode error - silently fail
      return null;
    }
  }

  /**
   * Play a cached sample immediately.
   * If the sample isn't loaded yet, the call is silently skipped (no blocking).
   *
   * @param path - The file path (must have been preloaded)
   * @param volume - Base volume (0-1), applied on top of masterGain
   * @param pitchVariation - If true, randomize playback rate +/-5%
   */
  play(path: string, volume: number, pitchVariation?: boolean): void {
    const buffer = this.buffers.get(path);
    if (!buffer) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    // Pitch variation: +/- 5%
    if (pitchVariation) {
      source.playbackRate.value = 0.95 + Math.random() * 0.1;
    }

    // Volume randomization: +/- 10% of the requested volume
    const volVariation = volume * (0.9 + Math.random() * 0.2);
    const gain = this.ctx.createGain();
    gain.gain.value = volVariation;
    source.connect(gain);
    gain.connect(this.masterGain);

    // Disconnect nodes after playback to prevent audio graph leak
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };

    source.start(0);
  }

  /** Check if a given path has been loaded and cached. */
  has(path: string): boolean {
    return this.buffers.has(path);
  }

  /** Get the raw AudioBuffer for a loaded sample (or null if not loaded). */
  getBuffer(path: string): AudioBuffer | null {
    return this.buffers.get(path) ?? null;
  }
}
