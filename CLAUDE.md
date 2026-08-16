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
  on floating-point noise alone.
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
matches the light that actually arrived. Six glyphs render smooth gradients.

Everything upstream feeds that: per-tile baked shadow fields, 3D-distance
attenuation, wrap-around diffuse (pure Lambert goes black at grazing angles,
which at this resolution reads as an artefact), fog, baked corner occlusion,
and a filmic tone map so bright pools do not flatten to white.

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

- **`exposure` is the master knob, and it wants to be well above 1.** The tone
  curve is `x / (1 + x)`. At exposure 1 a white surface under a full-strength
  light reaches only 0.5, which selects the *third* of six ramp glyphs — the
  top of the ramp is unreachable by construction and everything reads as dim
  noise. Interiors want roughly 2.5–3, the outdoor map wants ~1.9.
- **`ambient` is a much weaker lever than it looks.** Sweeping it 0.26 → 0.06
  barely moves the glyph distribution once lights are present, because the
  lights dominate. Its real job is setting how black the unlit corners go.
  Raising it to brighten a scene just flattens contrast — reach for `exposure`
  or light `intensity` instead.
- **Light `radius` is what creates contrast.** A radius that covers the whole
  room produces a flat, evenly-lit wash. Keep radii meaningfully smaller than
  the room so the falloff is visible as a pool. This was the single biggest
  improvement to how "3D" the image reads.
- **Aim for surfaces landing mid-ramp (`░`–`▓`).** At `·` (9% coverage) the
  foreground colour gets boosted ~10x to preserve the cell average, so a dim
  cell renders as a bright dot on black — a frame dominated by `·` reads as
  scattered noise rather than as a surface.

`npm run typecheck` will not catch any of this. Render a frame and look at it.

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
      shading.ts        CellBuffer: light -> (glyph, fg, bg); the core trick
      renderer.ts       four passes: columns, floor/ceiling, walls, sprites
      camera.ts         movement with per-axis wall sliding
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

## Status

Complete and working end to end. The app builds, runs, and renders.

Verified:

- `npm run build` clean (60 KB JS / 3.6 KB CSS, ~22 KB gzipped, no deps).
- All six presets build headlessly and pass structural checks: no ragged grid
  rows, door axes correct, spawns legal, no light or entity buried in a wall,
  and no open tile unreachable from the spawn.
- Generated worlds: 0 WFC fallbacks on all three themes; 100% of open tiles
  reachable after 30,000 frames of collision-driven walking; window shifts cost
  ~75-80 ms and happen roughly once a minute of walking; render stays ~1-2 ms
  with 25-48 lights. All three verified by eye in a browser.
- Rendered in headless Chrome; viewport, minimap, telemetry and live editor all
  work. Interior and outdoor (sky + stars) scenes both confirmed by eye.
- **Stability measured**, since that was the hardest requirement. Per frame, on
  a 151x39 grid:

  | scenario | cells repainted | glyph changes |
  |---|---|---|
  | still camera, no flicker | 0.0% | 0.0% |
  | still, entities moving | 0.5% | 0.0% |
  | still, torches flickering | 32% | 0.0% |
  | turning 20 deg/s | 44% | 1.9% |
  | walking 2.6 tiles/s | 64% | 1.7% |

  The image is bit-identical at rest. Under motion the *characters* hold still
  — under 2% change — and only their colours move. Flicker repaints a third of
  the screen but changes no glyphs at all, so it reads as light rather than as
  churn. That gap between "cells repainted" and "glyphs changed" is the whole
  design working.

Verification harnesses (headless map validator, render probe that prints a
frame as text, stability probe) were written to the session scratchpad, not the
repo. Recreate as needed; the engine is DOM-free, so it renders under plain
Node with no browser involved. That is by far the fastest way to inspect a
render change.

Remaining / not done:

- No automated tests in the repo, and no CI.
- Not run on a non-Chromium browser, or on a real touch device.
- Ideas deliberately left out: sprite sheets, per-tile distinct ceiling
  textures, mouse-look invert, saving a map to the URL hash (would also make
  preset screenshots scriptable).
