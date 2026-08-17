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
const LAMP_ON = 0.09;

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
    sun: rgb(120, 140, 200),
    sunI: 0.1,
    ambient: 0.1,
    ambientColor: rgb(56, 74, 122),
    top: rgb(5, 7, 16),
    horizon: rgb(16, 22, 40),
    fog: rgb(12, 16, 30),
    stars: 0.75,
  },
  {
    at: -0.12,
    sun: rgb(150, 150, 200),
    sunI: 0.12,
    ambient: 0.13,
    ambientColor: rgb(70, 86, 130),
    top: rgb(18, 26, 54),
    horizon: rgb(70, 62, 84),
    fog: rgb(44, 46, 66),
    stars: 0.4,
  },
  {
    at: 0.06,
    sun: rgb(255, 150, 92),
    sunI: 0.75,
    ambient: 0.2,
    ambientColor: rgb(120, 116, 150),
    top: rgb(52, 74, 132),
    horizon: rgb(226, 140, 96),
    fog: rgb(190, 150, 140),
    stars: 0,
  },
  {
    at: 0.35,
    sun: rgb(255, 214, 168),
    sunI: 1.25,
    ambient: 0.28,
    ambientColor: rgb(128, 150, 190),
    top: rgb(62, 110, 176),
    horizon: rgb(178, 200, 220),
    fog: rgb(168, 186, 204),
    stars: 0,
  },
  {
    at: 1,
    sun: rgb(255, 246, 226),
    sunI: 1.5,
    ambient: 0.32,
    ambientColor: rgb(140, 164, 200),
    top: rgb(58, 118, 196),
    horizon: rgb(190, 212, 230),
    fog: rgb(178, 196, 214),
    stars: 0,
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
  const lamp = (LAMP_ON - altitude) / 0.22;
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
