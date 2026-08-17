# TextWorld

A static website that renders a simple text map as a character-cell 3D world.
No backend, no build-time data: you type a map into a textarea and walk around
inside it. `npm run build` produces a folder you can drop on any static host.

## Goal

Prove that a raycast 3D view drawn entirely in text characters can look
*deliberate* rather than noisy. Three requirements drive nearly every design
decision in here:

1. **Simple maps in.** A map is ASCII art plus an optional legend. A bare
   `{ "grid": ["###", "#.#", "###"] }` is a complete, valid world.
2. **Dynamic.** Doors open, lights flicker, entities move and carry their own
   light, and edits to the map text apply live.
3. **Stable.** The image must come to rest when you stop moving. This is the
   hard constraint and the reason for most of the complexity below.

## Why the image holds still

Text is a brutally low-resolution medium; anything that jitters reads as
static, not detail. Stability is enforced at four separate layers, and all four
matter:

- **Textures are welded to world space.** `materials.ts` snaps texture
  coordinates to a fixed lattice (`TEXELS_PER_TILE`) and evaluates a
  deterministic integer hash. A surface point resolves to the same texel no
  matter where the camera stands, so wall detail never crawls.
- **The dither is screen-space.** `shading.ts` indexes an 8x8 Bayer matrix by
  screen cell. Fixed screen-space dither reads as film grain that sits still; a
  world-space one reads as the wall boiling.
- **Glyphs have hysteresis.** A cell keeps its current glyph until the
  underlying brightness moves past a dead band (`HYSTERESIS`). Without this, a
  cell sitting near a ramp threshold flips between two characters every frame
  on floating-point noise alone. The band holds the *character*, not the ramp
  level, which is what also keeps the material sets' variant glyphs still.
- **No head bob, ever.** `camera.ts` deliberately omits bob and view sway. Both
  are cheap ways to make a renderer feel alive and both are poison here: they
  add continuous sub-cell motion that no amount of hysteresis can settle.

A fifth trick pays this off twice: colours are quantised to 6 bits per channel,
so a cell whose lighting drifted by a rounding error compares *equal* to last
frame, and `display.ts` skips redrawing it entirely.

## Why it looks like light rather than ASCII

The naive approach — map brightness to a glyph on a luminance ramp — throws
away most of the available precision. Instead `CellBuffer.write` treats a cell
as a mix: `density * fg + (1 - density) * bg`. It picks a glyph for coverage
and then *solves for the foreground colour*, so the cell's average colour
matches the light that actually arrived. Six glyphs render smooth gradients —
and because the colour is solved rather than looked up, swapping in a different
set of characters changes what the frame is drawn *with* and not how bright it
is. See "Glyph sets".

Everything upstream feeds that: per-tile baked shadow fields, 3D-distance
attenuation, wrap-around diffuse (pure Lambert goes black at grazing angles,
which at this resolution reads as an artefact), fog, baked corner occlusion,
and a filmic tone map so bright pools do not flatten to white.

One consequence is worth stating on its own, because it decides the dither.
A cell reproduces its colour **exactly** whenever the chosen glyph's coverage
is at least the coverage the colour needs, and reproduces it **too dark** when
it is less — the foreground that would compensate is past white. So the dither
only ever pushes the choice toward a *heavier* glyph. A symmetric dither spends
half its cells clipping, which showed up as a measurable dark bias at every
ramp boundary; dithering upward costs nothing and gives the same texture.

## Glyph sets

`shading.ts` compiles three ramps and the viewer picks between them (`G`, or
the topbar selector). All three go through the same coverage solve, so the
*luminance* of a frame is identical in all three to within a rounding error —
only the characters change.

- **blocks** — ` ·░▒▓█`, the original.
- **ascii** — ` .-:=+*o%#@█`, one character per level and no alternates. Twelve
  levels give a gradient smooth enough that the dither barely has to work.
- **material** — the block ramp's exact coverage levels with a characteristic
  mark mixed into the middle of each: masonry gets courses, panelling gets
  seams, water gets ripples, foliage gets scatter.

Two things make `material` read as texture rather than as text, and the first
version got both wrong:

- **The accent is a minority, by weight.** A variant is chosen uniformly from
  its level's list, so a character is made rare simply by repeating the block
  it accents: `░░░═` puts a course line in one cell of four. Three
  equally-likely alternates per level was the first attempt and the eye tracks
  the characters instead of the light — the opposite of the point.
- **The variant is welded to world space, and held by the hysteresis.** It is
  hashed on a coarse lattice (`glyphSeed`), and — this is the part that matters
  — the dead band holds the *glyph*, not the level, so a cell that is not
  re-picking its brightness does not re-roll its character either. Without that
  every wall shimmers as the world slides under it.

Variants need not match their level's coverage exactly: `write` solves the
colour against the coverage of the glyph it actually chose, so a light variant
simply comes out with a brighter foreground.

## The city

A third generator kind, and the first world that is not expressible as one
surface per tile. The goal is that it feels like a real city: a street grid you
can lose your bearings in, a skyline, traffic that obeys its lights, people on
the sidewalks, and a day that turns to night with the lamps coming on.

