/**
 * Outdoor world generation.
 *
 * Every tile is a pure function of its absolute coordinates and the world
 * seed. Nothing is remembered between visits and nothing depends on the order
 * tiles are generated in, so the landscape is identical every time you walk
 * back to it — which the WFC dungeons cannot promise, since their solver
 * depends on what was already standing next to it.
 *
 * The landform is built in layers, each one overriding the last:
 *
 *   elevation -> terracing -> river channels -> roads -> settlements
 *
 * Terracing is what makes cliffs: quantising height to steps larger than the
 * player can climb turns a smooth slope into a sequence of unclimbable ledges.
 * Biomes deliberately do *not* change the elevation, only the surface and what
 * grows on it; deriving height from the biome puts a wall at every biome
 * border, and a landscape should not change shape because the grass changed
 * colour.
 */

import type { Material, RGB } from './types.ts';
import { makeMaterial, parseColor, parsePattern, rgb } from './materials.ts';
import type { MapSourceMaterial } from './mapFormat.ts';
import { fbm2, hashi, noise2, norm01, ridge2 } from './noise.ts';

export interface BiomeSpec {
  id: string;
  /** Surface the player walks on. */
  ground: MapSourceMaterial;
  /** Exposed vertical faces — cliff walls and the sides of ledges. */
  cliff: MapSourceMaterial;
  /** 0..1 chance per tile. */
  trees: number;
  shrubs: number;
  rocks: number;
  treeSprite: string;
  shrubSprite: string;
  rockSprite: string;
  /** Recolours this biome's sprites; omit to use the sprite's own palette. */
  tint?: string;
}

export interface TerrainThemeSpec {
  id: string;
  label: string;
  kind: 'terrain';

  biomes: BiomeSpec[];
  water: MapSourceMaterial;
  /** Colour the water surface reaches at `waterDepth` tiles down. */
  waterDeep: string;
  /** Churning white water on the vertical face of a fall. */
  falls: MapSourceMaterial;
  road: MapSourceMaterial;
  wall: MapSourceMaterial;
  yard: MapSourceMaterial;

  /** Peak-to-trough height of the landscape, in tiles. */
  amplitude: number;
  /** Height of one terrace step in the rocky regions; also the cliff height. */
  terrace: number;

  /**
   * Height of one step of the water table — so, the height of a waterfall.
   * Water is level within a step and falls between them; see `waterTable`.
   */
  pool: number;
  /**
   * How far the water table sits below the broad shape of the land. This is
   * the knob that decides how wet the world is: at 0 every shallow hollow
   * fills, and pushed far enough down only the carved river channels do.
   */
  waterOffset: number;
  /** How deep a channel a river cuts below the surrounding land. */
  riverDepth: number;
  /** Depth at which water reaches its full `waterDeep` colour. */
  waterDepth: number;

  ambient: number;
  ambientColor: string;
  exposure: number;
  /**
   * Spread of the tone curve. See `setContrast` in shading.ts — outdoors this
   * matters more than anywhere else, because a sunlit landscape has no dark
   * corners to anchor the bottom of the range.
   */
  contrast: number;
  fogColor: string;
  fogDensity: number;
  skyTop: string;
  skyHorizon: string;
  stars: number;

  /** Direction *toward* the sun, and how hard it shades the land. */
  sun: { x: number; y: number; z: number; color: string; intensity: number };
  /** Campfire-ish lights dotted around settlements. */
  torch: { radius: number; color: string; intensity: number; flicker: number };
  lantern: { radius: number; color: string; intensity: number };
}

export interface TerrainSample {
  /**
   * Top of whatever you can see: the water surface on a water tile, the ground
   * everywhere else. This is what the renderer marches against.
   */
  height: number;
  /**
   * Top of the solid ground, under any water. This is what the *legs* care
   * about, and keeping the two apart is the whole reason a lake can be level
   * while the bed beneath it is not.
   */
  bed: number;
  /** `height - bed`; 0 on dry land. */
  depth: number;
  /** Blocks movement outright: a building wall. */
  solid: boolean;
  water: boolean;
  surface: Material;
  side: Material;
  biome: number;
  /** Suppresses vegetation: roads, water, floors. */
  bare: boolean;
}

