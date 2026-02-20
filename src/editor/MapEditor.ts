/**
 * Map Editor for creating and modifying game maps.
 * Provides terrain painting, spice placement, spawn point editing,
 * and map save/load functionality.
 */

import { TerrainType, type TerrainRenderer } from '../rendering/TerrainRenderer';
import type { SceneManager } from '../rendering/SceneManager';
import { TILE_SIZE } from '../utils/MathUtils';
import * as THREE from 'three';

export type EditorTool = 'terrain' | 'spice' | 'height' | 'spawn' | 'eraser';

export interface SpawnPoint {
  x: number;
  z: number;
  playerId: number;
}

export interface EditorMapData {
  version: number;
  width: number;
  height: number;
  terrain: number[];
  spice: number[];
  heightmap: number[];
  spawnPoints: SpawnPoint[];
  name: string;
  author: string;
  maxPlayers: number;
}

const TERRAIN_COLORS: Record<TerrainType, string> = {
  [TerrainType.Sand]: '#C2A54F',
  [TerrainType.Rock]: '#8B7355',
  [TerrainType.SpiceLow]: '#D4842A',
  [TerrainType.SpiceHigh]: '#B85C1E',
  [TerrainType.Dunes]: '#D4B86A',
  [TerrainType.Cliff]: '#6B5B45',
  [TerrainType.ConcreteSlab]: '#808080',
  [TerrainType.InfantryRock]: '#9B8B6B',
};

const TERRAIN_NAMES: Record<number, string> = {
  [TerrainType.Sand]: 'Sand',
  [TerrainType.Rock]: 'Rock',
  [TerrainType.Dunes]: 'Dunes',
  [TerrainType.Cliff]: 'Cliff',
  [TerrainType.InfantryRock]: 'Infantry Rock',
};

const PAINTABLE_TERRAINS = [
  TerrainType.Sand,
  TerrainType.Rock,
  TerrainType.Dunes,
  TerrainType.Cliff,
  TerrainType.InfantryRock,
];

export class MapEditor {
  private terrain: TerrainRenderer;
  private scene: SceneManager;
  private container: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;

  private tool: EditorTool = 'terrain';
  private brushSize = 1;
  private selectedTerrain: TerrainType = TerrainType.Sand;
  private spiceIntensity = 0.8;
  private heightValue = 128;
  private spawnPoints: SpawnPoint[] = [];
  private nextSpawnId = 0;

  private painting = false;
  private mapName = 'Untitled Map';
  private mapAuthor = 'Unknown';

  private undoStack: Array<{ terrain: Uint8Array; spice: Float32Array }> = [];
  private maxUndo = 20;

  // Spawn point markers in 3D scene
  private spawnMarkers: THREE.Mesh[] = [];
  private spawnGeo: THREE.CylinderGeometry | null = null;

  constructor(terrain: TerrainRenderer, scene: SceneManager) {
    this.terrain = terrain;
    this.scene = scene;

    // Create editor UI
    this.container = document.createElement('div');
    this.container.id = 'map-editor';

    // Create minimap canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 256;
    this.minimapCtx = this.canvas.getContext('2d')!;

    this.buildUI();
    this.setupInputHandlers();
  }

  show(): void {
    document.body.appendChild(this.container);
    this.saveUndoState();
    this.updateMinimap();
  }

  hide(): void {
    this.container.remove();
    this.clearSpawnMarkers();
  }

