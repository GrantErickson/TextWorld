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
  // After dark, so the only thing the roof changes is what is overhead. By
  // day it also — correctly — puts the street below it into shade, and the
  // point of the second half of this test is that the *geometry* under the
  // horizon does not move.
  world.timeOfDay = 0.02;
  world.advanceClock(0);
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

  const px = door.x + 0.5 + door.fx * 1.5;
  const py = door.y + 0.5 + door.fy * 1.5;
  const t = world.tileAt(Math.floor(px), Math.floor(py));
  assert.ok(t && t.interior, 'expected to be standing inside');

  // Over four headings. Rooms are a few tiles across, so one heading can be
  // most of one wall and says more about which way it happens to face than
  // about whether the room is lit.
  const hist = new Map<number, number>();
  let cells = 0;
  for (const turn of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    cam.placeAt(px, py, Math.atan2(door.fy, door.fx) + turn, t!.bed, world.eyeHeight);
    world.update(1 / 60, cam.x, cam.y);
    r.buf.invalidate();
    r.render(world, cam, 0.5);
    for (let i = 0; i < COLS * ROWS; i++) {
      hist.set(r.buf.glyph[i], (hist.get(r.buf.glyph[i]) ?? 0) + 1);
      cells++;
    }
  }
  const top = Math.max(...hist.values()) / cells;
  assert.ok(top < 0.6, `the commonest glyph holds ${(top * 100).toFixed(0)}% of the room`);
  assert.ok(hist.size >= 3, `a room drawn with ${hist.size} distinct glyphs is a wash`);
});

test('a building is divided into rooms, and every one of them can be got to', () => {
  // The failure this is here for is silent in the worst way: a partition rule
  // that walls a room off completely leaves a building that looks exactly
  // right from the street and has a space inside it nobody can ever reach.
  const world = World.fromCity(CITY_THEMES.city, 7);
  const w = world.width;
  const at = (x: number, y: number) => world.tileAt(x, y);

  let inside = 0;
  let walled = 0;
  for (let y = world.originY + 1; y < world.originY + world.height - 1; y++) {
    for (let x = world.originX + 1; x < world.originX + w - 1; x++) {
      const t = at(x, y);
      if (!t || t.storeys === 0) continue;
      if (t.interior) inside++;
      else walled++;
    }
  }
  assert.ok(inside > 500, `only ${inside} tiles of room in the whole window`);

  // Flood from the street over anything walkable, refusing steps too big for
  // the legs — the same rule the camera obeys.
  const seen = new Uint8Array(w * world.height);
  const queue: number[] = [];
  const idx = (x: number, y: number) => (y - world.originY) * w + (x - world.originX);
  for (let y = world.originY + 1; y < world.originY + world.height - 1; y++) {
    for (let x = world.originX + 1; x < world.originX + w - 1; x++) {
      const t = at(x, y);
      if (!t || t.storeys > 0) continue;
      seen[idx(x, y)] = 1;
      queue.push(x, y);
    }
  }
  for (let head = 0; head < queue.length; head += 2) {
    const x = queue[head];
    const y = queue[head + 1];
    const from = at(x, y)!;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx <= world.originX || ny <= world.originY) continue;
      if (nx >= world.originX + w - 1 || ny >= world.originY + world.height - 1) continue;
      const i = idx(nx, ny);
      if (seen[i]) continue;
      const t = at(nx, ny);
      if (!t || (t.storeys > 0 && !t.interior)) continue;
      if (t.bed - from.bed > 0.55) continue;
      seen[i] = 1;
      queue.push(nx, ny);
    }
  }

  let reached = 0;
  for (let y = world.originY + 1; y < world.originY + world.height - 1; y++) {
    for (let x = world.originX + 1; x < world.originX + w - 1; x++) {
      const t = at(x, y);
      if (t && t.interior && seen[idx(x, y)]) reached++;
    }
  }
  const share = reached / inside;
  assert.ok(share > 0.9, `only ${(share * 100).toFixed(0)}% of the rooms can be walked to`);

  // And there have to *be* partitions, or this passes for the wrong reason:
  // one open hall per building is trivially all-reachable.
  let inner = 0;
  for (let y = world.originY + 2; y < world.originY + world.height - 2; y++) {
    for (let x = world.originX + 2; x < world.originX + w - 2; x++) {
      const t = at(x, y);
      if (!t || t.storeys === 0 || t.interior) continue;
      // A wall with room on both sides is a partition, not a facade.
      const h = at(x - 1, y)?.interior && at(x + 1, y)?.interior;
      const v = at(x, y - 1)?.interior && at(x, y + 1)?.interior;
      if (h || v) inner++;
    }
  }
  assert.ok(inner > 60, `only ${inner} partition tiles: the buildings are still one room each`);
  assert.ok(walled > inner, 'more partition than facade, which is the wrong way round');
});

test('every room has a lamp in it', () => {
  // Rooms are lit from the lot's own lattice, not a lattice over the world.
  // A world lattice is what this had while a footprint was one big room, and
  // partitions broke it silently: over half the rooms ended up with no lamp
  // anywhere in them, and which ones went dark depended on where the lot fell.
  const world = World.fromCity(CITY_THEMES.city, 7);
  const lamps = world.lights.filter((l) => l.lampBase === 0 && l.radius > 3);
  assert.ok(lamps.length > 4, `only ${lamps.length} room lamps`);

  let rooms = 0;
  let lit = 0;
  for (let y = Math.floor(world.spawnY) - 12; y <= Math.floor(world.spawnY) + 12; y++) {
    for (let x = Math.floor(world.spawnX) - 12; x <= Math.floor(world.spawnX) + 12; x++) {
      const t = world.tileAt(x, y);
      if (!t || !t.interior) continue;
      rooms++;
      for (const l of lamps) {
        if (Math.hypot(l.x - (x + 0.5), l.y - (y + 0.5)) <= l.radius) {
          lit++;
          break;
        }
      }
    }
  }
  assert.ok(rooms > 20, `only ${rooms} room tiles near the spawn to check`);
  assert.ok(lit / rooms > 0.9, `${(100 - (100 * lit) / rooms).toFixed(0)}% of the floor is out of reach of any lamp`);
});

test('rooms have something standing in them', () => {
  const world = World.fromCity(CITY_THEMES.city, 7);
  const furniture = new Set(['table', 'chair', 'shelf', 'counter', 'crate', 'houseplant', 'desklamp']);
  let indoors = 0;
  const kinds = new Set<string>();
  for (const e of world.entities) {
    if (!furniture.has(e.def.id)) continue;
    const t = world.tileAt(Math.floor(e.x), Math.floor(e.y));
    assert.ok(t && t.interior, `a ${e.def.id} ended up outside a room at (${e.x}, ${e.y})`);
    assert.ok(Math.abs(e.z - t!.bed) < 1.2, `a ${e.def.id} is floating off its floor`);
    indoors++;
    kinds.add(e.def.id);
  }
  assert.ok(indoors > 10, `only ${indoors} pieces of furniture in the whole window`);
  assert.ok(kinds.size >= 4, `only ${kinds.size} kinds of thing in every room in the city`);
});

test('open ground reports no ceiling at all', () => {
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const t = world.tileAt(Math.floor(world.spawnX), Math.floor(world.spawnY));
  assert.ok(t && t.type === TILE_EMPTY);
  const r = world.surfaceUnder(Math.floor(world.spawnX), Math.floor(world.spawnY), t!.height, spans);
  assert.ok(Math.abs(r.floor - t!.height) < 1e-9);
  assert.equal(r.ceiling, Infinity, 'the sky is not a ceiling');
});
