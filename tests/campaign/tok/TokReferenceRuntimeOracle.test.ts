import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  compareMissionOracleDatasets,
  validateMissionOracleDataset,
} from '../../../tools/oracles/lib/reference-compare.mjs';
import {
  buildMissionOracleEntry,
  readJsonFile,
  writeJsonFile,
} from './oracles/missionOracle';
import type {
  TokCheckpointSignalV1,
  TokMissionOracleDatasetV1,
  TokMissionOracleEntryV1,
} from './oracles/oracleTypes';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const REFERENCE_FILE = path.join(ROOT, 'tools/oracles/reference/tok_mission_oracle.reference.v1.json');
const REPORT_FILE = path.join(ROOT, 'artifacts/oracle-diffs/reference_runtime_vs_internal.report.json');
const DIFF_FILE = path.join(ROOT, 'artifacts/oracle-diffs/reference_runtime_vs_internal.diff.json');
const FALLBACK_FAST_LIMIT = 12;

function boolEnv(name: string): boolean {
  return process.env[name] === '1';
}

function intEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function removeIfExists(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function subsetDataset(
  source: TokMissionOracleDatasetV1,
  scriptIds: string[],
  missions: Record<string, TokMissionOracleEntryV1>,
): TokMissionOracleDatasetV1 {
  return {
    schemaVersion: source.schemaVersion,
    generator: source.generator,
    generatedAt: source.generatedAt,
    seed: source.seed,
    defaultMaxTick: source.defaultMaxTick,
    headerMaxTick: source.headerMaxTick,
    checkpointStride: source.checkpointStride,
    fastScripts: source.fastScripts.filter((scriptId) => scriptIds.includes(scriptId)),
    missions,
  };
}

function selectReferenceScriptIds(
  reference: TokMissionOracleDatasetV1,
  fullMode: boolean,
  maxMissions: number | null,
): string[] {
  const allScriptIds = Object.keys(reference.missions).sort((a, b) => a.localeCompare(b));
  let selected = fullMode
    ? allScriptIds
    : reference.fastScripts.filter((scriptId) => reference.missions[scriptId] !== undefined);

  if (selected.length === 0) {
    selected = allScriptIds.slice(0, FALLBACK_FAST_LIMIT);
  }

  if (maxMissions !== null && selected.length > maxMissions) {
    selected = selected.slice(0, maxMissions);
  }

  return selected;
}

function checkpointMap(entry: TokMissionOracleEntryV1): Map<number, TokCheckpointSignalV1> {
  return new Map(entry.checkpoints.map((checkpoint) => [checkpoint.tick, checkpoint]));
}

function projectInternalEntryToReference(
  referenceEntry: TokMissionOracleEntryV1,
  internalEntry: TokMissionOracleEntryV1,
): TokMissionOracleEntryV1 {
  const internalByTick = checkpointMap(internalEntry);
  const checkpoints = referenceEntry.checkpoints.map((checkpoint) => {
    const matched = internalByTick.get(checkpoint.tick);
    if (!matched) {
      throw new Error(
        `Internal trace missing checkpoint tick ${checkpoint.tick} for mission ${referenceEntry.scriptId}`,
      );
    }
    return matched;
  });

  const final = checkpointMap({
    ...internalEntry,
    checkpoints: [...internalEntry.checkpoints, internalEntry.final],
  }).get(referenceEntry.final.tick);

  if (!final) {
    throw new Error(
      `Internal trace missing final tick ${referenceEntry.final.tick} for mission ${referenceEntry.scriptId}`,
    );
  }

  return {
    scriptId: referenceEntry.scriptId,
    maxTick: referenceEntry.maxTick,
    frameCount: referenceEntry.frameCount,
    checkpoints,
    final,
  };
}

describe('Tok external reference runtime parity', () => {
  it('replays current interpreter and compares against external checkpoint oracle when available', () => {
    const requireReference = boolEnv('TOK_REFERENCE_REQUIRE');
    const fullMode = boolEnv('TOK_REFERENCE_FULL');
    const emitReport = boolEnv('TOK_REFERENCE_REPORT');
    const maxMissions = intEnv('TOK_REFERENCE_MAX_MISSIONS');

    if (!fs.existsSync(REFERENCE_FILE)) {
      if (requireReference || emitReport) {
        writeJsonFile(REPORT_FILE, {
          status: 'missing-reference',
          referenceFile: REFERENCE_FILE,
          requireReference,
          fullMode,
          maxMissions,
        });
      } else {
        removeIfExists(REPORT_FILE);
      }
      if (requireReference) {
        throw new Error(`Missing reference oracle file: ${REFERENCE_FILE}`);
      }
      removeIfExists(DIFF_FILE);
      return;
    }

    const reference = readJsonFile<TokMissionOracleDatasetV1>(REFERENCE_FILE);
    const referenceValidation = validateMissionOracleDataset(reference, 'reference');
    if (!referenceValidation.valid) {
      writeJsonFile(REPORT_FILE, {
        status: 'invalid-reference',
        referenceFile: REFERENCE_FILE,
        errors: referenceValidation.errors,
      });
      throw new Error(`Reference oracle schema validation failed (${referenceValidation.errors.length} errors).`);
    }

    const selectedScriptIds = selectReferenceScriptIds(reference, fullMode, maxMissions);
    expect(selectedScriptIds.length).toBeGreaterThan(0);

    const internalMissions: Record<string, TokMissionOracleEntryV1> = {};
    for (const scriptId of selectedScriptIds) {
      const referenceEntry = reference.missions[scriptId];
      const replayedEntry = buildMissionOracleEntry(
        scriptId,
        referenceEntry.maxTick,
        reference.seed,
        reference.checkpointStride,
      );
      internalMissions[scriptId] = projectInternalEntryToReference(referenceEntry, replayedEntry);
    }

    const referenceSubset = subsetDataset(
      reference,
      selectedScriptIds,
      Object.fromEntries(selectedScriptIds.map((scriptId) => [scriptId, reference.missions[scriptId]])),
    );
    const internal = {
      schemaVersion: reference.schemaVersion,
      generator: 'tok-runtime-reference-compare-v1',
      generatedAt: new Date().toISOString(),
      seed: reference.seed,
      defaultMaxTick: reference.defaultMaxTick,
      headerMaxTick: reference.headerMaxTick,
      checkpointStride: reference.checkpointStride,
      fastScripts: reference.fastScripts.filter((scriptId) => selectedScriptIds.includes(scriptId)),
      missions: internalMissions,
    } satisfies TokMissionOracleDatasetV1;

    const result = compareMissionOracleDatasets(referenceSubset, internal, {
      requireAllMissions: true,
      minCoverage: 1,
    });

    if (result.diff || emitReport) {
      writeJsonFile(REPORT_FILE, {
        status: result.diff ? 'mismatch' : 'match',
        referenceFile: REFERENCE_FILE,
        fullMode,
        maxMissions,
        selectedMissionCount: selectedScriptIds.length,
        selectedScriptIds,
        coverage: result.coverage,
        missingInInternal: result.missingInInternal,
        missingInReference: result.missingInReference,
        diff: result.diff,
      });
    } else {
      removeIfExists(REPORT_FILE);
    }

    if (result.diff) {
      writeJsonFile(DIFF_FILE, result.diff);
      throw new Error(`Reference runtime mismatch at ${result.diff.path}`);
    }

    removeIfExists(DIFF_FILE);
  });
});
