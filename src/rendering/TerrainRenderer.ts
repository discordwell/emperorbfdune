import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TILE_SIZE } from '../utils/MathUtils';
import type { SceneManager } from './SceneManager';
import type { MapData } from '../config/MapLoader';

// Terrain types matching EBFD
export enum TerrainType {
  Sand = 0,
  Rock = 1,
  SpiceLow = 2,
  SpiceHigh = 3,
  Dunes = 4,
  Cliff = 5,
  ConcreteSlab = 6,
  InfantryRock = 7, // Elevated rock where infantry gets bonuses
}

// Fallback vertex color palette
const TERRAIN_COLORS: Record<TerrainType, THREE.Color> = {
  [TerrainType.Sand]: new THREE.Color(0xC2A54F),
  [TerrainType.Rock]: new THREE.Color(0x8B7355),
  [TerrainType.SpiceLow]: new THREE.Color(0xD4842A),
  [TerrainType.SpiceHigh]: new THREE.Color(0xB85C1E),
  [TerrainType.Dunes]: new THREE.Color(0xD4B86A),
  [TerrainType.Cliff]: new THREE.Color(0x6B5B45),
  [TerrainType.ConcreteSlab]: new THREE.Color(0x808080),
  [TerrainType.InfantryRock]: new THREE.Color(0x9B8B6B),
};

// Default map size for proc-gen fallback
const DEFAULT_MAP_SIZE = 128;

// Maximum terrain height from heightmap values (world units)
const MAX_ELEVATION = 3.0;

/** Type-based height for procedural maps (no heightmap data) */
function proceduralHeight(t: TerrainType): number {
  if (t === TerrainType.Cliff) return 1.5;
  if (t === TerrainType.Rock || t === TerrainType.InfantryRock) return 0.3;
  if (t === TerrainType.Dunes) return 0.15;
  return 0;
}

/**
 * CPF passability nibble (0-15) → visual TerrainType mapping.
 * Corrected via cross-tabulation of CPF values vs texture indices:
 *   CPF 2, 3, 4, 6, 8, 10 all share the same dominant texture (tex 57 = sand).
 *   Only CPF 5 and 7 correspond to rocky/elevated terrain.
 * Visual terrain is decoupled from passability — raw CPF drives movement checks.
 */
const CPF_TO_TERRAIN: TerrainType[] = [
  TerrainType.Cliff,       // 0  - impassable boundary
  TerrainType.Cliff,       // 1  - cliff edge
  TerrainType.Sand,        // 2  - open terrain (shares sand texture with CPF 10)
  TerrainType.Sand,        // 3  - open terrain variant
  TerrainType.Dunes,       // 4  - light dunes
  TerrainType.Rock,        // 5  - rocky elevated (less common)
  TerrainType.Sand,        // 6  - open terrain (most common CPF value)
  TerrainType.InfantryRock,// 7  - infantry-only elevated rock
  TerrainType.Dunes,       // 8  - dunes
  TerrainType.Dunes,       // 9  - dunes variant
  TerrainType.Sand,        // 10 - main open sand
  TerrainType.Sand,        // 11 - sand variant
  TerrainType.SpiceLow,    // 12 - spice field (low)
  TerrainType.SpiceLow,    // 13 - spice variant
  TerrainType.SpiceHigh,   // 14 - rich spice
  TerrainType.SpiceHigh,   // 15 - rich spice variant
];

