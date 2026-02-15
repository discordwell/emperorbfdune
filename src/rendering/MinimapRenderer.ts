import type { TerrainRenderer } from './TerrainRenderer';
import { TerrainType } from './TerrainRenderer';
import type { SceneManager } from './SceneManager';
import type { FogOfWar } from './FogOfWar';
import { FOG_VISIBLE, FOG_EXPLORED } from './FogOfWar';
import { Position, Owner, Health, unitQuery, buildingQuery, type World } from '../core/ECS';
import { worldToTile, TILE_SIZE } from '../utils/MathUtils';

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
  private fogOfWar: FogOfWar | null = null;
  private terrainImageData: ImageData | null = null;
  private onRightClick: ((worldX: number, worldZ: number) => void) | null = null;
  // Click ping animation
  private clickPing: { x: number; y: number; age: number } | null = null;
  // Rally point for player 0
  private rallyPoint: { x: number; z: number } | null = null;
  // Attack flash pings
  private attackPings: { x: number; z: number; color: string; age: number }[] = [];

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
    this.canvas.addEventListener('contextmenu', this.onContextMenu);

    this.renderTerrain();
  }

  setRightClickCallback(cb: (worldX: number, worldZ: number) => void): void {
    this.onRightClick = cb;
  }

  setFogOfWar(fog: FogOfWar): void {
    this.fogOfWar = fog;
  }

  setRallyPoint(x: number, z: number): void {
    this.rallyPoint = { x, z };
  }

  /** Flash a colored ping on the minimap at a world position */
  flashPing(worldX: number, worldZ: number, color: string): void {
    this.attackPings.push({ x: worldX / TILE_SIZE, z: worldZ / TILE_SIZE, color, age: 0 });
  }

  renderTerrain(): void {
    const mapW = this.terrain.getMapWidth();
    const mapH = this.terrain.getMapHeight();
    const scaleX = 200 / mapW;
    const scaleZ = 200 / mapH;
    this.ctx.clearRect(0, 0, 200, 200);

    for (let tz = 0; tz < mapH; tz++) {
      for (let tx = 0; tx < mapW; tx++) {
        const type = this.terrain.getTerrainType(tx, tz);
        this.ctx.fillStyle = MINIMAP_COLORS[type] ?? '#000';
        this.ctx.fillRect(tx * scaleX, tz * scaleZ, Math.ceil(scaleX), Math.ceil(scaleZ));
      }
    }

    this.terrainImageData = this.ctx.getImageData(0, 0, 200, 200);
  }

  update(world: World): void {
    // Restore terrain base
    if (this.terrainImageData) {
      this.ctx.putImageData(this.terrainImageData, 0, 0);
    }

    const mapW = this.terrain.getMapWidth();
    const mapH = this.terrain.getMapHeight();

    // Apply fog of war overlay
    if (this.fogOfWar && this.fogOfWar.isEnabled()) {
      const vis = this.fogOfWar.getVisibility();
      const fogW = this.fogOfWar.getMapWidth();
      const tileScaleX = 200 / mapW;
      const tileScaleZ = 200 / mapH;
      this.ctx.fillStyle = 'rgba(0,0,0,0.7)';
      for (let tz = 0; tz < mapH; tz++) {
        for (let tx = 0; tx < mapW; tx++) {
          const v = vis[tz * fogW + tx];
          if (v === FOG_VISIBLE) continue; // Fully visible
          if (v === FOG_EXPLORED) {
            this.ctx.globalAlpha = 0.4;
          } else {
            this.ctx.globalAlpha = 0.85;
          }
          this.ctx.fillRect(tx * tileScaleX, tz * tileScaleZ, Math.ceil(tileScaleX), Math.ceil(tileScaleZ));
        }
      }
      this.ctx.globalAlpha = 1.0;
    }

    // World units to minimap pixels
    const worldW = mapW * TILE_SIZE;
    const worldH = mapH * TILE_SIZE;
    const scaleWx = 200 / worldW;
    const scaleWz = 200 / worldH;

    // Draw units
    const units = unitQuery(world);
    for (const eid of units) {
      if (Health.current[eid] <= 0) continue;
      const owner = Owner.playerId[eid];
      // Only show enemy units if visible through fog
      if (owner !== 0 && this.fogOfWar && this.fogOfWar.isEnabled()) {
        const tile = worldToTile(Position.x[eid], Position.z[eid]);
        if (!this.fogOfWar.isTileVisible(tile.tx, tile.tz)) continue;
      }
      const px = Position.x[eid] * scaleWx;
      const pz = Position.z[eid] * scaleWz;
      this.ctx.fillStyle = PLAYER_COLORS[owner] ?? '#fff';
      this.ctx.fillRect(px - 1, pz - 1, 3, 3);
    }

    // Draw buildings
    const buildings = buildingQuery(world);
    for (const eid of buildings) {
      if (Health.current[eid] <= 0) continue;
      const owner = Owner.playerId[eid];
      if (owner !== 0 && this.fogOfWar && this.fogOfWar.isEnabled()) {
        const tile = worldToTile(Position.x[eid], Position.z[eid]);
        if (!this.fogOfWar.isTileVisible(tile.tx, tile.tz)) continue;
      }
      const px = Position.x[eid] * scaleWx;
      const pz = Position.z[eid] * scaleWz;
      this.ctx.fillStyle = PLAYER_COLORS[owner] ?? '#fff';
      this.ctx.fillRect(px - 2, pz - 2, 5, 5);
    }

    // Draw camera viewport
    const target = this.sceneManager.cameraTarget;
    const zoom = this.sceneManager.getZoom();
    const viewW = zoom * 1.5 * scaleWx;
    const viewH = zoom * scaleWz;
    const cx = target.x * scaleWx;
    const cz = target.z * scaleWz;

    this.ctx.strokeStyle = '#fff';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(cx - viewW / 2, cz - viewH / 2, viewW, viewH);

    // Draw rally point flag
    if (this.rallyPoint) {
      const rx = this.rallyPoint.x * scaleWx;
      const rz = this.rallyPoint.z * scaleWz;
      // Pulsing yellow circle
      const pulse = 0.5 + Math.sin(Date.now() * 0.005) * 0.3;
      this.ctx.fillStyle = `rgba(255, 200, 0, ${pulse})`;
      this.ctx.beginPath();
      this.ctx.arc(rx, rz, 3, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.strokeStyle = '#ff8800';
      this.ctx.lineWidth = 1;
      this.ctx.stroke();
    }

    // Draw click ping animation
    if (this.clickPing) {
      this.clickPing.age++;
      const t = this.clickPing.age / 20; // 20 frames of animation
      if (t >= 1) {
        this.clickPing = null;
      } else {
        const radius = 3 + t * 8;
        const alpha = 1 - t;
        this.ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        this.ctx.lineWidth = 2 * (1 - t);
        this.ctx.beginPath();
        this.ctx.arc(this.clickPing.x, this.clickPing.y, radius, 0, Math.PI * 2);
        this.ctx.stroke();
      }
    }

    // Draw attack pings (expanding colored rings)
    const tileScaleXPings = 200 / mapW;
    const tileScaleZPings = 200 / mapH;
    for (let i = this.attackPings.length - 1; i >= 0; i--) {
      const ping = this.attackPings[i];
      ping.age++;
      const t = ping.age / 40; // 40 frames ~1.5s
      if (t >= 1) {
        this.attackPings.splice(i, 1);
      } else {
        const px = ping.x * tileScaleXPings;
        const pz = ping.z * tileScaleZPings;
        const radius = 2 + t * 12;
        const alpha = (1 - t) * 0.8;
        const hex = ping.color;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        this.ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.arc(px, pz, radius, 0, Math.PI * 2);
        this.ctx.stroke();
      }
    }
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
    const mapW = this.terrain.getMapWidth();
    const mapH = this.terrain.getMapHeight();
    const worldW = mapW * TILE_SIZE;
    const worldH = mapH * TILE_SIZE;
    const worldX = (mx / 200) * worldW;
    const worldZ = (my / 200) * worldH;

    // Use smooth pan for single clicks, instant for drag
    if (this.isDragging && e.type === 'mousemove') {
      this.sceneManager.cameraTarget.x = worldX;
      this.sceneManager.cameraTarget.z = worldZ;
      this.sceneManager.updateCameraPosition();
    } else {
      this.sceneManager.panTo(worldX, worldZ);
    }

    // Show click ping
    this.clickPing = { x: mx, y: my, age: 0 };
  }

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (!this.onRightClick) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const mapW = this.terrain.getMapWidth();
    const mapH = this.terrain.getMapHeight();
    const worldW = mapW * TILE_SIZE;
    const worldH = mapH * TILE_SIZE;
    this.onRightClick((mx / 200) * worldW, (my / 200) * worldH);
  };
}
