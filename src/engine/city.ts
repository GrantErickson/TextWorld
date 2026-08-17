/**
 * City generation.
 *
 * Like the wilds, every tile is a pure function of its absolute coordinates,
 * so the city is endless without being remembered. Unlike the wilds, it is not
 * a landscape with things scattered on it — it is a *plan*, and the order the
 * plan is read in matters:
 *
 *   streets -> sidewalks -> blocks -> lots -> buildings
 *
 * Each layer only fills what the one above it left over, which is what keeps
 * frontages square to their street and stops a building from straddling one.
 *
 * The streets themselves are the part most easily got wrong. It is tempting to
 * lay them out as `x % BLOCK < WIDTH`, which is O(1) and gives a perfectly
 * uniform grid that reads as graph paper rather than as a city. Instead each
 * street line is placed at its nominal spacing plus a hash-derived jitter.
 * Because the jitter depends only on the line's *index*, the line stays
 * straight and unbroken from one edge of the world to the other — blocks vary
 * in size while streets still run all the way across, which is what real
 * gridded cities look like.
 */

import type { Material, RGB } from './types.ts';
import { makeMaterial, parseColor, parsePattern, rgb } from './materials.ts';
import type { MapSourceMaterial } from './mapFormat.ts';
import { fbm2, hashi, norm01 } from './noise.ts';
import type { TerrainSample } from './terrain.ts';

/** Height of one storey, in tiles. */
export const STOREY = 3.4;

/** Nominal distance between street centre lines. */
const BLOCK = 34;
/** How far a street line may wander from its nominal position. */
const JITTER = 6;
/** Half-width of an ordinary street's carriageway. */
const ROAD_HALF = 2;
/** Half-width of an avenue: every Nth line is a major road. */
const AVENUE_HALF = 4;
const AVENUE_EVERY = 4;
/** Sidewalk width, outside the carriageway. */
const WALK = 2;
/** Lots are subdivided to roughly this size before a building goes up. */
const LOT = 11;

export interface CityThemeSpec {
  id: string;
  label: string;
  kind: 'city';

  road: MapSourceMaterial;
  walk: MapSourceMaterial;
  /** Facades are picked per building from this list. */
  facades: MapSourceMaterial[];
  roof: MapSourceMaterial;
  /** Upper storeys: carries the window glow that switches on after dark. */
  glass: MapSourceMaterial;
  /** Ground-floor shopfronts. One is picked per lot. */
  shopfronts: MapSourceMaterial[];
  /** Bright signage over a shopfront, on a minority of lots. */
  signs: MapSourceMaterial[];
  park: MapSourceMaterial;
  /** Road markings: centre lines and crossing stripes. */
  paint: MapSourceMaterial;

  /** Ground relief. A city is nearly flat, but not perfectly. */
  amplitude: number;
  /** Tallest a building may get, in storeys, at the centre of downtown. */
  maxStoreys: number;

  exposure: number;
  fogColor: string;
  fogDensity: number;
}

/** Everything the world needs about one city tile. */
export interface CitySample extends TerrainSample {
  /** Ground-floor face material, and the height it gives way to the facade. */
  sideLower: Material | null;
  bandZ: number;
  /** 0 for open ground; otherwise how many floors this building has. */
  storeys: number;
  /** True for a tile inside a building's footprint rather than on its wall. */
  interior: boolean;
}

export function makeCitySample(): CitySample {
  return {
    height: 0,
    bed: 0,
    depth: 0,
    solid: false,
    water: false,
    surface: DEFAULT_ROAD,
    side: DEFAULT_ROAD,
    biome: 0,
    bare: true,
    sideLower: null,
    bandZ: 0,
    storeys: 0,
    interior: false,
  };
}

interface Palette {
  shopfronts: Material[];
  signs: Material[];
  road: Material;
  walk: Material;
  facades: Material[];
  roof: Material;
  glass: Material;
  park: Material;
  paint: Material;
}

const palettes = new WeakMap<CityThemeSpec, Palette>();