/** Resolved materials, built once per theme rather than per tile. */
interface Palette {
  ground: Material[];
  cliff: Material[];
  /**
   * Water surfaces by biome and by depth band. Depth is the thing that makes
   * water read as water rather than as blue paint, and a heightmap already
   * knows it exactly — but a material per tile would be an allocation per tile
   * per window rebuild, so it is quantised into bands instead. The banding is
   * not a compromise: at this resolution it reads as depth contours.
   */
  water: Material[][];
  falls: Material;
  road: Material;
  wall: Material;
  yard: Material;
}

/** How many depth bands the water is quantised into. */
const WATER_BANDS = 6;

const palettes = new WeakMap<TerrainThemeSpec, Palette>();

function mat(def: MapSourceMaterial, fallback = rgb(140, 140, 140)): Material {
  return makeMaterial(
    'terrain',
    parseColor(def.color, fallback),
    parsePattern(def.pattern),
    def.roughness ?? 0.6,
    def.emissive ?? 0,
  );
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return rgb(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

/**
 * The depth ramp for one biome: wet ground at the shore, the theme's water
 * colour just off it, and `waterDeep` in the middle.
 */
function waterBands(theme: TerrainThemeSpec, ground: RGB): Material[] {
  const shallow = parseColor(theme.water.color, rgb(74, 127, 168));
  const deep = parseColor(theme.waterDeep, rgb(20, 44, 74));
  const shore = mix(mix(ground, rgb(0, 0, 0), 0.3), shallow, 0.5);
  const out: Material[] = [];
  for (let i = 0; i < WATER_BANDS; i++) {
    const f = i / (WATER_BANDS - 1);
    const near = mix(shore, shallow, Math.min(1, f * 2.2));
    // Shallow water shows the bed through it, so it keeps some of the ground's
    // texture; deep water is a smooth sheet.
    out.push(makeMaterial('water', mix(near, deep, f), 'water', 0.5 - f * 0.32));
  }
  return out;
}

function paletteFor(theme: TerrainThemeSpec): Palette {
  let p = palettes.get(theme);
  if (!p) {
    p = {
      ground: theme.biomes.map((b) => mat(b.ground)),
      cliff: theme.biomes.map((b) => mat(b.cliff)),
      water: theme.biomes.map((b) => waterBands(theme, parseColor(b.ground.color, rgb(140, 140, 140)))),
      falls: mat(theme.falls),
      road: mat(theme.road),
      wall: mat(theme.wall),
      yard: mat(theme.yard),
    };
    palettes.set(theme, p);
  }
  return p;
}

/** Which biome governs this spot. Two slow fields, so regions are large. */
export function biomeAt(theme: TerrainThemeSpec, wx: number, wy: number, seed: number): number {
  const n = theme.biomes.length;
  if (n <= 1) return 0;
  const warmth = norm01(fbm2(wx * 0.0115, wy * 0.0115, seed + 11, 3));
  const damp = norm01(fbm2(wx * 0.0115 + 71.3, wy * 0.0115 - 39.1, seed + 23, 3));
  // A 2x2 split for four biomes, falling back sensibly for other counts.
  const a = warmth > 0.5 ? 1 : 0;
  const b = damp > 0.5 ? 1 : 0;
  return (a * 2 + b) % n;
}

/** Slowly varying relief multiplier: some stretches roll, others are near flat. */
function reliefAt(wx: number, wy: number, seed: number): number {
  return 0.35 + 1.15 * norm01(fbm2(wx * 0.0034, wy * 0.0034, seed + 77, 3));
}

const LAND_FREQ = 0.0125;
const LAND_OCTAVES = 5;
/** Octaves counted as the broad shape of the land; the rest is surface detail. */
const BROAD_OCTAVES = 1;
// One octave, not two. The second octave is slow enough to look smooth on its
// own, but quantising it still crosses a step every few tiles, and the result
// is a staircase of one-tile pools rather than lakes: mean pool run went from
// 6.5 tiles to 4.4 by adding it back.

/**
 * The landform's noise, split into its broad shape and its full detail.
 *
 * Water needs both. The bed follows every dip, but the *water table* has to
 * follow only the broad shape — otherwise a lake surface casts every pebble on
 * its floor and is no longer a surface at all. The split is a true low pass:
 * the fine octaves are not dropped from `broad`, they are replaced by their
 * mean, so `broad` and `full` are directly comparable and their difference is
 * exactly the surface detail.
 */
function landNoise(wx: number, wy: number, seed: number, out: { broad: number; full: number }): void {
  let amp = 1;
  let freq = 1;
  let full = 0;
  let broad = 0;
  let norm = 0;
  for (let i = 0; i < LAND_OCTAVES; i++) {
    const n = noise2(wx * LAND_FREQ * freq, wy * LAND_FREQ * freq, seed + i * 1013);
    full += n * amp;
    broad += (i < BROAD_OCTAVES ? n : 0.5) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  out.full = full / norm;
  out.broad = broad / norm;
}

const landScratch = { broad: 0, full: 0 };

/**
 * Landform height, before rivers and buildings. Kept separate so a settlement
 * can ask what the ground would have been and flatten itself onto it.
 */
export function landHeight(theme: TerrainThemeSpec, wx: number, wy: number, seed: number): number {
  landNoise(wx, wy, seed, landScratch);
  let h = (norm01(landScratch.full) - 0.5) * theme.amplitude * reliefAt(wx, wy, seed);

  // Rocky country: quantise to ledges taller than the player can step, which
  // is what turns a hillside into a cliff.
  const rocky = norm01(fbm2(wx * 0.0062 + 19.7, wy * 0.0062 + 4.2, seed + 5, 3));
  if (rocky > 0.5 && theme.terrace > 0) {
    const strength = Math.min(1, (rocky - 0.5) / 0.18);
    const stepped = Math.round(h / theme.terrace) * theme.terrace;
    h += (stepped - h) * strength;
  }
  return h;
}

/**
 * Height of the water surface over a spot, whether or not there is water there.
 *
 * This is the answer to "lakes should be level, and a height difference should
 * flow". Water used to be a colour painted on the riverbed, so its surface
 * followed every contour the bed did — a river visibly ran along the side of a
 * hill. Here the surface is its own field, and it is *quantised*: the broad
 * shape of the land, floored to `pool`-tile steps.
 *
 * Quantising a smooth field is what buys flatness for free. Every tile whose
 * broad height falls inside one step shares one surface height exactly, so a
 * body of water is level by construction rather than by relaxation — no flood
 * fill, no iteration, and still a pure function of the coordinates, which is
 * what lets the window regenerate identically when you walk back.
 *
 * Between two steps the surface drops by exactly `pool`, which is a waterfall.
 * So the two behaviours the request asked for are the same mechanism seen at
 * different places on the same field.
 */
export function waterTable(theme: TerrainThemeSpec, wx: number, wy: number, seed: number): number {
  landNoise(wx, wy, seed, landScratch);
  const broad = (norm01(landScratch.broad) - 0.5) * theme.amplitude * reliefAt(wx, wy, seed);
  return Math.floor(broad / theme.pool) * theme.pool + theme.waterOffset;
}

/** 0 outside a road, rising to 1 along its centre line. */
function roadStrength(wx: number, wy: number, seed: number): number {
  const r = ridge2(wx * 0.0088 + 13.1, wy * 0.0088 - 7.7, seed + 777, 3);
  const t = 0.955;
  return r > t ? Math.min(1, (r - t) / (1 - t)) : 0;
}

/** 0 outside a river, rising to 1 mid-channel. */
function riverStrength(wx: number, wy: number, seed: number): number {
  const r = ridge2(wx * 0.0072 - 22.5, wy * 0.0072 + 8.9, seed + 301, 3);
  const t = 0.94;
  return r > t ? Math.min(1, (r - t) / (1 - t)) : 0;
}

/**
 * Settlements, on a jittered lattice. 0 = nothing, 1 = wall, 2 = enclosed yard.
 *
 * Buildings are walled enclosures rather than roofed rooms: a heightmap has
 * exactly one surface per tile, so a tile cannot be both floor and roof. A
 * roofless compound you can walk into is the honest version of a building in
 * this model, and reads well from outside as a village silhouette.
 */
function buildingAt(wx: number, wy: number, seed: number): 0 | 1 | 2 {
  const S = 58;
  const gx = Math.floor(wx / S);
  const gy = Math.floor(wy / S);
  for (let cy = gy - 1; cy <= gy; cy++) {
    for (let cx = gx - 1; cx <= gx; cx++) {
      const h = hashi(cx, cy, seed + 4242);
      if (h % 100 >= 42) continue; // most cells have no settlement
      const ox = cx * S + (((h >>> 3) % (S - 26)) | 0);
      const oy = cy * S + (((h >>> 11) % (S - 26)) | 0);
      const count = 2 + ((h >>> 17) % 4);

      for (let b = 0; b < count; b++) {
        const bh = hashi(cx * 71 + b * 13, cy * 131 + b * 7, seed + 99);
        const bx = ox + ((bh % 20) | 0);
        const by = oy + (((bh >>> 6) % 20) | 0);
        const bw = 5 + ((bh >>> 12) % 4);
        const bd = 5 + ((bh >>> 16) % 3);
        if (wx < bx || wx >= bx + bw || wy < by || wy >= by + bd) continue;

        const onBorder = wx === bx || wx === bx + bw - 1 || wy === by || wy === by + bd - 1;
        if (!onBorder) return 2;

        // One doorway, so the enclosure can be walked into.
        const side = (bh >>> 20) % 4;
        const alongX = side === 0 || side === 1;
        const mid = alongX ? bx + (bw >> 1) : by + (bd >> 1);
        const edge = side === 0 ? by : side === 1 ? by + bd - 1 : side === 2 ? bx : bx + bw - 1;
        const isDoor = alongX ? wy === edge && wx === mid : wx === edge && wy === mid;
        return isDoor ? 2 : 1;
      }
    }
  }
  return 0;
}

/**
 * Height a settlement sits on: the land at the middle of its lattice cell,
 * lifted clear of the waterline. Nobody builds a village in a lake, and a
 * flooded courtyard reads as a bug rather than as a feature.
 */
function settlementBase(theme: TerrainThemeSpec, wx: number, wy: number, seed: number): number {
  const S = 58;
  const cx = Math.floor(wx / S) * S + (S >> 1);
  const cy = Math.floor(wy / S) * S + (S >> 1);
  const h = landHeight(theme, cx, cy, seed);
  return Math.max(h, waterTable(theme, cx, cy, seed) + 0.5);
}

/** Everything the world needs to know about one outdoor tile. */
export function sampleTerrain(
  theme: TerrainThemeSpec,
  wx: number,
  wy: number,
  seed: number,
  out: TerrainSample,
): void {
  const pal = paletteFor(theme);
  const biome = biomeAt(theme, wx, wy, seed);

  let bed = landHeight(theme, wx, wy, seed);
  let surface = pal.ground[biome];
  let side = pal.cliff[biome];
  let bare = false;
  let solid = false;
  let flooded = true;

  // Rivers cut down through whatever the land was doing. The channel is only
  // a shape in the ground now — whether there is water in it is decided at the
  // end, against the table, exactly as it is for a hollow that never saw a
  // river. One rule for all standing water is what keeps the surface level.
  const river = riverStrength(wx, wy, seed);
  if (river > 0) {
    bed -= river * theme.riverDepth;
    if (river > 0.22) bare = true;
  }

  // Roads flatten the ground they run over: a road that follows every bump is
  // a goat track, not a road.
  const road = roadStrength(wx, wy, seed);
  if (road > 0) {
    const smooth = (fbm2(wx * 0.0105, wy * 0.0105, seed, 2) - 0.46) * theme.amplitude * 0.55;
    bed += (smooth - bed) * road * 0.85;
    if (road > 0.3) {
      surface = pal.road;
      bare = true;
    }
  }

  const b = buildingAt(wx, wy, seed);
  if (b !== 0) {
    const base = settlementBase(theme, wx, wy, seed);
    bare = true;
    flooded = false; // settlements are lifted clear of the table by construction
    if (b === 1) {
      bed = base + 3.2;
      solid = true;
      surface = pal.wall;
      side = pal.wall;
    } else {
      bed = base;
      surface = pal.yard;
    }
  }

  let height = bed;
  let depth = 0;
  let water = false;

  if (flooded && !solid) {
    const table = waterTable(theme, wx, wy, seed);
    if (bed < table - 0.02) {
      water = true;
      bare = true;
      height = table;
      depth = table - bed;
      const band = Math.min(WATER_BANDS - 1, Math.floor((depth / theme.waterDepth) * WATER_BANDS));
      surface = pal.water[biome][band < 0 ? 0 : band];
      // The exposed face of a water tile is either a fall onto the pool below
      // or water spilling over a lip. Both are white water.
      side = pal.falls;
    }
  }

  out.height = height;
  out.bed = bed;
  out.depth = depth;
  out.solid = solid;
  out.water = water;
  out.surface = surface;
  out.side = side;
  out.biome = biome;
  out.bare = bare;
}

export function makeSample(): TerrainSample {
  return {
    height: 0,
    bed: 0,
    depth: 0,
    solid: false,
    water: false,
    surface: DEFAULT_SURFACE,
    side: DEFAULT_SURFACE,
    biome: 0,
    bare: false,
  };
}

const DEFAULT_SURFACE = makeMaterial('terrain', rgb(120, 130, 110), 'noise', 0.6);

// ---------------------------------------------------------------- the themes

const WILDS: TerrainThemeSpec = {
  id: 'wilds',
  label: 'Endless Wilds',
  kind: 'terrain',
  amplitude: 11,
  terrace: 0.95,
  biomes: [
    {
      id: 'meadow',
      ground: { color: '#84ab4a', pattern: 'noise', roughness: 0.55 },
      cliff: { color: '#8d8474', pattern: 'rock', roughness: 0.8 },
      trees: 0.035,
      shrubs: 0.045,
      rocks: 0.008,
      treeSprite: 'tree',
      shrubSprite: 'shrub',
      rockSprite: 'boulder',
    },
    {
      id: 'forest',
      ground: { color: '#487a33', pattern: 'noise', roughness: 0.65 },
      cliff: { color: '#7d7466', pattern: 'rock', roughness: 0.8 },
      trees: 0.15,
      shrubs: 0.04,
      rocks: 0.005,
      treeSprite: 'pine',
      shrubSprite: 'shrub',
      rockSprite: 'boulder',
    },
    {
      id: 'highland',
      ground: { color: '#9c8f6e', pattern: 'rock', roughness: 0.75 },
      cliff: { color: '#a09585', pattern: 'rock', roughness: 0.85 },
      trees: 0.022,
      shrubs: 0.025,
      rocks: 0.028,
      treeSprite: 'pine',
      shrubSprite: 'shrub',
      rockSprite: 'boulder',
    },
    {
      id: 'marsh',
      ground: { color: '#5c8449', pattern: 'noise', roughness: 0.7 },
      cliff: { color: '#6f6a5c', pattern: 'rock', roughness: 0.75 },
      trees: 0.05,
      shrubs: 0.10,
      rocks: 0.004,
      treeSprite: 'tree',
      shrubSprite: 'reeds',
      rockSprite: 'boulder',
    },
  ],
  water: { color: '#4a7fa8', pattern: 'water', roughness: 0.4 },
  waterDeep: '#132f4c',
  falls: { color: '#d6e6ee', pattern: 'noise', roughness: 0.95 },
  road: { color: '#9c8f76', pattern: 'noise', roughness: 0.4 },
  wall: { color: '#a89a80', pattern: 'brick', roughness: 0.7 },
  yard: { color: '#8e8570', pattern: 'tile', roughness: 0.5 },

  pool: 1.0,
  waterOffset: -2.2,
  riverDepth: 2.6,
  waterDepth: 2.2,

  ambient: 0.10,
  ambientColor: '#6b86b4',
  exposure: 1.9,
  contrast: 1.85,
  fogColor: '#7d95ad',
  fogDensity: 0.0062,
  // Deep overhead, pale at the horizon. A bright even sky is a third of an
  // outdoor frame spent on one glyph, and it flattens the land it sits over.
  skyTop: '#14355c',
  skyHorizon: '#8ea8bf',
  stars: 0,
  // Low, not overhead. A heightmap's surfaces are nearly all horizontal, so a
  // high sun gives every one of them the same n.L and the landform vanishes
  // into a flat wash — measurably: at 50 degrees a 15-degree slope was only
  // 1.6x brighter than one tilted away from the sun, and at 22 degrees it is
  // over 6x. Long light is what makes a landscape read.
  sun: { x: 0.73, y: -0.57, z: 0.375, color: '#ffe3b0', intensity: 1.9 },
  torch: { radius: 7, color: '#ffb060', intensity: 1.5, flicker: 0.35 },
  lantern: { radius: 4.5, color: '#ffd0a0', intensity: 0.25 },
};

const BADLANDS: TerrainThemeSpec = {
  id: 'badlands',
  label: 'Endless Badlands',
  kind: 'terrain',
  amplitude: 14,
  terrace: 1.35,
  biomes: [
    {
      id: 'flats',
      ground: { color: '#cda05a', pattern: 'noise', roughness: 0.5 },
      cliff: { color: '#a87350', pattern: 'brick', roughness: 0.85 },
      trees: 0.008,
      shrubs: 0.04,
      rocks: 0.018,
      treeSprite: 'pine',
      shrubSprite: 'shrub',
      rockSprite: 'boulder',
      tint: '#9c9a63',
    },
    {
      id: 'mesa',
      ground: { color: '#bc6f36', pattern: 'rock', roughness: 0.8 },
      cliff: { color: '#9c5f3e', pattern: 'brick', roughness: 0.9 },
      trees: 0.004,
      shrubs: 0.02,
      rocks: 0.03,
      treeSprite: 'pine',
      shrubSprite: 'shrub',
      rockSprite: 'boulder',
      tint: '#a08a56',
    },
    {
      id: 'scrub',
      ground: { color: '#b09a44', pattern: 'noise', roughness: 0.6 },
      cliff: { color: '#96704a', pattern: 'rock', roughness: 0.85 },
      trees: 0.01,
      shrubs: 0.07,
      rocks: 0.02,
      treeSprite: 'tree',
      shrubSprite: 'shrub',
      rockSprite: 'boulder',
      tint: '#8f9457',
    },
    {
      id: 'wash',
      ground: { color: '#c4a870', pattern: 'noise', roughness: 0.45 },
      cliff: { color: '#9a7c58', pattern: 'rock', roughness: 0.8 },
      trees: 0.006,
      shrubs: 0.05,
      rocks: 0.012,
      treeSprite: 'tree',
      shrubSprite: 'reeds',
      rockSprite: 'boulder',
      tint: '#94975e',
    },
  ],
  water: { color: '#5f8f9a', pattern: 'water', roughness: 0.4 },
  waterDeep: '#1b4048',
  falls: { color: '#e2e8e0', pattern: 'noise', roughness: 0.95 },
  road: { color: '#b09a72', pattern: 'noise', roughness: 0.35 },
  wall: { color: '#b08a62', pattern: 'brick', roughness: 0.75 },
  yard: { color: '#9c8a68', pattern: 'tile', roughness: 0.5 },

  pool: 1.35,
  waterOffset: -2.8,
  riverDepth: 2.8,
  waterDepth: 2.0,

  ambient: 0.11,
  ambientColor: '#8c7f70',
  exposure: 1.15,
  contrast: 1.9,
  fogColor: '#a88d68',
  fogDensity: 0.0058,
  skyTop: '#1e3f6b',
  skyHorizon: '#bd9a6a',
  stars: 0,
  sun: { x: -0.73, y: -0.55, z: 0.41, color: '#ffdb98', intensity: 2.0 },
  torch: { radius: 7, color: '#ffb060', intensity: 1.5, flicker: 0.35 },
  lantern: { radius: 4.5, color: '#ffd0a0', intensity: 0.25 },
};

export const TERRAIN_THEMES: Record<string, TerrainThemeSpec> = {
  wilds: WILDS,
  badlands: BADLANDS,
};

export function lookupTerrainTheme(id: string | undefined): TerrainThemeSpec | null {
  if (!id) return null;
  return TERRAIN_THEMES[id] ?? null;
}

export function terrainThemeIds(): string[] {
  return Object.keys(TERRAIN_THEMES);
}
