import type { Camera } from './camera.ts';
import type { World } from './world.ts';
import type { RayHit } from './raycast.ts';
import { castRay, makeHit } from './raycast.ts';
import { applyFog, ensureVisibility, makeAccum, sunLight, surfaceLight } from './lighting.ts';
import type { LightAccum } from './lighting.ts';
import { hash2, sampleTexture } from './materials.ts';
import { DENSITY_CHARS } from './sprites.ts';
import {
  CellBuffer,
  GS_SKY,
  KIND_CEILING,
  KIND_DOOR,
  KIND_FLOOR,
  KIND_SKY,
  KIND_SPRITE,
  KIND_WALL,
  cellSeed,
  glyphSeed,
  setContrast,
  toneMap,
} from './shading.ts';

const MAX_DIST = 44;
/**
 * Outdoor worlds see much further: there is no ceiling to close the view down
 * and a landscape that stops at 44 tiles reads as a small room with a painted
 * backdrop. Fog does the rest of the work.
 */
const TERRAIN_MAX_DIST = 95;

export interface RenderStats {
  cols: number;
  rows: number;
  rays: number;
  sprites: number;
  ms: number;
}

interface SpriteDraw {
  index: number;
  depth: number;
}

export class Renderer {
  readonly buf = new CellBuffer();

  private zbuf = new Float32Array(0);
  private wallTop = new Int32Array(0);
  private wallBot = new Int32Array(0);
  private hits: RayHit[] = [];
  /**
   * Per-cell depth, written by the terrain pass. Indoors a single depth per
   * column is enough to hide sprites behind walls, but a landscape presents a
   * different distance in every row of a column, so sprites out there have to
   * be tested cell by cell.
   */
  private depth = new Float32Array(0);
  /**
   * Per-column coverage: which rows of the column being marched are already
   * resolved. This replaces the single y-buffer, which could only ever
   * describe one contiguous run of unresolved rows. That is enough while every
   * column has one surface, and not enough the moment a building has a floor
   * you can stand under: a slab seen edge-on leaves a gap above it *and*
   * below it, and ceilings paint down toward the horizon while floors paint up.
   */
  private doneRows = new Uint8Array(0);
  private cellDepth = false;

  /** World-space end point of each column's ray; drawn on the minimap. */
  rayX = new Float32Array(0);
  rayY = new Float32Array(0);

  /**
   * Global contrast trim, multiplied into every world's own `contrast`. The
   * map is authored for a look; this is the viewer's knob on top of it.
   */
  contrastTrim = 1;

  private accum: LightAccum = makeAccum();
  private accTop: LightAccum = makeAccum();
  private accMid: LightAccum = makeAccum();
  private accBot: LightAccum = makeAccum();
  private drawList: SpriteDraw[] = [];

  stats: RenderStats = { cols: 0, rows: 0, rays: 0, sprites: 0, ms: 0 };

  resize(cols: number, rows: number): void {
    if (this.buf.resize(cols, rows)) {
      this.zbuf = new Float32Array(cols);
      this.wallTop = new Int32Array(cols);
      this.wallBot = new Int32Array(cols);
      this.rayX = new Float32Array(cols);
      this.rayY = new Float32Array(cols);
      this.depth = new Float32Array(cols * rows);
      this.doneRows = new Uint8Array(rows);
      this.hits = new Array(cols);
      for (let i = 0; i < cols; i++) this.hits[i] = makeHit();
    }
  }