  private buildUI(): void {
    this.container.style.cssText = `
      position: fixed; top: 10px; right: 10px; width: 260px;
      background: rgba(0,0,0,0.9); color: #ccc; padding: 12px;
      border: 1px solid #555; border-radius: 6px; z-index: 8000;
      font-family: 'Trebuchet MS', sans-serif; font-size: 13px;
      max-height: 90vh; overflow-y: auto;
    `;

    this.container.innerHTML = `
      <h3 style="color: #d4a843; margin: 0 0 10px; text-align: center;">MAP EDITOR</h3>

      <div style="margin-bottom: 10px;">
        <label style="color: #888; font-size: 11px;">Tool:</label>
        <div id="ed-tools" style="display: flex; gap: 4px; margin-top: 4px;">
          ${this.makeToolBtn('terrain', 'Terrain')}
          ${this.makeToolBtn('spice', 'Spice')}
          ${this.makeToolBtn('height', 'Height')}
          ${this.makeToolBtn('spawn', 'Spawns')}
          ${this.makeToolBtn('eraser', 'Eraser')}
        </div>
      </div>

      <div id="ed-terrain-panel" style="margin-bottom: 10px;">
        <label style="color: #888; font-size: 11px;">Terrain Type:</label>
        <div id="ed-terrain-types" style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">
          ${PAINTABLE_TERRAINS.map((t) => `
            <button data-terrain="${t}" style="
              width: 46px; height: 28px; border: 2px solid ${this.selectedTerrain === t ? '#ff0' : '#555'};
              background: ${TERRAIN_COLORS[t]}; cursor: pointer; border-radius: 3px;
              font-size: 9px; color: #fff; text-shadow: 0 0 3px #000;
            ">${TERRAIN_NAMES[t]}</button>
          `).join('')}
        </div>
      </div>

      <div id="ed-spice-panel" style="margin-bottom: 10px; display: none;">
        <label style="color: #888; font-size: 11px;">Spice Intensity:</label>
        <input id="ed-spice-slider" type="range" min="0.1" max="1" step="0.1" value="${this.spiceIntensity}"
          style="width: 100%; margin-top: 4px;">
        <span id="ed-spice-val" style="color: #d4842a;">${(this.spiceIntensity * 100).toFixed(0)}%</span>
      </div>

      <div id="ed-height-panel" style="margin-bottom: 10px; display: none;">
        <label style="color: #888; font-size: 11px;">Height Value:</label>
        <input id="ed-height-slider" type="range" min="0" max="255" step="1" value="${this.heightValue}"
          style="width: 100%; margin-top: 4px;">
        <span id="ed-height-val" style="color: #8bf;">${this.heightValue}</span>
      </div>

      <div style="margin-bottom: 10px;">
        <label style="color: #888; font-size: 11px;">Brush Size:</label>
        <input id="ed-brush-slider" type="range" min="1" max="10" step="1" value="${this.brushSize}"
          style="width: 100%; margin-top: 4px;">
        <span id="ed-brush-val" style="color: #aaa;">${this.brushSize}</span>
      </div>

      <div style="margin-bottom: 10px;">
        <label style="color: #888; font-size: 11px;">Map Preview:</label>
        <div style="margin-top: 4px; text-align: center;"></div>
      </div>

      <div style="margin-bottom: 10px;">
        <label style="color: #888; font-size: 11px;">Map Name:</label>
        <input id="ed-map-name" type="text" value="${this.mapName}"
          style="width: 100%; background: #222; color: #ccc; border: 1px solid #555; padding: 4px; margin-top: 4px; box-sizing: border-box;">
      </div>

      <div style="display: flex; gap: 6px; flex-wrap: wrap;">
        <button id="ed-save" style="${edBtnStyle}">Save Map</button>
        <button id="ed-load" style="${edBtnStyle}">Load Map</button>
        <button id="ed-export" style="${edBtnStyle}">Export</button>
        <button id="ed-undo" style="${edBtnStyle}">Undo</button>
        <button id="ed-new" style="${edBtnStyle}">New Map</button>
      </div>

      <input id="ed-file-input" type="file" accept=".json" style="display: none;">
    `;

    // Append minimap canvas
    const previewContainer = this.container.querySelector('[style*="text-align: center"]');
    if (previewContainer) previewContainer.appendChild(this.canvas);

    this.bindEvents();
  }

  private makeToolBtn(tool: EditorTool, label: string): string {
    const active = this.tool === tool;
    return `<button data-tool="${tool}" style="
      flex: 1; padding: 5px 2px; background: ${active ? '#446' : '#333'};
      color: ${active ? '#fff' : '#aaa'}; border: 1px solid ${active ? '#88f' : '#555'};
      cursor: pointer; border-radius: 3px; font-size: 11px;
    ">${label}</button>`;
  }