### Why the column model has to change

Everything before this had exactly one solid surface per tile, which is what
lets the terrain renderer march a column with a single y-buffer that only ever
moves up the screen. A building you can walk into breaks that outright: the
tile under your feet on the third floor is also the ceiling of the second, and
the renderer has never drawn an underside in its life.

So a city column is a short **list of solid spans** rather than a height:

    street        ground .. ground              (one span, as before)
    exterior wall ground .. roof                (one tall span)
    interior      ground, then a thin slab at
                  each storey, and the roof     (several spans, air between)

Spans are *derived* from a few per-tile fields rather than stored as a list —
storey count, whether the tile is perimeter or interior, where its openings
are — so the tile stays small and the generator stays a pure function.

### Why the y-buffer becomes a coverage mask

With ceilings in play, surfaces no longer converge on the horizon from one
side: floors paint upward toward it and ceilings paint downward, and a slab
seen edge-on from outside splits the remaining view into two gaps rather than
one. A single `yBuf` cannot express that.

The generalisation is per column: a **done mask** over rows plus a count of
rows still unresolved. Marching front to back, each surface fills only the rows
not yet taken; the column finishes early when the count hits zero. The current
y-buffer is exactly the degenerate case of this where the unresolved rows are
always one contiguous run, so the existing behaviour is preserved rather than
replaced.

Per column, each tile can contribute:

- the **top** of each span below the eye (a floor, or the street, or a roof)
- the **underside** of each span above the eye (a ceiling)
- the **vertical face** of a span at the tile boundary (a wall)

### Order of work

1. **Done.** City layout: streets, sidewalks, blocks, lots, a skyline of varied
   storeys. `city.ts`.
2. **Done.** Day and night: `daynight.ts`. One value, `world.timeOfDay`, drives
   the sun's position and colour, ambient, sky, fog, stars and whether the
   lamps are lit. `T` scrubs an hour, shift-`T` back.
3. **Done.** Traffic, crowds and street furniture. Signals are a pure function
   of the junction's coordinates and the clock — no light objects to step, and
   every driver approaching a junction agrees about it without coordinating.
   Cars keep a lane, brake for a red and queue behind the car in front; people
   walk the pavements and turn round at the end of one. Trees line the kerbs at
   intervals and fill the parks, with lamp posts and benches among them.

   The one thing worth remembering: **props are rebuilt on every window move,
   actors are carried across.** Props are a pure function of position, so
   rebuilding them is invisible; rebuilding actors teleports every car back to
   a lattice point every few seconds of walking. The snapshot has to be taken
   *before* the entity list is cleared, which is a mistake that fails silently
   and which `city.test.ts` now checks by object identity.
4. **Done.** Seamless interiors. You can walk in off the street, through
   rooms with walls, doorways and furniture, and up a flight of stairs to the
   floor above.

   The order to do it in, each step leaving the tree working:

   1. **Done.** **`spansAt(wx, wy)` on World** — returns the solid intervals
      of a column. For everything that is not a hollow building this is the
      single span it is today, so the whole engine keeps its current
      behaviour, and a test asserts exactly that. `spansOf` is the same thing
      for a caller that already holds the tile; the terrain march does, and
      the second lookup was worth removing.
   2. **Done.** **Coverage mask in `drawTerrain`, then undersides** — the
      y-buffer became a per-column done mask plus a count of unresolved rows
      (2a), and the march then moved from one height per tile to the span
      list, drawing the underside of every span above the eye (2b). Both are
      no-ops with one span per column, and both were checked that way rather
      than assumed: all 26,600 cells of a five-heading city sweep come back
      identical, and the wilds render to a byte-identical buffer.
   3. **Done.** **Hollow the ground floor** — two thirds of a building's tiles
      became a room with a floor at pavement level and a slab overhead, the
      frontage got openings every `DOOR_EVERY` tiles, and collision started
      answering per storey. You can walk in off the street. 39 of 45 buildings
      in a window are openable; what is left is lots with no street frontage at
      all, which is invisible from outside.
   4. **Done.** **Rooms, doorways and furniture** — the footprint is divided on
      the lot's own lattice, a partition every `ROOM_PITCH` cells, each stretch
      of wall pierced once at a hashed position. 96% of interior floor is still
      reachable from the street. Seven pieces of furniture, sparse, big things
      against a wall.
   5. **Done.** **Stairs** — a run of `STAIR_RUN` treads along one row of the
      lot, one flight per storey, all running the same way. 29 of 39 buildings
      in a window have a full flight; the rest are lots their block clipped too
      short to fit one.

   Collision follows the same span list: which storey you are on is whichever
   span your feet are standing on, and `canStep` compares against the surface
   of the span you would be on, not the column's single height.

Steps 1-2 fit the existing renderer, so the city is walkable and lit before the
largest and riskiest piece starts.

What is left is polish rather than structure: the way in is the full height of
the ground floor, so it reads as a glazed shopfront rather than as a door with
a lintel; a stairwell is an open shaft to the roof and is lit as one big
volume; and the floors above the first have no furniture, since nothing
furnishes by storey yet.

