import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isHexHash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

export function sha256Hex(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function pickScriptId(row) {
  return row.scriptId ?? row.mission ?? row.file ?? row.s;
}

export function pickTick(row) {
  return row.tick ?? row.t;
}

function pickField(row, longName, shortName, fallback) {
  const value = row[longName];
  if (value !== undefined) return value;
  const short = row[shortName];
  if (short !== undefined) return short;
  return fallback;
}

function pickFiniteNumberOrNull(row, longName, shortName) {
  const value = row[longName] ?? row[shortName];
  if (value === undefined || value === null) return null;
  if (!isFiniteNumber(value)) {
    throw new Error(`${longName} must be a finite number when present: ${JSON.stringify(value)}`);
  }
  return value;
}

function pickHash(row, longName, shortName) {
  const value = row[longName] ?? row[shortName];
  if (value === undefined) return null;
  if (!isHexHash(value)) {
    throw new Error(`${longName} must be a 64-char hex hash, got ${JSON.stringify(value)}`);
  }
  return value.toLowerCase();
}

export function canonicalFrameFromRow(row) {
  const scriptId = pickScriptId(row);
  const tick = pickTick(row);
  if (typeof scriptId !== 'string' || !isFiniteNumber(tick)) {
    throw new Error(`Row missing required fields {scriptId, tick}: ${JSON.stringify(row)}`);
  }

  const nextSideId = pickField(row, 'nextSideId', 'n', 0);
  if (!isFiniteNumber(nextSideId)) {
    throw new Error(`nextSideId must be finite number when present: ${JSON.stringify(row)}`);
  }

  // Keep key order aligned with TokTraceFrame hashing used by internal oracle.
  return {
    tick,
    intVars: pickField(row, 'intVars', 'i', []),
    objVars: pickField(row, 'objVars', 'o', []),
    posVars: pickField(row, 'posVars', 'p', []),
    nextSideId,
    relationships: pickField(row, 'relationships', 'r', []),
    eventFlags: pickField(row, 'eventFlags', 'e', []),
    dispatch: pickField(row, 'dispatch', 'd', {}),
  };
}

export function pickDeclaredFrameCount(row) {
  return pickFiniteNumberOrNull(row, 'frameCount', 'fc');
}

export function pickDeclaredMaxTick(row) {
  return pickFiniteNumberOrNull(row, 'maxTick', 'mt');
}

export function buildSignalFromRow(row) {
  const frame = canonicalFrameFromRow(row);

  return {
    tick: frame.tick,
    frameHash: pickHash(row, 'frameHash', 'fh') ?? sha256Hex(frame),
    intHash: pickHash(row, 'intHash', 'ih') ?? sha256Hex(frame.intVars),
    objHash: pickHash(row, 'objHash', 'oh') ?? sha256Hex(frame.objVars),
    posHash: pickHash(row, 'posHash', 'ph') ?? sha256Hex(frame.posVars),
    relHash: pickHash(row, 'relHash', 'rh') ?? sha256Hex(frame.relationships),
    eventHash: pickHash(row, 'eventHash', 'eh') ?? sha256Hex(frame.eventFlags),
    dispatchHash: pickHash(row, 'dispatchHash', 'dh') ?? sha256Hex(frame.dispatch),
  };
}

export function parseJsonLine(line, lineNo, sourceLabel = 'input') {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(`${sourceLabel}:${lineNo} invalid JSON: ${String(err)}`);
  }
}

export function readJsonLines(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].trim();
    if (!line) continue;
    rows.push(parseJsonLine(line, i + 1, filePath));
  }
  return rows;
}

