import * as THREE from 'three';
import type { SceneManager } from '../rendering/SceneManager';
import type { TerrainRenderer } from '../rendering/TerrainRenderer';
import { TerrainType } from '../rendering/TerrainRenderer';
import { Position, Owner, Health, BuildingType, buildingQuery, type World } from '../core/ECS';
import { worldToTile, tileToWorld, TILE_SIZE } from '../utils/MathUtils';
import { GameConstants } from '../utils/Constants';
import { EventBus } from '../core/EventBus';
import type { AudioManager } from '../audio/AudioManager';

type PlaceCallback = (typeName: string, x: number, z: number) => void;

export class BuildingPlacement {
  private sceneManager: SceneManager;
  private terrain: TerrainRenderer;
  private audioManager: AudioManager;
  private onPlace: PlaceCallback;

  private active = false;
  private typeName = '';
  private buildingSize = { w: 3, h: 3 }; // Tiles
  private allowedTerrain = new Set<TerrainType>(); // Per-building terrain requirements
  private concreteMode = false; // Special mode for placing concrete slabs
  private onConcrete: ((tx: number, tz: number) => boolean) | null = null;

  // Wall drag-to-build mode
  private wallMode = false;
  private wallDragging = false;
  private wallDragStart = { tx: -1, tz: -1 };
  private wallPreviewGroup: THREE.Group | null = null;
  private onWallLine: ((tiles: { tx: number; tz: number }[]) => void) | null = null;

  // Ghost preview
  private ghostMesh: THREE.Mesh | null = null;
  private gridHelper: THREE.Group | null = null;
  private validColor = new THREE.Color(0x00ff00);
  private invalidColor = new THREE.Color(0xff0000);
  private currentTile = { tx: -1, tz: -1 };
  private isValidPlacement = false;

  // Occupied tiles tracking
  private occupiedTiles = new Set<string>(); // All buildings (for overlap check)
  private ownedTiles = new Set<string>(); // Player-owned buildings (for proximity check)

  // Building context for footprint lookup
  private buildingTypeNames: string[] = [];
  private buildingFootprints = new Map<string, { w: number; h: number }>(); // typeName -> size

  constructor(
    sceneManager: SceneManager,
    terrain: TerrainRenderer,
    audioManager: AudioManager,
    onPlace: PlaceCallback
  ) {
    this.sceneManager = sceneManager;
    this.terrain = terrain;
    this.audioManager = audioManager;
    this.onPlace = onPlace;

    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('keydown', this.onKeyDown);
  }

  setBuildingContext(buildingTypeNames: string[], footprints: Map<string, { w: number; h: number }>): void {
    this.buildingTypeNames = buildingTypeNames;
    this.buildingFootprints = footprints;
  }

  startPlacement(typeName: string, sizeW = 3, sizeH = 3, terrainTypes?: string[]): void {
    this.cancel();
    this.concreteMode = false;
    this.onConcrete = null;
    this.active = true;
    this.typeName = typeName;
    this.buildingSize = { w: sizeW, h: sizeH };

    // Map terrain requirement strings to TerrainType enum values
    this.allowedTerrain.clear();
    const terrainList = terrainTypes ?? ['Rock'];
    for (const t of terrainList) {
      const lower = t.trim().toLowerCase();
      if (lower === 'rock' || lower === 'nbrock' || lower === 'ramp') {
        this.allowedTerrain.add(TerrainType.Rock);
        this.allowedTerrain.add(TerrainType.InfantryRock);
      } else if (lower === 'sand' || lower === 'dustbowl') {
        this.allowedTerrain.add(TerrainType.Sand);
        this.allowedTerrain.add(TerrainType.Dunes);
      } else if (lower === 'infrock') {
        this.allowedTerrain.add(TerrainType.InfantryRock);
      }
    }
    // Concrete slab is always valid terrain for building placement
    this.allowedTerrain.add(TerrainType.ConcreteSlab);

    // Create ghost preview mesh
    const geo = new THREE.BoxGeometry(
      sizeW * TILE_SIZE,
      TILE_SIZE,
      sizeH * TILE_SIZE
    );
    const mat = new THREE.MeshBasicMaterial({
      color: this.validColor,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    });
    this.ghostMesh = new THREE.Mesh(geo, mat);
    this.ghostMesh.position.y = TILE_SIZE / 2;
    this.sceneManager.scene.add(this.ghostMesh);

    // Create grid overlay
    this.gridHelper = new THREE.Group();
    for (let dz = 0; dz < sizeH; dz++) {
      for (let dx = 0; dx < sizeW; dx++) {
        const cellGeo = new THREE.PlaneGeometry(TILE_SIZE * 0.95, TILE_SIZE * 0.95);
        cellGeo.rotateX(-Math.PI / 2);
        const cellMat = new THREE.MeshBasicMaterial({
          color: this.validColor,
          transparent: true,
          opacity: 0.2,
          side: THREE.DoubleSide,
        });
        const cell = new THREE.Mesh(cellGeo, cellMat);
        cell.position.set(
          dx * TILE_SIZE - (sizeW - 1) * TILE_SIZE / 2,
          0.1,
          dz * TILE_SIZE - (sizeH - 1) * TILE_SIZE / 2
        );
        this.gridHelper.add(cell);
      }
    }
    this.sceneManager.scene.add(this.gridHelper);

    document.body.style.cursor = 'crosshair';
  }

