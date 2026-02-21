import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compareOracleValues } from './oracles/comparator';
import { buildBranchOracleDataset } from './oracles/branchOracle';
import { readJsonFile, writeJsonFile } from './oracles/missionOracle';
import type { TokBranchOracleDatasetV1 } from './oracles/oracleTypes';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '../../../');
const ORACLE_FILE = path.join(TEST_DIR, 'oracles', 'tok_branch_oracle.v1.json');
const DIFF_FILE = path.join(ROOT, 'artifacts', 'oracle-diffs', 'tok_branch_oracle.diff.json');

function writeDiffReport(payload: unknown): void {
  fs.mkdirSync(path.dirname(DIFF_FILE), { recursive: true });
  fs.writeFileSync(DIFF_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

describe('Tok branch oracle', () => {
  it('matches deterministic branch scenario oracle', () => {
    const updateMode = process.env.TOK_UPDATE_ORACLES === '1';

    if (updateMode) {
      writeJsonFile(ORACLE_FILE, buildBranchOracleDataset());
    }

    if (!fs.existsSync(ORACLE_FILE)) {
      throw new Error(`Missing oracle fixture: ${ORACLE_FILE}. Run TOK_UPDATE_ORACLES=1 to generate.`);
    }

    const expected = readJsonFile<TokBranchOracleDatasetV1>(ORACLE_FILE);
    const actual = buildBranchOracleDataset();

    const expectedComparable = {
      schemaVersion: expected.schemaVersion,
      generator: expected.generator,
      scenarios: expected.scenarios,
    };
    const actualComparable = {
      schemaVersion: actual.schemaVersion,
      generator: actual.generator,
      scenarios: actual.scenarios,
    };

    const diffs = compareOracleValues(expectedComparable, actualComparable, { maxDiffs: 1 });
    if (diffs.length > 0) {
      writeDiffReport({ firstDiff: diffs[0] });
    } else if (fs.existsSync(DIFF_FILE)) {
      fs.unlinkSync(DIFF_FILE);
    }

    expect(diffs).toEqual([]);
  });
});
