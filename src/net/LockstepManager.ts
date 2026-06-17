/**
 * Deterministic lockstep protocol for multiplayer synchronization.
 * All players execute the same commands at the same tick.
 * Input delay buffer absorbs network jitter.
 */

import type { ReplayCommand } from '../core/ReplaySystem';
import type { SessionManager } from './SessionManager';
import type { PeerMessage } from './PeerConnection';
import { computeSimulationHash } from '../core/SimulationHash';
import type { World } from '../core/ECS';

const INPUT_DELAY = 3; // Ticks ahead commands are scheduled
const HASH_CHECK_INTERVAL = 25; // Compare hashes every N ticks

export interface LockstepEvents {
  /** Called when all inputs for a tick are ready and it can be simulated */
  onTickReady: (tick: number, commands: ReplayCommand[]) => void;
  /** Called when a desync is detected */
  onDesync: (tick: number, localHash: number, remoteHashes: Map<string, number>) => void;
  /** Called when waiting for remote input (stall) */
  onStall: (waitingFor: string[]) => void;
  /** Called when stall is resolved */
  onStallResolved: () => void;
}

interface TickInput {
  commands: ReplayCommand[];
  hash?: number;
}

export class LockstepManager {
  private localPlayerId: string;
  private peerIds: string[];
  private session: SessionManager;
  private events: LockstepEvents;

  // Input buffers: tick -> player -> commands
  private inputBuffer = new Map<number, Map<string, TickInput>>();
  private localTick = 0;
  private confirmedTick = 0;
  private stalling = false;
  private totalPlayers: number;

  constructor(
    localPlayerId: string,
    peerIds: string[],
    session: SessionManager,
    events: LockstepEvents,
  ) {
    this.localPlayerId = localPlayerId;
    this.peerIds = peerIds;
    this.session = session;
    this.events = events;
    this.totalPlayers = peerIds.length + 1;
    this.seedWarmup();
  }

  /**
   * Seed empty inputs for the warmup window (ticks 1..INPUT_DELAY-1).
   * Local commands are always scheduled INPUT_DELAY ticks ahead, so the first
   * tick any player can ever produce input for is INPUT_DELAY itself — leaving
   * the earliest ticks with no input. Without seeding them, tryAdvance() would
   * stall on tick 1 forever and the simulation could never start. No commands
   * can legitimately exist for these ticks anyway, so empty inputs are correct.
   */
  private seedWarmup(): void {
    const allIds = [this.localPlayerId, ...this.peerIds];
    for (let t = 1; t < INPUT_DELAY; t++) {
      const buffer = this.getOrCreateTickBuffer(t);
      for (const id of allIds) buffer.set(id, { commands: [] });
    }
  }

  /**
   * Queue local commands for the current tick.
   * Commands are scheduled INPUT_DELAY ticks ahead.
   */
  queueLocalInput(commands: ReplayCommand[], world?: World, playerCredits?: number[]): void {
    const targetTick = this.localTick + INPUT_DELAY;

    const input: TickInput = { commands };

    // Attach hash periodically for desync detection
    if (world && this.localTick % HASH_CHECK_INTERVAL === 0) {
      input.hash = computeSimulationHash(world, playerCredits);
    }

    // Store locally
    this.getOrCreateTickBuffer(targetTick).set(this.localPlayerId, input);

    // Broadcast to all peers
    this.session.broadcast({
      type: 'lockstep:input',
      tick: targetTick,
      commands,
      hash: input.hash,
    });

    this.localTick++;
  }

  /**
   * Handle incoming lockstep input from a peer.
   * Called by the SessionManager message handler.
   */
  handlePeerInput(peerId: string, msg: PeerMessage): void {
    if (msg.type !== 'lockstep:input') return;

    const tick = msg.tick as number;
    const commands = msg.commands as ReplayCommand[];
    const hash = msg.hash as number | undefined;

    this.getOrCreateTickBuffer(tick).set(peerId, { commands, hash });

    // Check if this resolves a stall
    if (this.stalling) {
      this.tryAdvance();
    }
  }

