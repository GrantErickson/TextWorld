import type { Material, PatternId, RGB } from './types.ts';
import { slotForPattern } from './shading.ts';

/**
 * Texels per world tile. Texture coordinates are snapped to this lattice
 * before a pattern is evaluated, which is the first half of keeping the image
 * stable: a surface point always resolves to the same texel no matter where
 * the camera stands, so wall detail is welded to the wall instead of crawling
 * across it as you move.
 */
export const TEXELS_PER_TILE = 12;

export function rgb(r: number, g: number, b: number): RGB {
  return { r, g, b };
}

export function parseColor(input: string | undefined, fallback: RGB): RGB {
  if (!input) return fallback;
  const s = input.trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return fallback;
  const hex = m[1];
  if (hex.length === 3) {
    return rgb(
      parseInt(hex[0] + hex[0], 16),
      parseInt(hex[1] + hex[1], 16),
      parseInt(hex[2] + hex[2], 16),
    );
  }
  return rgb(
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  );
}

const PATTERNS: readonly PatternId[] = [
  'solid',
  'noise',
  'rock',
  'brick',
  'panel',
  'grate',
  'tile',
  'planks',
  'water',
];

export function parsePattern(input: string | undefined): PatternId {
  if (input && (PATTERNS as readonly string[]).includes(input)) return input as PatternId;
  return 'solid';
}

export function makeMaterial(
  id: string,
  color: RGB,
  pattern: PatternId,
  roughness = 0.6,
  emissive = 0,
  nightGlow = 0,
): Material {
  return { id, color, pattern, roughness, emissive, nightGlow, glyphSlot: slotForPattern(pattern) };
}

export const DEFAULT_WALL = makeMaterial('default-wall', rgb(140, 146, 156), 'rock', 0.6);
export const DEFAULT_FLOOR = makeMaterial('default-floor', rgb(84, 90, 100), 'tile', 0.45);
export const DEFAULT_CEILING = makeMaterial('default-ceiling', rgb(64, 70, 82), 'panel', 0.35);

/** Deterministic integer hash -> [0, 1). Stable across frames by construction. */
export function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function fbm(ix: number, iy: number): number {
  return (
    hash2(ix, iy) * 0.5 +
    hash2(ix >> 1, iy >> 1) * 0.3 +
    hash2(ix >> 2, iy >> 2) * 0.2
  );
}

/**
 * Sample a material's procedural pattern.
 *
 * `u` runs along the surface and `v` across it; both are in tile units (not
 * normalised), so a 3-tile-wide wall gets three repeats rather than one
 * stretched copy. Returns a brightness multiplier around 1.0.
 */
export function sampleTexture(m: Material, u: number, v: number): number {
  if (m.pattern === 'solid' && m.roughness === 0) return 1;

  const iu = Math.floor(u * TEXELS_PER_TILE);
  const iv = Math.floor(v * TEXELS_PER_TILE);
  let t = 1;

  // The deviations below are wide on purpose. They used to sit around +-15%,
  // which sounds like plenty and is not: after roughness scales it and the
  // tone curve compresses it, a whole wall of it stayed inside a single ramp
  // step and rendered as one flat character. A pattern has to move the value
  // across a step boundary or it may as well not exist.
  switch (m.pattern) {
    case 'solid':
      t = 1 + (hash2(iu, iv) - 0.5) * 0.12;
      break;

    case 'noise':
      t = 0.72 + fbm(iu, iv) * 0.58;
      break;

    case 'rock': {
      const n = fbm(iu, iv);
      const crack = fbm(iu >> 1, (iv * 3) >> 1) > 0.8 ? 0.48 : 1;
      t = (0.66 + n * 0.64) * crack;
      break;
    }

    case 'brick': {
      // 6x3 texel bricks, every other course offset by half a brick.
      const course = Math.floor(iv / 3);
      const offset = (course & 1) === 1 ? 3 : 0;
      const bx = (((iu + offset) % 6) + 6) % 6;
      const by = (((iv % 3) + 3) % 3);
      const mortar = bx === 0 || by === 0;
      t = mortar ? 0.42 : 0.86 + hash2(course, Math.floor((iu + offset) / 6)) * 0.42;
      break;
    }

    case 'panel': {
      const seamV = (((iu % 8) + 8) % 8) === 0;
      const seamH = (((iv % 14) + 14) % 14) === 0;
      const rivet = (((iu % 8) + 8) % 8) === 4 && (((iv % 14) + 14) % 14) === 7;
      t = seamV || seamH ? 0.44 : rivet ? 1.32 : 0.93 + hash2(iu >> 3, iv >> 3) * 0.2;
      break;
    }

    case 'grate': {
      const bx = ((iu % 3) + 3) % 3;
      const by = ((iv % 3) + 3) % 3;
      t = bx !== 0 && by !== 0 ? 0.14 : 1.2;
      break;
    }

    case 'tile': {
      const grout = (((iu % 6) + 6) % 6) === 0 || (((iv % 6) + 6) % 6) === 0;
      const checker = ((Math.floor(iu / 6) + Math.floor(iv / 6)) & 1) === 1;
      t = grout ? 0.45 : checker ? 0.82 : 1.14;
      break;
    }

    case 'planks': {
      const seam = (((iv % 4) + 4) % 4) === 0;
      t = seam ? 0.46 : 0.84 + hash2(iu, Math.floor(iv / 4)) * 0.4;
      break;
    }

    case 'water': {
      // Long shallow ripples: banded across v, wandering along u. Static, like
      // every other pattern here — a surface that animates is a surface that
      // never settles, and the sun glint in the renderer supplies the life.
      const band = Math.sin(iv * 0.62 + hash2(iu >> 2, 0) * 6.28) * 0.5 + 0.5;
      t = 0.82 + band * 0.3 + hash2(iu, iv >> 1) * 0.08;
      break;
    }
  }

  // Roughness scales the deviation from flat, so a polished material keeps its
  // pattern shape but with far less contrast.
  return 1 + (t - 1) * m.roughness;
}
