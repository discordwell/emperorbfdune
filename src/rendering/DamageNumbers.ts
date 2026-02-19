import * as THREE from 'three';
import type { SceneManager } from './SceneManager';
import type { FogOfWar } from './FogOfWar';
import { EventBus } from '../core/EventBus';
import { worldToTile } from '../utils/MathUtils';

interface FloatingNumber {
  el: HTMLDivElement;
  worldX: number;
  worldZ: number;
  age: number;
}

const MAX_NUMBERS = 30;
const LIFETIME = 40; // frames (~1.6s at 25fps)

export class DamageNumbers {
  private sceneManager: SceneManager;
  private fogOfWar: FogOfWar | null = null;
  private container: HTMLDivElement;
  private numbers: FloatingNumber[] = [];
  private tempVec = new THREE.Vector3();
  private enabled = true;
  // Throttle: aggregate damage per tile per frame
  private pendingDamage = new Map<string, { x: number; z: number; damage: number; owner: number }>();

  constructor(sceneManager: SceneManager) {
    this.sceneManager = sceneManager;

    this.container = document.createElement('div');
    this.container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:12;overflow:hidden;';
    document.body.appendChild(this.container);

    EventBus.on('combat:hit', ({ x, z, damage, targetOwner }) => {
      if (!this.enabled) return;
      // Aggregate by approximate tile to avoid spam
      const key = `${Math.round(x / 3)},${Math.round(z / 3)}`;
      const existing = this.pendingDamage.get(key);
      if (existing) {
        existing.damage += damage;
      } else {
        this.pendingDamage.set(key, { x, z, damage, owner: targetOwner });
      }
    });
  }

  setFogOfWar(fog: FogOfWar): void {
    this.fogOfWar = fog;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.container.style.display = enabled ? '' : 'none';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  update(): void {
    if (!this.enabled) return;

    // Flush pending damage into floating numbers
    for (const [, entry] of this.pendingDamage) {
      // Don't show damage in fog
      if (this.fogOfWar && this.fogOfWar.isEnabled()) {
        const tile = worldToTile(entry.x, entry.z);
        if (!this.fogOfWar.isTileVisible(tile.tx, tile.tz)) continue;
      }
      this.spawn(entry.x, entry.z, entry.damage, entry.owner);
    }
    this.pendingDamage.clear();

    // Update existing numbers
    const camera = this.sceneManager.camera;
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const num = this.numbers[i];
      num.age++;

      if (num.age >= LIFETIME) {
        num.el.remove();
        this.numbers.splice(i, 1);
        continue;
      }

      // Project world position to screen
      const t = num.age / LIFETIME;
      this.tempVec.set(num.worldX, 2 + t * 4, num.worldZ);
      this.tempVec.project(camera);

      // Behind camera check
      if (this.tempVec.z <= 0 || this.tempVec.z > 1) {
        num.el.style.display = 'none';
        continue;
      }

      const screenX = (this.tempVec.x * 0.5 + 0.5) * window.innerWidth;
      const screenY = (-this.tempVec.y * 0.5 + 0.5) * window.innerHeight;

      num.el.style.display = '';
      num.el.style.left = screenX + 'px';
      num.el.style.top = screenY + 'px';
      num.el.style.opacity = String(1 - t * t);
    }
  }

  private spawn(x: number, z: number, damage: number, targetOwner: number): void {
    // Evict oldest if at capacity
    if (this.numbers.length >= MAX_NUMBERS) {
      const oldest = this.numbers.shift()!;
      oldest.el.remove();
    }

    const el = document.createElement('div');
    const dmgText = Math.round(damage);
    const color = targetOwner === 0 ? '#ff4444' : '#ffcc44';
    const size = damage > 50 ? 16 : damage > 20 ? 14 : 12;
    el.textContent = `-${dmgText}`;
    el.style.cssText = `
      position:absolute;transform:translate(-50%,-50%);
      font-family:'Segoe UI',Tahoma,sans-serif;font-size:${size}px;font-weight:bold;
      color:${color};text-shadow:0 0 3px #000,0 0 6px #000;
      pointer-events:none;white-space:nowrap;
    `;
    this.container.appendChild(el);

    // Add small random offset to prevent exact overlap
    this.numbers.push({
      el,
      worldX: x + (Math.random() - 0.5) * 1.5,
      worldZ: z + (Math.random() - 0.5) * 1.5,
      age: 0,
    });
  }

  dispose(): void {
    this.container.remove();
  }
}
