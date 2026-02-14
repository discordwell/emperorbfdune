import { SampleBank } from './SampleBank';
import type { GameRules } from '../config/RulesParser';

const V = '/assets/audio/voices/';

/**
 * Action code mapping for numbered voice files.
 * File pattern: NN-XXYY.ogg where XX is action code, YY is variant number.
 */
const ACTION_CODES: Record<string, string> = {
  select: 'US',
  move: 'UM',
  attack: 'UA',
};

/**
 * Action suffix mapping for faction generic voice files.
 * File pattern: {Prefix}Action{N}.ogg (e.g. ATRSelect1.ogg)
 */
const FACTION_ACTION_SUFFIX: Record<string, string> = {
  select: 'Select',
  move: 'Move',
  attack: 'Attack',
};

/**
 * Hardcoded SoundID -> unit type name mapping from the original game.
 * These come from the (commented-out) SoundID properties in rules.txt.
 */
const SOUND_ID_MAP: Record<number, string> = {
  0: 'ATKindjal',
  1: 'HKScout',
  2: 'ORScout',
  3: 'ATAPC',
  4: 'HKFlame',
  5: 'ORLaserTank',
  6: 'ATSniper',
  7: 'ATSonicTank2',  // 07 also found, might be duplicate
  8: 'HKAssault2',    // variant
  9: 'ORKobra2',      // variant
  10: 'ATSonicTank',
  11: 'HKAssault',
  12: 'ORKobra',
  13: 'IMSardaukar',
  14: 'GUNIABTank2',  // variant
  15: 'ORChemical2',  // variant
  16: 'ATInfantry',
  17: 'TLLeech',
  18: 'HKTrooper',
  19: 'HKBuzzsaw',
  20: 'OREngineer',
  21: 'ORKobra3',     // variant
  23: 'ORScout2',     // variant
  24: 'ATRepairUnit',
  25: 'ORChemical',
  26: 'ORDeviator',
  28: 'ATMongoose',
  30: 'IXProjector2', // variant
  31: 'GUNIABTank',
  33: 'HKMissile',
  35: 'ATEngineer',
  36: 'ATSonicTank3', // variant
  37: 'HKAssault3',   // variant
  38: 'ORDeviator2',  // variant
  39: 'ATMinotaurus',
  40: 'ATScout',
  41: 'ATOrni',
  42: 'ORMortar',
  43: 'IXProjector',
  44: 'HKDevastator',
  45: 'ATTrike',
  46: 'IXInfiltrator',
  47: 'FRADVFremen',
  48: 'FRFremen',
  49: 'FRFremen2',     // variant
  50: 'FRADVFremen2',  // variant
  51: 'HKDevastator2', // variant
  52: 'IXInfiltrator2', // variant
  53: 'ATEngineer2',   // variant
  54: 'GUNIABTank3',   // variant
};

/**
 * Map from 2-letter faction prefix (from unit name) to the 3-letter prefix
 * used in faction generic voice files.
 */
const FACTION_VOICE_PREFIXES: Record<string, string> = {
  'AT': 'ATR',
  'HK': 'HAR',
  'OR': 'ORD',
  'FR': 'FRE',
  'IM': 'Sar',
  'IX': 'IX',
  'TL': 'TL',
  'GU': 'GUI',
};

/**
 * VoiceManager handles unit voice lines (select, move, attack responses).
 *
 * Voice playback priority:
 * 1. Unit-specific voices: NN-XXYY.ogg (numbered sound ID files)
 * 2. Faction generic voices: PrefixAction{N}.ogg (e.g. ATRSelect1.ogg)
 *
 * A cooldown prevents voice spam when rapidly clicking units.
 */
export class VoiceManager {
  private sampleBank: SampleBank;
  private lastVoiceTime = 0;
  private voiceCooldown = 400; // ms between voice lines

  /** Map unit type name -> sound ID number */
  private unitSoundIds = new Map<string, number>();

  /** Cache: soundId+action -> list of available OGG paths */
  private unitVoiceCache = new Map<string, string[]>();