function mat(def: MapSourceMaterial, fallback = rgb(140, 140, 140), nightGlow = 0): Material {
  return makeMaterial(
    'city',
    parseColor(def.color, fallback),
    parsePattern(def.pattern),
    def.roughness ?? 0.6,
    def.emissive ?? 0,
    nightGlow,
  );
}

function paletteFor(spec: CityThemeSpec): Palette {
  let p = palettes.get(spec);
  if (!p) {
    p = {
      // Shopfronts glow a little after dark; signs glow a lot.
      shopfronts: spec.shopfronts.map((f) => mat(f, undefined, 0.5)),
      signs: spec.signs.map((f) => mat(f, undefined, 1.7)),
      road: mat(spec.road),
      walk: mat(spec.walk),
      facades: spec.facades.map((f) => mat(f, undefined, 0.34)),
      roof: mat(spec.roof),
      glass: mat(spec.glass),
      park: mat(spec.park),
      paint: mat(spec.paint),
    };
    palettes.set(spec, p);
  }
  return p;
}

const DEFAULT_ROAD = makeMaterial('city', rgb(60, 60, 66), 'noise', 0.35);

// ------------------------------------------------------------------ streets

/** Whether the street line with this index is a major road. */
function isAvenue(i: number): boolean {
  return ((i % AVENUE_EVERY) + AVENUE_EVERY) % AVENUE_EVERY === 0;
}

function halfWidth(i: number): number {
  return isAvenue(i) ? AVENUE_HALF : ROAD_HALF;
}

/** Centre line of street `i`, jittered but straight for its whole length. */
export function streetLine(i: number, axis: number, seed: number): number {
  return i * BLOCK + (hashi(i, axis * 7919, seed) % (JITTER * 2 + 1)) - JITTER;
}

/**
 * The nearest street line to `v`, and how far away it is. Only the three
 * candidate indices around `v` can possibly be nearest, since the jitter is
 * bounded well below the spacing.
 */
function nearestStreet(v: number, axis: number, seed: number): { index: number; dist: number } {
  const guess = Math.round(v / BLOCK);
  let index = guess;
  let dist = Infinity;
  for (let k = guess - 1; k <= guess + 1; k++) {
    const d = Math.abs(v - streetLine(k, axis, seed));
    if (d < dist) {
      dist = d;
      index = k;
    }
  }
  return { index, dist };
}

export interface StreetInfo {
  /** True on the carriageway itself. */
  road: boolean;
  /** True on the pavement beside it. */
  walk: boolean;
  /** True where two carriageways cross. */
  junction: boolean;
  /** Distance from the nearest line on each axis, and that line's index. */
  dx: number;
  dy: number;
  ix: number;
  iy: number;
  halfX: number;
  halfY: number;
}

export function streetAt(wx: number, wy: number, seed: number, out: StreetInfo): void {
  const sx = nearestStreet(wx + 0.5, 0, seed);
  const sy = nearestStreet(wy + 0.5, 1, seed);
  const hx = halfWidth(sx.index);
  const hy = halfWidth(sy.index);

  const onRoadX = sx.dist <= hx;
  const onRoadY = sy.dist <= hy;

  out.dx = sx.dist;
  out.dy = sy.dist;
  out.ix = sx.index;
  out.iy = sy.index;
  out.halfX = hx;
  out.halfY = hy;
  out.road = onRoadX || onRoadY;
  out.junction = onRoadX && onRoadY;
  out.walk = !out.road && (sx.dist <= hx + WALK || sy.dist <= hy + WALK);
}

export function makeStreetInfo(): StreetInfo {
  return { road: false, walk: false, junction: false, dx: 0, dy: 0, ix: 0, iy: 0, halfX: 0, halfY: 0 };
}

// ----------------------------------------------------------------- traffic

/** Seconds in a full signal cycle at one junction. */
const SIGNAL_CYCLE = 15;
/** Share of the cycle each axis holds green; the remainder is all-red. */
const GREEN_SHARE = 0.42;

