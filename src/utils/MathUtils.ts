import { simRng } from './DeterministicRNG';

export const TILE_SIZE = 2; // World units per tile

export function tileToWorld(tileX: number, tileZ: number): { x: number; z: number } {
  return { x: tileX * TILE_SIZE, z: tileZ * TILE_SIZE };
}

export function worldToTile(worldX: number, worldZ: number): { tx: number; tz: number } {
  return { tx: Math.floor(worldX / TILE_SIZE), tz: Math.floor(worldZ / TILE_SIZE) };
}

export function distance2D(x1: number, z1: number, x2: number, z2: number): number {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distanceSq2D(x1: number, z1: number, x2: number, z2: number): number {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return dx * dx + dz * dz;
}

export function angleBetween(x1: number, z1: number, x2: number, z2: number): number {
  return Math.atan2(x2 - x1, z2 - z1);
}

export function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function randomInt(min: number, max: number): number {
  return Math.floor(simRng.random() * (max - min + 1)) + min;
}

export function randomFloat(min: number, max: number): number {
  return simRng.random() * (max - min) + min;
}
