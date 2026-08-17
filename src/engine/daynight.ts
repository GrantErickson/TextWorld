/**
 * Time of day.
 *
 * One value, `timeOfDay` in 0..1, drives everything: where the sun is, how
 * bright and what colour it is, what colour the sky and the fog are, whether
 * stars are out, and whether the street lamps have come on. Deriving them all
 * from one number is what keeps dusk coherent — the light reddens, the sky
 * reddens with it, the shadows lengthen and the lamps flicker on together,
 * because they are all reading the same clock.
 *
 *   0.00  midnight      0.25  sunrise      0.50  noon      0.75  sunset
 */

import type { RGB } from './types.ts';
import { rgb } from './materials.ts';

const TAU = Math.PI * 2;

/** Seconds in a full cycle. Long enough to notice, short enough to see night. */
export const DAY_LENGTH = 240;

/** Below this sun altitude the lamps are lit. */
const LAMP_ON = 0.12;

export interface SkyState {
  /** Sun altitude, -1 at midnight to +1 at noon. */
  altitude: number;
  sunX: number;
  sunY: number;
  sunZ: number;
  sunColor: RGB;
  sunIntensity: number;
  ambient: number;
  ambientColor: RGB;
  skyTop: RGB;
  skyHorizon: RGB;
  fogColor: RGB;
  stars: number;
  /** 0 by day, 1 once it is dark enough for the lamps. */
  lampness: number;
}

/** A keyframe of the sky, keyed by sun altitude. */
interface Key {
  at: number;
  sun: RGB;
  sunI: number;
  ambient: number;
  ambientColor: RGB;
  top: RGB;
  horizon: RGB;
  fog: RGB;
  stars: number;
}

// Ordered by altitude. Dusk is given its own key rather than being interpolated
// between night and noon: the warm low sun is the most recognisable light of
// the day and a straight blend right through it loses the colour entirely.
const KEYS: Key[] = [
  {
    at: -1,
    sun: rgb(120, 140, 200), sunI: 0.1, ambient: 0.1, ambientColor: rgb(56, 74, 122),
    top: rgb(5, 7, 16), horizon: rgb(16, 22, 40), fog: rgb(12, 16, 30), stars: 0.78,
  },
  {
    at: -0.42,
    sun: rgb(126, 146, 202), sunI: 0.1, ambient: 0.105, ambientColor: rgb(60, 78, 124),
    top: rgb(7, 10, 22), horizon: rgb(22, 28, 50), fog: rgb(16, 21, 38), stars: 0.74,
  },
  {
    at: -0.26,
    sun: rgb(136, 148, 198), sunI: 0.11, ambient: 0.115, ambientColor: rgb(68, 84, 130),
    top: rgb(12, 17, 38), horizon: rgb(40, 42, 68), fog: rgb(28, 33, 54), stars: 0.6,
  },
  {
    at: -0.15,
    sun: rgb(168, 154, 190), sunI: 0.14, ambient: 0.13, ambientColor: rgb(84, 94, 134),
    top: rgb(20, 29, 58), horizon: rgb(78, 68, 90), fog: rgb(50, 52, 72), stars: 0.38,
  },
  {
    at: -0.07,
    sun: rgb(208, 148, 150), sunI: 0.3, ambient: 0.155, ambientColor: rgb(104, 104, 142),
    top: rgb(32, 46, 88), horizon: rgb(140, 100, 106), fog: rgb(96, 88, 100), stars: 0.16,
  },
  {
    at: 0,
    sun: rgb(240, 140, 104), sunI: 0.5, ambient: 0.175, ambientColor: rgb(114, 112, 146),
    top: rgb(44, 62, 112), horizon: rgb(196, 124, 96), fog: rgb(146, 122, 122), stars: 0.05,
  },
  {
    at: 0.08,
    sun: rgb(255, 158, 100), sunI: 0.82, ambient: 0.205, ambientColor: rgb(124, 122, 154),
    top: rgb(54, 78, 136), horizon: rgb(230, 152, 108), fog: rgb(192, 156, 142), stars: 0,
  },
  {
    at: 0.2,
    sun: rgb(255, 190, 140), sunI: 1.05, ambient: 0.245, ambientColor: rgb(130, 140, 176),
    top: rgb(58, 96, 158), horizon: rgb(206, 190, 190), fog: rgb(186, 178, 180), stars: 0,
  },
  {
    at: 0.42,
    sun: rgb(255, 224, 182), sunI: 1.3, ambient: 0.285, ambientColor: rgb(132, 154, 194),
    top: rgb(60, 112, 180), horizon: rgb(182, 204, 222), fog: rgb(172, 190, 206), stars: 0,
  },
  {
    at: 1,
    sun: rgb(255, 246, 226), sunI: 1.5, ambient: 0.32, ambientColor: rgb(140, 164, 200),
    top: rgb(58, 118, 196), horizon: rgb(190, 212, 230), fog: rgb(178, 196, 214), stars: 0,
  },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return rgb(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t));
}