### Three things a building with an inside taught the rest of the engine

- **Walls come from the neighbours, not from the lot rectangle.** A lot is
  `LOT` tiles square, so the outermost ring looks like the obvious wall — and
  it is wrong in the one place it matters. Lots are measured from whichever
  street is *nearer*, so a block is subdivided from both edges and the two
  grids meet in the middle; the leftover lot on each side is whatever width was
  left, its far edge is not a lot boundary, and every tile along that seam
  passes the rectangle test while its neighbour across the seam belongs to a
  different building. `lotIdAt` asks each of the four neighbours for its lot
  key instead, which needs no district or density noise because a lot is
  uniformly built or open.
- **Nothing gets the sun through a floor above it.** The terrain pass added a
  directional term to every top surface and every face, because until interiors
  every surface in a city was outdoors. An interior floor was lit by direct
  sunlight through its own ceiling, and came out 40% brighter than that ceiling
  — a lit floor under a void. A top surface is exposed when it is the highest
  span of its column, an underside never is, and a face is exposed when it
  stands above everything in the column the light would cross to reach it.
- **A room needs a lamp, and darker surfaces than the street.** It has no sun
  in it and the city's ambient is set for open air, so with light surfaces the
  ambient carries the frame and everything lands in one narrow band. Both
  failures — no lamp at all, and a lamp over a surface too light — measure as a
  wash. `spans.test.ts` pins it by rendering a room and refusing a frame whose
  commonest glyph holds over 60% of it.
- **Anything laid out inside a building goes on the *lot's* lattice, never on
  a lattice over the world.** Lamps were placed on a world lattice while a
  footprint was one big room, and partitioning broke it silently: one point per
  thirty-six tiles against a room of sixteen left better than half the rooms
  dark, and which ones depended on where the lot happened to fall. `isRoomLamp`
  answers from the lot's own cell coordinates, so there is exactly one per room
  however the lots land.
- **Every flight of stairs runs the same way, and the run length is
  arithmetic.** A flight climbs a whole STOREY, so a run of N tiles has treads
  STOREY/N apart, and anything past STEP_HEIGHT is a staircase that renders
  perfectly and cannot be walked up. A switchback is the obvious shape and does
  not fit a tile grid: its treads over one tile end up STOREY/N apart *at the
  turn*, which is a step's worth of headroom where you have to walk under one.
  All flights the same way puts consecutive treads a whole storey apart; the
  price is walking back along each floor, which a straight-run stair core makes
  you do anyway.
- **A building stands on one level, taken at the middle of its lot.** Following
  the ground per tile tilts every floor and every roof by however much the land
  moves across the lot. That went unnoticed through the entire skyline and was
  fatal to stairs: the top of a flight missed its landing by 0.43 of the 0.55 a
  leg has.
- **Collision has to look *up* by a step as well as down.** A stair tile in a
  tall building carries a tread per flight, one above another, and picking the
  one you stand on by looking only downward finds the tread of the flight
  below — so stepping off a landing walks you into the stairwell. `surfaceOf`
  takes the highest surface within a step's reach; refusing still works because
  nothing in reach falls through to the lowest surface there is, which is by
  definition further than a step.
- **Furniture has to be far sparser than a plan suggests.** Half the wall tiles
  occupied looks right drawn from above and is unusable in the view: a shelf a
  tile and a half wide at less than a tile's range fills two thirds of the
  screen. About a fifth of tiles, big things against a wall, small things in
  the middle.

The interior lamp is the one place in this engine where the average lies. Tuned
on frame percentiles the lamp wants to be half again brighter than it is, and a
wall standing under one then renders as a featureless white sheet worth 0.4% of
cells — invisible in the numbers, immediate in a screenshot.

Two things about the march are worth knowing before touching it again, because
both were wrong in the first draft of step 2b:

- **A face is a set difference, not a height comparison.** Visible wall is
  where this column is solid and the one before it is not. With one span
  apiece that reduces to the single interval between the two heights, which is
  what the old code computed; with slabs it is several intervals, and the gaps
  are exactly the strips a slab already hides.
- **Surfaces have to be offered to the mask in the order a ray meets them**,
  which is not the order the spans are in. Below the eye a *higher* plane is
  crossed at a shorter distance than a lower one; above the eye it is the
  other way about. So tops run downward from eye level and undersides upward,
  and since tops land below the horizon and undersides above it, the two runs
  never contend for a row.

### Two things step 2 added that the rest of the engine now depends on

- **Lights have a `z`.** They used to sit at a fixed `LIGHT_HEIGHT`, which is
  fine for a torch on a dungeon wall and wrong for a lamp on a post over a
  pavement. `surfaceLight` now takes the vertical term from each light.
- **Lights have a `lampBase`.** A light that answers to the clock stores its
  daylit intensity there, and `advanceClock` scales it by how dark it is. The
  renderer still knows nothing about the time of day.

## Outdoor worlds (heightmap terrain)

