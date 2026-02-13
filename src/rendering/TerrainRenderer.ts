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

// Color palette for terrain types
const TERRAIN_COLORS: Record<TerrainType, THREE.Color> = {
  [TerrainType.Sand]: new THREE.Color(0xC2A54F),       // Sandy tan
  [TerrainType.Rock]: new THREE.Color(0x8B7355),       // Brown rock
  [TerrainType.SpiceLow]: new THREE.Color(0xD4842A),   // Light orange spice
  [TerrainType.SpiceHigh]: new THREE.Color(0xB85C1E),  // Deep orange/red spice
  [TerrainType.Dunes]: new THREE.Color(0xD4B86A),      // Light sand dunes
  [TerrainType.Cliff]: new THREE.Color(0x6B5B45),      // Dark cliff
  [TerrainType.ConcreteSlab]: new THREE.Color(0x808080),// Grey concrete
  [TerrainType.InfantryRock]: new THREE.Color(0x9B8B6B),// Lighter rock (infantry)
};

export const MAP_SIZE = 128; // Tiles per side

export class TerrainRenderer {
  private sceneManager: SceneManager;
  private terrainData: Uint8Array; // TerrainType per tile
  private spiceAmount: Float32Array; // Spice density 0-1 per tile
  private mesh: THREE.Mesh | null = null;

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
    // Update terrain type based on spice
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

  generate(): void {
    this.generateProceduralTerrain();
    this.buildMesh();
  }

  private generateProceduralTerrain(): void {
    // Perlin-like noise using layered sine waves (simple but effective)
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

        // Default: sand
        let terrain = TerrainType.Sand;

        // Rock patches
        if (rockNoise > 0.35) {
          terrain = TerrainType.Rock;
        } else if (rockNoise > 0.25) {
          terrain = TerrainType.InfantryRock;
        }

        // Cliff at extreme rock values or map edges
        if (rockNoise > 0.55 || tx <= 1 || tx >= MAP_SIZE - 2 || tz <= 1 || tz >= MAP_SIZE - 2) {
          terrain = TerrainType.Cliff;
        }

        // Dunes on sand
        if (terrain === TerrainType.Sand && duneNoise > 0.3) {
          terrain = TerrainType.Dunes;
        }

        this.terrainData[idx] = terrain;

        // Spice fields - only on sand/dunes, in patches
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

    // Vertex colors based on terrain type
    const posAttr = geometry.attributes.position;
    const vertexCount = posAttr.count;
    const colors = new Float32Array(vertexCount * 3);

    for (let i = 0; i < vertexCount; i++) {
      const wx = posAttr.getX(i);
      const wz = posAttr.getZ(i);

      // Map world pos to tile
      const tx = Math.floor((wx + TILE_SIZE / 2) / TILE_SIZE);
      const tz = Math.floor((wz + TILE_SIZE / 2) / TILE_SIZE);
      const clampedTx = Math.max(0, Math.min(MAP_SIZE - 1, tx));
      const clampedTz = Math.max(0, Math.min(MAP_SIZE - 1, tz));

      const terrainType = this.terrainData[clampedTz * MAP_SIZE + clampedTx] as TerrainType;
      const color = TERRAIN_COLORS[terrainType] ?? TERRAIN_COLORS[TerrainType.Sand];

      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;

      // Add slight height variation for rock and cliffs
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

    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.receiveShadow = true;
    this.sceneManager.scene.add(this.mesh);
  }

  updateSpiceVisuals(): void {
    // Rebuild mesh when spice changes significantly
    this.buildMesh();
  }
}
