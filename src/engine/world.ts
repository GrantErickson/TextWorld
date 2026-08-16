import type { Door, Entity, Light, Material, RGB, Tile, TileType } from './types.ts';
import { TILE_DOOR, TILE_EMPTY, TILE_WALL } from './types.ts';
import {
  DEFAULT_CEILING,
  DEFAULT_FLOOR,
  DEFAULT_WALL,
  makeMaterial,
  parseColor,
  parsePattern,
  rgb,
} from './materials.ts';
import type { MapSource, MapSourceLegend } from './mapFormat.ts';
import { MapError } from './mapFormat.ts';
import { lookupSprite } from './sprites.ts';
import type { Theme } from './themes.ts';
import { lookupTheme, themeIds } from './themes.ts';
import { WfcModel, solveRegion } from './wfc.ts';

/**
 * Streaming parameters.
 *
 * The window has to be wide enough that the player can never see its edge: at
 * WINDOW/2 - SHIFT_THRESHOLD tiles of guaranteed clearance, anything past it
 * is further than the renderer casts anyway.
 */
const WINDOW = 96;
const SHIFT_THRESHOLD = 12;
/** Known cells fed into a solve on each side, so new terrain matches the old. */
/**
 * Known cells shown to the solver on each side. Two is the least that means
 * anything for n=3 patterns, and asking for more agreement than that mostly
 * just fails and relaxes back down — while making every solve bigger.
 */
const SOLVE_CONTEXT = 2;
/**
 * Solves are kept small on purpose. WFC's contradiction rate climbs steeply
 * with region area — the same sample that resolves every time at 24x24 fails
 * half the time at 32x32 — and a small region is cheap to retry.
 */
const SOLVE_BLOCK = 24;

/**
 * Stranded open areas smaller than this are filled in rather than tunnelled
 * to. A passage costs more than the closet it would open.
 */
const MIN_POCKET = 8;

/** Props and lights are only instantiated near the player. */
const LIGHT_CULL = 40;
const PROP_CULL = 28;

interface TileTemplate {
  type: TileType;
  wall: Material | null;
  floor: Material;
  ceiling: Material;
  sky: boolean;
}

/** A door counts as passable — for walking and for light — past this point. */
export const DOOR_PASSABLE = 0.55;

const DOOR_SPEED = 1.7;
const DOOR_AUTO_RADIUS = 2.4;
const DOOR_HOLD = 1.4;
/** How far a carried light may drift before its shadow field is rebaked. */
const LIGHT_REBAKE_DIST = 0.4;
const LIGHT_REBAKE_INTERVAL = 0.1;

export class World {
  readonly width: number;
  readonly height: number;
  readonly tiles: Tile[];
  readonly doors: Door[] = [];
  readonly lights: Light[] = [];
  readonly entities: Entity[] = [];

  name = 'untitled';
  ambient = 0.18;
  ambientColor: RGB = rgb(58, 74, 99);
  fogColor: RGB = rgb(11, 15, 23);
  fogDensity = 0.08;
  /**
   * Tone-mapping exposure. This wants to be well above 1: the curve is
   * `x / (1 + x)`, so at exposure 1 even a white surface under a full-strength
   * light only reaches 0.5 and the top half of the glyph ramp is unreachable
   * by construction. Around 2.2 a lit wall lands mid-ramp, which is where the
   * glyphs read as surface texture rather than as scattered dots.
   */
  exposure = 2.2;
  skyTop: RGB = rgb(14, 22, 42);
  skyHorizon: RGB = rgb(58, 78, 112);
  starDensity = 0.5;

  spawnX = 1.5;
  spawnY = 1.5;
  spawnAngle = 0;

  /**
   * World coordinate of tile[0]. Always (0, 0) for an authored map; for a
   * generated one this slides as the window follows the player, which is what
   * makes every coordinate in the engine absolute and unbounded.
   */
  originX = 0;
  originY = 0;

  /** True when this world streams new terrain instead of being fixed. */
  infinite = false;

  /**
   * Generator health. A solve that gives up still returns usable terrain, but
   * a rising failure count means the theme's sample is over-constrained and
   * the world is drifting toward whatever the fallback happens to be.
   */
  readonly gen = { solves: 0, failures: 0, relaxations: 0, tunnels: 0, lastMs: 0 };

  /** Seconds since this world was built; drives flicker, bob and doors. */
  time = 0;

  // --------------------------------------------------- generation state
  private theme: Theme | null = null;
  private model: WfcModel | null = null;
  /**
   * Pristine WFC output per window cell; -1 means "not generated yet".
   *
   * This is never edited after the solver produces it, because it doubles as
   * the constraint set for every later solve. Carving a passage through it
   * would manufacture local arrangements that appear nowhere in the sample,
   * and feeding those back as fixed constraints is unsatisfiable by
   * construction — which silently turned every streamed solve into a failure.
   */
  private chars: Int16Array = new Int16Array(0);

  /**
   * Post-processing laid over `chars`: 0 = use the character, 1 = forced open
   * (a carved passage), 2 = forced solid (a pocket too small to bother with).
   */
  private carved: Uint8Array = new Uint8Array(0);
  private templates: TileTemplate[] = [];
  private defaultTemplate: TileTemplate | null = null;
  private openTemplate: TileTemplate | null = null;
  private solidTemplate: TileTemplate | null = null;
  private seed = 1;
  private openChar = -1;
  private lanternIndex = -1;

