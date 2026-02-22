import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TILE_SIZE } from '../utils/MathUtils';
import type { SceneManager } from './SceneManager';
import type { MapData, MapPoint } from '../config/MapLoader';

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

// Maximum terrain height from heightmap values (world units)
const MAX_ELEVATION = 3.0;

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
    vec3 spiceColor = texture2D(spiceTex, tiledUv).rgb;

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
    vec3 spiceColor = texture2D(spiceTex, tiledUv).rgb;

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

  // Variable map dimensions
  private mapWidth = 128;
  private mapHeight = 128;

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
  private spiceMounds: THREE.Group[] = [];

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
      return 0;
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
        load('/assets/textures/@!Spice.png'),
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

    // Apply heightmap to vertices
    const posAttr = geometry.attributes.position;
    const vertexCount = posAttr.count;

    for (let i = 0; i < vertexCount; i++) {
      const wx = posAttr.getX(i);
      const wz = posAttr.getZ(i);

      const tx = Math.floor((wx + TILE_SIZE / 2) / TILE_SIZE);
      const tz = Math.floor((wz + TILE_SIZE / 2) / TILE_SIZE);
      const clampedTx = Math.max(0, Math.min(this.mapWidth - 1, tx));
      const clampedTz = Math.max(0, Math.min(this.mapHeight - 1, tz));

      const tileIdx = clampedTz * this.mapWidth + clampedTx;

      if (this.heightData) {
        const elevation = this.heightData[tileIdx] / 255.0 * MAX_ELEVATION;
        posAttr.setY(i, posAttr.getY(i) + elevation);
      }
    }
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
      });
    } else {
      // Fallback: basic desert material
      material = new THREE.MeshLambertMaterial({ color: 0xC2A54F });
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
              mat.roughness = 1.0;
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
    } catch (e) {
      throw new Error(`Failed to load XBF terrain for ${mapId}: ${e}`);
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

  /** Place 3D SpiceMound models at spice field centers */
  async placeSpiceMounds(spiceFields: MapPoint[]): Promise<void> {
    if (spiceFields.length === 0) return;

    let template: THREE.Group;
    try {
      const loader = new GLTFLoader();
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        loader.load('/assets/models/spice/Spicemound.gltf', resolve, undefined, reject);
      });
      template = gltf.scene;
    } catch (e) {
      console.warn('Failed to load SpiceMound model, skipping placement:', e);
      return;
    }

    for (const field of spiceFields) {
      const mound = template.clone(true);
      // XBF model coordinates [-16,16] → TILE_SIZE via scale 0.0625
      mound.scale.setScalar(TILE_SIZE / 32);
      const wx = field.x * TILE_SIZE;
      const wz = field.z * TILE_SIZE;
      const y = this.getHeightAt(wx, wz);
      mound.position.set(wx, y, wz);
      this.sceneManager.scene.add(mound);
      this.spiceMounds.push(mound);
    }

    console.log(`Placed ${spiceFields.length} SpiceMound models`);
  }

  dispose(): void {
    // Dispose spice mounds
    for (const mound of this.spiceMounds) {
      mound.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.geometry.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of materials) mat.dispose();
        }
      });
      this.sceneManager.scene.remove(mound);
    }
    this.spiceMounds = [];
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

}