Outdoor worlds are the second generator kind. Where the dungeon themes solve
for *characters*, the wilds evaluate **noise per tile**, which is a pure
function of absolute coordinates and a seed. That has a property WFC cannot
offer: walk away and come back and the terrain is bit-identical, because
nothing is remembered — it is recomputed.

### The world is a heightmap

Every tile carries a surface normal baked from its neighbours and **two**
heights: `bed`, the top of the solid ground, and `height`, the top of whatever
you can see — the water surface where there is water and the bed everywhere
else. `depth` is the difference. Keeping the two apart is the whole water
model; see below. Between them they express everything the request asked for:

- **hills and valleys** — smooth noise
- **cliffs** — terraced height in the highland biomes, quantised past what the
  player can step up
- **rivers and lakes** — a quantised water table over a carved bed
- **buildings** — columns tall enough to be unclimbable, with a wall material
  on the side faces and a roof on top
- **roads** — a ridge-noise band that flattens height and swaps the material

Walkability is derived rather than authored: you may step up or down by
`STEP_HEIGHT`, so a gentle slope walks and a cliff does not. Buildings are just
very tall columns, so nothing special is needed to keep you out of them.

### Water: level pools and falls

Water used to be a colour painted on the riverbed, so its surface followed
every contour the bed did and a river visibly ran along the side of a hill.
The surface is now its own field, and the two things it has to do pull against
each other: a lake must be one level however big it is, and a river must step
downhill.

**A water level is a property of a basin, not of a point.** That sentence is
the whole design, and getting it wrong is subtle enough to be worth recording.
The first version quantised the broad land height *at the point itself*, which
is level only in the sense that a staircase is. Measured on a real window, the
widest lake in it came out as concentric rings, 6-5-4-4-5-6 from the middle
outward. Of course it did: the surface was a scaled copy of the bed under it,
so it reproduced the bowl's contour lines.

So `waterTable` quantises from `basinFloor` instead — the lowest broad height
within `BASIN_REACH`. That needs no test for which case it is in:

- **In a bowl**, every point sees the same floor, so the level is one value
  across the whole thing and the lake is flat however large it is.
- **On a slope**, the floor in view drops as you descend, so the level steps
  down with it and a river stays a cascade of pools and falls.

Four details, each of which was wrong first:

- **The search runs on a *global* lattice, not a pattern centred on the query.**
  Every point tests a subset of the same fixed set of nodes, so while the
  lowest node stays in reach the answer is bit-identical from anywhere in the
  basin — no flood fill, no iteration, still a pure function of coordinates.
- **Round the level up, not down.** Rounding down can land it below the basin
  floor it was measured from, so whether a basin held any water at all came
  down to where its floor happened to fall modulo the step. One theme came out
  with no water anywhere near the origin for exactly that reason.
- **`pool` is what merges neighbouring basins.** Two basins whose floors differ
  by less than a step snap to one level, so when they flood over their divide
  the joined body is still level. This is the parameter that actually decides
  large-body flatness: at `pool` 1.0 open water agreed with itself 76% of the
  time, at 1.8 it agreed 99%.
- **Relief is evaluated at the winning node, not at the query.** At the query it
  drifts by a percent across a large lake, which is enough to straddle a
  quantisation boundary and put a hairline step through the middle of one.

Two things carried over and still matter. Rivers are only a *shape* in the
ground — the channel carves the bed, and whether it floods is decided by the
same table test a hollow gets, which is what keeps the surface level where a
channel opens into a lake. And settlements are lifted clear of the table, or
villages generate underwater.

`basinFloor` is memoised per theme *object*, not per theme id: two specs can
share an id and differ in amplitude — the tuning probes do exactly that — and
an id-keyed cache hands one theme's landscape to the other. It caches a pure
function, so clearing it is always safe.

The honest limit: this cannot *merge* basins the way a real flood fill would.
Two basins that brim over into one another share a surface only because `pool`
rounds them together, not because anything computed a spill point. See
"Remaining" for what would fix that properly.

Depth is what makes water read as water rather than as blue paint, and the
heightmap knows it exactly — but a material per tile would be an allocation per
tile per window rebuild, so it is quantised into `WATER_BANDS` shades per
biome, shore to deep. At this resolution the banding reads as depth contours.
A lake is also flat, so the diffuse sun paints every cell of it identically;
the **sun glint** in the terrain pass is what says "surface". It is the one
view-dependent thing in this renderer, and on water that is the correct answer.

### Getting around, and not getting stuck

Movement outdoors is decided entirely by the heightmap: `canStep` refuses a
move when the destination **bed** is more than `STEP_HEIGHT` above your
feet. Four details matter, and the first two were bugs:

- **Only upward steps are refused.** Blocking large drops as well seemed
  symmetrical and was wrong — it let you walk down into a hollow you could
  then never leave. A drop is a fall, not an obstacle.
- **The comparison is against the feet, not the ground you came from.** That
  one parameter is what makes jumping work: while airborne you clear whatever
  you are above, but walking into a cliff face still stops you.
