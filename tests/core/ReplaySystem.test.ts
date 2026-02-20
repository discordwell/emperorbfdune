import { describe, it, expect } from 'vitest';
import {
  ReplayRecorder,
  ReplayPlayer,
  ReplayCommandType,
  serializeReplay,
  deserializeReplay,
  type ReplayCommand,
  type ReplayHeader,
} from '../../src/core/ReplaySystem';

const makeHeader = (): ReplayHeader => ({
  version: 1,
  date: '2026-02-20',
  housePrefix: 'AT_',
  enemyPrefix: 'HK_',
  mapId: 'test_map',
  mapSeed: 42,
  rngSeed: 42,
  totalPlayers: 2,
  opponents: [{ prefix: 'HK_', name: 'Harkonnen' }],
  gameMode: 'skirmish',
});

describe('ReplayRecorder', () => {
  it('records commands per tick', () => {
    const recorder = new ReplayRecorder();
    recorder.startRecording(makeHeader());

    recorder.recordCommand({
      type: ReplayCommandType.Move,
      player: 0,
      entities: [1, 2, 3],
      x: 100,
      z: 200,
    });
    recorder.endTick(1);

    recorder.endTick(2); // Empty tick — should not be stored

    recorder.recordCommand({
      type: ReplayCommandType.Attack,
      player: 0,
      entities: [4],
      targetEid: 10,
    });
    recorder.endTick(3);

    const data = recorder.stopRecording();
    expect(data).not.toBeNull();
    expect(data!.ticks.length).toBe(2); // Only ticks with commands
    expect(data!.ticks[0].tick).toBe(1);
    expect(data!.ticks[0].commands.length).toBe(1);
    expect(data!.ticks[1].tick).toBe(3);
    expect(data!.endTick).toBe(3);
  });

  it('records hash checkpoints', () => {
    const recorder = new ReplayRecorder();
    recorder.startRecording(makeHeader());
    recorder.addHashCheckpoint(25, 0xABCD);
    recorder.addHashCheckpoint(50, 0x1234);
    recorder.endTick(50);

    const data = recorder.stopRecording();
    expect(data!.hashCheckpoints.length).toBe(2);
    expect(data!.hashCheckpoints[0]).toEqual([25, 0xABCD]);
  });

  it('does not record when not recording', () => {
    const recorder = new ReplayRecorder();
    recorder.recordCommand({
      type: ReplayCommandType.Stop,
      player: 0,
      entities: [1],
    });
    recorder.endTick(1);
    expect(recorder.isRecording()).toBe(false);
    expect(recorder.stopRecording()).toBeNull();
  });
});

describe('ReplayPlayer', () => {
  it('plays back commands in order', () => {
    const recorder = new ReplayRecorder();
    recorder.startRecording(makeHeader());

    recorder.recordCommand({
      type: ReplayCommandType.Move,
      player: 0,
      entities: [1],
      x: 10,
      z: 20,
    });
    recorder.endTick(1);

    recorder.recordCommand({
      type: ReplayCommandType.Attack,
      player: 0,
      entities: [2],
      targetEid: 5,
    });
    recorder.endTick(3);

    const data = recorder.stopRecording()!;

    const player = new ReplayPlayer();
    player.load(data);

    const executed: ReplayCommand[] = [];
    player.setCommandHandler((cmd) => executed.push(cmd));
    player.start();

    // Tick 1 — has command
    expect(player.processTick(1)).toBe(1);
    expect(executed.length).toBe(1);
    expect(executed[0].type).toBe(ReplayCommandType.Move);

    // Tick 2 — no command
    expect(player.processTick(2)).toBe(0);
    expect(executed.length).toBe(1);

    // Tick 3 — has command
    expect(player.processTick(3)).toBe(1);
    expect(executed.length).toBe(2);
    expect(executed[1].type).toBe(ReplayCommandType.Attack);
  });

  it('stops at end tick', () => {
    const recorder = new ReplayRecorder();
    recorder.startRecording(makeHeader());
    recorder.endTick(5);
    const data = recorder.stopRecording()!;

    const player = new ReplayPlayer();
    player.load(data);
    player.start();

    expect(player.isPlaying()).toBe(true);
    player.processTick(6); // Past end
    expect(player.isPlaying()).toBe(false);
  });

  it('retrieves hash checkpoints', () => {
    const recorder = new ReplayRecorder();
    recorder.startRecording(makeHeader());
    recorder.addHashCheckpoint(25, 0xDEAD);
    recorder.endTick(30);
    const data = recorder.stopRecording()!;

    const player = new ReplayPlayer();
    player.load(data);

    expect(player.getHashCheckpoint(25)).toBe(0xDEAD);
    expect(player.getHashCheckpoint(26)).toBeNull();
  });
});

describe('Serialization', () => {
  it('round-trips replay data through JSON', () => {
    const recorder = new ReplayRecorder();
    recorder.startRecording(makeHeader());
    recorder.recordCommand({
      type: ReplayCommandType.Move,
      player: 0,
      entities: [1, 2],
      x: 50,
      z: 75,
    });
    recorder.endTick(1);
    recorder.addHashCheckpoint(1, 0xBEEF);
    const data = recorder.stopRecording()!;

    const json = serializeReplay(data);
    const restored = deserializeReplay(json);

    expect(restored.header.housePrefix).toBe('AT_');
    expect(restored.ticks.length).toBe(1);
    expect(restored.ticks[0].commands[0].x).toBe(50);
    expect(restored.hashCheckpoints[0][1]).toBe(0xBEEF);
    expect(restored.endTick).toBe(1);
  });
});