  /**
   * `cellAspect` is the display's cellWidth / cellHeight. Character cells are
   * roughly half as wide as they are tall, and the projection has to know
   * that or every wall comes out stretched.
   */
  render(world: World, cam: Camera, cellAspect: number): RenderStats {
    const t0 = performance.now();
    const cols = this.buf.cols;
    const rows = this.buf.rows;
    if (cols === 0 || rows === 0) return this.stats;

    if (cam.teleported) {
      this.buf.invalidate();
      cam.teleported = false;
    }

    // Constant for the whole frame, so it is set once here rather than
    // threaded through every one of the shading call sites below.
    setContrast(world.contrast * this.contrastTrim);

    ensureVisibility(world);

    // Vertical projection scale, in rows per tile at unit distance. Derived so
    // that a square in the world projects to a square on screen once the
    // non-square character cell is accounted for.
    const projY = (cols * cellAspect) / (2 * cam.planeLength);
    const projX = cols / (2 * cam.planeLength);
    const horizon = rows * 0.5 + cam.pitch;

    this.cellDepth = world.terrain;
    if (world.terrain) {
      this.drawTerrain(world, cam, cols, rows, projY, horizon);
    } else {
      this.castColumns(world, cam, cols, rows, projY, horizon);
      this.drawFloorAndCeiling(world, cam, cols, rows, projY, horizon);
      this.drawWalls(world, cam, cols, rows, projY, horizon);
    }
    const sprites = this.drawSprites(world, cam, cols, rows, projX, projY, horizon);

    this.stats.cols = cols;
    this.stats.rows = rows;
    this.stats.rays = cols;
    this.stats.sprites = sprites;
    this.stats.ms = performance.now() - t0;
    return this.stats;
  }

  // ------------------------------------------------------------- pass 1

  private castColumns(
    world: World,
    cam: Camera,
    cols: number,
    rows: number,
    projY: number,
    horizon: number,
  ): void {
    for (let x = 0; x < cols; x++) {
      const cameraX = (2 * (x + 0.5)) / cols - 1;
      const rdx = cam.dirX + cam.planeX * cameraX;
      const rdy = cam.dirY + cam.planeY * cameraX;
      const hit = this.hits[x];
      castRay(world, cam.x, cam.y, rdx, rdy, MAX_DIST, hit);

      if (hit.hit) {
        this.zbuf[x] = hit.dist;
        this.rayX[x] = hit.wx;
        this.rayY[x] = hit.wy;
        const lineH = projY / hit.dist;
        // Projected from the actual eye height rather than assumed to be
        // centred, so a jump moves walls, floor and ceiling together.
        const top = horizon + (projY * (cam.z - 1)) / hit.dist;
        const bot = horizon + (projY * cam.z) / hit.dist;
        // A row is covered when its centre falls inside the wall span.
        this.wallTop[x] = Math.max(0, Math.ceil(top - 0.5));
        this.wallBot[x] = Math.min(rows - 1, Math.floor(bot - 0.5));
      } else {
        this.zbuf[x] = Infinity;
        this.rayX[x] = cam.x + rdx * MAX_DIST;
        this.rayY[x] = cam.y + rdy * MAX_DIST;
        this.wallTop[x] = rows; // covers nothing
        this.wallBot[x] = -1;
      }
    }
  }

  // ------------------------------------------------------------- pass 2

