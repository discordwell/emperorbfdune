import * as THREE from 'three';
import type { SceneManager } from './SceneManager';
import type { TerrainRenderer } from './TerrainRenderer';
import {
  Position, Owner, ViewRange, Health,
  unitQuery, buildingQuery,
  type World,
} from '../core/ECS';
import { worldToTile, TILE_SIZE } from '../utils/MathUtils';
import { GameConstants } from '../utils/Constants';

// Visibility states (tri-state fog system matching original Emperor BFD)
export const FOG_UNEXPLORED = 0; // Shroud: never seen, completely black
export const FOG_EXPLORED = 1;   // Fog: previously explored, terrain visible but units hidden
export const FOG_VISIBLE = 2;    // Clear: currently in view range, everything visible

// Elevation bonus: tiles of height above viewer per extra tile of sight range
const ELEVATION_SIGHT_BONUS_PER_UNIT = 0.8;
// Height threshold for LOS blocking (cliff-like terrain blocks sight)
const LOS_BLOCK_HEIGHT_DIFF = 1.2;
// Alpha values for the three fog states
const ALPHA_SHROUD = 248;   // Nearly opaque black for unexplored
const ALPHA_FOG = 140;      // Semi-dark for explored-but-not-visible
const ALPHA_VISIBLE = 0;    // Fully transparent for visible

// 5x5 Gaussian kernel (sigma ~1.0, normalized to sum to 256 for integer math)
// [1, 4, 7, 4, 1]
// [4, 16, 26, 16, 4]
// [7, 26, 41, 26, 7]
// [4, 16, 26, 16, 4]
// [1, 4, 7, 4, 1]
// Sum = 273, we use a two-pass separable blur instead for performance
const BLUR_KERNEL_1D = [1, 4, 7, 4, 1]; // 1D kernel, sum = 17
const BLUR_RADIUS = 2; // Half-width of 5-tap kernel

export class FogOfWar {
  private sceneManager: SceneManager;
  private terrain: TerrainRenderer;
  private localPlayerId = 0;

  // Map dimensions (from terrain)
  private mapW: number;
  private mapH: number;

  // Per-tile visibility state (FOG_UNEXPLORED / FOG_EXPLORED / FOG_VISIBLE)
  private visibility: Uint8Array;
  // Permanent exploration: once explored, stays explored (persisted across save/load)
  private explored: Uint8Array;

  // Pre-computed per-tile elevation cache (world-unit heights at tile centers)
  private tileHeights: Float32Array;

  // Fog overlay mesh rendered on top of terrain
  private fogMesh: THREE.Mesh | null = null;
  private fogTexture: THREE.DataTexture;
  private fogData: Uint8Array;

  // Intermediate buffers for two-pass separable Gaussian blur
  private rawAlphaBuffer: Uint8Array;
  private blurTempBuffer: Uint8Array;

  // Dirty region tracking for incremental updates
  private dirtyMinX = 0;
  private dirtyMinZ = 0;
  private dirtyMaxX = 0;
  private dirtyMaxZ = 0;
  private fullDirty = true;

  private enabled = true;
  private tickCounter = 4; // Start near updateInterval so first update fires immediately
  private lastPositionHash = -1;
  private updateInterval = 5; // Recalculate every 5 ticks (~200ms at 25 TPS)

  constructor(sceneManager: SceneManager, terrain: TerrainRenderer, localPlayerId = 0) {
    this.sceneManager = sceneManager;
    this.terrain = terrain;
    this.localPlayerId = localPlayerId;

    this.mapW = terrain.getMapWidth();
    this.mapH = terrain.getMapHeight();
    const tileCount = this.mapW * this.mapH;

    this.visibility = new Uint8Array(tileCount);
    this.explored = new Uint8Array(tileCount);
    this.tileHeights = new Float32Array(tileCount);
    this.fogData = new Uint8Array(tileCount * 4);
    this.rawAlphaBuffer = new Uint8Array(tileCount);
    this.blurTempBuffer = new Uint8Array(tileCount);

    // Initialize all tiles as unexplored (black)
    for (let i = 0; i < tileCount; i++) {
      const idx = i * 4;
      this.fogData[idx] = 0;     // R
      this.fogData[idx + 1] = 0; // G
      this.fogData[idx + 2] = 0; // B
      this.fogData[idx + 3] = 255; // A - fully opaque (shroud)
    }

    this.buildHeightCache();

    this.fogTexture = new THREE.DataTexture(
      this.fogData as unknown as BufferSource, this.mapW, this.mapH, THREE.RGBAFormat
    );
    this.fogTexture.magFilter = THREE.LinearFilter;
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.fogTexture.needsUpdate = true;

    this.createFogMesh();
  }

