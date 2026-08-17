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
/** Tiles of frontage between one way into a building and the next. */
const DOOR_EVERY = 6;
/**
 * Cells of a lot between internal partitions. At LOT 11 this puts one wall on
 * each axis and leaves four rooms of four tiles square — small enough to read
 * as rooms and big enough to stand a few things in.
 */
const ROOM_PITCH = 5;
/**
 * Tiles in one flight of stairs.
 *
 * Set by the step the legs can make, not by taste: a flight climbs a whole
 * STOREY, so a run of N tiles has treads STOREY/N apart and anything that puts
 * that over STEP_HEIGHT is a staircase you cannot walk up. At STOREY 3.4 and a
 * step of 0.55 the shortest legal run is seven; nine leaves margin and lands
 * neatly inside a lot, which is eleven cells across with a wall at each end.
 */
export const STAIR_RUN = 9;
/**
 * Which row of a lot the stairs run along. Not the row against the outside
 * wall, which is where it went first: an opening cut in that wall then lands
 * on a tread part way up a flight, which is a step no legs can make, and the
 * building is sealed. A cell in leaves a corridor along the frontage for the
 * door to open into and for the flight to be reached from.
 */
const STAIR_ROW = 2;

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
  /** Inside a building: the floor underfoot, the slab overhead, its rim. */
  interiorFloor: MapSourceMaterial;
  interiorCeiling: MapSourceMaterial;
  interiorWall: MapSourceMaterial;
  /** Stair treads. Their own material, so a flight reads as a flight. */
  tread: MapSourceMaterial;

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
  /** Position along a flight of stairs, 1-based; 0 for anything else. */
  stair: number;
  /** Surface of a floor inside the column, where that is not its top. */
  innerFloor: Material | null;
  /**
   * Underside of whatever is overhead. Open ground has no ceiling and never
   * asks for this; a room does, and it is not the same surface as its roof.
   */
  ceiling: Material;
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
    stair: 0,
    innerFloor: null,
    ceiling: DEFAULT_ROAD,
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
  interiorFloor: Material;
  interiorCeiling: Material;
  interiorWall: Material;
  tread: Material;
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
      interiorFloor: mat(spec.interiorFloor),
      interiorCeiling: mat(spec.interiorCeiling),
      interiorWall: mat(spec.interiorWall),
      tread: mat(spec.tread),
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
 * The nearest street line to `v`, and how far away it is, left in `nsIndex`
 * and `nsDist`. Only the three candidate indices around `v` can possibly be
 * nearest, since the jitter is bounded well below the spacing.
 *
 * Answering through a pair of module variables rather than a returned object
 * is the difference between allocating nothing and allocating twice per tile:
 * classifying a building's tiles asks its four neighbours which lot they are
 * in, so this now runs ten times per tile of a window rather than twice.
 */
