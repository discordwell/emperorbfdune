/**
 * DialogManager - Plays spoken advisor/mentat dialog lines during gameplay.
 * Maps game events to the original UI-G dialog WAV files (converted to OGG/Opus).
 *
 * File mapping: UISPOKEN.TXT entry N (1-based) -> UI-G{(N-1)*2+4}.ogg
 * Some entries have no audio file (text-only subtitles).
 */
import { SampleBank } from './SampleBank';
import { EventBus } from '../core/EventBus';

// Dialog events that can be triggered during gameplay
export type DialogEvent =
  | 'unitReady'
  | 'buildingComplete'
  | 'buildingReady'
  | 'buildingSold'
  | 'buildingLost'
  | 'buildingStarted'
  | 'harvesterUnderAttack'
  | 'baseUnderAttack'
  | 'unitLost'
  | 'lowPower'
  | 'insufficientFunds'
  | 'wormSign'
  | 'wormAttack'
  | 'cannotBuild'
  | 'newConstructionOptions'
  | 'superweaponStarted'
  | 'superweaponReady'
  | 'superweaponIncoming'
  | 'buildingStolen'
  | 'buildingCaptured'
  | 'targetDestroyed'
  | 'constructionComplete'
  | 'training'
  | 'reinforcementsApproaching'
  | 'reinforcementsArrived'
  | 'victory'
  | 'defeat'
  | 'battleWin'
  | 'battleLose'
  | 'retreatStart'
  | 'retreatSuccess'
  | 'retreatFailed';

// Faction prefixes for faction-specific dialog variants
type FactionPrefix = 'AT' | 'HK' | 'OR';

const DIALOG_PATH = '/assets/audio/dialog/';

/**
 * Maps UISPOKEN.TXT string key -> UI-G file number.
 * Formula: entry index (1-based) -> (index - 1) * 2 + 4
 * Only entries with existing audio files are included.
 */
const STRING_KEY_TO_FILE: Record<string, number> = {
  // Harvester under attack (faction-specific)
  ATHarvAttack: 4,
  HKHarvAttack: 6,
  ORHarvAttack: 8,
  // Base under attack (generic)
  BaseAttack: 10,
  // Low power (faction-specific)
  ATLowPower: 16,
  HKLowPower: 18,
  ORLowPower: 20,
  // Building sold
  BldgSold: 22,
  // Building built / ready to place (AT has unique line)
  ATBldgBuilt: 24,
  // Construction started (faction-specific)
  ATBldgStart: 30,
  HKBldgStart: 32,
  ORBldgStart: 34,
  // Cannot build
  HKCannotBuild: 40,
  // New construction options
  HKNewConOpt: 46,
  ORNewConOpt: 48,
  // Training
  Training: 50,
  // Superweapon started (faction-specific)
  ATSpecWepStart: 52,
  HKSpecWepStart: 54,
  ORSpecWepStart: 56,
  // Superweapon ready (faction-specific)
  ATSpecWepReady: 58,
  HKSpecWepReady: 60,
  ORSpecWepReady: 62,
  // Incoming superweapons
  IncomingHawk: 64,
  ORIncomingHawk: 66,
  ATIncomingChaos: 68,
  IncomingChaos: 70,
  ATIncomingDHand: 72,
  HKIncomingDHand: 74,
  ORIncomingDHand: 76,
  // Building stolen (faction-specific)
  ATBldgStolen: 78,
  HKBldgStolen: 80,
  // Building captured
  ATBldgCaptured: 84,
  HKBldgCaptured: 86,
  // Leech / contamination
  HKLeechAttack: 92,
  ContAttack: 96,
  // Worm
  WormSign: 98,
  HKWormSign: 100,
  Wormstrike: 102,
  // Target destroyed
  TargDest: 106,
  // Upgrade
  HKUpgrade: 110,
  ORUpgrade: 112,
  // Retreat
  RetreatStart: 154,
  RetreatStartEnemy: 156,
  RetreatSuccess: 158,
  RetreatFailed: 160,
  // Reinforcements
  ReinforceApp: 162,
  ReinforceArr: 164,
  // Funds
  InsufficientFunds: 166,
  // Construction complete
  ConComplete: 178,
  // Game state
  GameSaved: 182,
  BattleRetreat: 184,
  BattleWin: 186,
  // Victory/Defeat
  WinGame: 192,
  LoseGame: 194,
};

