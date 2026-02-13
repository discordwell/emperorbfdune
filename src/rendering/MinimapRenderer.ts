import type { TerrainRenderer } from './TerrainRenderer';
import { TerrainType, MAP_SIZE } from './TerrainRenderer';
import type { SceneManager } from './SceneManager';
import { Position, Owner, unitQuery, buildingQuery, type World } from '../core/ECS';

const MINIMAP_COLORS: Record<TerrainType, string> = {
  [TerrainType.Sand]: '#C2A54F',
  [TerrainType.Rock]: '#6B5B45',
  [TerrainType.SpiceLow]: '#D4842A',
  [TerrainType.SpiceHigh]: '#B85C1E',
  [TerrainType.Dunes]: '#D4B86A',
  [TerrainType.Cliff]: '#3A3025',
  [TerrainType.ConcreteSlab]: '#808080',
  [TerrainType.InfantryRock]: '#7B6B55',
};

const PLAYER_COLORS = [
  '#0085E2', '#AF2416', '#92FDCA', '#FF7919',
  '#40FF00', '#7F48BD', '#FFF06A', '#FFA3E0',
];

export class MinimapRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private terrain: TerrainRenderer;
  private sceneManager: SceneManager;
  private terrainImageData: ImageData | null = null;

  constructor(terrain: TerrainRenderer, sceneManager: SceneManager) {
    this.canvas = document.getElementById('minimap-canvas') as HTMLCanvasElement;
    this.canvas.width = 200;
    this.canvas.height = 200;
    this.ctx = this.canvas.getContext('2d')!;
    this.terrain = terrain;
    this.sceneManager = sceneManager;

    // Click to navigate
    this.canvas.addEventListener('mousedown', this.onClick);
    this.canvas.addEventListener('mousemove', this.onDrag);

    this.renderTerrain();
  }

  private renderTerrain(): void {
    const scale = 200 / MAP_SIZE;
    this.ctx.clearRect(0, 0, 200, 200);

    for (let tz = 0; tz < MAP_SIZE; tz++) {
      for (let tx = 0; tx < MAP_SIZE; tx++) {
        const type = this.terrain.getTerrainType(tx, tz);
        this.ctx.fillStyle = MINIMAP_COLORS[type] ?? '#000';
        this.ctx.fillRect(tx * scale, tz * scale, Math.ceil(scale), Math.ceil(scale));
      }
    }

    this.terrainImageData = this.ctx.getImageData(0, 0, 200, 200);
  }

  update(world: World): void {
    // Restore terrain base
    if (this.terrainImageData) {
      this.ctx.putImageData(this.terrainImageData, 0, 0);
    }

    const scale = 200 / (MAP_SIZE * 2); // World units to minimap pixels

    // Draw units
    const units = unitQuery(world);
    for (const eid of units) {
      const px = Position.x[eid] * scale;
      const pz = Position.z[eid] * scale;
      const owner = Owner.playerId[eid];
      this.ctx.fillStyle = PLAYER_COLORS[owner] ?? '#fff';
      this.ctx.fillRect(px - 1, pz - 1, 2, 2);
    }

    // Draw buildings
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      const px = Position.x[eid] * scale;
      const pz = Position.z[eid] * scale;
      const owner = Owner.playerId[eid];
      this.ctx.fillStyle = PLAYER_COLORS[owner] ?? '#fff';
      this.ctx.fillRect(px - 2, pz - 2, 4, 4);
    }

    // Draw camera viewport
    const target = this.sceneManager.cameraTarget;
    const zoom = this.sceneManager.getZoom();
    const viewW = zoom * 1.5 * scale;
    const viewH = zoom * scale;
    const cx = target.x * scale;
    const cz = target.z * scale;

    this.ctx.strokeStyle = '#fff';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(cx - viewW / 2, cz - viewH / 2, viewW, viewH);
  }

  private isDragging = false;

  private onClick = (e: MouseEvent): void => {
    this.isDragging = true;
    this.navigateTo(e);
  };

  private onDrag = (e: MouseEvent): void => {
    if (!this.isDragging || !(e.buttons & 1)) {
      this.isDragging = false;
      return;
    }
    this.navigateTo(e);
  };

  private navigateTo(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const scale = (MAP_SIZE * 2) / 200;
    this.sceneManager.cameraTarget.x = mx * scale;
    this.sceneManager.cameraTarget.z = my * scale;
    this.sceneManager.updateCameraPosition();
  }
}
