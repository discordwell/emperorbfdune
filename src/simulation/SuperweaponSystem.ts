/**
 * SuperweaponSystem - Manages palace superweapon charging, targeting, firing, and AI usage.
 * Extracted from index.ts to reduce main file complexity.
 */

import { EventBus } from '../core/EventBus';
import {
  Position, Health, Owner, BuildingType,
  unitQuery, buildingQuery, hasComponent,
  type World,
} from '../core/ECS';
import type { SceneManager } from '../rendering/SceneManager';
import type { EffectsManager } from '../rendering/EffectsManager';
import type { AudioManager } from '../audio/AudioManager';
import type { SelectionPanel } from '../ui/SelectionPanel';
import type { MinimapRenderer } from '../rendering/MinimapRenderer';

const SUPERWEAPON_CONFIG: Record<string, { name: string; chargeTime: number; radius: number; damage: number; style: 'missile' | 'airstrike' | 'lightning' }> = {
  'HKPalace': { name: 'Death Hand Missile', chargeTime: 5184, radius: 15, damage: 800, style: 'missile' },
  'ATPalace': { name: 'Hawk Strike', chargeTime: 4536, radius: 10, damage: 500, style: 'airstrike' },
  'ORPalace': { name: 'Chaos Lightning', chargeTime: 6220, radius: 12, damage: 600, style: 'lightning' },
  'GUPalace': { name: 'Guild NIAB Strike', chargeTime: 5500, radius: 10, damage: 700, style: 'lightning' },
};

export interface SuperweaponDeps {
  scene: SceneManager;
  effectsManager: EffectsManager;
  audioManager: AudioManager;
  selectionPanel: SelectionPanel;
  minimapRenderer: MinimapRenderer;
  totalPlayers: number;
  buildingTypeNames: string[];
  getWorld: () => World;
  getTickCount: () => number;
  getPowerMultiplier: (playerId: number) => number;
}

export class SuperweaponSystem {
  private deps: SuperweaponDeps;
  private state = new Map<number, { palaceType: string; charge: number; ready: boolean }>();
  private targetMode = false;
  private swButton: HTMLDivElement;
  private swChargeBar: HTMLDivElement;
  private swLabel: HTMLSpanElement;

