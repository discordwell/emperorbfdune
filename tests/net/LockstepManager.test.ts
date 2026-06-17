import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld } from 'bitecs';

import { LockstepManager } from '../../src/net/LockstepManager';
import type { LockstepEvents } from '../../src/net/LockstepManager';
import type { SessionManager } from '../../src/net/SessionManager';
import type { PeerMessage } from '../../src/net/PeerConnection';
import { ReplayCommandType } from '../../src/core/ReplaySystem';
import type { ReplayCommand } from '../../src/core/ReplaySystem';

const INPUT_DELAY = 3; // mirrors the constant in LockstepManager

function makeManager(peerIds: string[] = ['p1']) {
  const broadcast = vi.fn();
  const session = { broadcast } as unknown as SessionManager;
  const events: { [K in keyof LockstepEvents]: ReturnType<typeof vi.fn> } = {
    onTickReady: vi.fn(),
    onDesync: vi.fn(),
    onStall: vi.fn(),
    onStallResolved: vi.fn(),
  };
  const mgr = new LockstepManager('local', peerIds, session, events as unknown as LockstepEvents);
  return { mgr, broadcast, events };
}

function peerInput(tick: number, commands: ReplayCommand[] = [], hash?: number): PeerMessage {
  return { type: 'lockstep:input', tick, commands, hash };
}

/** Advance through the seeded warmup ticks (1..INPUT_DELAY-1). */
function confirmWarmup(mgr: LockstepManager) {
  for (let t = 1; t < INPUT_DELAY; t++) mgr.tryAdvance();
}

