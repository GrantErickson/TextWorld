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

Verified this session:

- `npm run build` clean (42 KB JS / 3.6 KB CSS gzipped to ~17 KB, no deps).
- All three preset maps build headlessly and pass structural checks: no ragged
  grid rows, door axes correct, spawns legal, no light or entity buried in a
  wall, and no open tile unreachable from the spawn.
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