  constructor(deps: SuperweaponDeps) {
    this.deps = deps;

    // Create UI button
    this.swButton = document.createElement('div');
    this.swButton.id = 'superweapon-btn';
    this.swButton.style.cssText = `
      position:absolute;bottom:8px;right:8px;width:184px;height:36px;
      background:linear-gradient(180deg,#2a1a1a,#1a0a0a);border:1px solid #555;
      border-radius:4px;display:none;align-items:center;justify-content:center;
      font-family:'Segoe UI',Tahoma,sans-serif;font-size:12px;color:#f88;
      cursor:pointer;pointer-events:auto;z-index:15;text-align:center;
      user-select:none;transition:background 0.3s,border-color 0.3s;
    `;
    document.getElementById('sidebar')?.appendChild(this.swButton);

    // Charge bar
    this.swChargeBar = document.createElement('div');
    this.swChargeBar.style.cssText = `
      position:absolute;bottom:0;left:0;height:3px;width:0%;
      background:linear-gradient(90deg,#f44,#ff8800);border-radius:0 0 3px 3px;
      transition:width 0.5s;
    `;
    this.swButton.appendChild(this.swChargeBar);

    // Label
    this.swLabel = document.createElement('span');
    this.swLabel.style.cssText = 'position:relative;z-index:1;';
    this.swButton.appendChild(this.swLabel);

    // Click to activate targeting
    this.swButton.addEventListener('click', () => {
      const sw = this.state.get(0);
      if (!sw || !sw.ready) return;
      this.targetMode = true;
      const cmdMode = document.getElementById('command-mode');
      if (cmdMode) {
        cmdMode.style.display = 'block';
        cmdMode.textContent = `${SUPERWEAPON_CONFIG[sw.palaceType]?.name ?? 'Superweapon'} - Click to target`;
        cmdMode.style.background = 'rgba(200,0,0,0.85)';
      }
    });

    // Targeting click (capture phase to consume before selection/command handlers)
    window.addEventListener('mousedown', (e) => {
      if (!this.targetMode || e.button !== 0) return;
      if (e.clientY < 32 || e.clientX > window.innerWidth - 200) return;
      if (e.clientX < 200 && e.clientY > window.innerHeight - 200) return;

      e.stopPropagation();
      e.preventDefault();

      this.targetMode = false;
      const cmdMode = document.getElementById('command-mode');
      if (cmdMode) cmdMode.style.display = 'none';

      const worldPos = deps.scene.screenToWorld(e.clientX, e.clientY);
      if (worldPos) {
        this.fire(0, worldPos.x, worldPos.z);
      }
    }, true);

    // Cancel on Escape
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.targetMode) {
        this.targetMode = false;
        const cmdMode = document.getElementById('command-mode');
        if (cmdMode) cmdMode.style.display = 'none';
        e.stopPropagation();
      }
    }, true);
  }

  get isTargeting(): boolean {
    return this.targetMode;
  }

  fire(playerId: number, targetX: number, targetZ: number): void {
    const sw = this.state.get(playerId);
    if (!sw || !sw.ready) return;

    const config = SUPERWEAPON_CONFIG[sw.palaceType];
    if (!config) return;

    sw.charge = 0;
    sw.ready = false;

    EventBus.emit('superweapon:fired', { owner: playerId, type: sw.palaceType, x: targetX, z: targetZ });

    const { effectsManager, audioManager, scene, selectionPanel, minimapRenderer } = this.deps;

    // Visual effects based on style
    if (config.style === 'missile') {
      effectsManager.spawnExplosion(targetX, 0, targetZ, 'large');
      setTimeout(() => effectsManager.spawnExplosion(targetX + 3, 0, targetZ + 2, 'large'), 100);
      setTimeout(() => effectsManager.spawnExplosion(targetX - 2, 0, targetZ - 3, 'large'), 200);
      setTimeout(() => effectsManager.spawnExplosion(targetX + 1, 0, targetZ + 4, 'large'), 300);
      setTimeout(() => effectsManager.spawnExplosion(targetX - 3, 0, targetZ + 1, 'large'), 400);
    } else if (config.style === 'airstrike') {
      for (let i = -3; i <= 3; i++) {
        const delay = (i + 3) * 120;
        const ox = targetX + i * 2 + (Math.random() - 0.5) * 2;
        const oz = targetZ + (Math.random() - 0.5) * 3;
        setTimeout(() => effectsManager.spawnExplosion(ox, 0, oz, 'medium'), delay);
      }
    } else if (config.style === 'lightning') {
      for (let i = 0; i < 8; i++) {
        const delay = i * 80;
        const angle = (i / 8) * Math.PI * 2;
        const dist = 2 + Math.random() * (config.radius * 0.5);
        const ox = targetX + Math.cos(angle) * dist;
        const oz = targetZ + Math.sin(angle) * dist;
        setTimeout(() => effectsManager.spawnExplosion(ox, 0, oz, 'small'), delay);
      }
      setTimeout(() => effectsManager.spawnExplosion(targetX, 0, targetZ, 'large'), 200);
    }

    audioManager.playSfx('superweaponLaunch');
    scene.shake(config.style === 'missile' ? 1.0 : 0.6);

    // Apply damage to all entities in radius
    const w = this.deps.getWorld();
    const allUnits = unitQuery(w);
    const allBuildings = buildingQuery(w);
    const targets = [...allUnits, ...allBuildings];
    for (const eid of targets) {
      if (Health.current[eid] <= 0) continue;
      const dx = Position.x[eid] - targetX;
      const dz = Position.z[eid] - targetZ;
      const dist2 = dx * dx + dz * dz;
      const r2 = config.radius * config.radius;
      if (dist2 < r2) {
        const dist = Math.sqrt(dist2);
        const dmg = Math.floor(config.damage * (1 - dist / config.radius));
        Health.current[eid] = Math.max(0, Health.current[eid] - dmg);
        if (Health.current[eid] <= 0) {
          if (hasComponent(w, BuildingType, eid)) {
            EventBus.emit('building:destroyed', { entityId: eid, owner: Owner.playerId[eid], x: Position.x[eid], z: Position.z[eid] });
          }
          EventBus.emit('unit:died', { entityId: eid, killerEntity: -1 });
        }
      }
    }

    // Messages
    if (playerId === 0) {
      selectionPanel.addMessage(`${config.name} launched!`, '#ff4444');
    } else {
      selectionPanel.addMessage(`Enemy ${config.name} incoming!`, '#ff4444');
      minimapRenderer.flashPing(targetX, targetZ, '#ff0000');
    }
  }

  /** Called from game:tick handler. Handles charging, AI firing, and UI updates. */
  update(world: World, tickCount: number): void {
    if (tickCount % 25 !== 0) return; // Check every second

    const { totalPlayers, buildingTypeNames, audioManager, selectionPanel, getPowerMultiplier } = this.deps;

    for (let pid = 0; pid < totalPlayers; pid++) {
      const blds = buildingQuery(world);
      let palaceType: string | null = null;
      for (const bid of blds) {
        if (Owner.playerId[bid] !== pid || Health.current[bid] <= 0) continue;
        const bTypeId = BuildingType.id[bid];
        const bName = buildingTypeNames[bTypeId] ?? '';
        if (SUPERWEAPON_CONFIG[bName]) {
          palaceType = bName;
          break;
        }
      }

      if (palaceType) {
        if (!this.state.has(pid)) {
          this.state.set(pid, { palaceType, charge: 0, ready: false });
        }
        const sw = this.state.get(pid)!;
        sw.palaceType = palaceType;
        const config = SUPERWEAPON_CONFIG[palaceType];
        if (!sw.ready) {
          const mult = getPowerMultiplier(pid);
          sw.charge += 25 * mult;
          if (sw.charge >= config.chargeTime) {
            sw.charge = config.chargeTime;
            sw.ready = true;
            EventBus.emit('superweapon:ready', { owner: pid, type: palaceType });
            audioManager.playSfx('superweaponReady');
            if (pid === 0) {
              selectionPanel.addMessage(`${config.name} ready!`, '#ff8800');
            } else {
              selectionPanel.addMessage(`Warning: Enemy superweapon detected!`, '#ff4444');
            }
          }
        }
      } else {
        this.state.delete(pid);
      }
    }

    // Update UI button for player
    const sw = this.state.get(0);
    if (sw) {
      this.swButton.style.display = 'flex';
      const config = SUPERWEAPON_CONFIG[sw.palaceType];
      const pct = Math.min(100, (sw.charge / (config?.chargeTime ?? 1)) * 100);
      this.swChargeBar.style.width = `${pct}%`;
      if (sw.ready) {
        this.swLabel.textContent = `${config?.name ?? 'Superweapon'} - READY`;
        this.swLabel.style.color = '#ff4444';
        this.swButton.style.borderColor = '#f44';
        this.swButton.style.cursor = 'pointer';
        this.swChargeBar.style.background = '#f44';
      } else {
        this.swLabel.textContent = `${config?.name ?? 'Charging...'} ${Math.floor(pct)}%`;
        this.swLabel.style.color = '#f88';
        this.swButton.style.borderColor = '#555';
        this.swButton.style.cursor = 'default';
      }
    } else {
      this.swButton.style.display = 'none';
    }

    // AI fires superweapon at player base when ready
    const aiSwBlds = buildingQuery(world);
    for (let aiPid = 1; aiPid < totalPlayers; aiPid++) {
      const aiSw = this.state.get(aiPid);
      if (aiSw?.ready) {
        const playerBlds = aiSwBlds;
        let bestX = 100, bestZ = 100, bestCount = 0;
        for (const bid of playerBlds) {
          if (Owner.playerId[bid] !== 0 || Health.current[bid] <= 0) continue;
          const bx = Position.x[bid], bz = Position.z[bid];
          let count = 0;
          for (const bid2 of playerBlds) {
            if (Owner.playerId[bid2] !== 0 || Health.current[bid2] <= 0) continue;
            const dx = Position.x[bid2] - bx, dz = Position.z[bid2] - bz;
            if (dx * dx + dz * dz < 225) count++;
          }
          if (count > bestCount) { bestCount = count; bestX = bx; bestZ = bz; }
        }
        if (bestCount > 0) {
          bestX += (Math.random() - 0.5) * 6;
          bestZ += (Math.random() - 0.5) * 6;
          this.fire(aiPid, bestX, bestZ);
        }
      }
    }
  }

  /** Serialize superweapon charge state for save/load */
  getChargeState(): Array<{ playerId: number; palaceType: string; charge: number }> {
    const result: Array<{ playerId: number; palaceType: string; charge: number }> = [];
    for (const [playerId, s] of this.state) {
      result.push({ playerId, palaceType: s.palaceType, charge: s.charge });
    }
    return result;
  }

  /** Restore superweapon charge state from saved data */
  setChargeState(data: Array<{ playerId: number; palaceType: string; charge: number }>): void {
    this.state.clear();
    for (const entry of data) {
      const cfg = SUPERWEAPON_CONFIG[entry.palaceType];
      if (!cfg) continue;
      this.state.set(entry.playerId, {
        palaceType: entry.palaceType,
        charge: entry.charge,
        ready: entry.charge >= cfg.chargeTime,
      });
    }
  }
}
