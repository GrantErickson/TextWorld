import type { CellBuffer } from '../engine/shading.ts';
import { RAMP } from '../engine/shading.ts';

const FONT_STACK =
  "'Cascadia Mono', 'Cascadia Code', 'DejaVu Sans Mono', Consolas, 'Courier New', monospace";

/** Tiles in the pre-rendered glyph atlas before it is recycled. */
const ATLAS_COLS = 48;
const ATLAS_ROWS = 48;
const ATLAS_CAP = ATLAS_COLS * ATLAS_ROWS;

/**
 * Draws a grid of coloured characters to a canvas.
 *
 * Two things make this fast enough to run every frame at ~7000 cells:
 *
 *  - **Dirty-cell diffing.** Only cells whose glyph or colours actually
 *    changed are redrawn. This is where the renderer's stability work pays off
 *    a second time: a still camera redraws essentially nothing.
 *  - **A glyph atlas.** Every (glyph, colour) pair is rasterised once into an
 *    offscreen canvas and thereafter blitted with `drawImage`, which is
 *    markedly cheaper than re-shaping text with `fillText`.
 */
export class Display {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  cols = 0;
  rows = 0;
  cellW = 8;
  cellH = 16;
  cellAspect = 0.5;

  private dpr = 1;
  private fontSize = 14;
  private baseline = 12;

  private prevGlyph = new Uint8Array(0);
  private prevFg = new Int32Array(0);
  private prevBg = new Int32Array(0);
  private forceFull = true;

  private atlas: HTMLCanvasElement;
  private atlasCtx: CanvasRenderingContext2D;
  private atlasMap = new Map<number, number>();
  private atlasNext = 0;

  private cssCache = new Map<number, string>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx;

    this.atlas = document.createElement('canvas');
    const actx = this.atlas.getContext('2d');
    if (!actx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.atlasCtx = actx;
  }

  setFontSize(px: number): void {
    this.fontSize = px;
  }

  getFontSize(): number {
    return this.fontSize;
  }

