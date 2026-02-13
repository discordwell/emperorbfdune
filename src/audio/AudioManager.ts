import { EventBus } from '../core/EventBus';

interface TrackInfo {
  name: string;
  path: string;
  faction: string; // AT, HK, OR, IN (menu/score)
}

const MUSIC_TRACKS: TrackInfo[] = [
  { name: 'The War Begins', path: '/assets/audio/music/(AT01)The_War_Begins.mp3', faction: 'AT' },
  { name: 'Ride the Worm', path: '/assets/audio/music/(AT07)Ride_the_Worm.mp3', faction: 'AT' },
  { name: 'The Machine', path: '/assets/audio/music/(HK01)The_Machine.mp3', faction: 'HK' },
  { name: 'Legacy', path: '/assets/audio/music/(HK05)Legacy.mp3', faction: 'HK' },
  { name: 'Not an Option', path: '/assets/audio/music/(OR01)Not_an_Option.mp3', faction: 'OR' },
  { name: 'A Plan of Attack', path: '/assets/audio/music/(OR09)A_Plan_of_Attack.mp3', faction: 'OR' },
  { name: 'Menu', path: '/assets/audio/music/IN_Menu.mp3', faction: 'IN' },
  { name: 'Score', path: '/assets/audio/music/IN_Score.mp3', faction: 'IN' },
];

// Synthesized SFX using Web Audio API (no external files needed)
type SfxType = 'select' | 'move' | 'attack' | 'explosion' | 'build' | 'sell' | 'error' | 'victory' | 'defeat' | 'harvest' | 'shot' | 'powerlow';

export class AudioManager {
  private audioContext: AudioContext | null = null;
  private musicElement: HTMLAudioElement | null = null;
  private currentTrackIndex = -1;
  private musicVolume = 0.3;
  private sfxVolume = 0.5;
  private muted = false;
  private lastShotTime = 0;
  private playerFaction = 'AT';
  private musicStarted = false;

  constructor() {
    this.setupEventListeners();
    this.setupKeyboardControls();
  }

  private getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  setPlayerFaction(faction: string): void {
    this.playerFaction = faction;
  }

  private setupEventListeners(): void {
    EventBus.on('unit:selected', () => this.playSfx('select'));
    EventBus.on('unit:move', () => this.playSfx('move'));
    EventBus.on('unit:attack', () => this.playSfx('attack'));
    EventBus.on('unit:died', () => this.playSfx('explosion'));
    EventBus.on('production:complete', () => this.playSfx('build'));
    EventBus.on('harvest:delivered', () => this.playSfx('harvest'));
    EventBus.on('combat:fire', () => {
      const now = Date.now();
      if (now - this.lastShotTime > 100) { // Max 10 shot sounds/sec
        this.lastShotTime = now;
        this.playSfx('shot');
      }
    });

    // Start music on first user interaction
    const startMusic = () => {
      if (!this.musicStarted) {
        this.musicStarted = true;
        this.playNextTrack();
      }
      document.removeEventListener('click', startMusic);
      document.removeEventListener('keydown', startMusic);
    };
    document.addEventListener('click', startMusic);
    document.addEventListener('keydown', startMusic);
  }