  /**
   * Try to advance the simulation by one tick.
   * Returns true if the tick was ready and commands were dispatched.
   */
  tryAdvance(): boolean {
    const tick = this.confirmedTick + 1;
    const buffer = this.inputBuffer.get(tick);

    if (!buffer) {
      this.reportStall(tick);
      return false;
    }

    // Check we have input from all players
    const allIds = [this.localPlayerId, ...this.peerIds];
    const missing: string[] = [];
    for (const id of allIds) {
      if (!buffer.has(id)) missing.push(id);
    }

    if (missing.length > 0) {
      this.reportStall(tick);
      return false;
    }

    // All inputs received — resolve stall if active
    if (this.stalling) {
      this.stalling = false;
      this.events.onStallResolved();
    }

    // Merge all commands for this tick
    const merged: ReplayCommand[] = [];
    for (const input of buffer.values()) {
      merged.push(...input.commands);
    }

    // Check for desync via hash comparison
    this.checkDesync(tick, buffer);

    // Dispatch
    this.events.onTickReady(tick, merged);
    this.confirmedTick = tick;

    // Clean up old buffers. Map iteration is in insertion order, which is NOT
    // necessarily ascending by tick — a peer's input for a future tick can be
    // inserted before an older tick is confirmed — so we cannot `break` early
    // or genuinely old buffers would leak. Deleting while iterating keys() is safe.
    for (const t of this.inputBuffer.keys()) {
      if (t < tick - 10) this.inputBuffer.delete(t);
    }

    return true;
  }

  private reportStall(tick: number): void {
    if (!this.stalling) {
      this.stalling = true;
      const allIds = [this.localPlayerId, ...this.peerIds];
      const buffer = this.inputBuffer.get(tick);
      const waiting = allIds.filter((id) => !buffer?.has(id));
      this.events.onStall(waiting);
    }
  }

  private checkDesync(tick: number, buffer: Map<string, TickInput>): void {
    // Hashes are attached in queueLocalInput when `localTick % HASH_CHECK_INTERVAL === 0`,
    // but scheduled INPUT_DELAY ticks ahead — so they live on ticks where
    // `tick % HASH_CHECK_INTERVAL === INPUT_DELAY`, never on multiples of the interval.
    // Gating on `tick % HASH_CHECK_INTERVAL === 0` (the old check) therefore never lined
    // up with a hash-bearing tick and silently disabled desync detection entirely.
    // Instead, gate on the presence of a local hash: ticks without one bail out cheaply.
    const localInput = buffer.get(this.localPlayerId);
    if (localInput?.hash === undefined) return;

    const remoteHashes = new Map<string, number>();
    let desync = false;

    for (const [peerId, input] of buffer) {
      if (peerId === this.localPlayerId) continue;
      if (input.hash !== undefined) {
        remoteHashes.set(peerId, input.hash);
        if (input.hash !== localInput.hash) {
          desync = true;
        }
      }
    }

    if (desync) {
      this.events.onDesync(tick, localInput.hash, remoteHashes);
    }
  }

  private getOrCreateTickBuffer(tick: number): Map<string, TickInput> {
    let buffer = this.inputBuffer.get(tick);
    if (!buffer) {
      buffer = new Map();
      this.inputBuffer.set(tick, buffer);
    }
    return buffer;
  }

  /** Get the confirmed tick (last tick all players agreed on) */
  getConfirmedTick(): number {
    return this.confirmedTick;
  }

  /** Get the local input tick (how far ahead local input is) */
  getLocalTick(): number {
    return this.localTick;
  }

  /** Get input delay in ticks */
  getInputDelay(): number {
    return INPUT_DELAY;
  }

  /** Check if currently stalling */
  isStalling(): boolean {
    return this.stalling;
  }

  /** Number of ticks currently held in the input buffer (diagnostic). */
  getBufferedTickCount(): number {
    return this.inputBuffer.size;
  }

  /** Reset for a new game */
  reset(): void {
    this.inputBuffer.clear();
    this.localTick = 0;
    this.confirmedTick = 0;
    this.stalling = false;
    this.seedWarmup();
  }
}
