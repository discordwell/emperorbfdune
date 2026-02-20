/**
 * Web Worker for A* pathfinding — offloads expensive path computation from main thread.
 * Receives terrain data and blocked tiles, processes findPath requests asynchronously.
 */

// Terrain types (must match TerrainType enum)
const enum TT {
  Sand = 0,
  Rock = 1,
  SpiceLow = 2,
  SpiceHigh = 3,
  Dunes = 4,
  Cliff = 5,
  ConcreteSlab = 6,
  InfantryRock = 7,
}

interface PathNode {
  tx: number;
  tz: number;
  g: number;
  h: number;
  f: number;
  parent: PathNode | null;
}

class MinHeap {
  private data: PathNode[] = [];
  get length(): number { return this.data.length; }

  insert(node: PathNode): void {
    this.data.push(node);
    this.bubbleUp(this.data.length - 1);
  }

  extractMin(): PathNode {
    const min = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return min;
  }

  private bubbleUp(i: number): void {
    const d = this.data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (d[i].f >= d[parent].f) break;
      const tmp = d[i]; d[i] = d[parent]; d[parent] = tmp;
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const d = this.data;
    const n = d.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && d[left].f < d[smallest].f) smallest = left;
      if (right < n && d[right].f < d[smallest].f) smallest = right;
      if (smallest === i) break;
      const tmp = d[i]; d[i] = d[smallest]; d[smallest] = tmp;
      i = smallest;
    }
  }
}

// Terrain state
let terrainData: Uint8Array | null = null;
let mapW = 0;
let mapH = 0;
let blockedTiles = new Set<number>();

function isPassable(tx: number, tz: number): boolean {
  if (tx < 0 || tx >= mapW || tz < 0 || tz >= mapH) return false;
  return terrainData![tz * mapW + tx] !== TT.Cliff;
}

function isPassableVehicle(tx: number, tz: number): boolean {
  if (tx < 0 || tx >= mapW || tz < 0 || tz >= mapH) return false;
  const t = terrainData![tz * mapW + tx];
  return t !== TT.Cliff && t !== TT.InfantryRock;
}

function heuristic(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(bx - ax);
  const dz = Math.abs(bz - az);
  return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
}

function findNearestPassable(
  tx: number, tz: number,
  passableFn: (tx: number, tz: number) => boolean
): { tx: number; tz: number } | null {
  for (let r = 1; r < 10; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const ntx = tx + dx;
        const ntz = tz + dz;
        if (ntx >= 0 && ntx < mapW && ntz >= 0 && ntz < mapH && passableFn(ntx, ntz)) {
          return { tx: ntx, tz: ntz };
        }
      }
    }
  }
  return null;
}

function simplifyPath(path: { x: number; z: number }[]): { x: number; z: number }[] {
  if (path.length <= 2) return path;
  const result = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = result[result.length - 1];
    const next = path[i + 1];
    const curr = path[i];
    const dx1 = curr.x - prev.x;
    const dz1 = curr.z - prev.z;
    const dx2 = next.x - curr.x;
    const dz2 = next.z - curr.z;
    if (dx1 !== dx2 || dz1 !== dz2) {
      result.push(curr);
    }
  }
  result.push(path[path.length - 1]);
  return result;
}

function reconstructPath(node: PathNode): { x: number; z: number }[] {
  const path: { x: number; z: number }[] = [];
  let current: PathNode | null = node;
  while (current) {
    path.unshift({ x: current.tx * 2 + 1, z: current.tz * 2 + 1 });
    current = current.parent;
  }
  return simplifyPath(path);
}

function findPath(
  startTx: number, startTz: number,
  endTx: number, endTz: number,
  isVehicle: boolean,
  maxNodes: number
): { x: number; z: number }[] | null {
  if (!terrainData) return null;

  const passable = isVehicle
    ? (tx: number, tz: number) => isPassableVehicle(tx, tz) && !blockedTiles.has(tz * mapW + tx)
    : (tx: number, tz: number) => isPassable(tx, tz) && !blockedTiles.has(tz * mapW + tx);

  if (!passable(endTx, endTz)) {
    const nearest = findNearestPassable(endTx, endTz, passable);
    if (!nearest) return null;
    endTx = nearest.tx;
    endTz = nearest.tz;
  }

  const openSet = new MinHeap();
  const closedSet = new Set<number>();
  const bestG = new Map<number, number>();

  const startNode: PathNode = {
    tx: startTx, tz: startTz,
    g: 0,
    h: heuristic(startTx, startTz, endTx, endTz),
    f: 0,
    parent: null,
  };
  startNode.f = startNode.g + startNode.h;
  openSet.insert(startNode);

  let nodesExplored = 0;
  let bestPartialNode: PathNode | null = null;

  while (openSet.length > 0 && nodesExplored < maxNodes) {
    nodesExplored++;
    const current = openSet.extractMin();

    if (current.tx === endTx && current.tz === endTz) {
      return reconstructPath(current);
    }

    const key = current.tz * mapW + current.tx;
    if (closedSet.has(key)) continue;
    if (current.g > (bestG.get(key) ?? Infinity)) continue;
    closedSet.add(key);

    if (!bestPartialNode || current.h < bestPartialNode.h) {
      bestPartialNode = current;
    }

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const ntx = current.tx + dx;
        const ntz = current.tz + dz;

        if (ntx < 0 || ntx >= mapW || ntz < 0 || ntz >= mapH) continue;
        const nkey = ntz * mapW + ntx;
        if (closedSet.has(nkey)) continue;
        if (!passable(ntx, ntz)) continue;

        if (dx !== 0 && dz !== 0) {
          if (!passable(current.tx + dx, current.tz) || !passable(current.tx, current.tz + dz)) {
            continue;
          }
        }

        const baseCost = (dx !== 0 && dz !== 0) ? 1.414 : 1.0;
        const tType = terrainData[ntz * mapW + ntx];
        const terrainMult = tType === TT.Dunes ? 1.5
          : tType === TT.Rock || tType === TT.InfantryRock ? 0.8
          : tType === TT.ConcreteSlab ? 0.7
          : 1.0;
        const moveCost = baseCost * terrainMult;
        const g = current.g + moveCost;

        if (g >= (bestG.get(nkey) ?? Infinity)) continue;
        bestG.set(nkey, g);

        const h = heuristic(ntx, ntz, endTx, endTz);
        openSet.insert({
          tx: ntx, tz: ntz,
          g, h, f: g + h,
          parent: current,
        });
      }
    }
  }

  if (bestPartialNode && bestPartialNode.parent && bestPartialNode.h < startNode.h * 0.7) {
    return reconstructPath(bestPartialNode);
  }

  return null;
}

// Message handling
self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      // Receive terrain data
      terrainData = new Uint8Array(msg.terrainData);
      mapW = msg.mapWidth;
      mapH = msg.mapHeight;
      break;
    }

    case 'updateTerrain': {
      // Incremental terrain update
      if (terrainData && msg.terrainData) {
        terrainData = new Uint8Array(msg.terrainData);
      }
      break;
    }

    case 'updateBlocked': {
      // Update blocked tiles from building placements
      blockedTiles = new Set<number>(msg.tiles as number[]);
      break;
    }

    case 'findPath': {
      const result = findPath(
        msg.startTx, msg.startTz,
        msg.endTx, msg.endTz,
        msg.isVehicle,
        msg.maxNodes ?? 3000
      );
      (self as unknown as Worker).postMessage({
        type: 'pathResult',
        requestId: msg.requestId,
        path: result,
      });
      break;
    }
  }
};
