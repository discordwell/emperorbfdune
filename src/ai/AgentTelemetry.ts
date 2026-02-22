/**
 * Agent telemetry — reports game state to the telemetry server and document.title.
 * Two-phase:
 *   1. startConsoleCapture() — call at top of main(), captures all console + errors
 *   2. createTelemetrySystem() — call after game loop starts, adds game state reporting
 */
import {
  Owner, Health, UnitType, BuildingType,
  unitQuery, buildingQuery,
} from '../core/ECS';
import type { GameContext } from '../core/GameContext';
import type { AgentConfig } from './CampaignAgent';

const TELEMETRY_URL = 'http://localhost:8081';
const REPORT_INTERVAL_TICKS = 120; // ~2 seconds at 60 tps

interface TelemetrySnapshot {
  ts: number;
  status: string;
  tick: number;
  elapsed: number;
  outcome: string;
  house: string;
  territory: number | null;
  missionCount: number;
  players: PlayerSnapshot[];
  errors: string[];
  warnings: string[];
}

interface PlayerSnapshot {
  id: number;
  units: number;
  buildings: number;
  solaris: number;
  unitTypes: Record<string, number>;
  buildingTypes: Record<string, number>;
}

// Console capture state (shared between both phases)
const pendingConsoleLines: string[] = [];
const recentErrors: string[] = [];
const recentWarnings: string[] = [];
const MAX_RECENT = 20;
let consoleIntercepted = false;
let flushInterval: ReturnType<typeof setInterval> | null = null;

function flushConsoleLogs(): void {
  if (pendingConsoleLines.length === 0) return;
  const lines = pendingConsoleLines.splice(0);
  fetch(`${TELEMETRY_URL}/console`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines }),
  }).catch(() => {});
}

/**
 * Phase 1: Start capturing console output immediately.
 * Call this at the very top of main() so loading errors are captured.
 * Sets document.title to show loading status.
 */
