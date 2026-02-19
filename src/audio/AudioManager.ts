import { EventBus } from '../core/EventBus';
import { SampleBank } from './SampleBank';
import { VoiceManager } from './VoiceManager';
import { DialogManager } from './DialogManager';
import { SFX_MANIFEST, getPrioritySamplePaths } from './SfxManifest';
import type { GameRules } from '../config/RulesParser';

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
type SfxType = 'select' | 'move' | 'attack' | 'explosion' | 'build' | 'sell' | 'error' | 'victory' | 'defeat' | 'harvest' | 'shot' | 'powerlow' | 'place' | 'worm' | 'underattack' | 'deathInfantry' | 'deathVehicle' | 'deathBuilding' | 'superweaponReady' | 'superweaponLaunch';

export type UnitCategory = 'infantry' | 'vehicle' | 'harvester';

export class AudioManager {
  private audioContext: AudioContext | null = null;
  private musicElement: HTMLAudioElement | null = null;
  private fadingOutElement: HTMLAudioElement | null = null;
  private currentTrackIndex = -1;
  private musicVolume = 0.3;
  private sfxVolume = 0.5;
  private muted = false;
  private lastShotTime = 0;
  private playerFaction = 'AT';
  private musicStarted = false;
  private unitClassifier: ((eid: number) => UnitCategory) | null = null;
  private buildingChecker: ((eid: number) => boolean) | null = null;
  private crossfadeDuration = 2000; // ms
  private crossfadeTimer: ReturnType<typeof setInterval> | null = null;
  private combatIntensity = 0; // 0-1
  private lastCombatEvent = 0;
  private sampleBank: SampleBank | null = null;
  private voiceManager: VoiceManager | null = null;
  private dialogManager: DialogManager | null = null;
  private sfxCooldowns = new Map<string, number>(); // SfxType -> last play timestamp
  private samplesPreloaded = false;
  private unitTypeResolver: ((eid: number) => string) | null = null;
  // Camera position for positional audio
  private listenerX = 55;
  private listenerZ = 55;
  private maxAudioRange = 60; // World units beyond which sounds are silent
  // Ambient wind
  private windNode: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windLfo: OscillatorNode | null = null;
  private windLfoGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windActive = false;

  constructor() {
    this.setupEventListeners();
    this.setupKeyboardControls();
  }

