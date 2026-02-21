import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compareOracleValues } from './oracles/comparator';
import { readJsonFile, writeJsonFile } from './oracles/missionOracle';
import {
  buildSimulationHashDataset,
  discoverSimHashScriptIds,
} from './oracles/simulationHashOracle';
import type { TokSimulationHashDatasetV1 } from './oracles/oracleTypes';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const ORACLE_FILE = path.join(TEST_DIR, 'oracles', 'tok_simhash_oracle.v1.json');
const DIFF_FILE = path.join(ROOT, 'artifacts', 'oracle-diffs', 'tok_simhash_oracle.diff.json');

function writeDiffReport(payload: unknown): void {
  fs.mkdirSync(path.dirname(DIFF_FILE), { recursive: true });
  fs.writeFileSync(DIFF_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildSubsetDataset(expected: TokSimulationHashDatasetV1, scriptIds: string[]): TokSimulationHashDatasetV1 {
  return {
    schemaVersion: expected.schemaVersion,
    generator: expected.generator,
    generatedAt: expected.generatedAt,
    seed: expected.seed,
    defaultMaxTick: expected.defaultMaxTick,
    headerMaxTick: expected.headerMaxTick,
    checkpointStride: expected.checkpointStride,
    fastScripts: expected.fastScripts.filter((s) => scriptIds.includes(s)),
    missions: Object.fromEntries(scriptIds.map((id) => [id, expected.missions[id]])),
  };
}

describe('Tok simulation-hash oracle', () => {
  it('matches simulation hash checkpoints for mission matrix', () => {
    const updateMode = process.env.TOK_UPDATE_ORACLES === '1';
    const fullMode = updateMode || process.env.TOK_ORACLE_FULL === '1';
    const allScripts = discoverSimHashScriptIds();

    if (updateMode) {
      writeJsonFile(ORACLE_FILE, buildSimulationHashDataset({ scriptIds: allScripts }));
    }

    if (!fs.existsSync(ORACLE_FILE)) {
      throw new Error(`Missing oracle fixture: ${ORACLE_FILE}. Run TOK_UPDATE_ORACLES=1 to generate.`);
    }

    const expected = readJsonFile<TokSimulationHashDatasetV1>(ORACLE_FILE);
    const selected = fullMode
      ? allScripts
      : expected.fastScripts.filter((s) => expected.missions[s] !== undefined);

    const actual = buildSimulationHashDataset({
      scriptIds: selected,
      seed: expected.seed,
      defaultMaxTick: expected.defaultMaxTick,
      headerMaxTick: expected.headerMaxTick,
      checkpointStride: expected.checkpointStride,
      fastScripts: expected.fastScripts,
    });
    const expectedSubset = buildSubsetDataset(expected, selected);

    const expectedComparable = { ...expectedSubset, generatedAt: '' };
    const actualComparable = { ...actual, generatedAt: '' };
    const diffs = compareOracleValues(expectedComparable, actualComparable, { maxDiffs: 1 });
    if (diffs.length > 0) {
      writeDiffReport({
        mode: fullMode ? 'full' : 'fast',
        selectedCount: selected.length,
        firstDiff: diffs[0],
      });
    } else if (fs.existsSync(DIFF_FILE)) {
      fs.unlinkSync(DIFF_FILE);
    }

    expect(diffs).toEqual([]);
  });
});