// Terrain splatmap shader
const terrainVertexShader = /* glsl */ `
  varying vec2 vWorldUv;
  varying vec3 vNormal;

  void main() {
    // World-space UV for texture tiling (position is in world coords)
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldUv = worldPos.xz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const terrainFragmentShader = /* glsl */ `
  uniform sampler2D splatmap;
  uniform sampler2D sandTex;
  uniform sampler2D rockTex;
  uniform sampler2D spiceTex;
  uniform vec2 mapWorldSize;
  uniform vec2 mapOffset;
  uniform float texScale;

  varying vec2 vWorldUv;
  varying vec3 vNormal;

  void main() {
    // Splatmap UV: map world position to 0-1 range
    vec2 splatUv = (vWorldUv - mapOffset) / mapWorldSize;
    splatUv = clamp(splatUv, 0.0, 1.0);
    vec4 splat = texture2D(splatmap, splatUv);

    // Tiled texture UVs
    vec2 tiledUv = vWorldUv * texScale;
    vec3 sandColor = texture2D(sandTex, tiledUv).rgb;
    vec3 rockColor = texture2D(rockTex, tiledUv).rgb;
    vec3 spiceBase = texture2D(spiceTex, tiledUv).rgb;
    // Tint spice texture orange
    vec3 spiceColor = spiceBase * vec3(1.4, 0.8, 0.3);

    // Blend based on splatmap weights (R=sand, G=rock, B=spice)
    float total = splat.r + splat.g + splat.b;
    vec3 color;
    if (total < 0.01) {
      color = sandColor;
    } else {
      color = (sandColor * splat.r + rockColor * splat.g + spiceColor * splat.b) / total;
    }

    // Simple directional lighting
    vec3 lightDir = normalize(vec3(0.5, 1.0, 0.3));
    float diff = max(dot(vNormal, lightDir), 0.0);
    float ambient = 0.4;
    float light = ambient + diff * 0.6;

    gl_FragColor = vec4(color * light, 1.0);
  }