  private bindEvents(): void {
    // Tool selection
    this.container.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tool = (btn as HTMLElement).dataset.tool as EditorTool;
        this.updateToolPanels();
        this.rebuildToolButtons();
      });
    });

    // Terrain type selection
    this.container.querySelectorAll('[data-terrain]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedTerrain = parseInt((btn as HTMLElement).dataset.terrain!) as TerrainType;
        this.updateTerrainButtons();
      });
    });

    // Sliders
    const spiceSlider = this.container.querySelector('#ed-spice-slider') as HTMLInputElement;
    spiceSlider?.addEventListener('input', () => {
      this.spiceIntensity = parseFloat(spiceSlider.value);
      const val = this.container.querySelector('#ed-spice-val');
      if (val) val.textContent = `${(this.spiceIntensity * 100).toFixed(0)}%`;
    });

    const heightSlider = this.container.querySelector('#ed-height-slider') as HTMLInputElement;
    heightSlider?.addEventListener('input', () => {
      this.heightValue = parseInt(heightSlider.value);
      const val = this.container.querySelector('#ed-height-val');
      if (val) val.textContent = `${this.heightValue}`;
    });

    const brushSlider = this.container.querySelector('#ed-brush-slider') as HTMLInputElement;
    brushSlider?.addEventListener('input', () => {
      this.brushSize = parseInt(brushSlider.value);
      const val = this.container.querySelector('#ed-brush-val');
      if (val) val.textContent = `${this.brushSize}`;
    });

    // Map name
    const nameInput = this.container.querySelector('#ed-map-name') as HTMLInputElement;
    nameInput?.addEventListener('change', () => {
      this.mapName = nameInput.value;
    });

    // Buttons
    this.container.querySelector('#ed-save')?.addEventListener('click', () => this.saveMap());
    this.container.querySelector('#ed-load')?.addEventListener('click', () => {
      (this.container.querySelector('#ed-file-input') as HTMLInputElement)?.click();
    });
    this.container.querySelector('#ed-export')?.addEventListener('click', () => this.exportMap());
    this.container.querySelector('#ed-undo')?.addEventListener('click', () => this.undo());
    this.container.querySelector('#ed-new')?.addEventListener('click', () => this.newMap());

    const fileInput = this.container.querySelector('#ed-file-input') as HTMLInputElement;
    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this.importMap(file);
      fileInput.value = '';
    });
  }

  private setupInputHandlers(): void {
    const onMouseDown = (e: MouseEvent) => {
      if (!this.container.parentElement) return; // Not active
      if (e.target && this.container.contains(e.target as Node)) return; // Click on UI
      if (e.button !== 0) return;

      this.painting = true;
      this.saveUndoState();
      this.paintAt(e);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (this.painting) this.paintAt(e);
    };

    const onMouseUp = () => {
      if (this.painting) {
        this.painting = false;
        this.terrain.updateSpiceVisuals();
        this.updateMinimap();
      }
    };

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  private paintAt(e: MouseEvent): void {
    const hit = this.scene.screenToWorld(e.clientX, e.clientY);
    if (!hit) return;

    const cx = Math.floor(hit.x / TILE_SIZE);
    const cz = Math.floor(hit.z / TILE_SIZE);
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();

    // Spawn tool places at center regardless of brush size
    if (this.tool === 'spawn') {
      if (cx >= 0 && cx < w && cz >= 0 && cz < h) {
        this.addSpawnPoint(cx * TILE_SIZE, cz * TILE_SIZE);
      }
      return;
    }

    const r = this.brushSize - 1;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r + r) continue;
        const tx = cx + dx;
        const tz = cz + dz;
        if (tx < 0 || tx >= w || tz < 0 || tz >= h) continue;

        switch (this.tool) {
          case 'terrain':
            this.terrain.setTerrainType(tx, tz, this.selectedTerrain);
            break;
          case 'spice':
            this.terrain.setSpice(tx, tz, this.spiceIntensity);
            break;
          case 'eraser':
            this.terrain.setTerrainType(tx, tz, TerrainType.Sand);
            this.terrain.setSpice(tx, tz, 0);
            break;
          case 'height':
            break;
        }
      }
    }
  }

  // --- Spawn Points ---

  private addSpawnPoint(x: number, z: number): void {
    if (this.spawnPoints.length >= 8) return;
    this.spawnPoints.push({ x, z, playerId: this.nextSpawnId++ });
    this.updateSpawnMarkers();
  }

  private removeSpawnPoint(index: number): void {
    this.spawnPoints.splice(index, 1);
    this.updateSpawnMarkers();
  }

  private updateSpawnMarkers(): void {
    this.clearSpawnMarkers();
    if (!this.spawnGeo) {
      this.spawnGeo = new THREE.CylinderGeometry(0.5, 0.5, 3, 8);
    }
    const colors = [0x4488ff, 0xff4444, 0x44cc44, 0xffcc00, 0xff88ff, 0x88ffff, 0xff8844, 0x8844ff];

    for (let i = 0; i < this.spawnPoints.length; i++) {
      const sp = this.spawnPoints[i];
      const mat = new THREE.MeshBasicMaterial({ color: colors[i % colors.length] });
      const mesh = new THREE.Mesh(this.spawnGeo, mat);
      mesh.position.set(sp.x, 2, sp.z);
      this.scene.scene.add(mesh);
      this.spawnMarkers.push(mesh);
    }
  }

  private clearSpawnMarkers(): void {
    for (const m of this.spawnMarkers) {
      this.scene.scene.remove(m);
      (m.material as THREE.MeshBasicMaterial).dispose();
    }
    this.spawnMarkers = [];
  }

  // --- Undo ---

  private saveUndoState(): void {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();
    const terrainCopy = new Uint8Array(w * h);
    const spiceCopy = new Float32Array(w * h);

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        terrainCopy[z * w + x] = this.terrain.getTerrainType(x, z);
        spiceCopy[z * w + x] = this.terrain.getSpice(x, z);
      }
    }

    this.undoStack.push({ terrain: terrainCopy, spice: spiceCopy });
    if (this.undoStack.length > this.maxUndo) {
      this.undoStack.shift();
    }
  }

  private undo(): void {
    if (this.undoStack.length <= 1) return; // Keep baseline state
    this.undoStack.pop(); // Discard current state
    const state = this.undoStack[this.undoStack.length - 1]; // Restore previous

    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        this.terrain.setTerrainType(x, z, state.terrain[z * w + x]);
        this.terrain.setSpice(x, z, state.spice[z * w + x]);
      }
    }

    this.terrain.updateSpiceVisuals();
    this.updateMinimap();
  }

  // --- Minimap ---

  updateMinimap(): void {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const sx = cw / w;
    const sz = ch / h;

    this.minimapCtx.fillStyle = '#000';
    this.minimapCtx.fillRect(0, 0, cw, ch);

    for (let tz = 0; tz < h; tz++) {
      for (let tx = 0; tx < w; tx++) {
        const type = this.terrain.getTerrainType(tx, tz);
        this.minimapCtx.fillStyle = TERRAIN_COLORS[type] ?? '#000';
        this.minimapCtx.fillRect(tx * sx, tz * sz, Math.ceil(sx), Math.ceil(sz));
      }
    }

    // Draw spawn points
    const colors = ['#4488ff', '#ff4444', '#44cc44', '#ffcc00', '#ff88ff', '#88ffff', '#ff8844', '#8844ff'];
    for (let i = 0; i < this.spawnPoints.length; i++) {
      const sp = this.spawnPoints[i];
      const px = (sp.x / 2) * sx;
      const pz = (sp.z / 2) * sz;
      this.minimapCtx.fillStyle = colors[i % colors.length];
      this.minimapCtx.beginPath();
      this.minimapCtx.arc(px, pz, 4, 0, Math.PI * 2);
      this.minimapCtx.fill();
    }
  }

  // --- Save/Load ---

  private buildMapData(): EditorMapData {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();
    const terrainArr: number[] = [];
    const spiceArr: number[] = [];
    const heightArr: number[] = [];

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        terrainArr.push(this.terrain.getTerrainType(x, z));
        spiceArr.push(Math.round(this.terrain.getSpice(x, z) * 100) / 100);
        heightArr.push(0); // Placeholder - heightmap editing not yet implemented
      }
    }

    return {
      version: 1,
      width: w,
      height: h,
      terrain: terrainArr,
      spice: spiceArr,
      heightmap: heightArr,
      spawnPoints: [...this.spawnPoints],
      name: this.mapName,
      author: this.mapAuthor,
      maxPlayers: Math.max(2, this.spawnPoints.length),
    };
  }

  saveMap(): void {
    const data = this.buildMapData();
    const key = `ebfd_editor_${data.name.replace(/\s/g, '_').toLowerCase()}`;
    localStorage.setItem(key, JSON.stringify(data));

    // Update saved maps index
    const index: string[] = JSON.parse(localStorage.getItem('ebfd_editor_maps') || '[]');
    if (!index.includes(key)) {
      index.push(key);
      localStorage.setItem('ebfd_editor_maps', JSON.stringify(index));
    }

    this.showToast(`Map "${data.name}" saved`);
  }

  exportMap(): void {
    const data = this.buildMapData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.name.replace(/\s/g, '_')}.ebfd-map.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async importMap(file: File): Promise<void> {
    try {
      const text = await file.text();
      const data = JSON.parse(text) as EditorMapData;
      if (!data.version || !Array.isArray(data.terrain) || !data.width || !data.height) {
        this.showToast('Invalid map file format');
        return;
      }
      this.loadMapData(data);
      this.showToast(`Loaded "${data.name}"`);
    } catch {
      this.showToast('Failed to load map file');
    }
  }

  loadMapData(data: EditorMapData): void {
    const mapW = this.terrain.getMapWidth();
    const mapH = this.terrain.getMapHeight();
    if (data.width !== mapW || data.height !== mapH) {
      this.showToast(`Map size mismatch: ${data.width}x${data.height} vs ${mapW}x${mapH}`);
      return;
    }

    const w = data.width;
    const h = data.height;

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const idx = z * w + x;
        this.terrain.setTerrainType(x, z, data.terrain[idx]);
        this.terrain.setSpice(x, z, data.spice[idx] ?? 0);
      }
    }

    this.spawnPoints = data.spawnPoints ? [...data.spawnPoints] : [];
    this.nextSpawnId = this.spawnPoints.length;
    this.mapName = data.name || 'Untitled';
    this.mapAuthor = data.author || 'Unknown';

    const nameInput = this.container.querySelector('#ed-map-name') as HTMLInputElement;
    if (nameInput) nameInput.value = this.mapName;

    this.terrain.updateSpiceVisuals();
    this.updateSpawnMarkers();
    this.updateMinimap();
  }

  private newMap(): void {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();

    this.saveUndoState();

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        // Border = cliff, interior = sand
        if (x < 2 || x >= w - 2 || z < 2 || z >= h - 2) {
          this.terrain.setTerrainType(x, z, TerrainType.Cliff);
        } else {
          this.terrain.setTerrainType(x, z, TerrainType.Sand);
        }
        this.terrain.setSpice(x, z, 0);
      }
    }

    this.spawnPoints = [];
    this.nextSpawnId = 0;
    this.mapName = 'Untitled Map';
    const nameInput = this.container.querySelector('#ed-map-name') as HTMLInputElement;
    if (nameInput) nameInput.value = this.mapName;

    this.terrain.updateSpiceVisuals();
    this.clearSpawnMarkers();
    this.updateMinimap();
  }

  // --- UI Helpers ---

  private updateToolPanels(): void {
    const show = (id: string, visible: boolean) => {
      const el = this.container.querySelector(id) as HTMLElement;
      if (el) el.style.display = visible ? 'block' : 'none';
    };
    show('#ed-terrain-panel', this.tool === 'terrain');
    show('#ed-spice-panel', this.tool === 'spice');
    show('#ed-height-panel', this.tool === 'height');
  }

  private rebuildToolButtons(): void {
    const toolsDiv = this.container.querySelector('#ed-tools');
    if (!toolsDiv) return;
    toolsDiv.innerHTML = `
      ${this.makeToolBtn('terrain', 'Terrain')}
      ${this.makeToolBtn('spice', 'Spice')}
      ${this.makeToolBtn('height', 'Height')}
      ${this.makeToolBtn('spawn', 'Spawns')}
      ${this.makeToolBtn('eraser', 'Eraser')}
    `;
    toolsDiv.querySelectorAll('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tool = (btn as HTMLElement).dataset.tool as EditorTool;
        this.updateToolPanels();
        this.rebuildToolButtons();
      });
    });
  }

  private updateTerrainButtons(): void {
    this.container.querySelectorAll('[data-terrain]').forEach((btn) => {
      const t = parseInt((btn as HTMLElement).dataset.terrain!);
      (btn as HTMLElement).style.borderColor = t === this.selectedTerrain ? '#ff0' : '#555';
    });
  }

  private showToast(message: string): void {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: #333; color: #ccc; padding: 8px 20px; border-radius: 4px;
      z-index: 9999; font-size: 13px; border: 1px solid #555;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }

  /** Get the list of saved editor maps from localStorage */
  static getSavedMaps(): Array<{ key: string; name: string }> {
    const index: string[] = JSON.parse(localStorage.getItem('ebfd_editor_maps') || '[]');
    return index.map((key) => {
      try {
        const data = JSON.parse(localStorage.getItem(key) || '{}') as EditorMapData;
        return { key, name: data.name || key };
      } catch {
        return { key, name: key };
      }
    });
  }

  /** Load a saved map by localStorage key */
  loadSavedMap(key: string): void {
    const json = localStorage.getItem(key);
    if (!json) return;
    try {
      const data = JSON.parse(json) as EditorMapData;
      this.loadMapData(data);
    } catch {
      this.showToast('Failed to load saved map');
    }
  }
}

const edBtnStyle = `
  padding: 5px 10px; background: #333; color: #ccc; border: 1px solid #555;
  border-radius: 3px; cursor: pointer; font-size: 11px;
  font-family: 'Trebuchet MS', sans-serif;
`;