  /** Cache: factionPrefix+action -> list of available OGG paths */
  private factionVoiceCache = new Map<string, string[]>();

  /** Set of all voice paths that have been discovered (for preloading) */
  private allDiscoveredPaths = new Set<string>();

  /** Track which factions have been preloaded */
  private preloadedFactions = new Set<string>();

  constructor(sampleBank: SampleBank) {
    this.sampleBank = sampleBank;
  }

  /**
   * Build the unit type -> soundId mapping.
   * Called after rules are parsed. Uses the hardcoded SOUND_ID_MAP
   * since the SoundID properties are commented out in rules.txt.
   */
  init(rules: GameRules): void {
    // Build reverse map: for each soundId -> unitTypeName entry,
    // store the primary unit name (skip variant duplicates for the mapping)
    const primaryUnits = new Map<string, number>();

    for (const [soundId, unitName] of Object.entries(SOUND_ID_MAP)) {
      const id = Number(soundId);
      // Strip trailing digit suffixes for variant matching (e.g. ATSonicTank2 -> ATSonicTank)
      const baseName = unitName.replace(/\d+$/, '');

      // Check if this exact unit name exists in rules
      if (rules.units.has(unitName)) {
        this.unitSoundIds.set(unitName, id);
      }
      // Also try the base name (without variant suffix)
      if (baseName !== unitName && rules.units.has(baseName)) {
        // Only set if not already mapped
        if (!this.unitSoundIds.has(baseName)) {
          this.unitSoundIds.set(baseName, id);
        }
      }
    }

    // Also add primary mappings from the canonical list
    for (const [soundId, unitName] of Object.entries(SOUND_ID_MAP)) {
      const id = Number(soundId);
      if (rules.units.has(unitName) && !primaryUnits.has(unitName)) {
        primaryUnits.set(unitName, id);
      }
    }

    console.log(`[VoiceManager] Initialized with ${this.unitSoundIds.size} unit->soundId mappings`);
  }

  /**
   * Discover available voice files for a sound ID and action.
   * Scans known file patterns and caches results.
   */
  private getUnitVoicePaths(soundId: number, action: 'select' | 'move' | 'attack'): string[] {
    const cacheKey = `${soundId}-${action}`;
    if (this.unitVoiceCache.has(cacheKey)) {
      return this.unitVoiceCache.get(cacheKey)!;
    }

    const code = ACTION_CODES[action];
    const prefix = soundId.toString().padStart(2, '0');
    const paths: string[] = [];

    // Generate possible variant numbers (00-15 should cover all)
    for (let i = 0; i <= 15; i++) {
      const variant = i.toString().padStart(2, '0');
      const path = `${V}${prefix}-${code}${variant}.ogg`;
      paths.push(path);
    }

    this.unitVoiceCache.set(cacheKey, paths);
    for (const p of paths) this.allDiscoveredPaths.add(p);
    return paths;
  }

  /**
   * Discover available faction generic voice files for a faction prefix and action.
   */
  private getFactionVoicePaths(factionPrefix: string, action: 'select' | 'move' | 'attack'): string[] {
    const voicePrefix = FACTION_VOICE_PREFIXES[factionPrefix];
    if (!voicePrefix) return [];

    const cacheKey = `${voicePrefix}-${action}`;
    if (this.factionVoiceCache.has(cacheKey)) {
      return this.factionVoiceCache.get(cacheKey)!;
    }

    const suffix = FACTION_ACTION_SUFFIX[action];
    const paths: string[] = [];

    // Faction voices typically have 1-4 variants
    for (let i = 1; i <= 4; i++) {
      const path = `${V}${voicePrefix}${suffix}${i}.ogg`;
      paths.push(path);
    }

    this.factionVoiceCache.set(cacheKey, paths);
    for (const p of paths) this.allDiscoveredPaths.add(p);
    return paths;
  }

  /**
   * Get the 2-letter faction prefix from a unit type name.
   * E.g. "ATKindjal" -> "AT", "HKFlame" -> "HK", "IMSardaukar" -> "IM"
   */
  private getFactionPrefix(unitTypeName: string): string {
    // Try known prefixes (2-letter)
    const prefix = unitTypeName.substring(0, 2);
    if (FACTION_VOICE_PREFIXES[prefix]) return prefix;
    return '';
  }

