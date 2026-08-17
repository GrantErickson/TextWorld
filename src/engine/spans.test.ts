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
import { Camera } from './camera.ts';
import { Renderer } from './renderer.ts';
import { CITY_THEMES, STOREY } from './city.ts';
import { TERRAIN_THEMES } from './terrain.ts';
import { TILE_EMPTY } from './types.ts';

const spans: Span[] = [];

test('a column is a single span everywhere but inside a building', () => {
  // Interiors are a city feature, and every other world has to go on being
  // exactly what it was: one surface per tile, marched with one front.
  const worlds = [World.fromCity(CITY_THEMES.city, 7), World.fromTerrain(TERRAIN_THEMES.wilds, 2024)];
  for (const world of worlds) {
    for (let y = world.originY; y < world.originY + world.height; y += 3) {
      for (let x = world.originX; x < world.originX + world.width; x += 3) {
        const t = world.tileAt(x, y);
        if (!t) continue;
        const n = world.spansAt(x, y, spans);
        if (t.interior) {
          assert.ok(n > 1, `a room at (${x}, ${y}) is still solid`);
          continue;
        }
        assert.equal(n, 1, `column (${x}, ${y}) has ${n} spans`);
        assert.equal(spans[0].hi, t.height, 'the span must top out at the tile height');
        assert.ok(spans[0].lo < spans[0].hi, 'a span must have some thickness');
      }
    }
  }
});

test('the wilds never grow an inside', () => {
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  assert.ok(
    world.tiles.every((t) => !t.interior && t.storeys === 0),
    'a landscape tile came back with storeys',
  );
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

test('a slab overhead is drawn as a ceiling where there would be sky', () => {
  // The renderer had never drawn an underside in its life, and this is the
  // only thing that exercises the path before buildings are hollowed out. It
  // fails silently in both directions worth caring about: a ceiling projected
  // into the wrong rows still produces a plausible frame, and one whose
  // distance comes out inverted produces a plausible frame that is inside out.
  const world = World.fromCity(CITY_THEMES.city, 7);
  const cam = new Camera();
  const r = new Renderer();
  const COLS = 60;
  const ROWS = 24;
  r.resize(COLS, ROWS);

  cam.placeAt(world.spawnX, world.spawnY, world.spawnAngle, world.groundAt(world.spawnX, world.spawnY));
  world.update(0.016, cam.x, cam.y);
  r.buf.invalidate();
  r.render(world, cam, 0.5);
  const openGlyph = r.buf.glyph.slice();
  const openFg = r.buf.fg.slice();

  // A single tile's ceiling sits directly overhead and out of shot, so it
  // takes a room's worth of them before any of it reaches the top of the
  // screen. Only open ground is roofed over, and the slab count is chosen so
  // the ground span keeps the height it already had — the frame below the
  // horizon then has to come back unchanged, which is the other half of this.
  const cx = Math.floor(world.spawnX);
  const cy = Math.floor(world.spawnY);
  let roofed = 0;
  for (let y = cy - 9; y <= cy + 9; y++) {
    for (let x = cx - 9; x <= cx + 9; x++) {
      const t = world.tileAt(x, y);
      if (!t || t.storeys > 0) continue;
      t.storeys = 2;
      t.height = t.height + 2 * STOREY;
      t.interior = true;
      roofed++;
    }
  }
  assert.ok(roofed > 100, `only ${roofed} tiles to roof over`);

  r.buf.invalidate();
  r.render(world, cam, 0.5);

  const horizon = ROWS * 0.5;
  let above = 0;
  let below = 0;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      if (r.buf.glyph[i] === openGlyph[i] && r.buf.fg[i] === openFg[i]) continue;
      if (y + 0.5 < horizon) above++;
      else below++;
    }
  }
  assert.ok(above > 200, `a roof over the street changed only ${above} cells above the horizon`);
  assert.equal(below, 0, `${below} cells below the horizon moved when only the sky should have`);
});

/** A way into a building near the spawn: the tile, and the way in from the street. */
function findDoorway(world: World): { x: number; y: number; fx: number; fy: number } {
  let best = Infinity;
  let found: { x: number; y: number; fx: number; fy: number } | null = null;
  for (let y = world.originY + 2; y < world.originY + world.height - 2; y++) {
    for (let x = world.originX + 2; x < world.originX + world.width - 2; x++) {
      const t = world.tileAt(x, y);
      if (!t || !t.interior) continue;
      const d = (x - world.spawnX) ** 2 + (y - world.spawnY) ** 2;
      if (d >= best) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        // Open ground next door: pavement, road or yard. Asking the tiles
        // rather than the generator keeps this a test of the world that came
        // out rather than of the rule that made it.
        const n = world.tileAt(x + dx, y + dy);
        if (!n || n.storeys > 0) continue;
        found = { x, y, fx: -dx, fy: -dy };
        best = d;
        break;
      }
    }
  }
  assert.ok(found, 'the city built no way into any building');
  return found!;
}