  /** Build cached elevation values at tile centers for fast LOS queries */
  private buildHeightCache(): void {
    const w = this.mapW;
    const h = this.mapH;
    for (let tz = 0; tz < h; tz++) {
      for (let tx = 0; tx < w; tx++) {
        // Sample height at tile center (world coords)
        const wx = tx * TILE_SIZE + TILE_SIZE * 0.5;
        const wz = tz * TILE_SIZE + TILE_SIZE * 0.5;
        this.tileHeights[tz * w + tx] = this.terrain.getHeightAt(wx, wz);
      }
    }
  }

  /** Re-initialize fog buffers and mesh after terrain dimensions change */
  reinitialize(): void {
    this.mapW = this.terrain.getMapWidth();
    this.mapH = this.terrain.getMapHeight();
    const tileCount = this.mapW * this.mapH;

    this.visibility = new Uint8Array(tileCount);
    this.explored = new Uint8Array(tileCount);
    this.tileHeights = new Float32Array(tileCount);
    this.fogData = new Uint8Array(tileCount * 4);
    this.rawAlphaBuffer = new Uint8Array(tileCount);
    this.blurTempBuffer = new Uint8Array(tileCount);

    for (let i = 0; i < tileCount; i++) {
      const idx = i * 4;
      this.fogData[idx] = 0;
      this.fogData[idx + 1] = 0;
      this.fogData[idx + 2] = 0;
      this.fogData[idx + 3] = 255;
    }

    this.buildHeightCache();

    this.fogTexture.dispose();
    this.fogTexture = new THREE.DataTexture(
      this.fogData as unknown as BufferSource, this.mapW, this.mapH, THREE.RGBAFormat
    );
    this.fogTexture.magFilter = THREE.LinearFilter;
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.fogTexture.needsUpdate = true;

    this.tickCounter = this.updateInterval - 1;
    this.lastPositionHash = -1;
    this.fullDirty = true;

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

  /** Get the cached tile-center height for a tile coordinate */
  private getTileHeight(tx: number, tz: number): number {
    if (tx < 0 || tx >= this.mapW || tz < 0 || tz >= this.mapH) return 0;
    return this.tileHeights[tz * this.mapW + tx];
  }

  /**
   * Elevation-aware line-of-sight check using Bresenham ray march.
   * Returns true if (tx, tz) is visible from (ox, oz) at observer elevation.
   * The ray checks intermediate tiles for terrain that blocks the sight line.
   */
  private hasLineOfSight(ox: number, oz: number, observerHeight: number, tx: number, tz: number): boolean {
    const dx = tx - ox;
    const dz = tz - oz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 1.5) return true; // Adjacent tiles always visible

    // Number of steps along the ray (at least 1 per tile distance)
    const steps = Math.max(2, Math.ceil(dist));
    const invSteps = 1 / steps;

    // Target height: terrain at target + small margin for unit visibility
    const targetHeight = this.getTileHeight(tx, tz);

    // Cast ray from observer to target, checking if intermediate terrain blocks it
    // We compute the sight line slope and check if any intermediate terrain rises above it
    for (let i = 1; i < steps; i++) {
      const t = i * invSteps;
      const sx = ox + dx * t;
      const sz = oz + dz * t;
      const stx = Math.floor(sx + 0.5);
      const stz = Math.floor(sz + 0.5);

      if (stx < 0 || stx >= this.mapW || stz < 0 || stz >= this.mapH) continue;
      // Skip the observer and target tiles themselves
      if (stx === ox && stz === oz) continue;
      if (stx === tx && stz === tz) continue;

      const sampleHeight = this.getTileHeight(stx, stz);
      // Height of the sight line at this sample point (linear interpolation)
      const lineHeight = observerHeight + (targetHeight - observerHeight) * t;

      // If terrain at this intermediate point is significantly above the sight line, LOS blocked
      if (sampleHeight > lineHeight + LOS_BLOCK_HEIGHT_DIFF) {
        return false;
      }
    }

    return true;
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
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      hash = (hash * 31 + tile.tx * 997 + tile.tz * 1009 + eid) | 0;
      entityCount++;
    }
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      if (Health.current[eid] <= 0) continue;
      const bTile = worldToTile(Position.x[eid], Position.z[eid]);
      hash = (hash * 31 + eid * 503 + bTile.tx * 997 + bTile.tz * 1009) | 0;
      entityCount++;
    }
    hash = (hash * 31 + entityCount) | 0;

    // Skip if nothing changed
    if (hash === this.lastPositionHash) return;
    this.lastPositionHash = hash;

    const tileCount = this.mapW * this.mapH;

    // Reset dirty region
    this.dirtyMinX = this.mapW;
    this.dirtyMinZ = this.mapH;
    this.dirtyMaxX = 0;
    this.dirtyMaxZ = 0;

    // Reset visibility (keep explored state), track what changes
    for (let i = 0; i < tileCount; i++) {
      const oldVis = this.visibility[i];
      const newVis = this.explored[i] > 0 ? FOG_EXPLORED : FOG_UNEXPLORED;
      this.visibility[i] = newVis;
      // If visibility changed (was VISIBLE, now FOG/UNEXPLORED), mark dirty
      if (oldVis !== newVis) {
        const tx = i % this.mapW;
        const tz = (i / this.mapW) | 0;
        this.expandDirty(tx, tz);
      }
    }

    // Reveal around player units with elevation-aware sight
    for (const eid of units) {
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      if (Health.current[eid] <= 0) continue;
      const range = ViewRange.range[eid] || GameConstants.DEFAULT_UNIT_VIEW_RANGE;
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      const observerHeight = this.getTileHeight(tile.tx, tile.tz);
      const tileRadius = Math.ceil(range / TILE_SIZE);
      // Elevation bonus: units on higher ground see further
      const elevationBonus = Math.max(0, observerHeight * ELEVATION_SIGHT_BONUS_PER_UNIT);
      const effectiveRadius = tileRadius + Math.floor(elevationBonus);
      this.revealAreaWithLOS(tile.tx, tile.tz, effectiveRadius, observerHeight);
    }

    // Reveal around player buildings with elevation-aware sight
    for (const eid of buildings) {
      if (Owner.playerId[eid] !== this.localPlayerId) continue;
      if (Health.current[eid] <= 0) continue;
      const range = ViewRange.range[eid] || GameConstants.DEFAULT_BUILDING_VIEW_RANGE;
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      const observerHeight = this.getTileHeight(tile.tx, tile.tz);
      const tileRadius = Math.ceil(range / TILE_SIZE);
      // Buildings get a slight elevation bonus (assumed taller structures)
      const structureHeightBonus = 0.5;
      const elevationBonus = Math.max(0, (observerHeight + structureHeightBonus) * ELEVATION_SIGHT_BONUS_PER_UNIT);
      const effectiveRadius = tileRadius + Math.floor(elevationBonus);
      this.revealAreaWithLOS(tile.tx, tile.tz, effectiveRadius, observerHeight + structureHeightBonus);
    }

    // Update fog texture (only dirty region if possible)
    this.updateTexture();
  }

  /** Reveal an area using world coordinates (called by mission scripts).
   *  No LOS check -- script reveals are unconditional. */
  revealWorldArea(worldX: number, worldZ: number, worldRadius: number): void {
    const tile = worldToTile(worldX, worldZ);
    const tileRadius = Math.ceil(worldRadius / TILE_SIZE);
    this.revealAreaSimple(tile.tx, tile.tz, tileRadius);
    this.fullDirty = true;
    this.updateTexture();
  }

  /** Re-cover an area with shroud using world coordinates (called by mission scripts). */
  coverWorldArea(worldX: number, worldZ: number, worldRadius: number): void {
    const tile = worldToTile(worldX, worldZ);
    const tileRadius = Math.ceil(worldRadius / TILE_SIZE);
    this.coverArea(tile.tx, tile.tz, tileRadius);
    this.fullDirty = true;
    this.updateTexture();
  }

  /** Expand dirty region to include a tile and its blur neighborhood */
  private expandDirty(tx: number, tz: number): void {
    const margin = BLUR_RADIUS + 1;
    if (tx - margin < this.dirtyMinX) this.dirtyMinX = Math.max(0, tx - margin);
    if (tz - margin < this.dirtyMinZ) this.dirtyMinZ = Math.max(0, tz - margin);
    if (tx + margin > this.dirtyMaxX) this.dirtyMaxX = Math.min(this.mapW - 1, tx + margin);
    if (tz + margin > this.dirtyMaxZ) this.dirtyMaxZ = Math.min(this.mapH - 1, tz + margin);
  }

  /**
   * Reveal tiles in a circle around (cx, cz) with elevation-aware line-of-sight.
   * Tiles that are behind cliffs or high terrain relative to the observer are blocked.
   */
  private revealAreaWithLOS(cx: number, cz: number, radius: number, observerHeight: number): void {
    const r2 = radius * radius;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const dist2 = dx * dx + dz * dz;
        if (dist2 > r2) continue;
        const tx = cx + dx;
        const tz = cz + dz;
        if (tx < 0 || tx >= this.mapW || tz < 0 || tz >= this.mapH) continue;

        // Line-of-sight check for tiles beyond immediate vicinity
        const dist = Math.sqrt(dist2);
        if (dist > 2 && !this.hasLineOfSight(cx, cz, observerHeight, tx, tz)) {
          continue;
        }

        const idx = tz * this.mapW + tx;
        if (this.visibility[idx] !== FOG_VISIBLE) {
          this.visibility[idx] = FOG_VISIBLE;
          this.explored[idx] = 1;
          this.expandDirty(tx, tz);
        }
      }
    }
  }

  /** Simple reveal without LOS (used by mission script reveals) */
  private revealAreaSimple(cx: number, cz: number, radius: number): void {
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

  private coverArea(cx: number, cz: number, radius: number): void {
    const r2 = radius * radius;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > r2) continue;
        const tx = cx + dx;
        const tz = cz + dz;
        if (tx < 0 || tx >= this.mapW || tz < 0 || tz >= this.mapH) continue;
        const idx = tz * this.mapW + tx;
        this.visibility[idx] = FOG_UNEXPLORED;
        this.explored[idx] = 0;
      }
    }
  }

  /**
   * Update the fog texture using a two-pass separable 5-tap Gaussian blur
   * for smooth feathered edges between fog states. Uses dirty region tracking
   * to only recompute the area that changed when possible.
   */
  private updateTexture(): void {
    const w = this.mapW;
    const h = this.mapH;
    const tileCount = w * h;
    const rawAlpha = this.rawAlphaBuffer;
    const blurTemp = this.blurTempBuffer;

    // First pass: write raw alpha values from visibility state
    for (let i = 0; i < tileCount; i++) {
      const vis = this.visibility[i];
      if (vis === FOG_VISIBLE) rawAlpha[i] = ALPHA_VISIBLE;
      else if (vis === FOG_EXPLORED) rawAlpha[i] = ALPHA_FOG;
      else rawAlpha[i] = ALPHA_SHROUD;
    }

    // Determine blur region
    let x0: number, z0: number, x1: number, z1: number;
    if (this.fullDirty) {
      x0 = 0; z0 = 0; x1 = w - 1; z1 = h - 1;
      this.fullDirty = false;
    } else {
      // Expand dirty region by blur radius for correct edge blending
      x0 = Math.max(0, this.dirtyMinX - BLUR_RADIUS);
      z0 = Math.max(0, this.dirtyMinZ - BLUR_RADIUS);
      x1 = Math.min(w - 1, this.dirtyMaxX + BLUR_RADIUS);
      z1 = Math.min(h - 1, this.dirtyMaxZ + BLUR_RADIUS);
    }

    // If no dirty region, still need to write the texture
    // (this covers the case where only fog->explored transitions happened)

    // Two-pass separable Gaussian blur for feathered edges:

    // Horizontal pass: rawAlpha -> blurTemp
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        let sum = 0;
        let wt = 0;
        for (let k = -BLUR_RADIUS; k <= BLUR_RADIUS; k++) {
          const nx = x + k;
          if (nx >= 0 && nx < w) {
            const kw = BLUR_KERNEL_1D[k + BLUR_RADIUS];
            sum += rawAlpha[z * w + nx] * kw;
            wt += kw;
          }
        }
        blurTemp[z * w + x] = (sum / wt + 0.5) | 0;
      }
    }

    // Vertical pass: blurTemp -> fogData alpha channel
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        let sum = 0;
        let wt = 0;
        for (let k = -BLUR_RADIUS; k <= BLUR_RADIUS; k++) {
          const nz = z + k;
          if (nz >= 0 && nz < h) {
            const kw = BLUR_KERNEL_1D[k + BLUR_RADIUS];
            sum += blurTemp[nz * w + x] * kw;
            wt += kw;
          }
        }
        const idx = (z * w + x) * 4;
        this.fogData[idx] = 0;     // R
        this.fogData[idx + 1] = 0; // G
        this.fogData[idx + 2] = 0; // B
        this.fogData[idx + 3] = (sum / wt + 0.5) | 0;
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

  /** Get the current visibility state of a tile */
  getTileState(tx: number, tz: number): number {
    if (!this.enabled) return FOG_VISIBLE;
    if (tx < 0 || tx >= this.mapW || tz < 0 || tz >= this.mapH) return FOG_UNEXPLORED;
    return this.visibility[tz * this.mapW + tx];
  }

  getVisibility(): Uint8Array {
    return this.visibility;
  }

  /** Serialize explored tiles for save/load */
  getExploredData(): number[] {
    // Run-length encode explored tiles for compact storage
    const result: number[] = [];
    let i = 0;
    const len = this.explored.length;
    while (i < len) {
      const val = this.explored[i];
      let run = 1;
      while (i + run < len && this.explored[i + run] === val && run < 255) run++;
      result.push(val, run);
      i += run;
    }
    return result;
  }

  /** Restore explored tiles from saved data */
  setExploredData(data: number[]): void {
    let idx = 0;
    for (let i = 0; i < data.length; i += 2) {
      const val = data[i];
      const run = data[i + 1];
      for (let j = 0; j < run && idx < this.explored.length; j++) {
        this.explored[idx++] = val;
      }
    }
    this.lastPositionHash = -1; // Force redraw
    this.fullDirty = true;
  }
}