  /**
   * Preload all voice files for a specific faction.
   * Loads both unit-specific voices (for all units of that faction)
   * and faction generic voices.
   */
  async preloadFaction(factionPrefix: string): Promise<void> {
    if (this.preloadedFactions.has(factionPrefix)) return;
    this.preloadedFactions.add(factionPrefix);

    const pathsToLoad: string[] = [];

    // 1. Faction generic voices
    for (const action of ['select', 'move', 'attack'] as const) {
      pathsToLoad.push(...this.getFactionVoicePaths(factionPrefix, action));
    }

    // 2. Unit-specific voices for all units of this faction
    for (const [unitName, soundId] of this.unitSoundIds) {
      if (this.getFactionPrefix(unitName) === factionPrefix) {
        for (const action of ['select', 'move', 'attack'] as const) {
          pathsToLoad.push(...this.getUnitVoicePaths(soundId, action));
        }
      }
    }

    console.log(`[VoiceManager] Preloading ${pathsToLoad.length} voice paths for faction ${factionPrefix}...`);
    await this.sampleBank.preload(pathsToLoad);

    // Count how many actually loaded
    let loaded = 0;
    for (const p of pathsToLoad) {
      if (this.sampleBank.has(p)) loaded++;
    }
    console.log(`[VoiceManager] Preloaded ${loaded}/${pathsToLoad.length} voice samples for faction ${factionPrefix}`);
  }

  /**
   * Preload voices for the enemy faction too (for when their units are selected).
   */
  async preloadEnemyFaction(factionPrefix: string): Promise<void> {
    await this.preloadFaction(factionPrefix);
  }

  /**
   * Play a voice line for a unit performing an action.
   * Respects cooldown to prevent voice spam.
   *
   * @param unitTypeName - The unit type name (e.g. "ATKindjal", "HKFlame")
   * @param action - The action: 'select', 'move', or 'attack'
   */
  playVoice(unitTypeName: string, action: 'select' | 'move' | 'attack'): void {
    // Cooldown check
    const now = Date.now();
    if (now - this.lastVoiceTime < this.voiceCooldown) return;

    // Try unit-specific voice first
    const soundId = this.unitSoundIds.get(unitTypeName);
    if (soundId !== undefined) {
      const paths = this.getUnitVoicePaths(soundId, action);
      const loaded = paths.filter(p => this.sampleBank.has(p));
      if (loaded.length > 0) {
        const path = loaded[Math.floor(Math.random() * loaded.length)];
        this.sampleBank.play(path, 0.7, false);
        this.lastVoiceTime = now;
        return;
      }
    }

    // Fall back to faction generic voice
    const factionPrefix = this.getFactionPrefix(unitTypeName);
    if (factionPrefix) {
      const paths = this.getFactionVoicePaths(factionPrefix, action);
      const loaded = paths.filter(p => this.sampleBank.has(p));
      if (loaded.length > 0) {
        const path = loaded[Math.floor(Math.random() * loaded.length)];
        this.sampleBank.play(path, 0.7, false);
        this.lastVoiceTime = now;
        return;
      }
    }

    // No voice available -- silently skip
  }

  /**
   * Check if a unit type has any voice files available.
   */
  hasVoice(unitTypeName: string): boolean {
    const soundId = this.unitSoundIds.get(unitTypeName);
    if (soundId !== undefined) {
      for (const action of ['select', 'move', 'attack'] as const) {
        const paths = this.getUnitVoicePaths(soundId, action);
        if (paths.some(p => this.sampleBank.has(p))) return true;
      }
    }
    const factionPrefix = this.getFactionPrefix(unitTypeName);
    if (factionPrefix) {
      for (const action of ['select', 'move', 'attack'] as const) {
        const paths = this.getFactionVoicePaths(factionPrefix, action);
        if (paths.some(p => this.sampleBank.has(p))) return true;
      }
    }
    return false;
  }
}
