import type { GameContext } from '../core/GameContext';
import type { PauseMenu } from '../ui/PauseMenu';
import { getDisplayName } from '../config/DisplayNames';
import {
  hasComponent,
  Position, Health, Owner, UnitType,
  MoveTarget, Veterancy, Harvester, BuildingType,
  buildingQuery,
} from '../core/ECS';

export function registerInputHandlers(ctx: GameContext, pauseMenu: PauseMenu): void {
  const {
    game, scene, gameRules, typeRegistry, unitRenderer,
    selectionManager, commandManager, abilitySystem,
    selectionPanel, audioManager, input,
  } = ctx;
  const { unitTypeNames, buildingTypeNames } = typeRegistry;

  const helpOverlay = document.getElementById('help-overlay');
  const tooltipEl = document.getElementById('tooltip');
  const gameCanvas = document.getElementById('game-canvas') as HTMLCanvasElement;

  // Camera bookmarks
  const cameraBookmarks = new Map<number, { x: number; z: number }>();

  // Event ring buffer for Space key cycling
  type GameEvent = { x: number; z: number; type: string; time: number };
  const eventQueue: GameEvent[] = [];
  let eventCycleIdx = -1;

  // Build the event queue widget (near minimap)
  const eventQueueEl = document.createElement('div');
  eventQueueEl.style.cssText = `
    position:fixed;bottom:10px;left:210px;
    font-family:'Segoe UI',Tahoma,sans-serif;font-size:10px;
    pointer-events:auto;z-index:15;display:flex;gap:3px;
  `;
  document.body.appendChild(eventQueueEl);

  function updateEventQueueUI(): void {
    eventQueueEl.innerHTML = '';
    for (let i = eventQueue.length - 1; i >= 0; i--) {
      const ev = eventQueue[i];
      const age = (Date.now() - ev.time) / 1000;
      if (age > 120) continue;
      const iconMap: Record<string, string> = { attack: '\u2694', death: '\u2620', worm: '\ud83d\udc1b' };
      const colorMap: Record<string, string> = { attack: '#f44', death: '#f88', worm: '#f80' };
      const icon = iconMap[ev.type] ?? '\u26a0';
      const color = colorMap[ev.type] ?? '#aaa';
      const opacity = Math.max(0.4, 1 - age / 120);
      const btn = document.createElement('div');
      btn.style.cssText = `
        width:22px;height:22px;background:rgba(20,10,10,0.8);border:1px solid ${color};
        border-radius:3px;display:flex;align-items:center;justify-content:center;
        cursor:pointer;opacity:${opacity};font-size:12px;
      `;
      btn.title = `${ev.type} (${Math.round(age)}s ago) — click to jump`;
      btn.textContent = icon;
      const idx = i;
      btn.addEventListener('click', () => {
        eventCycleIdx = idx;
        scene.panTo(eventQueue[idx].x, eventQueue[idx].z);
      });
      eventQueueEl.appendChild(btn);
    }
  }
  setInterval(updateEventQueueUI, 10000);

  // Wire pushGameEvent into ctx
  ctx.pushGameEvent = (x: number, z: number, type: string): void => {
    eventQueue.push({ x, z, type, time: Date.now() });
    if (eventQueue.length > 5) eventQueue.shift();
    eventCycleIdx = eventQueue.length - 1;
    updateEventQueueUI();
  };

  // Speed indicator
  const speedEl = document.getElementById('game-speed');
  ctx.updateSpeedIndicator = (speed: number): void => {
    if (!speedEl) return;
    const label = speed <= 0.5 ? '0.5x' : speed >= 2.0 ? '2x' : '1x';
    const color = speed <= 0.5 ? '#88aaff' : speed >= 2.0 ? '#ff8844' : '#888';
    speedEl.textContent = label;
    speedEl.style.color = color;
  };

  // Contextual cursor
  const ATTACK_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='9' stroke='%23ff3333' stroke-width='2' fill='none'/%3E%3Cline x1='12' y1='3' x2='12' y2='7' stroke='%23ff3333' stroke-width='2'/%3E%3Cline x1='12' y1='17' x2='12' y2='21' stroke='%23ff3333' stroke-width='2'/%3E%3Cline x1='3' y1='12' x2='7' y2='12' stroke='%23ff3333' stroke-width='2'/%3E%3Cline x1='17' y1='12' x2='21' y2='12' stroke='%23ff3333' stroke-width='2'/%3E%3C/svg%3E") 12 12, crosshair`;
  const MOVE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M12 2 L17 8 L14 8 L14 14 L8 14 L8 8 L5 8 Z' fill='%2344ff44' stroke='%23000' stroke-width='1'/%3E%3C/svg%3E") 12 2, default`;
  let lastCursorUpdate = 0;
  let lastCursorStyle = '';
  let lastTooltipEid = -1;

  if (gameCanvas) {
    gameCanvas.addEventListener('mousemove', (e: MouseEvent) => {
      const now = performance.now();
      if (now - lastCursorUpdate < 80) return;
      lastCursorUpdate = now;

      const mode = commandManager.getCommandMode();
      if (mode === 'attack-move' || mode === 'patrol' || mode === 'teleport') {
        if (lastCursorStyle !== 'crosshair') {
          gameCanvas.style.cursor = 'crosshair';
          lastCursorStyle = 'crosshair';
        }
        if (tooltipEl) tooltipEl.style.display = 'none';
        lastTooltipEid = -1;
        return;
      }

      // Hover tooltip
      const hoverEid = unitRenderer.getEntityAtScreen(e.clientX, e.clientY);
      if (hoverEid !== null && tooltipEl) {
        const w = game.getWorld();
        if (!w || !hasComponent(w, Health, hoverEid)) {
          if (lastTooltipEid !== -1) { tooltipEl.style.display = 'none'; lastTooltipEid = -1; }
        } else {
          if (hoverEid !== lastTooltipEid) {
            lastTooltipEid = hoverEid;
            let name = '';
            let isBuilding = false;
            if (hasComponent(w, UnitType, hoverEid)) {
              const typeId = UnitType.id[hoverEid];
              name = unitTypeNames[typeId] ?? '';
            } else if (hasComponent(w, BuildingType, hoverEid)) {
              const typeId = BuildingType.id[hoverEid];
              name = buildingTypeNames[typeId] ?? '';
              isBuilding = true;
            }
            const displayName = name ? getDisplayName(name) : 'Unknown';
            const hp = Health.current[hoverEid];
            const maxHp = Health.max[hoverEid];
            const hpPct = maxHp > 0 ? Math.round((hp / maxHp) * 100) : 0;
            const hpColor = hpPct > 60 ? '#4f4' : hpPct > 30 ? '#ff8' : '#f44';
            const owner = Owner.playerId[hoverEid];
            const ownerLabel = owner === 0 ? 'You' : `Player ${owner}`;
            const rank = hasComponent(w, Veterancy, hoverEid) ? Veterancy.rank[hoverEid] : 0;
            const rankStr = rank > 0 ? ` ${'*'.repeat(rank)}` : '';
            tooltipEl.innerHTML = `<div style="font-weight:bold;color:#fff;">${displayName}${rankStr}</div>`
              + `<div style="color:${hpColor};">HP: ${Math.round(hp)}/${Math.round(maxHp)} (${hpPct}%)</div>`
              + `<div style="color:#aaa;font-size:10px;">${ownerLabel}${isBuilding ? ' | Building' : ''}</div>`;
            tooltipEl.style.display = 'block';
          }
          const tx = Math.min(e.clientX + 16, window.innerWidth - 260);
          const ty = Math.max(10, Math.min(e.clientY - 10, window.innerHeight - 60));
          tooltipEl.style.left = `${tx}px`;
          tooltipEl.style.top = `${ty}px`;
        }
      } else {
        if (tooltipEl && lastTooltipEid !== -1) {
          tooltipEl.style.display = 'none';
          lastTooltipEid = -1;
        }
      }

      const selected = selectionManager.getSelectedEntities();
      if (selected.length === 0) {
        if (lastCursorStyle !== 'default') {
          gameCanvas.style.cursor = 'default';
          lastCursorStyle = 'default';
        }
        return;
      }

      if (hoverEid !== null) {
        const hoverOwner = Owner.playerId[hoverEid];
        const selOwner = Owner.playerId[selected[0]];
        if (hoverOwner !== selOwner) {
          if (lastCursorStyle !== 'attack') {
            gameCanvas.style.cursor = ATTACK_CURSOR;
            lastCursorStyle = 'attack';
          }
        } else {
          if (lastCursorStyle !== 'move') {
            gameCanvas.style.cursor = MOVE_CURSOR;
            lastCursorStyle = 'move';
          }
        }
      } else {
        if (lastCursorStyle !== 'move') {
          gameCanvas.style.cursor = MOVE_CURSOR;
          lastCursorStyle = 'move';
        }
      }
    });
    gameCanvas.addEventListener('mouseleave', () => {
      if (tooltipEl) tooltipEl.style.display = 'none';
      lastTooltipEid = -1;
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      if (helpOverlay) {
        helpOverlay.style.display = helpOverlay.style.display === 'none' ? 'block' : 'none';
      }
    } else if (e.key === 'Escape' && helpOverlay?.style.display === 'block') {
      helpOverlay.style.display = 'none';
    } else if (e.key === 'h' && !e.ctrlKey && !e.altKey) {
      const w = game.getWorld();
      const blds = buildingQuery(w);
      let baseX = 50, baseZ = 50;
      for (const bid of blds) {
        if (Owner.playerId[bid] !== 0 || Health.current[bid] <= 0) continue;
        const bTypeId = BuildingType.id[bid];
        const bName = buildingTypeNames[bTypeId] ?? '';
        if (bName.includes('ConYard')) {
          baseX = Position.x[bid];
          baseZ = Position.z[bid];
          break;
        }
      }
      scene.panTo(baseX, baseZ);
    } else if (e.key === ' ' && !e.ctrlKey) {
      e.preventDefault();
      if (selectionManager.getSelectedEntities().length > 0) {
        // Let SelectionManager handle
      } else if (eventQueue.length > 0) {
        if (eventCycleIdx < 0 || eventCycleIdx >= eventQueue.length) eventCycleIdx = eventQueue.length - 1;
        const ev = eventQueue[eventCycleIdx];
        scene.panTo(ev.x, ev.z);
        eventCycleIdx--;
        if (eventCycleIdx < 0) eventCycleIdx = eventQueue.length - 1;
      }
    } else if ('xdtluw'.includes(e.key) && !e.ctrlKey && !e.altKey) {
      const selected = selectionManager.getSelectedEntities();
      const handled = abilitySystem.handleKeyCommand(e.key, selected, game.getWorld());
      if (handled) {
        e.stopImmediatePropagation();
        input.consumeKey(e.key);
      }
      if (!handled && e.key === 'x' && selected.length > 0) {
        commandManager.issueScatterCommand(selected);
      }
    } else if (e.key === 'F1' || e.key === 'F2' || e.key === 'F3' || e.key === 'F4') {
      e.preventDefault();
      const slot = parseInt(e.key.charAt(1)) - 1;
      if (e.ctrlKey || e.metaKey) {
        const ct = scene.getCameraTarget();
        cameraBookmarks.set(slot, { x: ct.x, z: ct.z });
        selectionPanel.addMessage(`Camera ${slot + 1} saved`, '#88f');
      } else {
        const bm = cameraBookmarks.get(slot);
        if (bm) {
          scene.panTo(bm.x, bm.z);
          selectionPanel.addMessage(`Camera ${slot + 1}`, '#88f');
        } else {
          selectionPanel.addMessage(`Camera ${slot + 1} not set (Ctrl+F${slot + 1} to save)`, '#666');
        }
      }
    } else if (e.key === '-' || e.key === '_') {
      const speeds = [0.5, 1.0, 2.0];
      const currentSpeed = game.getSpeed();
      const idx = speeds.findIndex(s => Math.abs(s - currentSpeed) < 0.01);
      const newSpeed = speeds[Math.max(0, (idx < 0 ? 1 : idx) - 1)];
      game.setSpeed(newSpeed);
      selectionPanel.addMessage(`Speed: ${newSpeed}x`, '#888');
      ctx.updateSpeedIndicator(newSpeed);
    } else if (e.key === '=' || e.key === '+') {
      const speeds = [0.5, 1.0, 2.0];
      const currentSpeed = game.getSpeed();
      const idx = speeds.findIndex(s => Math.abs(s - currentSpeed) < 0.01);
      const newSpeed = speeds[Math.min(speeds.length - 1, (idx < 0 ? 1 : idx) + 1)];
      game.setSpeed(newSpeed);
      selectionPanel.addMessage(`Speed: ${newSpeed}x`, '#888');
      ctx.updateSpeedIndicator(newSpeed);
    } else if (e.key === 'F5') {
      e.preventDefault();
      ctx.saveGame();
    } else if (e.key === 'F8') {
      e.preventDefault();
      if (localStorage.getItem('ebfd_save')) {
        selectionPanel.addMessage('Loading saved game...', '#88f');
        localStorage.setItem('ebfd_load', '1');
        setTimeout(() => window.location.reload(), 300);
      } else {
        selectionPanel.addMessage('No saved game found', '#f44');
      }
    } else if (e.key === 'Escape' && !helpOverlay?.style.display?.includes('block')) {
      e.preventDefault();
      if (pauseMenu.isOpen) {
        pauseMenu.close();
        if (pauseMenu.pausedByMenu && game.isPaused()) game.pause();
        pauseMenu.pausedByMenu = false;
      } else {
        pauseMenu.pausedByMenu = !game.isPaused();
        if (!game.isPaused()) game.pause();
        pauseMenu.show();
      }
    } else if (e.key === 'F9') {
      e.preventDefault();
      game.pause();
      selectionPanel.addMessage(game.isPaused() ? 'Game Paused' : 'Game Resumed', '#888');
    }
  });
}