export function startConsoleCapture(): void {
  if (consoleIntercepted) return;
  consoleIntercepted = true;

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const format = (args: any[]) =>
    args.map(a => typeof a === 'string' ? a : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');

  console.log = (...args: any[]) => {
    pendingConsoleLines.push(`[LOG] ${format(args)}`);
    originalLog.apply(console, args);
  };
  console.warn = (...args: any[]) => {
    const line = `[WARN] ${format(args)}`;
    pendingConsoleLines.push(line);
    recentWarnings.push(line);
    if (recentWarnings.length > MAX_RECENT) recentWarnings.shift();
    originalWarn.apply(console, args);
  };
  console.error = (...args: any[]) => {
    const line = `[ERROR] ${format(args)}`;
    pendingConsoleLines.push(line);
    recentErrors.push(line);
    if (recentErrors.length > MAX_RECENT) recentErrors.shift();
    originalError.apply(console, args);
  };

  window.addEventListener('error', (e) => {
    const line = `[UNCAUGHT] ${e.message} at ${e.filename}:${e.lineno}`;
    recentErrors.push(line);
    pendingConsoleLines.push(line);
    if (recentErrors.length > MAX_RECENT) recentErrors.shift();
  });

  window.addEventListener('unhandledrejection', (e) => {
    const line = `[UNHANDLED_PROMISE] ${e.reason}`;
    recentErrors.push(line);
    pendingConsoleLines.push(line);
    if (recentErrors.length > MAX_RECENT) recentErrors.shift();
  });

  // Flush console to telemetry server every 2 seconds (independent of game loop)
  flushInterval = setInterval(flushConsoleLogs, 2000);

  // Update title to show we're loading
  document.title = 'AGENT loading...';

}

/**
 * Phase 2: Start full game state telemetry reporting.
 * Uses setInterval (not game loop) so it works even if tab is throttled.
 */
export function createTelemetrySystem(
  ctx: GameContext,
  config: AgentConfig,
): { update(world: any, dt: number): void } {
  const startTime = Date.now();

  // setInterval-based reporting — works even when requestAnimationFrame is throttled
  setInterval(() => {
    try {
      // Force-unpause if paused (agent should never be paused)
      if (ctx.game.isPaused()) {
        ctx.game.pause(); // toggle to unpause
      }
      const snap = buildSnapshot(ctx, config, startTime);
      updateTitle(snap);
      sendTelemetry(snap);
    } catch (e) {
      document.title = `AGENT ERROR: ${e}`;
    }
  }, 3000);

  // Also report on first tick
  let firstReport = true;

  return {
    update(_world: any, _dt: number) {
      if (firstReport) {
        firstReport = false;
        try {
          const snap = buildSnapshot(ctx, config, startTime);
          updateTitle(snap);
          sendTelemetry(snap);
        } catch { /* ignore */ }
      }
    },
  };
}

function buildSnapshot(
  ctx: GameContext,
  config: AgentConfig,
  startTime: number,
): TelemetrySnapshot {
  const world = ctx.game.getWorld();
  const tick = ctx.game.getTickCount();
  const outcome = ctx.victorySystem.getOutcome();

  const playerMap = new Map<number, PlayerSnapshot>();
  const getPlayer = (id: number): PlayerSnapshot => {
    if (!playerMap.has(id)) {
      playerMap.set(id, { id, units: 0, buildings: 0, solaris: 0, unitTypes: {}, buildingTypes: {} });
    }
    return playerMap.get(id)!;
  };

  const units = unitQuery(world);
  for (const eid of units) {
    if (Health.current[eid] <= 0) continue;
    const owner = Owner.playerId[eid];
    const p = getPlayer(owner);
    p.units++;
    const typeId = UnitType.id[eid];
    const typeName = ctx.typeRegistry.unitTypeNames[typeId] ?? `unit_${typeId}`;
    p.unitTypes[typeName] = (p.unitTypes[typeName] ?? 0) + 1;
  }

  const buildings = buildingQuery(world);
  for (const eid of buildings) {
    if (Health.current[eid] <= 0) continue;
    const owner = Owner.playerId[eid];
    const p = getPlayer(owner);
    p.buildings++;
    const typeId = BuildingType.id[eid];
    const typeName = ctx.typeRegistry.buildingTypeNames[typeId] ?? `bldg_${typeId}`;
    p.buildingTypes[typeName] = (p.buildingTypes[typeName] ?? 0) + 1;
  }

  for (const [id, p] of playerMap) {
    try { p.solaris = ctx.harvestSystem.getSolaris(id); } catch { /* ignore */ }
  }

  return {
    ts: Date.now(),
    status: outcome === 'playing' ? 'playing' : outcome,
    tick,
    elapsed: Math.floor((Date.now() - startTime) / 1000),
    outcome,
    house: config.house,
    territory: ctx.house?.campaignTerritoryId ?? null,
    missionCount: config.missionCount,
    players: [...playerMap.values()].sort((a, b) => a.id - b.id),
    errors: [...recentErrors],
    warnings: [...recentWarnings],
  };
}

function updateTitle(snap: TelemetrySnapshot): void {
  const p0 = snap.players.find(p => p.id === 0);
  const enemies = snap.players.filter(p => p.id > 0);
  const enemyUnits = enemies.reduce((sum, p) => sum + p.units, 0);
  const enemyBuildings = enemies.reduce((sum, p) => sum + p.buildings, 0);

  const parts = [
    `AGENT ${snap.house} T${snap.territory ?? '?'} M${snap.missionCount + 1}`,
    `t:${snap.tick}`,
    `P:${p0?.units ?? 0}u/${p0?.buildings ?? 0}b/$${p0?.solaris ?? 0}`,
    `E:${enemyUnits}u/${enemyBuildings}b`,
    snap.outcome,
  ];
  if (snap.errors.length > 0) parts.push(`ERR:${snap.errors.length}`);
  document.title = parts.join(' | ');
}

function sendTelemetry(snap: TelemetrySnapshot): void {
  fetch(`${TELEMETRY_URL}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snap),
  }).catch(() => {});
}
