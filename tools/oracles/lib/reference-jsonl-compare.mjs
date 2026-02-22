import { firstDiff } from './reference-compare.mjs';
import {
  buildSignalFromRow,
  mergeRows,
  pickScriptId,
  pickTick,
} from './reference-jsonl.mjs';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function rowKey(scriptId, tick) {
  return `${scriptId}\u0000${tick}`;
}

function parseRowKey(key) {
  const split = key.indexOf('\u0000');
  return {
    scriptId: key.slice(0, split),
    tick: Number(key.slice(split + 1)),
  };
}

function indexSignalRows(rows) {
  const index = new Map();
  for (const row of rows) {
    const scriptId = pickScriptId(row);
    const tick = pickTick(row);
    if (typeof scriptId !== 'string' || !isFiniteNumber(tick)) {
      throw new Error(`Row missing required fields {scriptId, tick}: ${JSON.stringify(row)}`);
    }
    index.set(rowKey(scriptId, tick), buildSignalFromRow(row));
  }
  return index;
}

export function rowsFromMissionOracleDataset(dataset, options = {}) {
  const scripts = options.scripts ?? 'all';
  const includeFinal = options.includeFinal !== false;
  const sourceMissions = dataset.missions ?? {};
  const selectedSet = scripts === 'fast'
    ? new Set((dataset.fastScripts ?? []).filter((scriptId) => typeof scriptId === 'string'))
    : null;

  const rows = [];
  const missionIds = Object.keys(sourceMissions).sort((a, b) => a.localeCompare(b));
  for (const scriptId of missionIds) {
    if (selectedSet && !selectedSet.has(scriptId)) continue;
    const mission = sourceMissions[scriptId];
    const byTick = new Map();

    for (const checkpoint of mission.checkpoints ?? []) {
      byTick.set(checkpoint.tick, checkpoint);
    }
    if (includeFinal && mission.final && !byTick.has(mission.final.tick)) {
      byTick.set(mission.final.tick, mission.final);
    }

    for (const tick of [...byTick.keys()].sort((a, b) => a - b)) {
      const signal = byTick.get(tick);
      rows.push({
        scriptId,
        tick,
        maxTick: mission.maxTick,
        frameCount: mission.frameCount,
        frameHash: signal.frameHash,
        intHash: signal.intHash,
        objHash: signal.objHash,
        posHash: signal.posHash,
        relHash: signal.relHash,
        eventHash: signal.eventHash,
        dispatchHash: signal.dispatchHash,
      });
    }
  }

  return rows;
}

export function compareReferenceSignalRows(referenceRows, expectedRows, options = {}) {
  const requireAllExpectedRows = options.requireAllExpectedRows === true;
  const minCoverage = isFiniteNumber(options.minCoverage) ? options.minCoverage : 0;

  const mergedReference = mergeRows(referenceRows, { prefer: 'last' }).rows;
  const mergedExpected = mergeRows(expectedRows, { prefer: 'last' }).rows;
  const referenceIndex = indexSignalRows(mergedReference);
  const expectedIndex = indexSignalRows(mergedExpected);

  const referenceKeys = [...referenceIndex.keys()].sort((a, b) => a.localeCompare(b));
  const expectedKeys = [...expectedIndex.keys()].sort((a, b) => a.localeCompare(b));
  const referenceSet = new Set(referenceKeys);
  const expectedSet = new Set(expectedKeys);

  const missingInReference = expectedKeys.filter((key) => !referenceSet.has(key));
  const unexpectedInReference = referenceKeys.filter((key) => !expectedSet.has(key));
  const comparedKeys = expectedKeys.filter((key) => referenceSet.has(key));
  const coverage = expectedKeys.length === 0 ? 1 : comparedKeys.length / expectedKeys.length;

  if (coverage < minCoverage) {
    return {
      diff: {
        path: '$.__coverage',
        expected: minCoverage,
        actual: coverage,
      },
      coverage,
      comparedRows: comparedKeys.length,
      expectedRows: expectedKeys.length,
      referenceRows: referenceKeys.length,
      missingInReference: missingInReference.map(parseRowKey),
      unexpectedInReference: unexpectedInReference.map(parseRowKey),
    };
  }

  if (requireAllExpectedRows && missingInReference.length > 0) {
    return {
      diff: {
        path: '$.__set',
        expected: expectedKeys,
        actual: referenceKeys,
      },
      coverage,
      comparedRows: comparedKeys.length,
      expectedRows: expectedKeys.length,
      referenceRows: referenceKeys.length,
      missingInReference: missingInReference.map(parseRowKey),
      unexpectedInReference: unexpectedInReference.map(parseRowKey),
    };
  }

  for (const key of comparedKeys) {
    const expected = expectedIndex.get(key);
    const actual = referenceIndex.get(key);
    const diff = firstDiff(expected, actual, '$.signal');
    if (diff) {
      const parsed = parseRowKey(key);
      return {
        diff: {
          path: `$.missions.${parsed.scriptId}[tick=${parsed.tick}]${diff.path.slice('$.signal'.length)}`,
          expected: diff.expected,
          actual: diff.actual,
        },
        coverage,
        comparedRows: comparedKeys.length,
        expectedRows: expectedKeys.length,
        referenceRows: referenceKeys.length,
        missingInReference: missingInReference.map(parseRowKey),
        unexpectedInReference: unexpectedInReference.map(parseRowKey),
      };
    }
  }

  return {
    diff: null,
    coverage,
    comparedRows: comparedKeys.length,
    expectedRows: expectedKeys.length,
    referenceRows: referenceKeys.length,
    missingInReference: missingInReference.map(parseRowKey),
    unexpectedInReference: unexpectedInReference.map(parseRowKey),
  };
}
