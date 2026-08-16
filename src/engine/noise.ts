/**
 * Deterministic value noise.
 *
 * Everything here is a pure function of position and seed — no state, no
 * caching, no generation order. That is what lets an outdoor world be
 * *stable*: walk twenty minutes east and back again and the hills are exactly
 * where you left them, because they were never stored, only recomputed. It is
 * also what keeps the streaming window cheap, since any tile can be evaluated
 * on its own without reference to its neighbours.
 */

import { hash2 } from './materials.ts';

/** Non-negative integer hash of two coordinates plus a salt. */
export function hashi(x: number, y: number, salt: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Smooth 2D value noise in 0..1. */
export function noise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  // Smoothstep the cell fractions so the lattice does not show as creases.
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const s = seed | 0;
  const a = hash2(ix + s, iy);
  const b = hash2(ix + 1 + s, iy);
  const c = hash2(ix + s, iy + 1);
  const d = hash2(ix + 1 + s, iy + 1);

  const top = a + (b - a) * sx;
  const bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}

/**
 * Stretch an fBm value to actually use its range.
 *
 * Averaging octaves pulls the result hard toward 0.5 — a 5-octave fBm mostly
 * lives inside 0.35..0.65 — so anything scaled by it straight comes out a
 * fraction of the amplitude asked for, and any threshold set near 0.5 either
 * never triggers or triggers everywhere. Everything downstream wants this.
 */
export function norm01(v: number): number {
  const t = (v - 0.5) * 3.1 + 0.5;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Fractal Brownian motion: octaves of noise2, normalised to 0..1. */
export function fbm2(x: number, y: number, seed: number, octaves = 4, gain = 0.5, lacunarity = 2): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged noise: 1 along a set of winding lines, falling away on either side.
 * Rivers and roads are both "a line that wanders across the landscape", which
 * is exactly what the ridges of folded noise give you for free.
 */
export function ridge2(x: number, y: number, seed: number, octaves = 3): number {
  const n = norm01(fbm2(x, y, seed, octaves));
  return 1 - Math.abs(n * 2 - 1);
}

/** Warp a coordinate pair by another noise field, to break up regularity. */
export function warp(x: number, y: number, seed: number, amount: number): [number, number] {
  return [
    x + (noise2(x * 0.5, y * 0.5, seed) - 0.5) * amount,
    y + (noise2(x * 0.5 + 31.7, y * 0.5 - 17.3, seed + 91) - 0.5) * amount,
  ];
}
