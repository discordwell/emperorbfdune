/**
 * Map Editor for creating and modifying game maps.
 * Provides terrain painting, spice placement, height editing,
 * object placement (spawns, entrances, script points, buildings, units),
 * grid overlay, undo/redo, and map save/load (.bin + JSON).
 */

import { TerrainType, type TerrainRenderer } from '../rendering/TerrainRenderer';
import type { SceneManager } from '../rendering/SceneManager';
import { TILE_SIZE } from '../utils/MathUtils';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EditorTool =
  | 'terrain'
  | 'spice'
  | 'height'
  | 'spawn'
  | 'entrance'
  | 'script'
  | 'building'
  | 'unit'
  | 'eraser';

export interface SpawnPoint {
  x: number;
  z: number;
  playerId: number;
}

export interface EntrancePoint {
  marker: number;
  x: number;
  z: number;
}

export interface ScriptPoint {
  index: number; // 1-24 (ScriptN)
  x: number;
  z: number;
}

export interface PlacedEntity {
  kind: 'building' | 'unit';
  name: string;
  owner: number;
  x: number;
  z: number;
}

export interface EditorMapData {
  version: number;
  width: number;
  height: number;
  terrain: number[];
  spice: number[];
  heightmap: number[];
  spawnPoints: SpawnPoint[];
  entrances: EntrancePoint[];
  scriptPoints: ScriptPoint[];
  entities: PlacedEntity[];
  name: string;
  author: string;
  maxPlayers: number;
}

// ---------------------------------------------------------------------------
// Undo/redo state snapshot
// ---------------------------------------------------------------------------

interface EditorSnapshot {
  terrain: Uint8Array;
  spice: Float32Array;
  heightmap: Uint8Array;
  spawnPoints: SpawnPoint[];
  entrances: EntrancePoint[];
  scriptPoints: ScriptPoint[];
  entities: PlacedEntity[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  [TerrainType.InfantryRock]: 'Inf. Rock',
  [TerrainType.ConcreteSlab]: 'Concrete',
};

const PAINTABLE_TERRAINS = [
  TerrainType.Sand,
  TerrainType.Rock,
  TerrainType.Dunes,
  TerrainType.Cliff,
  TerrainType.InfantryRock,
  TerrainType.ConcreteSlab,
];

const PLAYER_COLORS = [
  '#4488ff', '#ff4444', '#44cc44', '#ffcc00',
  '#ff88ff', '#88ffff', '#ff8844', '#8844ff',
];

const PLAYER_HEX = [
  0x4488ff, 0xff4444, 0x44cc44, 0xffcc00,
  0xff88ff, 0x88ffff, 0xff8844, 0x8844ff,
];

// .bin header: uint16 width, uint16 height, float32 ambientR, float32 ambientG = 12 bytes
const BIN_HEADER_SIZE = 12;

// Max terrain height from heightmap 0-255 (matches TerrainRenderer)
const MAX_ELEVATION = 3.0;

// Common building and unit names for placement palette
const BUILDING_NAMES = [
  'ATConYard', 'HKConYard', 'ORConYard',
  'ATSmWindtrap', 'HKSmWindtrap', 'ORSmWindtrap',
  'ATBarracks', 'HKBarracks', 'ORBarracks',
  'ATFactory', 'HKFactory', 'ORFactory',
  'ATRefinery', 'HKRefinery', 'ORRefinery',
  'ATOutpost', 'HKOutpost', 'OROutpost',
  'ATHangar', 'HKHangar', 'ORHangar',
  'ATPalace', 'HKPalace', 'ORPalace',
  'ATRocketTurret', 'HKGunTurret', 'ORPopUpTurret',
];

const UNIT_NAMES = [
  'ATLightInfantry', 'HKLightInfantry', 'ORLightInfantry',
  'ATTrooper', 'HKTrooper', 'ORTrooper',
  'ATMongoose', 'HKBuzzsaw', 'ORDustScout',
  'ATMirageTank', 'HKAssaultTank', 'ORKobra',
  'ATSonicTank', 'HKDevastator', 'ORDeviator',
  'Harvester',
];

// Shared CSS for inline editor buttons
const ED_BTN_STYLE = `
  padding: 5px 10px; background: #333; color: #ccc; border: 1px solid #555;
  border-radius: 3px; cursor: pointer; font-size: 11px;
  font-family: 'Trebuchet MS', sans-serif;
`;

// ---------------------------------------------------------------------------
// MapEditor class
// ---------------------------------------------------------------------------

export class MapEditor {
  private terrain: TerrainRenderer;
  private scene: SceneManager;
  private container: HTMLDivElement;
  private minimapCanvas: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;

  // Current tool state
  private tool: EditorTool = 'terrain';
  private brushSize = 1;
  private selectedTerrain: TerrainType = TerrainType.Sand;
  private spiceIntensity = 0.8;
  private heightValue = 128;
  private heightMode: 'set' | 'raise' | 'lower' | 'smooth' = 'set';
  private selectedBuilding = BUILDING_NAMES[0];
  private selectedUnit = UNIT_NAMES[0];
  private placementOwner = 0;
  private nextScriptIndex = 1;

  // Map objects
  private spawnPoints: SpawnPoint[] = [];
  private nextSpawnId = 0;
  private entrances: EntrancePoint[] = [];
  private nextEntranceMarker = 0;
  private scriptPoints: ScriptPoint[] = [];
  private placedEntities: PlacedEntity[] = [];

  // Heightmap for editor (separate from TerrainRenderer's internal)
  private editorHeightmap: Uint8Array;

  // Painting state
  private painting = false;
  private mapName = 'Untitled Map';
  private mapAuthor = 'Unknown';

  // Undo/redo
  private undoStack: EditorSnapshot[] = [];
  private redoStack: EditorSnapshot[] = [];
  private maxUndo = 30;

  // 3D markers
  private spawnMarkers: THREE.Group[] = [];
  private entranceMarkers: THREE.Mesh[] = [];
  private scriptMarkers: THREE.Group[] = [];
  private entityMarkers: THREE.Mesh[] = [];
  private spawnGeo: THREE.CylinderGeometry | null = null;
  private entranceGeo: THREE.BoxGeometry | null = null;
  private scriptGeo: THREE.OctahedronGeometry | null = null;
  private entityGeo: THREE.BoxGeometry | null = null;

  // Grid overlay
  private gridHelper: THREE.GridHelper | null = null;
  private gridVisible = false;

  // Brush cursor visualization
  private brushCursor: THREE.Mesh | null = null;

  // Event handler references for cleanup
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseUp: () => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(terrain: TerrainRenderer, scene: SceneManager) {
    this.terrain = terrain;
    this.scene = scene;

    const w = terrain.getMapWidth();
    const h = terrain.getMapHeight();
    this.editorHeightmap = new Uint8Array(w * h);

    // Create editor UI container
    this.container = document.createElement('div');
    this.container.id = 'map-editor';

    // Minimap canvas
    this.minimapCanvas = document.createElement('canvas');
    this.minimapCanvas.width = 256;
    this.minimapCanvas.height = 256;
    this.minimapCtx = this.minimapCanvas.getContext('2d')!;

    // Bind event handlers
    this.boundMouseDown = (e: MouseEvent) => this.onMouseDown(e);
    this.boundMouseMove = (e: MouseEvent) => this.onMouseMove(e);
    this.boundMouseUp = () => this.onMouseUp();
    this.boundKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);

    this.buildUI();
  }

  // =========================================================================
  // Public API
  // =========================================================================

  show(): void {
    document.body.appendChild(this.container);
    this.setupInputHandlers();
    this.pushUndoState();
    this.updateMinimap();
    this.createBrushCursor();
  }