  /**
   * Re-measure the font and resize the backing store to the element's box.
   * Returns true when the character grid dimensions changed.
   */
  layout(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));

    const pxW = Math.max(1, Math.floor(cssW * dpr));
    const pxH = Math.max(1, Math.floor(cssH * dpr));

    const fontPx = Math.max(4, Math.round(this.fontSize * dpr));
    const font = `${fontPx}px ${FONT_STACK}`;

    // Measure the full block: it defines the cell box exactly, so blocks tile
    // without seams and every other ramp glyph sits on the same grid.
    this.ctx.font = font;
    const m = this.ctx.measureText('█');
    let cw = Math.round(m.width);
    let asc = m.actualBoundingBoxAscent;
    let desc = m.actualBoundingBoxDescent;
    let ch = Math.round(asc + desc);
    if (!Number.isFinite(cw) || cw < 1) cw = Math.max(1, Math.round(fontPx * 0.6));
    if (!Number.isFinite(ch) || ch < 1) {
      ch = Math.max(1, Math.round(fontPx * 1.15));
      asc = ch * 0.8;
    }

    const cols = Math.max(8, Math.floor(pxW / cw));
    const rows = Math.max(6, Math.floor(pxH / ch));

    const changed =
      cols !== this.cols ||
      rows !== this.rows ||
      cw !== this.cellW ||
      ch !== this.cellH ||
      dpr !== this.dpr;

    this.dpr = dpr;
    this.cellW = cw;
    this.cellH = ch;
    this.cellAspect = cw / ch;
    this.baseline = Math.round(asc);
    this.cols = cols;
    this.rows = rows;

    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
    }

    this.ctx.font = font;
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.imageSmoothingEnabled = false;

    if (changed) {
      const n = cols * rows;
      this.prevGlyph = new Uint8Array(n);
      this.prevFg = new Int32Array(n).fill(-1);
      this.prevBg = new Int32Array(n).fill(-1);
      this.rebuildAtlas(font);
    }

    this.forceFull = true;
    return changed;
  }

  private rebuildAtlas(font: string): void {
    this.atlas.width = ATLAS_COLS * this.cellW;
    this.atlas.height = ATLAS_ROWS * this.cellH;
    this.atlasCtx.font = font;
    this.atlasCtx.textBaseline = 'alphabetic';
    this.atlasMap.clear();
    this.atlasNext = 0;
    this.cssCache.clear();
  }

  private clearAtlas(): void {
    this.atlasCtx.clearRect(0, 0, this.atlas.width, this.atlas.height);
    this.atlasMap.clear();
    this.atlasNext = 0;
    this.forceFull = true;
  }

  /** Returns the atlas slot index for a (glyph, colour) pair, rasterising it if new. */
  private slotFor(glyph: number, fg: number): number {
    const key = (glyph << 24) | fg;
    const found = this.atlasMap.get(key);
    if (found !== undefined) return found;

    if (this.atlasNext >= ATLAS_CAP) this.clearAtlas();

    const slot = this.atlasNext++;
    const sx = (slot % ATLAS_COLS) * this.cellW;
    const sy = Math.floor(slot / ATLAS_COLS) * this.cellH;

    this.atlasCtx.clearRect(sx, sy, this.cellW, this.cellH);
    this.atlasCtx.fillStyle = this.css(fg);
    this.atlasCtx.fillText(RAMP[glyph], sx, sy + this.baseline);

    this.atlasMap.set(key, slot);
    return slot;
  }

  private css(v: number): string {
    let s = this.cssCache.get(v);
    if (s === undefined) {
      if (this.cssCache.size > 40000) this.cssCache.clear();
      s = '#' + v.toString(16).padStart(6, '0');
      this.cssCache.set(v, s);
    }
    return s;
  }

  /** Paint a frame. Returns how many cells actually had to be redrawn. */
  draw(buf: CellBuffer): number {
    const ctx = this.ctx;
    const cols = Math.min(this.cols, buf.cols);
    const rows = Math.min(this.rows, buf.rows);
    const cw = this.cellW;
    const chh = this.cellH;
    const full = this.forceFull;
    const solidIndex = RAMP.length - 1;

    // Cleared up front, not at the end: recycling the atlas mid-frame sets the
    // flag again to request a clean repaint next time, and that must survive.
    this.forceFull = false;

    if (full) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    let changed = 0;

    for (let y = 0; y < rows; y++) {
      const rowOff = y * buf.cols;
      const prevOff = y * this.cols;
      const py = y * chh;

      for (let x = 0; x < cols; x++) {
        const i = rowOff + x;
        const pi = prevOff + x;

        const g = buf.glyph[i];
        const fg = buf.fg[i];
        const bg = buf.bg[i];

        if (!full && g === this.prevGlyph[pi] && fg === this.prevFg[pi] && bg === this.prevBg[pi]) {
          continue;
        }

        this.prevGlyph[pi] = g;
        this.prevFg[pi] = fg;
        this.prevBg[pi] = bg;
        changed++;

        const px = x * cw;

        if (g === solidIndex) {
          // The full block is drawn as a rect: exact coverage, no font seams,
          // and it skips the atlas entirely.
          ctx.fillStyle = this.css(fg);
          ctx.fillRect(px, py, cw, chh);
          continue;
        }

        ctx.fillStyle = this.css(bg);
        ctx.fillRect(px, py, cw, chh);

        if (g > 0) {
          const slot = this.slotFor(g, fg);
          const sx = (slot % ATLAS_COLS) * cw;
          const sy = Math.floor(slot / ATLAS_COLS) * chh;
          ctx.drawImage(this.atlas, sx, sy, cw, chh, px, py, cw, chh);
        }
      }
    }

    return changed;
  }

  invalidate(): void {
    this.forceFull = true;
  }
}