`;

// Spice overlay shaders (renders on top of XBF terrain mesh)
const spiceOverlayVertexShader = /* glsl */ `
  varying vec2 vSplatUv;
  void main() {
    vSplatUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const spiceOverlayFragmentShader = /* glsl */ `
  uniform sampler2D splatmap;
  uniform sampler2D spiceTex;
  uniform vec2 mapWorldSize;
  varying vec2 vSplatUv;

  void main() {
    vec4 splat = texture2D(splatmap, vSplatUv);
    float spiceWeight = splat.b;
    if (spiceWeight < 0.01) discard;

    // Tile the spice texture across the terrain
    vec2 tiledUv = vSplatUv * mapWorldSize * 0.075;
    vec3 spiceBase = texture2D(spiceTex, tiledUv).rgb;
    vec3 spiceColor = spiceBase * vec3(1.4, 0.8, 0.3);

    gl_FragColor = vec4(spiceColor, spiceWeight * 0.85);
  }
`;

export class TerrainRenderer {
  private sceneManager: SceneManager;
  private terrainData: Uint8Array; // TerrainType per tile (visual only)
  private baseTerrain: Uint8Array; // Original terrain before spice overlay
  private spiceAmount: Float32Array; // Spice density 0-1 per tile
  private rawPassability: Uint8Array | null = null; // Raw CPF values for movement checks
  private mesh: THREE.Mesh | null = null;
  private splatmapTexture: THREE.DataTexture | null = null;
  private splatmapData: Uint8Array | null = null;
  private texturesLoaded = false;
  private spiceVisualsDirty = false;
  private sandTex: THREE.Texture | null = null;
  private rockTex: THREE.Texture | null = null;
  private spiceTex: THREE.Texture | null = null;

  // Variable map dimensions (replaces fixed MAP_SIZE)
  private mapWidth = DEFAULT_MAP_SIZE;
  private mapHeight = DEFAULT_MAP_SIZE;

  // Heightmap data from real maps (null for proc-gen)
  private heightData: Uint8Array | null = null;

  // XBF terrain mesh (original game terrain)
  private xbfMesh: THREE.Group | null = null;
  private xbfLoaded = false;
  private float32Heights: Float32Array | null = null;
  private heightGridW = 0;
  private heightGridH = 0;
  private spiceOverlayMesh: THREE.Mesh | null = null;
  private spiceOverlayMaterial: THREE.ShaderMaterial | null = null;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.terrainData = new Uint8Array(this.mapWidth * this.mapHeight);
    this.baseTerrain = new Uint8Array(this.mapWidth * this.mapHeight);
    this.spiceAmount = new Float32Array(this.mapWidth * this.mapHeight);
  }

  getMapWidth(): number { return this.mapWidth; }
  getMapHeight(): number { return this.mapHeight; }

  /** Get a copy of the raw terrain data for worker pathfinding */
  getTerrainDataCopy(): Uint8Array {
    return new Uint8Array(this.terrainData);
  }

  getTerrainType(tx: number, tz: number): TerrainType {
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return TerrainType.Cliff;
    return this.terrainData[tz * this.mapWidth + tx];
  }

  setTerrainType(tx: number, tz: number, type: TerrainType): void {
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return;
    this.terrainData[tz * this.mapWidth + tx] = type;
  }

  /** Get interpolated terrain height at world coordinates */
  getHeightAt(worldX: number, worldZ: number): number {
    // Convert world coords to fractional tile coords
    const fx = worldX / TILE_SIZE;
    const fz = worldZ / TILE_SIZE;
    const tx = Math.floor(fx);
    const tz = Math.floor(fz);

    // Use float32 heights from XBF terrain if available (most accurate)
    if (this.float32Heights) {
      const gw = this.heightGridW;
      const gh = this.heightGridH;
      const tx0 = tx < 0 ? 0 : tx >= gw ? gw - 1 : tx;
      const tz0 = tz < 0 ? 0 : tz >= gh ? gh - 1 : tz;
      const tx1 = Math.min(tx0 + 1, gw); // grid is (W+1) wide
      const tz1 = Math.min(tz0 + 1, gh); // grid is (H+1) tall
      const fracX = Math.max(0, Math.min(1, fx - tx));
      const fracZ = Math.max(0, Math.min(1, fz - tz));

      const stride = gw + 1; // (W+1) values per row
      const h00 = this.float32Heights[tz0 * stride + tx0];
      const h10 = this.float32Heights[tz0 * stride + tx1];
      const h01 = this.float32Heights[tz1 * stride + tx0];
      const h11 = this.float32Heights[tz1 * stride + tx1];

      const top = h00 + (h10 - h00) * fracX;
      const bot = h01 + (h11 - h01) * fracX;
      return top + (bot - top) * fracZ;
    }

    if (!this.heightData) {
      // Procedural: interpolate between neighboring tile heights for smooth transitions
      const fracX = fx - tx;
      const fracZ = fz - tz;
      const h00 = proceduralHeight(this.getTerrainType(tx, tz));
      const h10 = proceduralHeight(this.getTerrainType(tx + 1, tz));
      const h01 = proceduralHeight(this.getTerrainType(tx, tz + 1));
      const h11 = proceduralHeight(this.getTerrainType(tx + 1, tz + 1));
      const top = h00 + (h10 - h00) * fracX;
      const bot = h01 + (h11 - h01) * fracX;
      return top + (bot - top) * fracZ;
    }

    // Bilinear interpolation of uint8 heightmap
    const w = this.mapWidth;
    const h = this.mapHeight;
    const tx0 = tx < 0 ? 0 : tx >= w ? w - 1 : tx;
    const tz0 = tz < 0 ? 0 : tz >= h ? h - 1 : tz;
    const tx1 = tx + 1 >= w ? w - 1 : tx + 1 < 0 ? 0 : tx + 1;
    const tz1 = tz + 1 >= h ? h - 1 : tz + 1 < 0 ? 0 : tz + 1;
    const fracX = fx - tx;
    const fracZ = fz - tz;

    const scale = MAX_ELEVATION / 255.0;
    const h00 = this.heightData[tz0 * w + tx0] * scale;
    const h10 = this.heightData[tz0 * w + tx1] * scale;
    const h01 = this.heightData[tz1 * w + tx0] * scale;
    const h11 = this.heightData[tz1 * w + tx1] * scale;

    const top = h00 + (h10 - h00) * fracX;
    const bot = h01 + (h11 - h01) * fracX;
    return top + (bot - top) * fracZ;
  }

  getSpice(tx: number, tz: number): number {
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return 0;
    return this.spiceAmount[tz * this.mapWidth + tx];
  }

  setSpice(tx: number, tz: number, amount: number): void {
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return;
    const idx = tz * this.mapWidth + tx;
    this.spiceAmount[idx] = Math.max(0, amount);
    const oldType = this.terrainData[idx];
    if (amount > 0.6) {
      this.terrainData[idx] = TerrainType.SpiceHigh;
    } else if (amount > 0) {
      this.terrainData[idx] = TerrainType.SpiceLow;
    } else {
      // Spice depleted - revert to original terrain
      this.terrainData[idx] = this.baseTerrain[idx] || TerrainType.Sand;
    }
    if (this.terrainData[idx] !== oldType) {
      this.spiceVisualsDirty = true;
    }
  }

  /** Check and flush pending spice visual updates (call from game loop) */
  flushSpiceVisuals(): void {
    if (this.spiceVisualsDirty) {
      this.updateSpiceVisuals();
      this.spiceVisualsDirty = false;
    }
  }

  isPassable(tx: number, tz: number): boolean {
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return false;
    if (this.rawPassability) {
      const cpf = this.rawPassability[tz * this.mapWidth + tx];
      return cpf > 1; // CPF 0-1 = impassable cliff
    }
    const type = this.getTerrainType(tx, tz);
    return type !== TerrainType.Cliff;
  }

  isPassableVehicle(tx: number, tz: number): boolean {
    if (tx < 0 || tx >= this.mapWidth || tz < 0 || tz >= this.mapHeight) return false;
    if (this.rawPassability) {
      const cpf = this.rawPassability[tz * this.mapWidth + tx];
      return cpf > 1 && cpf !== 7; // CPF 0-1 = cliff, CPF 7 = infantry only
    }
    const type = this.getTerrainType(tx, tz);
    return type !== TerrainType.Cliff && type !== TerrainType.InfantryRock;
  }

  /** Load terrain from real map data (replaces proc-gen) */
  async loadFromMapData(data: MapData): Promise<void> {
    this.mapWidth = data.width;
    this.mapHeight = data.height;

    const tileCount = this.mapWidth * this.mapHeight;
    this.terrainData = new Uint8Array(tileCount);
    this.baseTerrain = new Uint8Array(tileCount);
    this.spiceAmount = new Float32Array(tileCount);
    this.heightData = new Uint8Array(tileCount);

    // Copy height data
    this.heightData.set(data.heightMap);

    // Store raw CPF values for movement checks (decoupled from visual terrain)
    this.rawPassability = new Uint8Array(tileCount);
    this.rawPassability.set(data.passability);

    // Convert CPF passability values to visual TerrainType enum
    for (let i = 0; i < tileCount; i++) {
      const cpfValue = data.passability[i];
      this.terrainData[i] = CPF_TO_TERRAIN[cpfValue] ?? TerrainType.Sand;

      // Initialize spice amounts from terrain type
      if (this.terrainData[i] === TerrainType.SpiceLow) {
        this.baseTerrain[i] = TerrainType.Sand;
        this.spiceAmount[i] = 0.4;
      } else if (this.terrainData[i] === TerrainType.SpiceHigh) {
        this.baseTerrain[i] = TerrainType.Sand;
        this.spiceAmount[i] = 0.8;
      } else {
        this.baseTerrain[i] = this.terrainData[i];
      }
    }

    await this.loadTextures();
    this.generateSplatmap();
    this.buildMesh();

    console.log(`Terrain loaded from map data: ${this.mapWidth}×${this.mapHeight}`);
  }

  /** Procedural generation fallback */
  async generate(): Promise<void> {
    // Reset to default size for proc-gen
    this.mapWidth = DEFAULT_MAP_SIZE;
    this.mapHeight = DEFAULT_MAP_SIZE;
    this.terrainData = new Uint8Array(this.mapWidth * this.mapHeight);
    this.baseTerrain = new Uint8Array(this.mapWidth * this.mapHeight);
    this.spiceAmount = new Float32Array(this.mapWidth * this.mapHeight);
    this.heightData = null;

    this.generateProceduralTerrain();
    await this.loadTextures();
    this.generateSplatmap();
    this.buildMesh();
  }

  private async loadTextures(): Promise<void> {
    if (this.texturesLoaded) return; // Already loaded
    const loader = new THREE.TextureLoader();
    const load = (path: string): Promise<THREE.Texture> =>
      new Promise((resolve, reject) => {
        loader.load(path, resolve, undefined, reject);
      });

    try {
      const [sand, rock, spice] = await Promise.all([
        load('/assets/textures/ground.png'),
        load('/assets/textures/rockpatch5.png'),
        load('/assets/textures/sandcover.png'),
      ]);

      for (const tex of [sand, rock, spice]) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
      }

      this.sandTex = sand;
      this.rockTex = rock;
      this.spiceTex = spice;
      this.texturesLoaded = true;
      console.log('Terrain textures loaded');
    } catch (e) {
      console.warn('Failed to load terrain textures, using vertex colors fallback', e);
    }
  }

  private generateSplatmap(): void {
    const splatW = this.mapWidth;
    const splatH = this.mapHeight;
    const expectedSize = splatW * splatH * 4;

    // Reuse existing buffer if same size, only allocate on first call or size change
    if (!this.splatmapData || this.splatmapData.length !== expectedSize) {
      this.splatmapData = new Uint8Array(expectedSize);
      // Need a new texture if size changed
      if (this.splatmapTexture) {
        this.splatmapTexture.dispose();
        this.splatmapTexture = null;
      }
    }

    const data = this.splatmapData;

    for (let tz = 0; tz < splatH; tz++) {
      for (let tx = 0; tx < splatW; tx++) {
        const idx = (tz * splatW + tx) * 4;
        const terrain = this.terrainData[tz * this.mapWidth + tx] as TerrainType;

        let r = 0, g = 0, b = 0;
        switch (terrain) {
          case TerrainType.Sand:
          case TerrainType.Dunes:
            r = 255;
            break;
          case TerrainType.Rock:
          case TerrainType.InfantryRock:
          case TerrainType.Cliff:
          case TerrainType.ConcreteSlab:
            g = 255;
            break;
          case TerrainType.SpiceLow:
            r = 128; b = 128; // Blend sand + spice
            break;
          case TerrainType.SpiceHigh:
            b = 255;
            break;
          default:
            r = 255;
        }

        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    if (!this.splatmapTexture) {
      this.splatmapTexture = new THREE.DataTexture(
        data as unknown as BufferSource, splatW, splatH, THREE.RGBAFormat
      );
      this.splatmapTexture.magFilter = THREE.LinearFilter;
      this.splatmapTexture.minFilter = THREE.LinearFilter;
    }
    this.splatmapTexture.needsUpdate = true;
  }

  private buildMesh(): void {
    if (this.mesh) {
      this.sceneManager.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }

    const worldW = this.mapWidth * TILE_SIZE;
    const worldH = this.mapHeight * TILE_SIZE;
    const geometry = new THREE.PlaneGeometry(worldW, worldH, this.mapWidth, this.mapHeight);
    geometry.rotateX(-Math.PI / 2);
    // Offset so tile (0,0) is at world origin
    geometry.translate(worldW / 2 - TILE_SIZE / 2, 0, worldH / 2 - TILE_SIZE / 2);

    // Vertex colors (needed for fallback and shader vColor)
    const posAttr = geometry.attributes.position;
    const vertexCount = posAttr.count;
    const colors = new Float32Array(vertexCount * 3);

    for (let i = 0; i < vertexCount; i++) {
      const wx = posAttr.getX(i);
      const wz = posAttr.getZ(i);

      const tx = Math.floor((wx + TILE_SIZE / 2) / TILE_SIZE);
      const tz = Math.floor((wz + TILE_SIZE / 2) / TILE_SIZE);
      const clampedTx = Math.max(0, Math.min(this.mapWidth - 1, tx));
      const clampedTz = Math.max(0, Math.min(this.mapHeight - 1, tz));

      const tileIdx = clampedTz * this.mapWidth + clampedTx;
      const terrainType = this.terrainData[tileIdx] as TerrainType;
      const color = TERRAIN_COLORS[terrainType] ?? TERRAIN_COLORS[TerrainType.Sand];

      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;

      // Height: use real heightmap if available, otherwise type-based
      if (this.heightData) {
        const elevation = this.heightData[tileIdx] / 255.0 * MAX_ELEVATION;
        posAttr.setY(i, posAttr.getY(i) + elevation);
      } else {
        // Procedural height variation
        if (terrainType === TerrainType.Rock || terrainType === TerrainType.InfantryRock) {
          posAttr.setY(i, posAttr.getY(i) + 0.3);
        } else if (terrainType === TerrainType.Cliff) {
          posAttr.setY(i, posAttr.getY(i) + 1.5);
        } else if (terrainType === TerrainType.Dunes) {
          posAttr.setY(i, posAttr.getY(i) + 0.15);
        }
      }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    let material: THREE.Material;

    if (this.texturesLoaded && this.splatmapTexture && this.sandTex && this.rockTex && this.spiceTex) {
      // Map offset is the world position of tile (0,0) minus half tile
      const mapOffset = new THREE.Vector2(-TILE_SIZE / 2, -TILE_SIZE / 2);
      const mapWorldSize = new THREE.Vector2(worldW, worldH);

      material = new THREE.ShaderMaterial({
        uniforms: {
          splatmap: { value: this.splatmapTexture },
          sandTex: { value: this.sandTex },
          rockTex: { value: this.rockTex },
          spiceTex: { value: this.spiceTex },
          mapWorldSize: { value: mapWorldSize },
          mapOffset: { value: mapOffset },
          texScale: { value: 0.15 }, // Texture repeat frequency
        },
        vertexShader: terrainVertexShader,
        fragmentShader: terrainFragmentShader,
        vertexColors: true,
      });
    } else {
      // Fallback: vertex colors
      material = new THREE.MeshLambertMaterial({ vertexColors: true });
    }

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = true;
    this.sceneManager.scene.add(this.mesh);
  }

  updateSpiceVisuals(): void {
    if (this.xbfLoaded) {
      // XBF mode: only regenerate splatmap texture (spice overlay reads it automatically)
      this.generateSplatmap();
      return;
    }
    // Splatmap mode: regenerate splatmap from current terrain data without full mesh rebuild
    if (this.texturesLoaded && this.splatmapData && this.splatmapTexture) {
      this.generateSplatmap();
    } else {
      this.buildMesh();
    }
  }

  /** Load original XBF terrain mesh, replacing the splatmap terrain visually.
   *  Returns true on success, false on failure (graceful fallback to splatmap). */
  async loadTerrainMesh(mapId: string): Promise<boolean> {
    const glbUrl = `/assets/maps/terrain/${mapId}.terrain.glb`;
    const heightsUrl = `/assets/maps/terrain/${mapId}.terrain.heights`;

    try {
      // Load GLB mesh
      const loader = new GLTFLoader();
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        loader.load(glbUrl, resolve, undefined, reject);
      });

      // Load heights file
      let heightsLoaded = false;
      try {
        const resp = await fetch(heightsUrl);
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          const view = new DataView(buf);
          const w = view.getUint16(0, true);
          const h = view.getUint16(2, true);
          // yScale stored at offset 4 but heights are already pre-scaled in the file
          const numFloats = (w + 1) * (h + 1);
          this.float32Heights = new Float32Array(buf, 8, numFloats);
          this.heightGridW = w;
          this.heightGridH = h;
          heightsLoaded = true;
        }
      } catch {
        // Heights file optional - fall back to existing heightmap
      }

      // Configure loaded mesh materials
      gltf.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.receiveShadow = true;
          // Ensure textures use repeat wrapping
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of materials) {
            if (mat instanceof THREE.MeshStandardMaterial) {
              mat.metalness = 0;
              mat.roughness = 0.85;
              if (mat.map) {
                mat.map.wrapS = THREE.RepeatWrapping;
                mat.map.wrapT = THREE.RepeatWrapping;
              }
            }
          }
        }
      });

      // Add XBF mesh to scene
      this.xbfMesh = gltf.scene;
      this.sceneManager.scene.add(this.xbfMesh);

      // Hide the splatmap mesh
      if (this.mesh) {
        this.mesh.visible = false;
      }

      // Build spice overlay
      this.buildSpiceOverlay();

      this.xbfLoaded = true;
      console.log(`XBF terrain loaded: ${mapId} (heights: ${heightsLoaded})`);
      return true;
    } catch {
      // GLB not found or failed to load - fall back to splatmap
      return false;
    }
  }

  private buildSpiceOverlay(): void {
    if (!this.spiceTex) return;

    const worldW = this.mapWidth * TILE_SIZE;
    const worldH = this.mapHeight * TILE_SIZE;

    // Create a plane matching the map dimensions, subdivided per tile
    const geometry = new THREE.PlaneGeometry(worldW, worldH, this.mapWidth, this.mapHeight);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(worldW / 2 - TILE_SIZE / 2, 0, worldH / 2 - TILE_SIZE / 2);

    // Conform overlay vertices to terrain surface
    const posAttr = geometry.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const wx = posAttr.getX(i);
      const wz = posAttr.getZ(i);
      const y = this.getHeightAt(wx, wz) + 0.1; // Slight offset above terrain
      posAttr.setY(i, y);
    }
    posAttr.needsUpdate = true;

    // Generate splatmap if not yet done
    if (!this.splatmapTexture) {
      this.generateSplatmap();
    }

    this.spiceOverlayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        splatmap: { value: this.splatmapTexture },
        spiceTex: { value: this.spiceTex },
        mapWorldSize: { value: new THREE.Vector2(worldW, worldH) },
      },
      vertexShader: spiceOverlayVertexShader,
      fragmentShader: spiceOverlayFragmentShader,
      transparent: true,
      depthWrite: false,
    });

    this.spiceOverlayMesh = new THREE.Mesh(geometry, this.spiceOverlayMaterial);
    this.spiceOverlayMesh.renderOrder = 1; // Render after terrain
    this.sceneManager.scene.add(this.spiceOverlayMesh);
  }

  dispose(): void {
    // Dispose XBF terrain
    if (this.xbfMesh) {
      this.xbfMesh.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.geometry.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of materials) {
            if (mat instanceof THREE.MeshStandardMaterial) mat.map?.dispose();
            mat.dispose();
          }
        }
      });
      this.sceneManager.scene.remove(this.xbfMesh);
      this.xbfMesh = null;
    }
    // Dispose spice overlay
    if (this.spiceOverlayMesh) {
      this.spiceOverlayMesh.geometry.dispose();
      this.spiceOverlayMaterial?.dispose();
      this.sceneManager.scene.remove(this.spiceOverlayMesh);
      this.spiceOverlayMesh = null;
      this.spiceOverlayMaterial = null;
    }
    // Dispose splatmap mesh
    if (this.mesh) {
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.sceneManager.scene.remove(this.mesh);
      this.mesh = null;
    }
    // Dispose shared textures
    this.sandTex?.dispose();
    this.rockTex?.dispose();
    this.spiceTex?.dispose();
    this.splatmapTexture?.dispose();
    this.sandTex = null;
    this.rockTex = null;
    this.spiceTex = null;
    this.splatmapTexture = null;
    this.texturesLoaded = false;
    this.float32Heights = null;
    this.xbfLoaded = false;
  }

  private mapSeed = Math.random() * 10000;

  setMapSeed(seed: number): void { this.mapSeed = seed; }

  private generateProceduralTerrain(): void {
    const seed = this.mapSeed;
    const w = this.mapWidth;
    const h = this.mapHeight;
    const noise = (x: number, z: number, scale: number): number => {
      const s = scale;
      return (
        Math.sin((x + seed) * 0.03 * s + z * 0.05 * s) * 0.3 +
        Math.sin(x * 0.07 * s - (z + seed) * 0.04 * s + 1.5) * 0.25 +
        Math.sin((x + seed * 0.7) * 0.13 * s + z * 0.11 * s + 3.0) * 0.2 +
        Math.sin(x * 0.23 * s - (z + seed * 0.3) * 0.19 * s + 5.0) * 0.15 +
        Math.sin((x + seed * 0.5) * 0.41 * s + z * 0.37 * s + 7.0) * 0.1
      );
    };

    // Map layout variations based on seed
    const layout = Math.floor(seed) % 4;
    // 0 = Open Desert (default), 1 = Canyon, 2 = Rocky Plateau, 3 = Coastal

    for (let tz = 0; tz < h; tz++) {
      for (let tx = 0; tx < w; tx++) {
        const idx = tz * w + tx;
        const rockNoise = noise(tx, tz, 1.0);
        const duneNoise = noise(tx + 500, tz + 500, 0.5);
        const spiceNoise = noise(tx + 1000, tz + 1000, 0.8);

        let terrain = TerrainType.Sand;
        let rockThreshold = 0.35;
        let cliffThreshold = 0.55;
        let spiceThreshold = 0.2;

        if (layout === 1) {
          // Canyon: more cliffs, narrow passages
          rockThreshold = 0.25;
          cliffThreshold = 0.40;
          const cx = Math.abs(tx - w / 2) / (w / 2);
          const cz = Math.abs(tz - h / 2) / (h / 2);
          const canyonVal = Math.min(cx, cz);
          if (canyonVal < 0.15) { rockThreshold = 0.6; cliffThreshold = 0.8; }
        } else if (layout === 2) {
          rockThreshold = 0.15;
          cliffThreshold = 0.50;
          spiceThreshold = 0.25;
        } else if (layout === 3) {
          const midDist = Math.abs(tx + tz - w) / w;
          if (midDist < 0.15) { rockThreshold = 0.1; cliffThreshold = 0.25; }
          else { rockThreshold = 0.45; cliffThreshold = 0.65; }
        }

        if (rockNoise > rockThreshold) {
          terrain = TerrainType.Rock;
        } else if (rockNoise > rockThreshold - 0.1) {
          terrain = TerrainType.InfantryRock;
        }

        if (rockNoise > cliffThreshold || tx <= 1 || tx >= w - 2 || tz <= 1 || tz >= h - 2) {
          terrain = TerrainType.Cliff;
        }

        if (terrain === TerrainType.Sand && duneNoise > 0.3) {
          terrain = TerrainType.Dunes;
        }

        this.terrainData[idx] = terrain;
        this.baseTerrain[idx] = terrain;

        if (terrain === TerrainType.Sand || terrain === TerrainType.Dunes) {
          if (spiceNoise > spiceThreshold) {
            const spiceAmount = Math.min(1.0, (spiceNoise - spiceThreshold) * 2.5);
            this.spiceAmount[idx] = spiceAmount;
            this.terrainData[idx] = spiceAmount > 0.6 ? TerrainType.SpiceHigh : TerrainType.SpiceLow;
          }
        }
      }
    }
  }
}
