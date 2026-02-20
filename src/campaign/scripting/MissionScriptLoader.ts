/**
 * Loads mission script JSON files from the assets directory.
 */

import type { MissionScript } from './MissionScriptTypes';

const MISSIONS_PATH = '/assets/data/missions/';

/** Cache of loaded scripts. */
const scriptCache = new Map<string, MissionScript>();

/**
 * Load a mission script by ID.
 * Returns null if the script doesn't exist or fails to parse.
 */
export async function loadMissionScript(scriptId: string): Promise<MissionScript | null> {
  // Check cache
  const cached = scriptCache.get(scriptId);
  if (cached) return cached;

  try {
    const resp = await fetch(`${MISSIONS_PATH}${scriptId}.json`);
    if (!resp.ok) return null;
    const script: MissionScript = await resp.json();

    // Basic validation
    if (!script.id || !script.rules || !Array.isArray(script.rules)) {
      console.warn(`[MissionScript] Invalid script: ${scriptId}`);
      return null;
    }

    scriptCache.set(scriptId, script);
    return script;
  } catch (e) {
    console.warn(`[MissionScript] Failed to load ${scriptId}:`, e);
    return null;
  }
}

/** Cache of loaded tok buffers. */
const tokCache = new Map<string, ArrayBuffer>();

/**
 * Load a .tok binary script by ID.
 * Returns null if the file doesn't exist.
 */
export async function loadTokScript(scriptId: string): Promise<ArrayBuffer | null> {
  const cached = tokCache.get(scriptId);
  if (cached) return cached;

  try {
    const resp = await fetch(`${MISSIONS_PATH}tok/${scriptId}.tok`);
    if (!resp.ok) return null;
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength < 8) return null;
    tokCache.set(scriptId, buffer);
    return buffer;
  } catch {
    return null;
  }
}

/** Clear the script cache. */
export function clearScriptCache(): void {
  scriptCache.clear();
  tokCache.clear();
}