/** Build OGG path from file number */
function dialogPath(fileNum: number): string {
  return `${DIALOG_PATH}UI-G${String(fileNum).padStart(3, '0')}.ogg`;
}

/**
 * For each DialogEvent, define which string keys to try in priority order.
 * The manager tries faction-specific first, then generic fallback.
 */
interface DialogMapping {
  // Faction-specific keys: { AT: key, HK: key, OR: key }
  faction?: Partial<Record<FactionPrefix, string>>;
  // Generic fallback key
  generic?: string;
}

const EVENT_MAPPINGS: Record<DialogEvent, DialogMapping> = {
  harvesterUnderAttack: {
    faction: { AT: 'ATHarvAttack', HK: 'HKHarvAttack', OR: 'ORHarvAttack' },
  },
  baseUnderAttack: {
    generic: 'BaseAttack',
  },
  unitLost: {
    // No audio file exists for UnitLost (012) or BldgLost (014)
    // We could fall back to silence, but we have no file
    generic: undefined,
  },
  buildingLost: {
    generic: undefined,
  },
  lowPower: {
    faction: { AT: 'ATLowPower', HK: 'HKLowPower', OR: 'ORLowPower' },
  },
  buildingSold: {
    generic: 'BldgSold',
  },
  buildingReady: {
    faction: { AT: 'ATBldgBuilt' },
    // BldgBuilt (026) doesn't exist; use AT variant as fallback
  },
  unitReady: {
    // UnitReady (028) doesn't have audio; use Training as fallback
    generic: 'Training',
  },
  buildingStarted: {
    faction: { AT: 'ATBldgStart', HK: 'HKBldgStart', OR: 'ORBldgStart' },
  },
  cannotBuild: {
    faction: { HK: 'HKCannotBuild' },
  },
  newConstructionOptions: {
    faction: { HK: 'HKNewConOpt', OR: 'ORNewConOpt' },
  },
  training: {
    generic: 'Training',
  },
  superweaponStarted: {
    faction: { AT: 'ATSpecWepStart', HK: 'HKSpecWepStart', OR: 'ORSpecWepStart' },
  },
  superweaponReady: {
    faction: { AT: 'ATSpecWepReady', HK: 'HKSpecWepReady', OR: 'ORSpecWepReady' },
  },
  superweaponIncoming: {
    // These depend on what KIND of superweapon is incoming
    // For simplicity, use the generic ones
    faction: { AT: 'ATIncomingDHand', HK: 'HKIncomingDHand', OR: 'ORIncomingDHand' },
  },
  buildingStolen: {
    faction: { AT: 'ATBldgStolen', HK: 'HKBldgStolen' },
  },
  buildingCaptured: {
    faction: { AT: 'ATBldgCaptured', HK: 'HKBldgCaptured' },
  },
  targetDestroyed: {
    generic: 'TargDest',
  },
  constructionComplete: {
    generic: 'ConComplete',
  },
  wormSign: {
    faction: { HK: 'HKWormSign' },
    generic: 'WormSign',
  },
  wormAttack: {
    generic: 'Wormstrike',
  },
  insufficientFunds: {
    generic: 'InsufficientFunds',
  },
  reinforcementsApproaching: {
    generic: 'ReinforceApp',
  },
  reinforcementsArrived: {
    generic: 'ReinforceArr',
  },
  victory: {
    generic: 'WinGame',
  },
  defeat: {
    generic: 'LoseGame',
  },
  battleWin: {
    generic: 'BattleWin',
  },
  battleLose: {
    // BattleLose (188) doesn't exist; use LoseGame
    generic: 'LoseGame',
  },
  retreatStart: {
    generic: 'RetreatStart',
  },
  retreatSuccess: {
    generic: 'RetreatSuccess',
  },
  retreatFailed: {
    generic: 'RetreatFailed',
  },
  buildingComplete: {
    generic: 'ConComplete',
  },
};

