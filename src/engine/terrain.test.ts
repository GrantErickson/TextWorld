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

import { TERRAIN_THEMES, landHeight, makeSample, sampleTerrain, waterTable } from './terrain.ts';
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

test('water sits in the ground, never on it', () => {
  // The bed/surface split is the whole water model. If they ever collapse back
  // into one field, water is painted on the terrain again and every lake goes
  // back to running down the side of a hill.
  for (const theme of Object.values(TERRAIN_THEMES)) {
    const s = makeSample();
    let wet = 0;
    for (let y = -200; y < 200; y += 3) {
      for (let x = -200; x < 200; x += 3) {
        sampleTerrain(theme, x, y, SEED, s);
        assert.ok(s.bed <= s.height + 1e-9, `${theme.id}: the bed must never rise above the surface`);
        assert.ok(Math.abs(s.height - s.bed - s.depth) < 1e-9, `${theme.id}: depth must be surface - bed`);
        if (s.water) {
          wet++;
          assert.ok(s.depth > 0, `${theme.id}: a water tile with no depth is dry ground painted blue`);
          assert.ok(!s.solid, `${theme.id}: a building wall cannot also be water`);
        } else {
          assert.equal(s.depth, 0, `${theme.id}: dry ground must have no depth`);
        }
      }
    }
    assert.ok(wet > 0, `theme "${theme.id}" generated no water at all`);
  }
});

test('a water surface is level, or falls by a whole step', () => {
  // This is the request in one assertion. The surface is a quantised field, so
  // every water tile's height is an exact multiple of the pool step: within a
  // pool the difference between neighbours is 0, and where it is not, it is a
  // whole step — a waterfall. What must never appear is a small non-zero
  // difference, which is a sloping lake.
  for (const theme of Object.values(TERRAIN_THEMES)) {
    const a = makeSample();
    const b = makeSample();
    let pairs = 0;
    for (let y = -200; y < 200; y += 3) {
      for (let x = -200; x < 200; x += 3) {
        sampleTerrain(theme, x, y, SEED, a);
        if (!a.water) continue;

        const steps = (a.height - theme.waterOffset) / theme.pool;
        assert.ok(
          Math.abs(steps - Math.round(steps)) < 1e-6,
          `${theme.id}: water surface ${a.height} is not on the pool lattice`,
        );

        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ] as Array<[number, number]>) {
          sampleTerrain(theme, x + dx, y + dy, SEED, b);
          if (!b.water) continue;
          pairs++;
          const drop = Math.abs(a.height - b.height);
          const inSteps = drop / theme.pool;
          assert.ok(
            Math.abs(inSteps - Math.round(inSteps)) < 1e-6,
            `${theme.id}: neighbouring water differs by ${drop.toFixed(4)}, which is not a whole fall`,
          );
        }
      }
    }
    assert.ok(pairs > 20, `theme "${theme.id}" has too little water to judge`);
  }
});

test('most water is flat pool rather than falls', () => {
  // The lattice assertion above is satisfied by a staircase too. A world where
  // every tile of water is its own step has technically level pools, each one
  // tile wide, and reads as a rockery. Check that pools actually have extent.
  for (const theme of Object.values(TERRAIN_THEMES)) {
    const a = makeSample();
    const b = makeSample();
    let level = 0;
    let stepped = 0;
    for (let y = -220; y < 220; y++) {
      for (let x = -220; x < 220; x += 2) {
        sampleTerrain(theme, x, y, SEED, a);
        if (!a.water) continue;
        sampleTerrain(theme, x + 1, y, SEED, b);
        if (!b.water) continue;
        if (Math.abs(a.height - b.height) < 1e-9) level++;
        else stepped++;
      }
    }
    const flat = level / Math.max(1, level + stepped);
    assert.ok(flat > 0.9, `theme "${theme.id}": only ${(flat * 100).toFixed(1)}% of water neighbours are level`);
  }
});

test('the water table is a pure function of position', () => {
  // Same contract as the rest of the generator: no memory, no order effects,
  // or a lake changes shape when you walk back to it.
  const theme = TERRAIN_THEMES.wilds;
  const first: number[] = [];
  const coords: Array<[number, number]> = [
    [0, 0],
    [61, -17],
    [-333, 208],
    [12000, 4000],
  ];
  for (const [x, y] of coords) first.push(waterTable(theme, x, y, SEED));
  for (let i = 0; i < 40; i++) waterTable(theme, i * 31, i * 17, SEED);
  const second = coords.map(([x, y]) => waterTable(theme, x, y, SEED));
  assert.deepEqual(second, first, 'the water table must not depend on what was sampled before it');
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