  private constructor(width: number, height: number, tiles: Tile[]) {
    this.width = width;
    this.height = height;
    this.tiles = tiles;
  }

  // ---------------------------------------------------------------- queries

  tileAt(x: number, y: number): Tile | null {
    const lx = x - this.originX;
    const ly = y - this.originY;
    if (lx < 0 || ly < 0 || lx >= this.width || ly >= this.height) return null;
    return this.tiles[ly * this.width + lx];
  }

  /** Blocks movement. Out of bounds counts as solid so you cannot walk off. */
  isSolid(x: number, y: number): boolean {
    const t = this.tileAt(x, y);
    if (!t) return true;
    if (t.type === TILE_WALL) return true;
    if (t.type === TILE_DOOR) return this.doors[t.doorId].openness < DOOR_PASSABLE;
    return false;
  }

  /** Blocks light. Same rule as movement but tolerant of out-of-bounds. */
  blocksLight(x: number, y: number): boolean {
    const t = this.tileAt(x, y);
    if (!t) return true;
    if (t.type === TILE_WALL) return true;
    if (t.type === TILE_DOOR) return this.doors[t.doorId].openness < DOOR_PASSABLE;
    return false;
  }

  /** True if a circle of `radius` centred at (x, y) clears all solid tiles. */
  canOccupy(x: number, y: number, radius: number): boolean {
    const minX = Math.floor(x - radius);
    const maxX = Math.floor(x + radius);
    const minY = Math.floor(y - radius);
    const maxY = Math.floor(y + radius);
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        if (!this.isSolid(tx, ty)) continue;
        // Closest point on the tile square to the circle centre.
        const cx = Math.max(tx, Math.min(x, tx + 1));
        const cy = Math.max(ty, Math.min(y, ty + 1));
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy < radius * radius) return false;
      }
    }
    return true;
  }

  /** First door tile within `reach` along a ray, or null. */
  doorInFront(px: number, py: number, dx: number, dy: number, reach = 1.8): Door | null {
    const steps = Math.ceil(reach / 0.15);
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * reach;
      const tile = this.tileAt(Math.floor(px + dx * t), Math.floor(py + dy * t));
      if (!tile) return null;
      if (tile.type === TILE_DOOR) return this.doors[tile.doorId];
      if (tile.type === TILE_WALL) return null;
    }
    return null;
  }

  toggleDoor(door: Door): void {
    door.target = door.target > 0.5 ? 0 : 1;
    door.holdTimer = 0;
  }

  markLightsDirty(): void {
    for (const l of this.lights) l.visDirty = true;
  }

  // ----------------------------------------------------------------- update

  update(dt: number, playerX: number, playerY: number): void {
    this.time += dt;
    if (this.infinite) {
      this.stream(playerX, playerY);
      this.moveLantern(dt, playerX, playerY);
    }
    this.updateDoors(dt, playerX, playerY);
    this.updateEntities(dt);
  }

  /**
   * Carry the lantern. Its shadow field is only rebaked once it has drifted
   * far enough to matter — rebaking every frame would cost more than the rest
   * of the lighting put together.
   */
  private moveLantern(dt: number, playerX: number, playerY: number): void {
    if (this.lanternIndex < 0) return;
    const l = this.lights[this.lanternIndex];
    if (!l) return;
    l.x = playerX;
    l.y = playerY;
    l.cooldown -= dt;
    const drift = Math.hypot(l.x - l.visX, l.y - l.visY);
    if (drift > LIGHT_REBAKE_DIST && l.cooldown <= 0) {
      l.visDirty = true;
      l.cooldown = LIGHT_REBAKE_INTERVAL;
    }
  }

  private updateDoors(dt: number, playerX: number, playerY: number): void {
    for (const d of this.doors) {
      if (d.auto) {
        const dx = playerX - (d.tx + 0.5);
        const dy = playerY - (d.ty + 0.5);
        if (dx * dx + dy * dy < DOOR_AUTO_RADIUS * DOOR_AUTO_RADIUS) {
          d.target = 1;
          d.holdTimer = DOOR_HOLD;
        } else if (d.holdTimer > 0) {
          d.holdTimer -= dt;
          if (d.holdTimer <= 0) d.target = 0;
        }
      }

      if (d.openness === d.target) continue;

      const before = d.openness;
      const step = d.speed * dt;
      d.openness =
        d.target > d.openness
          ? Math.min(d.target, d.openness + step)
          : Math.max(d.target, d.openness - step);

      // Shadows only need rebaking when the door crosses the threshold that
      // decides whether light gets through, not on every animation frame.
      const wasOpen = before >= DOOR_PASSABLE;
      const isOpen = d.openness >= DOOR_PASSABLE;
      if (wasOpen !== isOpen) this.markLightsDirty();
    }
  }

  private updateEntities(dt: number): void {
    for (const e of this.entities) {
      if (e.path.length > 1 && e.speed > 0) {
        const target = e.path[e.pathIndex];
        const dx = target[0] - e.x;
        const dy = target[1] - e.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.06) {
          e.pathIndex = (e.pathIndex + 1) % e.path.length;
        } else {
          const step = Math.min(dist, e.speed * dt);
          e.x += (dx / dist) * step;
          e.y += (dy / dist) * step;
        }
      }

      if (e.lightIndex >= 0) {
        const l = this.lights[e.lightIndex];
        l.x = e.x;
        l.y = e.y;
        l.cooldown -= dt;
        const drift = Math.hypot(l.x - l.visX, l.y - l.visY);
        if (drift > LIGHT_REBAKE_DIST && l.cooldown <= 0) {
          l.visDirty = true;
          l.cooldown = LIGHT_REBAKE_INTERVAL;
        }
      }
    }
  }

  // ------------------------------------------------------------------ build

  static fromSource(src: MapSource): World {
    if (src.generate) {
      const theme = lookupTheme(src.generate.theme);
      if (!theme) {
        throw new MapError(
          `Unknown theme "${src.generate.theme}". Available: ${themeIds().join(', ')}.`,
        );
      }
      const world = World.fromTheme(theme, src.generate.seed ?? 1);

      // The theme sets the look; anything stated in the source wins over it.
      if (src.name !== undefined) world.name = src.name;
      if (src.ambient !== undefined) world.ambient = src.ambient;
      if (src.ambientColor !== undefined) world.ambientColor = parseColor(src.ambientColor, world.ambientColor);
      if (src.exposure !== undefined) world.exposure = src.exposure;
      if (src.fog?.color !== undefined) world.fogColor = parseColor(src.fog.color, world.fogColor);
      if (src.fog?.density !== undefined) world.fogDensity = src.fog.density;
      if (src.sky?.top !== undefined) world.skyTop = parseColor(src.sky.top, world.skyTop);
      if (src.sky?.horizon !== undefined) world.skyHorizon = parseColor(src.sky.horizon, world.skyHorizon);
      if (src.sky?.stars !== undefined) world.starDensity = src.sky.stars;
      return world;
    }

    const grid = src.grid;
    const height = grid.length;
    const width = grid[0].length;

    const materials = buildMaterials(src);
    const legend = src.legend ?? {};

    const tiles: Tile[] = new Array(width * height);
    const world = new World(width, height, tiles);

    world.name = src.name ?? 'untitled';
    if (src.ambient !== undefined) world.ambient = src.ambient;
    world.ambientColor = parseColor(src.ambientColor, world.ambientColor);
    world.fogColor = parseColor(src.fog?.color, world.fogColor);
    if (src.fog?.density !== undefined) world.fogDensity = src.fog.density;
    if (src.exposure !== undefined) world.exposure = src.exposure;
    world.skyTop = parseColor(src.sky?.top, world.skyTop);
    world.skyHorizon = parseColor(src.sky?.horizon, world.skyHorizon);
    if (src.sky?.stars !== undefined) world.starDensity = src.sky.stars;

    const mat = (id: string | undefined, fallback: Material): Material => {
      if (!id) return fallback;
      const m = materials[id];
      if (!m) throw new MapError(`Unknown material "${id}". Define it under "materials".`);
      return m;
    };

    // Pass 1: tile types and surfaces.
    for (let y = 0; y < height; y++) {
      const row = grid[y];
      for (let x = 0; x < width; x++) {
        const ch = row[x];
        const entry: MapSourceLegend | undefined = legend[ch];
        const i = y * width + x;

        if (entry?.door) {
          tiles[i] = {
            type: TILE_DOOR,
            wall: mat(entry.door, DEFAULT_WALL),
            floor: mat(entry.floor, DEFAULT_FLOOR),
            ceiling: mat(entry.ceiling, DEFAULT_CEILING),
            sky: false,
            doorId: -1,
            ao: 1,
          };
        } else if (entry?.wall) {
          tiles[i] = {
            type: TILE_WALL,
            wall: mat(entry.wall, DEFAULT_WALL),
            floor: mat(entry.floor, DEFAULT_FLOOR),
            ceiling: mat(entry.ceiling, DEFAULT_CEILING),
            sky: false,
            doorId: -1,
            ao: 1,
          };
        } else if (entry) {
          tiles[i] = {
            type: TILE_EMPTY,
            wall: null,
            floor: mat(entry.floor, DEFAULT_FLOOR),
            ceiling: mat(entry.ceiling, DEFAULT_CEILING),
            sky: entry.sky === true,
            doorId: -1,
            ao: 1,
          };
        } else {
          // Unlisted characters: whitespace and '.' are open floor, anything
          // else is a plain wall. That is what makes raw ASCII art work.
          const open = ch === ' ' || ch === '.';
          tiles[i] = {
            type: open ? TILE_EMPTY : TILE_WALL,
            wall: open ? null : DEFAULT_WALL,
            floor: DEFAULT_FLOOR,
            ceiling: DEFAULT_CEILING,
            sky: false,
            doorId: -1,
            ao: 1,
          };
        }
      }
    }

    // Pass 2: doors. Orientation comes from which neighbours are solid, so a
    // door in an east-west wall run swings on the plane you walk through.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = tiles[y * width + x];
        if (t.type !== TILE_DOOR) continue;
        const solidWE = isBuildSolid(tiles, width, height, x - 1, y) && isBuildSolid(tiles, width, height, x + 1, y);
        const solidNS = isBuildSolid(tiles, width, height, x, y - 1) && isBuildSolid(tiles, width, height, x, y + 1);
        // Panel spans X (plane at y+0.5) when the wall run is east-west.
        const axis: 'x' | 'y' = solidWE && !solidNS ? 'x' : solidNS && !solidWE ? 'y' : solidWE ? 'x' : 'y';

        const ch = grid[y][x];
        const entry = legend[ch];
        const door: Door = {
          id: world.doors.length,
          tx: x,
          ty: y,
          axis,
          material: t.wall ?? DEFAULT_WALL,
          openness: 0,
          target: 0,
          auto: entry?.auto === true,
          holdTimer: 0,
          speed: DOOR_SPEED,
        };
        t.doorId = door.id;
        world.doors.push(door);
      }
    }

    // Pass 3: bake corner occlusion for floors and ceilings. Static, cheap,
    // and it does a lot of work selling the geometry at low resolution.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = tiles[y * width + x];
        if (t.type !== TILE_EMPTY) continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (isBuildSolid(tiles, width, height, x + dx, y + dy)) n += dx === 0 || dy === 0 ? 1 : 0.5;
          }
        }
        t.ao = Math.max(0.55, 1 - n * 0.075);
      }
    }

    // Lights.
    for (const l of src.lights ?? []) {
      world.lights.push(makeLight(l.x, l.y, l.radius, l.color, l.intensity, l.flicker, world.lights.length, -1));
    }

    // Entities, plus any lights they carry.
    for (const e of src.entities ?? []) {
      const def = lookupSprite(e.sprite);
      if (!def) throw new MapError(`Unknown sprite "${e.sprite}".`);
      const index = world.entities.length;
      let lightIndex = -1;
      if (e.light) {
        lightIndex = world.lights.length;
        world.lights.push(
          makeLight(e.x, e.y, e.light.radius, e.light.color, e.light.intensity, e.light.flicker, lightIndex, index),
        );
      }
      world.entities.push({
        index,
        def,
        x: e.x,
        y: e.y,
        path: (e.path ?? []) as Array<[number, number]>,
        pathIndex: 0,
        speed: e.speed ?? 0,
        bob: e.bob ?? (def.base > 0 ? 0.05 : 0),
        bobPhase: index * 1.7,
        lightIndex,
      });
    }

    // Spawn: honour the authored point if it is legal, otherwise fall back to
    // the first open tile so a half-finished map still loads.
    const sp = src.spawn;
    if (sp && world.canOccupy(sp.x, sp.y, 0.24)) {
      world.spawnX = sp.x;
      world.spawnY = sp.y;
      world.spawnAngle = ((sp.angle ?? 0) * Math.PI) / 180;
    } else {
      let found = false;
      for (let y = 0; y < height && !found; y++) {
        for (let x = 0; x < width && !found; x++) {
          if (world.canOccupy(x + 0.5, y + 0.5, 0.24)) {
            world.spawnX = x + 0.5;
            world.spawnY = y + 0.5;
            world.spawnAngle = ((sp?.angle ?? 0) * Math.PI) / 180;
            found = true;
          }
        }
      }
      if (!found) throw new MapError('The map has no open tile to stand in.');
    }

    return world;
  }

  // -------------------------------------------------------- infinite worlds

  /** Build a streamed world from a theme. The window is centred on the origin. */
  static fromTheme(theme: Theme, seed: number): World {
    const tiles: Tile[] = new Array(WINDOW * WINDOW);
    const world = new World(WINDOW, WINDOW, tiles);

    world.infinite = true;
    world.theme = theme;
    world.model = new WfcModel(theme.sample, theme.n);
    world.seed = seed >>> 0;
    world.chars = new Int16Array(WINDOW * WINDOW).fill(-1);
    world.carved = new Uint8Array(WINDOW * WINDOW);
    world.name = theme.label;

    world.ambient = theme.ambient;
    world.ambientColor = parseColor(theme.ambientColor, world.ambientColor);
    world.exposure = theme.exposure;
    world.fogColor = parseColor(theme.fogColor, world.fogColor);
    world.fogDensity = theme.fogDensity;
    if (theme.skyTop) world.skyTop = parseColor(theme.skyTop, world.skyTop);
    if (theme.skyHorizon) world.skyHorizon = parseColor(theme.skyHorizon, world.skyHorizon);
    if (theme.stars !== undefined) world.starDensity = theme.stars;

    world.buildTemplates();
    world.originX = -(WINDOW >> 1);
    world.originY = -(WINDOW >> 1);

    // Order matters: tiles have to exist before anything can ask what is
    // walkable, and the spawn has to be known before props avoid it.
    world.fillUnknown();
    world.connectRegions(0, 0);
    world.buildTiles();
    world.bakeAO();

    const spot = world.findOpenNear(0, 0) ?? [0, 0];
    world.spawnX = spot[0] + 0.5;
    world.spawnY = spot[1] + 0.5;
    world.spawnAngle = world.openestAngle(world.spawnX, world.spawnY);
    world.populate(world.spawnX, world.spawnY);

    return world;
  }

  /**
   * Recenter the window if the player has drifted far enough from its middle.
   * A cheap comparison on almost every frame; real work a few times a minute.
   */
  private stream(px: number, py: number): void {
    const cx = this.originX + this.width * 0.5;
    const cy = this.originY + this.height * 0.5;
    if (Math.abs(px - cx) <= SHIFT_THRESHOLD && Math.abs(py - cy) <= SHIFT_THRESHOLD) return;

    const nox = Math.floor(px) - (this.width >> 1);
    const noy = Math.floor(py) - (this.height >> 1);
    const dx = nox - this.originX;
    const dy = noy - this.originY;
    if (dx === 0 && dy === 0) return;

    // Carry over the overlap; everything else comes back as "not generated".
    const w = this.width;
    const h = this.height;
    const next = new Int16Array(w * h).fill(-1);
    const nextCarved = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = y + dy;
      if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < w; x++) {
        const sx = x + dx;
        if (sx < 0 || sx >= w) continue;
        next[y * w + x] = this.chars[sy * w + sx];
        nextCarved[y * w + x] = this.carved[sy * w + sx];
      }
    }
    this.chars = next;
    this.carved = nextCarved;
    this.originX = nox;
    this.originY = noy;

    this.fillUnknown();
    this.connectRegions(px, py);
    this.buildTiles();
    this.bakeAO();
    this.populate(px, py);
    // Geometry moved under every shadow field, and the light set was rebuilt.
    this.markLightsDirty();

    const spot = this.findOpenNear(Math.floor(px), Math.floor(py));
    if (spot) {
      this.spawnX = spot[0] + 0.5;
      this.spawnY = spot[1] + 0.5;
    }
  }

  /**
   * Solve every block that still contains ungenerated cells, tightened to the
   * cells that are actually missing. After a shift the new terrain is a narrow
   * strip; solving the full block it happens to fall in would cost several
   * times as much for the same result.
   */
  private fillUnknown(): void {
    for (let by = 0; by < this.height; by += SOLVE_BLOCK) {
      for (let bx = 0; bx < this.width; bx += SOLVE_BLOCK) {
        const bw = Math.min(SOLVE_BLOCK, this.width - bx);
        const bh = Math.min(SOLVE_BLOCK, this.height - by);

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -1;
        let maxY = -1;
        for (let y = by; y < by + bh; y++) {
          for (let x = bx; x < bx + bw; x++) {
            if (this.chars[y * this.width + x] >= 0) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        if (maxX < 0) continue;
        this.solveRect(minX, minY, maxX - minX + 1, maxY - minY + 1);
      }
    }
  }

  /**
   * Solve one rectangle. Cells that already have a character — retained
   * terrain, or the corridor lattice — go into the wave as fixed constraints,
   * so the result agrees with its surroundings instead of merely abutting it.
   */
  private solveRect(x0: number, y0: number, rw: number, rh: number): void {
    const model = this.model;
    if (!model) return;

    const ex0 = Math.max(0, x0 - SOLVE_CONTEXT);
    const ey0 = Math.max(0, y0 - SOLVE_CONTEXT);
    const ex1 = Math.min(this.width, x0 + rw + SOLVE_CONTEXT);
    const ey1 = Math.min(this.height, y0 + rh + SOLVE_CONTEXT);
    const ew = ex1 - ex0;
    const eh = ey1 - ey0;

    const t0 = performance.now();
    const seed = hashInt(this.originX + x0, this.originY + y0, this.seed);

    /**
     * Progressive relaxation.
     *
     * A failed solve emits characters that are not a valid combination of the
     * sample's patterns. Feed those back in as constraints and the next solve
     * cannot succeed either, so one failure anywhere poisons everything
     * downstream of it and the world decays into fallback. Backing off the
     * constraints breaks that cascade: the last level asks for no agreement
     * with the surroundings at all, which always succeeds, and the resulting
     * seam sits at the window edge — tens of tiles away, under heavy fog.
     */
    let result: ReturnType<typeof solveRegion> | null = null;
    for (const limit of [SOLVE_CONTEXT, 1, 0]) {
      const known = new Int16Array(ew * eh).fill(-1);
      if (limit > 0) {
        for (let y = 0; y < eh; y++) {
          for (let x = 0; x < ew; x++) {
            const gx = ex0 + x;
            const gy = ey0 + y;
            // Chebyshev distance from the rectangle being solved.
            const dxo = Math.max(x0 - gx, gx - (x0 + rw - 1), 0);
            const dyo = Math.max(y0 - gy, gy - (y0 + rh - 1), 0);
            if (Math.max(dxo, dyo) > limit) continue;
            const existing = this.chars[gy * this.width + gx];
            if (existing >= 0) known[y * ew + x] = existing;
          }
        }
      }

      result = solveRegion(model, { width: ew, height: eh, known, seed, attempts: 3 });
      if (result.ok) break;
      this.gen.relaxations++;
    }

    this.gen.solves++;
    if (!result || !result.ok) this.gen.failures++;
    this.gen.lastMs += performance.now() - t0;
    if (!result) return;

    // Only the target rectangle is kept. The surrounding cells were in the
    // wave to provide context — the known ones as constraints, the unknown
    // ones as slack — but committing them too would leave the remaining
    // ungenerated area ragged, and a region hemmed in on three or four sides
    // is far harder to satisfy than one being extended along an edge. That
    // difference is the whole ballgame: it is a ~99% failure rate against ~0%.
    for (let y = y0; y < y0 + rh; y++) {
      for (let x = x0; x < x0 + rw; x++) {
        const gi = y * this.width + x;
        if (this.chars[gi] >= 0) continue;
        this.chars[gi] = result.chars[(y - ey0) * ew + (x - ex0)];
      }
    }
  }

  private isCharSolid(ci: number): boolean {
    if (ci < 0) return true;
    const t = this.templates[ci];
    return !t || t.type !== TILE_EMPTY;
  }

  /** Solidity as the world actually presents it: the character plus any carving. */
  private isSolidAt(i: number): boolean {
    const c = this.carved[i];
    if (c === 1) return false;
    if (c === 2) return true;
    return this.isCharSolid(this.chars[i]);
  }

  /**
   * Make every worthwhile open area reachable.
   *
   * WFC has no notion of connectivity, so it cheerfully produces rooms with no
   * way in. Deleting those is the easy fix and a bad one — it throws away most
   * of what the generator drew. Instead each stranded pocket is tunnelled
   * through to the nearest reachable cell, which is both cheap and reads as
   * intentional: a doorway punched between two chambers. Only pockets too
   * small to be worth a passage are filled in.
   *
   * Cells on the window border count as reachable from the start, since they
   * lead off toward terrain that has not been generated yet.
   */
  private connectRegions(px: number, py: number): void {
    const w = this.width;
    const h = this.height;
    const total = w * h;
    const reach = new Uint8Array(total);
    const stack: number[] = [];
    const pushOpen = (i: number): void => {
      if (reach[i] || this.isSolidAt(i)) return;
      reach[i] = 1;
      stack.push(i);
    };
    const flood = (): void => {
      while (stack.length > 0) {
        const i = stack.pop() as number;
        const x = i % w;
        const y = (i - x) / w;
        if (x > 0) pushOpen(i - 1);
        if (x < w - 1) pushOpen(i + 1);
        if (y > 0) pushOpen(i - w);
        if (y < h - 1) pushOpen(i + w);
      }
    };

    // Seeded from the player alone. Seeding from the window border as well
    // looks tempting — those cells do lead off toward ungenerated terrain —
    // but it quietly declares whole regions "fine" that the player cannot
    // actually walk to, which is the thing this pass exists to prevent. If the
    // player is not standing anywhere valid, the first pocket found bootstraps
    // the component and the rest are tunnelled to it.
    const sx = Math.floor(px) - this.originX;
    const sy = Math.floor(py) - this.originY;
    if (sx >= 0 && sy >= 0 && sx < w && sy < h) pushOpen(sy * w + sx);
    flood();

    // Scratch buffers for the tunnelling search, reused across pockets.
    const seen = new Uint8Array(total);
    const prev = new Int32Array(total);
    const visited = new Uint8Array(total);
    const pocket: number[] = [];
    const queue: number[] = [];

    for (let start = 0; start < total; start++) {
      if (reach[start] || visited[start] || this.isSolidAt(start)) continue;

      pocket.length = 0;
      queue.length = 0;
      queue.push(start);
      visited[start] = 1;
      while (queue.length > 0) {
        const i = queue.pop() as number;
        pocket.push(i);
        const x = i % w;
        const y = (i - x) / w;
        if (x > 0 && !visited[i - 1] && !this.isSolidAt(i - 1)) {
          visited[i - 1] = 1;
          queue.push(i - 1);
        }
        if (x < w - 1 && !visited[i + 1] && !this.isSolidAt(i + 1)) {
          visited[i + 1] = 1;
          queue.push(i + 1);
        }
        if (y > 0 && !visited[i - w] && !this.isSolidAt(i - w)) {
          visited[i - w] = 1;
          queue.push(i - w);
        }
        if (y < h - 1 && !visited[i + w] && !this.isSolidAt(i + w)) {
          visited[i + w] = 1;
          queue.push(i + w);
        }
      }

      if (pocket.length < MIN_POCKET) {
        for (const i of pocket) this.carved[i] = 2;
        continue;
      }

      this.gen.tunnels++;
      this.tunnel(pocket, reach, seen, prev);
      for (const i of pocket) pushOpen(i);
      flood();
    }
  }

  /**
   * Breadth-first search outward from a stranded pocket, straight through
   * solid rock, until it meets reachable ground; then open every solid cell
   * along the path it came by. The first hit is the shortest way out, so the
   * passage is as short as the geometry allows.
   */
  private tunnel(pocket: number[], reach: Uint8Array, seen: Uint8Array, prev: Int32Array): void {
    const w = this.width;
    const h = this.height;

    seen.fill(0);
    prev.fill(-1);
    const queue: number[] = [];
    for (const i of pocket) {
      seen[i] = 1;
      queue.push(i);
    }

    let head = 0;
    let hit = -1;
    while (head < queue.length) {
      const i = queue[head++];
      if (reach[i]) {
        hit = i;
        break;
      }
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && !seen[i - 1]) {
        seen[i - 1] = 1;
        prev[i - 1] = i;
        queue.push(i - 1);
      }
      if (x < w - 1 && !seen[i + 1]) {
        seen[i + 1] = 1;
        prev[i + 1] = i;
        queue.push(i + 1);
      }
      if (y > 0 && !seen[i - w]) {
        seen[i - w] = 1;
        prev[i - w] = i;
        queue.push(i - w);
      }
      if (y < h - 1 && !seen[i + w]) {
        seen[i + w] = 1;
        prev[i + w] = i;
        queue.push(i + w);
      }
    }

    // Record the passage as an overlay rather than editing the characters, so
    // the solver keeps seeing terrain it could have produced itself.
    for (let cur = hit; cur >= 0; cur = prev[cur]) {
      if (this.isSolidAt(cur)) this.carved[cur] = 1;
    }
  }

  private wallChar(): number {
    const model = this.model;
    const theme = this.theme;
    if (!model || !theme) return -1;
    return model.charToIndex(theme.fallback);
  }

  private buildTemplates(): void {
    const theme = this.theme;
    const model = this.model;
    if (!theme || !model) return;

    const mats: Record<string, Material> = {};
    for (const [id, def] of Object.entries(theme.materials)) {
      mats[id] = makeMaterial(
        id,
        parseColor(def.color, rgb(150, 150, 150)),
        parsePattern(def.pattern),
        def.roughness ?? 0.6,
        def.emissive ?? 0,
      );
    }
    const mat = (id: string | undefined, fallback: Material): Material =>
      id ? (mats[id] ?? fallback) : fallback;

    this.templates = model.chars.map((ch) => {
      const entry = theme.legend[ch];
      if (entry?.wall) {
        return {
          type: TILE_WALL as TileType,
          wall: mat(entry.wall, DEFAULT_WALL),
          floor: mat(entry.floor, DEFAULT_FLOOR),
          ceiling: mat(entry.ceiling, DEFAULT_CEILING),
          sky: false,
        };
      }
      if (entry) {
        return {
          type: TILE_EMPTY as TileType,
          wall: null,
          floor: mat(entry.floor, DEFAULT_FLOOR),
          ceiling: mat(entry.ceiling, DEFAULT_CEILING),
          sky: entry.sky === true,
        };
      }
      const open = ch === ' ' || ch === '.';
      return {
        type: (open ? TILE_EMPTY : TILE_WALL) as TileType,
        wall: open ? null : DEFAULT_WALL,
        floor: DEFAULT_FLOOR,
        ceiling: DEFAULT_CEILING,
        sky: false,
      };
    });

    this.defaultTemplate = this.templates[0] ?? null;
    this.openChar = model.charToIndex(theme.open);
    this.openTemplate = this.openChar >= 0 ? this.templates[this.openChar] : null;
    const solid = model.charToIndex(theme.fallback);
    this.solidTemplate = solid >= 0 ? this.templates[solid] : null;
  }

  private buildTiles(): void {
    for (let i = 0; i < this.chars.length; i++) {
      const ci = this.chars[i];
      let t = (ci >= 0 ? this.templates[ci] : null) ?? this.defaultTemplate;
      const c = this.carved[i];
      if (c === 1 && this.openTemplate) t = this.openTemplate;
      else if (c === 2 && this.solidTemplate) t = this.solidTemplate;
      this.tiles[i] = {
        type: t ? t.type : TILE_WALL,
        wall: t ? t.wall : DEFAULT_WALL,
        floor: t ? t.floor : DEFAULT_FLOOR,
        ceiling: t ? t.ceiling : DEFAULT_CEILING,
        sky: t ? t.sky : false,
        doorId: -1,
        ao: 1,
      };
    }
  }

  private bakeAO(): void {
    const w = this.width;
    const h = this.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = this.tiles[y * w + x];
        if (t.type !== TILE_EMPTY) continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (isBuildSolid(this.tiles, w, h, x + dx, y + dy)) n += dx === 0 || dy === 0 ? 1 : 0.5;
          }
        }
        t.ao = Math.max(0.55, 1 - n * 0.075);
      }
    }
  }

  private isOpenAt(wx: number, wy: number): boolean {
    const t = this.tileAt(wx, wy);
    return !!t && t.type === TILE_EMPTY;
  }

  private touchesWall(wx: number, wy: number): boolean {
    return (
      !this.isOpenAt(wx + 1, wy) ||
      !this.isOpenAt(wx - 1, wy) ||
      !this.isOpenAt(wx, wy + 1) ||
      !this.isOpenAt(wx, wy - 1)
    );
  }

  /**
   * The direction with the longest clear run. Dropping into a generated world
   * nose-first against a wall is a poor introduction to it — and since the
   * generator picks the spawn, it should pick where to look as well.
   */
  private openestAngle(px: number, py: number): number {
    let best = 0;
    let bestDist = -1;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      let d = 0.5;
      while (d < 26 && this.isOpenAt(Math.floor(px + dx * d), Math.floor(py + dy * d))) d += 0.5;
      if (d > bestDist) {
        bestDist = d;
        best = a;
      }
    }
    return best;
  }

  private findOpenNear(wx: number, wy: number): [number, number] | null {
    for (let r = 0; r < this.width >> 1; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = wx + dx;
          const y = wy + dy;
          if (this.isOpenAt(x, y) && this.canOccupy(x + 0.5, y + 0.5, 0.24)) return [x, y];
        }
      }
    }
    return null;
  }

  /**
   * Instantiate lights and props for the current window.
   *
   * Both are derived from the generated characters and from absolute
   * coordinates, so they land in the same places for the same terrain. Both
   * are also culled to the player's neighbourhood: `surfaceLight` walks the
   * light list for every shaded cell, so an unbounded light count would show
   * up directly in the frame time.
   */
  private populate(px: number, py: number): void {
    const theme = this.theme;
    if (!theme) return;
    this.lights.length = 0;
    this.entities.length = 0;

    // The player's lantern is always light 0, so `update` can find it again
    // after the list is rebuilt.
    this.lights.push(
      makeLight(px, py, theme.lantern.radius, theme.lantern.color, theme.lantern.intensity, 0, 0, -1),
    );
    this.lanternIndex = 0;

    const spacing = Math.max(3, Math.round(theme.torch.spacing));
    const bx0 = Math.floor((px - LIGHT_CULL) / spacing);
    const bx1 = Math.floor((px + LIGHT_CULL) / spacing);
    const by0 = Math.floor((py - LIGHT_CULL) / spacing);
    const by1 = Math.floor((py + LIGHT_CULL) / spacing);

    for (let by = by0; by <= by1 && this.lights.length < 48; by++) {
      for (let bx = bx0; bx <= bx1 && this.lights.length < 48; bx++) {
        const spot = this.torchSpot(bx, by, spacing);
        if (!spot) continue;
        const lx = spot[0] + 0.5;
        const ly = spot[1] + 0.5;
        const dx = lx - px;
        const dy = ly - py;
        if (dx * dx + dy * dy > LIGHT_CULL * LIGHT_CULL) continue;
        this.lights.push(
          makeLight(
            lx,
            ly,
            theme.torch.radius,
            theme.torch.color,
            theme.torch.intensity,
            theme.torch.flicker,
            hashInt(spot[0], spot[1], 0x2f1c) & 0xffff,
            -1,
          ),
        );
      }
    }

    if (theme.props.length === 0) return;
    const px0 = Math.floor(px - PROP_CULL);
    const px1 = Math.floor(px + PROP_CULL);
    const py0 = Math.floor(py - PROP_CULL);
    const py1 = Math.floor(py + PROP_CULL);

    for (let wy = py0; wy <= py1 && this.entities.length < 90; wy++) {
      for (let wx = px0; wx <= px1 && this.entities.length < 90; wx++) {
        if (!this.isOpenAt(wx, wy)) continue;
        // Keep the spawn tile and the torches themselves clear.
        if (Math.abs(wx + 0.5 - this.spawnX) < 1 && Math.abs(wy + 0.5 - this.spawnY) < 1) continue;

        const h = hashInt(wx, wy, this.seed ^ 0x2545f491);
        let roll = (h % 100000) / 100000;
        let picked: string | null = null;
        for (const p of theme.props) {
          if (roll < p.chance) {
            picked = p.sprite;
            break;
          }
          roll -= p.chance;
        }
        if (!picked) continue;

        const def = lookupSprite(picked);
        if (!def) continue;
        const jx = ((hashInt(wx, wy, 0x1111) % 1000) / 1000 - 0.5) * 0.4;
        const jy = ((hashInt(wx, wy, 0x2222) % 1000) / 1000 - 0.5) * 0.4;
        const index = this.entities.length;
        this.entities.push({
          index,
          def,
          x: wx + 0.5 + jx,
          y: wy + 0.5 + jy,
          path: [],
          pathIndex: 0,
          speed: 0,
          bob: def.base > 0 ? 0.05 : 0,
          bobPhase: hashInt(wx, wy, 0x3333) % 628 / 100,
          lightIndex: -1,
        });
      }
    }
  }

  /** A deterministic, wall-hugging spot for one torch inside a lattice cell. */
  private torchSpot(bx: number, by: number, spacing: number): [number, number] | null {
    for (let k = 0; k < 8; k++) {
      const h = hashInt(bx * 31 + k, by * 17 + k * 7, this.seed ^ 0x51ed270b);
      const tx = bx * spacing + (h % spacing);
      const ty = by * spacing + ((h >>> 9) % spacing);
      if (!this.isOpenAt(tx, ty)) continue;
      if (!this.touchesWall(tx, ty)) continue;
      return [tx, ty];
    }
    return null;
  }
}

