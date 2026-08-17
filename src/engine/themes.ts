/**
 * World types for the infinite generator.
 *
 * A theme is mostly a block of ASCII art. WFC learns the local structure of
 * that art and emits more of it forever; everything else here is the same
 * material/legend vocabulary a hand-written map uses. Adding a world type
 * means drawing a new sample, not writing new code.
 *
 * Drawing a good sample is its own skill. What matters most:
 *  - Draw the *structure*, not a picture. Corridor widths, wall thicknesses
 *    and junction shapes are what the model actually learns.
 *  - Keep openings generous. WFC has no notion of connectivity, so narrow,
 *    rare passages become sealed pockets once it improvises.
 *  - Repeat each motif a few times. A shape that appears once is rare in the
 *    output and tends to appear malformed.
 */

import type { MapSourceLegend, MapSourceMaterial } from './mapFormat.ts';

export interface ThemeTorch {
  /** Roughly one torch per this many tiles, each way. */
  spacing: number;
  radius: number;
  color: string;
  intensity: number;
  flicker: number;
}

export interface ThemeProp {
  sprite: string;
  /** Chance per candidate floor tile, 0..1. */
  chance: number;
}

/**
 * A dim light carried by the player.
 *
 * Fixed maps are authored so that everywhere worth standing is lit. A world
 * that generates forever cannot promise that, and walking into an unlit
 * stretch of an endless dungeon means staring at nothing at all. Keep it weak:
 * it exists so the near walls read, not to light the room.
 */
export interface ThemeLantern {
  radius: number;
  color: string;
  intensity: number;
}

export interface Theme {
  id: string;
  label: string;
  /** Sample art the generator learns from. */
  sample: string[];
  /** Pattern size. 3 captures corridor width and wall thickness; 2 is mushier. */
  n: number;
  /** Character used if the solver has to give up: must be solid. */
  fallback: string;
  /** Character the generator guarantees around the spawn point. */
  open: string;

  materials: Record<string, MapSourceMaterial>;
  legend: Record<string, MapSourceLegend>;

  ambient: number;
  ambientColor: string;
  exposure: number;
  /** Spread of the tone curve; see `setContrast` in shading.ts. */
  contrast: number;
  fogColor: string;
  fogDensity: number;
  skyTop?: string;
  skyHorizon?: string;
  stars?: number;

  torch: ThemeTorch;
  lantern: ThemeLantern;
  props: ThemeProp[];
}

const CATACOMBS: Theme = {
  id: 'catacombs',
  label: 'Endless Catacombs',
  n: 3,
  fallback: '#',
  open: '.',
  // Chambers and halls rather than a tight maze: a 1-wide labyrinth solves
  // only about half the time at n=3 and is claustrophobic to actually walk.
  sample: [
    '######################',
    '#....#........#......#',
    '#....#..####..#..##..#',
    '#.......#..#.....##..#',
    '#....#..#..#..#......#',
    '#..###..####..###..###',
    '#....................#',
    '#..####......####....#',
    '#..#..#..###..#..#...#',
    '#..#..#..#.#..#..#...#',
    '#..####..#.#..####...#',
    '#........#.#.........#',
    '#..####..###..####...#',
    '#....................#',
    '######################',
  ],
  materials: {
    brick: { color: '#b08a68', pattern: 'brick', roughness: 0.8 },
    floor: { color: '#7d8496', pattern: 'tile', roughness: 0.5 },
    ceil: { color: '#5a6172', pattern: 'panel', roughness: 0.35 },
  },
  legend: {
    '#': { wall: 'brick', floor: 'floor', ceiling: 'ceil' },
    '.': { floor: 'floor', ceiling: 'ceil' },
  },
  ambient: 0.09,
  ambientColor: '#3d4f70',
  exposure: 4.2,
  contrast: 1.9,
  fogColor: '#0e1420',
  fogDensity: 0.05,
  // Spread out and kept short: overlapping pools wash the whole place out,
  // and the dark stretch between two torches is what sells the depth.
  torch: { spacing: 11, radius: 6, color: '#ffc890', intensity: 2.0, flicker: 0.26 },
  lantern: { radius: 5, color: '#ffb877', intensity: 0.75 },
  props: [
    { sprite: 'barrel', chance: 0.035 },
    { sprite: 'crate', chance: 0.03 },
    { sprite: 'pillar', chance: 0.02 },
  ],
};

