/**
 * Async wrapper around the pathfinder Web Worker.
 * Queues path requests and resolves them when the worker responds.
 * Falls back to synchronous pathfinding if worker fails to load.
 */

import { PathfindingSystem } from './PathfindingSystem';
import type { TerrainRenderer } from '../rendering/TerrainRenderer';

interface PendingRequest {
  resolve: (path: { x: number; z: number }[] | null) => void;
}

export class AsyncPathfinder {
  private worker: Worker | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private fallback: PathfindingSystem;
  private terrain: TerrainRenderer;
  private ready = false;

  constructor(terrain: TerrainRenderer, fallback: PathfindingSystem) {
    this.terrain = terrain;
    this.fallback = fallback;
    this.initWorker();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker('/dist/pathfinder.worker.js');
      this.worker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === 'pathResult') {
          const req = this.pending.get(msg.requestId);
          if (req) {
            this.pending.delete(msg.requestId);
            req.resolve(msg.path);
          }
        }
      };
      this.worker.onerror = (e: ErrorEvent) => {
        console.warn('Pathfinder worker error, falling back to sync:', e.message);
        this.worker = null;
        // Resolve all pending requests via fallback
        for (const [, req] of this.pending) {
          req.resolve(null);
        }
        this.pending.clear();
      };
      // Send initial terrain data
      this.sendTerrainData();
      this.ready = true;
    } catch {
      console.warn('Failed to create pathfinder worker, using sync fallback');
      this.worker = null;
    }
  }

  /** Send current terrain state to the worker */
  sendTerrainData(): void {
    if (!this.worker) return;
    const data = this.terrain.getTerrainDataCopy();
    this.worker.postMessage({
      type: 'init',
      terrainData: data.buffer,
      mapWidth: this.terrain.getMapWidth(),
      mapHeight: this.terrain.getMapHeight(),
    }, [data.buffer]);
  }

  /** Update terrain data in worker (call after terrain changes like building placement) */
  updateTerrain(): void {
    if (!this.worker) return;
    const data = this.terrain.getTerrainDataCopy();
    this.worker.postMessage({
      type: 'updateTerrain',
      terrainData: data.buffer,
    }, [data.buffer]);
  }

  /** Update blocked tiles in worker */
  updateBlockedTiles(occupied: Set<string>): void {
    // Update fallback too
    this.fallback.updateBlockedTiles(occupied);

    if (!this.worker) return;
    const mapW = this.terrain.getMapWidth();
    const tiles: number[] = [];
    for (const key of occupied) {
      const [tx, tz] = key.split(',').map(Number);
      tiles.push(tz * mapW + tx);
    }
    this.worker.postMessage({
      type: 'updateBlocked',
      tiles,
    });
  }

  /** Request a path asynchronously. Returns a promise. */
  findPathAsync(
    startTx: number, startTz: number,
    endTx: number, endTz: number,
    isVehicle: boolean,
    maxNodes: number = 3000
  ): Promise<{ x: number; z: number }[] | null> {
    if (!this.worker) {
      // Sync fallback
      return Promise.resolve(
        this.fallback.findPath(startTx, startTz, endTx, endTz, isVehicle, maxNodes)
      );
    }

    const id = this.requestId++;
    return new Promise(resolve => {
      this.pending.set(id, { resolve });
      this.worker!.postMessage({
        type: 'findPath',
        requestId: id,
        startTx, startTz, endTx, endTz,
        isVehicle, maxNodes,
      });
    });
  }

  /** Synchronous path for immediate needs (uses fallback). */
  findPathSync(
    startTx: number, startTz: number,
    endTx: number, endTz: number,
    isVehicle: boolean,
    maxNodes: number = 3000
  ): { x: number; z: number }[] | null {
    return this.fallback.findPath(startTx, startTz, endTx, endTz, isVehicle, maxNodes);
  }

  /** Check if worker is available */
  isWorkerAvailable(): boolean {
    return this.worker !== null && this.ready;
  }

  /** Get count of pending async requests */
  getPendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pending.clear();
  }
}