  hide(): void {
    this.container.remove();
    this.teardownInputHandlers();
    this.clearAllMarkers();
    this.removeBrushCursor();
    this.removeGrid();
  }

  dispose(): void {
    this.hide();
    this.spawnGeo?.dispose();
    this.entranceGeo?.dispose();
    this.scriptGeo?.dispose();
    this.entityGeo?.dispose();
    if (this.brushCursor) {
      this.brushCursor.geometry.dispose();
      (this.brushCursor.material as THREE.Material).dispose();
    }
  }

  // =========================================================================
  // UI Construction
  // =========================================================================

  private buildUI(): void {
    this.container.style.cssText = `
      position: fixed; top: 10px; right: 10px; width: 280px;
      background: rgba(0,0,0,0.92); color: #ccc; padding: 12px;
      border: 1px solid #555; border-radius: 6px; z-index: 8000;
      font-family: 'Trebuchet MS', sans-serif; font-size: 13px;
      max-height: 95vh; overflow-y: auto;
      user-select: none;
    `;

    this.container.innerHTML = `
      <h3 style="color: #d4a843; margin: 0 0 8px; text-align: center; font-size: 15px; letter-spacing: 2px;">MAP EDITOR</h3>

      <!-- Tool buttons -->
      <div style="margin-bottom: 8px;">
        <label style="color: #888; font-size: 11px;">Tool: <span id="ed-shortcut-hint" style="color:#666; font-style:italic;"></span></label>
        <div id="ed-tools" style="display: flex; gap: 3px; margin-top: 4px; flex-wrap: wrap;"></div>
      </div>

      <!-- Terrain panel -->
      <div id="ed-terrain-panel" style="margin-bottom: 8px;">
        <label style="color: #888; font-size: 11px;">Terrain Type:</label>
        <div id="ed-terrain-types" style="display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px;"></div>
      </div>

      <!-- Spice panel -->
      <div id="ed-spice-panel" style="margin-bottom: 8px; display: none;">
        <label style="color: #888; font-size: 11px;">Spice Density:</label>
        <div style="display:flex; align-items:center; gap:8px; margin-top:4px;">
          <button id="ed-spice-low" style="${ED_BTN_STYLE} flex:1; background:#d4842a33; border-color:#d4842a;">Low</button>
          <button id="ed-spice-high" style="${ED_BTN_STYLE} flex:1; background:#b85c1e33; border-color:#b85c1e;">High</button>
        </div>
        <input id="ed-spice-slider" type="range" min="0.1" max="1" step="0.05" value="${this.spiceIntensity}"
          style="width: 100%; margin-top: 4px;">
        <span id="ed-spice-val" style="color: #d4842a;">${(this.spiceIntensity * 100).toFixed(0)}%</span>
      </div>

      <!-- Height panel -->
      <div id="ed-height-panel" style="margin-bottom: 8px; display: none;">
        <label style="color: #888; font-size: 11px;">Height Mode:</label>
        <div id="ed-height-modes" style="display:flex; gap:3px; margin-top:4px;"></div>
        <label style="color: #888; font-size: 11px; margin-top:6px; display:block;">Height Value:</label>
        <input id="ed-height-slider" type="range" min="0" max="255" step="1" value="${this.heightValue}"
          style="width: 100%; margin-top: 4px;">
        <span id="ed-height-val" style="color: #8bf;">${this.heightValue}</span>
      </div>

      <!-- Spawn panel -->
      <div id="ed-spawn-panel" style="margin-bottom: 8px; display: none;">
        <label style="color: #888; font-size: 11px;">Click map to place spawn (max 4 players).</label>
        <div id="ed-spawn-list" style="margin-top:4px;"></div>
      </div>

      <!-- Entrance panel -->
      <div id="ed-entrance-panel" style="margin-bottom: 8px; display: none;">
        <label style="color: #888; font-size: 11px;">Click map to place entrance points.</label>
        <div id="ed-entrance-list" style="margin-top:4px;"></div>
      </div>

      <!-- Script panel -->
      <div id="ed-script-panel" style="margin-bottom: 8px; display: none;">
        <label style="color: #888; font-size: 11px;">Script Point Index (1-24):</label>
        <input id="ed-script-index" type="number" min="1" max="24" value="${this.nextScriptIndex}"
          style="width:60px; background:#222; color:#ccc; border:1px solid #555; padding:3px; margin-top:4px;">
        <div id="ed-script-list" style="margin-top:4px;"></div>
      </div>

      <!-- Building panel -->
      <div id="ed-building-panel" style="margin-bottom: 8px; display: none;">
        <label style="color: #888; font-size: 11px;">Building:</label>
        <select id="ed-building-select" style="width:100%; background:#222; color:#ccc; border:1px solid #555; padding:3px; margin-top:4px;"></select>
        <label style="color: #888; font-size: 11px; margin-top:4px; display:block;">Owner Player:</label>
        <input id="ed-building-owner" type="number" min="0" max="7" value="0"
          style="width:60px; background:#222; color:#ccc; border:1px solid #555; padding:3px; margin-top:4px;">
      </div>

      <!-- Unit panel -->
      <div id="ed-unit-panel" style="margin-bottom: 8px; display: none;">
        <label style="color: #888; font-size: 11px;">Unit:</label>
        <select id="ed-unit-select" style="width:100%; background:#222; color:#ccc; border:1px solid #555; padding:3px; margin-top:4px;"></select>
        <label style="color: #888; font-size: 11px; margin-top:4px; display:block;">Owner Player:</label>
        <input id="ed-unit-owner" type="number" min="0" max="7" value="0"
          style="width:60px; background:#222; color:#ccc; border:1px solid #555; padding:3px; margin-top:4px;">
      </div>

      <!-- Brush size (shared by terrain/spice/height/eraser) -->
      <div id="ed-brush-row" style="margin-bottom: 8px;">
        <label style="color: #888; font-size: 11px;">Brush Size:</label>
        <input id="ed-brush-slider" type="range" min="1" max="10" step="1" value="${this.brushSize}"
          style="width: 100%; margin-top: 4px;">
        <span id="ed-brush-val" style="color: #aaa;">${this.brushSize}</span>
      </div>

      <!-- Grid toggle -->
      <div style="margin-bottom: 8px;">
        <label style="cursor:pointer; color:#aaa; font-size:12px;">
          <input id="ed-grid-toggle" type="checkbox" style="vertical-align:middle; margin-right:4px;">
          Show Grid Overlay
        </label>
      </div>

      <!-- Minimap preview -->
      <div style="margin-bottom: 8px;">
        <label style="color: #888; font-size: 11px;">Map Preview:</label>
        <div id="ed-minimap-holder" style="margin-top: 4px; text-align: center;"></div>
      </div>

      <!-- Map name / author -->
      <div style="margin-bottom: 4px;">
        <label style="color: #888; font-size: 11px;">Map Name:</label>
        <input id="ed-map-name" type="text" value="${this.mapName}"
          style="width:100%; background:#222; color:#ccc; border:1px solid #555; padding:4px; margin-top:2px; box-sizing:border-box;">
      </div>
      <div style="margin-bottom: 8px;">
        <label style="color: #888; font-size: 11px;">Author:</label>
        <input id="ed-map-author" type="text" value="${this.mapAuthor}"
          style="width:100%; background:#222; color:#ccc; border:1px solid #555; padding:4px; margin-top:2px; box-sizing:border-box;">
      </div>

      <!-- Action buttons -->
      <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px;">
        <button id="ed-save-bin" style="${ED_BTN_STYLE}">Save .bin</button>
        <button id="ed-load-bin" style="${ED_BTN_STYLE}">Load .bin</button>
        <button id="ed-save-json" style="${ED_BTN_STYLE}">Export JSON</button>
        <button id="ed-load-json" style="${ED_BTN_STYLE}">Import JSON</button>
      </div>
      <div style="display: flex; gap: 4px; flex-wrap: wrap;">
        <button id="ed-undo" style="${ED_BTN_STYLE}">Undo (Z)</button>
        <button id="ed-redo" style="${ED_BTN_STYLE}">Redo (Y)</button>
        <button id="ed-new" style="${ED_BTN_STYLE}">New Map</button>
        <button id="ed-save-local" style="${ED_BTN_STYLE}">Quick Save</button>
      </div>

      <input id="ed-file-json" type="file" accept=".json,.ebfd-map.json" style="display:none;">
      <input id="ed-file-bin" type="file" accept=".bin" style="display:none;">

      <!-- Keyboard shortcuts hint -->
      <div style="margin-top:8px; color:#555; font-size:10px; text-align:center;">
        T=Terrain H=Height S=Spice P=Spawn E=Entrance N=Script B=Building U=Unit X=Eraser G=Grid
      </div>
    `;

    // Append minimap canvas
    const holder = this.container.querySelector('#ed-minimap-holder');
    if (holder) {
      this.minimapCanvas.style.cssText = 'border:1px solid #444; max-width:100%;';
      holder.appendChild(this.minimapCanvas);
    }

    this.populateToolButtons();
    this.populateTerrainButtons();
    this.populateHeightModes();
    this.populateSelects();
    this.bindEvents();
  }

