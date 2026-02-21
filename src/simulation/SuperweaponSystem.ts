/**
 * SuperweaponSystem - Manages palace superweapon charging, targeting, firing, and AI usage.
 * Extracted from index.ts to reduce main file complexity.
 */

import { simRng } from '../utils/DeterministicRNG';
import { EventBus } from '../core/EventBus';
import {
  Position, Health, Owner, BuildingType,
  unitQuery, buildingQuery,
  type World,
} from '../core/ECS';
import type { SceneManager } from '../rendering/SceneManager';
import type { EffectsManager } from '../rendering/EffectsManager';
import type { AudioManager } from '../audio/AudioManager';
import type { SelectionPanel } from '../ui/SelectionPanel';
import type { MinimapRenderer } from '../rendering/MinimapRenderer';
import type { GameRules } from '../config/RulesParser';
import { TILE_SIZE } from '../utils/MathUtils';

interface SuperweaponConfig {
  name: string;
  chargeTime: number;
  radius: number;
  damage: number;
  style: 'missile' | 'airstrike' | 'lightning';
}

// Display names and styles for superweapon types (not available in rules.txt)
const SUPERWEAPON_DISPLAY: Record<string, { name: string; style: 'missile' | 'airstrike' | 'lightning' }> = {
  'HKPalace': { name: 'Death Hand Missile', style: 'missile' },
  'ATPalace': { name: 'Hawk Strike', style: 'airstrike' },
  'ORPalace': { name: 'Chaos Lightning', style: 'lightning' },
  'GUPalace': { name: 'Guild NIAB Strike', style: 'lightning' },
};

// Hardcoded fallback config (used when rules.txt data can't be resolved)
// Radius values are in world units (tiles * TILE_SIZE)
const FALLBACK_CONFIG: Record<string, SuperweaponConfig> = {
  'HKPalace': { name: 'Death Hand Missile', chargeTime: 5184, radius: 6, damage: 5000, style: 'missile' },
  'ATPalace': { name: 'Hawk Strike', chargeTime: 4536, radius: 8, damage: 1000, style: 'airstrike' },
  'ORPalace': { name: 'Chaos Lightning', chargeTime: 6220, radius: 8, damage: 1000, style: 'lightning' },
  'GUPalace': { name: 'Guild NIAB Strike', chargeTime: 5500, radius: 20, damage: 700, style: 'lightning' },
};

/** Build superweapon config dynamically from parsed rules.txt data */
function buildSuperweaponConfig(rules: GameRules): Record<string, SuperweaponConfig> {
  const config: Record<string, SuperweaponConfig> = {};

  // Scan units for superweapon flags and resolve their data chains
  for (const [unitName, unitDef] of rules.units) {
    let style: 'missile' | 'airstrike' | 'lightning' | null = null;
    if (unitDef.deathHand) style = 'missile';
    else if (unitDef.hawkWeapon) style = 'airstrike';
    else if (unitDef.beamWeapon) style = 'lightning';
    if (!style) continue;

    // Find which palace building produces this unit
    const palaceName = unitDef.primaryBuilding;
    if (!palaceName) continue;

    const display = SUPERWEAPON_DISPLAY[palaceName];
    const chargeTime = unitDef.buildTime;

    // Resolve bullet from Resource field
    // Resource format: "BulletName" or "FXName, BulletName"
    let bulletName = '';
    if (unitDef.resource) {
      const parts = unitDef.resource.split(',').map(s => s.trim());
      bulletName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    }

    let damage = 0;
    let radius = 0;
    if (bulletName) {
      const bullet = rules.bullets.get(bulletName);
      if (bullet) {
        damage = bullet.damage;
        // Convert game units to world units: 32 game units = 1 tile, 1 tile = TILE_SIZE world units
        radius = (bullet.blastRadius / 32) * TILE_SIZE;
      }
    }

    config[palaceName] = {
      name: display?.name ?? unitName,
      chargeTime: chargeTime || FALLBACK_CONFIG[palaceName]?.chargeTime || 5000,
      radius: radius || FALLBACK_CONFIG[palaceName]?.radius || 4,
      damage: damage || FALLBACK_CONFIG[palaceName]?.damage || 500,
      style: display?.style ?? style,
    };
  }

  // Add fallbacks for any palaces not found in rules (e.g. GUPalace)
  for (const [palaceName, fallback] of Object.entries(FALLBACK_CONFIG)) {
    if (!config[palaceName]) {
      config[palaceName] = fallback;
    }
  }

  return config;
}