describe('LockstepManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules local input INPUT_DELAY ticks ahead and broadcasts it', () => {
    const { mgr, broadcast } = makeManager();
    mgr.queueLocalInput([{ type: ReplayCommandType.Stop, player: 0 }]);

    expect(mgr.getLocalTick()).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'lockstep:input', tick: INPUT_DELAY }),
    );
  });

  it('attaches a desync hash only on hash-check-interval ticks', () => {
    const { mgr, broadcast } = makeManager();
    const world = createWorld();

    mgr.queueLocalInput([], world, [100]); // localTick 0 -> 0 % 25 === 0 -> hash
    expect(typeof broadcast.mock.calls[0][0].hash).toBe('number');

    mgr.queueLocalInput([], world, [100]); // localTick 1 -> no hash
    expect(broadcast.mock.calls[1][0].hash).toBeUndefined();
  });

  it('auto-confirms the warmup window so the simulation can actually start', () => {
    // Regression: local input is always scheduled INPUT_DELAY ahead, so without
    // seeding, ticks 1..INPUT_DELAY-1 never get input and tryAdvance() deadlocks
    // on tick 1 forever.
    const { mgr, events } = makeManager();

    expect(mgr.tryAdvance()).toBe(true);
    expect(mgr.tryAdvance()).toBe(true);
    expect(mgr.getConfirmedTick()).toBe(INPUT_DELAY - 1);
    expect(events.onTickReady).toHaveBeenCalledWith(1, []);
    expect(events.onTickReady).toHaveBeenCalledWith(2, []);

    // The first "real" tick still needs everyone's input.
    expect(mgr.tryAdvance()).toBe(false);
    expect(mgr.isStalling()).toBe(true);
    expect(events.onStall).toHaveBeenCalled();
  });

  it('stalls on missing peer input and resolves when it arrives', () => {
    const { mgr, events } = makeManager();
    confirmWarmup(mgr);

    mgr.queueLocalInput([{ type: ReplayCommandType.Stop, player: 0 }]); // local input for tick 3
    expect(mgr.tryAdvance()).toBe(false);
    expect(mgr.isStalling()).toBe(true);
    expect(events.onStall).toHaveBeenCalledWith(['p1']);

    // Peer input arrives — handlePeerInput retries automatically while stalling.
    mgr.handlePeerInput('p1', peerInput(INPUT_DELAY));
    expect(mgr.isStalling()).toBe(false);
    expect(events.onStallResolved).toHaveBeenCalledTimes(1);
    expect(mgr.getConfirmedTick()).toBe(INPUT_DELAY);
  });

  it('merges all players’ commands for a confirmed tick', () => {
    const { mgr, events } = makeManager();
    confirmWarmup(mgr);

    const localCmd: ReplayCommand = { type: ReplayCommandType.Move, player: 0 };
    const peerCmd: ReplayCommand = { type: ReplayCommandType.Attack, player: 1 };
    mgr.queueLocalInput([localCmd]);
    mgr.handlePeerInput('p1', peerInput(INPUT_DELAY, [peerCmd]));
    expect(mgr.tryAdvance()).toBe(true);

    const readyCall = events.onTickReady.mock.calls.find((c) => c[0] === INPUT_DELAY);
    expect(readyCall).toBeDefined();
    expect(readyCall![1]).toEqual(expect.arrayContaining([localCmd, peerCmd]));
  });

  it('detects a desync when a peer hash differs from the local hash', () => {
    // Regression: desync hashes live on ticks where tick % 25 === INPUT_DELAY,
    // but checkDesync used to gate on tick % 25 === 0 — a set it never intersects,
    // so desyncs were silently never reported.
    const { mgr, broadcast, events } = makeManager();
    const world = createWorld();

    mgr.queueLocalInput([], world, [100]); // tick 3 carries the local hash
    const localHash = broadcast.mock.calls[0][0].hash as number;
    confirmWarmup(mgr);

    mgr.handlePeerInput('p1', peerInput(INPUT_DELAY, [], localHash ^ 0xffff));
    expect(mgr.tryAdvance()).toBe(true);

    expect(events.onDesync).toHaveBeenCalledTimes(1);
    const [tickArg, localArg, remoteMap] = events.onDesync.mock.calls[0];
    expect(tickArg).toBe(INPUT_DELAY);
    expect(localArg).toBe(localHash);
    expect((remoteMap as Map<string, number>).get('p1')).toBe(localHash ^ 0xffff);
  });

  it('does not flag a desync when hashes match', () => {
    const { mgr, broadcast, events } = makeManager();
    const world = createWorld();

    mgr.queueLocalInput([], world, [100]);
    const localHash = broadcast.mock.calls[0][0].hash as number;
    confirmWarmup(mgr);

    mgr.handlePeerInput('p1', peerInput(INPUT_DELAY, [], localHash));
    expect(mgr.tryAdvance()).toBe(true);
    expect(events.onDesync).not.toHaveBeenCalled();
  });

  it('prunes stale input buffers even when a future tick was inserted out of order', () => {
    // Regression: the cleanup loop used `break` on the first non-old tick, assuming
    // Map iteration is sorted. It is insertion-ordered, so an early future-tick
    // buffer made it bail out and leak every older buffer behind it.
    const { mgr } = makeManager();
    const N = 30;

    // A peer input for a far-future tick, inserted FIRST (out of tick order).
    mgr.handlePeerInput('p1', peerInput(100));

    // Local + peer inputs for ticks 3..N.
    for (let i = 0; i < N - 2; i++) mgr.queueLocalInput([]); // localTick 0..N-3 -> ticks 3..N
    for (let t = INPUT_DELAY; t <= N; t++) mgr.handlePeerInput('p1', peerInput(t));

    // Drain everything that can be confirmed (ticks 31..99 are missing -> stops at N).
    while (mgr.tryAdvance()) { /* advance */ }
    expect(mgr.getConfirmedTick()).toBe(N);

    // After confirming tick N, only ticks >= N-10 (plus the orphan future tick)
    // should remain. With the old `break` bug this would be ~29.
    expect(mgr.getBufferedTickCount()).toBeLessThanOrEqual(12);
  });

  it('reset() restores the warmup so a new game can start again', () => {
    const { mgr } = makeManager();
    confirmWarmup(mgr);
    mgr.queueLocalInput([]);
    mgr.handlePeerInput('p1', peerInput(INPUT_DELAY));
    while (mgr.tryAdvance()) { /* advance */ }
    expect(mgr.getConfirmedTick()).toBe(INPUT_DELAY);

    mgr.reset();
    expect(mgr.getConfirmedTick()).toBe(0);
    expect(mgr.getLocalTick()).toBe(0);
    expect(mgr.tryAdvance()).toBe(true); // warmup tick 1 confirmable again
  });
});