  // ---------------------------------------------------------------------------
  // Populate dynamic UI elements
  // ---------------------------------------------------------------------------

  private populateToolButtons(): void {
    const tools: { id: EditorTool; label: string; key: string }[] = [
      { id: 'terrain', label: 'Terrain', key: 'T' },
      { id: 'spice', label: 'Spice', key: 'S' },
      { id: 'height', label: 'Height', key: 'H' },
      { id: 'spawn', label: 'Spawn', key: 'P' },
      { id: 'entrance', label: 'Entrance', key: 'E' },
      { id: 'script', label: 'Script', key: 'N' },
      { id: 'building', label: 'Building', key: 'B' },
      { id: 'unit', label: 'Unit', key: 'U' },
      { id: 'eraser', label: 'Eraser', key: 'X' },
    ];

    const div = this.container.querySelector('#ed-tools')!;
    div.innerHTML = '';
    for (const t of tools) {
      const active = this.tool === t.id;
      const btn = document.createElement('button');
      btn.dataset.tool = t.id;
      btn.textContent = t.label;
      btn.title = `${t.label} (${t.key})`;
      btn.style.cssText = `
        flex: 0 0 auto; padding: 4px 6px;
        background: ${active ? '#446' : '#333'};
        color: ${active ? '#fff' : '#aaa'};
        border: 1px solid ${active ? '#88f' : '#555'};
        cursor: pointer; border-radius: 3px; font-size: 10px;
      `;
      btn.addEventListener('click', () => {
        this.tool = t.id;
        this.populateToolButtons();
        this.updateToolPanels();
      });
      div.appendChild(btn);
    }
  }

  private populateTerrainButtons(): void {
    const div = this.container.querySelector('#ed-terrain-types')!;
    div.innerHTML = '';
    for (const t of PAINTABLE_TERRAINS) {
      const btn = document.createElement('button');
      btn.dataset.terrain = String(t);
      btn.textContent = TERRAIN_NAMES[t] ?? String(t);
      btn.style.cssText = `
        width: 50px; height: 26px;
        border: 2px solid ${this.selectedTerrain === t ? '#ff0' : '#555'};
        background: ${TERRAIN_COLORS[t]};
        cursor: pointer; border-radius: 3px;
        font-size: 9px; color: #fff; text-shadow: 0 0 3px #000;
      `;
      btn.addEventListener('click', () => {
        this.selectedTerrain = t;
        this.populateTerrainButtons();
      });
      div.appendChild(btn);
    }
  }

  private populateHeightModes(): void {
    const modes: { id: 'set' | 'raise' | 'lower' | 'smooth'; label: string }[] = [
      { id: 'set', label: 'Set' },
      { id: 'raise', label: 'Raise' },
      { id: 'lower', label: 'Lower' },
      { id: 'smooth', label: 'Smooth' },
    ];
    const div = this.container.querySelector('#ed-height-modes')!;
    div.innerHTML = '';
    for (const m of modes) {
      const active = this.heightMode === m.id;
      const btn = document.createElement('button');
      btn.textContent = m.label;
      btn.style.cssText = `
        flex:1; padding:3px 4px;
        background: ${active ? '#446' : '#333'};
        color: ${active ? '#fff' : '#aaa'};
        border: 1px solid ${active ? '#88f' : '#555'};
        cursor: pointer; border-radius: 3px; font-size: 10px;
      `;
      btn.addEventListener('click', () => {
        this.heightMode = m.id;
        this.populateHeightModes();
      });
      div.appendChild(btn);
    }
  }

  private populateSelects(): void {
    const bSel = this.container.querySelector('#ed-building-select') as HTMLSelectElement;
    if (bSel) {
      bSel.innerHTML = BUILDING_NAMES.map(n => `<option value="${n}">${n}</option>`).join('');
      bSel.value = this.selectedBuilding;
    }
    const uSel = this.container.querySelector('#ed-unit-select') as HTMLSelectElement;
    if (uSel) {
      uSel.innerHTML = UNIT_NAMES.map(n => `<option value="${n}">${n}</option>`).join('');
      uSel.value = this.selectedUnit;
    }
  }

  // ---------------------------------------------------------------------------
  // Bind UI events
  // ---------------------------------------------------------------------------

  private bindEvents(): void {
    // Sliders
    const spiceSlider = this.container.querySelector('#ed-spice-slider') as HTMLInputElement;
    spiceSlider?.addEventListener('input', () => {
      this.spiceIntensity = parseFloat(spiceSlider.value);
      const val = this.container.querySelector('#ed-spice-val');
      if (val) val.textContent = `${(this.spiceIntensity * 100).toFixed(0)}%`;
    });

    // Spice low/high presets
    this.container.querySelector('#ed-spice-low')?.addEventListener('click', () => {
      this.spiceIntensity = 0.4;
      spiceSlider.value = '0.4';
      const val = this.container.querySelector('#ed-spice-val');
      if (val) val.textContent = '40%';
    });
    this.container.querySelector('#ed-spice-high')?.addEventListener('click', () => {
      this.spiceIntensity = 0.9;
      spiceSlider.value = '0.9';
      const val = this.container.querySelector('#ed-spice-val');
      if (val) val.textContent = '90%';
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
      this.updateBrushCursor();
    });

    // Map name / author
    const nameInput = this.container.querySelector('#ed-map-name') as HTMLInputElement;
    nameInput?.addEventListener('change', () => { this.mapName = nameInput.value; });
    const authorInput = this.container.querySelector('#ed-map-author') as HTMLInputElement;
    authorInput?.addEventListener('change', () => { this.mapAuthor = authorInput.value; });

    // Script index
    const scriptIdx = this.container.querySelector('#ed-script-index') as HTMLInputElement;
    scriptIdx?.addEventListener('change', () => {
      this.nextScriptIndex = Math.max(1, Math.min(24, parseInt(scriptIdx.value) || 1));
    });

    // Building / unit selects
    const bSel = this.container.querySelector('#ed-building-select') as HTMLSelectElement;
    bSel?.addEventListener('change', () => { this.selectedBuilding = bSel.value; });
    const uSel = this.container.querySelector('#ed-unit-select') as HTMLSelectElement;
    uSel?.addEventListener('change', () => { this.selectedUnit = uSel.value; });

    // Owner inputs
    const bOwner = this.container.querySelector('#ed-building-owner') as HTMLInputElement;
    bOwner?.addEventListener('change', () => { this.placementOwner = parseInt(bOwner.value) || 0; });
    const uOwner = this.container.querySelector('#ed-unit-owner') as HTMLInputElement;
    uOwner?.addEventListener('change', () => { this.placementOwner = parseInt(uOwner.value) || 0; });

    // Grid toggle
    const gridToggle = this.container.querySelector('#ed-grid-toggle') as HTMLInputElement;
    gridToggle?.addEventListener('change', () => {
      this.gridVisible = gridToggle.checked;
      if (this.gridVisible) this.showGrid(); else this.removeGrid();
    });

    // Action buttons
    this.container.querySelector('#ed-save-bin')?.addEventListener('click', () => this.saveBin());
    this.container.querySelector('#ed-load-bin')?.addEventListener('click', () => {
      (this.container.querySelector('#ed-file-bin') as HTMLInputElement)?.click();
    });
    this.container.querySelector('#ed-save-json')?.addEventListener('click', () => this.exportJSON());
    this.container.querySelector('#ed-load-json')?.addEventListener('click', () => {
      (this.container.querySelector('#ed-file-json') as HTMLInputElement)?.click();
    });
    this.container.querySelector('#ed-undo')?.addEventListener('click', () => this.undo());
    this.container.querySelector('#ed-redo')?.addEventListener('click', () => this.redo());
    this.container.querySelector('#ed-new')?.addEventListener('click', () => this.newMap());
    this.container.querySelector('#ed-save-local')?.addEventListener('click', () => this.saveLocal());

    // File inputs
    const fileJson = this.container.querySelector('#ed-file-json') as HTMLInputElement;
    fileJson?.addEventListener('change', () => {
      const file = fileJson.files?.[0];
      if (file) this.importJSON(file);
      fileJson.value = '';
    });
    const fileBin = this.container.querySelector('#ed-file-bin') as HTMLInputElement;
    fileBin?.addEventListener('change', () => {
      const file = fileBin.files?.[0];
      if (file) this.loadBin(file);
      fileBin.value = '';
    });
  }