- **Buildings need no special case.** Their walls are columns too tall to
  climb, so the same rule keeps you out — and lets you fly over the roof.
- **Swimming needs no special case either**, for the same reason the rule tests
  the bed. Afloat, your feet sit near the water surface, so a deep bed is far
  below them and poses no step at all — while a cliff rising out of the lake
  still stops you exactly as it does on dry land.

Wading and swimming are decided by depth alone. Past `SWIM_DEPTH` the eye rides
the surface, and buoyancy *replaces* gravity rather than fighting it: a spring
settling toward the waterline would bob, and bob is the one thing this renderer
cannot have. Being *over* deep water is not being *in* it — the eye has to have
reached the surface, or you float in mid-air the moment you jump off a cliff
above a lake.

Even so, terrain can produce a hollow no jump can leave, and tuning the
generator until that is impossible would cost more than it is worth. Flight
(`F`) is the escape hatch, and doubles as the best way to look at a landscape.
Jump height is deliberately set between the two terrace sizes: it clears a
temperate 0.95-tile ledge and not a badlands 1.35-tile one, so cliffs still
mean something.

Indoors the eye is clamped between floor and ceiling. The flat-floor passes
project both planes *from the eye height*, so outside that band the geometry
folds through itself.

### Rendering non-level ground

The indoor path assumes a flat floor at z=0, a ceiling at z=1 and an eye at
z=0.5, and casts floors *by screen row* because every cell in a row is the same
distance away. None of that survives variable height, so terrain uses a
separate path: a per-column march with a **y-buffer**, the classic voxel-
landscape algorithm.

Marching front to back, each cell contributes at most two things: a vertical
**face** where the ground steps up from the previous cell, and its **top
surface** spanning the distances the ray is inside it. Both are clipped to the
rows not yet painted, and the buffer only ever moves up the screen. Occlusion
falls out for free — standing on a plateau, the valley immediately below the
edge is correctly hidden until it clears your line of sight — and the sky is
whatever rows are left over.

Two rules are easy to get wrong:

- A cell's top surface is only visible when its height is **below the eye**. At
  or above eye level you see the face and nothing else; drawing a top there
  renders the underside of a solid.
- Texture and lighting must be sampled **per row**, inverting the projection to
  get the distance for that row. One sample per span looks fine on flat ground
  and smears badly on a slope.

Terrain also needs a **sun**: point lights alone leave hills unreadable,
because every top surface is horizontal and shades identically. The sun is a
directional term using each tile's baked normal, which is what makes the
landform legible. Two things about it are not obvious:

- **It has to sit low.** A heightmap's surfaces are nearly all horizontal, so a
  high sun gives every one of them nearly the same `n·L` and the landform
  vanishes into a flat wash. Measured: at 50 degrees of elevation a 15-degree
  slope was 1.6x brighter than one tilted away from the sun; at 22 degrees it
  is over 6x. Long light is what makes a landscape read.
- **The terminator has to be wrapped, by shifting and not by flooring.** Pure
  Lambert against a low sun draws a knife edge across every hill, and at
  character resolution that reads as a tear in the image. `sunLight` shifts the
  zero crossing (`(dot + w) / (1 + w)`) so the terminator spreads over several
  tiles of slope. A *floor* (`w + (1-w)·max(0, dot)`) was tried first and is
  worse: it lifts every back-facing surface equally, so shadow becomes a flat
  grey wash and the frame loses the range the low sun was there to create —
  glyph entropy over the outdoor maps fell from 2.0 to 1.4 on that alone.

## Infinite worlds (Wave Function Collapse)

A map source may replace `grid` with a `generate` block, which streams an
endless world instead of loading a fixed one:

    { "name": "Endless Catacombs", "generate": { "theme": "catacombs", "seed": 7 } }

The design in one line: **WFC generates characters, not tiles.** The model
learns from a small block of ASCII art — the same thing an author would type
into the editor — and emits more text in that style, which then goes through
the ordinary legend/material pipeline. Whatever `#` means in a hand-written
map, it means the same in a generated one, and themes are authored as sample
art rather than as code.

Themes live in `src/engine/themes.ts`; the solver is `src/engine/wfc.ts`.
A new world type is a block of sample art plus a material palette.

### Four things that make it work (each was a bug first)

These are not incidental — the generator produced garbage without every one:

1. **Never feed edited terrain back to the solver.** `chars` holds pristine WFC
   output and is never modified; carved passages live in a separate `carved`
   overlay that only tile-building consults. Carving into `chars` manufactures
   local arrangements that appear nowhere in the sample, and pinning those as
   constraints is unsatisfiable *by construction* — it turned 100% of streamed
   solves into failures while the initial world looked perfect.
2. **Relax constraints progressively.** A failed solve emits characters that
   are not a valid pattern combination, which poisons every solve downstream
   and decays the world into fallback. `solveRect` retries with less and less
   agreement demanded, ending at none — which always succeeds. Failure rate
   went 97% → 0%.
