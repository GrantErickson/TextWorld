/**
 * The authored map format.
 *
 * The design goal is that a useful map is a block of ASCII art plus a legend,
 * and everything else has a sane default. `{ "grid": ["###", "#.#", "###"] }`
 * is a complete, valid world.
 */

export interface MapSourceMaterial {
  color?: string;
  pattern?: string;
  roughness?: number;
  emissive?: number;
}

export interface MapSourceLegend {
  /** Material id for a solid wall tile. */
  wall?: string;
  /** Material id for a door tile (implies the tile is a door). */
  door?: string;
  /** Door opens on approach instead of needing E. */
  auto?: boolean;
  /** Material ids for the open-tile surfaces. */
  floor?: string;
  ceiling?: string;
  /** Open to the sky: no ceiling is drawn. */
  sky?: boolean;
}

export interface MapSourceLight {
  x: number;
  y: number;
  radius?: number;
  color?: string;
  intensity?: number;
  flicker?: number;
}

export interface MapSourceEntity {
  sprite: string;
  x: number;
  y: number;
  speed?: number;
  bob?: number;
  path?: Array<[number, number]>;
  light?: Omit<MapSourceLight, 'x' | 'y'>;
}

/** Replaces `grid` with an endlessly generated world. */
export interface MapSourceGenerate {
  theme: string;
  seed?: number;
}

export interface MapSource {
  name?: string;
  /** Omitted when `generate` is present. */
  grid: string[];
  generate?: MapSourceGenerate;
  spawn?: { x: number; y: number; angle?: number };
  /** Base light level with nothing else illuminating a surface, 0..1. */
  ambient?: number;
  ambientColor?: string;
  fog?: { color?: string; density?: number };
  sky?: { top?: string; horizon?: string; stars?: number };
  /** Tone-mapping exposure; higher is brighter overall. */
  exposure?: number;
  /**
   * Spread of the tone curve, applied after exposure. 1 is the plain curve;
   * above 1 deepens shadow and lifts highlight. Interiors want roughly
   * 1.4–1.8. Raise `exposure` alongside it — they pull opposite ways.
   */
  contrast?: number;
  materials?: Record<string, MapSourceMaterial>;
  legend?: Record<string, MapSourceLegend>;
  lights?: MapSourceLight[];
  entities?: MapSourceEntity[];
}

export class MapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapError';
  }
}

function fail(message: string): never {
  throw new MapError(message);
}

/**
 * Parse and validate authored map text. Throws MapError with a message meant
 * to be shown directly to whoever is editing the map.
 */