  /**
   * Floors and ceilings are cast row by row rather than per pixel: every cell
   * in a screen row sits at the same world distance, so one division per row
   * plus a linear walk across it gives exact world coordinates.
   */
  private drawFloorAndCeiling(
    world: World,
    cam: Camera,
    cols: number,
    rows: number,
    projY: number,
    horizon: number,
  ): void {
    const buf = this.buf;
    const acc = this.accum;
    const exposure = world.exposure;

    const dirX = cam.dirX;
    const dirY = cam.dirY;
    const planeX = cam.planeX;
    const planeY = cam.planeY;

    for (let y = 0; y < rows; y++) {
      const p = y + 0.5 - horizon;
      const isFloor = p > 0;
      const ap = Math.abs(p);

      // Distance to the floor is set by how far the eye is above it; to the
      // ceiling, by how far it is below that. At eye height 0.5 these are
      // equal, which is why a fixed constant worked until the eye could move.
      const eyeToPlane = isFloor ? cam.z : 1 - cam.z;
      let rowDist = ap < 1e-3 ? MAX_DIST : (projY * eyeToPlane) / ap;
      const beyond = rowDist >= MAX_DIST;
      if (beyond) rowDist = MAX_DIST;

      const wx0 = cam.x + rowDist * (dirX - planeX);
      const wy0 = cam.y + rowDist * (dirY - planeY);
      const stepX = (rowDist * 2 * planeX) / cols;
      const stepY = (rowDist * 2 * planeY) / cols;

      let wx = wx0 + stepX * 0.5;
      let wy = wy0 + stepY * 0.5;

      const kind = isFloor ? KIND_FLOOR : KIND_CEILING;
      const z = isFloor ? 0 : 1;

      for (let x = 0; x < cols; x++, wx += stepX, wy += stepY) {
        if (y >= this.wallTop[x] && y <= this.wallBot[x]) continue;

        const tile = world.tileAt(Math.floor(wx), Math.floor(wy));

        // Looking up through a hole in the roof, or off the edge of the map.
        if (!isFloor && (beyond || !tile || tile.sky)) {
          const cameraX = (2 * (x + 0.5)) / cols - 1;
          this.writeSky(world, buf, x, y, dirX + planeX * cameraX, dirY + planeY * cameraX, -p, rows);
          continue;
        }

        if (beyond || !tile) {
          // Far floor: nothing but fog.
          const fr = world.fogColor.r / 255;
          const fg = world.fogColor.g / 255;
          const fb = world.fogColor.b / 255;
          buf.write(x, y, kind, toneMap(fr, exposure), toneMap(fg, exposure), toneMap(fb, exposure));
          continue;
        }

        const mat = isFloor ? tile.floor : tile.ceiling;
        const tex = sampleTexture(mat, wx, wy) * tile.ao;

        surfaceLight(world, wx, wy, z, 0, 0, acc);

        const base = mat.color;
        acc.r = (base.r / 255) * (acc.r * tex + mat.emissive);
        acc.g = (base.g / 255) * (acc.g * tex + mat.emissive);
        acc.b = (base.b / 255) * (acc.b * tex + mat.emissive);

        applyFog(world, rowDist, acc);
        buf.write(
          x,
          y,
          kind,
          toneMap(acc.r, exposure),
          toneMap(acc.g, exposure),
          toneMap(acc.b, exposure),
          mat.glyphSlot,
          glyphSeed(wx, wy),
        );
      }
    }
  }

  private writeSky(
    world: World,
    buf: CellBuffer,
    x: number,
    y: number,
    rdx: number,
    rdy: number,
    p: number,
    rows: number,
  ): void {
    const el = Math.min(1, Math.max(0, p / (rows * 0.55)));
    const s = el * el * (3 - 2 * el);
    const top = world.skyTop;
    const hz = world.skyHorizon;
    let r = (hz.r + (top.r - hz.r) * s) / 255;
    let g = (hz.g + (top.g - hz.g) * s) / 255;
    let b = (hz.b + (top.b - hz.b) * s) / 255;

    // Stars are hashed on view direction, not on screen position, so they stay
    // pinned to the sky as you turn instead of sliding with the viewport.
    if (world.starDensity > 0) {
      const az = Math.atan2(rdy, rdx);
      const iu = Math.floor((az / (Math.PI * 2) + 0.5) * 1600);
      const iv = Math.floor(p * 1.6);
      const cutoff = 1 - world.starDensity * 0.05;
      const n = hash2(iu, iv);
      if (n > cutoff) {
        const bright = 0.25 + ((n - cutoff) / (1 - cutoff)) * 0.85 * s;
        r += bright;
        g += bright;
        b += bright * 1.06;
      }
    }

    const e = world.exposure;
    buf.write(x, y, KIND_SKY, toneMap(r, e), toneMap(g, e), toneMap(b, e), GS_SKY);
  }

  // ------------------------------------------------------------- pass 3

