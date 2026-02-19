import * as THREE from 'three';
import type { SceneManager } from './SceneManager';
import type { TerrainRenderer } from './TerrainRenderer';
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
  private terrain: TerrainRenderer;
  private localPlayerId = 0;

  // Map dimensions (from terrain)
  private mapW: number;
  private mapH: number;

  // Per-tile visibility
  private visibility: Uint8Array;
  private explored: Uint8Array; // Permanent: once explored, stays explored

  // Fog overlay mesh
  private fogMesh: THREE.Mesh | null = null;
  private fogTexture: THREE.DataTexture;
  private fogData: Uint8Array;
  private rawAlphaBuffer: Uint8Array; // Temp buffer for blur pass

  // (buildingViewRange removed — now uses per-building ViewRange component)

  private enabled = true;
  private tickCounter = 0;
  private lastPositionHash = 0;
  private updateInterval = 5; // Only recalculate every 5 ticks (200ms)

  constructor(sceneManager: SceneManager, terrain: TerrainRenderer, localPlayerId = 0) {
    this.sceneManager = sceneManager;
    this.terrain = terrain;
    this.localPlayerId = localPlayerId;

    this.mapW = terrain.getMapWidth();
    this.mapH = terrain.getMapHeight();
    const tileCount = this.mapW * this.mapH;

    this.visibility = new Uint8Array(tileCount);
    this.explored = new Uint8Array(tileCount);
    this.fogData = new Uint8Array(tileCount * 4);
    this.rawAlphaBuffer = new Uint8Array(tileCount);
    // Initialize all as unexplored (black)
    for (let i = 0; i < tileCount; i++) {
      const idx = i * 4;
      this.fogData[idx] = 0;     // R
      this.fogData[idx + 1] = 0; // G
      this.fogData[idx + 2] = 0; // B
      this.fogData[idx + 3] = 255; // A - fully opaque (black)
    }

    this.fogTexture = new THREE.DataTexture(
      this.fogData as unknown as BufferSource, this.mapW, this.mapH, THREE.RGBAFormat
    );
    this.fogTexture.magFilter = THREE.LinearFilter;
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.fogTexture.needsUpdate = true;

    this.createFogMesh();
  }

  /** Re-initialize fog buffers and mesh after terrain dimensions change */
  reinitialize(): void {
    this.mapW = this.terrain.getMapWidth();
    this.mapH = this.terrain.getMapHeight();
    const tileCount = this.mapW * this.mapH;

    this.visibility = new Uint8Array(tileCount);
    this.explored = new Uint8Array(tileCount);
    this.fogData = new Uint8Array(tileCount * 4);
    this.rawAlphaBuffer = new Uint8Array(tileCount);
    for (let i = 0; i < tileCount; i++) {
      const idx = i * 4;
      this.fogData[idx] = 0;
      this.fogData[idx + 1] = 0;
      this.fogData[idx + 2] = 0;
      this.fogData[idx + 3] = 255;
    }

    this.fogTexture.dispose();
    this.fogTexture = new THREE.DataTexture(
      this.fogData as unknown as BufferSource, this.mapW, this.mapH, THREE.RGBAFormat
    );
    this.fogTexture.magFilter = THREE.LinearFilter;
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.fogTexture.needsUpdate = true;

    // Remove old fog mesh and create new one
    if (this.fogMesh) {
      this.sceneManager.scene.remove(this.fogMesh);
      this.fogMesh.geometry.dispose();
      (this.fogMesh.material as THREE.Material).dispose();
      this.fogMesh = null;
    }
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

  getMapWidth(): number { return this.mapW; }
  getMapHeight(): number { return this.mapH; }

  private createFogMesh(): void {
    const worldW = this.mapW * TILE_SIZE;
    const worldH = this.mapH * TILE_SIZE;
    const geometry = new THREE.PlaneGeometry(worldW, worldH);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(worldW / 2 - TILE_SIZE / 2, 0.5, worldH / 2 - TILE_SIZE / 2);

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

    // Throttle: only check for changes every N ticks
    this.tickCounter++;
    if (this.tickCounter < this.updateInterval) return;
    this.tickCounter = 0;

    // Quick position hash to detect if any units moved
    let hash = 0;
    let entityCount = 0;
    const units = unitQuery(world);
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      if (Health.current[eid] <= 0) continue;
      // Use tile coords for hash (position changes within same tile don't matter)
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      hash = (hash * 31 + tile.tx * 997 + tile.tz * 1009 + eid) | 0;
      entityCount++;
    }
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      if (Health.current[eid] <= 0) continue;
      hash = (hash * 31 + eid * 503) | 0;
      entityCount++;
    }
    hash = (hash * 31 + entityCount) | 0;

    // Skip if nothing changed
    if (hash === this.lastPositionHash) return;
    this.lastPositionHash = hash;

    const tileCount = this.mapW * this.mapH;

    // Reset visibility (keep explored state)
    for (let i = 0; i < tileCount; i++) {
      this.visibility[i] = this.explored[i] > 0 ? FOG_EXPLORED : FOG_UNEXPLORED;
    }

    // Reveal around player units
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      if (Health.current[eid] <= 0) continue;
      const range = ViewRange.range[eid] || 10; // Default 5 tiles * 2
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      this.revealArea(tile.tx, tile.tz, Math.ceil(range / TILE_SIZE));
    }

    // Reveal around player buildings (using per-building ViewRange)
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      if (Health.current[eid] <= 0) continue;
      const range = ViewRange.range[eid] || 20; // Default 10 tiles * 2
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      this.revealArea(tile.tx, tile.tz, Math.ceil(range / TILE_SIZE));
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
        if (tx < 0 || tx >= this.mapW || tz < 0 || tz >= this.mapH) continue;
        const idx = tz * this.mapW + tx;
        this.visibility[idx] = FOG_VISIBLE;
        this.explored[idx] = 1;
      }
    }
  }

  private updateTexture(): void {
    const tileCount = this.mapW * this.mapH;
    // First pass: write raw alpha values based on visibility state
    const rawAlpha = this.rawAlphaBuffer;
    for (let i = 0; i < tileCount; i++) {
      const vis = this.visibility[i];
      if (vis === FOG_VISIBLE) rawAlpha[i] = 0;
      else if (vis === FOG_EXPLORED) rawAlpha[i] = 140;
      else rawAlpha[i] = 240;
    }

    // Second pass: 3x3 box blur on alpha for soft edges
    for (let z = 0; z < this.mapH; z++) {
      for (let x = 0; x < this.mapW; x++) {
        const idx = (z * this.mapW + x) * 4;
        this.fogData[idx] = 0;
        this.fogData[idx + 1] = 0;
        this.fogData[idx + 2] = 0;

        // Sample 3x3 neighborhood
        let sum = 0;
        let count = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const nz = z + dz;
            if (nx >= 0 && nx < this.mapW && nz >= 0 && nz < this.mapH) {
              sum += rawAlpha[nz * this.mapW + nx];
              count++;
            }
          }
        }
        this.fogData[idx + 3] = Math.round(sum / count);
      }
    }
    this.fogTexture.needsUpdate = true;
  }

  isTileVisible(tx: number, tz: number): boolean {
    if (!this.enabled) return true;
    if (tx < 0 || tx >= this.mapW || tz < 0 || tz >= this.mapH) return false;
    return this.visibility[tz * this.mapW + tx] === FOG_VISIBLE;
  }

  isTileExplored(tx: number, tz: number): boolean {
    if (!this.enabled) return true;
    if (tx < 0 || tx >= this.mapW || tz < 0 || tz >= this.mapH) return false;
    return this.explored[tz * this.mapW + tx] > 0;
  }

  getVisibility(): Uint8Array {
    return this.visibility;
  }
}