export function parseMapSource(text: string): MapSource {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`Not valid JSON — ${msg}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('Top level must be a JSON object.');
  }
  const src = raw as Record<string, unknown>;

  // A generated world supplies its own terrain, so "grid" is not required —
  // but everything else in the format still applies on top of the theme.
  if (src.generate !== undefined) {
    const g = src.generate as Record<string, unknown>;
    if (typeof g !== 'object' || g === null || Array.isArray(g)) {
      fail('"generate" must be an object like { "theme": "catacombs", "seed": 7 }.');
    }
    if (typeof g.theme !== 'string') fail('"generate" needs a "theme" name.');
    if (g.seed !== undefined && typeof g.seed !== 'number') fail('"generate.seed" must be a number.');

    const gen: MapSource = {
      grid: [],
      generate: { theme: g.theme as string, seed: g.seed as number | undefined },
    };
    applyCommon(src, gen);
    return gen;
  }

  if (!Array.isArray(src.grid)) fail('"grid" is required and must be an array of strings.');
  const gridIn = src.grid as unknown[];
  if (gridIn.length === 0) fail('"grid" must contain at least one row.');
  const grid: string[] = [];
  for (let i = 0; i < gridIn.length; i++) {
    const row = gridIn[i];
    if (typeof row !== 'string') fail(`"grid" row ${i} is a ${typeof row}; every row must be a string.`);
    grid.push(row as string);
  }

  // Ragged rows are convenient to author and harmless: pad to the widest.
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  if (width < 3 || grid.length < 3) fail('"grid" must be at least 3x3.');
  for (let i = 0; i < grid.length; i++) grid[i] = grid[i].padEnd(width, ' ');

  const out: MapSource = { grid };
  applyCommon(src, out);
  return out;
}

/**
 * The optional fields, shared by authored and generated maps. A generated
 * world takes its look from its theme, and anything set here overrides it.
 */
function applyCommon(src: Record<string, unknown>, out: MapSource): void {
  if (typeof src.name === 'string') out.name = src.name;

  if (src.spawn !== undefined) {
    const sp = src.spawn as Record<string, unknown>;
    if (typeof sp !== 'object' || sp === null) fail('"spawn" must be an object like { "x": 2.5, "y": 2.5, "angle": 90 }.');
    if (typeof sp.x !== 'number' || typeof sp.y !== 'number') fail('"spawn" needs numeric "x" and "y".');
    out.spawn = {
      x: sp.x as number,
      y: sp.y as number,
      angle: typeof sp.angle === 'number' ? (sp.angle as number) : 0,
    };
  }

  if (typeof src.ambient === 'number') out.ambient = clamp01(src.ambient as number);
  if (typeof src.ambientColor === 'string') out.ambientColor = src.ambientColor as string;
  if (typeof src.exposure === 'number') out.exposure = Math.max(0.05, src.exposure as number);
  if (typeof src.contrast === 'number') {
    out.contrast = Math.max(0.2, Math.min(6, src.contrast as number));
  }

  if (src.fog !== undefined) {
    const f = src.fog as Record<string, unknown>;
    if (typeof f !== 'object' || f === null) fail('"fog" must be an object.');
    out.fog = {
      color: typeof f.color === 'string' ? (f.color as string) : undefined,
      density: typeof f.density === 'number' ? Math.max(0, f.density as number) : undefined,
    };
  }

  if (src.sky !== undefined) {
    const s = src.sky as Record<string, unknown>;
    if (typeof s !== 'object' || s === null) fail('"sky" must be an object.');
    out.sky = {
      top: typeof s.top === 'string' ? (s.top as string) : undefined,
      horizon: typeof s.horizon === 'string' ? (s.horizon as string) : undefined,
      stars: typeof s.stars === 'number' ? clamp01(s.stars as number) : undefined,
    };
  }

  if (src.materials !== undefined) {
    if (typeof src.materials !== 'object' || src.materials === null || Array.isArray(src.materials)) {
      fail('"materials" must be an object keyed by material id.');
    }
    out.materials = src.materials as Record<string, MapSourceMaterial>;
  }

  if (src.legend !== undefined) {
    if (typeof src.legend !== 'object' || src.legend === null || Array.isArray(src.legend)) {
      fail('"legend" must be an object keyed by a single map character.');
    }
    const legend = src.legend as Record<string, MapSourceLegend>;
    for (const key of Object.keys(legend)) {
      if ([...key].length !== 1) fail(`Legend key ${JSON.stringify(key)} must be exactly one character.`);
    }
    out.legend = legend;
  }

  if (src.lights !== undefined) {
    if (!Array.isArray(src.lights)) fail('"lights" must be an array.');
    out.lights = (src.lights as unknown[]).map((l, i) => {
      const o = l as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) fail(`Light ${i} must be an object.`);
      if (typeof o.x !== 'number' || typeof o.y !== 'number') fail(`Light ${i} needs numeric "x" and "y".`);
      return o as unknown as MapSourceLight;
    });
  }

  if (src.entities !== undefined) {
    if (!Array.isArray(src.entities)) fail('"entities" must be an array.');
    out.entities = (src.entities as unknown[]).map((e, i) => {
      const o = e as Record<string, unknown>;
      if (typeof o !== 'object' || o === null) fail(`Entity ${i} must be an object.`);
      if (typeof o.sprite !== 'string') fail(`Entity ${i} needs a "sprite" name.`);
      if (typeof o.x !== 'number' || typeof o.y !== 'number') fail(`Entity ${i} needs numeric "x" and "y".`);
      if (o.path !== undefined) {
        if (!Array.isArray(o.path)) fail(`Entity ${i} "path" must be an array of [x, y] pairs.`);
        for (const p of o.path as unknown[]) {
          if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') {
            fail(`Entity ${i} "path" entries must be [x, y] number pairs.`);
          }
        }
      }
      return o as unknown as MapSourceEntity;
    });
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
