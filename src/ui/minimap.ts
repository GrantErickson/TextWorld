import type { Camera } from '../engine/camera.ts';
import type { Renderer } from '../engine/renderer.ts';
import type { World } from '../engine/world.ts';
import { TILE_DOOR, TILE_EMPTY, TILE_WALL } from '../engine/types.ts';
import { DOOR_PASSABLE } from '../engine/world.ts';
import { flickerFactor } from '../engine/lighting.ts';

/** Top-down view of the world with the camera's ray fan drawn over it. */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 8;
  private offX = 0;
  private offY = 0;
  /** Tile coordinates of the drawn region's top-left corner. */
  private viewX = 0;
  private viewY = 0;
  private viewW = 1;
  private viewH = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx;
  }

  /**
   * Choose the region to draw. A fixed map is shown whole; a streamed one has
   * no "whole", so it gets a window centred on the player — which also keeps
   * the scale readable instead of shrinking as the world grows.
   */
  private chooseView(world: World, cam: Camera): void {
    if (!world.infinite) {
      this.viewX = world.originX;
      this.viewY = world.originY;
      this.viewW = world.width;
      this.viewH = world.height;
      return;
    }
    const span = Math.min(world.width, 56);
    this.viewW = span;
    this.viewH = span;
    // Follow in whole tiles: a fractional origin would make the whole map
    // shimmer as the player walks.
    this.viewX = Math.round(cam.x) - (span >> 1);
    this.viewY = Math.round(cam.y) - (span >> 1);
  }

  private layout(world: World): void {
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.floor(this.canvas.getBoundingClientRect().width));
    const scale = Math.max(2, Math.floor((cssW / this.viewW) * dpr) / dpr);
    const cssH = Math.ceil(scale * this.viewH);

    const pxW = Math.floor(cssW * dpr);
    const pxH = Math.floor(cssH * dpr);
    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
      this.canvas.style.height = `${cssH}px`;
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.scale = scale;
    this.offX = (cssW - scale * this.viewW) / 2 - this.viewX * scale;
    this.offY = -this.viewY * scale;
  }

  draw(world: World, cam: Camera, renderer: Renderer, showRays: boolean): void {
    this.chooseView(world, cam);
    this.layout(world);
    const ctx = this.ctx;
    const s = this.scale;
    // Offsets already fold in the view origin, so everything below can be
    // drawn straight from absolute world coordinates.
    const ox = this.offX;
    const oy = this.offY;

    ctx.fillStyle = '#070a0f';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Tiles.
    for (let y = this.viewY; y < this.viewY + this.viewH; y++) {
      for (let x = this.viewX; x < this.viewX + this.viewW; x++) {
        const t = world.tileAt(x, y);
        if (!t) continue;
        if (t.type === TILE_EMPTY) {
          const v = Math.round(26 + t.ao * 22);
          ctx.fillStyle = `rgb(${v},${v + 3},${v + 7})`;
        } else if (t.type === TILE_WALL) {
          const c = t.wall!.color;
          ctx.fillStyle = `rgb(${Math.round(c.r * 0.55)},${Math.round(c.g * 0.55)},${Math.round(c.b * 0.55)})`;
        } else if (t.type === TILE_DOOR) {
          const d = world.doors[t.doorId];
          ctx.fillStyle = d.openness >= DOOR_PASSABLE ? '#2c6b52' : '#b8863c';
        } else {
          continue;
        }
        ctx.fillRect(ox + x * s, oy + y * s, s, s);
      }
    }

    // Light pools, so the map explains what the viewport is showing.
    ctx.globalCompositeOperation = 'lighter';
    for (const l of world.lights) {
      const f = flickerFactor(l, world.time);
      const cx = ox + l.x * s;
      const cy = oy + l.y * s;
      const r = l.radius * s * 0.85;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r));
      const a = Math.min(0.5, 0.26 * l.intensity * f);
      grad.addColorStop(0, `rgba(${l.color.r},${l.color.g},${l.color.b},${a})`);
      grad.addColorStop(1, `rgba(${l.color.r},${l.color.g},${l.color.b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Ray fan.
    if (showRays && renderer.rayX.length > 0) {
      ctx.strokeStyle = 'rgba(111, 210, 192, 0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(renderer.rayX.length / 64));
      for (let i = 0; i < renderer.rayX.length; i += step) {
        ctx.moveTo(ox + cam.x * s, oy + cam.y * s);
        ctx.lineTo(ox + renderer.rayX[i] * s, oy + renderer.rayY[i] * s);
      }
      ctx.stroke();
    }

    // View cone.
    const left = cam.angle - Math.atan(cam.planeLength);
    const right = cam.angle + Math.atan(cam.planeLength);
    const reach = 5 * s;
    ctx.fillStyle = 'rgba(111, 210, 192, 0.10)';
    ctx.beginPath();
    ctx.moveTo(ox + cam.x * s, oy + cam.y * s);
    ctx.arc(ox + cam.x * s, oy + cam.y * s, reach, left, right);
    ctx.closePath();
    ctx.fill();

    // Entities.
    for (const e of world.entities) {
      const c = e.def.color;
      ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`;
      ctx.beginPath();
      ctx.arc(ox + e.x * s, oy + e.y * s, Math.max(1.4, s * 0.2), 0, Math.PI * 2);
      ctx.fill();
    }

    // Player.
    const px = ox + cam.x * s;
    const py = oy + cam.y * s;
    const nose = Math.max(4, s * 0.62);
    ctx.fillStyle = '#eaf6f2';
    ctx.beginPath();
    ctx.moveTo(px + Math.cos(cam.angle) * nose, py + Math.sin(cam.angle) * nose);
    ctx.lineTo(
      px + Math.cos(cam.angle + 2.5) * nose * 0.7,
      py + Math.sin(cam.angle + 2.5) * nose * 0.7,
    );
    ctx.lineTo(
      px + Math.cos(cam.angle - 2.5) * nose * 0.7,
      py + Math.sin(cam.angle - 2.5) * nose * 0.7,
    );
    ctx.closePath();
    ctx.fill();
  }
}
