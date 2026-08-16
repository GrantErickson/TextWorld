import type { Camera } from './camera.ts';
import type { World } from './world.ts';
import type { RayHit } from './raycast.ts';
import { castRay, makeHit } from './raycast.ts';
import { applyFog, ensureVisibility, makeAccum, surfaceLight } from './lighting.ts';
import type { LightAccum } from './lighting.ts';
import { hash2, sampleTexture } from './materials.ts';
import { DENSITY_CHARS } from './sprites.ts';
import {
  CellBuffer,
  KIND_CEILING,
  KIND_DOOR,
  KIND_FLOOR,
  KIND_SKY,
  KIND_SPRITE,
  KIND_WALL,
  toneMap,
} from './shading.ts';

/** Eye height above the floor, in tiles. Walls are one tile tall. */
const CAM_Z = 0.5;
const MAX_DIST = 44;

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

  /** World-space end point of each column's ray; drawn on the minimap. */
  rayX = new Float32Array(0);
  rayY = new Float32Array(0);

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

    ensureVisibility(world);

    // Vertical projection scale, in rows per tile at unit distance. Derived so
    // that a square in the world projects to a square on screen once the
    // non-square character cell is accounted for.
    const projY = (cols * cellAspect) / (2 * cam.planeLength);
    const projX = cols / (2 * cam.planeLength);
    const horizon = rows * 0.5 + cam.pitch;

    this.castColumns(world, cam, cols, rows, projY, horizon);
    this.drawFloorAndCeiling(world, cam, cols, rows, projY, horizon);
    this.drawWalls(world, cam, cols, rows, projY, horizon);
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
        const top = horizon - lineH * 0.5;
        const bot = horizon + lineH * 0.5;
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

      let rowDist = ap < 1e-3 ? MAX_DIST : (projY * CAM_Z) / ap;
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
    buf.write(x, y, KIND_SKY, toneMap(r, e), toneMap(g, e), toneMap(b, e));
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
      const wTop = horizon - lineH * 0.5;
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

        buf.write(x, y, kind, toneMap(r, exposure), toneMap(g, exposure), toneMap(b, exposure));
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

      const sx = e.x - cam.x;
      const sy = e.y - cam.y;
      const tX = invDet * (cam.dirY * sx - cam.dirX * sy);
      const tY = invDet * (-cam.planeY * sx + cam.planeX * sy);
      if (tY <= 0.12 || tY > MAX_DIST) continue;

      const screenX = (cols / 2) * (1 + tX / tY);
      const halfW = (projX * (def.width / 2)) / tY;
      const colL = screenX - halfW;
      const colR = screenX + halfW;
      if (colR < 0 || colL >= cols) continue;

      const bob = e.bob > 0 ? Math.sin(world.time * 1.9 + e.bobPhase) * e.bob : 0;
      const zBottom = def.base + bob;
      const zTop = zBottom + def.height;
      const rowB = horizon + (projY * (CAM_Z - zBottom)) / tY;
      const rowT = horizon + (projY * (CAM_Z - zTop)) / tY;
      if (rowB < 0 || rowT >= rows) continue;

      const artH = def.art.length;
      const artW = def.art[0].length;
      const spanX = colR - colL;
      const spanY = rowB - rowT;
      if (spanX <= 0 || spanY <= 0) continue;

      // Billboards face the camera, so light them against the view normal.
      surfaceLight(world, e.x, e.y, zBottom + def.height * 0.5, -cam.dirX, -cam.dirY, acc);

      const fogF = world.fogDensity > 0 ? 1 - Math.exp(-tY * world.fogDensity) : 0;
      const fr = world.fogColor.r / 255;
      const fg = world.fogColor.g / 255;
      const fb = world.fogColor.b / 255;

      const cr = def.color.r / 255;
      const cg = def.color.g / 255;
      const cb = def.color.b / 255;

      const xStart = Math.max(0, Math.ceil(colL - 0.5));
      const xEnd = Math.min(cols - 1, Math.floor(colR - 0.5));
      const yStart = Math.max(0, Math.ceil(rowT - 0.5));
      const yEnd = Math.min(rows - 1, Math.floor(rowB - 0.5));

      let touched = false;

      for (let x = xStart; x <= xEnd; x++) {
        if (tY >= this.zbuf[x]) continue; // hidden behind geometry
        let au = Math.floor(((x + 0.5 - colL) / spanX) * artW);
        if (au < 0) au = 0;
        else if (au >= artW) au = artW - 1;

        for (let y = yStart; y <= yEnd; y++) {
          let av = Math.floor(((y + 0.5 - rowT) / spanY) * artH);
          if (av < 0) av = 0;
          else if (av >= artH) av = artH - 1;

          const row = def.art[av];
          const ch = au < row.length ? row[au] : ' ';
          const density = DENSITY_CHARS[ch];
          if (density === undefined || density < 0) continue;

          const selfLit = ch === '@' ? def.emissive : def.emissive * 0.25;

          // Art density scales the colour rather than picking a glyph
          // directly, which lets the shared shading stage choose the character
          // and keeps sprites reacting to light exactly like walls do.
          let r = cr * (acc.r * density + selfLit);
          let g = cg * (acc.g * density + selfLit);
          let b = cb * (acc.b * density + selfLit);

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
          );
          touched = true;
        }
      }

      if (touched) drawn++;
    }

    return drawn;
  }
}