3. **Commit only the target rectangle.** Solves are padded with context, but
   writing that padding back leaves the ungenerated area ragged, and a region
   hemmed in on three or four sides is far harder to satisfy than one being
   extended along an edge.
4. **Tunnel, don't seal.** WFC has no notion of connectivity. Deleting stranded
   rooms is the easy fix and throws away most of what the generator drew;
   `connectRegions` instead BFSes out of each pocket and opens the shortest
   path to reachable ground. Seed that flood **from the player only** — seeding
   from the window border too silently declares regions "fine" that the player
   cannot actually walk to.

`world.gen` counts solves, failures, relaxations and tunnels, and the telemetry
pane shows them. **A non-zero failure count means a theme's sample is
over-constrained** and its terrain is drifting toward the fallback.

### Drawing a sample that solves

Sample art is the whole game, and success rate is not guesswork — measure it.
Free 24x24 solves, n=3: the first catacombs maze managed 50%, the first station
sample 0%. Redrawn with wider halls and repeated motifs, both reach 100%.

- **n=3, not n=2.** n=2 solves every time and produces noise; n=3 produces
  actual corridors and rooms. Fix the art, don't lower n.
- Rigid 1-wide labyrinths are the worst case — over-constrained *and*
  claustrophobic to walk. Wide halls and repeated bays work.
- Contradiction rate climbs steeply with region area, hence `SOLVE_BLOCK`.

Streaming is a **sliding window**, not true unbounded storage:

- The world keeps a fixed `WINDOW`-square window of tiles plus the character
  grid it came from, and an `originX/originY` in absolute world coordinates.
  Finite maps are the same code with origin `(0, 0)`, so nothing regressed.
- When the player drifts more than `SHIFT_THRESHOLD` tiles from the window
  centre, the window recenters: the overlap is copied, and only the newly
  exposed strip is solved, with the retained characters supplied as fixed
  constraints so the seam is coherent.
- Solving happens in bounded rectangles, never over the whole window, which
  keeps both time and the propagator's memory per solve small.
- Lights and props are placed from the generated characters and culled when
  they leave the window.

Consequence worth knowing: memory is bounded, so walking far away and coming
back regenerates that area differently. Terrain is only stable within roughly
one window.

The solver must never throw or hang — the frame loop calls it. On repeated
contradiction it returns its best partial assignment. When reading that out,
pick each cell's *likeliest* remaining pattern, not its first: pattern 0 is
whatever sat in the sample's top-left corner, so "first" biases a whole failed
region into a slab of it.

Generated worlds also give the player a dim **lantern** (light 0, moved by
`moveLantern`). A fixed map is authored so everywhere worth standing is lit; an
endless one cannot promise that, and walking into an unlit stretch means seeing
nothing at all.

Not yet done for generated worlds: **doors**. The themes' legends define none,
because door state would have to survive the tile rebuild on every window
shift, and getting that wrong is worse than not having them.

## Lighting a map (hard-won, non-obvious)

Tuning a map's look is not intuitive, and the failure modes look like renderer
bugs when they are not. In rough order of leverage:

- **`exposure` and `contrast` are the two master knobs and they pull against
  each other.** Exposure slides the whole distribution; contrast widens it
  about a pivot of 0.45. Tone mapping alone is aggressively compressive — every
  built-in map once spent 98% of its cells on three adjacent glyphs and never
  reached ` ` or `█` anywhere in the frame, which is mid-grey mush by
  construction. Exposure cannot fix that on its own, it just slides the mush.
  Interiors now want roughly 1.2–3.6 exposure with 1.85–2.0 contrast; outdoors,
  1.0–1.9 with about 1.9.
- **Exposure is easy to overshoot.** Averaged over a whole frame the numbers
  keep improving as you raise it; then you stand next to a torch and the near
  wall is a flat white sheet. Tune with the near view, not the average.
- **`ambient` is a much weaker lever than it looks.** Sweeping it 0.26 → 0.06
  barely moves the glyph distribution once lights are present, because the
  lights dominate. Its real job is setting how black the unlit corners go.
  Raising it to brighten a scene just flattens contrast — reach for `exposure`
  or light `intensity` instead.
- **Light `radius` is what creates contrast.** A radius that covers the whole
  room produces a flat, evenly-lit wash. Keep radii meaningfully smaller than
  the room so the falloff is visible as a pool. This was the single biggest
  improvement to how "3D" the image reads.
- **Fog is the quiet killer of colour outdoors.** It blends toward one flat
  colour, so at any real density most of the frame converges on it and the
  distance goes grey. Outdoor densities want to be around 0.006, not 0.012.
- **Palettes need saturation to survive.** A warm sun over a desaturated ground
  colour lands on neutral grey, and neutral grey is what "no contrast" looks
  like in hue as well as in value.
- **Pattern deviation has to cross a ramp step or it does not exist.** The
  procedural patterns used to sit around ±15%, which sounds ample; after
  roughness scales it and the tone curve compresses it, a whole wall of it
  stayed inside one glyph and rendered flat.
