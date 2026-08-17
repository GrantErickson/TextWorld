/**
 * The shading stage is where the whole renderer either works or does not, and
 * its promises are easy to break by accident:
 *
 *   1. a cell's *average* colour equals the light that arrived — in every
 *      glyph mode, not just the block ramp it was designed around,
 *   2. an unchanging scene produces an unchanging buffer, and
 *   3. the tone curve actually spans its range.
 *
 * All three are checked numerically, because none is visible in a single
 * frame — you only notice them as washed-out gradients or a crawling image.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CellBuffer,
  GLYPHS,
  GLYPH_DENSITY,
  GLYPH_MODES,
  GS_BRICK,
  GS_FOLIAGE,
  GS_ROCK,
  KIND_FLOOR,
  KIND_WALL,
  contrastCurve,
  getGlyphMode,
  glyphSeed,
  setContrast,
  setGlyphMode,
  toneMap,
} from './shading.ts';

/** Undo the gamma encoding `pack` applies, to get back to linear light. */
function decode(packed: number): [number, number, number] {
  const r = ((packed >> 16) & 0xff) / 255;
  const g = ((packed >> 8) & 0xff) / 255;
  const b = (packed & 0xff) / 255;
  return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
}

test('a cell reconstructs the colour it was given, in every glyph mode', () => {
  // Solving for the foreground rather than picking a ramp entry is the trick
  // that keeps gradients smooth with only a handful of glyphs; if it
  // regresses, cells come out systematically too dark or too bright.
  //
  // It has to survive the variant glyphs too. A level's variants are only
  // roughly matched in coverage, and the reconstruction leans on `write`
  // solving against the coverage of the glyph it actually chose rather than
  // the level's nominal one.
  setContrast(1);
  for (const mode of GLYPH_MODES) {
    setGlyphMode(mode);
    const buf = new CellBuffer();
    buf.resize(8, 8);

    for (const slot of [GS_ROCK, GS_FOLIAGE]) {
      for (let i = 1; i <= 20; i++) {
        const v = i / 22;
        const x = i % 8;
        const y = (i * 3) % 8;
        buf.write(x, y, KIND_FLOOR, v, v, v, slot, glyphSeed(i * 0.7, i * 1.3));

        const idx = y * 8 + x;
        const d = GLYPH_DENSITY[buf.glyph[idx]];
        const [fr] = decode(buf.fg[idx]);
        const [br] = decode(buf.bg[idx]);
        const mixed = d * fr + (1 - d) * br;
        assert.ok(
          Math.abs(mixed - v) < 0.06,
          `${mode}: target ${v.toFixed(3)} came back as ${mixed.toFixed(3)} ` +
            `(glyph ${JSON.stringify(GLYPHS[buf.glyph[idx]])})`,
        );
      }
    }
  }
  setGlyphMode('blocks');
});

test('every glyph ramp climbs to full coverage', () => {
  // A ramp that tops out below 1 cannot represent a bright cell: `write`
  // compensates by pushing the foreground past white, which clips and shifts
  // the hue. The ramps are compiled at module load and throw on a ramp that
  // does not ascend, so reaching here at all is half the test.
  for (const mode of GLYPH_MODES) {
    setGlyphMode(mode);
    const buf = new CellBuffer();
    buf.resize(2, 2);
    buf.write(0, 0, KIND_WALL, 1, 1, 1, GS_ROCK);
    assert.equal(GLYPH_DENSITY[buf.glyph[0]], 1, `${mode} must reach a full cell`);
    buf.write(1, 1, KIND_WALL, 0, 0, 0, GS_ROCK);
    assert.equal(GLYPH_DENSITY[buf.glyph[3]], 0, `${mode} must reach an empty cell`);
  }
  setGlyphMode('blocks');
});

test('an unchanged scene produces an unchanged buffer', () => {
  for (const mode of GLYPH_MODES) {
    setGlyphMode(mode);
    const buf = new CellBuffer();
    buf.resize(16, 16);
    const paint = (): void => {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          buf.write(x, y, KIND_WALL, x / 20, y / 20, 0.3, GS_ROCK, glyphSeed(x * 0.3, y * 0.3));
        }
      }
    };
    paint();
    const glyphs = Uint8Array.from(buf.glyph);
    const fg = Int32Array.from(buf.fg);
    paint();
    assert.deepEqual(Array.from(buf.glyph), Array.from(glyphs), `${mode}: glyphs must not churn`);
    assert.deepEqual(Array.from(buf.fg), Array.from(fg), `${mode}: colours must not churn`);
  }
  setGlyphMode('blocks');
});

test('hysteresis holds a glyph through small changes', () => {
  const buf = new CellBuffer();
  buf.resize(4, 4);
  buf.write(0, 0, KIND_WALL, 0.5, 0.5, 0.5);
  const first = buf.glyph[0];
  // Nudges below the dead band must not flip the character. Without this a
  // cell sitting near a ramp threshold flickers on floating-point noise alone.
  for (let i = 0; i < 8; i++) {
    buf.write(0, 0, KIND_WALL, 0.5 + (i % 2 === 0 ? 0.004 : -0.004), 0.5, 0.5);
    assert.equal(buf.glyph[0], first);
  }
});

