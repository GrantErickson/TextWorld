/**
 * The span model, step one of interiors.
 *
 * Its whole point at this stage is that it changes *nothing*: a column with a
 * single span is the world exactly as the engine has always drawn and walked
 * it. Proving that here is what makes the renderer surgery that follows
 * checkable — it can be landed and compared against a known-good picture
 * before any building is hollowed out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Span } from './world.ts';
import { SLAB, World } from './world.ts';
import { CITY_THEMES, STOREY } from './city.ts';
import { TERRAIN_THEMES } from './terrain.ts';
import { TILE_EMPTY } from './types.ts';

const spans: Span[] = [];

test('every column in every world is still a single span', () => {
  const worlds = [World.fromCity(CITY_THEMES.city, 7), World.fromTerrain(TERRAIN_THEMES.wilds, 2024)];
  for (const world of worlds) {
    for (let y = world.originY; y < world.originY + world.height; y += 3) {
      for (let x = world.originX; x < world.originX + world.width; x += 3) {
        const t = world.tileAt(x, y);
        if (!t) continue;
        const n = world.spansAt(x, y, spans);
        assert.equal(n, 1, `column (${x}, ${y}) already has ${n} spans`);
        assert.equal(spans[0].hi, t.height, 'the span must top out at the tile height');
        assert.ok(spans[0].lo < spans[0].hi, 'a span must have some thickness');
      }
    }
  }
});

test('a hollow column stacks a slab per storey', () => {
  // Nothing generates these yet, so drive it directly off a tile.
  // Set the storey count rather than hunting for one: how tall the buildings
  // near the spawn happen to be is the generator's business, not this test's.
  const world = World.fromCity(CITY_THEMES.city, 7);
  const target = world.tiles.find((t) => t.storeys > 0);
  assert.ok(target, 'no buildings at all');

  const tile = target!;
  tile.storeys = 4;
  tile.height = 40;
  const base = tile.height - tile.storeys * STOREY;
  tile.interior = true;
  try {
    // Find it again by scanning for the tile we just altered.
    let found = false;
    for (let y = world.originY; y < world.originY + world.height && !found; y++) {
      for (let x = world.originX; x < world.originX + world.width; x++) {
        if (world.tileAt(x, y) !== tile) continue;
        found = true;
        const n = world.spansAt(x, y, spans);
        assert.equal(n, tile.storeys + 1, 'expected the ground plus one slab per storey');
        assert.equal(spans[0].hi, base, 'the ground floor sits at the building base');
        for (let k = 1; k <= tile.storeys; k++) {
          assert.ok(Math.abs(spans[k].hi - (base + k * STOREY)) < 1e-9, `slab ${k} is at the wrong height`);
          assert.ok(Math.abs(spans[k].hi - spans[k].lo - SLAB) < 1e-9, `slab ${k} is the wrong thickness`);
        }
        // And the air between two slabs has to be tall enough to stand in.
        assert.ok(spans[1].lo - spans[0].hi > 2, 'the ground floor has no headroom');
        break;
      }
    }
    assert.ok(found, 'lost the tile we were testing');
  } finally {
    tile.interior = false;
  }
});

test('surfaceUnder finds the floor you are on and the ceiling above it', () => {
  const world = World.fromCity(CITY_THEMES.city, 7);
  let tile = null;
  let at: [number, number] = [0, 0];
  for (let y = world.originY; y < world.originY + world.height && !tile; y++) {
    for (let x = world.originX; x < world.originX + world.width; x++) {
      const t = world.tileAt(x, y);
      if (!t || t.storeys <= 0) continue;
      tile = t;
      at = [x, y];
      break;
    }
  }
  assert.ok(tile, 'no building to test against');
  tile!.storeys = 4;
  tile!.height = 40;

  const base = tile!.height - tile!.storeys * STOREY;
  tile!.interior = true;
  try {
    // Standing on the ground floor.
    const ground = world.surfaceUnder(at[0], at[1], base, spans);
    assert.ok(Math.abs(ground.floor - base) < 1e-9, 'should be standing on the base');
    assert.ok(Math.abs(ground.ceiling - (base + STOREY - SLAB)) < 1e-9, 'wrong ceiling over the ground floor');

    // Standing on the first floor.
    const first = world.surfaceUnder(at[0], at[1], base + STOREY, spans);
    assert.ok(Math.abs(first.floor - (base + STOREY)) < 1e-9, 'should be standing on the first floor slab');
  } finally {
    tile!.interior = false;
  }
});

test('open ground reports no ceiling at all', () => {
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const t = world.tileAt(Math.floor(world.spawnX), Math.floor(world.spawnY));
  assert.ok(t && t.type === TILE_EMPTY);
  const r = world.surfaceUnder(Math.floor(world.spawnX), Math.floor(world.spawnY), t!.height, spans);
  assert.ok(Math.abs(r.floor - t!.height) < 1e-9);
  assert.equal(r.ceiling, Infinity, 'the sky is not a ceiling');
});
