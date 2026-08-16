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

import type { Material } from './types.ts';
import { makeMaterial, parseColor, parsePattern, rgb } from './materials.ts';
import type { MapSourceMaterial } from './mapFormat.ts';
import { fbm2, hashi, norm01, ridge2 } from './noise.ts';

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
  road: MapSourceMaterial;
  wall: MapSourceMaterial;
  yard: MapSourceMaterial;

  /** Peak-to-trough height of the landscape, in tiles. */
  amplitude: number;
  /** Height of one terrace step in the rocky regions; also the cliff height. */
  terrace: number;

  ambient: number;
  ambientColor: string;
  exposure: number;
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
  height: number;
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
  water: Material;
  road: Material;
  wall: Material;
  yard: Material;
}

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

function paletteFor(theme: TerrainThemeSpec): Palette {
  let p = palettes.get(theme);
  if (!p) {
    p = {
      ground: theme.biomes.map((b) => mat(b.ground)),
      cliff: theme.biomes.map((b) => mat(b.cliff)),
      water: mat(theme.water),
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

/**
 * Landform height, before buildings. Kept separate so a settlement can ask
 * what the ground would have been and flatten itself onto it.
 */
export function landHeight(theme: TerrainThemeSpec, wx: number, wy: number, seed: number): number {
  // Broad shape, plus a slowly varying relief multiplier so some stretches are
  // rolling and others nearly flat.
  const base = norm01(fbm2(wx * 0.0125, wy * 0.0125, seed, 5));
  const relief = 0.35 + 1.15 * norm01(fbm2(wx * 0.0034, wy * 0.0034, seed + 77, 3));
  let h = (base - 0.5) * theme.amplitude * relief;

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

/** Height a settlement sits on: the land at the middle of its lattice cell. */
function settlementBase(theme: TerrainThemeSpec, wx: number, wy: number, seed: number): number {
  const S = 58;
  const cx = Math.floor(wx / S) * S + (S >> 1);
  const cy = Math.floor(wy / S) * S + (S >> 1);
  return landHeight(theme, cx, cy, seed);
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

  let h = landHeight(theme, wx, wy, seed);
  let surface = pal.ground[biome];
  let side = pal.cliff[biome];
  let water = false;
  let bare = false;
  let solid = false;

  // Rivers cut down through whatever the land was doing.
  const river = riverStrength(wx, wy, seed);
  if (river > 0) {
    h -= river * 1.9;
    if (river > 0.22) {
      water = true;
      bare = true;
      surface = pal.water;
    }
  }

  // Roads flatten the ground they run over: a road that follows every bump is
  // a goat track, not a road.
  const road = roadStrength(wx, wy, seed);
  if (road > 0 && !water) {
    const smooth = (fbm2(wx * 0.0105, wy * 0.0105, seed, 2) - 0.46) * theme.amplitude * 0.55;
    h += (smooth - h) * road * 0.85;
    if (road > 0.3) {
      surface = pal.road;
      bare = true;
    }
  }

  const b = buildingAt(wx, wy, seed);
  if (b !== 0) {
    const base = settlementBase(theme, wx, wy, seed);
    bare = true;
    if (b === 1) {
      h = base + 3.2;
      solid = true;
      surface = pal.wall;
      side = pal.wall;
    } else {
      h = base;
      surface = pal.yard;
    }
  }

  out.height = h;
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
      ground: { color: '#8fa863', pattern: 'noise', roughness: 0.55 },
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
      ground: { color: '#5f7a4a', pattern: 'noise', roughness: 0.65 },
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
      ground: { color: '#9a9384', pattern: 'rock', roughness: 0.75 },
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
      ground: { color: '#6d7f5c', pattern: 'noise', roughness: 0.7 },
      cliff: { color: '#6f6a5c', pattern: 'rock', roughness: 0.75 },
      trees: 0.05,
      shrubs: 0.10,
      rocks: 0.004,
      treeSprite: 'tree',
      shrubSprite: 'reeds',
      rockSprite: 'boulder',
    },
  ],
  water: { color: '#4a7fa8', pattern: 'noise', roughness: 0.25 },
  road: { color: '#9c8f76', pattern: 'noise', roughness: 0.4 },
  wall: { color: '#a89a80', pattern: 'brick', roughness: 0.7 },
  yard: { color: '#8e8570', pattern: 'tile', roughness: 0.5 },

  ambient: 0.24,
  ambientColor: '#7b93bd',
  exposure: 1.5,
  fogColor: '#9fb2c6',
  fogDensity: 0.013,
  skyTop: '#3f6ea8',
  skyHorizon: '#a8c0d6',
  stars: 0,
  sun: { x: 0.45, y: -0.35, z: 0.66, color: '#ffe8bd', intensity: 1.35 },
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
      ground: { color: '#c2a075', pattern: 'noise', roughness: 0.5 },
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
      ground: { color: '#b07a52', pattern: 'rock', roughness: 0.8 },
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
      ground: { color: '#a89865', pattern: 'noise', roughness: 0.6 },
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
      ground: { color: '#b8a887', pattern: 'noise', roughness: 0.45 },
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
  water: { color: '#5f8f9a', pattern: 'noise', roughness: 0.25 },
  road: { color: '#b09a72', pattern: 'noise', roughness: 0.35 },
  wall: { color: '#b08a62', pattern: 'brick', roughness: 0.75 },
  yard: { color: '#9c8a68', pattern: 'tile', roughness: 0.5 },

  ambient: 0.26,
  ambientColor: '#a08f7a',
  exposure: 1.45,
  fogColor: '#cdb492',
  fogDensity: 0.012,
  skyTop: '#5a7fae',
  skyHorizon: '#d8c19a',
  stars: 0,
  sun: { x: -0.4, y: -0.3, z: 0.7, color: '#ffe3a8', intensity: 1.45 },
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
