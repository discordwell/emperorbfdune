/**
 * EditorEntry — Standalone map editor bootstrap.
 *
 * When the URL contains ?mode=editor, the main game index.ts will call
 * launchEditor() instead of the normal game flow. This sets up a minimal
 * SceneManager + TerrainRenderer with a blank map, then opens the MapEditor
 * UI. No game simulation, ECS, or AI is initialized.
 */

import * as THREE from 'three';
import { SceneManager } from '../rendering/SceneManager';
import { TerrainRenderer } from '../rendering/TerrainRenderer';
import { MapEditor } from './MapEditor';
import { TILE_SIZE } from '../utils/MathUtils';
import { loadMap } from '../config/MapLoader';

// Default blank map dimensions
const DEFAULT_MAP_W = 64;
const DEFAULT_MAP_H = 64;

/**
 * Detect whether we are in editor mode based on URL parameters.
 */
export function isEditorMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get('mode') === 'editor';
}

/**
 * Launch the map editor. Called from index.ts when ?mode=editor is detected.
 * Takes over the page — no game systems are started.
 */
export async function launchEditor(): Promise<void> {
  console.log('Map Editor: Initializing...');

  // Hide the loading screen, game UI overlay
  const loadScreen = document.getElementById('loading-screen');
  if (loadScreen) loadScreen.style.display = 'none';
  const uiOverlay = document.getElementById('ui-overlay');
  if (uiOverlay) uiOverlay.style.display = 'none';

  // Create the shared WebGL renderer
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Create scene manager (handles camera, lights, sky)
  const scene = new SceneManager(renderer);

  // Create terrain renderer
  const terrain = new TerrainRenderer(scene);

  // Check for ?map=ID parameter to load an existing map
  const params = new URLSearchParams(window.location.search);
  const mapId = params.get('map');

  let mapLoaded = false;
  if (mapId) {
    try {
      const mapData = await loadMap(mapId);
      if (mapData) {
        await terrain.loadFromMapData(mapData);
        // Try to load the XBF terrain mesh too
        try {
          await terrain.loadTerrainMesh(mapId);
        } catch {
          // XBF mesh not available — splatmap fallback is fine
        }
        mapLoaded = true;
        console.log(`Editor: Loaded map ${mapId} (${mapData.width}x${mapData.height})`);

        // Set camera bounds
        scene.setMapBounds(mapData.width * TILE_SIZE, mapData.height * TILE_SIZE);
        scene.snapTo(
          (mapData.width * TILE_SIZE) / 2,
          (mapData.height * TILE_SIZE) / 2
        );
      }
    } catch (err) {
      console.warn(`Editor: Failed to load map ${mapId}:`, err);
    }
  }

  if (!mapLoaded) {
    // Create a blank map with the splatmap-based terrain
    await initBlankMap(terrain, scene);
  }

  // Create and show the editor
  const editor = new MapEditor(terrain, scene);
  editor.show();

  // Setup camera controls (pan, zoom, rotate) without full InputManager
  setupEditorCameraControls(scene, terrain);

  // Start a minimal render loop
  startEditorRenderLoop(scene);

  // Show a title bar for the editor
  showEditorTitleBar(mapId);

  console.log('Map Editor: Ready. Use WASD to pan, scroll to zoom, [ ] to rotate.');
}

// ---------------------------------------------------------------------------
// Blank map initialization
// ---------------------------------------------------------------------------

async function initBlankMap(terrain: TerrainRenderer, scene: SceneManager): Promise<void> {
  // Build a minimal MapData to feed to the terrain renderer
  const w = DEFAULT_MAP_W;
  const h = DEFAULT_MAP_H;
  const tileCount = w * h;

  const heightMap = new Uint8Array(tileCount);
  const passability = new Uint8Array(tileCount);
  const textureIndices = new Uint8Array(tileCount);

  // Fill with open sand (CPF 6 = sand)
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const idx = z * w + x;
      if (x < 2 || x >= w - 2 || z < 2 || z >= h - 2) {
        passability[idx] = 0; // Cliff border
      } else {
        passability[idx] = 6; // Open sand
      }
    }
  }

  await terrain.loadFromMapData({
    width: w,
    height: h,
    ambientR: 1.0,
    ambientG: 1.0,
    heightMap,
    passability,
    textureIndices,
  });

  scene.setMapBounds(w * TILE_SIZE, h * TILE_SIZE);
  scene.snapTo((w * TILE_SIZE) / 2, (h * TILE_SIZE) / 2);
  scene.setZoom(60);

  console.log(`Editor: Blank ${w}x${h} map created`);
}

