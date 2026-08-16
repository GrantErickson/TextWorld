/**
 * The solver's contract is narrow but absolute: it is called from the frame
 * loop, so it must always terminate, always return a fully populated grid, and
 * never throw — no matter how unsatisfiable the constraints it is handed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WfcModel, mulberry32, solveRegion } from './wfc.ts';
import { THEMES } from './themes.ts';

const SAMPLE = [
  '########',
  '#......#',
  '#.####.#',
  '#.#..#.#',
  '#.####.#',
  '#......#',
  '########',
];

test('patterns are extracted and deduplicated', () => {
  const model = new WfcModel(SAMPLE, 3);
  assert.ok(model.patterns.length > 4, 'expected several distinct patterns');
  assert.equal(model.patterns.length, model.weights.length);
  assert.deepEqual([...model.chars].sort(), ['#', '.']);
  for (const p of model.patterns) assert.equal(p.length, 9);
});

test('a free solve fills every cell', () => {
  const model = new WfcModel(SAMPLE, 3);
  const r = solveRegion(model, { width: 20, height: 20, known: new Int16Array(400).fill(-1), seed: 7 });
  assert.equal(r.chars.length, 400);
  for (const c of r.chars) assert.ok(c >= 0 && c < model.chars.length, 'every cell resolved');
});

test('the same seed produces the same world', () => {
  const model = new WfcModel(SAMPLE, 3);
  const opts = { width: 16, height: 16, known: new Int16Array(256).fill(-1), seed: 99 };
  const a = solveRegion(model, opts);
  const b = solveRegion(model, { ...opts, known: new Int16Array(256).fill(-1) });
  assert.deepEqual(Array.from(a.chars), Array.from(b.chars));
});

test('fixed cells are honoured when they can be', () => {
  const model = new WfcModel(SAMPLE, 3);
  const w = 14;
  const known = new Int16Array(w * w).fill(-1);
  const wall = model.charToIndex('#');
  for (let y = 0; y < w; y++) known[y * w] = wall; // pin the left column
  const r = solveRegion(model, { width: w, height: w, known, seed: 3 });
  if (r.ok) {
    for (let y = 0; y < w; y++) assert.equal(r.chars[y * w], wall);
  }
});

test('impossible constraints degrade instead of throwing', () => {
  const model = new WfcModel(SAMPLE, 3);
  const w = 12;
  const known = new Int16Array(w * w).fill(-1);
  const wall = model.charToIndex('#');
  const open = model.charToIndex('.');
  // A checkerboard of wall and floor appears nowhere in the sample, so no
  // assignment can satisfy it. The solver must still come back with a grid.
  for (let i = 0; i < w * w; i++) known[i] = (i + Math.floor(i / w)) % 2 === 0 ? wall : open;
  const r = solveRegion(model, { width: w, height: w, known, seed: 11, attempts: 2 });
  assert.equal(r.chars.length, w * w);
  for (const c of r.chars) assert.ok(c >= 0 && c < model.chars.length);
});

test('a failed solve does not collapse to one pattern', () => {
  // On failure each cell takes its *likeliest* remaining pattern. Taking the
  // first instead biases a whole region into whatever sat in the sample's
  // top-left corner, which turned every failure into a slab of solid rock.
  const model = new WfcModel(SAMPLE, 3);
  const w = 12;
  const known = new Int16Array(w * w).fill(-1);
  const wall = model.charToIndex('#');
  const open = model.charToIndex('.');
  for (let i = 0; i < w * w; i++) known[i] = i % 3 === 0 ? wall : open;
  const r = solveRegion(model, { width: w, height: w, known, seed: 5, attempts: 2 });
  const distinct = new Set(r.chars);
  assert.ok(distinct.size > 1, 'output should not be a single repeated character');
});

test('every shipped theme solves cleanly at the size the world uses', () => {
  // Sample art is the main lever on WFC quality, and an over-constrained
  // sample fails silently by drifting toward the fallback. Catch it here.
  for (const [id, theme] of Object.entries(THEMES)) {
    const model = new WfcModel(theme.sample, theme.n);
    let ok = 0;
    for (let i = 0; i < 4; i++) {
      const r = solveRegion(model, {
        width: 24,
        height: 24,
        known: new Int16Array(576).fill(-1),
        seed: 1000 + i * 7919,
      });
      if (r.ok) ok++;
    }
    assert.ok(ok >= 3, `theme "${id}" only solved ${ok}/4 free regions; its sample is over-constrained`);
  }
});

test('the PRNG is deterministic and bounded', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 50; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});