  private getContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    // Lazily create SampleBank when AudioContext first becomes available
    if (!this.sampleBank && this.audioContext) {
      this.sampleBank = new SampleBank(this.audioContext);
      this.sampleBank.setVolume(this.sfxVolume);
    }
    return this.audioContext;
  }

  /**
   * Preload priority SFX samples. Call during loading screen phase.
   * Safe to call multiple times; only loads once.
   */
  async preloadSfx(): Promise<void> {
    if (this.samplesPreloaded) return;
    this.samplesPreloaded = true;
    const ctx = this.getContext();
    if (ctx.state === 'suspended') {
      // Don't block - samples will be loaded once context resumes
      ctx.resume().catch(() => {});
    }
    if (this.sampleBank) {
      const paths = getPrioritySamplePaths();
      console.log(`[AudioManager] Preloading ${paths.length} priority SFX samples...`);
      await this.sampleBank.preload(paths);
      console.log(`[AudioManager] SFX preload complete.`);
    }
  }

  setPlayerFaction(faction: string): void {
    this.playerFaction = faction;
    this.currentTrackIndex = -1;
  }

  setUnitClassifier(fn: (eid: number) => UnitCategory): void {
    this.unitClassifier = fn;
  }

  setBuildingChecker(fn: (eid: number) => boolean): void {
    this.buildingChecker = fn;
  }

  /**
   * Set a function that resolves entity ID -> unit type name.
   * Required for voice line playback (to look up unit-specific voices).
   */
  setUnitTypeResolver(fn: (eid: number) => string): void {
    this.unitTypeResolver = fn;
  }

  /**
   * Initialize the voice system. Call after rules are parsed.
   * Creates the VoiceManager and builds the unit->soundId mapping.
   */
  initVoices(rules: GameRules): void {
    const ctx = this.getContext();
    if (this.sampleBank) {
      this.voiceManager = new VoiceManager(this.sampleBank);
      this.voiceManager.init(rules);
    }
  }

  /**
   * Preload voice files for a faction. Call after initVoices().
   */
  async preloadVoices(factionPrefix: string): Promise<void> {
    if (this.voiceManager) {
      await this.voiceManager.preloadFaction(factionPrefix);
    }
  }

  /**
   * Get the VoiceManager instance (if initialized).
   */
  getVoiceManager(): VoiceManager | null {
    return this.voiceManager;
  }

  /**
   * Initialize the dialog system. Creates the DialogManager using the shared SampleBank.
   * Call after the AudioContext is available (e.g., after preloadSfx).
   */
  initDialog(): void {
    this.getContext(); // Ensure SampleBank exists
    if (this.sampleBank && !this.dialogManager) {
      this.dialogManager = new DialogManager(this.sampleBank);
    }
  }

  /**
   * Preload dialog audio files. Call during loading screen phase after initDialog().
   */
  async preloadDialog(factionPrefix: string): Promise<void> {
    if (this.dialogManager) {
      this.dialogManager.setPlayerFaction(factionPrefix);
      await this.dialogManager.preload();
    }
  }

  /**
   * Get the DialogManager instance (if initialized).
   */
  getDialogManager(): DialogManager | null {
    return this.dialogManager;
  }

  private setupEventListeners(): void {
    // Unit selection: try voice line first, then category SFX
    EventBus.on('unit:selected', (data) => {
      if (data.entityIds.length > 0) {
        const eid = data.entityIds[0];
        // Try voice line
        if (this.tryPlayVoice(eid, 'select')) return;
        // Fall back to category SFX
        if (this.unitClassifier) {
          const cat = this.unitClassifier(eid);
          this.playUnitSfx('select', cat);
        } else {
          this.playSfx('select');
        }
      } else {
        this.playSfx('select');
      }
    });
    // unit:move and unit:attack handled by CommandManager direct calls
    EventBus.on('unit:died', ({ entityId }) => {
      // Buildings are handled by building:destroyed
      if (this.buildingChecker?.(entityId)) return;
      if (this.unitClassifier) {
        const cat = this.unitClassifier(entityId);
        if (cat === 'infantry') this.playSfx('deathInfantry');
        else this.playSfx('deathVehicle');
      } else {
        this.playSfx('explosion');
      }
      this.bumpCombatIntensity(0.15);
    });
    EventBus.on('production:complete', () => this.playSfx('build'));
    EventBus.on('harvest:delivered', () => this.playSfx('harvest'));
    EventBus.on('building:destroyed', () => {
      this.playSfx('deathBuilding');
      this.bumpCombatIntensity(0.25);
    });
    EventBus.on('combat:fire', ({ attackerX, attackerZ }: { attackerX: number; attackerZ: number }) => {
      const now = Date.now();
      if (now - this.lastShotTime > 100) { // Max 10 shot sounds/sec
        this.lastShotTime = now;
        if (attackerX !== undefined && attackerZ !== undefined) {
          this.playSfxAt('shot', attackerX, attackerZ);
        } else {
          this.playSfx('shot');
        }
      }
      this.bumpCombatIntensity(0.02);
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

    this.crossfadeTo(track.path, false);
  }

  private crossfadeTo(path: string, loop: boolean): void {
    const newElement = new Audio(path);
    newElement.volume = 0;
    newElement.loop = loop;
    if (!loop) newElement.addEventListener('ended', this.onTrackEnded);

    // Start fade out of old element
    const oldElement = this.musicElement;
    if (oldElement) {
      oldElement.removeEventListener('ended', this.onTrackEnded);
      this.fadingOutElement = oldElement;
    }

    this.musicElement = newElement;
    newElement.play().catch(() => {});

    if (this.crossfadeTimer) clearInterval(this.crossfadeTimer);

    const steps = 20;
    const interval = this.crossfadeDuration / steps;
    let step = 0;

    this.crossfadeTimer = setInterval(() => {
      step++;
      const progress = step / steps;
      const vol = this.muted ? 0 : this.musicVolume;

      // Fade in new
      newElement.volume = vol * progress;
      // Fade out old
      if (oldElement) {
        oldElement.volume = this.muted ? 0 : Math.max(0, vol * (1 - progress));
      }

      if (step >= steps) {
        if (this.crossfadeTimer) clearInterval(this.crossfadeTimer);
        this.crossfadeTimer = null;
        if (oldElement) {
          oldElement.pause();
          this.fadingOutElement = null;
        }
      }
    }, interval);
  }

  private onTrackEnded = (): void => {
    this.playNextTrack();
  };

  playMenuMusic(): void {
    const menu = MUSIC_TRACKS.find(t => t.faction === 'IN' && t.name === 'Menu');
    if (!menu) return;
    this.crossfadeTo(menu.path, true);
    this.musicStarted = true;
  }

  playVictoryMusic(): void {
    const score = MUSIC_TRACKS.find(t => t.name === 'Score');
    if (!score) return;
    this.crossfadeTo(score.path, false);
  }

  startGameMusic(): void {
    this.musicStarted = true;
    this.currentTrackIndex = -1;
    this.playNextTrack();
  }

  // --- SFX (sampled with synth fallback) ---

  playSfx(type: SfxType): void {
    if (this.muted) return;

    try {
      const ctx = this.getContext();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      // Try sampled audio first
      if (this.playSample(type)) return;

      // Fall back to synthesized SFX
      this.playSynthSfx(type, ctx);
    } catch {
      // Audio not available
    }
  }

  /**
   * Attempt to play a sampled SFX. Returns true if a sample was played,
   * false if we should fall back to synth (no manifest entry, no loaded samples,
   * or on cooldown).
   */
  private playSample(type: string): boolean {
    const entry = SFX_MANIFEST[type];
    if (!entry || entry.paths.length === 0 || !this.sampleBank) return false;

    // Cooldown check
    if (entry.cooldown) {
      const now = Date.now();
      const lastPlay = this.sfxCooldowns.get(type) ?? 0;
      if (now - lastPlay < entry.cooldown) return true; // On cooldown -- suppress but don't fallback
      this.sfxCooldowns.set(type, now);
    }

    // Pick a random variant from the available paths
    const path = entry.paths[Math.floor(Math.random() * entry.paths.length)];

    // Only play if the sample is actually loaded
    if (!this.sampleBank.has(path)) return false;

    this.sampleBank.play(path, entry.volume, entry.pitchVariation);
    return true;
  }

  /** Route to the appropriate synth method. volumeScale attenuates for positional audio. */
  private _volumeScale = 1.0;
  private playSynthSfx(type: SfxType, ctx: AudioContext, volumeScale = 1.0): void {
    this._volumeScale = volumeScale;
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
      case 'place': this.synthPlace(ctx); break;
      case 'worm': this.synthWorm(ctx); break;
      case 'underattack': this.synthUnderAttack(ctx); break;
      case 'deathInfantry': this.synthDeathInfantry(ctx); break;
      case 'deathVehicle': this.synthDeathVehicle(ctx); break;
      case 'deathBuilding': this.synthDeathBuilding(ctx); break;
      case 'superweaponReady': this.synthSuperweaponReady(ctx); break;
      case 'superweaponLaunch': this.synthSuperweaponLaunch(ctx); break;
    }
    this._volumeScale = 1.0; // Reset after synth call
  }

  private makeGain(ctx: AudioContext, volume: number): GainNode {
    const gain = ctx.createGain();
    gain.gain.value = volume * this.sfxVolume * this._volumeScale;
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
    // Triumphant fanfare: C major arpeggio with harmonics + sustained chord
    const t = ctx.currentTime;
    const fanfare = [523, 659, 784, 1047, 1319]; // C5 E5 G5 C6 E6
    fanfare.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.12);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12 * this.sfxVolume, t + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.08 * this.sfxVolume, t + i * 0.12 + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.8);
      osc.connect(gain);
      osc.start(t + i * 0.12);
      osc.stop(t + i * 0.12 + 0.8);
    });
    // Sustained major chord
    [523, 659, 784].forEach(freq => {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.06);
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + 0.6);
      gain.gain.linearRampToValueAtTime(0.06 * this.sfxVolume, t + 0.8);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 2.5);
      osc.connect(gain);
      osc.start(t + 0.6);
      osc.stop(t + 2.5);
    });
  }

  private synthDefeat(ctx: AudioContext): void {
    // Ominous descending minor chord with slow decay
    const t = ctx.currentTime;
    const notes = [440, 370, 311, 233, 185]; // A4 F#4 Eb4 Bb3 F#3
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.12);
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.frequency.exponentialRampToValueAtTime(freq * 0.95, t + i * 0.25 + 0.8);
      gain.gain.setValueAtTime(0.12 * this.sfxVolume, t + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.25 + 1.0);
      osc.connect(gain);
      osc.start(t + i * 0.25);
      osc.stop(t + i * 0.25 + 1.0);
    });
    // Deep rumble undertone
    const rumble = ctx.createOscillator();
    const rumbleGain = this.makeGain(ctx, 0.08);
    rumble.type = 'sine';
    rumble.frequency.value = 50;
    rumbleGain.gain.exponentialRampToValueAtTime(0.001, t + 2.0);
    rumble.connect(rumbleGain);
    rumble.start(t);
    rumble.stop(t + 2.0);
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

  // --- Voice lines ---

  /**
   * Try to play a voice line for a specific entity. Returns true if a voice was played.
   * Falls back gracefully if the unit has no voices.
   */
  tryPlayVoice(entityId: number, action: 'select' | 'move' | 'attack'): boolean {
    if (this.muted || !this.voiceManager || !this.unitTypeResolver) return false;
    const typeName = this.unitTypeResolver(entityId);
    if (!typeName) return false;
    this.voiceManager.playVoice(typeName, action);
    // VoiceManager handles cooldown internally, but we consider it "played"
    // if a voice manager exists and the type name was resolved
    return this.voiceManager.hasVoice(typeName);
  }

  /**
   * Play voice line for a unit action, falling back to category SFX.
   * Used by CommandManager for move/attack commands.
   */
  playUnitVoiceOrSfx(action: 'select' | 'move' | 'attack', category: UnitCategory, entityId?: number): void {
    if (this.muted) return;
    // Try voice line first
    if (entityId !== undefined && this.tryPlayVoice(entityId, action)) return;
    // Fall back to category synth SFX
    this.playUnitSfx(action, category);
  }

  // --- Unit category-specific SFX ---

  playUnitSfx(action: 'select' | 'move' | 'attack', category: UnitCategory): void {
    if (this.muted) return;
    try {
      const ctx = this.getContext();
      if (ctx.state === 'suspended') ctx.resume();

      if (action === 'select') {
        if (category === 'infantry') this.synthSelectInfantry(ctx);
        else if (category === 'harvester') this.synthSelectHarvester(ctx);
        else this.synthSelectVehicle(ctx);
      } else if (action === 'move') {
        if (category === 'infantry') this.synthMoveInfantry(ctx);
        else if (category === 'harvester') this.synthMoveHarvester(ctx);
        else this.synthMoveVehicle(ctx);
      } else if (action === 'attack') {
        if (category === 'infantry') this.synthAttackInfantry(ctx);
        else if (category === 'harvester') this.synthAttackVehicle(ctx);
        else this.synthAttackVehicle(ctx);
      }
    } catch {
      // Audio not available
    }
  }

  // Infantry select: crisp radio chirp (two quick high beeps)
  private synthSelectInfantry(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const p = this.randPitch();
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.14);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200 * p, t + i * 0.07);
      osc.frequency.exponentialRampToValueAtTime(1600 * p, t + i * 0.07 + 0.04);
      gain.gain.setValueAtTime(0.14 * this.sfxVolume, t + i * 0.07);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.06);
      osc.connect(gain);
      osc.start(t + i * 0.07);
      osc.stop(t + i * 0.07 + 0.07);
    }
  }

  // Vehicle select: mechanical clunk (low tone with slight ramp)
  private synthSelectVehicle(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const p = this.randPitch();
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.18);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(400 * p, t);
    osc.frequency.exponentialRampToValueAtTime(600 * p, t + 0.06);
    osc.frequency.exponentialRampToValueAtTime(500 * p, t + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  // Harvester select: deep industrial hum
  private synthSelectHarvester(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.15);
    osc.type = 'sawtooth';
    osc.frequency.value = 150;
    osc2.type = 'sine';
    osc2.frequency.value = 200;
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(gain);
    osc2.connect(gain);
    osc.start(t);
    osc2.start(t);
    osc.stop(t + 0.25);
    osc2.stop(t + 0.25);
  }

  // Infantry move: short snappy confirmation beep
  private synthMoveInfantry(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const p = this.randPitch();
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.12);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900 * p, t);
    osc.frequency.exponentialRampToValueAtTime(700 * p, t + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  // Vehicle move: engine rev (low sweep up then down)
  private synthMoveVehicle(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const p = this.randPitch();
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.12);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(250 * p, t);
    osc.frequency.exponentialRampToValueAtTime(400 * p, t + 0.08);
    osc.frequency.exponentialRampToValueAtTime(300 * p, t + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  // Harvester move: heavy rumble
  private synthMoveHarvester(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.1);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.1);
    osc.frequency.exponentialRampToValueAtTime(140, t + 0.2);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(filter);
    filter.connect(gain);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  // Infantry attack: sharp burst
  private synthAttackInfantry(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const p = this.randPitch();
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.18);
    osc.type = 'square';
    osc.frequency.setValueAtTime(600 * p, t);
    osc.frequency.exponentialRampToValueAtTime(300 * p, t + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  // Vehicle attack: aggressive low growl
  private synthAttackVehicle(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const p = this.randPitch();
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.15);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(200 * p, t);
    osc.frequency.exponentialRampToValueAtTime(100 * p, t + 0.12);
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(150 * p, t);
    osc2.frequency.exponentialRampToValueAtTime(80 * p, t + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(gain);
    osc2.connect(gain);
    osc.start(t);
    osc2.start(t);
    osc.stop(t + 0.2);
    osc2.stop(t + 0.2);
  }

  // Building placement: solid thunk
  private synthPlace(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.18);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // Worm warning: deep rumble with tremolo
  private synthWorm(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    const gain = this.makeGain(ctx, 0.2);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(60, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.6);
    lfo.type = 'sine';
    lfo.frequency.value = 8;
    lfoGain.gain.value = 0.1 * this.sfxVolume;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    osc.connect(gain);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.7);
    lfo.stop(t + 0.7);
  }

  // Under attack alert: urgent two-tone alarm
  private synthUnderAttack(ctx: AudioContext): void {
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.12);
      osc.type = 'square';
      osc.frequency.value = i % 2 === 0 ? 800 : 600;
      gain.gain.setValueAtTime(0.12 * this.sfxVolume, t + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.1);
      osc.connect(gain);
      osc.start(t + i * 0.12);
      osc.stop(t + i * 0.12 + 0.11);
    }
  }

  // Infantry death: sharp crack + quick fade (small arms)
  private synthDeathInfantry(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const p = this.randPitch();
    // Short noise burst
    const bufferSize = ctx.sampleRate * 0.1;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.2));
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.makeGain(ctx, 0.15);
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 500 * p;
    source.connect(filter);
    filter.connect(gain);
    source.start(t);
  }

  // Vehicle death: heavy metallic boom with rumble
  private synthDeathVehicle(ctx: AudioContext): void {
    const t = ctx.currentTime;
    const p = this.randPitch();
    // Noise burst (explosion body)
    const bufferSize = ctx.sampleRate * 0.4;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.12));
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.makeGain(ctx, 0.3);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600 * p, t);
    filter.frequency.exponentialRampToValueAtTime(80, t + 0.4);
    source.connect(filter);
    filter.connect(gain);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    source.start(t);
    // Metallic ping
    const osc = ctx.createOscillator();
    const oscGain = this.makeGain(ctx, 0.08);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200 * p, t);
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.15);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(oscGain);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // Building death: massive rumbling explosion with debris
  private synthDeathBuilding(ctx: AudioContext): void {
    const t = ctx.currentTime;
    // Long noise burst
    const bufferSize = ctx.sampleRate * 0.8;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.2));
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.makeGain(ctx, 0.35);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, t);
    filter.frequency.exponentialRampToValueAtTime(50, t + 0.8);
    source.connect(filter);
    filter.connect(gain);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    source.start(t);
    // Sub-bass thud
    const osc = ctx.createOscillator();
    const oscGain = this.makeGain(ctx, 0.2);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(50, t);
    osc.frequency.exponentialRampToValueAtTime(25, t + 0.5);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.connect(oscGain);
    osc.start(t);
    osc.stop(t + 0.6);
  }

  private synthSuperweaponReady(ctx: AudioContext): void {
    const t = ctx.currentTime;
    // Ascending alarm tones (3 notes)
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = this.makeGain(ctx, 0.2);
      osc.type = 'square';
      osc.frequency.value = 600 + i * 200;
      gain.gain.setValueAtTime(0.2 * this.sfxVolume, t + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.15 + 0.12);
      osc.connect(gain);
      osc.start(t + i * 0.15);
      osc.stop(t + i * 0.15 + 0.12);
    }
  }

  private synthSuperweaponLaunch(ctx: AudioContext): void {
    const t = ctx.currentTime;
    // Descending siren + explosion
    const osc = ctx.createOscillator();
    const gain = this.makeGain(ctx, 0.3);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(100, t + 0.6);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 0.7);
    // Low boom follows
    const osc2 = ctx.createOscillator();
    const gain2 = this.makeGain(ctx, 0.25);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(60, t + 0.3);
    osc2.frequency.exponentialRampToValueAtTime(30, t + 0.8);
    gain2.gain.setValueAtTime(0, t);
    gain2.gain.linearRampToValueAtTime(0.25 * this.sfxVolume, t + 0.35);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    osc2.connect(gain2);
    osc2.start(t + 0.3);
    osc2.stop(t + 0.9);
  }

  // --- Positional Audio ---

  /** Update the listener position (call from game loop with camera position) */
  updateListenerPosition(x: number, z: number): void {
    this.listenerX = x;
    this.listenerZ = z;
  }

  /** Play a synth SFX with distance-based volume attenuation */
  playSfxAt(type: SfxType, worldX: number, worldZ: number): void {
    if (this.muted) return;
    const dx = worldX - this.listenerX;
    const dz = worldZ - this.listenerZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > this.maxAudioRange) return; // Too far away

    // Linear falloff: full volume at 0, silent at maxRange
    const volumeScale = Math.max(0, 1 - dist / this.maxAudioRange);
    if (volumeScale < 0.05) return; // Negligible

    try {
      const ctx = this.getContext();
      if (ctx.state === 'suspended') ctx.resume();

      // Try sampled audio with distance scaling
      if (this.playSampleAt(type, volumeScale)) return;

      // Fall back to synth with distance-attenuated volume
      this.playSynthSfx(type, ctx, volumeScale);
    } catch {
      // Audio not available
    }
  }

  /** Play a sampled SFX with volume scaling */
  private playSampleAt(type: string, volumeScale: number): boolean {
    const entry = SFX_MANIFEST[type];
    if (!entry || entry.paths.length === 0 || !this.sampleBank) return false;
    if (entry.cooldown) {
      const now = Date.now();
      const lastPlay = this.sfxCooldowns.get(type) ?? 0;
      if (now - lastPlay < entry.cooldown) return true;
      this.sfxCooldowns.set(type, now);
    }
    const path = entry.paths[Math.floor(Math.random() * entry.paths.length)];
    if (!this.sampleBank.has(path)) return false;
    this.sampleBank.play(path, entry.volume * volumeScale, entry.pitchVariation);
    return true;
  }

  // --- Ambient Wind ---

  /** Start a continuous desert wind ambient loop (synthesized). */
  startAmbientWind(): void {
    if (this.windActive || this.muted) return;
    try {
      const ctx = this.getContext();
      if (ctx.state === 'suspended') ctx.resume();

      // Create brown noise for wind (low-pass filtered white noise)
      const bufferSize = ctx.sampleRate * 2; // 2-second loop
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let lastOut = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        // Brown noise: integrate white noise with leaky filter
        lastOut = (lastOut + (0.02 * white)) / 1.02;
        data[i] = Math.max(-1, Math.min(1, lastOut * 3.5)); // Normalize + clamp
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      // Bandpass filter: 100-500 Hz for wind character
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 250;
      this.windFilter.Q.value = 0.5;

      // Slow LFO for gusting effect
      this.windLfo = ctx.createOscillator();
      this.windLfoGain = ctx.createGain();
      this.windLfo.type = 'sine';
      this.windLfo.frequency.value = 0.15; // Very slow gusting
      this.windLfoGain.gain.value = 0.02 * this.sfxVolume;
      this.windLfo.connect(this.windLfoGain);

      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0.04 * this.sfxVolume;
      this.windLfoGain.connect(this.windGain.gain);

      source.connect(this.windFilter);
      this.windFilter.connect(this.windGain);
      this.windGain.connect(ctx.destination);
      this.windLfo.start();
      source.start();

      this.windNode = source;
      this.windActive = true;
    } catch {
      // Audio not available
    }
  }

  /** Stop the ambient wind loop. */
  stopAmbientWind(): void {
    if (this.windLfo) {
      try { this.windLfo.stop(); } catch { /* */ }
      this.windLfo.disconnect();
      this.windLfo = null;
    }
    if (this.windLfoGain) { this.windLfoGain.disconnect(); this.windLfoGain = null; }
    if (this.windFilter) { this.windFilter.disconnect(); this.windFilter = null; }
    if (this.windNode) {
      try { this.windNode.stop(); } catch { /* already stopped */ }
      this.windNode.disconnect();
      this.windNode = null;
    }
    if (this.windGain) { this.windGain.disconnect(); this.windGain = null; }
    this.windActive = false;
  }

  /** Get the name of the currently playing music track. */
  getCurrentTrackName(): string | null {
    if (!this.musicElement || this.currentTrackIndex < 0) return null;
    const playlist = this.getPlaylist();
    if (this.currentTrackIndex >= playlist.length) return null;
    return playlist[this.currentTrackIndex].name;
  }

  // --- Combat intensity ---

  private bumpCombatIntensity(amount: number): void {
    this.combatIntensity = Math.min(1, this.combatIntensity + amount);
    this.lastCombatEvent = Date.now();
  }

  /** Call periodically from game loop to decay intensity */
  updateIntensity(): void {
    const elapsed = Date.now() - this.lastCombatEvent;
    if (elapsed > 3000) {
      // Decay after 3 seconds of no combat
      this.combatIntensity = Math.max(0, this.combatIntensity - 0.005);
    }
  }

  getCombatIntensity(): number {
    return this.combatIntensity;
  }

  // --- Controls ---

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.musicElement) {
      this.musicElement.volume = this.muted ? 0 : this.musicVolume;
    }
    if (this.fadingOutElement) {
      this.fadingOutElement.volume = this.muted ? 0 : this.musicVolume;
    }
    if (this.sampleBank) {
      this.sampleBank.setVolume(this.muted ? 0 : this.sfxVolume);
    }
    if (this.dialogManager) {
      this.dialogManager.setMuted(this.muted);
    }
    // Handle ambient wind
    if (this.muted && this.windActive) {
      this.stopAmbientWind();
    } else if (!this.muted && !this.windActive) {
      this.startAmbientWind();
    }
  }

  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (!this.muted) {
      if (this.musicElement) this.musicElement.volume = this.musicVolume;
      if (this.fadingOutElement) this.fadingOutElement.volume = Math.min(this.fadingOutElement.volume, this.musicVolume);
    }
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sampleBank) {
      this.sampleBank.setVolume(this.sfxVolume);
    }
    if (this.windGain) {
      this.windGain.gain.value = 0.04 * this.sfxVolume;
    }
    if (this.windLfoGain) {
      this.windLfoGain.gain.value = 0.02 * this.sfxVolume;
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  stopAll(): void {
    if (this.crossfadeTimer) { clearInterval(this.crossfadeTimer); this.crossfadeTimer = null; }
    if (this.musicElement) {
      this.musicElement.pause();
      this.musicElement.removeEventListener('ended', this.onTrackEnded);
      this.musicElement = null;
    }
    if (this.fadingOutElement) {
      this.fadingOutElement.pause();
      this.fadingOutElement = null;
    }
    this.stopAmbientWind();
  }
}