// ---------------------------------------------------------------------------
// Camera controls (stripped-down version without game input system)
// ---------------------------------------------------------------------------

function setupEditorCameraControls(scene: SceneManager, terrain: TerrainRenderer): void {
  const keys = new Set<string>();
  const PAN_SPEED = 0.8;
  const ROTATE_SPEED = 0.03;

  window.addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
  });

  window.addEventListener('keyup', (e) => {
    keys.delete(e.key.toLowerCase());
  });

  // Scroll to zoom
  window.addEventListener('wheel', (e) => {
    // Don't zoom if over the editor panel
    const editorPanel = document.getElementById('map-editor');
    if (editorPanel && editorPanel.contains(e.target as Node)) return;
    scene.zoom(e.deltaY * 0.05);
  }, { passive: true });

  // Middle-mouse drag to pan
  let middleDrag = false;
  let lastMX = 0;
  let lastMY = 0;

  window.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      middleDrag = true;
      lastMX = e.clientX;
      lastMY = e.clientY;
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (middleDrag) {
      const dx = (e.clientX - lastMX) * -0.3;
      const dz = (e.clientY - lastMY) * -0.3;
      scene.panCamera(dx, dz);
      lastMX = e.clientX;
      lastMY = e.clientY;
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (e.button === 1) middleDrag = false;
  });

  // Update loop for keyboard-based panning
  const updateCamera = () => {
    let dx = 0;
    let dz = 0;

    if (keys.has('w') || keys.has('arrowup')) dz -= PAN_SPEED;
    if (keys.has('s') || keys.has('arrowdown')) dz += PAN_SPEED;
    if (keys.has('a') || keys.has('arrowleft')) dx -= PAN_SPEED;
    if (keys.has('d') || keys.has('arrowright')) dx += PAN_SPEED;

    if (dx !== 0 || dz !== 0) {
      scene.panCamera(dx, dz);
    }

    if (keys.has('[')) scene.rotateCamera(-ROTATE_SPEED);
    if (keys.has(']')) scene.rotateCamera(ROTATE_SPEED);

    requestAnimationFrame(updateCamera);
  };
  requestAnimationFrame(updateCamera);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function startEditorRenderLoop(scene: SceneManager): void {
  const loop = () => {
    requestAnimationFrame(loop);
    scene.render(0);
  };
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Editor title bar
// ---------------------------------------------------------------------------

function showEditorTitleBar(mapId: string | null): void {
  const bar = document.createElement('div');
  bar.style.cssText = `
    position: fixed; top: 0; left: 0; right: 280px; height: 32px;
    background: linear-gradient(180deg, #1a1a2e 0%, #0d0d1a 100%);
    border-bottom: 1px solid #333;
    display: flex; align-items: center; padding: 0 16px;
    font-family: 'Segoe UI', Tahoma, sans-serif;
    font-size: 13px; color: #ccc; z-index: 7000;
  `;

  const title = document.createElement('span');
  title.style.cssText = 'color: #d4a843; font-weight: bold; letter-spacing: 2px; margin-right: 16px;';
  title.textContent = 'EMPEROR MAP EDITOR';
  bar.appendChild(title);

  if (mapId) {
    const mapLabel = document.createElement('span');
    mapLabel.style.cssText = 'color: #888; font-size: 12px;';
    mapLabel.textContent = `Editing: ${mapId}`;
    bar.appendChild(mapLabel);
  }

  const controls = document.createElement('span');
  controls.style.cssText = 'margin-left: auto; color: #666; font-size: 11px;';
  controls.textContent = 'WASD: Pan | Scroll: Zoom | [ ]: Rotate | Middle-drag: Pan';
  bar.appendChild(controls);

  // Back to game link
  const backLink = document.createElement('a');
  backLink.href = '/';
  backLink.textContent = 'Back to Game';
  backLink.style.cssText = 'margin-left: 16px; color: #8cf; font-size: 12px; text-decoration: none;';
  backLink.addEventListener('mouseenter', () => { backLink.style.color = '#bdf'; });
  backLink.addEventListener('mouseleave', () => { backLink.style.color = '#8cf'; });
  bar.appendChild(backLink);

  document.body.appendChild(bar);
}
