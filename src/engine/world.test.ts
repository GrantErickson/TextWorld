/**
 * World-level invariants: the things that make a generated world *playable*
 * rather than merely valid. Most of these were failures at some point —
 * unreachable rooms, a spawn inside solid rock, terrain that changed shape
 * when you walked away and came back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from './world.ts';
import { parseMapSource } from './mapFormat.ts';
import { TILE_EMPTY } from './types.ts';
import { THEMES } from './themes.ts';
import { TERRAIN_THEMES } from './terrain.ts';
import { PRESETS } from '../maps.ts';
import { Camera } from './camera.ts';

/** Open tiles reachable on foot from the spawn, and the total open count. */
function survey(world: World): { open: number; reach: number } {
  const w = world.width;
  const h = world.height;
  const seen = new Uint8Array(w * h);
  const sx = Math.floor(world.spawnX) - world.originX;
  const sy = Math.floor(world.spawnY) - world.originY;
  const stack = [sy * w + sx];
  seen[stack[0]] = 1;
  let reach = 0;
  while (stack.length) {
    const i = stack.pop() as number;
    reach++;
    const x = i % w;
    const y = (i - x) / w;
    const push = (j: number): void => {
      if (seen[j] || world.tiles[j].type !== TILE_EMPTY) return;
      seen[j] = 1;
      stack.push(j);
    };
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  let open = 0;
  for (let i = 0; i < w * h; i++) if (world.tiles[i].type === TILE_EMPTY) open++;
  return { open, reach };
}

test('every shipped preset builds', () => {
  for (const preset of PRESETS) {
    const world = World.fromSource(parseMapSource(preset.source));
    assert.ok(world.width >= 3 && world.height >= 3, `${preset.id} has no size`);
    assert.ok(world.tiles.every(Boolean), `${preset.id} left holes in its tile array`);
  }
});

test('every preset spawns somewhere you can stand', () => {
  for (const preset of PRESETS) {
    const world = World.fromSource(parseMapSource(preset.source));
    assert.ok(
      world.canOccupy(world.spawnX, world.spawnY, 0.24),
      `${preset.id} spawns inside geometry at (${world.spawnX}, ${world.spawnY})`,
    );
  }
});

test('authored maps put doors on the axis of their wall run', () => {
  // A door on the wrong axis is a panel across the doorway you walk along
  // instead of through — invisible in the map source, obvious in the world.
  const world = World.fromSource(parseMapSource(PRESETS.find((p) => p.id === 'vault')!.source));
  assert.ok(world.doors.length > 0);
  for (const d of world.doors) {
    const solid = (x: number, y: number): boolean => {
      const t = world.tileAt(x, y);
      return !t || t.type !== TILE_EMPTY;
    };
    const we = solid(d.tx - 1, d.ty) && solid(d.tx + 1, d.ty);
    const ns = solid(d.tx, d.ty - 1) && solid(d.tx, d.ty + 1);
    if (we && !ns) assert.equal(d.axis, 'x', `door ${d.id} should span X`);
    else if (ns && !we) assert.equal(d.axis, 'y', `door ${d.id} should span Y`);
  }
});

test('dungeon worlds never fall back to the solver default', () => {
  // A non-zero failure count means the terrain is drifting toward whatever the
  // fallback happens to be, which is how the world quietly decays into rock.
  for (const id of Object.keys(THEMES)) {
    const world = World.fromTheme(THEMES[id], 1337);
    assert.equal(world.gen.failures, 0, `theme "${id}" fell back on ${world.gen.failures} solves`);
  }
});

test('every open tile of a dungeon is reachable from the spawn', () => {
  for (const id of Object.keys(THEMES)) {
    const world = World.fromTheme(THEMES[id], 1337);
    const { open, reach } = survey(world);
    assert.equal(reach, open, `theme "${id}": ${open - reach} of ${open} open tiles are stranded`);
  }
});

test('indoor worlds stay perfectly flat', () => {
  // The terrain fields exist on every tile; if an indoor map ever picks up a
  // height, the flat-floor renderer silently disagrees with collision.
  const world = World.fromSource(parseMapSource(PRESETS.find((p) => p.id === 'vault')!.source));
  assert.equal(world.terrain, false);
  for (const t of world.tiles) assert.equal(t.height, 0);
  assert.equal(world.groundAt(world.spawnX, world.spawnY), 0);
});

test('outdoor worlds are walkable where they say they are', () => {
  for (const id of Object.keys(TERRAIN_THEMES)) {
    const world = World.fromTerrain(TERRAIN_THEMES[id], 2024);
    assert.equal(world.terrain, true);
    const tile = world.tileAt(Math.floor(world.spawnX), Math.floor(world.spawnY));
    assert.ok(tile, `theme "${id}" spawned outside its own window`);
    assert.equal(tile!.type, TILE_EMPTY, `theme "${id}" spawned inside a building`);
    assert.equal(world.groundAt(world.spawnX, world.spawnY), tile!.height);
  }
});

/** Find a pair of side-by-side tiles whose height differs by more than `drop`. */
function findLedge(world: World, drop: number): [number, number] | null {
  for (let y = world.originY + 2; y < world.originY + world.height - 2; y++) {
    for (let x = world.originX + 2; x < world.originX + world.width - 2; x++) {
      const a = world.tileAt(x, y);
      const b = world.tileAt(x + 1, y);
      if (!a || !b || a.type !== TILE_EMPTY || b.type !== TILE_EMPTY) continue;
      if (Math.abs(a.height - b.height) > drop) return [x, y];
    }
  }
  return null;
}

test('a cliff cannot be climbed, but can be walked off', () => {
  // Refusing the way *down* as well was the bug behind getting stuck: it let
  // you walk into a hollow you could then never leave. A drop is a fall, not
  // an obstacle.
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const ledge = findLedge(world, 1.2);
  assert.ok(ledge, 'expected to find a cliff to test against');
  const [x, y] = ledge!;
  const a = world.tileAt(x, y)!;
  const b = world.tileAt(x + 1, y)!;
  const [lowX, highX] = a.height < b.height ? [x, x + 1] : [x + 1, x];

  assert.equal(
    world.canStep(lowX + 0.5, y + 0.5, highX + 0.5, y + 0.5, 0.24),
    false,
    'you should not be able to climb a cliff',
  );
  assert.equal(
    world.canStep(highX + 0.5, y + 0.5, lowX + 0.5, y + 0.5, 0.24),
    true,
    'you should be able to walk off a ledge',
  );
});

test('level ground is walkable', () => {
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  let checked = 0;
  for (let y = world.originY + 2; y < world.originY + world.height - 2 && checked < 5; y++) {
    for (let x = world.originX + 2; x < world.originX + world.width - 2 && checked < 5; x++) {
      const a = world.tileAt(x, y);
      const b = world.tileAt(x + 1, y);
      if (!a || !b || a.type !== TILE_EMPTY || b.type !== TILE_EMPTY) continue;
      if (Math.abs(a.height - b.height) > 0.02) continue;
      assert.equal(world.canStep(x + 0.5, y + 0.5, x + 1.5, y + 0.5, 0.24), true);
      checked++;
    }
  }
  assert.ok(checked > 0, 'expected to find level ground to test against');
});

test('being above a ledge is what lets you clear it', () => {
  // The airborne rule: what you can pass over is decided by where your feet
  // are, which is what makes jumping onto a ledge work.
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const ledge = findLedge(world, 1.2);
  assert.ok(ledge);
  const [x, y] = ledge!;
  const a = world.tileAt(x, y)!;
  const b = world.tileAt(x + 1, y)!;
  const [lowX, highX] = a.height < b.height ? [x, x + 1] : [x + 1, x];
  const top = Math.max(a.height, b.height);

  assert.equal(
    world.canStep(lowX + 0.5, y + 0.5, highX + 0.5, y + 0.5, 0.24, top - 0.1),
    true,
    'feet level with the ledge should clear it',
  );
  assert.equal(
    world.canStep(lowX + 0.5, y + 0.5, highX + 0.5, y + 0.5, 0.24, top - 2),
    false,
    'feet well below the ledge should still be stopped by its face',
  );
});

test('walking away and back gives the same land', () => {
  // The headline property of the outdoor generator. Memory is bounded, so the
  // window is thrown away and rebuilt — and because every tile is a function
  // of its coordinates, rebuilding must reproduce it exactly.
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const probes: Array<[number, number]> = [];
  const before: number[] = [];
  for (let i = 0; i < 24; i++) {
    const x = world.originX + 30 + i;
    const y = world.originY + 40 + ((i * 7) % 20);
    probes.push([x, y]);
    before.push(world.tileAt(x, y)!.height);
  }

  // Stream a long way off, then come back.
  for (let i = 1; i <= 12; i++) world.update(1 / 60, i * 40, i * 25);
  for (let i = 12; i >= 0; i--) world.update(1 / 60, i * 40, i * 25);
  world.update(1 / 60, world.spawnX, world.spawnY);

  for (let i = 0; i < probes.length; i++) {
    const t = world.tileAt(probes[i][0], probes[i][1]);
    assert.ok(t, 'probe fell outside the window after returning');
    assert.equal(t!.height, before[i], `terrain at ${probes[i]} changed after a round trip`);
  }
});

test('the camera rides the ground and cannot walk through a building', () => {
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const cam = new Camera();
  cam.placeAt(world.spawnX, world.spawnY, 0, world.bedAt(world.spawnX, world.spawnY));
  assert.ok(Math.abs(cam.z - (world.bedAt(cam.x, cam.y) + 0.5)) < 1e-9);

  const input = { forward: 1, strafe: 0, turn: 0, mouseDX: 0, mouseDY: 0, run: false, jump: false, lift: 0 };
  for (let i = 0; i < 600; i++) {
    cam.update(1 / 60, input, world, 40);
    world.update(1 / 60, cam.x, cam.y);
    input.turn = i % 90 === 0 ? 1 : 0;
    const tile = world.tileAt(Math.floor(cam.x), Math.floor(cam.y));
    assert.ok(tile, 'camera left the window');
    assert.equal(tile!.type, TILE_EMPTY, `camera entered solid geometry at frame ${i}`);
  }
  // The eye must have settled onto whatever it ended up standing on — or be
  // floating on whatever it ended up in.
  const restingOn = cam.swimming ? world.groundAt(cam.x, cam.y) : world.bedAt(cam.x, cam.y);
  assert.ok(Math.abs(cam.z - (restingOn + 0.5)) < 0.5);
});

const idle = { forward: 0, strafe: 0, turn: 0, mouseDX: 0, mouseDY: 0, run: false, jump: false, lift: 0 };

test('a jump rises and comes back down', () => {
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const cam = new Camera();
  cam.placeAt(world.spawnX, world.spawnY, 0, world.groundAt(world.spawnX, world.spawnY));
  const rest = cam.z;

  cam.update(1 / 60, { ...idle, jump: true }, world, 40);
  let peak = cam.z;
  for (let i = 0; i < 120; i++) {
    cam.update(1 / 60, idle, world, 40);
    peak = Math.max(peak, cam.z);
  }
  // High enough to scramble up a temperate terrace, not high enough to make
  // the badlands' taller ledges meaningless.
  assert.ok(peak - rest > 0.95, `jump only cleared ${(peak - rest).toFixed(2)} tiles`);
  assert.ok(peak - rest < 1.35, `jump cleared ${(peak - rest).toFixed(2)} tiles, which trivialises cliffs`);
  assert.ok(Math.abs(cam.z - rest) < 0.02, 'should have landed again');
  assert.equal(cam.grounded, true);
});

test('flying climbs, and will not sink through the ground', () => {
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const cam = new Camera();
  cam.placeAt(world.spawnX, world.spawnY, 0, world.groundAt(world.spawnX, world.spawnY));
  const rest = cam.z;

  cam.flying = true;
  for (let i = 0; i < 60; i++) cam.update(1 / 60, { ...idle, lift: 1 }, world, 40);
  assert.ok(cam.z > rest + 3, `expected to gain height, got ${(cam.z - rest).toFixed(2)}`);

  for (let i = 0; i < 600; i++) cam.update(1 / 60, { ...idle, lift: -1 }, world, 40);
  // The bed, not the surface: flying down into a lake should reach its floor.
  assert.ok(cam.z >= world.bedAt(cam.x, cam.y) + 0.49, 'flight must not drop through the floor');

  // And switching it off drops you back to the ground rather than leaving you
  // hovering.
  cam.flying = true;
  for (let i = 0; i < 60; i++) cam.update(1 / 60, { ...idle, lift: 1 }, world, 40);
  cam.flying = false;
  for (let i = 0; i < 300; i++) cam.update(1 / 60, idle, world, 40);
  const landed = cam.swimming ? world.groundAt(cam.x, cam.y) : world.bedAt(cam.x, cam.y);
  assert.ok(Math.abs(cam.z - (landed + 0.5)) < 0.5, 'should have come back down');
});

test('indoors the eye stays inside the room', () => {
  // The flat-floor passes project floor and ceiling from the eye height, and
  // outside the band between them the geometry folds through itself.
  const world = World.fromSource(parseMapSource(PRESETS.find((p) => p.id === 'vault')!.source));
  const cam = new Camera();
  cam.placeAt(world.spawnX, world.spawnY, 0);
  for (let i = 0; i < 240; i++) {
    cam.update(1 / 60, { ...idle, jump: true }, world, 40);
    assert.ok(cam.z > 0.1 && cam.z < 0.9, `eye left the room at z=${cam.z.toFixed(3)}`);
  }
  cam.flying = true;
  for (let i = 0; i < 240; i++) {
    cam.update(1 / 60, { ...idle, lift: 1 }, world, 40);
    assert.ok(cam.z < 0.9, `flying left the room at z=${cam.z.toFixed(3)}`);
  }
});

// ------------------------------------------------------------------- water

/** The deepest water tile in the window, or null if the world is dry. */
function deepestWater(world: World): { x: number; y: number; depth: number; surface: number } | null {
  let best: { x: number; y: number; depth: number; surface: number } | null = null;
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) {
      const t = world.tiles[y * world.width + x];
      if (!t.water) continue;
      if (!best || t.depth > best.depth) {
        best = { x: world.originX + x + 0.5, y: world.originY + y + 0.5, depth: t.depth, surface: t.height };
      }
    }
  }
  return best;
}