/** Non-negative integer hash of two coordinates plus a salt. */
function hashInt(x: number, y: number, salt: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

function isBuildSolid(tiles: Tile[], w: number, h: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return true;
  const t = tiles[y * w + x];
  return t.type === TILE_WALL || t.type === TILE_DOOR;
}

function makeLight(
  x: number,
  y: number,
  radius: number | undefined,
  color: string | undefined,
  intensity: number | undefined,
  flicker: number | undefined,
  seedIndex: number,
  ownerEntity: number,
): Light {
  return {
    x,
    y,
    radius: radius ?? 8,
    color: parseColor(color, rgb(255, 214, 170)),
    intensity: intensity ?? 1,
    flicker: flicker ?? 0,
    seed: seedIndex * 37 + 11,
    vis: null,
    visDirty: true,
    visOX: 0,
    visOY: 0,
    visW: 0,
    visH: 0,
    visX: x,
    visY: y,
    ownerEntity,
    cooldown: 0,
  };
}

function buildMaterials(src: MapSource): Record<string, Material> {
  const out: Record<string, Material> = {};
  for (const [id, def] of Object.entries(src.materials ?? {})) {
    out[id] = makeMaterial(
      id,
      parseColor(def.color, rgb(150, 150, 150)),
      parsePattern(def.pattern),
      def.roughness ?? 0.6,
      def.emissive ?? 0,
    );
  }
  return out;
}
