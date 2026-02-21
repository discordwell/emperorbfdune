/**
 * MapLoader — loads original Emperor: BFD map data from pre-converted .bin files.
 *
 * Binary format (.bin):
 *   Header (12 bytes):
 *     uint16 LE: width (tiles)
 *     uint16 LE: height (tiles)
 *     float32 LE: ambientR
 *     float32 LE: ambientG
 *   Body (3 × W×H bytes):
 *     [W*H bytes] heightMap  — elevation 0-255
 *     [W*H bytes] passability — terrain type 0-15 (CPF nibble values)
 *     [W*H bytes] textureIdx — texture palette index 0-255
 */

export interface MapData {
  width: number;
  height: number;
  ambientR: number;
  ambientG: number;
  heightMap: Uint8Array;       // W*H elevation values
  passability: Uint8Array;     // W*H terrain types (0-15)
  textureIndices: Uint8Array;  // W*H texture palette refs
}

export interface MapPoint { x: number; z: number; }
export interface MapEntrance { marker: number; x: number; z: number; }
export interface MapMetadata {
  spawnPoints: MapPoint[];
  scriptPoints: (MapPoint | null)[];  // 0-23 indexed, ScriptN → index N-1
  entrances: MapEntrance[];
  spiceFields: MapPoint[];
  aiWaypoints: MapPoint[];
}

export interface MapManifestEntry {
  name: string;
  w: number;
  h: number;
  players: number;
  type: string;
  binSize: number;
  hasThumb: boolean;
  // Optional metadata from test.xbf FXData (tile coordinates)
  spawnPoints?: number[][];      // [[x, z], ...]
  scriptPoints?: (number[] | null)[];  // indexed 0-23
  entrances?: number[][];        // [[marker, x, z], ...]
  spiceFields?: number[][];      // [[x, z], ...]
  aiWaypoints?: number[][];      // [[x, z], ...]
}

export type MapManifest = Record<string, MapManifestEntry>;

/** Parse compact manifest arrays into typed MapMetadata objects */
export function getMapMetadata(entry: MapManifestEntry): MapMetadata {
  const spawnPoints: MapPoint[] = (entry.spawnPoints ?? []).map(
    ([x, z]) => ({ x, z })
  );

  const scriptPoints: (MapPoint | null)[] = (entry.scriptPoints ?? []).map(
    pt => pt ? { x: pt[0], z: pt[1] } : null
  );
  // Pad to 24 slots
  while (scriptPoints.length < 24) scriptPoints.push(null);

  const entrances: MapEntrance[] = (entry.entrances ?? []).map(
    ([marker, x, z]) => ({ marker, x, z })
  );

  const spiceFields: MapPoint[] = (entry.spiceFields ?? []).map(
    ([x, z]) => ({ x, z })
  );

  const aiWaypoints: MapPoint[] = (entry.aiWaypoints ?? []).map(
    ([x, z]) => ({ x, z })
  );

  return { spawnPoints, scriptPoints, entrances, spiceFields, aiWaypoints };
}

const HEADER_SIZE = 12; // 2 + 2 + 4 + 4 bytes

let cachedManifest: MapManifest | null = null;
let cachedMap: { id: string; data: MapData } | null = null;

export async function loadMapManifest(): Promise<MapManifest> {
  if (cachedManifest) return cachedManifest;

  try {
    const response = await fetch('/assets/maps/manifest.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cachedManifest = await response.json() as MapManifest;
    console.log(`Map manifest loaded: ${Object.keys(cachedManifest).length} maps`);
    return cachedManifest;
  } catch (e) {
    console.warn('Failed to load map manifest:', e);
    return {};
  }
}

export async function loadMap(mapId: string): Promise<MapData | null> {
  // Return cached if same map
  if (cachedMap && cachedMap.id === mapId) return cachedMap.data;

  try {
    const response = await fetch(`/assets/maps/${mapId}.bin`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();

    if (buffer.byteLength < HEADER_SIZE) {
      throw new Error(`Map file too small: ${buffer.byteLength} bytes`);
    }

    const view = new DataView(buffer);
    const width = view.getUint16(0, true);
    const height = view.getUint16(2, true);
    const ambientR = view.getFloat32(4, true);
    const ambientG = view.getFloat32(8, true);

    const tileCount = width * height;
    const expectedSize = HEADER_SIZE + tileCount * 3;
    if (buffer.byteLength < expectedSize) {
      throw new Error(`Map file truncated: ${buffer.byteLength} < ${expectedSize}`);
    }

    const heightMap = new Uint8Array(buffer, HEADER_SIZE, tileCount);
    const passability = new Uint8Array(buffer, HEADER_SIZE + tileCount, tileCount);
    const textureIndices = new Uint8Array(buffer, HEADER_SIZE + tileCount * 2, tileCount);

    const data: MapData = {
      width,
      height,
      ambientR,
      ambientG,
      heightMap,
      passability,
      textureIndices,
    };

    cachedMap = { id: mapId, data };
    console.log(`Map loaded: ${mapId} (${width}×${height})`);
    return data;
  } catch (e) {
    console.warn(`Failed to load map ${mapId}:`, e);
    return null;
  }
}

/** Get list of skirmish maps from manifest */
export function getSkirmishMaps(manifest: MapManifest): [string, MapManifestEntry][] {
  return Object.entries(manifest)
    .filter(([, entry]) => entry.type === 'skirmish')
    .sort((a, b) => {
      // Sort by player count, then name
      if (a[1].players !== b[1].players) return a[1].players - b[1].players;
      return a[1].name.localeCompare(b[1].name);
    });
}

/** Get the map ID for a campaign territory */
export function getCampaignMapId(territoryId: number, housePrefix: string): string | null {
  // Territory IDs 1-33 map directly to T1-T33
  if (territoryId >= 1 && territoryId <= 33) {
    return `T${territoryId}`;
  }
  return null;
}

/** Get special mission map IDs by type and house */
export function getSpecialMissionMapId(
  missionType: 'heighliner' | 'homeDefense' | 'homeAttack' | 'civilWar' | 'final' | 'tutorial',
  housePrefix: string
): string | null {
  switch (missionType) {
    case 'heighliner':
      if (housePrefix === 'AT') return 'H1';
      if (housePrefix === 'OR') return 'H2';
      if (housePrefix === 'HK') return 'H3';
      return null;
    case 'homeDefense':
      if (housePrefix === 'AT') return 'D1';
      if (housePrefix === 'OR') return 'D2';
      if (housePrefix === 'HK') return 'V1';
      return null;
    case 'homeAttack':
      if (housePrefix === 'AT') return 'A1';
      if (housePrefix === 'OR') return 'A2'; // Draconis IV
      if (housePrefix === 'HK') return 'A3';
      return null;
    case 'civilWar':
      return 'C1';
    case 'final':
      return 'E1';
    case 'tutorial':
      if (housePrefix === 'AT') return 'U1';
      if (housePrefix === 'OR') return 'U2';
      if (housePrefix === 'HK') return 'U3';
      return 'X1';
    default:
      return null;
  }
}