export const SIGNAL_RED = 0;
export const SIGNAL_GREEN = 1;
export const SIGNAL_AMBER = 2;

/**
 * The signal facing traffic on one axis at a junction.
 *
 * A pure function of the junction's coordinates and the clock: no state to
 * store, no lights to step, and every car approaching the same junction agrees
 * about it without having to ask anything. The phase offset per junction stops
 * the whole city turning green at once.
 */
export function signalFor(ix: number, iy: number, alongX: boolean, time: number, seed: number): number {
  const phase = ((hashi(ix, iy, seed ^ 0x51d0) % 1000) / 1000) * SIGNAL_CYCLE;
  const t = (time + phase) % SIGNAL_CYCLE;
  const green = SIGNAL_CYCLE * GREEN_SHARE;
  const amber = SIGNAL_CYCLE * 0.06;
  if (alongX) {
    if (t < green) return SIGNAL_GREEN;
    if (t < green + amber) return SIGNAL_AMBER;
    return SIGNAL_RED;
  }
  const half = SIGNAL_CYCLE * 0.5;
  if (t >= half && t < half + green) return SIGNAL_GREEN;
  if (t >= half + green && t < half + green + amber) return SIGNAL_AMBER;
  return SIGNAL_RED;
}

/** Distance to the next street line crossed travelling along `dir`, and its index. */
export function nextCrossing(
  v: number,
  dir: number,
  axis: number,
  seed: number,
): { dist: number; index: number } {
  const guess = Math.round(v / BLOCK);
  let dist = Infinity;
  let index = guess;
  for (let k = guess - 2; k <= guess + 2; k++) {
    const delta = (streetLine(k, axis, seed) - v) * dir;
    if (delta > 0 && delta < dist) {
      dist = delta;
      index = k;
    }
  }
  return { dist, index };
}

/** Index of the street line nearest a coordinate on one axis. */
export function nearestLineIndex(v: number, axis: number, seed: number): number {
  const guess = Math.round(v / BLOCK);
  let index = guess;
  let dist = Infinity;
  for (let k = guess - 1; k <= guess + 1; k++) {
    const d = Math.abs(v - streetLine(k, axis, seed));
    if (d < dist) {
      dist = d;
      index = k;
    }
  }
  return index;
}

/** The lane centre offset from a street's middle, for the given direction. */
export function laneOffset(half: number, dir: number): number {
  // Drive on the right: heading positive means the lane below/right of centre.
  return dir > 0 ? half * 0.5 : -half * 0.5;
}

// -------------------------------------------------------------------- lots

/**
 * How built-up this part of town is, 0..1. Drives building height, so towers
 * cluster into a downtown and thin out into low-rise neighbourhoods instead of
 * every block being the same.
 */
export function density(wx: number, wy: number, seed: number): number {
  return norm01(fbm2(wx * 0.0032, wy * 0.0032, seed + 4801, 3));
}

export const DISTRICT_DOWNTOWN = 0;
export const DISTRICT_RESIDENTIAL = 1;
export const DISTRICT_INDUSTRIAL = 2;

/**
 * Which kind of neighbourhood this is. Varying only building *height* leaves
 * every block the same sort of place at a different size; a district decides
 * how tall it builds, how much of it is left as open ground, and — through
 * that — how it feels to walk through.
 */
export function districtAt(wx: number, wy: number, seed: number): number {
  const n = norm01(fbm2(wx * 0.0026 + 41.3, wy * 0.0026 - 17.9, seed + 9101, 3));
  return n > 0.62 ? DISTRICT_DOWNTOWN : n > 0.28 ? DISTRICT_RESIDENTIAL : DISTRICT_INDUSTRIAL;
}

