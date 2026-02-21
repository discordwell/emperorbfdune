import { pickScriptId, pickTick } from './reference-jsonl.mjs';

function asMissionMap(manifest) {
  const missions = manifest?.missions;
  if (!Array.isArray(missions)) {
    throw new Error('Manifest must contain missions[]');
  }
  const out = new Map();
  for (const mission of missions) {
    if (!mission || typeof mission.scriptId !== 'string') {
      throw new Error('Manifest mission missing scriptId');
    }
    if (!Array.isArray(mission.checkpointTicks)) {
      throw new Error(`Manifest mission ${mission.scriptId} missing checkpointTicks[]`);
    }
    out.set(mission.scriptId, mission);
  }
  return out;
}

export function buildCaptureProgress(rows, manifest) {
  const manifestMissions = asMissionMap(manifest);
  const rowTicksByMission = new Map();

  for (const row of rows) {
    const scriptId = pickScriptId(row);
    const tick = pickTick(row);
    if (typeof scriptId !== 'string' || typeof tick !== 'number' || !Number.isFinite(tick)) {
      continue;
    }
    const ticks = rowTicksByMission.get(scriptId) ?? new Set();
    ticks.add(tick);
    rowTicksByMission.set(scriptId, ticks);
  }

  const missionRows = [];
  let requiredCheckpoints = 0;
  let capturedCheckpoints = 0;
  let fullyCapturedMissions = 0;

  for (const [scriptId, mission] of [...manifestMissions.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const required = [...mission.checkpointTicks].sort((a, b) => a - b);
    const capturedTicks = rowTicksByMission.get(scriptId) ?? new Set();
    const missing = required.filter((tick) => !capturedTicks.has(tick));
    const hit = required.length - missing.length;
    const complete = missing.length === 0;

    requiredCheckpoints += required.length;
    capturedCheckpoints += hit;
    if (complete) fullyCapturedMissions++;

    missionRows.push({
      scriptId,
      maxTick: mission.maxTick,
      frameCount: mission.frameCount ?? (mission.maxTick + 1),
      requiredCheckpoints: required.length,
      capturedCheckpoints: hit,
      completion: required.length === 0 ? 1 : hit / required.length,
      complete,
      missingTicks: missing,
    });
  }

  const manifestSet = new Set(missionRows.map((m) => m.scriptId));
  const unexpectedMissions = [...rowTicksByMission.keys()]
    .filter((scriptId) => !manifestSet.has(scriptId))
    .sort((a, b) => a.localeCompare(b));

  return {
    missionCount: missionRows.length,
    completeMissionCount: fullyCapturedMissions,
    missionCoverage: missionRows.length === 0 ? 1 : fullyCapturedMissions / missionRows.length,
    requiredCheckpoints,
    capturedCheckpoints,
    checkpointCoverage: requiredCheckpoints === 0 ? 1 : capturedCheckpoints / requiredCheckpoints,
    unexpectedMissions,
    missions: missionRows,
  };
}