let nsIndex = 0;
let nsDist = 0;
function nearestStreet(v: number, axis: number, seed: number): void {
  const guess = Math.round(v / BLOCK);
  nsIndex = guess;
  nsDist = Infinity;
  for (let k = guess - 1; k <= guess + 1; k++) {
    const d = Math.abs(v - streetLine(k, axis, seed));
    if (d < nsDist) {
      nsDist = d;
      nsIndex = k;
    }
  }
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
  nearestStreet(wx + 0.5, 0, seed);
  const ix = nsIndex;
  const dx = nsDist;
  nearestStreet(wy + 0.5, 1, seed);
  const iy = nsIndex;
  const dy = nsDist;
  const hx = halfWidth(ix);
  const hy = halfWidth(iy);

  const onRoadX = dx <= hx;
  const onRoadY = dy <= hy;

  out.dx = dx;
  out.dy = dy;
  out.ix = ix;
  out.iy = iy;
  out.halfX = hx;
  out.halfY = hy;
  out.road = onRoadX || onRoadY;
  out.junction = onRoadX && onRoadY;
  out.walk = !out.road && (dx <= hx + WALK || dy <= hy + WALK);
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

/** Returned by `lotIdAt` for anything that is street rather than block. */
export const LOT_STREET = 0;

/**
 * Which lot a tile belongs to, as a stable nonzero key, or `LOT_STREET` on a
 * carriageway or a pavement.
 *
 * This is what decides a building's walls from its inside, and it decides it
 * by asking the four neighbours rather than from the lot's rectangle. The
 * rectangle looks like it should be enough — a lot is LOT tiles square, so the
 * inside is everything but the outermost ring — and it is wrong in the one
 * place it matters. Lots are measured from whichever street is *nearer*, so a
 * block is subdivided from both edges at once and the two grids meet somewhere
 * in the middle. The last lot on each side is whatever width is left over, its
 * far edge is not a lot boundary, and every tile along that seam passes the
 * rectangle test while its neighbour across the seam belongs to a different
 * building. Hollowing those opens a hole between two buildings that would then
 * share one interior at two different ceiling heights.
 *
 * Asking the neighbour for its lot key gets that right by construction, and
 * needs no district or density noise: a lot is uniformly built or open, so two
 * tiles of the same lot are always both built.
 */
export function lotIdAt(wx: number, wy: number, seed: number): number {
  const cx = wx + 0.5;
  const cy = wy + 0.5;
  nearestStreet(cx, 0, seed);
  const ix = nsIndex;
  const dx = nsDist;
  nearestStreet(cy, 1, seed);
  const iy = nsIndex;
  const dy = nsDist;
  const hx = halfWidth(ix);
  const hy = halfWidth(iy);
  if (dx <= hx + WALK || dy <= hy + WALK) return LOT_STREET;

  const lineX = streetLine(ix, 0, seed);
  const lineY = streetLine(iy, 1, seed);
  const edgeX = lineX + (cx > lineX ? hx + WALK : -(hx + WALK));
  const edgeY = lineY + (cy > lineY ? hy + WALK : -(hy + WALK));
  const lx = Math.floor((cx - edgeX) / LOT);
  const ly = Math.floor((cy - edgeY) / LOT);
  // Same expression as the lot key in sampleCity, forced nonzero so it can
  // never collide with LOT_STREET.
  return hashi(lx * 31 + ix * 7, ly * 17 + iy * 13, seed + 555) | 1;
}

/**
 * Where a tile sits in its lot: which lot, and which cell of it.
 *
 * The lot indices are what identifies a building; the cell indices are what
 * the inside is laid out on. Both fall out of the same pair of divisions, so
 * they are answered together through module variables rather than as an
 * allocated tuple — this runs once per tile of every window rebuild.
 */
let lotX = 0;
let lotY = 0;
let cellX = 0;
let cellY = 0;
function lotOf(wx: number, wy: number, seed: number, s: StreetInfo): void {
  // Measured from the block's own edge rather than from the world origin, so
  // lots line up with the frontage instead of drifting across it.
  const edgeX = streetLine(s.ix, 0, seed) + (wx + 0.5 > streetLine(s.ix, 0, seed) ? s.halfX + WALK : -(s.halfX + WALK));
  const edgeY = streetLine(s.iy, 1, seed) + (wy + 0.5 > streetLine(s.iy, 1, seed) ? s.halfY + WALK : -(s.halfY + WALK));
  const u = wx + 0.5 - edgeX;
  const v = wy + 0.5 - edgeY;
  lotX = Math.floor(u / LOT);
  lotY = Math.floor(v / LOT);
  // The lot edge does not land on a tile boundary, so this is the *count* of
  // whole tiles from it — 0 to LOT-1, each value taken exactly once per lot.
  cellX = Math.floor(u - lotX * LOT);
  cellY = Math.floor(v - lotY * LOT);
}

/**
 * Is this cell of a lot a partition wall rather than floor?
 *
 * Walls run along every ROOM_PITCH-th cell of the lot, and each stretch of
 * wall between two crossings is pierced once. The doorway's position is hashed
 * from the lot, the wall's line and which stretch of it this is, so it is the
 * same answer for every tile of that stretch without anything having to walk
 * along it — which is what keeps the whole layout a pure function of position.
 *
 * A crossing itself is never a doorway. Two walls meeting is a corner post,
 * and knocking it out joins four rooms into a pinwheel with a pillar missing.
 */
function partition(cx: number, cy: number, key: number): boolean {
  // The strip alongside the stairs is a landing, and runs the lot's full width
  // rather than being cut in two by the partition that crosses it. Splitting
  // it is what made a building unreachable: the landing meets the rooms only
  // at the foot of the flight, so a door opening into the half without the
  // foot in it led to a dead end and everything past it was sealed.
  if (cy === STAIR_ROW - 1 && cx >= 1 && cx <= STAIR_RUN) return false;

  const onX = cx % ROOM_PITCH === 0;
  const onY = cy % ROOM_PITCH === 0;
  if (!onX && !onY) return false;
  if (onX && onY) return true;

  if (onX) {
    const seg = Math.floor(cy / ROOM_PITCH);
    const door = 1 + (hashi(cx, seg, key ^ 0x5eed) % (ROOM_PITCH - 1));
    return cy % ROOM_PITCH !== door;
  }
  const seg = Math.floor(cx / ROOM_PITCH);
  const door = 1 + (hashi(seg, cy, key ^ 0x1d0a) % (ROOM_PITCH - 1));
  return cx % ROOM_PITCH !== door;
}

/**
 * Is this the tile a room hangs its lamp from?
 *
 * One per room, found from the lot's own lattice rather than from a lattice
 * laid over the world. A world lattice was what lit the buildings when a
 * footprint was one big room, and partitions broke it: rooms are four tiles
 * square, a spacing-six lattice has one point per thirty-six tiles, and better
 * than half of all rooms came out with no lamp anywhere in them. Which rooms
 * were dark then depended on where the lot happened to fall, which is exactly
 * the sort of thing that looks like a renderer bug.
 */
export function isRoomLamp(wx: number, wy: number, seed: number, s: StreetInfo): boolean {
  streetAt(wx, wy, seed, s);
  if (s.road || s.walk) return false;
  lotOf(wx, wy, seed, s);
  const mid = ROOM_PITCH >> 1;
  return cellX % ROOM_PITCH === mid && cellY % ROOM_PITCH === mid;
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
  out.stair = 0;
  out.innerFloor = null;
  out.ceiling = pal.roof;
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
  lotOf(wx, wy, seed, street);
  const lx = lotX;
  const ly = lotY;
  const cx = cellX;
  const cy = cellY;
  const key = hashi(lx * 31 + street.ix * 7, ly * 17 + street.iy * 13, seed + 555);

  // A building stands on one level, taken at the middle of its lot rather
  // than under each tile. Following the ground per tile tilts every floor and
  // every roof by however much the land moves across a lot — small enough to
  // pass unnoticed until stairs, where the top of a flight then misses the
  // slab it is supposed to land on by most of a step.
  const base = cityGround(spec, wx - cx + (LOT >> 1), wy - cy + (LOT >> 1), seed) + 0.18;
  const dens = density(wx, wy, seed);
  const district = districtAt(wx, wy, seed);

  // Some lots are left open. A city with no gaps in it feels like a maze, and
  // how many are left is most of what separates a downtown from a suburb.
  const openChance = district === DISTRICT_RESIDENTIAL ? 14 : district === DISTRICT_INDUSTRIAL ? 7 : 4;
  if (key % 100 < openChance) {
    // An open lot is ground, not a building, so it keeps the land's own shape.
    out.height = ground + 0.18;
    out.bed = out.height;
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
  out.ceiling = pal.roof;
  out.side = pal.facades[(key >>> 13) % pal.facades.length];

  // The ground floor is its own thing: a shopfront, and on some lots a lit
  // sign over it. This is what stops a street looking like extruded blocks.
  const shopRoll = (key >>> 21) % 100;
  out.sideLower =
    shopRoll < 22 ? pal.signs[(key >>> 3) % pal.signs.length] : pal.shopfronts[(key >>> 5) % pal.shopfronts.length];
  out.bandZ = base + STOREY * 0.92;

  // ---- wall or inside?
  //
  // A tile is inside the building when all four of its neighbours are the same
  // lot; anything with a neighbour elsewhere is a wall. Two adjacent built lots
  // therefore each keep their own wall and the party wall comes out two tiles
  // thick, which is what stops a whole block from becoming one room.
  const mine = key | 1;
  const nW = lotIdAt(wx - 1, wy, seed);
  const nE = lotIdAt(wx + 1, wy, seed);
  const nN = lotIdAt(wx, wy - 1, seed);
  const nS = lotIdAt(wx, wy + 1, seed);

  // ---- the stairs
  //
  // One flight per storey, all running the same way, along a single row just
  // inside the wall. Every tile of the run carries a tread at the same
  // fraction of the way up *every* storey, so the treads over one tile sit a
  // whole storey apart and there is room to stand between them.
  //
  // The obvious alternative — a switchback, with the next flight starting
  // where the last one finished — cannot be built out of tiles this way. Its
  // treads over a given tile end up STOREY/N apart at the turn, which is a
  // staircase with no headroom at exactly the point you have to walk under it.
  // Running every flight the same way means walking back along each floor to
  // start the next one, which is what a straight-run stair core does anyway.
  const alongRun = cy === STAIR_ROW && cx >= 1 && cx <= STAIR_RUN;
  if (alongRun && storeys >= 2) {
    // Only where the whole run is this building. A lot clipped short by its
    // block would otherwise get a flight that stops in a wall.
    const first = wx - cx + 1;
    const last = wx - cx + STAIR_RUN;
    if (lotIdAt(first, wy, seed) === (key | 1) && lotIdAt(last, wy, seed) === (key | 1)) {
      // Which end is the bottom is the lot's own business, so neighbouring
      // buildings do not all climb the same way.
      const up = ((key >>> 23) & 1) === 1;
      out.stair = up ? cx : STAIR_RUN + 1 - cx;
    }
  }

  // Whether this tile is a wall of the *inside* rather than of the outside,
  // which decides which skin it wears: brick and a shopfront belong on a
  // frontage, and putting them on a partition papers the sitting room in them.
  let inner = false;

  if (nW === mine && nE === mine && nN === mine && nS === mine) {
    // Inside. One big room the size of the footprint reads as a warehouse
    // whatever is standing in it, so the footprint is divided on a lattice
    // measured from the lot's own edge: a partition every ROOM_PITCH cells,
    // which for a full lot is one line on each axis and four rooms.
    inner = true;
    // A stair overrides the partition lattice it crosses: the run is nine
    // cells and a room is four, so it has to pass through one.
    out.interior = out.stair > 0 || !partition(cx, cy, key);
  } else {
    // A way in. The opening goes in a wall with the street on exactly one side
    // and more of this building on the other, so it always leads somewhere and
    // is never cut into a corner.
    //
    // Its position is taken modulo a spacing rather than measured along the
    // lot, because a lot's frontage is not the lot's width: blocks are
    // subdivided from both edges and the leftover lot in the middle is
    // whatever fits. At one opening per lot width, a short frontage could miss
    // its only slot and the building came out sealed — a fifth of them did.
    // Every DOOR_EVERY tiles instead, which is about two to a full frontage
    // and is what a parade of shops looks like anyway.
    const faces = (nW === LOT_STREET ? 1 : 0) + (nE === LOT_STREET ? 1 : 0) + (nN === LOT_STREET ? 1 : 0) + (nS === LOT_STREET ? 1 : 0);
    if (faces === 1) {
      const alongX = nN === LOT_STREET || nS === LOT_STREET;
      const behind = alongX ? (nN === LOT_STREET ? nS : nN) : nW === LOT_STREET ? nE : nW;
      const along = alongX ? wx : wy;
      // Where the room behind the opening is, in lot cells. A door cut where
      // that lands on a partition opens into a one-tile alcove, so the slot is
      // skipped rather than the wall moved: the frontage has another along.
      const inX = cx + (alongX ? 0 : nW === LOT_STREET ? 1 : -1);
      const inY = cy + (alongX ? (nN === LOT_STREET ? 1 : -1) : 0);
      const ontoStair = inY === STAIR_ROW && inX >= 1 && inX <= STAIR_RUN;
      if (
        behind === mine &&
        !partition(inX, inY, key) &&
        !ontoStair &&
        (((along % DOOR_EVERY) + DOOR_EVERY) % DOOR_EVERY) === (key >>> 17) % DOOR_EVERY
      ) {
        out.interior = true;
      }
    }
  }

  if (out.interior || inner) {
    // Anything the inside can see is finished as inside. No shopfront on a
    // partition or a slab rim either: the band is a thing the *outside* of a
    // building has, and applying it in here paints the sitting room with a
    // lit sign.
    out.ceiling = pal.interiorCeiling;
    out.side = pal.interiorWall;
    out.sideLower = null;
    out.bandZ = 0;
  }

  if (out.interior) {
    // Standing room. `height` stays the roof, because that is what the column
    // tops out at and what the spans are derived from; `bed` is the floor you
    // actually walk on, which is what collision and the eye ride.
    out.solid = false;
    // `surface` is the top of the column and stays the roof: seen from a
    // taller building next door, a hollowed one was coming out with its
    // middle in floorboards and only its wall ring in roofing.
    out.innerFloor = out.stair > 0 ? pal.tread : pal.interiorFloor;
    out.bed = out.stair > 0 ? base + (out.stair / STAIR_RUN) * STOREY : base;
  } else {
    out.stair = 0;
  }
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
  // Inside. Darker than the street, which is the opposite of what it looks
  // like it should be. A room is lit by one lamp against an ambient set for
  // open air, so with a light surface the ambient alone carries most of the
  // frame and everything lands in the same narrow band — measured at a p10 to
  // p90 of 0.28 to 0.48, which is a wash. Darker here and a stronger lamp puts
  // the range back into the falloff, where it reads as a pool of light.
  interiorFloor: { color: '#7a6e60', pattern: 'tile', roughness: 0.35 },
  interiorCeiling: { color: '#857f77', pattern: 'panel', roughness: 0.25 },
  interiorWall: { color: '#80796e', pattern: 'panel', roughness: 0.4 },
  // Treads are lighter than the floor they rise from, so a flight reads as a
  // flight rather than as a stepped lump of the same room.
  tread: { color: '#96897a', pattern: 'planks', roughness: 0.45 },

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