  cancel(): void {
    if (!this.active) return;
    const cancelledType = this.typeName;
    this.active = false;
    this.typeName = '';
    this.concreteMode = false;
    this.wallMode = false;
    this.wallDragging = false;
    this.onConcrete = null;
    this.onWallLine = null;

    // Emit cancel event so cost can be refunded
    if (cancelledType) {
      EventBus.emit('placement:cancelled', { typeName: cancelledType });
    }

    if (this.ghostMesh) {
      this.sceneManager.scene.remove(this.ghostMesh);
      this.ghostMesh.geometry.dispose();
      (this.ghostMesh.material as THREE.Material).dispose();
      this.ghostMesh = null;
    }
    this.disposeGridHelper();
    this.disposeWallPreview();

    document.body.style.cursor = 'default';
  }

  private disposeGridHelper(): void {
    if (this.gridHelper) {
      this.sceneManager.scene.remove(this.gridHelper);
      for (const child of this.gridHelper.children) {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      }
      this.gridHelper = null;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  getOccupiedTiles(): Set<string> {
    return this.occupiedTiles;
  }

  // Call from game tick to update occupied tiles from ECS
  updateOccupiedTiles(world: World): void {
    this.occupiedTiles.clear();
    this.ownedTiles.clear();
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      if (Health.current[eid] <= 0) continue;
      const tile = worldToTile(Position.x[eid], Position.z[eid]);
      const isOwned = Owner.playerId[eid] === 0;
      const typeName = this.buildingTypeNames[BuildingType.id[eid]] ?? '';
      const fp = this.buildingFootprints.get(typeName) ?? { w: 3, h: 3 };
      const startX = -Math.floor((fp.w - 1) / 2);
      const startZ = -Math.floor((fp.h - 1) / 2);
      for (let dz = startZ; dz < startZ + fp.h; dz++) {
        for (let dx = startX; dx < startX + fp.w; dx++) {
          const key = `${tile.tx + dx},${tile.tz + dz}`;
          this.occupiedTiles.add(key);
          if (isOwned) this.ownedTiles.add(key);
        }
      }
    }
  }

  private checkValidity(tx: number, tz: number): boolean {
    const { w, h } = this.buildingSize;
    const startX = -Math.floor((w - 1) / 2);
    const startZ = -Math.floor((h - 1) / 2);

    for (let dz = startZ; dz < startZ + h; dz++) {
      for (let dx = startX; dx < startX + w; dx++) {
        const checkX = tx + dx;
        const checkZ = tz + dz;

        // Bounds check
        if (checkX < 2 || checkX >= this.terrain.getMapWidth() - 2 || checkZ < 2 || checkZ >= this.terrain.getMapHeight() - 2) {
          return false;
        }

        // Terrain must match building's allowed terrain types
        const terrain = this.terrain.getTerrainType(checkX, checkZ);
        if (!this.allowedTerrain.has(terrain)) {
          return false;
        }

        // Can't overlap existing buildings
        if (this.occupiedTiles.has(`${checkX},${checkZ}`)) {
          return false;
        }
      }
    }

    // Must be within range of existing player-owned buildings
    const maxDist = GameConstants.MAX_BUILDING_PLACEMENT_TILE_DIST;
    let nearBuilding = false;
    for (const key of this.ownedTiles) {
      const [bx, bz] = key.split(',').map(Number);
      const dist = Math.abs(bx - tx) + Math.abs(bz - tz);
      if (dist <= maxDist + 3) { // +3 for building footprint
        nearBuilding = true;
        break;
      }
    }

    return nearBuilding;
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.active || !this.ghostMesh) return;

    const worldPos = this.sceneManager.screenToWorld(e.clientX, e.clientY);
    if (!worldPos) return;

    const tile = worldToTile(worldPos.x, worldPos.z);
    if (tile.tx === this.currentTile.tx && tile.tz === this.currentTile.tz) return;

    this.currentTile = tile;
    const snapped = tileToWorld(tile.tx, tile.tz);

    this.ghostMesh.position.x = snapped.x;
    this.ghostMesh.position.z = snapped.z;
    if (this.gridHelper) {
      this.gridHelper.position.x = snapped.x;
      this.gridHelper.position.z = snapped.z;
    }

    // Wall mode: update drag preview
    if (this.wallMode) {
      this.isValidPlacement = this.isWallTileValid(tile.tx, tile.tz);
      const ghostColor = this.isValidPlacement ? this.validColor : this.invalidColor;
      (this.ghostMesh.material as THREE.MeshBasicMaterial).color.copy(ghostColor);
      if (this.wallDragging) {
        this.updateWallPreview();
      }
      return;
    }

    this.isValidPlacement = this.concreteMode
      ? this.checkConcreteValidity(tile.tx, tile.tz)
      : this.checkValidity(tile.tx, tile.tz);

    // Per-tile validity coloring for detailed feedback
    if (!this.concreteMode && this.gridHelper) {
      const { w, h } = this.buildingSize;
      const startX = -Math.floor((w - 1) / 2);
      const startZ = -Math.floor((h - 1) / 2);
      let idx = 0;
      for (let dz = 0; dz < h; dz++) {
        for (let dx = 0; dx < w; dx++) {
          const child = this.gridHelper.children[idx++];
          if (child instanceof THREE.Mesh) {
            const checkTx = tile.tx + startX + dx;
            const checkTz = tile.tz + startZ + dz;
            (child.material as THREE.MeshBasicMaterial).color.copy(
              this.isTileValid(checkTx, checkTz) ? this.validColor : this.invalidColor
            );
          }
        }
      }
    } else if (this.gridHelper) {
      const color = this.isValidPlacement ? this.validColor : this.invalidColor;
      this.gridHelper.children.forEach(child => {
        if (child instanceof THREE.Mesh) {
          (child.material as THREE.MeshBasicMaterial).color.copy(color);
        }
      });
    }

    // Ghost mesh overall color
    const ghostColor = this.isValidPlacement ? this.validColor : this.invalidColor;
    (this.ghostMesh.material as THREE.MeshBasicMaterial).color.copy(ghostColor);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.active) return;

