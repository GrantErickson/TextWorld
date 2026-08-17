/**
 * Application wiring: DOM controls, the frame loop, and live map editing.
 *
 * Everything interesting happens in `src/engine`. This file's only jobs are to
 * keep the character grid sized to its container, feed input to the camera,
 * and rebuild the world when the map text changes.
 */

import './style.css';

import { Camera } from './engine/camera.ts';
import { MapError, parseMapSource } from './engine/mapFormat.ts';
import { Renderer } from './engine/renderer.ts';
import type { GlyphMode } from './engine/shading.ts';
import { GLYPH_MODES, setGlyphMode } from './engine/shading.ts';
import { World } from './engine/world.ts';
import { Display } from './ui/display.ts';
import { Input } from './ui/input.ts';
import { Minimap } from './ui/minimap.ts';
import { PRESETS, presetById } from './maps.ts';
import { clockString } from './engine/daynight.ts';

const STORAGE_SOURCE = 'textworld.source';
const STORAGE_PRESET = 'textworld.preset';
// Suffixed: the first version of these keys was written on *every* load, which
// meant a stored value shadowed the shipped default from a visitor's first
// visit onward and changing the default could never reach anyone. Renaming
// them retires those auto-written values once.
const STORAGE_GLYPHS = 'textworld.glyphs.v2';
const STORAGE_CONTRAST = 'textworld.contrast.v2';

/**
 * What the site looks like before anyone touches a control. A saved preference
 * still wins over these — but only one the viewer actually chose.
 */
const DEFAULT_GLYPHS: GlyphMode = 'ascii';
const DEFAULT_CONTRAST = 1.15;
const DEFAULT_CELL_SIZE = 14;

/** Debounce on the editor: long enough to finish a word, short enough to feel live. */
const EDIT_DELAY = 400;