  private drawWalls(
    world: World,
    cam: Camera,
    cols: number,
    rows: number,
    projY: number,
    horizon: number,
  ): void {
    const buf = this.buf;
    const exposure = world.exposure;
    const top3 = this.accTop;
    const mid3 = this.accMid;
    const bot3 = this.accBot;

    for (let x = 0; x < cols; x++) {
      const hit = this.hits[x];
      if (!hit.hit) continue;

      const lineH = projY / hit.dist;
      const wTop = horizon + (projY * (cam.z - 1)) / hit.dist;
      const yStart = this.wallTop[x];
      const yEnd = this.wallBot[x];
      if (yEnd < yStart) continue;

      const mat = hit.material;
      const base = mat.color;
      const kind = hit.isDoor ? KIND_DOOR : KIND_WALL;

      // Sample lighting at three heights on this column and interpolate. One
      // sample per column would flatten the wall; one per cell would cost 30x
      // more for detail nobody can see at this resolution.
      surfaceLight(world, hit.wx, hit.wy, 1, hit.nx, hit.ny, top3);
      surfaceLight(world, hit.wx, hit.wy, 0.5, hit.nx, hit.ny, mid3);
      surfaceLight(world, hit.wx, hit.wy, 0, hit.nx, hit.ny, bot3);

      const fogF = world.fogDensity > 0 ? 1 - Math.exp(-hit.dist * world.fogDensity) : 0;
      const fr = world.fogColor.r / 255;
      const fg = world.fogColor.g / 255;
      const fb = world.fogColor.b / 255;

      for (let y = yStart; y <= yEnd; y++) {
        const v = (y + 0.5 - wTop) / lineH; // 0 at the ceiling, 1 at the floor

        let lr: number;
        let lg: number;
        let lb: number;
        if (v < 0.5) {
          const t = v * 2;
          lr = top3.r + (mid3.r - top3.r) * t;
          lg = top3.g + (mid3.g - top3.g) * t;
          lb = top3.b + (mid3.b - top3.b) * t;
        } else {
          const t = (v - 0.5) * 2;
          lr = mid3.r + (bot3.r - mid3.r) * t;
          lg = mid3.g + (bot3.g - mid3.g) * t;
          lb = mid3.b + (bot3.b - mid3.b) * t;
        }

        // Contact shading where the wall meets floor and ceiling.
        const edge = v < 0.5 ? v : 1 - v;
        const contact = edge >= 0.14 ? 1 : 0.72 + (edge / 0.14) * 0.28;

        const tex = sampleTexture(mat, hit.u, v) * contact;

        let r = (base.r / 255) * (lr * tex + mat.emissive);
        let g = (base.g / 255) * (lg * tex + mat.emissive);
        let b = (base.b / 255) * (lb * tex + mat.emissive);

        if (fogF > 0) {
          r += (fr - r) * fogF;
          g += (fg - g) * fogF;
          b += (fb - b) * fogF;
        }

        buf.write(
          x,
          y,
          kind,
          toneMap(r, exposure),
          toneMap(g, exposure),
          toneMap(b, exposure),
          mat.glyphSlot,
          glyphSeed(hit.u, v),
        );
      }
    }
  }

  // ------------------------------------------------------- terrain pass