// Per-event cooldowns (ms). High-frequency events get aggressive throttling.
const EVENT_COOLDOWNS: Partial<Record<DialogEvent, number>> = {
  harvesterUnderAttack: 8000,
  baseUnderAttack: 8000,
  unitLost: 5000,
  buildingLost: 5000,
  lowPower: 15000,
  insufficientFunds: 8000,
  wormSign: 10000,
  wormAttack: 6000,
  targetDestroyed: 4000,
  cannotBuild: 3000,
  buildingStarted: 2000,
  unitReady: 2500,
  buildingReady: 2500,
  constructionComplete: 2000,
  buildingSold: 2000,
  superweaponReady: 5000,
  superweaponIncoming: 5000,
  superweaponStarted: 5000,
  newConstructionOptions: 5000,
};

export class DialogManager {
  private sampleBank: SampleBank;
  private playerFaction: FactionPrefix = 'AT';
  private lastDialogTime = 0;
  private globalCooldown = 1500; // Minimum ms between ANY dialog line
  private eventCooldowns = new Map<DialogEvent, number>(); // Last play time per event
  private dialogQueue: DialogEvent[] = [];
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  private volume = 0.85; // Dialog is higher priority than SFX
  private muted = false;
  private preloaded = false;

  constructor(sampleBank: SampleBank) {
    this.sampleBank = sampleBank;
  }

