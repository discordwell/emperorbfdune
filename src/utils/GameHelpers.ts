export function createSeededRng(seedText: string): () => number {
  let hash = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    hash ^= seedText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let state = (hash >>> 0) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Distribute N spawn positions evenly around an ellipse inscribed in the map */
export function getSpawnPositions(
  mapW: number,
  mapH: number,
  count: number,
  randomFn: () => number = Math.random,
): { x: number; z: number }[] {
  const TILE_SZ = 2;
  const centerX = (mapW / 2) * TILE_SZ;
  const centerZ = (mapH / 2) * TILE_SZ;
  const radiusX = mapW * 0.35 * TILE_SZ;
  const radiusZ = mapH * 0.35 * TILE_SZ;
  const margin = 20 * TILE_SZ;
  const maxX = mapW * TILE_SZ - margin;
  const maxZ = mapH * TILE_SZ - margin;

  const positions: { x: number; z: number }[] = [];

  if (count === 2) {
    const minPos = Math.max(margin, 50);
    const corners = [
      { x: minPos, z: minPos },
      { x: maxX, z: minPos },
      { x: minPos, z: maxZ },
      { x: maxX, z: maxZ },
    ];
    const playerIdx = Math.floor(randomFn() * 4);
    const enemyIdx = 3 - playerIdx;
    positions.push(corners[playerIdx], corners[enemyIdx]);
  } else {
    const startAngle = randomFn() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const angle = startAngle + (i * Math.PI * 2) / count;
      let x = centerX + Math.cos(angle) * radiusX;
      let z = centerZ + Math.sin(angle) * radiusZ;
      x = Math.max(margin, Math.min(maxX, x));
      z = Math.max(margin, Math.min(maxZ, z));
      positions.push({ x, z });
    }
  }

  return positions;
}

export function updateLoading(pct: number, text: string, detail?: string): void {
  const bar = document.getElementById('loading-bar');
  const label = document.getElementById('loading-text');
  const detailEl = document.getElementById('loading-detail');
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = text;
  if (detailEl) detailEl.textContent = detail ?? '';
}