const CAVERNS: Theme = {
  id: 'caverns',
  label: 'Endless Caverns',
  n: 3,
  fallback: '#',
  open: '.',
  sample: [
    '######################',
    '####.....####....#####',
    '##.........##......###',
    '#...................##',
    '#....####.......###..#',
    '##..######.....#####.#',
    '###..####...#..####..#',
    '###...##...###..##...#',
    '##.........###.......#',
    '#....,,......#.......#',
    '#...,,,,.....#...##..#',
    '##...,,.....##..####.#',
    '###.........##...##..#',
    '#####.......#........#',
    '#...##.....##........#',
    '#....##...####.....###',
    '##.................###',
    '######################',
  ],
  materials: {
    rock: { color: '#9aa3ae', pattern: 'rock', roughness: 0.85 },
    grit: { color: '#6e7382', pattern: 'noise', roughness: 0.7 },
    low: { color: '#4e5460', pattern: 'rock', roughness: 0.5 },
  },
  legend: {
    '#': { wall: 'rock', floor: 'grit', ceiling: 'low' },
    '.': { floor: 'grit', ceiling: 'low' },
    // Collapsed roof: a shaft of night sky in the middle of the cave.
    ',': { floor: 'grit', sky: true },
  },
  ambient: 0.1,
  ambientColor: '#46608e',
  exposure: 2.2,
  contrast: 2.0,
  fogColor: '#0c111c',
  fogDensity: 0.055,
  skyTop: '#050912',
  skyHorizon: '#1e2c4a',
  stars: 0.7,
  torch: { spacing: 13, radius: 6, color: '#8fd8c4', intensity: 1.9, flicker: 0.15 },
  lantern: { radius: 5.5, color: '#a8e0d0', intensity: 0.7 },
  props: [
    { sprite: 'plant', chance: 0.04 },
    { sprite: 'monolith', chance: 0.02 },
    { sprite: 'pillar', chance: 0.02 },
  ],
};

const STATION: Theme = {
  id: 'station',
  label: 'Endless Station',
  n: 3,
  fallback: '#',
  open: '.',
  // Repeated bays hung off wide spines. Highly regular, which is both the
  // right look for a station and what makes it solve every time.
  sample: [
    '########################',
    '#......................#',
    '#......................#',
    '#.####.####.####.####..#',
    '#.#..#.#..#.#..#.#..#..#',
    '#.#..#.#..#.#..#.#..#..#',
    '#.####.####.####.####..#',
    '#......................#',
    '#......................#',
    '#.####.####.####.####..#',
    '#.#..#.#..#.#..#.#..#..#',
    '#.#..#.#..#.#..#.#..#..#',
    '#.####.####.####.####..#',
    '#......................#',
    '#......................#',
    '########################',
  ],
  materials: {
    panel: { color: '#8f9dad', pattern: 'panel', roughness: 0.6 },
    deck: { color: '#767d8d', pattern: 'grate', roughness: 0.45 },
    roof: { color: '#5b6373', pattern: 'panel', roughness: 0.4 },
  },
  legend: {
    '#': { wall: 'panel', floor: 'deck', ceiling: 'roof' },
    '.': { floor: 'deck', ceiling: 'roof' },
  },
  ambient: 0.12,
  ambientColor: '#4a6a94',
  exposure: 1.5,
  contrast: 1.9,
  fogColor: '#0d1520',
  fogDensity: 0.045,
  // A station reads as evenly lit, so its lamps sit closer together than the
  // other themes' — but still far enough apart to leave shadow between bays.
  torch: { spacing: 11, radius: 6.5, color: '#bcd8ff', intensity: 1.7, flicker: 0 },
  lantern: { radius: 5, color: '#cfe4ff', intensity: 0.6 },
  props: [
    { sprite: 'crate', chance: 0.05 },
    { sprite: 'barrel', chance: 0.03 },
    { sprite: 'drone', chance: 0.012 },
  ],
};

export const THEMES: Record<string, Theme> = {
  catacombs: CATACOMBS,
  caverns: CAVERNS,
  station: STATION,
};

export function lookupTheme(id: string | undefined): Theme | null {
  if (!id) return null;
  return THEMES[id] ?? null;
}

export function themeIds(): string[] {
  return Object.keys(THEMES);
}
