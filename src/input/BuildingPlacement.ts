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

  startPlacement(typeName: string, sizeW = 3, sizeH = 3, terrainTypes?: string[]): void {
    this.cancel();
    this.active = true;
    this.typeName = typeName;
    this.buildingSize = { w: sizeW, h: sizeH };

    // Map terrain requirement strings to TerrainType enum values
    this.allowedTerrain.clear();
    const terrainList = terrainTypes ?? ['Rock'];
    for (const t of terrainList) {
      const lower = t.trim().toLowerCase();
      if (lower === 'rock') { this.allowedTerrain.add(TerrainType.Rock); this.allowedTerrain.add(TerrainType.InfantryRock); }
      else if (lower === 'sand') { this.allowedTerrain.add(TerrainType.Sand); this.allowedTerrain.add(TerrainType.Dunes); }
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
    if (this.gridHelper) {
      this.sceneManager.scene.remove(this.gridHelper);
      this.gridHelper = null;
    }

    document.body.style.cursor = 'default';
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
      // Mark 3x3 area as occupied (approximate building footprint)
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const key = `${tile.tx + dx},${tile.tz + dz}`;
          this.occupiedTiles.add(key);
          if (isOwned) this.ownedTiles.add(key);
        }
      }
    }
  }

  private checkValidity(tx: number, tz: number): boolean {
    const { w, h } = this.buildingSize;
    const halfW = Math.floor(w / 2);
    const halfH = Math.floor(h / 2);

    for (let dz = -halfH; dz <= halfH; dz++) {
      for (let dx = -halfW; dx <= halfW; dx++) {
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
    if (!this.active || !this.ghostMesh || !this.gridHelper) return;

    const worldPos = this.sceneManager.screenToWorld(e.clientX, e.clientY);
    if (!worldPos) return;

    const tile = worldToTile(worldPos.x, worldPos.z);
    if (tile.tx === this.currentTile.tx && tile.tz === this.currentTile.tz) return;

    this.currentTile = tile;
    const snapped = tileToWorld(tile.tx, tile.tz);

    this.ghostMesh.position.x = snapped.x;
    this.ghostMesh.position.z = snapped.z;
    this.gridHelper.position.x = snapped.x;
    this.gridHelper.position.z = snapped.z;

    this.isValidPlacement = this.concreteMode
      ? this.checkConcreteValidity(tile.tx, tile.tz)
      : this.checkValidity(tile.tx, tile.tz);

    // Per-tile validity coloring for detailed feedback
    if (!this.concreteMode) {
      const { w, h } = this.buildingSize;
      const halfW = Math.floor(w / 2);
      const halfH = Math.floor(h / 2);
      let idx = 0;
      for (let dz = 0; dz < h; dz++) {
        for (let dx = 0; dx < w; dx++) {
          const child = this.gridHelper.children[idx++];
          if (child instanceof THREE.Mesh) {
            const checkTx = tile.tx + dx - halfW;
            const checkTz = tile.tz + dz - halfH;
            (child.material as THREE.MeshBasicMaterial).color.copy(
              this.isTileValid(checkTx, checkTz) ? this.validColor : this.invalidColor
            );
          }
        }
      }
    } else {
      const color = this.isValidPlacement ? this.validColor : this.invalidColor;
      this.gridHelper.children.forEach(child => {
        if (child instanceof THREE.Mesh) {
          (child.material as THREE.MeshBasicMaterial).color = color;
        }
      });
    }

    // Ghost mesh overall color
    const ghostColor = this.isValidPlacement ? this.validColor : this.invalidColor;
    (this.ghostMesh.material as THREE.MeshBasicMaterial).color = ghostColor;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.active) return;

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
        this.cancel();
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
        if (this.gridHelper) {
          this.sceneManager.scene.remove(this.gridHelper);
          this.gridHelper = null;
        }
        document.body.style.cursor = 'default';
      } else {
        this.audioManager.playSfx('error');
        this.cancel();
      }
      e.preventDefault();
      e.stopPropagation();
    } else if (e.button === 0 && !this.isValidPlacement) {
      this.audioManager.playSfx('error');
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

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active) return;
    if (e.key === 'Escape') {
      this.cancel();
    }
  };
}
