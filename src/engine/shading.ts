/**
 * Turning continuous light into discrete characters.
 *
 * Four things have to happen at once here:
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
 *
 *  4. **The value range must actually be used.** Tone mapping alone lands a
 *     whole scene in the middle of the ramp — measurably: before `contrast`
 *     existed, every built-in map spent 98% of its cells on three adjacent
 *     glyphs and never once reached ' ' or '█'. See `setContrast`.
 */

/**
 * Approximate ink coverage of each character, 0..1, in the monospace fonts
 * this renders in.
 *
 * These are eyeballed rather than measured, and that is fine: they are used
 * both to pick a glyph *and* to solve for its colour, so an entry that is a
 * little off shifts which glyph gets chosen but never breaks the cell's
 * average brightness. What matters is that they are ordered correctly.
 */
const INK: Record<string, number> = {
  ' ': 0,
  '`': 0.04,
  "'": 0.05,
  '.': 0.06,
  ',': 0.07,
  '·': 0.07,
  _: 0.08,
  '-': 0.09,
  '─': 0.1,
  '|': 0.11,
  '│': 0.12,
  ':': 0.12,
  '"': 0.1,
  '~': 0.12,
  ';': 0.14,
  '≈': 0.18,
  '=': 0.19,
  '═': 0.2,
  '/': 0.2,
  '\\': 0.2,
  '+': 0.22,
  '┼': 0.22,
  '░': 0.28,
  '*': 0.28,
  v: 0.28,
  x: 0.3,
  s: 0.32,
  o: 0.34,
  '╬': 0.36,
  c: 0.3,
  e: 0.38,
  a: 0.38,
  O: 0.44,
  X: 0.48,
  '%': 0.5,
  S: 0.44,
  '▒': 0.52,
  '&': 0.55,
  $: 0.55,
  '#': 0.62,
  W: 0.6,
  '8': 0.56,
  '@': 0.72,
  '▓': 0.76,
  '█': 1.0,
};

/**
 * The flat glyph table. Every mode's ramps index into this, so a cell buffer
 * holds one small integer per cell whatever set drew it, and the display can
 * rasterise from a single array.
 */
export const GLYPHS: string[] = [];
const density: number[] = [];
const indexOfChar = new Map<string, number>();

function glyphIndex(ch: string): number {
  let i = indexOfChar.get(ch);
  if (i === undefined) {
    const d = INK[ch];
    if (d === undefined) throw new Error(`No ink coverage recorded for glyph ${JSON.stringify(ch)}.`);
    i = GLYPHS.length;
    GLYPHS.push(ch);
    density.push(d);
    indexOfChar.set(ch, i);
  }
  return i;
}

/**
 * A ramp: a list of coverage levels, each with one or more interchangeable
 * characters. The first character of a level is its canonical one and sets the
 * level's nominal coverage; the rest are variants of roughly the same weight,
 * picked by a world-space hash so a surface reads as texture rather than as a
 * flat wash.
 *
 * Variants need not match the canonical coverage exactly. The colour solve
 * uses the *chosen* glyph's real coverage, so a lighter variant simply comes
 * out with a brighter foreground and the cell average is preserved either way.
 */
interface GlyphSet {
  id: string;
  /** Nominal coverage of each level, ascending. */
  level: Float32Array;
  /** Where each level's variants start in `variant`; length levels + 1. */
  start: Int32Array;
  variant: Uint8Array;
  /** Mean gap between levels. Scales the dither so a finer ramp dithers less. */
  step: number;
}

function compile(id: string, levels: string[]): GlyphSet {
  const level = new Float32Array(levels.length);
  const start = new Int32Array(levels.length + 1);
  const variant: number[] = [];

  for (let i = 0; i < levels.length; i++) {
    start[i] = variant.length;
    const chars = [...levels[i]];
    for (const ch of chars) variant.push(glyphIndex(ch));
    level[i] = density[variant[start[i]]];
    if (i > 0 && level[i] <= level[i - 1]) {
      throw new Error(`Glyph set "${id}" level ${i} (${levels[i][0]}) does not increase in coverage.`);
    }
  }
  start[levels.length] = variant.length;

  if (level[levels.length - 1] < 1) {
    throw new Error(`Glyph set "${id}" must reach full coverage, or bright cells clip.`);
  }

  return {
    id,
    level,
    start,
    variant: new Uint8Array(variant),
    step: (level[levels.length - 1] - level[0]) / Math.max(1, levels.length - 1),
  };
}

// ---------------------------------------------------------------- the ramps

/**
 * The original six-step block ramp. Everything else is measured against it:
 * its level coverages are the anchors the material ramps reuse, so switching
 * modes changes the characters without changing how bright the scene reads.
 */
