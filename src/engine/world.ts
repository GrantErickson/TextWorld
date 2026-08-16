import type { Door, Entity, Light, Material, RGB, Tile } from './types.ts';
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

  /** Seconds since this world was built; drives flicker, bob and doors. */
  time = 0;

  private constructor(width: number, height: number, tiles: Tile[]) {
    this.width = width;
    this.height = height;
    this.tiles = tiles;
  }

  // ---------------------------------------------------------------- queries

  tileAt(x: number, y: number): Tile | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return this.tiles[y * this.width + x];
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
    this.updateDoors(dt, playerX, playerY);
    this.updateEntities(dt);
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