  /**
   * Non-level ground, drawn with a y-buffer.
   *
   * The flat-floor passes cast by screen *row*, which works only because every
   * cell in a row sits at the same distance — true of a level floor and false
   * of a hillside. So terrain marches per *column* instead, front to back,
   * where each cell contributes at most two things: a vertical face where the
   * ground steps up from the cell before it, and its top surface spanning the
   * distances the ray spends inside it.
   *
   * The coverage mask records which rows of a column are resolved. It only
   * screen, so occlusion needs no depth compare: standing on a plateau, the
   * valley immediately below the edge is hidden simply because those rows were
   * already covered, and it reappears further out exactly where the line of
   * sight clears the lip. Whatever rows remain at the end are sky.
   */
  private drawTerrain(
    world: World,
    cam: Camera,
    cols: number,
    rows: number,
    projY: number,
    horizon: number,
  ): void {
    const buf = this.buf;
    const acc = this.accum;
    const exposure = world.exposure;
    const camZ = cam.z;
    const depth = this.depth;
    depth.fill(Infinity);

    const fogR = world.fogColor.r / 255;
    const fogG = world.fogColor.g / 255;
    const fogB = world.fogColor.b / 255;
    const sunR = world.sunColor.r / 255;
    const sunG = world.sunColor.g / 255;
    const sunB = world.sunColor.b / 255;

    for (let x = 0; x < cols; x++) {
      const cameraX = (2 * (x + 0.5)) / cols - 1;
      const rdx = cam.dirX + cam.planeX * cameraX;
      const rdy = cam.dirY + cam.planeY * cameraX;

      let mapX = Math.floor(cam.x);
      let mapY = Math.floor(cam.y);
      const deltaX = rdx === 0 ? Infinity : Math.abs(1 / rdx);
      const deltaY = rdy === 0 ? Infinity : Math.abs(1 / rdy);

      let stepX: number;
      let stepY: number;
      let sideDistX: number;
      let sideDistY: number;
      if (rdx < 0) {
        stepX = -1;
        sideDistX = (cam.x - mapX) * deltaX;
      } else {
        stepX = 1;
        sideDistX = (mapX + 1 - cam.x) * deltaX;
      }
      if (rdy < 0) {
        stepY = -1;
        sideDistY = (cam.y - mapY) * deltaY;
      } else {
        stepY = 1;
        sideDistY = (mapY + 1 - cam.y) * deltaY;
      }

      const here = world.tileAt(mapX, mapY);
      let prevH = here ? here.height : 0;
      let dNear = 0;
      let side = 0;
      // Rows still to resolve in this column.
      const done = this.doneRows;
      done.fill(0);
      let remaining = rows;

      this.rayX[x] = cam.x + rdx * TERRAIN_MAX_DIST;
      this.rayY[x] = cam.y + rdy * TERRAIN_MAX_DIST;

      for (let guard = 0; guard < 600 && remaining > 0; guard++) {
        const alongX = sideDistX < sideDistY;
        let dFar = alongX ? sideDistX : sideDistY;
        if (dFar > TERRAIN_MAX_DIST) dFar = TERRAIN_MAX_DIST;

        const tile = world.tileAt(mapX, mapY);
        if (!tile) break;
        const h = tile.height;

        // ---- the vertical face where the ground steps up
        if (h > prevH && dNear > 0.02) {
          const rowTop = horizon + (projY * (camZ - h)) / dNear;
          const rowBot = horizon + (projY * (camZ - prevH)) / dNear;
          const y0 = Math.max(0, Math.ceil(rowTop - 0.5));
          const y1 = Math.min(rows - 1, Math.floor(rowBot - 0.5));
          if (y1 >= y0) {
            const wx = cam.x + rdx * dNear;
            const wy = cam.y + rdy * dNear;
            const upper = tile.side ?? tile.floor;
            const lower = tile.sideLower;
            const nx = side === 0 ? -stepX : 0;
            const ny = side === 0 ? 0 : -stepY;
            const u = side === 0 ? wy : wx;
            const fogF = world.fogDensity > 0 ? 1 - Math.exp(-dNear * world.fogDensity) : 0;
            const sun = sunLight(world, nx, ny, 0);

            for (let y = y0; y <= y1; y++) {
              if (done[y]) continue;
              done[y] = 1;
              remaining--;
              const zAt = camZ - ((y + 0.5 - horizon) * dNear) / projY;
              // The ground floor is its own material: a facade in one skin from
              // pavement to roof reads as an extruded block, not a building.
              const mat = lower !== null && zAt < tile.bandZ ? lower : upper;
              // Window and sign glow rises as the light goes, so a street lights
              // up at dusk without spending anything from the light budget.
              const glow = mat.emissive + mat.nightGlow * world.windowGlow;
              const tex = sampleTexture(mat, u, zAt);
              surfaceLight(world, wx, wy, zAt, nx, ny, acc);
              let r = (mat.color.r / 255) * ((acc.r + sunR * sun) * tex + glow);
              let g = (mat.color.g / 255) * ((acc.g + sunG * sun) * tex + glow);
              let b = (mat.color.b / 255) * ((acc.b + sunB * sun) * tex + glow);
              if (fogF > 0) {
                r += (fogR - r) * fogF;
                g += (fogG - g) * fogF;
                b += (fogB - b) * fogF;
              }
              buf.write(
                x,
                y,
                KIND_WALL,
                toneMap(r, exposure),
                toneMap(g, exposure),
                toneMap(b, exposure),
                mat.glyphSlot,
                glyphSeed(u, zAt),
              );
              depth[y * cols + x] = dNear;
            }
          }
        }

        // ---- the top surface, only ever visible from above it
        if (h < camZ - 0.002 && remaining > 0) {
          const rise = projY * (camZ - h);
          const rowFar = horizon + rise / Math.max(dFar, 1e-4);
          const rowNear = dNear > 0.02 ? horizon + rise / dNear : rows * 8;
          const y0 = Math.max(0, Math.ceil(rowFar - 0.5));
          const y1 = Math.min(rows - 1, Math.floor(rowNear - 0.5));
          if (y1 >= y0) {
            const mat = tile.floor;
            const sun = sunLight(world, tile.nx, tile.ny, tile.nz);
            // A lake is flat, so the diffuse sun term paints every cell of it
            // the same colour and it reads as a hole rather than a surface.
            // The glint is what says "water": a view-dependent highlight, so
            // it slides across the pool as you walk — the one place in this
            // renderer where something moving is the correct answer.
            const glinty = tile.water && world.sunIntensity > 0;
            for (let y = y0; y <= y1; y++) {
              if (done[y]) continue;
              const p = y + 0.5 - horizon;
              if (p <= 0.02) continue; // above the horizon: not this surface
              done[y] = 1;
              remaining--;
              // Invert the projection for this row. Sampling once per span
              // instead looks fine on the flat and smears badly on a slope.
              const d = rise / p;
              const wx = cam.x + rdx * d;
              const wy = cam.y + rdy * d;
              const tex = sampleTexture(mat, wx, wy);
              surfaceLight(world, wx, wy, h, 0, 0, acc);

              let lit = sun;
              if (glinty) {
                // Half-vector against a flat-up normal, so only its z matters.
                const vz = (camZ - h) / d;
                const inv = 1 / Math.hypot(1, vz);
                const hx = world.sunX - rdx * inv;
                const hy = world.sunY - rdy * inv;
                const hz = world.sunZ + vz * inv;
                const hl = Math.hypot(hx, hy, hz) || 1;
                let s = hz / hl;
                if (s > 0) {
                  s *= s;
                  s *= s;
                  s *= s;
                  s *= s; // ^16: a tight, bright band rather than a broad sheen
                  lit += world.sunIntensity * s * 2.6;
                }
              }

              const fogF = world.fogDensity > 0 ? 1 - Math.exp(-d * world.fogDensity) : 0;
              let r = (mat.color.r / 255) * ((acc.r + sunR * lit) * tex + mat.emissive);
              let g = (mat.color.g / 255) * ((acc.g + sunG * lit) * tex + mat.emissive);
              let b = (mat.color.b / 255) * ((acc.b + sunB * lit) * tex + mat.emissive);
              if (fogF > 0) {
                r += (fogR - r) * fogF;
                g += (fogG - g) * fogF;
                b += (fogB - b) * fogF;
              }
              buf.write(
                x,
                y,
                KIND_FLOOR,
                toneMap(r, exposure),
                toneMap(g, exposure),
                toneMap(b, exposure),
                mat.glyphSlot,
                glyphSeed(wx, wy),
              );
              depth[y * cols + x] = d;
            }
          }
        }

        if (alongX) {
          sideDistX += deltaX;
          mapX += stepX;
          side = 0;
        } else {
          sideDistY += deltaY;
          mapY += stepY;
          side = 1;
        }
        dNear = dFar;
        prevH = h;
        if (dNear >= TERRAIN_MAX_DIST) break;
      }

      for (let y = 0; y < rows; y++) {
        if (done[y]) continue;
        this.writeSky(world, buf, x, y, rdx, rdy, horizon - (y + 0.5), rows);
      }
    }
  }