const BLOCKS = compile('blocks', [' ', '·', '░', '▒', '▓', '█']);

/**
 * The classic ASCII-art ramp, at twice the resolution of the blocks.
 *
 * One character per level and no variants at all. Variants were tried here and
 * are wrong for this mode: twelve levels already give a gradient smooth enough
 * that the dither barely has to work, and adding alternates on top of that
 * turns a wall into a page of random text. The ramp *is* the texture.
 */
const ASCII = compile('ascii', [' ', '.', '-', ':', '=', '+', '*', 'o', '%', '#', '@', '█']);

/**
 * Material ramps: the block ramp's exact coverage levels, with a characteristic
 * mark mixed into the middle of each. Masonry gets courses, panelling gets
 * seams, water gets ripples, foliage gets scatter.
 *
 * The weighting is the whole design. A variant is chosen uniformly from its
 * level's list, so a character is made a *minority* simply by repeating the
 * block it accents — `░░░═` puts a course line in one cell of four. Three
 * equally-likely alternates per level was the first attempt and it reads as a
 * page of random text rather than as a wall: the eye tracks the characters
 * instead of the light, which is the opposite of the point. A quarter is
 * enough to say "brick" and little enough to stay a texture.
 *
 * The top level is plain block. Almost no character covers more than about 0.7
 * of its cell, and a highlight should read as light rather than as lettering.
 */
const MATERIAL_SETS: Record<string, string[]> = {
  solid: [' ', '·', '░', '▒', '▓', '█'],
  noise: [' ', '···.', '░░░*', '▒▒▒%', '▓', '█'],
  rock: [' ', '···,', '░░░x', '▒▒▒%', '▓', '█'],
  brick: [' ', '···-', '░░░═', '▒▒▒#', '▓', '█'],
  panel: [' ', '···-', '░░░┼', '▒▒▒#', '▓', '█'],
  grate: [' ', '···:', '░░░+', '▒▒▒#', '▓', '█'],
  tile: [' ', '···.', '░░░═', '▒▒▒#', '▓', '█'],
  planks: [' ', '···_', '░░░═', '▒▒▒#', '▓', '█'],
  // Water and leaves get half, not a quarter: on these two the character is
  // not decoration on a surface, it is how you tell what the surface is.
  water: [' ', '··~~', '░░≈≈', '▒▒%%', '▓', '█'],
  foliage: [' ', '··,,', '░░**', '▒▒%%', '▓', '█'],
  // The sky stays plain. Characters up there read as dirt on the lens — there
  // is no surface for them to be the texture *of*.
  sky: [' ', '·', '░', '▒', '▓', '█'],
};

/**
 * Glyph-set slots. A surface names the slot it wants and the active mode
 * decides which ramp that resolves to, so the renderer never knows or cares
 * which mode is on.
 */
export const GS_SOLID = 0;
export const GS_NOISE = 1;
export const GS_ROCK = 2;
export const GS_BRICK = 3;
export const GS_PANEL = 4;
export const GS_GRATE = 5;
export const GS_TILE = 6;
export const GS_PLANKS = 7;
export const GS_WATER = 8;
export const GS_FOLIAGE = 9;
export const GS_SKY = 10;
const SLOT_COUNT = 11;

const SLOT_NAMES = [
  'solid',
  'noise',
  'rock',
  'brick',
  'panel',
  'grate',
  'tile',
  'planks',
  'water',
  'foliage',
  'sky',
];

const MATERIAL = SLOT_NAMES.map((name) => compile(name, MATERIAL_SETS[name]));

export type GlyphMode = 'blocks' | 'ascii' | 'material';
export const GLYPH_MODES: readonly GlyphMode[] = ['blocks', 'ascii', 'material'];

/** Coverage of every glyph in `GLYPHS`, by index. */
export const GLYPH_DENSITY = new Float32Array(density);
/**
 * Which glyphs fill their cell exactly. The display draws these as a rect —
 * exact coverage, no font seams, and it skips the atlas entirely.
 */
export const GLYPH_SOLID = new Uint8Array(GLYPHS.map((ch) => (ch === '█' ? 1 : 0)));

let active: GlyphSet[] = new Array(SLOT_COUNT).fill(BLOCKS);
let activeMode: GlyphMode = 'blocks';

export function setGlyphMode(mode: GlyphMode): void {
  if (mode === activeMode) return;
  activeMode = mode;
  if (mode === 'material') active = MATERIAL.slice();
  else active = new Array(SLOT_COUNT).fill(mode === 'ascii' ? ASCII : BLOCKS);
}