const MINIMAP_HZ = 30;
const STATS_HZ = 5;

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in the page.`);
  return el as T;
}

const screenCanvas = must<HTMLCanvasElement>('screen');
const minimapCanvas = must<HTMLCanvasElement>('minimap');
const viewEl = must<HTMLElement>('view');
const clickToPlay = must<HTMLElement>('clickToPlay');
const srcEl = must<HTMLTextAreaElement>('src');
const errEl = must<HTMLElement>('err');
const statsEl = must<HTMLElement>('stats');
const presetSel = must<HTMLSelectElement>('presetSel');
const revertBtn = must<HTMLButtonElement>('revertBtn');
const fontSizeEl = must<HTMLInputElement>('fontSize');
const fontSizeOut = must<HTMLOutputElement>('fontSizeOut');
const glyphModeEl = must<HTMLSelectElement>('glyphMode');
const contrastEl = must<HTMLInputElement>('contrast');
const contrastOut = must<HTMLOutputElement>('contrastOut');
const showRaysEl = must<HTMLInputElement>('showRays');
const invertYEl = must<HTMLInputElement>('invertY');
const pauseBtn = must<HTMLButtonElement>('pauseBtn');

const display = new Display(screenCanvas);
const minimap = new Minimap(minimapCanvas);
const renderer = new Renderer();
const camera = new Camera();
const input = new Input();

/**
 * Telemetry rows are created once and then updated in place. Rebuilding the
 * panel's markup every frame would be a reflow for text nobody is reading that
 * fast, and it would fight the renderer for the same milliseconds.
 */
class StatsPanel {
  private rows = new Map<string, HTMLElement>();

  constructor(private readonly root: HTMLElement) {}

  set(key: string, value: string, tone: '' | 'good' | 'bad' = ''): void {
    let v = this.rows.get(key);
    if (!v) {
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = key;
      v = document.createElement('span');
      v.className = 'v';
      this.root.append(k, v);
      this.rows.set(key, v);
    }
    if (v.textContent !== value) v.textContent = value;
    const cls = tone ? `v ${tone}` : 'v';
    if (v.className !== cls) v.className = cls;
  }
}

const stats = new StatsPanel(statsEl);

// Assigned during startup below, before the first frame runs.
let world!: World;
let haveWorld = false;
let paused = false;
let showRays = false;
let needsRedraw = true;
let editTimer = 0;

// --------------------------------------------------------------- world build

/**
 * Parse `text` and swap in the resulting world.
 *
 * On failure the previous world keeps running: an author mid-edit should not
 * lose the view they are working against just because the JSON is briefly
 * unbalanced. Returns true when the world was replaced.
 */
function applySource(text: string, keepView: boolean): boolean {
  let next: World;
  try {
    next = World.fromSource(parseMapSource(text));
  } catch (e) {
    const msg = e instanceof MapError || e instanceof Error ? e.message : String(e);
    errEl.textContent = msg;
    errEl.classList.remove('ok');
    return false;
  }

  // Hold position across an edit when it is still meaningful — tuning lights or
  // materials should not teleport you back to the spawn every keystroke.
  const sameShape =
    keepView && haveWorld && world.width === next.width && world.height === next.height;
  if (sameShape && next.canOccupy(camera.x, camera.y, 0.24)) {
    camera.placeAt(camera.x, camera.y, camera.angle, next.groundAt(camera.x, camera.y), next.eyeHeight);
  } else {
    camera.placeAt(
      next.spawnX,
      next.spawnY,
      next.spawnAngle,
      next.groundAt(next.spawnX, next.spawnY),
      next.eyeHeight,
    );
  }

  world = next;
  haveWorld = true;
  needsRedraw = true;

  errEl.textContent = `${next.name} · ${next.width}x${next.height} · ${next.lights.length} lights · ${next.entities.length} entities · ${next.doors.length} doors`;
  errEl.classList.add('ok');
  return true;
}

function loadPreset(id: string, remember = true): void {
  const preset = presetById(id);
  presetSel.value = preset.id;
  srcEl.value = preset.source;
  applySource(preset.source, false);
  if (remember) {
    try {
      localStorage.setItem(STORAGE_PRESET, preset.id);
      localStorage.setItem(STORAGE_SOURCE, preset.source);
    } catch {
      // Private browsing or a full quota: persistence is a convenience only.
    }
  }
}

function scheduleRebuild(): void {
  window.clearTimeout(editTimer);
  editTimer = window.setTimeout(() => {
    if (applySource(srcEl.value, true)) {
      try {
        localStorage.setItem(STORAGE_SOURCE, srcEl.value);
      } catch {
        // See above.
      }
    }
  }, EDIT_DELAY);
}

// ------------------------------------------------------------------- startup

for (const p of PRESETS) {
  const opt = document.createElement('option');
  opt.value = p.id;
  opt.textContent = p.label;
  presetSel.append(opt);
}

// Restore the last edited map if it still parses; otherwise fall back to the
// preset, so a saved-but-broken map can never wedge the app on load.
{
  let restoredId = PRESETS[0].id;
  let restoredSource: string | null = null;
  try {
    restoredId = localStorage.getItem(STORAGE_PRESET) ?? restoredId;
    restoredSource = localStorage.getItem(STORAGE_SOURCE);
  } catch {
    // No storage available; start from the default preset.
  }

  // A stored map that is byte-identical to a shipped preset was never edited,
  // it was just the last one opened — so it should not outrank a change to
  // which world the site opens with. A map that *was* edited is kept.
  if (restoredSource && PRESETS.some((p) => p.source === restoredSource)) {
    restoredSource = null;
    restoredId = PRESETS[0].id;
  }

  presetSel.value = presetById(restoredId).id;
  if (restoredSource) {
    srcEl.value = restoredSource;
    if (!applySource(restoredSource, false)) loadPreset(presetSel.value, false);
  } else {
    loadPreset(presetSel.value, false);
  }
}

// Restore the viewer's own display preferences. These sit on top of whatever
// the map asks for rather than replacing it: `contrast` here is a trim applied
// over the map's own value, so a well-tuned map still looks like itself.
{
  let mode: GlyphMode = DEFAULT_GLYPHS;
  let trim = DEFAULT_CONTRAST;
  try {
    const saved = localStorage.getItem(STORAGE_GLYPHS) as GlyphMode | null;
    if (saved && GLYPH_MODES.includes(saved)) mode = saved;
    const savedTrim = Number(localStorage.getItem(STORAGE_CONTRAST));
    if (Number.isFinite(savedTrim) && savedTrim > 0) trim = savedTrim;
  } catch {
    // No storage available; the defaults are fine.
  }
  // Restoring is not choosing: writing here would persist the default on the
  // first load and the default could never be changed for anyone again.
  setGlyphs(mode, false);
  setContrastTrim(trim, false);
}

setFontSize(DEFAULT_CELL_SIZE);

// -------------------------------------------------------------------- events

presetSel.addEventListener('change', () => loadPreset(presetSel.value));

revertBtn.addEventListener('click', () => {
  loadPreset(presetSel.value);
  srcEl.focus();
});

srcEl.addEventListener('input', scheduleRebuild);

fontSizeEl.addEventListener('input', () => {
  fontSizeOut.value = fontSizeEl.value;
  setFontSize(Number(fontSizeEl.value));
});

glyphModeEl.addEventListener('change', () => setGlyphs(glyphModeEl.value as GlyphMode));

contrastEl.addEventListener('input', () => setContrastTrim(Number(contrastEl.value)));

showRaysEl.addEventListener('change', () => {
  showRays = showRaysEl.checked;
});

invertYEl.addEventListener('change', () => {
  input.invertY = invertYEl.checked;
});

pauseBtn.addEventListener('click', () => setPaused(!paused));

input.attach(screenCanvas);
input.onLockChange = (locked) => clickToPlay.classList.toggle('hidden', locked);

// The character grid is derived from the element's pixel box, so any resize —
// window, devtools, zoom — has to re-measure the font and reallocate buffers.
new ResizeObserver(() => relayout()).observe(viewEl);
window.addEventListener('resize', () => relayout());

function relayout(): void {
  display.layout();
  renderer.resize(display.cols, display.rows);
  camera.teleported = true; // drop glyph history: the grid moved under it
  needsRedraw = true;
}

function setFontSize(px: number): void {
  const clamped = Math.max(8, Math.min(26, Math.round(px)));
  display.setFontSize(clamped);
  fontSizeEl.value = String(clamped);
  fontSizeOut.value = String(clamped);
  relayout();
}

/**
 * Swap the glyph ramp. The cell buffer's hysteresis remembers a *glyph*, not a
 * brightness, so without dropping that history every cell inside its dead band
 * would keep drawing the old ramp's character until the light happened to move.
 */
function setGlyphs(mode: GlyphMode, persist = true): void {
  setGlyphMode(mode);
  glyphModeEl.value = mode;
  camera.teleported = true;
  display.invalidate();
  needsRedraw = true;
  if (!persist) return;
  try {
    localStorage.setItem(STORAGE_GLYPHS, mode);
  } catch {
    // Persistence is a convenience only.
  }
}

function setContrastTrim(value: number, persist = true): void {
  const clamped = Math.max(0.6, Math.min(1.6, value));
  renderer.contrastTrim = clamped;
  contrastEl.value = String(clamped);
  contrastOut.value = clamped.toFixed(2);
  needsRedraw = true;
  if (!persist) return;
  try {
    localStorage.setItem(STORAGE_CONTRAST, String(clamped));
  } catch {
    // See above.
  }
}

function setPaused(next: boolean): void {
  paused = next;
  pauseBtn.textContent = paused ? 'resume' : 'pause';
  needsRedraw = true;
}

// ----------------------------------------------------------------- main loop

let lastTime = performance.now();
let fps = 60;
let minimapAcc = 0;
let statsAcc = 0;
let changedCells = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);

  // Clamped so a backgrounded tab does not resume with one enormous step that
  // walks the camera through a wall.
  const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.08;

  const move = input.sample();

  if (input.wasTapped('KeyR')) {
    camera.placeAt(
      world.spawnX,
      world.spawnY,
      world.spawnAngle,
      world.groundAt(world.spawnX, world.spawnY),
      world.eyeHeight,
    );
    needsRedraw = true;
  }
  if (input.wasTapped('KeyE')) {
    const door = world.doorInFront(camera.x, camera.y, camera.dirX, camera.dirY);
    if (door) world.toggleDoor(door);
  }
  if (input.wasTapped('KeyM')) {
    showRays = !showRays;
    showRaysEl.checked = showRays;
  }
  if (input.wasTapped('KeyF')) {
    camera.flying = !camera.flying;
    camera.vz = 0;
  }
  // Scrub the clock an hour at a time; hold shift to go back. Only worlds
  // running a day/night cycle have a clock to move.
  if (input.wasTapped('KeyT') && world.dayLength > 0) {
    world.advanceClock((move.run ? -1 : 1) / 24);
    needsRedraw = true;
  }
  if (input.wasTapped('KeyG')) {
    const next = (GLYPH_MODES.indexOf(glyphModeEl.value as GlyphMode) + 1) % GLYPH_MODES.length;
    setGlyphs(GLYPH_MODES[next]);
  }
  if (input.wasTapped('BracketLeft')) setFontSize(display.getFontSize() - 1);
  if (input.wasTapped('BracketRight')) setFontSize(display.getFontSize() + 1);
  if (input.wasTapped('KeyP')) setPaused(!paused);

  if (!paused) {
    // Mouse look only applies while the pointer is captured; otherwise a stray
    // movement delta would spin the view when you go back to the editor.
    if (!input.isLocked()) {
      move.mouseDX = 0;
      move.mouseDY = 0;
    }
    camera.update(dt, move, world, display.rows);
    world.update(dt, camera.x, camera.y);
  }

  if (!paused || needsRedraw) {
    renderer.render(world, camera, display.cellAspect);
    changedCells = display.draw(renderer.buf);
    needsRedraw = false;
  }

  minimapAcc += dt;
  if (minimapAcc >= 1 / MINIMAP_HZ) {
    minimapAcc = 0;
    minimap.draw(world, camera, renderer, showRays);
  }

  statsAcc += dt;
  if (statsAcc >= 1 / STATS_HZ) {
    statsAcc = 0;
    updateStats();
  }

  input.endFrame();
}

function updateStats(): void {
  const s = renderer.stats;
  const cells = s.cols * s.rows;
  const heading = ((camera.angle * 180) / Math.PI + 360) % 360;

  stats.set('fps', paused ? 'paused' : fps.toFixed(0), paused ? '' : fps > 50 ? 'good' : fps > 28 ? '' : 'bad');
  stats.set('render', `${s.ms.toFixed(2)} ms`, s.ms < 8 ? 'good' : s.ms < 16 ? '' : 'bad');
  stats.set('grid', `${s.cols} x ${s.rows}`);
  stats.set('cells', String(cells));
  // The headline stability number: a still camera should settle near zero.
  stats.set('redrawn', `${changedCells} (${cells > 0 ? Math.round((changedCells / cells) * 100) : 0}%)`);
  stats.set('rays', String(s.rays));
  stats.set('sprites', `${s.sprites} / ${world.entities.length}`);
  stats.set('lights', String(world.lights.length));
  stats.set('position', `${camera.x.toFixed(2)}, ${camera.y.toFixed(2)}`);
  stats.set('heading', `${heading.toFixed(0)}°`);
  const stance = camera.flying
    ? 'flying'
    : camera.swimming
      ? 'swimming'
      : camera.wading
        ? 'wading'
        : camera.grounded
          ? 'walking'
          : 'falling';
  stats.set('altitude', `${camera.z.toFixed(2)} · ${stance}`, camera.flying || camera.swimming ? 'good' : '');
  const depth = world.waterDepthAt(camera.x, camera.y);
  stats.set('water', depth > 0 ? `${depth.toFixed(2)} deep` : '—');
  stats.set('exposure', `${world.exposure.toFixed(1)} · ×${world.contrast.toFixed(2)} contrast`);

  if (world.dayLength > 0) {
    stats.set(
      'clock',
      `${clockString(world.timeOfDay)}${world.sky.lampness > 0.02 ? ' · lamps' : ''}`,
      world.sky.altitude > 0 ? 'good' : '',
    );
  }

  if (world.infinite) {
    const g = world.gen;
    // A non-zero failure count means the theme's sample is over-constrained
    // and the terrain is drifting toward the solver's fallback.
    stats.set('wfc solves', String(g.solves));
    stats.set('wfc failed', String(g.failures), g.failures === 0 ? 'good' : 'bad');
    stats.set('relaxed', String(g.relaxations));
    stats.set('tunnels', String(g.tunnels));
  }
}

requestAnimationFrame(frame);