  // ------------------------------------------------------------- pass 4

  private drawSprites(
    world: World,
    cam: Camera,
    cols: number,
    rows: number,
    projX: number,
    projY: number,
    horizon: number,
  ): number {
    const buf = this.buf;
    const acc = this.accum;
    const exposure = world.exposure;

    const invDet = 1 / (cam.planeX * cam.dirY - cam.dirX * cam.planeY);

    this.drawList.length = 0;
    for (let i = 0; i < world.entities.length; i++) {
      const e = world.entities[i];
      const dx = e.x - cam.x;
      const dy = e.y - cam.y;
      this.drawList.push({ index: i, depth: dx * dx + dy * dy });
    }
    // Painter's order: far first, so nearer sprites overwrite them.
    this.drawList.sort((a, b) => b.depth - a.depth);

    let drawn = 0;

    for (const item of this.drawList) {
      const e = world.entities[item.index];
      const def = e.def;

      // Pick the view. Anything with a heading is drawn from its long side or
      // its end, whichever the viewer is nearer to, so a bus stops swinging
      // its flank round to face you as you walk past it.
      let art = def.art;
      let spriteW = def.width * e.scale;
      if (def.endArt && (e.dirX !== 0 || e.dirY !== 0)) {
        const vx = e.x - cam.x;
        const vy = e.y - cam.y;
        const vlen = Math.hypot(vx, vy) || 1;
        const align = Math.abs((e.dirX * vx + e.dirY * vy) / vlen);
        if (align > 0.5) {
          art = def.endArt;
          spriteW = (def.endWidth ?? def.width) * e.scale;
        }
      }

      const sx = e.x - cam.x;
      const sy = e.y - cam.y;
      const tX = invDet * (cam.dirY * sx - cam.dirX * sy);
      const tY = invDet * (-cam.planeY * sx + cam.planeX * sy);
      if (tY <= 0.12 || tY > MAX_DIST) continue;

      const screenX = (cols / 2) * (1 + tX / tY);
      const halfW = (projX * (spriteW / 2)) / tY;
      const colL = screenX - halfW;
      const colR = screenX + halfW;
      if (colR < 0 || colL >= cols) continue;

      const bob = e.bob > 0 ? Math.sin(world.time * 1.9 + e.bobPhase) * e.bob : 0;
      // e.z is the ground the sprite stands on: 0 indoors, the terrain height
      // outdoors, so a tree on a hilltop is drawn on the hilltop.
      const zBottom = e.z + def.base + bob;
      const zTop = zBottom + def.height * e.scale;
      const rowB = horizon + (projY * (cam.z - zBottom)) / tY;
      const rowT = horizon + (projY * (cam.z - zTop)) / tY;
      if (rowB < 0 || rowT >= rows) continue;

      const artH = art.length;
      const artW = art[0].length;
      const spanX = colR - colL;
      const spanY = rowB - rowT;
      if (spanX <= 0 || spanY <= 0) continue;

      // Billboards face the camera, so light them against the view normal.
      surfaceLight(world, e.x, e.y, zBottom + def.height * 0.5, -cam.dirX, -cam.dirY, acc);

      // Outdoors the sun does nearly all the lighting, and a sprite that only
      // collects ambient reads as a black cut-out against a sunlit hillside.
      // A billboard has no real normal to shade with, so it takes a flat share
      // of the sun — matched to what level ground collects, so lowering the sun
      // dims the trees along with the fields rather than leaving them glowing.
      if (world.sunIntensity > 0) {
        const s = sunLight(world, 0, 0, 1) * 0.85;
        acc.r += (world.sunColor.r / 255) * s;
        acc.g += (world.sunColor.g / 255) * s;
        acc.b += (world.sunColor.b / 255) * s;
      }

      const fogF = world.fogDensity > 0 ? 1 - Math.exp(-tY * world.fogDensity) : 0;
      const fr = world.fogColor.r / 255;
      const fg = world.fogColor.g / 255;
      const fb = world.fogColor.b / 255;

      const tint = e.tint ?? def.color;
      const cr = tint.r / 255;
      const cg = tint.g / 255;
      const cb = tint.b / 255;
      // A signal tints only its lamp; everything else tints whole.
      const litOnly = def.tintLitOnly === true && e.tint !== null;
      const br = def.color.r / 255;
      const bg = def.color.g / 255;
      const bb = def.color.b / 255;

      // Sway is a shear, not a shift: the offset scales with height up the
      // sprite so the foot stays planted and the crown moves.
      const swayCols =
        e.sway > 0
          ? (Math.sin(world.time * 1.15 + e.bobPhase) * e.sway * artW) / Math.max(0.01, spriteW)
          : 0;

      const xStart = Math.max(0, Math.ceil(colL - 0.5));
      const xEnd = Math.min(cols - 1, Math.floor(colR - 0.5));
      const yStart = Math.max(0, Math.ceil(rowT - 0.5));
      const yEnd = Math.min(rows - 1, Math.floor(rowB - 0.5));

      let touched = false;

      for (let x = xStart; x <= xEnd; x++) {
        if (!this.cellDepth && tY >= this.zbuf[x]) continue; // hidden behind geometry
        const auBase = ((x + 0.5 - colL) / spanX) * artW;
        let au = Math.floor(auBase);
        if (au < 0) au = 0;
        else if (au >= artW) au = artW - 1;

        for (let y = yStart; y <= yEnd; y++) {
          // Outdoors every row of a column sits at its own distance, so the
          // test has to be per cell rather than per column.
          if (this.cellDepth && tY >= this.depth[y * cols + x]) continue;
          const avf = ((y + 0.5 - rowT) / spanY) * artH;
          let av = Math.floor(avf);
          if (av < 0) av = 0;
          else if (av >= artH) av = artH - 1;

          let ax = au;
          if (swayCols !== 0) {
            // 1 at the crown, 0 at the foot.
            const lean = swayCols * (1 - avf / artH);
            ax = Math.floor(auBase - lean);
            if (ax < 0 || ax >= artW) continue;
          }

          const row = art[av];
          const ch = ax < row.length ? row[ax] : ' ';
          const density = DENSITY_CHARS[ch];
          if (density === undefined || density < 0) continue;

          // Headlights and the like: lit only once it is dark, on the same
          // clock the windows and lamps read.
          const nightLit = (def.nightGlow ?? 0) * world.windowGlow;
          const selfLit = ch === '@' ? def.emissive + nightLit : def.emissive * 0.25;

          // Art density scales the colour rather than picking a glyph
          // directly, which lets the shared shading stage choose the character
          // and keeps sprites reacting to light exactly like walls do.
          const lit = !litOnly || ch === '@';
          let r = (lit ? cr : br) * (acc.r * density + selfLit);
          let g = (lit ? cg : bg) * (acc.g * density + selfLit);
          let b = (lit ? cb : bb) * (acc.b * density + selfLit);

          if (fogF > 0) {
            r += (fr - r) * fogF;
            g += (fg - g) * fogF;
            b += (fb - b) * fogF;
          }

          buf.write(
            x,
            y,
            KIND_SPRITE,
            toneMap(r, exposure),
            toneMap(g, exposure),
            toneMap(b, exposure),
            def.glyphSlot,
            // Welded to the art cell, so a sprite's texture is perfectly still
            // however it moves on screen. Offset by the entity so two trees
            // side by side are not the same tree twice.
            cellSeed(au + e.index * 13, av),
          );
          touched = true;
        }
      }

      if (touched) drawn++;
    }

    return drawn;
  }
}