export function writeJsonLines(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${text}${text.length ? '\n' : ''}`, 'utf8');
}

export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function mergeRows(rows, options = {}) {
  const prefer = options.prefer ?? 'last';
  const strictConflicts = options.strictConflicts === true;
  const mergedByKey = new Map();
  const conflicts = [];

  for (const row of rows) {
    const scriptId = pickScriptId(row);
    const tick = pickTick(row);
    if (typeof scriptId !== 'string' || !isFiniteNumber(tick)) {
      throw new Error(`Row missing required fields {scriptId, tick}: ${JSON.stringify(row)}`);
    }
    const key = `${scriptId}\u0000${tick}`;
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, row);
      continue;
    }

    const same = JSON.stringify(existing) === JSON.stringify(row);
    if (!same) {
      conflicts.push({ scriptId, tick, previous: existing, next: row });
      if (strictConflicts) {
        throw new Error(`Conflicting duplicate at ${scriptId}@${tick}`);
      }
    }
    if (prefer === 'last') {
      mergedByKey.set(key, row);
    }
  }

  const rowsOut = [...mergedByKey.values()].sort((a, b) => {
    const sa = pickScriptId(a);
    const sb = pickScriptId(b);
    if (sa !== sb) return sa.localeCompare(sb);
    return pickTick(a) - pickTick(b);
  });

  return { rows: rowsOut, conflicts };
}

export function buildMissionOracleDatasetFromRows(rows, options = {}) {
  const stride = options.checkpointStride ?? 20;
  const seed = options.seed ?? 9001;
  const defaultMaxTick = options.defaultMaxTick ?? 80;
  const headerMaxTick = options.headerMaxTick ?? 8;
  const fastScripts = options.fastScripts ?? [];
  const grouped = new Map();

  for (const row of rows) {
    const scriptId = pickScriptId(row);
    const tick = pickTick(row);
    if (typeof scriptId !== 'string' || !isFiniteNumber(tick)) {
      throw new Error(`Row missing required fields {scriptId, tick}: ${JSON.stringify(row)}`);
    }
    const list = grouped.get(scriptId) ?? [];
    list.push(row);
    grouped.set(scriptId, list);
  }

  const missions = {};
  const missionIds = [...grouped.keys()].sort((a, b) => a.localeCompare(b));
  for (const scriptId of missionIds) {
    const rowsForMission = grouped.get(scriptId).slice().sort((a, b) => pickTick(a) - pickTick(b));
    let declaredFrameCount = null;
    let declaredMaxTick = null;
    for (const row of rowsForMission) {
      const fc = pickDeclaredFrameCount(row);
      if (fc !== null) declaredFrameCount = declaredFrameCount === null ? fc : Math.max(declaredFrameCount, fc);
      const mt = pickDeclaredMaxTick(row);
      if (mt !== null) declaredMaxTick = declaredMaxTick === null ? mt : Math.max(declaredMaxTick, mt);
    }

    const checkpoints = [];
    for (const row of rowsForMission) {
      const tick = pickTick(row);
      if (tick % stride !== 0) continue;
      checkpoints.push(buildSignalFromRow(row));
    }

    const finalRow = rowsForMission[rowsForMission.length - 1];
    const final = buildSignalFromRow(finalRow);
    if (declaredMaxTick !== null && final.tick !== declaredMaxTick) {
      throw new Error(`Mission ${scriptId} final tick ${final.tick} != declared maxTick ${declaredMaxTick}`);
    }

    const missionMaxTick = declaredMaxTick ?? final.tick;
    if (!checkpoints.length || checkpoints[checkpoints.length - 1].tick !== final.tick) {
      checkpoints.push(final);
    }

    missions[scriptId] = {
      scriptId,
      maxTick: missionMaxTick,
      frameCount: declaredFrameCount ?? rowsForMission.length,
      checkpoints,
      final,
    };
  }

  return {
    schemaVersion: 1,
    generator: options.generator ?? 'external-reference-normalizer-v2',
    generatedAt: new Date().toISOString(),
    seed,
    defaultMaxTick,
    headerMaxTick,
    checkpointStride: stride,
    fastScripts: fastScripts.filter((scriptId) => missions[scriptId]),
    missions,
  };
}

export function buildCaptureManifestFromOracleDataset(dataset, options = {}) {
  const scripts = options.scripts ?? 'all';
  const sourceMissions = Object.entries(dataset.missions ?? {})
    .map(([scriptId, entry]) => ({
      scriptId,
      maxTick: entry.maxTick,
      frameCount: entry.frameCount ?? (entry.maxTick + 1),
    }))
    .sort((a, b) => a.scriptId.localeCompare(b.scriptId));

  const selectedSet = scripts === 'fast'
    ? new Set((dataset.fastScripts ?? []).filter((s) => typeof s === 'string'))
    : null;

  const missions = sourceMissions
    .filter((m) => selectedSet ? selectedSet.has(m.scriptId) : true)
    .map((mission) => {
      const checkpointTicks = [];
      const stride = dataset.checkpointStride ?? 20;
      for (let tick = 0; tick <= mission.maxTick; tick += stride) {
        checkpointTicks.push(tick);
      }
      if (!checkpointTicks.length || checkpointTicks[checkpointTicks.length - 1] !== mission.maxTick) {
        checkpointTicks.push(mission.maxTick);
      }
      return {
        scriptId: mission.scriptId,
        maxTick: mission.maxTick,
        frameCount: mission.frameCount,
        checkpointTicks,
      };
    });

  return {
    schemaVersion: 1,
    generator: 'tok-reference-capture-manifest-v1',
    generatedAt: new Date().toISOString(),
    seed: dataset.seed,
    defaultMaxTick: dataset.defaultMaxTick,
    headerMaxTick: dataset.headerMaxTick,
    checkpointStride: dataset.checkpointStride,
    missionCount: missions.length,
    missions,
  };
}

export function validateReferenceRows(rows, options = {}) {
  const expectedMissionMax = options.expectedMissionMax ?? {};
  const requireAllMissions = options.requireAllMissions === true;
  const requireTickZero = options.requireTickZero !== false;
  const requireExpectedMaxTick = options.requireExpectedMaxTick === true;

  const errors = [];
  const warnings = [];
  const missions = new Map();
  const duplicates = [];

  for (const row of rows) {
    const scriptId = pickScriptId(row);
    const tick = pickTick(row);
    if (typeof scriptId !== 'string' || !isFiniteNumber(tick)) {
      errors.push(`Invalid row missing {scriptId, tick}: ${JSON.stringify(row)}`);
      continue;
    }
    const mission = missions.get(scriptId) ?? {
      ticks: [],
      rows: 0,
      declaredMaxTick: null,
      declaredFrameCount: null,
    };
    mission.ticks.push(tick);
    mission.rows++;
    const rowMaxTick = pickDeclaredMaxTick(row);
    if (rowMaxTick !== null) {
      mission.declaredMaxTick = mission.declaredMaxTick === null
        ? rowMaxTick
        : Math.max(mission.declaredMaxTick, rowMaxTick);
    }
    const rowFrameCount = pickDeclaredFrameCount(row);
    if (rowFrameCount !== null) {
      mission.declaredFrameCount = mission.declaredFrameCount === null
        ? rowFrameCount
        : Math.max(mission.declaredFrameCount, rowFrameCount);
    }
    missions.set(scriptId, mission);
  }

  for (const [scriptId, mission] of missions.entries()) {
    const tickSet = new Set();
    let hasTickZero = false;
    for (const tick of mission.ticks) {
      if (tick === 0) hasTickZero = true;
      if (tickSet.has(tick)) duplicates.push({ scriptId, tick });
      tickSet.add(tick);
    }

    if (requireTickZero && !hasTickZero) {
      errors.push(`${scriptId} missing tick 0`);
    }

    const maxCapturedTick = Math.max(...mission.ticks);
    const maxCaptured = mission.declaredMaxTick ?? maxCapturedTick;
    const expectedMax = expectedMissionMax[scriptId];
    if (isFiniteNumber(expectedMax)) {
      if (maxCaptured < expectedMax) {
        const msg = `${scriptId} max tick ${maxCaptured} < expected ${expectedMax}`;
        if (requireExpectedMaxTick) errors.push(msg);
        else warnings.push(msg);
      }
    }

    if (mission.declaredFrameCount !== null && mission.declaredFrameCount < maxCaptured + 1) {
      errors.push(`${scriptId} declared frameCount ${mission.declaredFrameCount} < maxTick+1 (${maxCaptured + 1})`);
    }
  }

  if (duplicates.length > 0) {
    warnings.push(`Detected ${duplicates.length} duplicate mission+tick rows`);
  }

  const expectedMissionIds = Object.keys(expectedMissionMax).sort((a, b) => a.localeCompare(b));
  const capturedMissionIds = [...missions.keys()].sort((a, b) => a.localeCompare(b));
  const capturedSet = new Set(capturedMissionIds);
  const missingMissions = expectedMissionIds.filter((id) => !capturedSet.has(id));
  if (requireAllMissions && missingMissions.length > 0) {
    errors.push(`Missing expected missions: ${missingMissions.join(', ')}`);
  }

  const coverage = expectedMissionIds.length === 0
    ? 1
    : (expectedMissionIds.length - missingMissions.length) / expectedMissionIds.length;

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    totalRows: rows.length,
    missionCount: capturedMissionIds.length,
    coverage,
    duplicateCount: duplicates.length,
    missingMissions,
    expectedMissionCount: expectedMissionIds.length,
    capturedMissionCount: capturedMissionIds.length,
  };
}
