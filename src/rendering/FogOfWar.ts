import * as THREE from 'three';
import type { SceneManager } from './SceneManager';
import { MAP_SIZE } from './TerrainRenderer';
import {
  Position, Owner, ViewRange, Health,
  unitQuery, buildingQuery,
  type World,
} from '../core/ECS';
import { worldToTile, TILE_SIZE } from '../utils/MathUtils';

// Visibility states
export const FOG_UNEXPLORED = 0;
export const FOG_EXPLORED = 1; // Was visible, now in fog
export const FOG_VISIBLE = 2;  // Currently visible

export class FogOfWar {
  private sceneManager: SceneManager;
  private localPlayerId = 0;

  // Per-tile visibility
  private visibility: Uint8Array;
  private explored: Uint8Array; // Permanent: once explored, stays explored

  // Fog overlay mesh
  private fogMesh: THREE.Mesh | null = null;
  private fogTexture: THREE.DataTexture;
  private fogData: Uint8Array;

  // Buildings reveal radius (tiles)
  private buildingViewRange = 8;

  private enabled = true;

  constructor(sceneManager: SceneManager, localPlayerId = 0) {
    this.sceneManager = sceneManager;
    this.localPlayerId = localPlayerId;

    this.visibility = new Uint8Array(MAP_SIZE * MAP_SIZE);
    this.explored = new Uint8Array(MAP_SIZE * MAP_SIZE);
    this.fogData = new Uint8Array(MAP_SIZE * MAP_SIZE * 4);
    // Initialize all as unexplored (black)
    for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
      const idx = i * 4;
      this.fogData[idx] = 0;     // R
      this.fogData[idx + 1] = 0; // G
      this.fogData[idx + 2] = 0; // B
      this.fogData[idx + 3] = 255; // A - fully opaque (black)
    }

    this.fogTexture = new THREE.DataTexture(
      this.fogData, MAP_SIZE, MAP_SIZE, THREE.RGBAFormat
    );
    this.fogTexture.magFilter = THREE.LinearFilter;
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.fogTexture.needsUpdate = true;

    this.createFogMesh();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.fogMesh) {
      this.fogMesh.visible = enabled;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private createFogMesh(): void {
    const worldSize = MAP_SIZE * TILE_SIZE;
    const geometry = new THREE.PlaneGeometry(worldSize, worldSize);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(worldSize / 2 - TILE_SIZE / 2, 0.5, worldSize / 2 - TILE_SIZE / 2);

    const material = new THREE.MeshBasicMaterial({
      map: this.fogTexture,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.fogMesh = new THREE.Mesh(geometry, material);
    this.fogMesh.renderOrder = 10; // Render on top of terrain
    this.sceneManager.scene.add(this.fogMesh);
  }

  update(world: World): void {
    if (!this.enabled) return;

    // Reset visibility (keep explored state)
    for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
      this.visibility[i] = this.explored[i] > 0 ? FOG_EXPLORED : FOG_UNEXPLORED;
    }

    // Reveal around player units
    const units = unitQuery(world);
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      if (Health.current[eid] <= 0) continue;
      const range = ViewRange.range ? (ViewRange.range[eid] || 6) : 6;
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      this.revealArea(tile.tx, tile.tz, Math.ceil(range / TILE_SIZE));
    }

    // Reveal around player buildings
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      if (Health.current[eid] <= 0) continue;
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      this.revealArea(tile.tx, tile.tz, this.buildingViewRange);
    }

    // Update fog texture
    this.updateTexture();
  }

  private revealArea(cx: number, cz: number, radius: number): void {
    const r2 = radius * radius;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        const tx = cx + dx;
        const tz = cz + dz;
        if (tx < 0 || tx >= MAP_SIZE || tz < 0 || tz >= MAP_SIZE) continue;
        const idx = tz * MAP_SIZE + tx;
        this.visibility[idx] = FOG_VISIBLE;
        this.explored[idx] = 1;
      }
    }
  }

  private updateTexture(): void {
    for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
      const idx = i * 4;
      const vis = this.visibility[i];
      // RGBA: black fog with varying alpha
      this.fogData[idx] = 0;
      this.fogData[idx + 1] = 0;
      this.fogData[idx + 2] = 0;
      if (vis === FOG_VISIBLE) {
        this.fogData[idx + 3] = 0;    // Fully transparent
      } else if (vis === FOG_EXPLORED) {
        this.fogData[idx + 3] = 140;  // Semi-transparent (fog)
      } else {
        this.fogData[idx + 3] = 240;  // Nearly opaque (unexplored)
      }
    }
    this.fogTexture.needsUpdate = true;
  }

  isTileVisible(tx: number, tz: number): boolean {
    if (!this.enabled) return true;
    if (tx < 0 || tx >= MAP_SIZE || tz < 0 || tz >= MAP_SIZE) return false;
    return this.visibility[tz * MAP_SIZE + tx] === FOG_VISIBLE;
  }

  isTileExplored(tx: number, tz: number): boolean {
    if (!this.enabled) return true;
    if (tx < 0 || tx >= MAP_SIZE || tz < 0 || tz >= MAP_SIZE) return false;
    return this.explored[tz * MAP_SIZE + tx] > 0;
  }

  getVisibility(): Uint8Array {
    return this.visibility;
  }
}
