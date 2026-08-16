/**
 * The outdoor generator's defining property is that it is a *pure function of
 * position*. That is what lets the world be endless without being remembered,
 * and it is the thing most easily lost by adding a cache or a neighbour
 * lookup. The rest of these guard thresholds that fail silently: a river that
 * never triggers or a height range that quietly compresses to nothing still
 * produces a perfectly valid, perfectly boring world.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TERRAIN_THEMES, landHeight, makeSample, sampleTerrain } from './terrain.ts';
import { fbm2, norm01, ridge2 } from './noise.ts';

const SEED = 2024;

test('a tile depends only on its coordinates, not on what was sampled before', () => {
  for (const theme of Object.values(TERRAIN_THEMES)) {
    const a = makeSample();
    const b = makeSample();
    const coords: Array<[number, number]> = [
      [0, 0],
      [37, -91],
      [-412, 615],
      [9001, -9001],
    ];

    // Sample in one order...
    const first = coords.map((c) => {
      sampleTerrain(theme, c[0], c[1], SEED, a);
      return { h: a.height, w: a.water, s: a.solid, bi: a.biome };
    });
    // ...then in reverse, with unrelated samples in between.
    for (let i = 0; i < 50; i++) sampleTerrain(theme, i * 13, i * 7, SEED, b);
    const second = coords
      .slice()
      .reverse()
      .map((c) => {
        sampleTerrain(theme, c[0], c[1], SEED, b);
        return { h: b.height, w: b.water, s: b.solid, bi: b.biome };
      })
      .reverse();

    assert.deepEqual(second, first, `theme "${theme.id}" is order dependent`);
  }
});

test('a different seed gives a different world', () => {
  const theme = TERRAIN_THEMES.wilds;
  const a = makeSample();
  const b = makeSample();
  let differences = 0;
  for (let i = 0; i < 200; i++) {
    sampleTerrain(theme, i * 3, i * 5, SEED, a);
    sampleTerrain(theme, i * 3, i * 5, SEED + 1, b);
    if (Math.abs(a.height - b.height) > 0.01) differences++;
  }
  assert.ok(differences > 150, 'seeds should produce substantially different terrain');
});

test('the landscape actually has relief', () => {
  // fBm concentrates hard around 0.5, so anything scaled by it straight comes
  // out a fraction of the amplitude asked for. This caught exactly that: an
  // 11-tile amplitude that produced a 3.8-tile range.
  for (const theme of Object.values(TERRAIN_THEMES)) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = -140; y < 140; y += 3) {
      for (let x = -140; x < 140; x += 3) {
        const h = landHeight(theme, x, y, SEED);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    assert.ok(hi - lo > theme.amplitude * 0.5, `theme "${theme.id}" span ${(hi - lo).toFixed(2)} is too flat`);
  }
});

test('terracing produces ledges too tall to walk up', () => {
  // Cliffs exist only because height is quantised past the step limit; if the
  // terracing stops biting, the world becomes uniformly walkable and the
  // "cliffs" in the feature list quietly disappear.
  const theme = TERRAIN_THEMES.wilds;
  let steep = 0;
  let total = 0;
  for (let y = -160; y < 160; y += 2) {
    for (let x = -160; x < 160; x += 2) {
      const a = landHeight(theme, x, y, SEED);
      const b = landHeight(theme, x + 1, y, SEED);
      total++;
      if (Math.abs(a - b) > 0.55) steep++;
    }
  }
  assert.ok(steep / total > 0.01, `only ${((steep / total) * 100).toFixed(2)}% of steps are cliffs`);
});

test('rivers, roads, buildings and every biome all occur', () => {
  // Each of these is a threshold on a noise field, and a threshold that has
  // drifted out of range produces a world that is valid and missing a feature.
  for (const theme of Object.values(TERRAIN_THEMES)) {
    const s = makeSample();
    let water = 0;
    let solid = 0;
    let bare = 0;
    const biomes = new Set<number>();
    for (let y = -180; y < 180; y += 2) {
      for (let x = -180; x < 180; x += 2) {
        sampleTerrain(theme, x, y, SEED, s);
        if (s.water) water++;
        if (s.solid) solid++;
        if (s.bare) bare++;
        biomes.add(s.biome);
      }
    }
    assert.ok(water > 0, `theme "${theme.id}" generated no water`);
    assert.ok(solid > 0, `theme "${theme.id}" generated no buildings`);
    assert.ok(bare > water, `theme "${theme.id}" generated no roads or yards`);
    assert.equal(biomes.size, theme.biomes.length, `theme "${theme.id}" never used every biome`);
  }
});

test('water sits below the ground beside it', () => {
  const theme = TERRAIN_THEMES.wilds;
  const s = makeSample();
  const t = makeSample();
  let checked = 0;
  for (let y = -200; y < 200 && checked < 40; y += 3) {
    for (let x = -200; x < 200 && checked < 40; x += 3) {
      sampleTerrain(theme, x, y, SEED, s);
      if (!s.water || s.solid) continue;
      sampleTerrain(theme, x + 6, y + 6, SEED, t);
      if (t.water || t.solid) continue;
      checked++;
      assert.ok(s.height <= t.height + 0.01, 'a river should be carved into the land, not perched on it');
    }
  }
  assert.ok(checked > 0, 'expected to find some river tiles to check');
});

test('norm01 spreads fBm across its range', () => {
  // Contract: keep the midpoint, push everything else away from it, stay in
  // range. Widening the spread is the whole point — a 5-octave fBm mostly
  // lives inside 0.35..0.65, and scaling terrain by that raw gives a fraction
  // of the amplitude asked for.
  assert.ok(Math.abs(norm01(0.5) - 0.5) < 1e-9, 'the midpoint must not move');
  assert.ok(norm01(0.6) > 0.6, 'values above the middle must be pushed up');
  assert.ok(norm01(0.4) < 0.4, 'values below the middle must be pushed down');

  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const n = norm01(i / 100);
    assert.ok(n >= 0 && n <= 1, 'norm01 must stay in range');
    assert.ok(n >= prev, 'norm01 must be monotonic');
    prev = n;
  }

  // And statistically: the spread of real fBm samples must actually widen.
  const raw: number[] = [];
  const norm: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const v = fbm2(i * 0.031, i * 0.017, 5, 5);
    raw.push(v);
    norm.push(norm01(v));
  }
  const sd = (xs: number[]): number => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
  };
  assert.ok(sd(norm) > sd(raw) * 1.8, `spread only grew from ${sd(raw).toFixed(3)} to ${sd(norm).toFixed(3)}`);
});

test('ridge2 peaks at 1 and stays in range', () => {
  let hi = -Infinity;
  for (let i = 0; i < 4000; i++) {
    const r = ridge2(i * 0.02, i * 0.013, 9, 3);
    assert.ok(r >= 0 && r <= 1);
    hi = Math.max(hi, r);
  }
  assert.ok(hi > 0.97, 'ridges should reach their crest, or thresholds never fire');
});