export function makeSkyState(): SkyState {
  return {
    altitude: 1,
    sunX: 0,
    sunY: 0,
    sunZ: 1,
    sunColor: rgb(255, 246, 226),
    sunIntensity: 1.4,
    ambient: 0.3,
    ambientColor: rgb(140, 164, 200),
    skyTop: rgb(58, 118, 196),
    skyHorizon: rgb(190, 212, 230),
    fogColor: rgb(178, 196, 214),
    stars: 0,
    lampness: 0,
  };
}

/** Evaluate the sky for a time of day. Pure: no world, no state. */
export function skyAt(t: number, out: SkyState): void {
  const frac = t - Math.floor(t);

  // Altitude is a cosine of the clock; the horizontal bearing swings from due
  // east at sunrise to due west at sunset, with a constant tilt so the light
  // is never exactly overhead and surfaces always have some direction to it.
  const altitude = -Math.cos(frac * TAU);

  // Sunrise (frac .25) -> due east, noon (.5) -> overhead, sunset (.75) -> west.
  const arc = (frac - 0.25) * TAU;
  const dirX = Math.cos(arc);
  const dirZ = Math.sin(arc);
  const len = Math.hypot(dirX, 0.38, dirZ) || 1;
  out.sunX = dirX / len;
  out.sunY = -0.38 / len;
  out.sunZ = dirZ / len;
  out.altitude = altitude;

  // Find the bracketing keys.
  let i = 0;
  while (i < KEYS.length - 2 && altitude > KEYS[i + 1].at) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const span = b.at - a.at || 1;
  const raw = (altitude - a.at) / span;
  const k = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  // Smoothstep, so the transitions do not have corners in them.
  const u = k * k * (3 - 2 * k);

  out.sunColor = mixRGB(a.sun, b.sun, u);
  out.sunIntensity = lerp(a.sunI, b.sunI, u);
  out.ambient = lerp(a.ambient, b.ambient, u);
  out.ambientColor = mixRGB(a.ambientColor, b.ambientColor, u);
  out.skyTop = mixRGB(a.top, b.top, u);
  out.skyHorizon = mixRGB(a.horizon, b.horizon, u);
  out.fogColor = mixRGB(a.fog, b.fog, u);
  out.stars = lerp(a.stars, b.stars, u);

  // Lamps fade in over a band rather than snapping, so dusk has a moment where
  // both the sky and the lamps are contributing.
  const lamp = (LAMP_ON - altitude) / 0.34;
  out.lampness = lamp < 0 ? 0 : lamp > 1 ? 1 : lamp;
}

/** Clock time as a readable 24h string, for telemetry. */
export function clockString(t: number): string {
  const frac = t - Math.floor(t);
  const minutes = Math.round(frac * 24 * 60);
  const hh = Math.floor(minutes / 60) % 24;
  const mm = minutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