test('deep water floats the camera at the surface instead of on the bed', () => {
  // The bed/surface split only pays off if movement reads the bed and the eye
  // rides the surface. Get that backwards and you either walk on top of a lake
  // or drown on its floor, both of which look like renderer bugs.
  for (const theme of Object.values(TERRAIN_THEMES)) {
    const world = World.fromTerrain(theme, 2024);
    const spot = deepestWater(world);
    assert.ok(spot, `theme "${theme.id}" produced no water in its first window`);
    assert.ok(spot!.depth > 1, `deepest water is only ${spot!.depth.toFixed(2)} tiles`);

    const cam = new Camera();
    cam.placeAt(spot!.x, spot!.y, 0, world.bedAt(spot!.x, spot!.y));
    for (let i = 0; i < 180; i++) cam.update(1 / 60, idle, world, 40);

    assert.equal(cam.swimming, true, `${theme.id}: should be swimming in ${spot!.depth.toFixed(1)} tiles of water`);
    assert.ok(
      cam.z > spot!.surface && cam.z < spot!.surface + 0.4,
      `${theme.id}: eye at ${cam.z.toFixed(2)} should sit just above the surface at ${spot!.surface.toFixed(2)}`,
    );
    assert.ok(
      cam.z > world.bedAt(cam.x, cam.y) + 1,
      `${theme.id}: the eye sank toward the bed instead of floating`,
    );
  }
});