/** The lot a block-interior tile belongs to, as a stable integer pair. */
function lotOf(wx: number, wy: number, seed: number, s: StreetInfo): [number, number] {
  // Measured from the block's own edge rather than from the world origin, so
  // lots line up with the frontage instead of drifting across it.
  const edgeX = streetLine(s.ix, 0, seed) + (wx + 0.5 > streetLine(s.ix, 0, seed) ? s.halfX + WALK : -(s.halfX + WALK));
  const edgeY = streetLine(s.iy, 1, seed) + (wy + 0.5 > streetLine(s.iy, 1, seed) ? s.halfY + WALK : -(s.halfY + WALK));
  return [Math.floor((wx + 0.5 - edgeX) / LOT), Math.floor((wy + 0.5 - edgeY) / LOT)];
}

/** Ground level. Nearly flat — enough to keep the skyline from being a ruler. */
export function cityGround(spec: CityThemeSpec, wx: number, wy: number, seed: number): number {
  return (norm01(fbm2(wx * 0.0055, wy * 0.0055, seed + 61, 3)) - 0.5) * spec.amplitude;
}

// ------------------------------------------------------------------ sample

export function sampleCity(
  spec: CityThemeSpec,
  wx: number,
  wy: number,
  seed: number,
  out: CitySample,
  street: StreetInfo,
): void {
  const pal = paletteFor(spec);
  streetAt(wx, wy, seed, street);

  const ground = cityGround(spec, wx, wy, seed);

  out.storeys = 0;
  out.interior = false;
  out.sideLower = null;
  out.bandZ = 0;
  out.solid = false;
  out.water = false;
  out.depth = 0;
  out.bare = true;
  out.biome = 0;
  out.side = pal.walk;

  if (street.road) {
    out.height = ground;
    out.bed = ground;
    out.surface = pal.road;
    out.side = pal.road;

    // Markings. The carriageway runs along whichever axis the tile is *far*
    // from its street line on, so the centre line and the crossing stripes
    // both follow from the same pair of distances.
    if (!street.junction) {
      const alongX = street.dy < street.dx;
      const acrossRoad = alongX ? street.dy : street.dx;
      const alongRoad = alongX ? wx : wy;
      const halfAcross = alongX ? street.halfY : street.halfX;
      const toJunction = alongX ? street.dx : street.dy;
      const halfJunction = alongX ? street.halfX : street.halfY;

      if (toJunction < halfJunction + 2.2) {
        // A crossing just off the junction, striped across the road.
        if (((alongRoad % 2) + 2) % 2 === 0) out.surface = pal.paint;
      } else if (acrossRoad < 0.5 && ((alongRoad % 6) + 6) % 6 < 3) {
        out.surface = pal.paint;
      }
    }
    return;
  }

  if (street.walk) {
    // The kerb: a step up from the carriageway, which is most of what makes a
    // street read as a street rather than as a corridor.
    out.height = ground + 0.18;
    out.bed = out.height;
    out.surface = pal.walk;
    return;
  }

  // Inside a block. Split it into lots and put something on this one.
  const [lx, ly] = lotOf(wx, wy, seed, street);
  const key = hashi(lx * 31 + street.ix * 7, ly * 17 + street.iy * 13, seed + 555);

  const base = ground + 0.18;
  const dens = density(wx, wy, seed);
  const district = districtAt(wx, wy, seed);

  // Some lots are left open. A city with no gaps in it feels like a maze, and
  // how many are left is most of what separates a downtown from a suburb.
  const openChance = district === DISTRICT_RESIDENTIAL ? 14 : district === DISTRICT_INDUSTRIAL ? 7 : 4;
  if (key % 100 < openChance) {
    out.height = base;
    out.bed = base;
    out.surface = pal.park;
    out.bare = false;
    return;
  }

  // Height is mostly the luck of the lot, nudged by how built-up the district
  // is. Driving it from the district field alone looked reasonable in the
  // formula and produced a city of uniform height, because that field barely
  // varies across the few hundred tiles you can actually see: neighbouring
  // lots have to differ from each other, or there is no skyline.
  const roll = ((key >>> 7) % 1000) / 1000;
  const tallness = 0.45 + 0.55 * dens;

  // Towers belong downtown, and every district has a floor as well as a
  // ceiling. Without the floor the curve did almost all its work at the bottom
  // of the range: `pow(roll, 1.7)` averages about 0.37, so on a three-storey
  // cap nearly every lot rounded down to a single storey and whole
  // neighbourhoods came out uniformly one floor high. A gentler exponent and a
  // district minimum give each part of town its own band of heights instead.
  const floorStoreys =
    district === DISTRICT_DOWNTOWN ? 4 : district === DISTRICT_RESIDENTIAL ? 2 : 2;
  const cap =
    district === DISTRICT_DOWNTOWN ? spec.maxStoreys : district === DISTRICT_RESIDENTIAL ? 7 : 5;
  const storeys = floorStoreys + Math.floor(Math.pow(roll, 1.25) * tallness * (cap - floorStoreys));

  // Lots are built to their boundaries, sharing party walls the way a real
  // block does. The variation between neighbours is what reads as separate
  // buildings, not gaps between them.
  out.storeys = storeys;
  out.solid = true;
  out.interior = false;
  out.height = base + storeys * STOREY;
  out.bed = out.height;
  out.surface = pal.roof;
  out.side = pal.facades[(key >>> 13) % pal.facades.length];

  // The ground floor is its own thing: a shopfront, and on some lots a lit
  // sign over it. This is what stops a street looking like extruded blocks.
  const shopRoll = (key >>> 21) % 100;
  out.sideLower =
    shopRoll < 22 ? pal.signs[(key >>> 3) % pal.signs.length] : pal.shopfronts[(key >>> 5) % pal.shopfronts.length];
  out.bandZ = base + STOREY * 0.92;
}