  // ---------------------------------------------------------------------------
  // Tool panel visibility
  // ---------------------------------------------------------------------------

  private updateToolPanels(): void {
    const panels: Record<string, EditorTool[]> = {
      '#ed-terrain-panel': ['terrain'],
      '#ed-spice-panel': ['spice'],
      '#ed-height-panel': ['height'],
      '#ed-spawn-panel': ['spawn'],
      '#ed-entrance-panel': ['entrance'],
      '#ed-script-panel': ['script'],
      '#ed-building-panel': ['building'],
      '#ed-unit-panel': ['unit'],
    };
    for (const [sel, tools] of Object.entries(panels)) {
      const el = this.container.querySelector(sel) as HTMLElement;
      if (el) el.style.display = tools.includes(this.tool) ? 'block' : 'none';
    }

    // Brush size only relevant for painting tools
    const brushRow = this.container.querySelector('#ed-brush-row') as HTMLElement;
    if (brushRow) {
      const paintingTools: EditorTool[] = ['terrain', 'spice', 'height', 'eraser'];
      brushRow.style.display = paintingTools.includes(this.tool) ? 'block' : 'none';
    }

    // Update shortcut hint
    const hint = this.container.querySelector('#ed-shortcut-hint');
    if (hint) {
      const shortcuts: Record<EditorTool, string> = {
        terrain: 'T', spice: 'S', height: 'H', spawn: 'P',
        entrance: 'E', script: 'N', building: 'B', unit: 'U', eraser: 'X',
      };
      hint.textContent = `(${shortcuts[this.tool]})`;
    }

    // Refresh object lists
    this.updateSpawnList();
    this.updateEntranceList();
    this.updateScriptList();
  }

  // ---------------------------------------------------------------------------
  // Input handling
  // ---------------------------------------------------------------------------

  private setupInputHandlers(): void {
    window.addEventListener('mousedown', this.boundMouseDown);
    window.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('mouseup', this.boundMouseUp);
    window.addEventListener('keydown', this.boundKeyDown);
  }

  private teardownInputHandlers(): void {
    window.removeEventListener('mousedown', this.boundMouseDown);
    window.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('mouseup', this.boundMouseUp);
    window.removeEventListener('keydown', this.boundKeyDown);
  }

  private onMouseDown(e: MouseEvent): void {
    if (!this.container.parentElement) return;
    if (e.target && this.container.contains(e.target as Node)) return;
    if (e.button !== 0) return;

    this.painting = true;
    this.pushUndoState();
    this.paintAt(e);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.container.parentElement) return;

    // Update brush cursor position
    this.moveBrushCursor(e);