- **Aim for surfaces landing mid-ramp (`░`–`▓`).** At `·` (9% coverage) the
  foreground colour gets boosted ~10x to preserve the cell average, so a dim
  cell renders as a bright dot on black — a frame dominated by `·` reads as
  scattered noise rather than as a surface.

`npm run typecheck` will not catch any of this. Render a frame and look at it.

Two measurements are worth taking rather than eyeballing, and both are cheap
under plain Node: the **glyph histogram** (what share the single commonest
character holds — over about half and the frame is flat) and the **luminance
p10/p50/p90** of the cells. Shannon entropy over the histogram is a useful
single number, but do not optimise it blindly: it peaks on a uniform spread,
which for a dungeon means evenly-lit mid-grey.

## Layout

    index.html          shell: viewport canvas, minimap, telemetry, map editor
    src/main.ts         wiring: DOM controls, frame loop, live map rebuilds
    src/maps.ts         built-in preset maps, stored as source text
    src/style.css
    src/engine/
      types.ts          shared value types; tile/material/light/entity shapes
      mapFormat.ts      parse + validate authored JSON -> MapSource
      world.ts          MapSource -> World; doors, entities, AO bake, spawn
      materials.ts      colour parsing, procedural patterns, stable hash
      raycast.ts        DDA grid march; thin-panel door intersection
      lighting.ts       per-tile shadow bake, attenuation, flicker, fog
      shading.ts        CellBuffer: light -> (glyph, fg, bg); glyph sets; contrast
      renderer.ts       four passes: columns, floor/ceiling, walls, sprites
      camera.ts         movement with per-axis wall sliding; wading and swimming
      sprites.ts        density-art billboards
    src/ui/
      display.ts        canvas text grid: dirty-cell diffing + glyph atlas
      input.ts          keyboard by event.code + pointer-lock mouse
      minimap.ts        top-down view, light pools, ray fan, view cone

Data flow per frame:

    Input.sample -> Camera.update -> World.update
                 -> Renderer.render (writes CellBuffer)
                 -> Display.draw    (diffs CellBuffer, blits changed cells)
                 -> Minimap.draw

## Conventions

- ESM with explicit `.ts` extensions on imports (`allowImportingTsExtensions`).
- `verbatimModuleSyntax` is on: type-only imports must say `import type`.
- Strict TypeScript. No dependencies beyond Vite and TypeScript, deliberately.
- Hot paths allocate nothing per cell: results are written into reused
  accumulators (`LightAccum`, `RayHit`) rather than returned as new objects.
- Comments explain *why*, especially where a simpler approach was rejected for
  a stability reason. Keep that voice.

## Commands

    npm install
    npm run dev        # vite dev server, opens a browser
    npm run typecheck  # tsc --noEmit
    npm run build      # typecheck + production build to dist/

## Tests

`npm test` runs 95 tests via `node --test` — no framework, no browser, because
the engine is DOM-free. `npm run build` runs them between the typecheck and the
bundle.

They deliberately cover the things that **fail silently**, which is most of
what went wrong while building this. A world with no rivers, terrain quietly
compressed to a tenth of its amplitude, a solver falling back on every call, a
sealed-off room, a spawn inside rock — all of these produce a perfectly valid
world that merely looks wrong, and none of them fail a typecheck. Notable:

- `terrain.test.ts` asserts a tile depends only on its coordinates, which is
  the property the endless outdoor world rests on. It also pins the water
  behaviour directly: every water surface sits on the pool lattice, neighbours
  differ by zero or a whole step and never by a small slope, and over 90% of
  neighbouring water is level — which is what separates a lake from a staircase
  that satisfies the first two.
- `world.test.ts` walks a world away and back and asserts the land came back
  identical, and drives the real `Camera` for 600 frames asserting it never
  ends up inside geometry. Swimming gets the same treatment: 1200 frames afloat
  without entering the ground, plus a check that a shore at the waterline is
  climbable and a cliff out of the same lake is not.
- `shading.test.ts` checks a cell reconstructs the colour it was given **in
  every glyph mode**, that an unchanged scene produces a byte-identical buffer,
  and that a material ramp mixes its accent in as a minority — too much and the
  surface reads as text, none at all and the variant lookup has silently
  stopped working.

When tuning a theme's sample art or a noise threshold, run the tests: the
"every biome occurs" and "every theme solves cleanly" cases are what catch a
threshold that has drifted out of range.

## Status

Complete and working end to end. The app builds, runs, and renders.

Verified:

- `npm run build` clean (83 KB JS / 3.6 KB CSS, ~30 KB gzipped, no deps).
- All six presets build headlessly and pass structural checks: no ragged grid
  rows, door axes correct, spawns legal, no light or entity buried in a wall,
  and no open tile unreachable from the spawn.
- Generated dungeons: 0 WFC fallbacks on all three themes; 100% of open tiles
  reachable after 30,000 frames of collision-driven walking; window shifts cost
  ~75-80 ms and happen roughly once a minute of walking; render stays ~1-2 ms
  with 25-48 lights. All three verified by eye in a browser.