test('falling into a lake floats rather than dropping to the bed', () => {
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const spot = deepestWater(world)!;
  const cam = new Camera();
  // Well above the water: being *over* deep water must not float you in mid-air.
  cam.placeAt(spot.x, spot.y, 0, spot.surface + 6);
  assert.equal(cam.swimming, false);
  cam.update(1 / 60, idle, world, 40);
  assert.equal(cam.swimming, false, 'floating started before reaching the water');

  let lowest = cam.z;
  for (let i = 0; i < 300; i++) {
    cam.update(1 / 60, idle, world, 40);
    lowest = Math.min(lowest, cam.z);
  }
  assert.equal(cam.swimming, true, 'should be afloat after landing in the lake');
  assert.ok(lowest > world.bedAt(cam.x, cam.y) + 0.5, `sank to ${lowest.toFixed(2)} before floating`);
});

test('swimming never leaves the camera inside the ground', () => {
  // Swimming is the one movement state where the feet are not on anything, so
  // it is the one most likely to walk the body into a bank or a building.
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const spot = deepestWater(world)!;
  const cam = new Camera();
  cam.placeAt(spot.x, spot.y, 0, world.bedAt(spot.x, spot.y));

  const input = { ...idle, forward: 1 };
  for (let i = 0; i < 1200; i++) {
    input.turn = i % 97 === 0 ? 1 : 0;
    cam.update(1 / 60, input, world, 40);
    world.update(1 / 60, cam.x, cam.y);
    const tile = world.tileAt(Math.floor(cam.x), Math.floor(cam.y));
    assert.ok(tile, 'camera left the window');
    assert.equal(tile!.type, TILE_EMPTY, `camera entered solid geometry at frame ${i}`);
    // The eye is either above the water it is in, or above the ground it is on.
    assert.ok(cam.z >= tile!.bed - 1e-6, `eye at ${cam.z.toFixed(2)} sank below the bed at frame ${i}`);
  }
});

