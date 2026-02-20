/**
 * Replay recording and playback system.
 * Records all player commands per tick for deterministic replay.
 * Stores periodic simulation hashes for desync detection during playback.
 */

// --- Command Types ---

export enum ReplayCommandType {
  Move = 0,
  Attack = 1,
  AttackMove = 2,
  Patrol = 3,
  Stop = 4,
  Guard = 5,
  Scatter = 6,
  Waypoint = 7,
  RallyPoint = 8,
  SpawnUnit = 9,
  SpawnBuilding = 10,
  SellBuilding = 11,
  RepairBuilding = 12,
  QueueProduction = 13,
  CancelProduction = 14,
  ActivateAbility = 15,
  SetStance = 16,
  SetControlGroup = 17,
  Escort = 18,
  Deploy = 19,
  ForceReturn = 20,
  LoadTransport = 21,
  UnloadTransport = 22,
  PlaceConcrete = 23,
  UpgradeBuilding = 24,
  FireSuperweapon = 25,
}

export interface ReplayCommand {
  type: ReplayCommandType;
  /** Player who issued the command (0-7) */
  player: number;
  /** Entity IDs involved */
  entities?: number[];
  /** Target position */
  x?: number;
  z?: number;
  /** Target entity ID */
  targetEid?: number;
  /** Generic string argument (unit/building type name, ability ID) */
  arg?: string;
  /** Generic numeric argument (stance, group number, etc.) */
  num?: number;
}

export interface ReplayTickData {
  tick: number;
  commands: ReplayCommand[];
}

export interface ReplayHeader {
  version: number;
  date: string;
  housePrefix: string;
  enemyPrefix: string;
  mapId: string;
  mapSeed: number;
  rngSeed: number;
  totalPlayers: number;
  opponents: Array<{ prefix: string; name: string }>;
  gameMode: string;
  difficulty?: string;
  gameSpeed?: number;
}

export interface ReplayData {
  header: ReplayHeader;
  ticks: ReplayTickData[];
  /** Periodic hash checkpoints: [tick, hash] pairs (every 25 ticks) */
  hashCheckpoints: Array<[number, number]>;
  /** Final tick count */
  endTick: number;
}

/**
 * Records game commands for replay.
 * Call `startRecording()` at game start, `recordCommand()` for each command,
 * and `endTick()` at the end of each simulation tick.
 */
export class ReplayRecorder {
  private data: ReplayData | null = null;
  private currentTickCommands: ReplayCommand[] = [];
  private recording = false;

  /** Start recording a new replay */
  startRecording(header: ReplayHeader): void {
    this.data = {
      header: { ...header, version: 1 },
      ticks: [],
      hashCheckpoints: [],
      endTick: 0,
    };
    this.currentTickCommands = [];
    this.recording = true;
  }

  /** Record a command issued during the current tick */
  recordCommand(cmd: ReplayCommand): void {
    if (!this.recording) return;
    this.currentTickCommands.push(cmd);
  }

  /** Called at the end of each simulation tick to flush commands */
  endTick(tick: number): void {
    if (!this.recording || !this.data) return;

    // Only store ticks that have commands (sparse storage)
    if (this.currentTickCommands.length > 0) {
      this.data.ticks.push({
        tick,
        commands: this.currentTickCommands,
      });
      this.currentTickCommands = [];
    } else {
      this.currentTickCommands.length = 0; // Reuse array
    }

    this.data.endTick = tick;
  }

  /** Record a hash checkpoint (called periodically, e.g. every 25 ticks) */
  addHashCheckpoint(tick: number, hash: number): void {
    if (!this.recording || !this.data) return;
    this.data.hashCheckpoints.push([tick, hash]);
  }

  /** Stop recording and return the replay data */
  stopRecording(): ReplayData | null {
    this.recording = false;
    const data = this.data;
    this.data = null;
    return data;
  }

  /** Check if currently recording */
  isRecording(): boolean {
    return this.recording;
  }

  /** Get current replay data size estimate (for UI display) */
  getEstimatedSize(): number {
    if (!this.data) return 0;
    return this.data.ticks.length * 64 + this.data.hashCheckpoints.length * 8;
  }
}

/**
 * Replays recorded commands tick-by-tick.
 * The game runs in normal tick mode, but instead of accepting player input,
 * commands are fed from the replay data.
 */
export class ReplayPlayer {
  private data: ReplayData | null = null;
  private tickIndex = 0;
  private playing = false;
  private onCommand: ((cmd: ReplayCommand) => void) | null = null;
  private hashMap: Map<number, number> | null = null;

  /** Load replay data and prepare for playback */
  load(data: ReplayData): void {
    this.data = data;
    this.tickIndex = 0;
    this.playing = false;
    // Build hash lookup map for O(1) access
    this.hashMap = new Map();
    for (const [t, h] of data.hashCheckpoints) {
      this.hashMap.set(t, h);
    }
  }

  /** Set the command handler that will execute replay commands */
  setCommandHandler(handler: (cmd: ReplayCommand) => void): void {
    this.onCommand = handler;
  }

  /** Start playback */
  start(): void {
    if (!this.data) return;
    this.playing = true;
    this.tickIndex = 0;
  }

  /**
   * Called at the start of each simulation tick during playback.
   * Feeds any commands for this tick to the command handler.
   * Returns the number of commands executed.
   */
  processTick(tick: number): number {
    if (!this.playing || !this.data) return 0;

    if (tick > this.data.endTick) {
      this.playing = false;
      return 0;
    }

    if (!this.onCommand) return 0;

    let count = 0;
    // Advance through ticks data (sparse — skip ticks with no commands)
    while (this.tickIndex < this.data.ticks.length) {
      const tickData = this.data.ticks[this.tickIndex];
      if (tickData.tick > tick) break; // Future tick
      if (tickData.tick === tick) {
        for (const cmd of tickData.commands) {
          this.onCommand(cmd);
          count++;
        }
        this.tickIndex++;
        break;
      }
      // tickData.tick < tick — skip past ticks (shouldn't happen in normal playback)
      this.tickIndex++;
    }

    return count;
  }

  /** Get the hash checkpoint for a given tick, if one exists */
  getHashCheckpoint(tick: number): number | null {
    return this.hashMap?.get(tick) ?? null;
  }

  /** Check if playback is active */
  isPlaying(): boolean {
    return this.playing;
  }

  /** Stop playback */
  stop(): void {
    this.playing = false;
  }

  /** Get total duration in ticks */
  getTotalTicks(): number {
    return this.data?.endTick ?? 0;
  }

  /** Get replay header info */
  getHeader(): ReplayHeader | null {
    return this.data?.header ?? null;
  }

  /** Get the RNG seed from the replay */
  getRngSeed(): number {
    return this.data?.header.rngSeed ?? 42;
  }
}

/**
 * Serialize replay data to a compact JSON string.
 */
export function serializeReplay(data: ReplayData): string {
  return JSON.stringify(data);
}

/**
 * Deserialize replay data from a JSON string.
 */
export function deserializeReplay(json: string): ReplayData {
  return JSON.parse(json) as ReplayData;
}

/**
 * Export replay as a downloadable file.
 */
export function downloadReplay(data: ReplayData, filename?: string): void {
  const json = serializeReplay(data);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? `replay_${data.header.date}.ebfd.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