test('you can walk in off the street, and stand up inside', () => {
  const world = World.fromCity(CITY_THEMES.city, 7);
  const door = findDoorway(world);
  const cam = new Camera();
  const push = { forward: 1, strafe: 0, turn: 0, mouseDX: 0, mouseDY: 0, run: false, jump: false, lift: 0 };

  // Start on the pavement outside, facing the opening.
  const sx = door.x + 0.5 - door.fx * 2;
  const sy = door.y + 0.5 - door.fy * 2;
  const start = world.tileAt(Math.floor(sx), Math.floor(sy));
  assert.ok(start && !start.interior && start.storeys === 0, 'expected to start on the street');
  cam.placeAt(sx, sy, Math.atan2(door.fy, door.fx), start!.bed, world.eyeHeight);

  for (let i = 0; i < 300; i++) cam.update(1 / 60, push, world, 40);

  const t = world.tileAt(Math.floor(cam.x), Math.floor(cam.y));
  assert.ok(t && t.interior, 'walked at the doorway for five seconds and never got in');

  // Standing on the floor of the room, not on its roof and not in the slab.
  const feet = cam.z - world.eyeHeight;
  const r = world.surfaceUnder(Math.floor(cam.x), Math.floor(cam.y), feet, spans);
  assert.ok(Math.abs(feet - r.floor) < 0.06, `feet at ${feet.toFixed(2)}, floor at ${r.floor.toFixed(2)}`);
  assert.ok(r.ceiling > cam.z + 1, `only ${(r.ceiling - cam.z).toFixed(2)} tiles of headroom`);
  assert.ok(r.ceiling < r.floor + STOREY, 'the ceiling is more than a storey up');
});

test('a wall keeps you out of the building it encloses', () => {
  // The other half of the doorway: everything that is not one has to refuse.
  const world = World.fromCity(CITY_THEMES.city, 7);
  const cam = new Camera();
  const push = { forward: 1, strafe: 0, turn: 0, mouseDX: 0, mouseDY: 0, run: false, jump: false, lift: 0 };

  let tried = 0;
  for (let y = world.originY + 4; y < world.originY + world.height - 4 && tried < 8; y++) {
    for (let x = world.originX + 4; x < world.originX + world.width - 4 && tried < 8; x++) {
      const t = world.tileAt(x, y);
      // A solid wall tile with pavement on one side and the building's inside
      // two tiles the other way: walking at it must not get you through.
      if (!t || t.storeys === 0 || t.interior) continue;
      const out = world.tileAt(x - 1, y);
      const into = world.tileAt(x + 2, y);
      if (!out || out.storeys !== 0 || !into || !into.interior) continue;
      tried++;
      cam.placeAt(x - 1.5, y + 0.5, 0, out.bed, world.eyeHeight);
      for (let i = 0; i < 240; i++) cam.update(1 / 60, push, world, 40);
      const now = world.tileAt(Math.floor(cam.x), Math.floor(cam.y));
      assert.ok(now && !now.interior, `walked through the wall at (${x}, ${y})`);
    }
  }
  assert.ok(tried > 0, 'found no wall to walk into');
});

test('a room is lit, not a flat wash', () => {
  // An interior has no sun in it and the city ambient is set for a street, so
  // a room with no lamp in it renders as one glyph over almost the whole
  // frame — a perfectly valid picture of nothing, which is exactly the kind of
  // failure that does not show up in a typecheck.
  const world = World.fromCity(CITY_THEMES.city, 7);
  const door = findDoorway(world);
  const cam = new Camera();
  const r = new Renderer();
  const COLS = 80;
  const ROWS = 28;
  r.resize(COLS, ROWS);

  const px = door.x + 0.5 + door.fx * 2.5;
  const py = door.y + 0.5 + door.fy * 2.5;
  const t = world.tileAt(Math.floor(px), Math.floor(py));
  assert.ok(t && t.interior, 'expected to be standing inside');
  cam.placeAt(px, py, Math.atan2(door.fy, door.fx), t!.bed, world.eyeHeight);
  world.update(1 / 60, cam.x, cam.y);
  r.buf.invalidate();
  r.render(world, cam, 0.5);

  const hist = new Map<number, number>();
  for (let i = 0; i < COLS * ROWS; i++) hist.set(r.buf.glyph[i], (hist.get(r.buf.glyph[i]) ?? 0) + 1);
  const top = Math.max(...hist.values()) / (COLS * ROWS);
  assert.ok(top < 0.6, `the commonest glyph holds ${(top * 100).toFixed(0)}% of the room`);
  assert.ok(hist.size >= 3, `a room drawn with ${hist.size} distinct glyphs is a wash`);
});

test('open ground reports no ceiling at all', () => {
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const t = world.tileAt(Math.floor(world.spawnX), Math.floor(world.spawnY));
  assert.ok(t && t.type === TILE_EMPTY);
  const r = world.surfaceUnder(Math.floor(world.spawnX), Math.floor(world.spawnY), t!.height, spans);
  assert.ok(Math.abs(r.floor - t!.height) < 1e-9);
  assert.equal(r.ceiling, Infinity, 'the sky is not a ceiling');
});