  private setupKeyboardControls(): void {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'm' && !e.ctrlKey && !e.altKey) {
        this.toggleMute();
      }
    });
  }

  // --- Music ---

  private getPlaylist(): TrackInfo[] {
    // Prefer player faction tracks, then mix in others
    const factionTracks = MUSIC_TRACKS.filter(t => t.faction === this.playerFaction);
    const otherTracks = MUSIC_TRACKS.filter(t => t.faction !== 'IN' && t.faction !== this.playerFaction);
    return [...factionTracks, ...otherTracks];
  }

  private playNextTrack(): void {
    const playlist = this.getPlaylist();
    if (playlist.length === 0) return;

    this.currentTrackIndex = (this.currentTrackIndex + 1) % playlist.length;
    const track = playlist[this.currentTrackIndex];

    if (this.musicElement) {
      this.musicElement.pause();
      this.musicElement.removeEventListener('ended', this.onTrackEnded);
    }

    this.musicElement = new Audio(track.path);
    this.musicElement.volume = this.muted ? 0 : this.musicVolume;
    this.musicElement.addEventListener('ended', this.onTrackEnded);
    this.musicElement.play().catch(() => {
      // Autoplay blocked — will retry on next user interaction
    });
  }

  private onTrackEnded = (): void => {
    this.playNextTrack();
  };

  playMenuMusic(): void {
    const menu = MUSIC_TRACKS.find(t => t.faction === 'IN' && t.name === 'Menu');
    if (!menu) return;

    if (this.musicElement) {
      this.musicElement.pause();
      this.musicElement.removeEventListener('ended', this.onTrackEnded);
    }

    this.musicElement = new Audio(menu.path);
    this.musicElement.volume = this.muted ? 0 : this.musicVolume;
    this.musicElement.loop = true;
    this.musicElement.play().catch(() => {});
    this.musicStarted = true;
  }

  playVictoryMusic(): void {
    const score = MUSIC_TRACKS.find(t => t.name === 'Score');
    if (!score) return;

    if (this.musicElement) {
      this.musicElement.pause();
      this.musicElement.removeEventListener('ended', this.onTrackEnded);
    }

    this.musicElement = new Audio(score.path);
    this.musicElement.volume = this.muted ? 0 : this.musicVolume;
    this.musicElement.play().catch(() => {});
  }

  startGameMusic(): void {
    this.musicStarted = true;
    this.currentTrackIndex = -1;
    this.playNextTrack();
  }

  // --- SFX (synthesized) ---

  playSfx(type: SfxType): void {
    if (this.muted) return;

    try {
      const ctx = this.getContext();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      switch (type) {
        case 'select': this.synthSelect(ctx); break;
        case 'move': this.synthMove(ctx); break;
        case 'attack': this.synthAttack(ctx); break;
        case 'explosion': this.synthExplosion(ctx); break;
        case 'build': this.synthBuild(ctx); break;
        case 'sell': this.synthSell(ctx); break;
        case 'error': this.synthError(ctx); break;
        case 'victory': this.synthVictory(ctx); break;
        case 'defeat': this.synthDefeat(ctx); break;
        case 'harvest': this.synthHarvest(ctx); break;
        case 'shot': this.synthShot(ctx); break;
        case 'powerlow': this.synthPowerLow(ctx); break;
      }
    } catch {
      // Audio not available
    }
  }

  private makeGain(ctx: AudioContext, volume: number): GainNode {
    const gain = ctx.createGain();
    gain.gain.value = volume * this.sfxVolume;
    gain.connect(ctx.destination);
    return gain;
  }

  private synthSelect(ctx: AudioContext): void {
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.15);
    const p = this.randPitch();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800 * p, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1200 * p, ctx.currentTime + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
  }

  private synthMove(ctx: AudioContext): void {
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.12);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12);
  }

  private synthAttack(ctx: AudioContext): void {
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.2);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  }

  private synthExplosion(ctx: AudioContext): void {
    // White noise burst
    const bufferSize = ctx.sampleRate * 0.3;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.makeGain(ctx, 0.25);
    // Low-pass filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.3);
    source.connect(filter);
    filter.connect(gain);
    source.start(ctx.currentTime);
  }

  private synthBuild(ctx: AudioContext): void {
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.1);
      osc.type = 'sine';
      osc.frequency.value = 400 + i * 200;
      gain.gain.setValueAtTime(0.1 * this.sfxVolume, t + i * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.15);
      osc.connect(gain);
      osc.start(t + i * 0.1);
      osc.stop(t + i * 0.1 + 0.15);
    }
  }

  private synthSell(ctx: AudioContext): void {
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.15);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1000, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
  }

  private synthError(ctx: AudioContext): void {
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.2);
    osc.type = 'square';
    osc.frequency.setValueAtTime(200, ctx.currentTime);
    osc.frequency.setValueAtTime(150, ctx.currentTime + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  }

  private synthVictory(ctx: AudioContext): void {
    const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
    const t = ctx.currentTime;
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.15);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15 * this.sfxVolume, t + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.4);
      osc.connect(gain);
      osc.start(t + i * 0.15);
      osc.stop(t + i * 0.15 + 0.4);
    });
  }

  private synthDefeat(ctx: AudioContext): void {
    const notes = [400, 350, 300, 200]; // Descending
    const t = ctx.currentTime;
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.15);
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15 * this.sfxVolume, t + i * 0.2);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.2 + 0.5);
      osc.connect(gain);
      osc.start(t + i * 0.2);
      osc.stop(t + i * 0.2 + 0.5);
    });
  }

  // Pitch randomization factor (0.9 - 1.1)
  private randPitch(): number {
    return 0.9 + Math.random() * 0.2;
  }

  private synthHarvest(ctx: AudioContext): void {
    // Cash register sound - ascending ding
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.12);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(500 * this.randPitch(), t);
    osc.frequency.exponentialRampToValueAtTime(1500, t + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  private synthShot(ctx: AudioContext): void {
    // Quick pop — randomized pitch for variety
    const t = ctx.currentTime;
    const baseFreq = 300 * this.randPitch();
    const bufferSize = ctx.sampleRate * 0.05;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3));
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.makeGain(ctx, 0.06);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = baseFreq;
    filter.Q.value = 2;
    source.connect(filter);
    filter.connect(gain);
    source.start(t);
  }

  private synthPowerLow(ctx: AudioContext): void {
    // Warning beep — two descending tones
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.15);
      osc.type = 'square';
      osc.frequency.value = 500 - i * 100;
      gain.gain.setValueAtTime(0.15 * this.sfxVolume, t + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.1);
      osc.connect(gain);
      osc.start(t + i * 0.15);
      osc.stop(t + i * 0.15 + 0.12);
    }
  }

  // --- Controls ---

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.musicElement) {
      this.musicElement.volume = this.muted ? 0 : this.musicVolume;
    }
  }

  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.musicElement && !this.muted) {
      this.musicElement.volume = this.musicVolume;
    }
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
  }

  isMuted(): boolean {
    return this.muted;
  }

  stopAll(): void {
    if (this.musicElement) {
      this.musicElement.pause();
      this.musicElement.removeEventListener('ended', this.onTrackEnded);
      this.musicElement = null;
    }
  }
}
