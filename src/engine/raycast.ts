import type { Material } from './types.ts';
import { TILE_DOOR, TILE_WALL } from './types.ts';
import type { World } from './world.ts';

export interface RayHit {
  hit: boolean;
  /** Perpendicular distance, already free of the fisheye artefact. */
  dist: number;
  /** World-space intersection point. */
  wx: number;
  wy: number;
  /** Tile containing the surface. */
  tx: number;
  ty: number;
  /** Open tile the ray was in when it hit; used to sample shadow fields. */
  fx: number;
  fy: number;
  /** 0 = the face normal points along X, 1 = along Y. */
  side: 0 | 1;
  /** Continuous world coordinate along the face, so textures span tiles. */
  u: number;
  material: Material;
  nx: number;
  ny: number;
  isDoor: boolean;
}

export function makeHit(): RayHit {
  return {
    hit: false,
    dist: 0,
    wx: 0,
    wy: 0,
    tx: 0,
    ty: 0,
    fx: 0,
    fy: 0,
    side: 0,
    u: 0,
    material: null as unknown as Material,
    nx: 0,
    ny: 0,
    isDoor: false,
  };
}

/**
 * Grid-marching raycast (DDA).
 *
 * `rdx`/`rdy` are the unnormalised camera-plane ray direction, so the
 * parameter `t` at which the ray meets a surface *is* the perpendicular
 * distance — no extra cosine correction is needed anywhere downstream.
 *
 * Results are written into `out` to keep the per-frame allocation count flat.
 */
export function castRay(
  world: World,
  px: number,
  py: number,
  rdx: number,
  rdy: number,
  maxDist: number,
  out: RayHit,
): boolean {
  out.hit = false;

  let mapX = Math.floor(px);
  let mapY = Math.floor(py);

  const deltaX = rdx === 0 ? Infinity : Math.abs(1 / rdx);
  const deltaY = rdy === 0 ? Infinity : Math.abs(1 / rdy);

  let stepX: number;
  let stepY: number;
  let sideDistX: number;
  let sideDistY: number;

  if (rdx < 0) {
    stepX = -1;
    sideDistX = (px - mapX) * deltaX;
  } else {
    stepX = 1;
    sideDistX = (mapX + 1 - px) * deltaX;
  }
  if (rdy < 0) {
    stepY = -1;
    sideDistY = (py - mapY) * deltaY;
  } else {
    stepY = 1;
    sideDistY = (mapY + 1 - py) * deltaY;
  }

  // The DDA loop steps before it tests, so the starting cell is never examined.
  // That is right for walls (you cannot stand in one) but wrong for doors: the
  // player can be standing inside an open door's tile.
  const start = world.tileAt(mapX, mapY);
  if (start && start.type === TILE_DOOR) {
    if (testDoor(world, mapX, mapY, px, py, rdx, rdy, mapX, mapY, out)) return true;
  }

  let prevX = mapX;
  let prevY = mapY;
  let side: 0 | 1 = 0;

  for (let guard = 0; guard < 512; guard++) {
    prevX = mapX;
    prevY = mapY;

    if (sideDistX < sideDistY) {
      sideDistX += deltaX;
      mapX += stepX;
      side = 0;
    } else {
      sideDistY += deltaY;
      mapY += stepY;
      side = 1;
    }

    const dist = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
    if (dist > maxDist) return false;

    const tile = world.tileAt(mapX, mapY);
    if (!tile) return false;

    if (tile.type === TILE_WALL) {
      out.hit = true;
      out.dist = Math.max(dist, 1e-4);
      out.wx = px + out.dist * rdx;
      out.wy = py + out.dist * rdy;
      out.tx = mapX;
      out.ty = mapY;
      out.fx = prevX;
      out.fy = prevY;
      out.side = side;
      // Continuous world coordinate along the face keeps brick courses lined
      // up from one tile to the next instead of restarting every tile.
      out.u = side === 0 ? out.wy : out.wx;
      out.material = tile.wall!;
      out.nx = side === 0 ? -stepX : 0;
      out.ny = side === 0 ? 0 : -stepY;
      out.isDoor = false;
      return true;
    }

    if (tile.type === TILE_DOOR) {
      if (testDoor(world, mapX, mapY, px, py, rdx, rdy, prevX, prevY, out)) return true;
    }
  }

  return false;
}