export function getGlyphMode(): GlyphMode {
  return activeMode;
}

/** Slot for a material's pattern. Resolved once, at material construction. */
export function slotForPattern(pattern: string): number {
  const i = SLOT_NAMES.indexOf(pattern);
  return i < 0 ? GS_SOLID : i;
}

/**
 * How many variant cells fit across one world tile.
 *
 * This is the lattice a surface's glyph variety is welded to, and it is
 * deliberately much coarser than the texture lattice: one variant per texel
 * would change several times within a single character cell, which reads as
 * static. Around six per tile puts roughly one variant per screen cell at
 * conversational range.
 */
const GLYPH_LATTICE = 6;

/** A world-space stable integer for picking a glyph variant. */
export function glyphSeed(u: number, v: number): number {
  return cellSeed(Math.floor(u * GLYPH_LATTICE) | 0, Math.floor(v * GLYPH_LATTICE) | 0);
}

/** The same, for callers that already hold integer lattice coordinates. */
export function cellSeed(iu: number, iv: number): number {
  let h = (Math.imul(iu | 0, 0x27d4eb2d) ^ Math.imul(iv | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return (h ^ (h >>> 13)) >>> 0;
}

// ------------------------------------------------------------------ shading

/** Fraction of a cell's colour carried by the background behind the glyph. */
const BG_FRACTION = 0.1;

/**
 * How far the underlying value must move before a glyph is allowed to change.
 *
 * Absolute rather than a fraction of the ramp step, on purpose: a finer ramp
 * then gets a *proportionally wider* dead band, which is what keeps the
 * twelve-level ASCII ramp close to as settled as the six-level block one.
 *
 * This was 0.035 before `contrast` existed. A steeper tone curve moves `need`
 * further for the same change in light, so the same band holds a glyph through
 * less of the world — glyph churn while walking roughly doubled on the contrast
 * change alone. Widening the band claws part of that back; it cannot claw all
 * of it back, because responding harder to light is the entire point of the
 * curve. Past about 0.08 the lag starts to show as a surface visibly catching
 * up after you stop.
 */
const HYSTERESIS = 0.06;

/**
 * Dither amplitude, in ramp steps. Expressed relative to the step so a ramp
 * with twice the levels dithers half as far, instead of smearing across three
 * of them.
 *
 * The dither is deliberately *one-sided* — it only ever pushes the choice
 * toward a heavier glyph, never a lighter one. That is not a stylistic call,
 * it falls out of the colour solve: a cell reproduces its colour exactly when
 * the glyph's coverage is at least `need`, and reproduces it too dark when it
 * is less, because the foreground it would take to compensate is past white.
 * A symmetric dither therefore spends half its cells clipping, which showed up
 * as a measurable dark bias near every ramp boundary. Choosing a *heavier*
 * glyph and a dimmer foreground costs nothing and gives the same texture.
 */
const DITHER_STEPS = 0.85;

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
  private histGlyph = new Uint8Array(0);
  private histKind = new Uint8Array(0);
  private histSlot = new Uint8Array(0);

  resize(cols: number, rows: number): boolean {
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    this.glyph = new Uint8Array(n);
    this.fg = new Int32Array(n);
    this.bg = new Int32Array(n);
    this.hist = new Float32Array(n).fill(-1);
    this.histGlyph = new Uint8Array(n);
    this.histKind = new Uint8Array(n).fill(255);
    this.histSlot = new Uint8Array(n).fill(255);
    return true;
  }

  /** Drop all hysteresis history; used when the camera teleports. */
  invalidate(): void {
    this.hist.fill(-1);
    this.histKind.fill(255);
    this.histSlot.fill(255);
  }

  /**
   * Write one cell from a linear colour. `r`, `g`, `b` are pre-tone-mapped
   * values in 0..1. `slot` names the glyph set and `seed` is a world-space
   * stable integer that picks among a level's variants — pass 0 for a surface
   * with nothing meaningful to hash, and the canonical glyph comes out.
   */
  write(
    x: number,
    y: number,
    kind: number,
    r: number,
    g: number,
    b: number,
    slot = GS_SOLID,
    seed = 0,
  ): void {
    const i = y * this.cols + x;

    // Density needed so that the reconstructed cell colour does not clip:
    //   fg = c * (1 - BG + BG*d) / d  must stay <= 1 for the brightest channel.
    const peak = r > g ? (r > b ? r : b) : g > b ? g : b;
    const clamped = peak > 1 ? 1 : peak < 0 ? 0 : peak;
    const need = clamped >= 1 ? 1 : ((1 - BG_FRACTION) * clamped) / (1 - BG_FRACTION * clamped);

    let gi: number;
    const sameSurface = this.histKind[i] === kind && this.histSlot[i] === slot;
    const prev = this.hist[i];
    if (sameSurface && prev >= 0 && Math.abs(need - prev) < HYSTERESIS) {
      // Inside the dead band: keep the glyph we already have. The colour still
      // updates continuously, so motion stays smooth without glyph churn. The
      // *variant* is held too, which is what stops surface texture from
      // shimmering as the world slides under a cell.
      gi = this.histGlyph[i];
    } else {
      const set = active[slot];
      // No light at all means no glyph. Dithering up from zero would sprinkle
      // the dark with characters that carry no information, which is the one
      // failure this renderer most needs to avoid.
      const dither = need > 0 ? (BAYER8[((y & 7) << 3) | (x & 7)] + 0.5) * DITHER_STEPS * set.step : 0;
      const lvl = pickLevel(set, need + dither);
      const from = set.start[lvl];
      const count = set.start[lvl + 1] - from;
      gi = set.variant[count > 1 ? from + (seed % count) : from];
      // A variant may run lighter than its level's canonical glyph, and one
      // lighter than `need` would clip exactly as a downward dither does. The
      // canonical glyph is >= need by construction, so fall back to it.
      if (GLYPH_DENSITY[gi] < need) gi = set.variant[from];
      this.hist[i] = need;
      this.histGlyph[i] = gi;
      this.histKind[i] = kind;
      this.histSlot[i] = slot;
    }

    // The *chosen* glyph's coverage, not its level's nominal one, so a variant
    // that runs light or heavy still reconstructs the colour it was given.
    const d = GLYPH_DENSITY[gi];
    this.glyph[i] = gi;

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

function pickLevel(set: GlyphSet, value: number): number {
  const n = set.level.length;
  for (let i = 0; i < n; i++) {
    if (set.level[i] >= value) return i;
  }
  return n - 1;
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

// ----------------------------------------------------------------- contrast

/**
 * Where the contrast curve pivots: values below this are pushed down, values
 * above are pushed up.
 *
 * Sat above the median a lit scene naturally lands at, so raising contrast
 * deepens shadow across most of the frame and only lifts what is genuinely
 * lit. That is deliberate — it means contrast and `exposure` pull in opposite
 * directions and a map is tuned with both, rather than contrast quietly
 * brightening everything and undoing the exposure work.
 */
const PIVOT = 0.45;

const CONTRAST_LUT = new Float32Array(1025);
let contrastK = 1;

/**
 * Set the contrast applied to every tone-mapped value from here on. 1 is
 * identity; above 1 spreads the range, below 1 compresses it.
 *
 * This is module state read by `toneMap` rather than a parameter, because it
 * is constant for a whole frame and `toneMap` is called from inside five
 * separate nested render loops — threading it through all of them would cost
 * more in noise than it saves in purity. The renderer sets it once per frame.
 *
 * Why it exists at all: the tone curve `x / (1 + x)` is aggressively
 * compressive, and every built-in map used to land 98% of its cells on three
 * adjacent glyphs — mid-grey mush with no black and no white anywhere in the
 * frame. Exposure alone cannot fix that; it slides the whole distribution
 * without widening it.
 */
export function setContrast(k: number): void {
  const c = k < 0.2 ? 0.2 : k > 6 ? 6 : k;
  if (c === contrastK) return;
  contrastK = c;
  for (let i = 0; i <= 1024; i++) CONTRAST_LUT[i] = contrastCurve(i / 1024, c);
}

export function getContrast(): number {
  return contrastK;
}

/** Monotonic S-curve about `PIVOT`, fixing 0 and 1. `k` = 1 is the identity. */
export function contrastCurve(v: number, k: number): number {
  if (k === 1) return v;
  const t = v < 0 ? 0 : v > 1 ? 1 : v;
  return t <= PIVOT
    ? PIVOT * Math.pow(t / PIVOT, k)
    : 1 - (1 - PIVOT) * Math.pow((1 - t) / (1 - PIVOT), k);
}

/**
 * Filmic-ish tone map, then contrast. Keeps bright pools of light from
 * flattening to white while still using the whole ramp.
 */
export function toneMap(v: number, exposure: number): number {
  const x = v * exposure;
  const t = x > 0 ? x / (1 + x) : 0;
  if (contrastK === 1) return t;
  const i = (t * 1024) | 0;
  return CONTRAST_LUT[i < 0 ? 0 : i > 1024 ? 1024 : i];
}

export function packedToCss(v: number): string {
  return '#' + v.toString(16).padStart(6, '0');
}