test('a bank too tall to climb still stops a swimmer', () => {
  // Floating raises the feet, which is what lets you climb out onto a shore.
  // It must not let you climb out onto a cliff.
  const world = World.fromTerrain(TERRAIN_THEMES.wilds, 2024);
  const spot = deepestWater(world)!;
  const feet = spot.surface - 0.34; // roughly where a swimmer's feet sit

  let checkedShore = false;
  let checkedCliff = false;
  for (let y = 0; y < world.height && !(checkedShore && checkedCliff); y++) {
    for (let x = 0; x < world.width; x++) {
      const t = world.tiles[y * world.width + x];
      const wx = world.originX + x + 0.5;
      const wy = world.originY + y + 0.5;
      const rise = t.bed - feet;
      if (rise > 1.2 && !checkedCliff) {
        assert.equal(world.canStep(spot.x, spot.y, wx, wy, 0.24, feet), false, 'a cliff must still block');
        checkedCliff = true;
      } else if (rise > -0.2 && rise < 0.2 && !checkedShore) {
        assert.equal(world.canStep(spot.x, spot.y, wx, wy, 0.24, feet), true, 'a shore at the waterline must be climbable');
        checkedShore = true;
      }
    }
  }
  assert.ok(checkedCliff && checkedShore, 'expected both a shore and a cliff to test against');
});
