/**
 * Loads mission script JSON files from the assets directory.
 * Uses a manifest for case-insensitive .tok lookup with proper URL encoding.
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

/** Manifest: lowercase basename → actual filename (without .tok). Loaded once. */
let tokManifest: Record<string, string> | null = null;
let manifestLoading: Promise<Record<string, string>> | null = null;

async function loadManifest(): Promise<Record<string, string>> {
  if (tokManifest) return tokManifest;
  if (manifestLoading) return manifestLoading;

  manifestLoading = fetch(`${MISSIONS_PATH}tok/tok-manifest.json`)
    .then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    })
    .then(data => {
      tokManifest = data as Record<string, string>;
      console.log(`[MissionScript] Loaded tok manifest: ${Object.keys(tokManifest).length} entries`);
      return tokManifest;
    })
    .catch(() => {
      console.warn('[MissionScript] tok-manifest.json not found, falling back to direct lookup');
      tokManifest = {};
      return tokManifest;
    });

  return manifestLoading;
}

/**
 * Resolve a script ID to the actual .tok filename using the manifest.
 * Does case-insensitive lookup and returns the properly encoded URL path.
 */
export async function resolveTokFilename(scriptId: string): Promise<string | null> {
  const manifest = await loadManifest();
  const key = scriptId.toLowerCase();
  const realName = manifest[key];
  if (realName !== undefined) return realName;

  // Not in manifest — return null (file doesn't exist)
  return null;
}

/**
 * Load a .tok binary script by ID.
 * Uses manifest for case-insensitive lookup and URL-encodes filenames with spaces.
 * Returns null if the file doesn't exist.
 */
export async function loadTokScript(scriptId: string): Promise<ArrayBuffer | null> {
  const cached = tokCache.get(scriptId.toLowerCase());
  if (cached) return cached;

  try {
    const realName = await resolveTokFilename(scriptId);
    if (realName === null) return null;

    // URL-encode the filename to handle spaces and special chars
    const encodedName = encodeURIComponent(realName);
    const resp = await fetch(`${MISSIONS_PATH}tok/${encodedName}.tok`);
    if (!resp.ok) return null;
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength < 8) return null;
    tokCache.set(scriptId.toLowerCase(), buffer);
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

/** Reset manifest (for testing). */
export function _resetManifest(): void {
  tokManifest = null;
  manifestLoading = null;
}
