/**
 * Turning continuous light into discrete characters.
 *
 * Three things have to happen at once here:
 *
 *  1. **Brightness must survive quantisation.** A cell's apparent colour is
 *     `density * fg + (1 - density) * bg`. Rather than picking a glyph from a
 *     luminance ramp and calling it done, we solve that equation for `fg`, so
 *     the *average* colour of every cell matches the light that actually
 *     arrived. Gradients stay smooth even though only six glyphs exist.
 *
 *  2. **The dither must not crawl.** The ordered dither is indexed by screen
 *     cell, not by world position. A fixed screen-space pattern reads as film
 *     grain that sits still; a world-space one reads as the wall boiling.
 *
 *  3. **Small changes must not flip glyphs.** Hysteresis holds a cell's glyph
 *     until the underlying value moves past a band. Without it, a cell sitting
 *     near a ramp threshold flickers between two characters every frame from
 *     nothing but floating-point noise.
 */

export const RAMP = [' ', '·', '░', '▒', '▓', '█'];
/** Approximate ink coverage of each ramp glyph, 0..1. */
export const RAMP_DENSITY = [0, 0.09, 0.28, 0.52, 0.76, 1.0];

/** Fraction of a cell's colour carried by the background behind the glyph. */
const BG_FRACTION = 0.1;

/** How far the underlying value must move before a glyph is allowed to change. */
const HYSTERESIS = 0.035;

/** Dither amplitude, as a fraction of the value range. */
const DITHER = 0.11;

export const KIND_SKY = 0;
export const KIND_CEILING = 1;
export const KIND_FLOOR = 2;
export const KIND_WALL = 3;
export const KIND_DOOR = 4;
export const KIND_SPRITE = 5;

// 8x8 ordered (Bayer) matrix, normalised to [-0.5, 0.5).
const BAYER8 = new Float32Array(64);
{
  const base = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
    7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ];
  for (let i = 0; i < 64; i++) BAYER8[i] = base[i] / 64 - 0.5;
}

/**
 * A screen's worth of character cells, plus the per-cell history the
 * hysteresis needs. Colours are packed 0xRRGGBB.
 */
export class CellBuffer {
  cols = 0;
  rows = 0;
  glyph = new Uint8Array(0);
  fg = new Int32Array(0);
  bg = new Int32Array(0);
  /** Committed value each cell's current glyph was chosen from. */
  private hist = new Float32Array(0);
  private histIdx = new Uint8Array(0);
  private histKind = new Uint8Array(0);

  resize(cols: number, rows: number): boolean {
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    this.glyph = new Uint8Array(n);
    this.fg = new Int32Array(n);
    this.bg = new Int32Array(n);
    this.hist = new Float32Array(n).fill(-1);
    this.histIdx = new Uint8Array(n);
    this.histKind = new Uint8Array(n).fill(255);
    return true;
  }

  /** Drop all hysteresis history; used when the camera teleports. */
  invalidate(): void {
    this.hist.fill(-1);
    this.histKind.fill(255);
  }

  /**
   * Write one cell from a linear colour. `r`, `g`, `b` are pre-tone-mapped
   * values in 0..1.
   */
  write(x: number, y: number, kind: number, r: number, g: number, b: number): void {
    const i = y * this.cols + x;

    // Density needed so that the reconstructed cell colour does not clip:
    //   fg = c * (1 - BG + BG*d) / d  must stay <= 1 for the brightest channel.
    const peak = r > g ? (r > b ? r : b) : g > b ? g : b;
    const clamped = peak > 1 ? 1 : peak < 0 ? 0 : peak;
    const need = clamped >= 1 ? 1 : ((1 - BG_FRACTION) * clamped) / (1 - BG_FRACTION * clamped);

    let idx: number;
    const sameKind = this.histKind[i] === kind;
    const prev = this.hist[i];
    if (sameKind && prev >= 0 && Math.abs(need - prev) < HYSTERESIS) {
      // Inside the dead band: keep the glyph we already have. The colour still
      // updates continuously, so motion stays smooth without glyph churn.
      idx = this.histIdx[i];
    } else {
      const dither = BAYER8[((y & 7) << 3) | (x & 7)] * DITHER;
      idx = pickDensity(need + dither);
      this.hist[i] = need;
      this.histIdx[i] = idx;
      this.histKind[i] = kind;
    }

    const d = RAMP_DENSITY[idx];
    this.glyph[i] = idx;

    if (d <= 0) {
      this.fg[i] = 0;
      this.bg[i] = pack(r * BG_FRACTION, g * BG_FRACTION, b * BG_FRACTION);
      return;
    }

    // Solve density*fg + (1 - density)*bg = c, with bg = c * BG_FRACTION.
    const k = (1 - BG_FRACTION + BG_FRACTION * d) / d;
    this.fg[i] = pack(r * k, g * k, b * k);
    this.bg[i] = pack(r * BG_FRACTION, g * BG_FRACTION, b * BG_FRACTION);
  }
}

function pickDensity(value: number): number {
  for (let i = 0; i < RAMP_DENSITY.length; i++) {
    if (RAMP_DENSITY[i] >= value) return i;
  }
  return RAMP_DENSITY.length - 1;
}

/**
 * Pack a linear colour to 0xRRGGBB, quantised to 6 bits per channel.
 *
 * The quantisation is deliberate. It costs nothing visually at this
 * resolution, and it means a cell whose lighting drifted by a rounding error
 * compares equal to its previous frame — which is what lets the display skip
 * redrawing it.
 */
function pack(r: number, g: number, b: number): number {
  const ri = toByte(r);
  const gi = toByte(g);
  const bi = toByte(b);
  return (ri << 16) | (gi << 8) | bi;
}

function toByte(v: number): number {
  // Gamma encode: lighting is computed linearly, displays are not.
  const c = v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, 1 / 2.2);
  return (Math.round(c * 255) & 0xfc) | 0;
}

/** Filmic-ish tone map. Keeps bright pools of light from flattening to white. */
export function toneMap(v: number, exposure: number): number {
  const x = v * exposure;
  return x / (1 + x);
}

export function packedToCss(v: number): string {
  return '#' + v.toString(16).padStart(6, '0');
}
