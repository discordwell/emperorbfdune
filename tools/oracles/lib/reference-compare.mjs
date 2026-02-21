function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function missionPath(scriptId) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(scriptId)) {
    return `$.missions.${scriptId}`;
  }
  return `$.missions[${JSON.stringify(scriptId)}]`;
}

export function firstDiff(expected, actual, root = '$') {
  if (expected === actual) return null;
  if (typeof expected !== typeof actual) {
    return { path: root, expected, actual };
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return { path: root, expected, actual };
    }
    if (expected.length !== actual.length) {
      return { path: `${root}.length`, expected: expected.length, actual: actual.length };
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = firstDiff(expected[i], actual[i], `${root}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  if (isPlainObject(expected) || isPlainObject(actual)) {
    if (!isPlainObject(expected) || !isPlainObject(actual)) {
      return { path: root, expected, actual };
    }

    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (expectedKeys.length !== actualKeys.length) {
      return { path: `${root}.__keys`, expected: expectedKeys, actual: actualKeys };
    }

    for (let i = 0; i < expectedKeys.length; i++) {
      if (expectedKeys[i] !== actualKeys[i]) {
        return {
          path: `${root}.__keys[${i}]`,
          expected: expectedKeys[i],
          actual: actualKeys[i],
        };
      }
    }

    for (const key of expectedKeys) {
      const diff = firstDiff(expected[key], actual[key], `${root}.${key}`);
      if (diff) return diff;
    }
    return null;
  }

  return { path: root, expected, actual };
}

function validateSignal(signal, path, errors) {
  if (!isPlainObject(signal)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isFiniteNumber(signal.tick)) errors.push(`${path}.tick must be a finite number`);
  if (!isHash(signal.frameHash)) errors.push(`${path}.frameHash must be a 64-char hex hash`);
  if (!isHash(signal.intHash)) errors.push(`${path}.intHash must be a 64-char hex hash`);
  if (!isHash(signal.objHash)) errors.push(`${path}.objHash must be a 64-char hex hash`);
  if (!isHash(signal.posHash)) errors.push(`${path}.posHash must be a 64-char hex hash`);
  if (!isHash(signal.relHash)) errors.push(`${path}.relHash must be a 64-char hex hash`);
  if (!isHash(signal.eventHash)) errors.push(`${path}.eventHash must be a 64-char hex hash`);
  if (!isHash(signal.dispatchHash)) errors.push(`${path}.dispatchHash must be a 64-char hex hash`);
}

function validateMission(entry, scriptId, errors) {
  const path = missionPath(scriptId);
  if (!isPlainObject(entry)) {
    errors.push(`${path} must be an object`);
    return;
  }

  if (entry.scriptId !== scriptId) {
    errors.push(`${path}.scriptId must equal key ${JSON.stringify(scriptId)}`);
  }
  if (!isFiniteNumber(entry.maxTick)) errors.push(`${path}.maxTick must be a finite number`);
  if (!isFiniteNumber(entry.frameCount)) errors.push(`${path}.frameCount must be a finite number`);
  if (!Array.isArray(entry.checkpoints)) {
    errors.push(`${path}.checkpoints must be an array`);
  } else {
    for (let i = 0; i < entry.checkpoints.length; i++) {
      validateSignal(entry.checkpoints[i], `${path}.checkpoints[${i}]`, errors);
    }
  }
  validateSignal(entry.final, `${path}.final`, errors);
}

export function validateMissionOracleDataset(dataset, label = 'dataset') {
  const errors = [];
  const root = `$${label ? `(${label})` : ''}`;

  if (!isPlainObject(dataset)) {
    return { valid: false, errors: [`${root} must be an object`] };
  }

  if (!isFiniteNumber(dataset.schemaVersion)) errors.push(`${root}.schemaVersion must be a finite number`);
  if (typeof dataset.generator !== 'string') errors.push(`${root}.generator must be a string`);
  if (typeof dataset.generatedAt !== 'string') errors.push(`${root}.generatedAt must be a string`);
  if (!isFiniteNumber(dataset.seed)) errors.push(`${root}.seed must be a finite number`);
  if (!isFiniteNumber(dataset.defaultMaxTick)) errors.push(`${root}.defaultMaxTick must be a finite number`);
  if (!isFiniteNumber(dataset.headerMaxTick)) errors.push(`${root}.headerMaxTick must be a finite number`);
  if (!isFiniteNumber(dataset.checkpointStride)) errors.push(`${root}.checkpointStride must be a finite number`);
  if (!Array.isArray(dataset.fastScripts) || !dataset.fastScripts.every((s) => typeof s === 'string')) {
    errors.push(`${root}.fastScripts must be an array of strings`);
  }

  if (!isPlainObject(dataset.missions)) {
    errors.push(`${root}.missions must be an object`);
  } else {
    for (const [scriptId, mission] of Object.entries(dataset.missions)) {
      validateMission(mission, scriptId, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function pickComparableTopLevel(dataset) {
  return {
    schemaVersion: dataset.schemaVersion,
    seed: dataset.seed,
    defaultMaxTick: dataset.defaultMaxTick,
    headerMaxTick: dataset.headerMaxTick,
    checkpointStride: dataset.checkpointStride,
  };
}

export function compareMissionOracleDatasets(reference, internal, options = {}) {
  const requireAllMissions = options.requireAllMissions === true;
  const minCoverage = isFiniteNumber(options.minCoverage) ? options.minCoverage : 0;

  const referenceMissionIds = Object.keys(reference.missions ?? {}).sort((a, b) => a.localeCompare(b));
  const internalMissionIds = Object.keys(internal.missions ?? {}).sort((a, b) => a.localeCompare(b));

  const internalSet = new Set(internalMissionIds);
  const referenceSet = new Set(referenceMissionIds);
  const missingInInternal = referenceMissionIds.filter((id) => !internalSet.has(id));
  const missingInReference = internalMissionIds.filter((id) => !referenceSet.has(id));
  const comparedMissionIds = referenceMissionIds.filter((id) => internalSet.has(id));
  const coverage = referenceMissionIds.length === 0 ? 1 : comparedMissionIds.length / referenceMissionIds.length;

  const topLevelDiff = firstDiff(pickComparableTopLevel(reference), pickComparableTopLevel(internal), '$');
  if (topLevelDiff) {
    return {
      diff: topLevelDiff,
      missingInInternal,
      missingInReference,
      comparedMissionIds,
      coverage,
    };
  }

  if (coverage < minCoverage) {
    return {
      diff: {
        path: '$.missions.__coverage',
        expected: minCoverage,
        actual: coverage,
      },
      missingInInternal,
      missingInReference,
      comparedMissionIds,
      coverage,
    };
  }

  if (requireAllMissions && (missingInInternal.length > 0 || missingInReference.length > 0)) {
    return {
      diff: {
        path: '$.missions.__set',
        expected: referenceMissionIds,
        actual: internalMissionIds,
      },
      missingInInternal,
      missingInReference,
      comparedMissionIds,
      coverage,
    };
  }

  for (const scriptId of comparedMissionIds) {
    const diff = firstDiff(
      reference.missions[scriptId],
      internal.missions[scriptId],
      missionPath(scriptId),
    );
    if (diff) {
      return {
        diff,
        missingInInternal,
        missingInReference,
        comparedMissionIds,
        coverage,
      };
    }
  }

  return {
    diff: null,
    missingInInternal,
    missingInReference,
    comparedMissionIds,
    coverage,
  };
}