    if (this.painting) {
      this.paintAt(e);
    }
  }

  private onMouseUp(): void {
    if (this.painting) {
      this.painting = false;
      this.terrain.updateSpiceVisuals();
      this.updateMinimap();
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.container.parentElement) return;
    // Ignore when typing in input fields
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;

    const key = e.key.toUpperCase();
    const toolMap: Record<string, EditorTool> = {
      'T': 'terrain', 'S': 'spice', 'H': 'height', 'P': 'spawn',
      'E': 'entrance', 'N': 'script', 'B': 'building', 'U': 'unit', 'X': 'eraser',
    };

    if (toolMap[key]) {
      this.tool = toolMap[key];
      this.populateToolButtons();
      this.updateToolPanels();
      e.preventDefault();
      return;
    }

    // Grid toggle
    if (key === 'G' && !e.ctrlKey) {
      this.gridVisible = !this.gridVisible;
      const toggle = this.container.querySelector('#ed-grid-toggle') as HTMLInputElement;
      if (toggle) toggle.checked = this.gridVisible;
      if (this.gridVisible) this.showGrid(); else this.removeGrid();
      e.preventDefault();
      return;
    }

    // Undo (Ctrl+Z or just Z when not Ctrl)
    if (key === 'Z' && (e.ctrlKey || e.metaKey)) {
      this.undo();
      e.preventDefault();
      return;
    }
    if (key === 'Z' && !e.ctrlKey && !e.metaKey) {
      this.undo();
      e.preventDefault();
      return;
    }

    // Redo (Ctrl+Y or just Y)
    if (key === 'Y' && (e.ctrlKey || e.metaKey)) {
      this.redo();
      e.preventDefault();
      return;
    }
    if (key === 'Y' && !e.ctrlKey && !e.metaKey) {
      this.redo();
      e.preventDefault();
      return;
    }

    // Brush size with [ and ]
    if (e.key === '[' && this.brushSize > 1) {
      this.brushSize--;
      this.updateBrushSlider();
      e.preventDefault();
      return;
    }
    if (e.key === ']' && this.brushSize < 10) {
      this.brushSize++;
      this.updateBrushSlider();
      e.preventDefault();
      return;
    }
  }

  private updateBrushSlider(): void {
    const slider = this.container.querySelector('#ed-brush-slider') as HTMLInputElement;
    if (slider) slider.value = String(this.brushSize);
    const val = this.container.querySelector('#ed-brush-val');
    if (val) val.textContent = String(this.brushSize);
    this.updateBrushCursor();
  }

  // ---------------------------------------------------------------------------
  // Paint operations
  // ---------------------------------------------------------------------------

  private paintAt(e: MouseEvent): void {
    const hit = this.scene.screenToWorld(e.clientX, e.clientY);
    if (!hit) return;

    const cx = Math.floor(hit.x / TILE_SIZE);
    const cz = Math.floor(hit.z / TILE_SIZE);
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();

    // Single-click placement tools (no brush)
    if (this.tool === 'spawn') {
      if (cx >= 0 && cx < w && cz >= 0 && cz < h) {
        this.addSpawnPoint(cx * TILE_SIZE, cz * TILE_SIZE);
      }
      this.painting = false; // Only place one per click
      return;
    }
    if (this.tool === 'entrance') {
      if (cx >= 0 && cx < w && cz >= 0 && cz < h) {
        this.addEntrance(cx * TILE_SIZE, cz * TILE_SIZE);
      }
      this.painting = false;
      return;
    }
    if (this.tool === 'script') {
      if (cx >= 0 && cx < w && cz >= 0 && cz < h) {
        this.addScriptPoint(cx * TILE_SIZE, cz * TILE_SIZE);
      }
      this.painting = false;
      return;
    }
    if (this.tool === 'building') {
      if (cx >= 0 && cx < w && cz >= 0 && cz < h) {
        this.addEntity('building', this.selectedBuilding, this.placementOwner, cx * TILE_SIZE, cz * TILE_SIZE);
      }
      this.painting = false;
      return;
    }
    if (this.tool === 'unit') {
      if (cx >= 0 && cx < w && cz >= 0 && cz < h) {
        this.addEntity('unit', this.selectedUnit, this.placementOwner, cx * TILE_SIZE, cz * TILE_SIZE);
      }
      this.painting = false;
      return;
    }

    // Brush-based painting
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
          case 'height':
            this.applyHeightBrush(tx, tz, w, h);
            break;
          case 'eraser':
            this.terrain.setTerrainType(tx, tz, TerrainType.Sand);
            this.terrain.setSpice(tx, tz, 0);
            this.editorHeightmap[tz * w + tx] = 0;
            break;
        }
      }
    }
  }

  private applyHeightBrush(tx: number, tz: number, w: number, h: number): void {
    const idx = tz * w + tx;
    const current = this.editorHeightmap[idx];

    switch (this.heightMode) {
      case 'set':
        this.editorHeightmap[idx] = this.heightValue;
        break;
      case 'raise':
        this.editorHeightmap[idx] = Math.min(255, current + 5);
        break;
      case 'lower':
        this.editorHeightmap[idx] = Math.max(0, current - 5);
        break;
      case 'smooth': {
        // Average with neighbors
        let sum = 0;
        let count = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = tx + dx;
            const nz = tz + dz;
            if (nx >= 0 && nx < w && nz >= 0 && nz < h) {
              sum += this.editorHeightmap[nz * w + nx];
              count++;
            }
          }
        }
        this.editorHeightmap[idx] = Math.round(sum / count);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Spawn points
  // ---------------------------------------------------------------------------

  private addSpawnPoint(x: number, z: number): void {
    if (this.spawnPoints.length >= 4) {
      this.showToast('Maximum 4 spawn points');
      return;
    }
    this.spawnPoints.push({ x, z, playerId: this.nextSpawnId++ });
    this.updateSpawnMarkers();
    this.updateSpawnList();
    this.updateMinimap();
  }

  private removeSpawnPoint(index: number): void {
    this.spawnPoints.splice(index, 1);
    this.updateSpawnMarkers();
    this.updateSpawnList();
    this.updateMinimap();
  }

  private updateSpawnList(): void {
    const list = this.container.querySelector('#ed-spawn-list');
    if (!list) return;
    list.innerHTML = this.spawnPoints.map((sp, i) => `
      <div style="display:flex; align-items:center; gap:4px; margin-bottom:2px;">
        <span style="color:${PLAYER_COLORS[i % PLAYER_COLORS.length]}; font-size:11px; font-weight:bold;">
          P${i + 1}
        </span>
        <span style="font-size:10px; color:#888;">(${Math.round(sp.x / TILE_SIZE)}, ${Math.round(sp.z / TILE_SIZE)})</span>
        <button class="ed-spawn-del" data-idx="${i}" style="margin-left:auto; padding:1px 5px; background:#411; color:#f66; border:1px solid #633; cursor:pointer; font-size:9px;">X</button>
      </div>
    `).join('');
    list.querySelectorAll('.ed-spawn-del').forEach(btn => {
      btn.addEventListener('click', () => {
        this.removeSpawnPoint(parseInt((btn as HTMLElement).dataset.idx!));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Entrance points
  // ---------------------------------------------------------------------------

  private addEntrance(x: number, z: number): void {
    this.entrances.push({ marker: this.nextEntranceMarker++, x, z });
    this.updateEntranceMarkers();
    this.updateEntranceList();
    this.updateMinimap();
  }

  private removeEntrance(index: number): void {
    this.entrances.splice(index, 1);
    this.updateEntranceMarkers();
    this.updateEntranceList();
    this.updateMinimap();
  }

  private updateEntranceList(): void {
    const list = this.container.querySelector('#ed-entrance-list');
    if (!list) return;
    list.innerHTML = this.entrances.map((en, i) => `
      <div style="display:flex; align-items:center; gap:4px; margin-bottom:2px;">
        <span style="color:#ff8844; font-size:11px; font-weight:bold;">E${en.marker}</span>
        <span style="font-size:10px; color:#888;">(${Math.round(en.x / TILE_SIZE)}, ${Math.round(en.z / TILE_SIZE)})</span>
        <button class="ed-ent-del" data-idx="${i}" style="margin-left:auto; padding:1px 5px; background:#411; color:#f66; border:1px solid #633; cursor:pointer; font-size:9px;">X</button>
      </div>
    `).join('');
    list.querySelectorAll('.ed-ent-del').forEach(btn => {
      btn.addEventListener('click', () => {
        this.removeEntrance(parseInt((btn as HTMLElement).dataset.idx!));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Script points
  // ---------------------------------------------------------------------------

  private addScriptPoint(x: number, z: number): void {
    // Remove existing point with same index
    this.scriptPoints = this.scriptPoints.filter(sp => sp.index !== this.nextScriptIndex);
    this.scriptPoints.push({ index: this.nextScriptIndex, x, z });
    this.scriptPoints.sort((a, b) => a.index - b.index);
    this.nextScriptIndex = Math.min(24, this.nextScriptIndex + 1);
    const scriptIdx = this.container.querySelector('#ed-script-index') as HTMLInputElement;
    if (scriptIdx) scriptIdx.value = String(this.nextScriptIndex);
    this.updateScriptMarkers();
    this.updateScriptList();
    this.updateMinimap();
  }

  private removeScriptPoint(index: number): void {
    this.scriptPoints = this.scriptPoints.filter(sp => sp.index !== index);
    this.updateScriptMarkers();
    this.updateScriptList();
    this.updateMinimap();
  }

  private updateScriptList(): void {
    const list = this.container.querySelector('#ed-script-list');
    if (!list) return;
    list.innerHTML = this.scriptPoints.map(sp => `
      <div style="display:flex; align-items:center; gap:4px; margin-bottom:2px;">
        <span style="color:#88ff88; font-size:11px; font-weight:bold;">Script${sp.index}</span>
        <span style="font-size:10px; color:#888;">(${Math.round(sp.x / TILE_SIZE)}, ${Math.round(sp.z / TILE_SIZE)})</span>
        <button class="ed-scr-del" data-idx="${sp.index}" style="margin-left:auto; padding:1px 5px; background:#411; color:#f66; border:1px solid #633; cursor:pointer; font-size:9px;">X</button>
      </div>
    `).join('');
    list.querySelectorAll('.ed-scr-del').forEach(btn => {
      btn.addEventListener('click', () => {
        this.removeScriptPoint(parseInt((btn as HTMLElement).dataset.idx!));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Entity placement (buildings / units)
  // ---------------------------------------------------------------------------

  private addEntity(kind: 'building' | 'unit', name: string, owner: number, x: number, z: number): void {
    this.placedEntities.push({ kind, name, owner, x, z });
    this.updateEntityMarkers();
    this.updateMinimap();
  }

  // ---------------------------------------------------------------------------
  // 3D Markers
  // ---------------------------------------------------------------------------

  private updateSpawnMarkers(): void {
    this.clearMarkerGroup(this.spawnMarkers);
    if (!this.spawnGeo) this.spawnGeo = new THREE.CylinderGeometry(0.4, 0.4, 3, 8);

    for (let i = 0; i < this.spawnPoints.length; i++) {
      const sp = this.spawnPoints[i];
      const group = new THREE.Group();

      // Cylinder beacon
      const mat = new THREE.MeshBasicMaterial({ color: PLAYER_HEX[i % PLAYER_HEX.length] });
      const mesh = new THREE.Mesh(this.spawnGeo, mat);
      mesh.position.y = 1.5;
      group.add(mesh);

      // Number label sprite
      const label = this.makeTextSprite(`P${i + 1}`, PLAYER_COLORS[i % PLAYER_COLORS.length]);
      label.position.y = 3.5;
      group.add(label);

      group.position.set(sp.x, 0, sp.z);
      this.scene.scene.add(group);
      this.spawnMarkers.push(group);
    }
  }

  private updateEntranceMarkers(): void {
    this.clearMeshArray(this.entranceMarkers);
    if (!this.entranceGeo) this.entranceGeo = new THREE.BoxGeometry(0.8, 2, 0.8);

    for (const en of this.entrances) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xff8844, wireframe: true });
      const mesh = new THREE.Mesh(this.entranceGeo, mat);
      mesh.position.set(en.x, 1, en.z);
      this.scene.scene.add(mesh);
      this.entranceMarkers.push(mesh);
    }
  }

  private updateScriptMarkers(): void {
    this.clearMarkerGroup(this.scriptMarkers);
    if (!this.scriptGeo) this.scriptGeo = new THREE.OctahedronGeometry(0.4);

    for (const sp of this.scriptPoints) {
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0x88ff88 });
      const mesh = new THREE.Mesh(this.scriptGeo, mat);
      mesh.position.y = 1.5;
      group.add(mesh);

      const label = this.makeTextSprite(`S${sp.index}`, '#88ff88');
      label.position.y = 2.5;
      group.add(label);

      group.position.set(sp.x, 0, sp.z);
      this.scene.scene.add(group);
      this.scriptMarkers.push(group);
    }
  }

  private updateEntityMarkers(): void {
    this.clearMeshArray(this.entityMarkers);
    if (!this.entityGeo) this.entityGeo = new THREE.BoxGeometry(1, 1.5, 1);

    for (const ent of this.placedEntities) {
      const color = ent.kind === 'building' ? 0xcccc44 : 0x44cccc;
      const mat = new THREE.MeshBasicMaterial({ color, wireframe: true });
      const mesh = new THREE.Mesh(this.entityGeo, mat);
      mesh.position.set(ent.x, 0.75, ent.z);
      this.scene.scene.add(mesh);
      this.entityMarkers.push(mesh);
    }
  }

  private clearMarkerGroup(arr: THREE.Group[]): void {
    for (const g of arr) {
      g.traverse(child => {
        if ((child as THREE.Mesh).isMesh) {
          (child as THREE.Mesh).geometry?.dispose();
          const mats = Array.isArray((child as THREE.Mesh).material) ? (child as THREE.Mesh).material : [(child as THREE.Mesh).material];
          for (const m of mats as THREE.Material[]) m.dispose();
        }
        if ((child as THREE.Sprite).isSprite) {
          ((child as THREE.Sprite).material as THREE.SpriteMaterial).map?.dispose();
          ((child as THREE.Sprite).material as THREE.SpriteMaterial).dispose();
        }
      });
      this.scene.scene.remove(g);
    }
    arr.length = 0;
  }

  private clearMeshArray(arr: THREE.Mesh[]): void {
    for (const m of arr) {
      this.scene.scene.remove(m);
      (m.material as THREE.Material).dispose();
    }
    arr.length = 0;
  }

  private clearAllMarkers(): void {
    this.clearMarkerGroup(this.spawnMarkers);
    this.clearMeshArray(this.entranceMarkers);
    this.clearMarkerGroup(this.scriptMarkers);
    this.clearMeshArray(this.entityMarkers);
  }

  private makeTextSprite(text: string, color: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 32, 16);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2, 1, 1);
    return sprite;
  }

  // ---------------------------------------------------------------------------
  // Grid overlay
  // ---------------------------------------------------------------------------

  private showGrid(): void {
    this.removeGrid();
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();
    const worldW = w * TILE_SIZE;
    const worldH = h * TILE_SIZE;
    const maxDim = Math.max(worldW, worldH);
    const divisions = Math.max(w, h);

    this.gridHelper = new THREE.GridHelper(maxDim, divisions, 0x444444, 0x222222);
    this.gridHelper.position.set(worldW / 2 - TILE_SIZE / 2, 0.05, worldH / 2 - TILE_SIZE / 2);
    this.scene.scene.add(this.gridHelper);
  }

  private removeGrid(): void {
    if (this.gridHelper) {
      this.scene.scene.remove(this.gridHelper);
      this.gridHelper.geometry.dispose();
      (this.gridHelper.material as THREE.Material).dispose();
      this.gridHelper = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Brush cursor visualization
  // ---------------------------------------------------------------------------

  private createBrushCursor(): void {
    this.removeBrushCursor();
    const geo = new THREE.RingGeometry(0, this.brushSize * TILE_SIZE, 32);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.25,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.brushCursor = new THREE.Mesh(geo, mat);
    this.brushCursor.position.y = 0.1;
    this.brushCursor.visible = false;
    this.scene.scene.add(this.brushCursor);
  }

  private removeBrushCursor(): void {
    if (this.brushCursor) {
      this.scene.scene.remove(this.brushCursor);
      this.brushCursor.geometry.dispose();
      (this.brushCursor.material as THREE.Material).dispose();
      this.brushCursor = null;
    }
  }

  private updateBrushCursor(): void {
    if (!this.brushCursor) return;
    this.brushCursor.geometry.dispose();
    const geo = new THREE.RingGeometry(
      Math.max(0, (this.brushSize - 0.5) * TILE_SIZE),
      this.brushSize * TILE_SIZE,
      32
    );
    geo.rotateX(-Math.PI / 2);
    this.brushCursor.geometry = geo;
  }

  private moveBrushCursor(e: MouseEvent): void {
    if (!this.brushCursor) return;
    const hit = this.scene.screenToWorld(e.clientX, e.clientY);
    if (hit) {
      this.brushCursor.position.set(hit.x, 0.1, hit.z);
      this.brushCursor.visible = true;
    } else {
      this.brushCursor.visible = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Undo / Redo
  // ---------------------------------------------------------------------------

  private captureSnapshot(): EditorSnapshot {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();
    const tileCount = w * h;
    const terrainCopy = new Uint8Array(tileCount);
    const spiceCopy = new Float32Array(tileCount);
    const heightCopy = new Uint8Array(tileCount);

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const idx = z * w + x;
        terrainCopy[idx] = this.terrain.getTerrainType(x, z);
        spiceCopy[idx] = this.terrain.getSpice(x, z);
        heightCopy[idx] = this.editorHeightmap[idx];
      }
    }

    return {
      terrain: terrainCopy,
      spice: spiceCopy,
      heightmap: heightCopy,
      spawnPoints: this.spawnPoints.map(sp => ({ ...sp })),
      entrances: this.entrances.map(en => ({ ...en })),
      scriptPoints: this.scriptPoints.map(sp => ({ ...sp })),
      entities: this.placedEntities.map(ent => ({ ...ent })),
    };
  }

  private restoreSnapshot(snap: EditorSnapshot): void {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const idx = z * w + x;
        this.terrain.setTerrainType(x, z, snap.terrain[idx]);
        this.terrain.setSpice(x, z, snap.spice[idx]);
        this.editorHeightmap[idx] = snap.heightmap[idx];
      }
    }

    this.spawnPoints = snap.spawnPoints.map(sp => ({ ...sp }));
    this.nextSpawnId = this.spawnPoints.length;
    this.entrances = snap.entrances.map(en => ({ ...en }));
    this.nextEntranceMarker = this.entrances.length;
    this.scriptPoints = snap.scriptPoints.map(sp => ({ ...sp }));
    this.placedEntities = snap.entities.map(ent => ({ ...ent }));

    this.terrain.updateSpiceVisuals();
    this.updateSpawnMarkers();
    this.updateEntranceMarkers();
    this.updateScriptMarkers();
    this.updateEntityMarkers();
    this.updateSpawnList();
    this.updateEntranceList();
    this.updateScriptList();
    this.updateMinimap();
  }

  private pushUndoState(): void {
    this.undoStack.push(this.captureSnapshot());
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    // Clear redo on new action
    this.redoStack = [];
  }

  private undo(): void {
    if (this.undoStack.length <= 1) return;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    const prev = this.undoStack[this.undoStack.length - 1];
    this.restoreSnapshot(prev);
    this.showToast('Undo');
  }

  private redo(): void {
    if (this.redoStack.length === 0) return;
    const state = this.redoStack.pop()!;
    this.undoStack.push(state);
    this.restoreSnapshot(state);
    this.showToast('Redo');
  }

  // ---------------------------------------------------------------------------
  // Minimap
  // ---------------------------------------------------------------------------

  updateMinimap(): void {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();
    const cw = this.minimapCanvas.width;
    const ch = this.minimapCanvas.height;
    const sx = cw / w;
    const sz = ch / h;

    this.minimapCtx.fillStyle = '#000';
    this.minimapCtx.fillRect(0, 0, cw, ch);

    // Terrain
    for (let tz = 0; tz < h; tz++) {
      for (let tx = 0; tx < w; tx++) {
        const type = this.terrain.getTerrainType(tx, tz);
        this.minimapCtx.fillStyle = TERRAIN_COLORS[type] ?? '#000';
        this.minimapCtx.fillRect(tx * sx, tz * sz, Math.ceil(sx), Math.ceil(sz));
      }
    }

    // Spawn points
    for (let i = 0; i < this.spawnPoints.length; i++) {
      const sp = this.spawnPoints[i];
      const px = (sp.x / TILE_SIZE) * sx;
      const pz = (sp.z / TILE_SIZE) * sz;
      this.minimapCtx.fillStyle = PLAYER_COLORS[i % PLAYER_COLORS.length];
      this.minimapCtx.beginPath();
      this.minimapCtx.arc(px, pz, 5, 0, Math.PI * 2);
      this.minimapCtx.fill();
      this.minimapCtx.fillStyle = '#fff';
      this.minimapCtx.font = 'bold 8px sans-serif';
      this.minimapCtx.textAlign = 'center';
      this.minimapCtx.textBaseline = 'middle';
      this.minimapCtx.fillText(`${i + 1}`, px, pz);
    }

    // Entrances
    for (const en of this.entrances) {
      const px = (en.x / TILE_SIZE) * sx;
      const pz = (en.z / TILE_SIZE) * sz;
      this.minimapCtx.strokeStyle = '#ff8844';
      this.minimapCtx.lineWidth = 1.5;
      this.minimapCtx.strokeRect(px - 3, pz - 3, 6, 6);
    }

    // Script points
    for (const sp of this.scriptPoints) {
      const px = (sp.x / TILE_SIZE) * sx;
      const pz = (sp.z / TILE_SIZE) * sz;
      this.minimapCtx.fillStyle = '#88ff88';
      this.minimapCtx.beginPath();
      this.minimapCtx.arc(px, pz, 3, 0, Math.PI * 2);
      this.minimapCtx.fill();
    }

    // Entities
    for (const ent of this.placedEntities) {
      const px = (ent.x / TILE_SIZE) * sx;
      const pz = (ent.z / TILE_SIZE) * sz;
      this.minimapCtx.fillStyle = ent.kind === 'building' ? '#cccc44' : '#44cccc';
      this.minimapCtx.fillRect(px - 2, pz - 2, 4, 4);
    }
  }

  // =========================================================================
  // Save / Load — .bin format (matching MapLoader)
  // =========================================================================

  /**
   * Save current map as a .bin file.
   * Binary format:
   *   Header (12 bytes): uint16 width, uint16 height, float32 ambientR, float32 ambientG
   *   Body: [W*H] heightMap + [W*H] passability + [W*H] textureIdx
   */
  saveBin(): void {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();
    const tileCount = w * h;
    const bufSize = BIN_HEADER_SIZE + tileCount * 3;
    const buffer = new ArrayBuffer(bufSize);
    const view = new DataView(buffer);

    // Header
    view.setUint16(0, w, true);
    view.setUint16(2, h, true);
    view.setFloat32(4, 1.0, true); // ambientR
    view.setFloat32(8, 1.0, true); // ambientG

    // heightMap
    const heightArr = new Uint8Array(buffer, BIN_HEADER_SIZE, tileCount);
    heightArr.set(this.editorHeightmap);

    // passability (convert TerrainType back to CPF-like values)
    const passArr = new Uint8Array(buffer, BIN_HEADER_SIZE + tileCount, tileCount);
    for (let i = 0; i < tileCount; i++) {
      passArr[i] = this.terrainToCpf(this.terrain.getTerrainType(
        i % w, Math.floor(i / w)
      ));
    }

    // textureIdx (just fill with zeros — purely visual in original engine)
    // The third layer is textureIdx, which we leave as 0

    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.mapName.replace(/\s/g, '_')}.bin`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast(`Saved ${this.mapName}.bin`);
  }

  /**
   * Load a .bin map file (same format as the game uses).
   */
  async loadBin(file: File): Promise<void> {
    try {
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength < BIN_HEADER_SIZE) {
        this.showToast('Invalid .bin file (too small)');
        return;
      }

      const view = new DataView(buffer);
      const w = view.getUint16(0, true);
      const h = view.getUint16(2, true);
      const tileCount = w * h;
      const expectedSize = BIN_HEADER_SIZE + tileCount * 3;

      if (buffer.byteLength < expectedSize) {
        this.showToast(`File truncated: ${buffer.byteLength} < ${expectedSize}`);
        return;
      }

      // Verify map dimensions match
      const mapW = this.terrain.getMapWidth();
      const mapH = this.terrain.getMapHeight();
      if (w !== mapW || h !== mapH) {
        this.showToast(`Size mismatch: file=${w}x${h} map=${mapW}x${mapH}`);
        return;
      }

      this.pushUndoState();

      const heightMap = new Uint8Array(buffer, BIN_HEADER_SIZE, tileCount);
      const passability = new Uint8Array(buffer, BIN_HEADER_SIZE + tileCount, tileCount);

      // CPF → TerrainType conversion (same table as TerrainRenderer)
      const CPF_TO_TERRAIN: TerrainType[] = [
        TerrainType.Cliff, TerrainType.Cliff, TerrainType.Sand, TerrainType.Sand,
        TerrainType.Dunes, TerrainType.Rock, TerrainType.Sand, TerrainType.InfantryRock,
        TerrainType.Dunes, TerrainType.Dunes, TerrainType.Sand, TerrainType.Sand,
        TerrainType.SpiceLow, TerrainType.SpiceLow, TerrainType.SpiceHigh, TerrainType.SpiceHigh,
      ];

      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          const idx = z * w + x;
          const cpf = passability[idx];
          const terrainType = CPF_TO_TERRAIN[cpf] ?? TerrainType.Sand;
          this.terrain.setTerrainType(x, z, terrainType);

          if (terrainType === TerrainType.SpiceLow) {
            this.terrain.setSpice(x, z, 0.4);
          } else if (terrainType === TerrainType.SpiceHigh) {
            this.terrain.setSpice(x, z, 0.8);
          } else {
            this.terrain.setSpice(x, z, 0);
          }

          this.editorHeightmap[idx] = heightMap[idx];
        }
      }

      this.terrain.updateSpiceVisuals();
      this.updateMinimap();
      this.showToast(`Loaded ${file.name}`);
    } catch (err) {
      this.showToast('Failed to load .bin file');
      console.warn('loadBin error:', err);
    }
  }

  /**
   * Convert TerrainType back to a CPF-like passability nibble.
   * This is the inverse of CPF_TO_TERRAIN used during loading.
   */
  private terrainToCpf(type: TerrainType): number {
    switch (type) {
      case TerrainType.Cliff: return 0;
      case TerrainType.Sand: return 6;
      case TerrainType.Dunes: return 4;
      case TerrainType.Rock: return 5;
      case TerrainType.InfantryRock: return 7;
      case TerrainType.ConcreteSlab: return 6; // Treat as open
      case TerrainType.SpiceLow: return 12;
      case TerrainType.SpiceHigh: return 14;
      default: return 6;
    }
  }

  // =========================================================================
  // Save / Load — JSON format (editor-native, includes all metadata)
  // =========================================================================

  private buildEditorMapData(): EditorMapData {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();
    const terrainArr: number[] = [];
    const spiceArr: number[] = [];
    const heightArr: number[] = [];

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const idx = z * w + x;
        terrainArr.push(this.terrain.getTerrainType(x, z));
        spiceArr.push(Math.round(this.terrain.getSpice(x, z) * 100) / 100);
        heightArr.push(this.editorHeightmap[idx]);
      }
    }

    return {
      version: 2,
      width: w,
      height: h,
      terrain: terrainArr,
      spice: spiceArr,
      heightmap: heightArr,
      spawnPoints: this.spawnPoints.map(sp => ({ ...sp })),
      entrances: this.entrances.map(en => ({ ...en })),
      scriptPoints: this.scriptPoints.map(sp => ({ ...sp })),
      entities: this.placedEntities.map(ent => ({ ...ent })),
      name: this.mapName,
      author: this.mapAuthor,
      maxPlayers: Math.max(2, this.spawnPoints.length),
    };
  }

  exportJSON(): void {
    const data = this.buildEditorMapData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.name.replace(/\s/g, '_')}.ebfd-map.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.showToast(`Exported ${data.name}.json`);
  }

  async importJSON(file: File): Promise<void> {
    try {
      const text = await file.text();
      const data = JSON.parse(text) as EditorMapData;
      if (!data.version || !Array.isArray(data.terrain) || !data.width || !data.height) {
        this.showToast('Invalid JSON map format');
        return;
      }
      this.loadEditorMapData(data);
      this.showToast(`Loaded "${data.name}"`);
    } catch {
      this.showToast('Failed to load JSON file');
    }
  }

  private loadEditorMapData(data: EditorMapData): void {
    const mapW = this.terrain.getMapWidth();
    const mapH = this.terrain.getMapHeight();
    if (data.width !== mapW || data.height !== mapH) {
      this.showToast(`Size mismatch: ${data.width}x${data.height} vs ${mapW}x${mapH}`);
      return;
    }

    this.pushUndoState();

    const w = data.width;
    const h = data.height;

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        const idx = z * w + x;
        this.terrain.setTerrainType(x, z, data.terrain[idx]);
        this.terrain.setSpice(x, z, data.spice[idx] ?? 0);
        this.editorHeightmap[idx] = data.heightmap?.[idx] ?? 0;
      }
    }

    this.spawnPoints = data.spawnPoints ? data.spawnPoints.map(sp => ({ ...sp })) : [];
    this.nextSpawnId = this.spawnPoints.length;
    this.entrances = data.entrances ? data.entrances.map(en => ({ ...en })) : [];
    this.nextEntranceMarker = this.entrances.length;
    this.scriptPoints = data.scriptPoints ? data.scriptPoints.map(sp => ({ ...sp })) : [];
    this.placedEntities = data.entities ? data.entities.map(ent => ({ ...ent })) : [];

    this.mapName = data.name || 'Untitled';
    this.mapAuthor = data.author || 'Unknown';
    const nameInput = this.container.querySelector('#ed-map-name') as HTMLInputElement;
    if (nameInput) nameInput.value = this.mapName;
    const authorInput = this.container.querySelector('#ed-map-author') as HTMLInputElement;
    if (authorInput) authorInput.value = this.mapAuthor;

    this.terrain.updateSpiceVisuals();
    this.updateSpawnMarkers();
    this.updateEntranceMarkers();
    this.updateScriptMarkers();
    this.updateEntityMarkers();
    this.updateSpawnList();
    this.updateEntranceList();
    this.updateScriptList();
    this.updateMinimap();
  }

  // =========================================================================
  // Quick save/load (localStorage)
  // =========================================================================

  saveLocal(): void {
    const data = this.buildEditorMapData();
    const key = `ebfd_editor_${data.name.replace(/\s/g, '_').toLowerCase()}`;
    localStorage.setItem(key, JSON.stringify(data));

    const index: string[] = JSON.parse(localStorage.getItem('ebfd_editor_maps') || '[]');
    if (!index.includes(key)) {
      index.push(key);
      localStorage.setItem('ebfd_editor_maps', JSON.stringify(index));
    }

    this.showToast(`Quick-saved "${data.name}"`);
  }

  /** Load a saved map by localStorage key */
  loadSavedMap(key: string): void {
    const json = localStorage.getItem(key);
    if (!json) return;
    try {
      const data = JSON.parse(json) as EditorMapData;
      this.loadEditorMapData(data);
    } catch {
      this.showToast('Failed to load saved map');
    }
  }

  /** Get list of saved editor maps */
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

  // =========================================================================
  // New Map
  // =========================================================================

  private newMap(): void {
    const w = this.terrain.getMapWidth();
    const h = this.terrain.getMapHeight();

    this.pushUndoState();

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        if (x < 2 || x >= w - 2 || z < 2 || z >= h - 2) {
          this.terrain.setTerrainType(x, z, TerrainType.Cliff);
        } else {
          this.terrain.setTerrainType(x, z, TerrainType.Sand);
        }
        this.terrain.setSpice(x, z, 0);
        this.editorHeightmap[z * w + x] = 0;
      }
    }

    this.spawnPoints = [];
    this.nextSpawnId = 0;
    this.entrances = [];
    this.nextEntranceMarker = 0;
    this.scriptPoints = [];
    this.placedEntities = [];
    this.mapName = 'Untitled Map';
    this.mapAuthor = 'Unknown';

    const nameInput = this.container.querySelector('#ed-map-name') as HTMLInputElement;
    if (nameInput) nameInput.value = this.mapName;
    const authorInput = this.container.querySelector('#ed-map-author') as HTMLInputElement;
    if (authorInput) authorInput.value = this.mapAuthor;

    this.terrain.updateSpiceVisuals();
    this.clearAllMarkers();
    this.updateSpawnList();
    this.updateEntranceList();
    this.updateScriptList();
    this.updateMinimap();
    this.showToast('New map created');
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private showToast(message: string): void {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: #333; color: #ccc; padding: 8px 20px; border-radius: 4px;
      z-index: 9999; font-size: 13px; border: 1px solid #555;
      pointer-events: none;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }
}
