import type { Light } from './types.ts';
import { TILE_EMPTY } from './types.ts';
import { hash2 } from './materials.ts';
import { hasLineOfSight } from './raycast.ts';
import type { World } from './world.ts';

/** Accumulator for a lighting result. Reused to avoid per-cell allocation. */
export interface LightAccum {
  r: number;
  g: number;
  b: number;
}

export function makeAccum(): LightAccum {
  return { r: 0, g: 0, b: 0 };
}

/**
 * Rebake the shadow field of any light whose occlusion may have changed —
 * a door crossed its passable threshold, or a carried light drifted far
 * enough. Baking is per *tile*, not per pixel: a 34x24 map is 816 short
 * line-of-sight walks, which is cheap enough to redo whenever it matters and
 * far cheaper than shadow-testing every one of ~7000 character cells.
 */
export function ensureVisibility(world: World): void {
  for (const light of world.lights) {
    if (light.vis && !light.visDirty) continue;
    bakeVisibility(world, light);
  }
}

export function bakeVisibility(world: World, light: Light): void {
  // One tile of margin past the radius so the wall-inheritance pass below has
  // real neighbours to read at the edge of the field.
  const r = Math.ceil(light.radius) + 1;
  const w = r * 2 + 1;
  const h = w;
  const ox = Math.floor(light.x) - r;
  const oy = Math.floor(light.y) - r;

  if (!light.vis || light.vis.length !== w * h) light.vis = new Float32Array(w * h);
  const vis = light.vis;
  light.visOX = ox;
  light.visOY = oy;
  light.visW = w;
  light.visH = h;

  const r2 = light.radius * light.radius;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const tile = world.tileAt(ox + x, oy + y);
      if (!tile || tile.type !== TILE_EMPTY) {
        vis[i] = -1; // resolved in the fill-in pass below
        continue;
      }
      const cx = ox + x + 0.5;
      const cy = oy + y + 0.5;
      const dx = cx - light.x;
      const dy = cy - light.y;
      if (dx * dx + dy * dy > r2) {
        vis[i] = 0;
        continue;
      }
      vis[i] = hasLineOfSight(world, light.x, light.y, cx, cy) ? 1 : 0;
    }
  }

  // Solid tiles inherit the brightest of their open neighbours. Without this,
  // bilinear sampling would drag a dark seam along the base of every wall.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (vis[i] !== -1) continue;
      let best = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const v = vis[ny * w + nx];
          if (v > best) best = v;
        }
      }
      vis[i] = best;
    }
  }

  light.visDirty = false;
  light.visX = light.x;
  light.visY = light.y;
}

/** Bilinear sample of a light's shadow field at a world position. */
function visibilityAt(world: World, light: Light, x: number, y: number): number {
  const vis = light.vis;
  if (!vis) return 1;
  const w = light.visW;
  const h = light.visH;

  // Into the field's local coordinates. Anything outside it is further away
  // than the light reaches, so it is unlit rather than clamped to the edge.
  const gx = x - 0.5 - light.visOX;
  const gy = y - 0.5 - light.visOY;
  if (gx < -1 || gy < -1 || gx > w || gy > h) return 0;

  let x0 = Math.floor(gx);
  let y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;

  const cx0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
  const cy0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
  const cx1 = x0 + 1 < 0 ? 0 : x0 + 1 >= w ? w - 1 : x0 + 1;
  const cy1 = y0 + 1 < 0 ? 0 : y0 + 1 >= h ? h - 1 : y0 + 1;

  const v00 = vis[cy0 * w + cx0];
  const v10 = vis[cy0 * w + cx1];
  const v01 = vis[cy1 * w + cx0];
  const v11 = vis[cy1 * w + cx1];

  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}

/** Smooth deterministic 1D noise; drives flicker without ever being random. */
function valueNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash2(i, seed);
  const b = hash2(i + 1, seed);
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

export function flickerFactor(light: Light, time: number): number {
  if (light.flicker <= 0) return 1;
  const n = valueNoise(time * 8.5, light.seed) * 0.65 + valueNoise(time * 21, light.seed + 91) * 0.35;
  return Math.max(0.25, 1 + (n - 0.5) * 2 * light.flicker);
}

/** Height above the floor that every point light hangs at, in tiles. */
export const LIGHT_HEIGHT = 0.58;