  setPlayerFaction(faction: string): void {
    const prefix = faction.substring(0, 2).toUpperCase() as FactionPrefix;
    if (prefix === 'AT' || prefix === 'HK' || prefix === 'OR') {
      this.playerFaction = prefix;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
  }

  /**
   * Preload all dialog audio files that are mapped to events.
   * Call during the loading screen phase.
   */
  async preload(): Promise<void> {
    if (this.preloaded) return;
    this.preloaded = true;

    const paths = new Set<string>();
    for (const mapping of Object.values(EVENT_MAPPINGS)) {
      // Add faction-specific paths
      if (mapping.faction) {
        for (const key of Object.values(mapping.faction)) {
          if (key && STRING_KEY_TO_FILE[key] !== undefined) {
            paths.add(dialogPath(STRING_KEY_TO_FILE[key]));
          }
        }
      }
      // Add generic paths
      if (mapping.generic && STRING_KEY_TO_FILE[mapping.generic] !== undefined) {
        paths.add(dialogPath(STRING_KEY_TO_FILE[mapping.generic]));
      }
    }

    console.log(`[DialogManager] Preloading ${paths.size} dialog samples...`);
    await this.sampleBank.preload([...paths]);
    console.log(`[DialogManager] Dialog preload complete.`);
  }

  /**
   * Play a dialog line for the given event.
   * Respects global and per-event cooldowns, queues if necessary.
   */
  playDialog(event: DialogEvent): void {
    if (this.muted) return;

    const now = Date.now();

    // Per-event cooldown check
    const eventCd = EVENT_COOLDOWNS[event] ?? 2000;
    const lastEvent = this.eventCooldowns.get(event) ?? 0;
    if (now - lastEvent < eventCd) return;

    // Global cooldown check — queue if too soon
    if (now - this.lastDialogTime < this.globalCooldown) {
      // Only queue if not already queued and queue isn't too long
      if (this.dialogQueue.length < 3 && !this.dialogQueue.includes(event)) {
        this.dialogQueue.push(event);
        this.scheduleQueueDrain();
      }
      return;
    }

    this.playNow(event);
  }

  private playNow(event: DialogEvent): void {
    const now = Date.now();
    const mapping = EVENT_MAPPINGS[event];
    if (!mapping) return;

    // Try faction-specific first
    let stringKey: string | undefined;
    if (mapping.faction) {
      stringKey = mapping.faction[this.playerFaction];
    }
    // Fall back to generic
    if (!stringKey && mapping.generic) {
      stringKey = mapping.generic;
    }
    // If still no key, try any available faction variant as fallback
    if (!stringKey && mapping.faction) {
      for (const key of Object.values(mapping.faction)) {
        if (key && STRING_KEY_TO_FILE[key] !== undefined) {
          stringKey = key;
          break;
        }
      }
    }

    if (!stringKey || STRING_KEY_TO_FILE[stringKey] === undefined) return;

    const path = dialogPath(STRING_KEY_TO_FILE[stringKey]);
    if (!this.sampleBank.has(path)) return;

    this.sampleBank.play(path, this.volume, false);
    this.lastDialogTime = now;
    this.eventCooldowns.set(event, now);
  }

  private scheduleQueueDrain(): void {
    if (this.queueTimer) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      if (this.dialogQueue.length > 0) {
        const event = this.dialogQueue.shift()!;
        const now = Date.now();
        // Re-check per-event cooldown before playing
        const eventCd = EVENT_COOLDOWNS[event] ?? 2000;
        const lastEvent = this.eventCooldowns.get(event) ?? 0;
        if (now - lastEvent >= eventCd) {
          this.playNow(event);
        }
        // Schedule next drain if queue still has items
        if (this.dialogQueue.length > 0) {
          this.scheduleQueueDrain();
        }
      }
    }, this.globalCooldown);
  }

  /**
   * Wire up to EventBus events. Call once during initialization.
   * The playerId parameter identifies which player is the human player (for filtering).
   */
  wireEvents(humanPlayerId: number, ownerChecker?: (entityId: number) => number): void {
    // Production complete -> unitReady or buildingReady
    EventBus.on('production:complete', ({ owner, isBuilding }) => {
      if (owner !== humanPlayerId) return;
      this.playDialog(isBuilding ? 'constructionComplete' : 'unitReady');
    });

    // Production started -> buildingStarted or training
    EventBus.on('production:started', ({ owner, isBuilding }) => {
      if (owner !== humanPlayerId) return;
      this.playDialog(isBuilding ? 'buildingStarted' : 'training');
    });

    // Building placed (construction complete and placed on map)
    EventBus.on('building:placed', ({ owner }) => {
      if (owner !== humanPlayerId) return;
      this.playDialog('buildingReady');
    });

    // Building destroyed (only play for human player's buildings)
    EventBus.on('building:destroyed', ({ owner }) => {
      if (owner === humanPlayerId) {
        this.playDialog('buildingLost');
      }
    });

    // Unit damaged -> check if harvester/building under attack
    EventBus.on('unit:damaged', ({ entityId, attackerOwner, isBuilding }) => {
      // Only play for human player's units being attacked by enemies
      if (attackerOwner === humanPlayerId) return; // We're the attacker
      // Must verify the damaged entity belongs to us (not enemy-vs-enemy combat)
      if (ownerChecker && ownerChecker(entityId) !== humanPlayerId) return;
      if (isBuilding) {
        this.playDialog('baseUnderAttack');
      }
    });

    // Worm events
    EventBus.on('worm:emerge', () => {
      this.playDialog('wormSign');
    });

    EventBus.on('worm:eat', ({ ownerId }) => {
      if (ownerId === humanPlayerId) {
        this.playDialog('wormAttack');
      }
    });

    // Note: lowPower is triggered directly from the power update loop in index.ts
    // since power:update events are not currently emitted.

    // Superweapon events
    EventBus.on('superweapon:ready', ({ owner }) => {
      if (owner === humanPlayerId) {
        this.playDialog('superweaponReady');
      } else {
        this.playDialog('superweaponIncoming');
      }
    });

    EventBus.on('superweapon:fired', ({ owner }) => {
      if (owner === humanPlayerId) {
        this.playDialog('superweaponStarted');
      } else {
        this.playDialog('superweaponIncoming');
      }
    });
  }

  /**
   * Set a callback to detect if a given entity is a harvester.
   * If provided, unit:damaged events for harvesters will trigger harvesterUnderAttack.
   */
  setHarvesterChecker(fn: (entityId: number) => boolean, humanPlayerId: number, ownerChecker: (entityId: number) => number): void {
    EventBus.on('unit:damaged', ({ entityId, attackerOwner }) => {
      if (attackerOwner === humanPlayerId) return;
      if (ownerChecker(entityId) !== humanPlayerId) return;
      if (fn(entityId)) {
        this.playDialog('harvesterUnderAttack');
      }
    });
  }

  /** Directly trigger a dialog event (for use from other systems). */
  trigger(event: DialogEvent): void {
    this.playDialog(event);
  }

  /** Clear the pending queue and reset cooldowns. */
  reset(): void {
    this.dialogQueue = [];
    this.eventCooldowns.clear();
    this.lastDialogTime = 0;
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
  }
}