export interface SuperweaponDeps {
  scene: SceneManager;
  effectsManager: EffectsManager;
  audioManager: AudioManager;
  selectionPanel: SelectionPanel;
  minimapRenderer: MinimapRenderer;
  totalPlayers: number;
  buildingTypeNames: string[];
  gameRules: GameRules;
  getWorld: () => World;
  getTickCount: () => number;
  getPowerMultiplier: (playerId: number) => number;
}

export class SuperweaponSystem {
  private deps: SuperweaponDeps;
  private superweaponConfig: Record<string, SuperweaponConfig>;
  private state = new Map<number, { palaceType: string; charge: number; ready: boolean }>();
  private targetMode = false;
  private swButton: HTMLDivElement;
  private swChargeBar: HTMLDivElement;
  private swLabel: HTMLSpanElement;

  constructor(deps: SuperweaponDeps) {
    this.deps = deps;
    this.superweaponConfig = buildSuperweaponConfig(deps.gameRules);

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
        cmdMode.textContent = `${this.superweaponConfig[sw.palaceType]?.name ?? 'Superweapon'} - Click to target`;
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

    const config = this.superweaponConfig[sw.palaceType];
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
        const ox = targetX + i * 2 + (simRng.random() - 0.5) * 2;
        const oz = targetZ + (simRng.random() - 0.5) * 3;
        setTimeout(() => effectsManager.spawnExplosion(ox, 0, oz, 'medium'), delay);
      }
    } else if (config.style === 'lightning') {
      for (let i = 0; i < 8; i++) {
        const delay = i * 80;
        const angle = (i / 8) * Math.PI * 2;
        const dist = 2 + simRng.random() * (config.radius * 0.5);
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
          // Note: only emit unit:died here; the unit:died handler in index.ts
          // already emits building:destroyed for buildings, avoiding double-fire.
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
        if (this.superweaponConfig[bName]) {
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
        const config = this.superweaponConfig[palaceType];
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
      const config = this.superweaponConfig[sw.palaceType];
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

    // AI fires superweapon at densest cluster of enemy buildings
    const aiSwBlds = buildingQuery(world);
    for (let aiPid = 1; aiPid < totalPlayers; aiPid++) {
      const aiSw = this.state.get(aiPid);
      if (aiSw?.ready) {
        let bestX = 100, bestZ = 100, bestCount = 0;
        // Find enemy building with most other enemy buildings nearby
        for (const bid of aiSwBlds) {
          if (Owner.playerId[bid] === aiPid || Health.current[bid] <= 0) continue;
          const bx = Position.x[bid], bz = Position.z[bid];
          let count = 0;
          for (const bid2 of aiSwBlds) {
            // Count nearby buildings NOT owned by this AI (i.e. enemy buildings)
            if (Owner.playerId[bid2] === aiPid || Health.current[bid2] <= 0) continue;
            const dx = Position.x[bid2] - bx, dz = Position.z[bid2] - bz;
            if (dx * dx + dz * dz < 225) count++;
          }
          if (count > bestCount) { bestCount = count; bestX = bx; bestZ = bz; }
        }
        if (bestCount > 0) {
          bestX += (simRng.random() - 0.5) * 6;
          bestZ += (simRng.random() - 0.5) * 6;
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
      const cfg = this.superweaponConfig[entry.palaceType];
      if (!cfg) continue;
      this.state.set(entry.playerId, {
        palaceType: entry.palaceType,
        charge: entry.charge,
        ready: entry.charge >= cfg.chargeTime,
      });
    }
  }
}
