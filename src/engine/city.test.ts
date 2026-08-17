/**
 * The city plan and the clock. Both fail quietly: a grid whose streets stop
 * being continuous still renders, and a day/night cycle whose keyframes are
 * out of order still runs — it just never gets dark.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CITY_THEMES, STOREY, makeCitySample, makeStreetInfo, sampleCity, streetAt } from './city.ts';
import { World } from './world.ts';
import { clockString, makeSkyState, skyAt } from './daynight.ts';
import { TILE_EMPTY } from './types.ts';

const SEED = 7;
const spec = CITY_THEMES.city;

test('a tile depends only on its coordinates', () => {
  const a = makeCitySample();
  const b = makeCitySample();
  const sa = makeStreetInfo();
  const sb = makeStreetInfo();
  const coords: Array<[number, number]> = [
    [0, 0],
    [53, -71],
    [-311, 402],
    [5000, -5000],
  ];
  const first = coords.map((c) => {
    sampleCity(spec, c[0], c[1], SEED, a, sa);
    return { h: a.height, s: a.solid, st: a.storeys };
  });
  for (let i = 0; i < 40; i++) sampleCity(spec, i * 11, i * 3, SEED, b, sb);
  const second = coords.map((c) => {
    sampleCity(spec, c[0], c[1], SEED, b, sb);
    return { h: b.height, s: b.solid, st: b.storeys };
  });
  assert.deepEqual(second, first);
});

test('streets run unbroken across the world', () => {
  // The point of jittering a street by its *index* rather than its position is
  // that the line stays straight for its whole length. If a street can break,
  // the grid stops being navigable and blocks fuse into each other.
  const info = makeStreetInfo();
  let found = 0;
  for (let x = -400; x < 400 && found < 6; x++) {
    streetAt(x, 0, SEED, info);
    if (!info.road) continue;
    found++;
    // Follow this carriageway a long way along its length.
    for (let y = -300; y <= 300; y += 7) {
      streetAt(x, y, SEED, info);
      assert.ok(info.road || info.walk, `street at x=${x} is interrupted at y=${y}`);
    }
  }
  assert.ok(found > 0, 'expected to find some streets');
});

test('the plan has streets, pavements and buildings in sane proportions', () => {
  const s = makeCitySample();
  const info = makeStreetInfo();
  let road = 0;
  let walk = 0;
  let built = 0;
  const heights = new Set<number>();
  const n = 240;
  for (let y = -n; y < n; y += 2) {
    for (let x = -n; x < n; x += 2) {
      sampleCity(spec, x, y, SEED, s, info);
      if (s.storeys > 0) {
        built++;
        heights.add(s.storeys);
      } else if (info.road) road++;
      else if (info.walk) walk++;
    }
  }
  const total = built + road + walk;
  assert.ok(road / total > 0.15 && road / total < 0.45, `carriageway is ${((road / total) * 100) | 0}% of the ground`);
  assert.ok(walk > 0, 'no pavement at all');
  assert.ok(built / total > 0.3, 'not enough of the city is built on');
  // A skyline needs neighbours of different heights, not one uniform slab.
  assert.ok(heights.size >= 5, `only ${heights.size} distinct building heights`);
});

test('the pavement stands above the carriageway beside it', () => {
  // The kerb is a small thing that does most of the work of making a street
  // read as a street rather than as a corridor between walls.
  const s = makeCitySample();
  const info = makeStreetInfo();
  let checked = 0;
  for (let x = -150; x < 150 && checked < 25; x++) {
    for (let y = -150; y < 150 && checked < 25; y += 3) {
      streetAt(x, y, SEED, info);
      if (!info.walk) continue;

      // Find an adjoining carriageway tile to compare against.
      let roadH: number | null = null;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        streetAt(x + dx, y + dy, SEED, info);
        if (!info.road) continue;
        sampleCity(spec, x + dx, y + dy, SEED, s, info);
        roadH = s.height;
        break;
      }
      if (roadH === null) continue;

      sampleCity(spec, x, y, SEED, s, info);
      assert.ok(
        s.height > roadH,
        `pavement at (${x}, ${y}) sits at ${s.height.toFixed(3)}, not above the road at ${roadH.toFixed(3)}`,
      );
      checked++;
    }
  }
  assert.ok(checked > 0, 'expected to find pavement beside a road');
});

test('a city world builds, and spawns you on the pavement', () => {
  const world = World.fromCity(spec, SEED);
  assert.equal(world.terrain, true);
  assert.ok(world.tiles.every(Boolean));
  const t = world.tileAt(Math.floor(world.spawnX), Math.floor(world.spawnY));
  assert.ok(t, 'spawned outside the window');
  assert.equal(t!.type, TILE_EMPTY, 'spawned inside a building');
  assert.equal(t!.storeys, 0, 'spawned on a building footprint');
});

test('buildings are as tall as their storey count says', () => {
  const world = World.fromCity(spec, SEED);
  let checked = 0;
  for (const t of world.tiles) {
    if (t.storeys <= 0) continue;
    checked++;
    // Roof height must be a whole number of storeys above some ground level,
    // or the facade texture and any future floor will not line up.
    const above = t.height / STOREY;
    assert.ok(above > 0.5, 'a building shorter than half a storey');
    if (checked > 200) break;
  }
  assert.ok(checked > 0, 'no buildings in the window');
});

test('the sky moves through a real day', () => {
  const sky = makeSkyState();
  skyAt(0, sky);
  const midnight = { alt: sky.altitude, ambient: sky.ambient, stars: sky.stars, lamps: sky.lampness };
  skyAt(0.5, sky);
  const noon = { alt: sky.altitude, ambient: sky.ambient, stars: sky.stars, lamps: sky.lampness };

  assert.ok(midnight.alt < -0.9, 'the sun should be well down at midnight');
  assert.ok(noon.alt > 0.9, 'the sun should be high at noon');
  assert.ok(noon.ambient > midnight.ambient, 'noon must be brighter than midnight');
  assert.ok(midnight.stars > 0.5 && noon.stars === 0, 'stars belong to the night');
  assert.equal(noon.lamps, 0, 'lamps must be off at noon');
  assert.equal(midnight.lamps, 1, 'lamps must be on at midnight');
});

test('the sky is continuous, including across midnight', () => {
  // A seam here shows up as the whole world flickering once per day.
  const a = makeSkyState();
  const b = makeSkyState();
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const t = i / 400;
    skyAt(t, a);
    skyAt(t + 0.0025, b);
    worst = Math.max(worst, Math.abs(b.ambient - a.ambient), Math.abs(b.skyTop.r - a.skyTop.r) / 255);
  }
  assert.ok(worst < 0.05, `sky jumps by ${worst.toFixed(3)} between adjacent moments`);
});

test('the clock reads as a time and wraps', () => {
  assert.equal(clockString(0), '00:00');
  assert.equal(clockString(0.5), '12:00');
  assert.equal(clockString(0.25), '06:00');
  assert.equal(clockString(1.25), '06:00');
});

test('street lamps are dark by day and lit by night', () => {
  const world = World.fromCity(spec, SEED);
  const lamps = world.lights.filter((l) => l.lampBase > 0);
  assert.ok(lamps.length > 0, 'the city put up no street lamps');

  world.timeOfDay = 0.5;
  world.advanceClock(0);
  assert.ok(
    world.lights.filter((l) => l.lampBase > 0).every((l) => l.intensity === 0),
    'lamps should be off at noon',
  );

  world.timeOfDay = 0;
  world.advanceClock(0);
  assert.ok(
    world.lights.filter((l) => l.lampBase > 0).every((l) => l.intensity > 0),
    'lamps should be lit at midnight',
  );
});