- Outdoor worlds: both themes verified by eye; terrain spans ~13 tiles of
  elevation with ~6% of neighbouring steps too tall to climb; rivers, roads,
  buildings and all four biomes occur; the land is bit-identical after walking
  away and back. Streaming an outdoor window is a full regenerate and costs far
  less than a WFC solve, since noise is evaluated per tile rather than solved.
- Water covers ~9-11% of both themes, roughly three quarters of it deep enough
  to swim. Pools average 6-8 tiles across a scanline and reach 45-60; every
  water surface sits on the pool lattice and over 90% of neighbouring water is
  exactly level, so what is not level is a fall rather than a slope.
- Rendered in headless Chrome; viewport, minimap, telemetry and live editor all
  work. Interior, outdoor and water scenes confirmed by eye in all three glyph
  modes.
- **Contrast measured**, since "the world needs more contrast" was the
  complaint that started this. Per preset, over five headings from spawn:
  the share of the frame held by its single commonest character, and the
  luminance p10/p90 of its cells.

  | preset | commonest glyph | p10 → p90 |
  |---|---|---|
  | vault (before) | 74% | 0.086 → 0.283 |
  | vault (after) | 52% | 0.032 → 0.487 |
  | catacombs (before) | 70% | 0.076 → 0.259 |
  | catacombs (after) | 46% | 0.039 → 0.523 |
  | wilds (before) | 59% | 0.147 → 0.511 |
  | wilds (after) | 41% | 0.030 → 0.583 |

  Roughly double the tonal range, spread over four or five glyphs instead of
  three. It took `contrast` *and* a low sun *and* wider pattern deviation *and*
  less fog; no one of them was enough on its own.
- **Stability measured**, since that was the hardest requirement. Per frame, on
  a 151x39 grid, in the Vault:

  | scenario | cells repainted | glyph changes |
  |---|---|---|
  | still camera, no flicker | 0.2% | 0.00% |
  | still, torches flickering | 48% | 0.07% |
  | turning 20 deg/s | 54% | 4.3% |
  | walking 2.6 tiles/s | 59% | 4.3% |

  The image still comes to rest: at a standstill nothing moves and flicker
  changes essentially no characters at all, so it reads as light rather than as
  churn. That gap between "cells repainted" and "glyphs changed" is the whole
  design working.

  Under motion glyph churn is up from the ~1.8% this held before, and that is a
  real cost of the contrast work rather than a bug: a steeper tone curve moves
  `need` further for the same change in light, so the same dead band holds a
  glyph across less of the world. Widening `HYSTERESIS` from 0.035 to 0.06
  recovers part of it. `ascii` runs about 7% and `material` about 5.7%, for the
  obvious reasons — twice as many levels to cross in one, a second thing that
  can change in the other.

Verification harnesses (headless map validator, render probe that prints a
frame as text, exposure/contrast sweep, water plan-view probe, stability probe)
were written to the session scratchpad, not the repo. Recreate as needed; the
engine is DOM-free, so it renders under plain Node with no browser involved.
That is by far the fastest way to inspect a render change — but it prints
characters, not colour, so finish in a browser. Several of the tuning problems
above (fog draining the palette, a blown-out near wall) were invisible in the
text dump and obvious in a screenshot.

Remaining / not done:

- No CI.
- **Interiors are ground-floor-furnished only.** The storeys above the first
  are hollow, lit and walkable, and nothing furnishes or lights them per floor
  — `furnish` and `lightInteriors` both key off `t.bed`, which is the ground.
- **The way into a building is the full height of its ground floor**, so it
  reads as a glazed shopfront rather than as a door with a lintel over it. A
  real opening wants a span above the head, which means a second stair-like
  field on the tile.
- **A stairwell is an open shaft to the roof**, so it is lit as one tall volume
  by the lamps that happen to fall on the run.
- **Water basins cannot merge.** Two that brim over into one another share a
  level only because `pool` rounds them together, not because anything computed
  a spill point. The proper fix is a depression-filling pass — priority flood
  over blocks on a *fixed global* lattice (never the streaming window, or a lake
  changes level as you walk toward it), each block simulated with a wide apron
  that is then discarded, cached by block coordinate. The quantisation already
  here would double as its seam tolerance: two blocks computing 4.03 and 4.07
  both land on 4.0. That is also the door to what noise fundamentally cannot
  fake — **flow accumulation**, so rivers widen downstream instead of being one
  width everywhere, and hydraulic erosion, so valleys look eroded rather than
  merely bumpy. It is a project rather than a patch: it trades "recompute
  anything instantly" for "simulate and cache", wants a worker rather than the
  frame loop, and lives or dies on the seam handling.
- Not run on a non-Chromium browser, or on a real touch device.
- The `material` glyph set is chosen by a material's `pattern`, so an author
  cannot pick a ramp independently of the texture. That has been fine so far
  because the two want to agree, but they need not.
- Water has no flow direction, so a fall reads as a drop rather than as a
  current, and rapids are a material rather than a shape.
- Ideas deliberately left out: sprite sheets, per-tile distinct ceiling
  textures, saving a map to the URL hash (would also make preset screenshots
  scriptable).
