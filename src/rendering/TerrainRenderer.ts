import * as THREE from 'three';
import { TILE_SIZE } from '../utils/MathUtils';
import type { SceneManager } from './SceneManager';

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

export const MAP_SIZE = 128; // Tiles per side
const SPLATMAP_SIZE = 128; // Splatmap resolution (1:1 with tiles)

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

export class TerrainRenderer {
  private sceneManager: SceneManager;
  private terrainData: Uint8Array; // TerrainType per tile
  private spiceAmount: Float32Array; // Spice density 0-1 per tile
  private mesh: THREE.Mesh | null = null;
  private splatmapTexture: THREE.DataTexture | null = null;
  private splatmapData: Uint8Array | null = null;
  private texturesLoaded = false;
  private sandTex: THREE.Texture | null = null;
  private rockTex: THREE.Texture | null = null;
  private spiceTex: THREE.Texture | null = null;

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;
    this.terrainData = new Uint8Array(MAP_SIZE * MAP_SIZE);
    this.spiceAmount = new Float32Array(MAP_SIZE * MAP_SIZE);
  }

  getTerrainType(tx: number, tz: number): TerrainType {
    if (tx < 0 || tx >= MAP_SIZE || tz < 0 || tz >= MAP_SIZE) return TerrainType.Cliff;
    return this.terrainData[tz * MAP_SIZE + tx];
  }

  setTerrainType(tx: number, tz: number, type: TerrainType): void {
    if (tx < 0 || tx >= MAP_SIZE || tz < 0 || tz >= MAP_SIZE) return;
    this.terrainData[tz * MAP_SIZE + tx] = type;
  }

  getSpice(tx: number, tz: number): number {
    if (tx < 0 || tx >= MAP_SIZE || tz < 0 || tz >= MAP_SIZE) return 0;
    return this.spiceAmount[tz * MAP_SIZE + tx];
  }

  setSpice(tx: number, tz: number, amount: number): void {
    if (tx < 0 || tx >= MAP_SIZE || tz < 0 || tz >= MAP_SIZE) return;
    this.spiceAmount[tz * MAP_SIZE + tx] = amount;
    const idx = tz * MAP_SIZE + tx;
    if (amount > 0.6) {
      this.terrainData[idx] = TerrainType.SpiceHigh;
    } else if (amount > 0) {
      this.terrainData[idx] = TerrainType.SpiceLow;
    }
  }

  isPassable(tx: number, tz: number): boolean {
    const type = this.getTerrainType(tx, tz);
    return type !== TerrainType.Cliff && type !== TerrainType.Rock;
  }

  isPassableVehicle(tx: number, tz: number): boolean {
    const type = this.getTerrainType(tx, tz);
    return type !== TerrainType.Cliff;
  }

  async generate(): Promise<void> {
    this.generateProceduralTerrain();
    await this.loadTextures();
    this.generateSplatmap();
    this.buildMesh();
  }

  private async loadTextures(): Promise<void> {
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
    // RGBA DataTexture: R=sand, G=rock, B=spice, A=unused
    const data = new Uint8Array(SPLATMAP_SIZE * SPLATMAP_SIZE * 4);
    this.splatmapData = data;

    for (let tz = 0; tz < SPLATMAP_SIZE; tz++) {
      for (let tx = 0; tx < SPLATMAP_SIZE; tx++) {
        const idx = (tz * SPLATMAP_SIZE + tx) * 4;
        const terrain = this.terrainData[tz * MAP_SIZE + tx] as TerrainType;

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

    if (this.splatmapTexture) {
      this.splatmapTexture.image.data.set(data);
      this.splatmapTexture.needsUpdate = true;
    } else {
      this.splatmapTexture = new THREE.DataTexture(
        data, SPLATMAP_SIZE, SPLATMAP_SIZE, THREE.RGBAFormat
      );
      this.splatmapTexture.magFilter = THREE.LinearFilter;
      this.splatmapTexture.minFilter = THREE.LinearFilter;
      this.splatmapTexture.needsUpdate = true;
    }
  }

  private buildMesh(): void {
    if (this.mesh) {
      this.sceneManager.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }

    const worldSize = MAP_SIZE * TILE_SIZE;
    const geometry = new THREE.PlaneGeometry(worldSize, worldSize, MAP_SIZE, MAP_SIZE);
    geometry.rotateX(-Math.PI / 2);
    // Offset so tile (0,0) is at world origin
    geometry.translate(worldSize / 2 - TILE_SIZE / 2, 0, worldSize / 2 - TILE_SIZE / 2);

    // Vertex colors (needed for fallback and shader vColor)
    const posAttr = geometry.attributes.position;
    const vertexCount = posAttr.count;
    const colors = new Float32Array(vertexCount * 3);

    for (let i = 0; i < vertexCount; i++) {
      const wx = posAttr.getX(i);
      const wz = posAttr.getZ(i);

      const tx = Math.floor((wx + TILE_SIZE / 2) / TILE_SIZE);
      const tz = Math.floor((wz + TILE_SIZE / 2) / TILE_SIZE);
      const clampedTx = Math.max(0, Math.min(MAP_SIZE - 1, tx));
      const clampedTz = Math.max(0, Math.min(MAP_SIZE - 1, tz));

      const terrainType = this.terrainData[clampedTz * MAP_SIZE + clampedTx] as TerrainType;
      const color = TERRAIN_COLORS[terrainType] ?? TERRAIN_COLORS[TerrainType.Sand];

      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;

      // Height variation
      if (terrainType === TerrainType.Rock || terrainType === TerrainType.InfantryRock) {
        posAttr.setY(i, posAttr.getY(i) + 0.3);
      } else if (terrainType === TerrainType.Cliff) {
        posAttr.setY(i, posAttr.getY(i) + 1.5);
      } else if (terrainType === TerrainType.Dunes) {
        posAttr.setY(i, posAttr.getY(i) + 0.15);
      }
    }

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    let material: THREE.Material;

    if (this.texturesLoaded && this.splatmapTexture && this.sandTex && this.rockTex && this.spiceTex) {
      // Map offset is the world position of tile (0,0) minus half tile
      const mapOffset = new THREE.Vector2(-TILE_SIZE / 2, -TILE_SIZE / 2);
      const mapWorldSize = new THREE.Vector2(worldSize, worldSize);

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
    // Regenerate splatmap from current terrain data without full mesh rebuild
    if (this.texturesLoaded && this.splatmapData && this.splatmapTexture) {
      this.generateSplatmap();
    } else {
      this.buildMesh();
    }
  }

  private generateProceduralTerrain(): void {
    const noise = (x: number, z: number, scale: number): number => {
      const s = scale;
      return (
        Math.sin(x * 0.03 * s + z * 0.05 * s) * 0.3 +
        Math.sin(x * 0.07 * s - z * 0.04 * s + 1.5) * 0.25 +
        Math.sin(x * 0.13 * s + z * 0.11 * s + 3.0) * 0.2 +
        Math.sin(x * 0.23 * s - z * 0.19 * s + 5.0) * 0.15 +
        Math.sin(x * 0.41 * s + z * 0.37 * s + 7.0) * 0.1
      );
    };

    for (let tz = 0; tz < MAP_SIZE; tz++) {
      for (let tx = 0; tx < MAP_SIZE; tx++) {
        const idx = tz * MAP_SIZE + tx;
        const rockNoise = noise(tx, tz, 1.0);
        const duneNoise = noise(tx + 500, tz + 500, 0.5);
        const spiceNoise = noise(tx + 1000, tz + 1000, 0.8);

        let terrain = TerrainType.Sand;

        if (rockNoise > 0.35) {
          terrain = TerrainType.Rock;
        } else if (rockNoise > 0.25) {
          terrain = TerrainType.InfantryRock;
        }

        if (rockNoise > 0.55 || tx <= 1 || tx >= MAP_SIZE - 2 || tz <= 1 || tz >= MAP_SIZE - 2) {
          terrain = TerrainType.Cliff;
        }

        if (terrain === TerrainType.Sand && duneNoise > 0.3) {
          terrain = TerrainType.Dunes;
        }

        this.terrainData[idx] = terrain;

        if (terrain === TerrainType.Sand || terrain === TerrainType.Dunes) {
          if (spiceNoise > 0.2) {
            const spiceAmount = Math.min(1.0, (spiceNoise - 0.2) * 2.5);
            this.spiceAmount[idx] = spiceAmount;
            this.terrainData[idx] = spiceAmount > 0.6 ? TerrainType.SpiceHigh : TerrainType.SpiceLow;
          }
        }
      }
    }
  }
}
