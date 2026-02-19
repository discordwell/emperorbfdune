import type { TerrainRenderer } from '../rendering/TerrainRenderer';

interface PathNode {
  tx: number;
  tz: number;
  g: number;
  h: number;
  f: number;
  parent: PathNode | null;
}

/** Binary min-heap for A* open set — O(log n) insert/extract vs O(n) linear scan */
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

export class PathfindingSystem {
  private terrain: TerrainRenderer;
  private blockedTiles = new Set<number>(); // key = tz * mapW + tx

  constructor(terrain: TerrainRenderer) {
    this.terrain = terrain;
  }

  updateBlockedTiles(occupied: Set<string>): void {
    this.blockedTiles.clear();
    const mapW = this.terrain.getMapWidth();
    for (const key of occupied) {
      const [tx, tz] = key.split(',').map(Number);
      this.blockedTiles.add(tz * mapW + tx);
    }
  }

  findPath(
    startTx: number, startTz: number,
    endTx: number, endTz: number,
    isVehicle: boolean = true,
    maxNodes: number = 1000
  ): { x: number; z: number }[] | null {
    // A* pathfinding on terrain grid
    const mapW = this.terrain.getMapWidth();
    const mapH = this.terrain.getMapHeight();
    const passable = isVehicle
      ? (tx: number, tz: number) => this.terrain.isPassableVehicle(tx, tz) && !this.blockedTiles.has(tz * mapW + tx)
      : (tx: number, tz: number) => this.terrain.isPassable(tx, tz) && !this.blockedTiles.has(tz * mapW + tx);

    if (!passable(endTx, endTz)) {
      // Find nearest passable tile to target
      const nearest = this.findNearestPassable(endTx, endTz, passable);
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
      h: this.heuristic(startTx, startTz, endTx, endTz),
      f: 0,
      parent: null,
    };
    startNode.f = startNode.g + startNode.h;
    openSet.insert(startNode);

    let nodesExplored = 0;

    while (openSet.length > 0 && nodesExplored < maxNodes) {
      nodesExplored++;

      const current = openSet.extractMin();

      if (current.tx === endTx && current.tz === endTz) {
        return this.reconstructPath(current);
      }

      const key = current.tz * mapW + current.tx;
      if (closedSet.has(key)) continue;
      closedSet.add(key);

      // 8-directional neighbors
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const ntx = current.tx + dx;
          const ntz = current.tz + dz;

          if (ntx < 0 || ntx >= mapW || ntz < 0 || ntz >= mapH) continue;
          const nkey = ntz * mapW + ntx;
          if (closedSet.has(nkey)) continue;
          if (!passable(ntx, ntz)) continue;

          // Diagonal movement check (don't cut corners)
          if (dx !== 0 && dz !== 0) {
            if (!passable(current.tx + dx, current.tz) || !passable(current.tx, current.tz + dz)) {
              continue;
            }
          }

          const moveCost = (dx !== 0 && dz !== 0) ? 1.414 : 1.0;
          const g = current.g + moveCost;

          // Skip if we already found a shorter path to this tile
          if (g >= (bestG.get(nkey) ?? Infinity)) continue;
          bestG.set(nkey, g);

          const h = this.heuristic(ntx, ntz, endTx, endTz);
          openSet.insert({
            tx: ntx, tz: ntz,
            g, h, f: g + h,
            parent: current,
          });
        }
      }
    }

    return null; // No path found
  }

  private heuristic(ax: number, az: number, bx: number, bz: number): number {
    // Octile distance
    const dx = Math.abs(bx - ax);
    const dz = Math.abs(bz - az);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
  }

  private reconstructPath(node: PathNode): { x: number; z: number }[] {
    const path: { x: number; z: number }[] = [];
    let current: PathNode | null = node;
    while (current) {
      // Convert tile to world coords (center of tile)
      path.unshift({ x: current.tx * 2 + 1, z: current.tz * 2 + 1 });
      current = current.parent;
    }
    // Simplify path - remove collinear points
    return this.simplifyPath(path);
  }

  private simplifyPath(path: { x: number; z: number }[]): { x: number; z: number }[] {
    if (path.length <= 2) return path;
    const result = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const prev = result[result.length - 1];
      const next = path[i + 1];
      const curr = path[i];
      // Keep if direction changes
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

  private findNearestPassable(tx: number, tz: number, passable: (tx: number, tz: number) => boolean): { tx: number; tz: number } | null {
    const mapW = this.terrain.getMapWidth();
    const mapH = this.terrain.getMapHeight();
    for (let r = 1; r < 10; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const ntx = tx + dx;
          const ntz = tz + dz;
          if (ntx >= 0 && ntx < mapW && ntz >= 0 && ntz < mapH && passable(ntx, ntz)) {
            return { tx: ntx, tz: ntz };
          }
        }
      }
    }
    return null;
  }
}