    // Wall mode: start or end drag
    if (this.wallMode && e.button === 0) {
      if (!this.wallDragging) {
        // Start drag from current tile
        this.wallDragging = true;
        this.wallDragStart = { ...this.currentTile };
        this.updateWallPreview();
      } else {
        // End drag: place all valid wall tiles in the line
        const tiles = BuildingPlacement.getWallLineTiles(
          this.wallDragStart.tx, this.wallDragStart.tz,
          this.currentTile.tx, this.currentTile.tz
        );
        const validTiles = tiles.filter(t => this.isWallTileValid(t.tx, t.tz));
        if (validTiles.length > 0 && this.onWallLine) {
          this.onWallLine(validTiles);
          this.audioManager.playSfx('build');
        } else {
          this.audioManager.playSfx('error');
        }
        // Reset drag but stay in wall mode
        this.wallDragging = false;
        this.updateWallPreview();
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (this.wallMode && e.button === 2) {
      if (this.wallDragging) {
        // Cancel current drag
        this.wallDragging = false;
        this.updateWallPreview();
      } else {
        // Exit wall mode
        this.active = false;
        this.wallMode = false;
        this.onWallLine = null;
        this.typeName = '';
        if (this.ghostMesh) {
          this.sceneManager.scene.remove(this.ghostMesh);
          this.ghostMesh.geometry.dispose();
          (this.ghostMesh.material as THREE.Material).dispose();
          this.ghostMesh = null;
        }
        this.disposeGridHelper();
        this.disposeWallPreview();
        document.body.style.cursor = 'default';
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.button === 0 && this.isValidPlacement) {
      if (this.concreteMode && this.onConcrete) {
        // Concrete: place slab and stay in placement mode
        if (this.onConcrete(this.currentTile.tx, this.currentTile.tz)) {
          this.audioManager.playSfx('build');
        } else {
          this.audioManager.playSfx('error');
        }
        e.preventDefault();
        e.stopPropagation();
      } else {
        // Place the building
        const snapped = tileToWorld(this.currentTile.tx, this.currentTile.tz);
        this.onPlace(this.typeName, snapped.x, snapped.z);
        this.audioManager.playSfx('build');
        // Clean up placement ghost without emitting placement:cancelled (cost already spent)
        this.active = false;
        this.typeName = '';
        if (this.ghostMesh) {
          this.sceneManager.scene.remove(this.ghostMesh);
          this.ghostMesh.geometry.dispose();
          (this.ghostMesh.material as THREE.Material).dispose();
          this.ghostMesh = null;
        }
        this.disposeGridHelper();
        document.body.style.cursor = 'default';
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (e.button === 2) {
      // Cancel on right-click
      if (this.concreteMode) {
        // Exit concrete mode without refund event
        this.active = false;
        this.concreteMode = false;
        this.onConcrete = null;
        this.typeName = '';
        if (this.ghostMesh) {
          this.sceneManager.scene.remove(this.ghostMesh);
          this.ghostMesh.geometry.dispose();
          (this.ghostMesh.material as THREE.Material).dispose();
          this.ghostMesh = null;
        }
        this.disposeGridHelper();
        document.body.style.cursor = 'default';
      } else {
        this.audioManager.playSfx('error');
        this.cancel();
      }
      e.preventDefault();
      e.stopPropagation();
    } else if (e.button === 0 && !this.isValidPlacement) {
      this.audioManager.playSfx('error');
      this.audioManager.getDialogManager()?.trigger('cannotBuild');
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /** Start concrete slab placement mode — can place multiple slabs */
  startConcretePlacement(onPlace: (tx: number, tz: number) => boolean): void {
    this.cancel();
    this.concreteMode = true;
    this.onConcrete = onPlace;
    this.active = true;
    this.typeName = '__concrete__';
    this.buildingSize = { w: 1, h: 1 };

    // Small single-tile ghost
    const geo = new THREE.BoxGeometry(TILE_SIZE, 0.15, TILE_SIZE);
    const mat = new THREE.MeshBasicMaterial({
      color: this.validColor,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    this.ghostMesh = new THREE.Mesh(geo, mat);
    this.ghostMesh.position.y = 0.1;
    this.sceneManager.scene.add(this.ghostMesh);

    this.gridHelper = new THREE.Group();
    this.sceneManager.scene.add(this.gridHelper);

    document.body.style.cursor = 'crosshair';
  }

  private isTileValid(tx: number, tz: number): boolean {
    if (tx < 2 || tx >= this.terrain.getMapWidth() - 2 || tz < 2 || tz >= this.terrain.getMapHeight() - 2) return false;
    const terrain = this.terrain.getTerrainType(tx, tz);
    if (!this.allowedTerrain.has(terrain)) return false;
    if (this.occupiedTiles.has(`${tx},${tz}`)) return false;
    return true;
  }

  private checkConcreteValidity(tx: number, tz: number): boolean {
    if (tx < 2 || tx >= this.terrain.getMapWidth() - 2 || tz < 2 || tz >= this.terrain.getMapHeight() - 2) return false;
    const t = this.terrain.getTerrainType(tx, tz);
    // Can place on sand, dunes — not on rock, cliff, spice, or existing concrete
    return t === TerrainType.Sand || t === TerrainType.Dunes;
  }

  /** Start wall drag-to-build mode. Click and drag to place a line of wall segments. */
  startWallPlacement(
    typeName: string,
    terrainTypes: string[],
    onWallLine: (tiles: { tx: number; tz: number }[]) => void,
  ): void {
    this.cancel();
    this.wallMode = true;
    this.wallDragging = false;
    this.onWallLine = onWallLine;
    this.active = true;
    this.typeName = typeName;
    this.buildingSize = { w: 1, h: 1 };

    // Map terrain requirements
    this.allowedTerrain.clear();
    for (const t of terrainTypes) {
      const lower = t.trim().toLowerCase();
      if (lower === 'rock') { this.allowedTerrain.add(TerrainType.Rock); this.allowedTerrain.add(TerrainType.InfantryRock); }
      else if (lower === 'sand') { this.allowedTerrain.add(TerrainType.Sand); this.allowedTerrain.add(TerrainType.Dunes); }
    }
    this.allowedTerrain.add(TerrainType.ConcreteSlab);

    // Single-tile ghost for cursor position
    const geo = new THREE.BoxGeometry(TILE_SIZE, TILE_SIZE * 0.5, TILE_SIZE);
    const mat = new THREE.MeshBasicMaterial({
      color: this.validColor,
      transparent: true,
      opacity: 0.4,
      side: THREE.DoubleSide,
    });
    this.ghostMesh = new THREE.Mesh(geo, mat);
    this.ghostMesh.position.y = TILE_SIZE * 0.25;
    this.sceneManager.scene.add(this.ghostMesh);

    this.gridHelper = new THREE.Group();
    this.sceneManager.scene.add(this.gridHelper);

    // Preview group for the drag line
    this.wallPreviewGroup = new THREE.Group();
    this.sceneManager.scene.add(this.wallPreviewGroup);

    document.body.style.cursor = 'crosshair';
  }

  /** Bresenham line algorithm for wall tile line (shared with WallSystem) */
  static getWallLineTiles(startTx: number, startTz: number, endTx: number, endTz: number): { tx: number; tz: number }[] {
    const tiles: { tx: number; tz: number }[] = [];
    let dx = Math.abs(endTx - startTx);
    let dz = Math.abs(endTz - startTz);
    const sx = startTx < endTx ? 1 : -1;
    const sz = startTz < endTz ? 1 : -1;
    let err = dx - dz;
    let tx = startTx;
    let tz = startTz;
    while (true) {
      tiles.push({ tx, tz });
      if (tx === endTx && tz === endTz) break;
      const e2 = 2 * err;
      if (e2 > -dz) { err -= dz; tx += sx; }
      if (e2 < dx) { err += dx; tz += sz; }
    }
    return tiles;
  }

  private updateWallPreview(): void {
    if (!this.wallPreviewGroup) return;

    // Clear previous preview
    for (const child of [...this.wallPreviewGroup.children]) {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
      this.wallPreviewGroup.remove(child);
    }

    if (!this.wallDragging) return;

    const tiles = BuildingPlacement.getWallLineTiles(
      this.wallDragStart.tx, this.wallDragStart.tz,
      this.currentTile.tx, this.currentTile.tz
    );

    for (const t of tiles) {
      const isValid = this.isWallTileValid(t.tx, t.tz);
      const geo = new THREE.BoxGeometry(TILE_SIZE * 0.9, TILE_SIZE * 0.4, TILE_SIZE * 0.9);
      const mat = new THREE.MeshBasicMaterial({
        color: isValid ? this.validColor : this.invalidColor,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const worldPos = tileToWorld(t.tx, t.tz);
      mesh.position.set(worldPos.x, TILE_SIZE * 0.2, worldPos.z);
      this.wallPreviewGroup.add(mesh);
    }
  }

  private isWallTileValid(tx: number, tz: number): boolean {
    if (tx < 2 || tx >= this.terrain.getMapWidth() - 2 || tz < 2 || tz >= this.terrain.getMapHeight() - 2) return false;
    const terrain = this.terrain.getTerrainType(tx, tz);
    if (!this.allowedTerrain.has(terrain)) return false;
    if (this.occupiedTiles.has(`${tx},${tz}`)) return false;
    // Proximity check
    const maxDist = GameConstants.MAX_BUILDING_PLACEMENT_TILE_DIST;
    for (const key of this.ownedTiles) {
      const [bx, bz] = key.split(',').map(Number);
      if (Math.abs(bx - tx) + Math.abs(bz - tz) <= maxDist + 3) return true;
    }
    return false;
  }

  private disposeWallPreview(): void {
    if (this.wallPreviewGroup) {
      for (const child of [...this.wallPreviewGroup.children]) {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      }
      this.sceneManager.scene.remove(this.wallPreviewGroup);
      this.wallPreviewGroup = null;
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;
    if (e.key === 'Escape') {
      if (this.concreteMode || this.wallMode) {
        // Exit special mode without refund event
        this.active = false;
        this.concreteMode = false;
        this.wallMode = false;
        this.wallDragging = false;
        this.onConcrete = null;
        this.onWallLine = null;
        this.typeName = '';
        if (this.ghostMesh) {
          this.sceneManager.scene.remove(this.ghostMesh);
          this.ghostMesh.geometry.dispose();
          (this.ghostMesh.material as THREE.Material).dispose();
          this.ghostMesh = null;
        }
        this.disposeGridHelper();
        this.disposeWallPreview();
        document.body.style.cursor = 'default';
      } else {
        this.cancel();
      }
    }
  };
}
