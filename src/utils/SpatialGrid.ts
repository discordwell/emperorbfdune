/**
 * Spatial hash grid for efficient neighbor queries.
 * Reduces O(n²) all-pairs checks to O(n*k) where k is nearby entity count.
 */
export class SpatialGrid {
  private cellSize: number;
  private invCellSize: number;
  private cells = new Map<number, number[]>();
  // Reusable result arrays to avoid GC pressure in hot loops
  private nearbyResult: number[] = [];
  private radiusResult: number[] = [];

  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
  }

  clear(): void {
    this.cells.clear();
  }

  private key(cx: number, cz: number): number {
    // Pack two 16-bit signed ints into one 32-bit number
    return ((cx & 0xFFFF) << 16) | (cz & 0xFFFF);
  }

  insert(eid: number, x: number, z: number): void {
    const cx = Math.floor(x * this.invCellSize);
    const cz = Math.floor(z * this.invCellSize);
    const k = this.key(cx, cz);
    let cell = this.cells.get(k);
    if (!cell) {
      cell = [];
      this.cells.set(k, cell);
    }
    cell.push(eid);
  }

  /** Get all entities in the same and adjacent cells (3x3 neighborhood).
   *  WARNING: returned array is reused between calls — do not store references. */
  getNearby(x: number, z: number): number[] {
    const cx = Math.floor(x * this.invCellSize);
    const cz = Math.floor(z * this.invCellSize);
    const result = this.nearbyResult;
    result.length = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.cells.get(this.key(cx + dx, cz + dz));
        if (cell) {
          for (let i = 0; i < cell.length; i++) {
            result.push(cell[i]);
          }
        }
      }
    }
    return result;
  }

  /** Get all entities within a radius (checks 3x3+ cells as needed).
   *  WARNING: returned array is reused between calls — do not store references. */
  getInRadius(x: number, z: number, radius: number): number[] {
    const cellSpan = Math.ceil(radius * this.invCellSize);
    const cx = Math.floor(x * this.invCellSize);
    const cz = Math.floor(z * this.invCellSize);
    const result = this.radiusResult;
    result.length = 0;
    for (let dz = -cellSpan; dz <= cellSpan; dz++) {
      for (let dx = -cellSpan; dx <= cellSpan; dx++) {
        const cell = this.cells.get(this.key(cx + dx, cz + dz));
        if (cell) {
          for (let i = 0; i < cell.length; i++) {
            result.push(cell[i]);
          }
        }
      }
    }
    return result;
  }
}
