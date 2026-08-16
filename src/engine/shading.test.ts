/**
 * The shading stage is where the whole renderer either works or does not, and
 * its two promises are easy to break by accident:
 *
 *   1. a cell's *average* colour equals the light that arrived, and
 *   2. an unchanging scene produces an unchanging buffer.
 *
 * Both are checked here numerically, because neither is visible in a single
 * frame — you only notice them as washed-out gradients or a crawling image.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CellBuffer, KIND_FLOOR, KIND_WALL, RAMP, RAMP_DENSITY, toneMap } from './shading.ts';

/** Undo the gamma encoding `pack` applies, to get back to linear light. */
function decode(packed: number): [number, number, number] {
  const r = ((packed >> 16) & 0xff) / 255;
  const g = ((packed >> 8) & 0xff) / 255;
  const b = (packed & 0xff) / 255;
  return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
}

test('a cell reconstructs the colour it was given', () => {
  const buf = new CellBuffer();
  buf.resize(8, 8);

  // Solving for the foreground rather than picking a ramp entry is the trick
  // that keeps gradients smooth with only six glyphs; if it regresses, cells
  // come out systematically too dark or too bright.
  for (let i = 1; i <= 20; i++) {
    const v = i / 22;
    const x = i % 8;
    const y = (i * 3) % 8;
    buf.write(x, y, KIND_FLOOR, v, v, v);

    const idx = y * 8 + x;
    const d = RAMP_DENSITY[buf.glyph[idx]];
    const [fr] = decode(buf.fg[idx]);
    const [br] = decode(buf.bg[idx]);
    const mixed = d * fr + (1 - d) * br;
    assert.ok(
      Math.abs(mixed - v) < 0.06,
      `target ${v.toFixed(3)} reconstructed as ${mixed.toFixed(3)} (glyph ${JSON.stringify(RAMP[buf.glyph[idx]])})`,
    );
  }
});

test('an unchanged scene produces an unchanged buffer', () => {
  const buf = new CellBuffer();
  buf.resize(16, 16);
  const paint = (): void => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) buf.write(x, y, KIND_WALL, x / 20, y / 20, 0.3);
    }
  };
  paint();
  const glyphs = Uint8Array.from(buf.glyph);
  const fg = Int32Array.from(buf.fg);
  paint();
  assert.deepEqual(Array.from(buf.glyph), Array.from(glyphs), 'glyphs must not churn');
  assert.deepEqual(Array.from(buf.fg), Array.from(fg), 'colours must not churn');
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

test('a different surface kind is allowed to re-pick its glyph', () => {
  // The dead band is per kind, so a wall edge meeting a floor does not inherit
  // the neighbouring surface's glyph choice.
  const buf = new CellBuffer();
  buf.resize(4, 4);
  buf.write(1, 1, KIND_WALL, 0.5, 0.5, 0.5);
  buf.write(1, 1, KIND_FLOOR, 0.02, 0.02, 0.02);
  assert.notEqual(buf.glyph[1 * 4 + 1], RAMP_DENSITY.length - 1);
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