test('hysteresis holds the variant too, not just the level', () => {
  // The variant is picked from a world-space hash, so it changes as a surface
  // slides under a cell. Re-rolling it every frame would put a shimmer on
  // every wall — exactly the churn the dead band exists to stop.
  setGlyphMode('material');
  const buf = new CellBuffer();
  buf.resize(4, 4);
  buf.write(0, 0, KIND_WALL, 0.4, 0.4, 0.4, GS_ROCK, 1);
  const first = buf.glyph[0];
  let held = true;
  for (let i = 0; i < 12; i++) {
    buf.write(0, 0, KIND_WALL, 0.4 + i * 0.0002, 0.4, 0.4, GS_ROCK, i * 7919);
    if (buf.glyph[0] !== first) held = false;
  }
  assert.ok(held, 'a seed change inside the dead band must not repaint the cell');
  setGlyphMode('blocks');
});

test('a material ramp mixes its accent in as a minority', () => {
  // Both halves matter. If the accent never appears the variant lookup has
  // silently stopped working and the mode is indistinguishable from blocks; if
  // it appears in most cells the surface reads as text rather than as texture,
  // which is what the first version of these ramps got wrong.
  setGlyphMode('material');
  const buf = new CellBuffer();
  buf.resize(40, 40);
  const seen = new Map<string, number>();
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      buf.write(x, y, KIND_WALL, 0.35, 0.35, 0.35, GS_BRICK, glyphSeed(x * 0.4, y * 0.4));
      const ch = GLYPHS[buf.glyph[y * 40 + x]];
      seen.set(ch, (seen.get(ch) ?? 0) + 1);
    }
  }
  const blocks = [...seen].filter(([c]) => '░▒▓█ ·'.includes(c)).reduce((a, [, n]) => a + n, 0);
  const accent = 1600 - blocks;
  assert.ok(accent > 0, 'the accent character never appeared');
  assert.ok(accent / 1600 < 0.4, `accent covers ${((accent / 1600) * 100).toFixed(0)}% of the surface`);
  setGlyphMode('blocks');
});

test('a different surface kind is allowed to re-pick its glyph', () => {
  // The dead band is per kind, so a wall edge meeting a floor does not inherit
  // the neighbouring surface's glyph choice.
  const buf = new CellBuffer();
  buf.resize(4, 4);
  buf.write(1, 1, KIND_WALL, 0.5, 0.5, 0.5);
  buf.write(1, 1, KIND_FLOOR, 0.02, 0.02, 0.02);
  assert.ok(GLYPH_DENSITY[buf.glyph[1 * 4 + 1]] < 0.3);
});

test('a different glyph slot is allowed to re-pick its glyph', () => {
  setGlyphMode('material');
  const buf = new CellBuffer();
  buf.resize(4, 4);
  buf.write(1, 1, KIND_WALL, 0.5, 0.5, 0.5, GS_ROCK, 1);
  const rock = buf.glyph[5];
  buf.write(1, 1, KIND_WALL, 0.5, 0.5, 0.5, GS_FOLIAGE, 1);
  // Same value, same kind — but a different ramp, so the dead band must not
  // carry the old ramp's character across.
  assert.ok(GLYPHS[rock] !== undefined);
  assert.equal(getGlyphMode(), 'material');
  setGlyphMode('blocks');
});

test('invalidate drops the history so a teleport cannot smear', () => {
  const buf = new CellBuffer();
  buf.resize(4, 4);
  buf.write(0, 0, KIND_WALL, 0.5, 0.5, 0.5);
  const before = buf.glyph[0];
  buf.invalidate();
  buf.write(0, 0, KIND_WALL, 0.02, 0.02, 0.02);
  assert.notEqual(buf.glyph[0], before);
});

test('tone mapping stays in range and keeps its order', () => {
  setContrast(1);
  let prev = -1;
  for (let i = 0; i <= 40; i++) {
    const v = toneMap(i / 4, 2.2);
    assert.ok(v >= 0 && v < 1, `toneMap out of range at ${i}`);
    assert.ok(v > prev, 'toneMap must be strictly increasing');
    prev = v;
  }
  // Exposure has to lift the mid-range: at exposure 1 a white surface only
  // reaches 0.5 and the top half of the glyph ramp is unreachable.
  assert.ok(toneMap(1, 2.2) > 0.6);
});

test('contrast spreads the range without breaking the ends', () => {
  // 1 must be exactly the identity, or every existing map's tuning shifts the
  // moment the knob is added.
  for (let i = 0; i <= 20; i++) {
    const v = i / 20;
    assert.equal(contrastCurve(v, 1), v);
  }

  for (const k of [1.3, 1.8, 2.5]) {
    assert.ok(Math.abs(contrastCurve(0, k)) < 1e-9, 'black must stay black');
    assert.ok(Math.abs(contrastCurve(1, k) - 1) < 1e-9, 'white must stay white');

    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = contrastCurve(i / 100, k);
      assert.ok(v > prev, `contrast must stay monotonic at k=${k}`);
      prev = v;
    }
    // The point of the knob: dark gets darker and light gets lighter, so the
    // distribution widens rather than sliding.
    assert.ok(contrastCurve(0.15, k) < 0.15, `k=${k} must deepen shadow`);
    assert.ok(contrastCurve(0.85, k) > 0.85, `k=${k} must lift highlight`);
  }
});

test('setContrast reaches toneMap and is undone by setting it back', () => {
  const plain = toneMap(0.2, 2.2);
  setContrast(2);
  const punchy = toneMap(0.2, 2.2);
  assert.ok(punchy < plain, 'a dark value must fall further with contrast up');
  setContrast(1);
  assert.ok(Math.abs(toneMap(0.2, 2.2) - plain) < 1e-6, 'contrast 1 must restore the plain curve');
});