/**
 * Total light arriving at a surface point, in linear units where 1.0 is a
 * fully lit white surface. May exceed 1; tone mapping deals with that.
 *
 * `z` is the height of the point above the floor (0 = floor, 1 = ceiling).
 * Attenuation uses the true 3D distance, so a torch visibly pools on the wall
 * beside it and falls off toward the ceiling instead of lighting the whole
 * column evenly.
 *
 * `nx`/`ny` is the surface normal in the plane. Pass (0, 0) for floors and
 * ceilings, which are treated as facing the light with a fixed wrap term.
 */
export function surfaceLight(
  world: World,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  out: LightAccum,
): void {
  const amb = world.ambient;
  out.r = (world.ambientColor.r / 255) * amb;
  out.g = (world.ambientColor.g / 255) * amb;
  out.b = (world.ambientColor.b / 255) * amb;

  const horizontal = nx === 0 && ny === 0;

  for (const light of world.lights) {
    // Each light carries its own height now — a lamp on a post pools very
    // differently from a candle on the floor — so the vertical term moves
    // inside the loop.
    const dz = light.z - z;
    const dz2 = dz * dz;
    const dx = light.x - x;
    const dy = light.y - y;
    const dFlat2 = dx * dx + dy * dy;
    const d2 = dFlat2 + dz2;
    if (d2 > light.radius * light.radius) continue;

    const d = Math.sqrt(d2) || 1e-4;
    const dFlat = Math.sqrt(dFlat2) || 1e-4;

    // Windowed falloff: reaches exactly zero at the radius, which keeps a
    // light's influence bounded and its pool of illumination readable.
    const f = 1 - d / light.radius;
    let atten = f * f * 0.82 + f * 0.18;

    // Wrap-around diffuse. Pure Lambert goes black at grazing angles, which at
    // character resolution reads as a hard artefact rather than as shading.
    let ndotl: number;
    if (horizontal) {
      // Floors and ceilings: the more directly overhead the light is, the more
      // of it lands here.
      ndotl = 0.3 + 0.7 * Math.min(1, Math.abs(dz) / d);
    } else {
      const dot = (dx * nx + dy * ny) / dFlat;
      ndotl = 0.22 + 0.78 * Math.max(0, dot);
    }
    atten *= ndotl;
    if (atten <= 0) continue;

    const shadow = visibilityAt(world, light, x, y);
    if (shadow <= 0) continue;

    const power = atten * shadow * light.intensity * flickerFactor(light, world.time);
    out.r += (light.color.r / 255) * power;
    out.g += (light.color.g / 255) * power;
    out.b += (light.color.b / 255) * power;
  }
}

/**
 * How far past perpendicular a surface still catches sun.
 *
 * The same wrap-around idea the point lights use, but shifted rather than
 * floored, which matters here. The sun sits low so that slopes shade
 * differently from one another, and pure Lambert against a low sun draws a
 * knife-edge terminator across every hill — at character resolution that reads
 * as a tear in the image rather than as the far side of a slope. Shifting the
 * zero crossing spreads the terminator over several tiles of slope instead.
 *
 * A floor (`w + (1-w)*max(0,dot)`) was tried first and is worse: it lifts every
 * back-facing surface by the same amount, so shadow becomes a flat grey wash
 * and the frame loses the range the low sun was there to create. Entropy over
 * the built-in outdoor maps fell from 2.0 to 1.4 on that version alone.
 */
const SUN_WRAP = 0.35;

/** Directional sun on a surface with the given normal. */
export function sunLight(world: World, nx: number, ny: number, nz: number): number {
  if (world.sunIntensity <= 0) return 0;
  const dot = nx * world.sunX + ny * world.sunY + nz * world.sunZ;
  const w = (dot + SUN_WRAP) / (1 + SUN_WRAP);
  return w > 0 ? world.sunIntensity * w : 0;
}

/** Blend a linear colour in `c` toward the fog colour by distance, in place. */
export function applyFog(world: World, dist: number, c: LightAccum): void {
  if (world.fogDensity <= 0) return;
  const f = 1 - Math.exp(-dist * world.fogDensity);
  const fr = world.fogColor.r / 255;
  const fg = world.fogColor.g / 255;
  const fb = world.fogColor.b / 255;
  c.r += (fr - c.r) * f;
  c.g += (fg - c.g) * f;
  c.b += (fb - c.b) * f;
}