// ------------------------------------------------------------------- themes

const DOWNTOWN: CityThemeSpec = {
  id: 'city',
  label: 'Endless City',
  kind: 'city',
  amplitude: 3.5,
  maxStoreys: 16,

  road: { color: '#4a4a52', pattern: 'noise', roughness: 0.3 },
  walk: { color: '#8e8e94', pattern: 'tile', roughness: 0.4 },
  facades: [
    { color: '#9a8f80', pattern: 'brick', roughness: 0.7 },
    { color: '#8a8f98', pattern: 'panel', roughness: 0.55 },
    { color: '#a89477', pattern: 'brick', roughness: 0.75 },
    { color: '#7f858e', pattern: 'panel', roughness: 0.5 },
    { color: '#9c8a86', pattern: 'brick', roughness: 0.7 },
  ],
  roof: { color: '#5e6068', pattern: 'grate', roughness: 0.5 },
  glass: { color: '#6e8ea8', pattern: 'panel', roughness: 0.25 },
  shopfronts: [
    { color: '#8fa6b8', pattern: 'panel', roughness: 0.3 },
    { color: '#7d8c98', pattern: 'grate', roughness: 0.35 },
    { color: '#9b8f7e', pattern: 'panel', roughness: 0.35 },
    { color: '#86967f', pattern: 'panel', roughness: 0.3 },
  ],
  signs: [
    { color: '#ff7a5c', pattern: 'panel', roughness: 0.2 },
    { color: '#5ad0ff', pattern: 'panel', roughness: 0.2 },
    { color: '#ffd25c', pattern: 'panel', roughness: 0.2 },
    { color: '#b98cff', pattern: 'panel', roughness: 0.2 },
    { color: '#5cff9e', pattern: 'panel', roughness: 0.2 },
  ],
  park: { color: '#5f7a52', pattern: 'noise', roughness: 0.6 },
  paint: { color: '#cdc9b4', pattern: 'solid', roughness: 0.15 },

  exposure: 1.5,
  fogColor: '#9fb0c2',
  fogDensity: 0.014,
};

export const CITY_THEMES: Record<string, CityThemeSpec> = {
  city: DOWNTOWN,
};

export function lookupCityTheme(id: string | undefined): CityThemeSpec | null {
  if (!id) return null;
  return CITY_THEMES[id] ?? null;
}

export function cityThemeIds(): string[] {
  return Object.keys(CITY_THEMES);
}

/** Placeholder so the module has a colour helper alongside the others. */
export function cityTint(a: RGB): RGB {
  return a;
}
