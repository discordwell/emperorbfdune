import fs from 'node:fs';
import path from 'node:path';

import type { TokTraceFrame } from '../traceHarness';
import { runFreshMissionTrace, runMissionTraceWithRestore } from '../traceHarness';
import { sha256Hex } from './hash';
import type {
  TokCheckpointSignalV1,
  TokMissionOracleDatasetV1,
  TokMissionOracleEntryV1,
} from './oracleTypes';
import { TOK_ORACLE_SCHEMA_VERSION } from './oracleTypes';

export const DEFAULT_MISSION_ORACLE_SEED = 9001;
export const DEFAULT_MAX_TICK = 80;
export const HEADER_MAX_TICK = 8;
export const DEFAULT_CHECKPOINT_STRIDE = 20;

// Small PR gate subset with broad coverage across houses/branches/complexity.
export const FAST_MISSION_SCRIPTS = [
  'ATP1D1FRFail',
  'ATP1D1FR',
  'ATP1D3SA',
  'ATP3D10FR',
  'ATStart',
  'ATTutorial',
  'HKP1M4SA',
  'HKP2M17TL',
  'HKStart',
  'ORP1M13OR',
  'ORP2M18TL',
  'ORP3D10TL',
  'ORStart',
  'Ordos Homeworld Defense',
  'Atreides Heighliner Mission',
  'HHK Civil War Defence Mission',
  'HKENDMission',
  'ORENDMission',
  'header',
] as const;

export interface BuildMissionDatasetOptions {
  scriptIds: string[];
  seed?: number;
  defaultMaxTick?: number;
  headerMaxTick?: number;
  checkpointStride?: number;
  fastScripts?: string[];
}

export function discoverScriptIds(tokDir: string): string[] {
  return fs.readdirSync(tokDir)
    .filter((f) => f.endsWith('.tok'))
    .map((f) => f.replace(/\.tok$/i, ''))
    .sort((a, b) => a.localeCompare(b));
}

export function buildMissionOracleDataset(options: BuildMissionDatasetOptions): TokMissionOracleDatasetV1 {
  const seed = options.seed ?? DEFAULT_MISSION_ORACLE_SEED;
  const defaultMaxTick = options.defaultMaxTick ?? DEFAULT_MAX_TICK;
  const headerMaxTick = options.headerMaxTick ?? HEADER_MAX_TICK;
  const checkpointStride = options.checkpointStride ?? DEFAULT_CHECKPOINT_STRIDE;

  const missions: Record<string, TokMissionOracleEntryV1> = {};
  for (const scriptId of options.scriptIds) {
    const maxTick = scriptId === 'header' ? headerMaxTick : defaultMaxTick;
    missions[scriptId] = buildMissionOracleEntry(scriptId, maxTick, seed, checkpointStride);
  }

  return {
    schemaVersion: TOK_ORACLE_SCHEMA_VERSION,
    generator: 'tok-mission-oracle-v1',
    generatedAt: new Date().toISOString(),
    seed,
    defaultMaxTick,
    headerMaxTick,
    checkpointStride,
    fastScripts: (options.fastScripts ?? [...FAST_MISSION_SCRIPTS]).filter((s) => missions[s]),
    missions,
  };
}

export function buildMissionOracleEntry(
  scriptId: string,
  maxTick: number,
  seed: number,
  checkpointStride: number,
): TokMissionOracleEntryV1 {
  const frames = runFreshMissionTrace(scriptId, maxTick, seed);
  const checkpoints = collectCheckpointSignals(frames, checkpointStride);

  const finalFrame = frames[frames.length - 1];
  if (!finalFrame) {
    throw new Error(`No frames captured for mission ${scriptId}`);
  }

  return {
    scriptId,
    maxTick,
    frameCount: frames.length,
    checkpoints,
    final: signalFromFrame(finalFrame),
  };
}

function collectCheckpointSignals(frames: TokTraceFrame[], stride: number): TokCheckpointSignalV1[] {
  const checkpoints: TokCheckpointSignalV1[] = [];
  for (const frame of frames) {
    if (frame.tick % stride !== 0) continue;
    checkpoints.push(signalFromFrame(frame));
  }

  const final = frames[frames.length - 1];
  if (final && (checkpoints.length === 0 || checkpoints[checkpoints.length - 1].tick !== final.tick)) {
    checkpoints.push(signalFromFrame(final));
  }

  return checkpoints;
}

function signalFromFrame(frame: TokTraceFrame): TokCheckpointSignalV1 {
  return {
    tick: frame.tick,
    frameHash: sha256Hex(frame),
    intHash: sha256Hex(frame.intVars),
    objHash: sha256Hex(frame.objVars),
    posHash: sha256Hex(frame.posVars),
    relHash: sha256Hex(frame.relationships),
    eventHash: sha256Hex(frame.eventFlags),
    dispatchHash: sha256Hex(frame.dispatch),
  };
}

export function buildSaveRestoreFinalHash(scriptId: string, maxTick: number, saveTick: number, seed: number): string {
  const frames = runMissionTraceWithRestore(scriptId, maxTick, saveTick, seed);
  const final = frames[frames.length - 1];
  if (!final) throw new Error(`No frames for save/restore trace ${scriptId}`);
  return sha256Hex(final);
}

export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}