/**
 * Doors are thin panels on the centre line of their tile rather than solid
 * blocks, so an open door leaves a real gap you can see and shoot light
 * through. The panel occupies [openness, 1] of the cell along its axis and its
 * texture slides with it.
 */
function testDoor(
  world: World,
  tx: number,
  ty: number,
  px: number,
  py: number,
  rdx: number,
  rdy: number,
  fx: number,
  fy: number,
  out: RayHit,
): boolean {
  const tile = world.tileAt(tx, ty)!;
  const door = world.doors[tile.doorId];
  if (!door || door.openness >= 0.999) return false;

  if (door.axis === 'x') {
    // Panel spans X, sitting on the plane y = ty + 0.5.
    if (rdy === 0) return false;
    const t = (ty + 0.5 - py) / rdy;
    if (t <= 0) return false;
    const hx = px + t * rdx;
    if (hx < tx || hx >= tx + 1) return false;
    const local = hx - tx;
    if (local < door.openness) return false;

    out.hit = true;
    out.dist = Math.max(t, 1e-4);
    out.wx = hx;
    out.wy = ty + 0.5;
    out.side = 1;
    out.u = tx + (local - door.openness);
    out.nx = 0;
    out.ny = rdy > 0 ? -1 : 1;
  } else {
    // Panel spans Y, sitting on the plane x = tx + 0.5.
    if (rdx === 0) return false;
    const t = (tx + 0.5 - px) / rdx;
    if (t <= 0) return false;
    const hy = py + t * rdy;
    if (hy < ty || hy >= ty + 1) return false;
    const local = hy - ty;
    if (local < door.openness) return false;

    out.hit = true;
    out.dist = Math.max(t, 1e-4);
    out.wx = tx + 0.5;
    out.wy = hy;
    out.side = 0;
    out.u = ty + (local - door.openness);
    out.nx = rdx > 0 ? -1 : 1;
    out.ny = 0;
  }

  out.tx = tx;
  out.ty = ty;
  out.fx = fx;
  out.fy = fy;
  out.material = door.material;
  out.isDoor = true;
  return true;
}

/** Cheap line-of-sight test between two world points. Used to bake shadows. */
export function hasLineOfSight(world: World, x0: number, y0: number, x1: number, y1: number): boolean {
  let mapX = Math.floor(x0);
  let mapY = Math.floor(y0);
  const endX = Math.floor(x1);
  const endY = Math.floor(y1);
  if (mapX === endX && mapY === endY) return true;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const deltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const deltaY = dy === 0 ? Infinity : Math.abs(1 / dy);

  let stepX: number;
  let stepY: number;
  let sideDistX: number;
  let sideDistY: number;

  if (dx < 0) {
    stepX = -1;
    sideDistX = (x0 - mapX) * deltaX;
  } else {
    stepX = 1;
    sideDistX = (mapX + 1 - x0) * deltaX;
  }
  if (dy < 0) {
    stepY = -1;
    sideDistY = (y0 - mapY) * deltaY;
  } else {
    stepY = 1;
    sideDistY = (mapY + 1 - y0) * deltaY;
  }

  for (let guard = 0; guard < 512; guard++) {
    if (sideDistX < sideDistY) {
      if (sideDistX > 1) return true; // past the target
      sideDistX += deltaX;
      mapX += stepX;
    } else {
      if (sideDistY > 1) return true;
      sideDistY += deltaY;
      mapY += stepY;
    }
    if (mapX === endX && mapY === endY) return true;
    if (world.blocksLight(mapX, mapY)) return false;
  }
  return false;
}
