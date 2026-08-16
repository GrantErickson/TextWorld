/**
 * Wave Function Collapse, overlapping model, over characters.
 *
 * The alphabet here is deliberately *characters* rather than tile ids. A theme
 * is authored as a small block of ASCII art — the same thing someone would
 * type into the map editor — and the model emits more text in that style,
 * which then goes through the ordinary legend/material pipeline. Whatever '#'
 * means in a hand-written map it means in a generated one, so adding a world
 * type costs a few lines of art rather than a new code path.
 *
 * The implementation is the standard Gumin formulation: extract every NxN
 * patch of the sample as a "pattern", precompute which patterns may sit beside
 * which in each of the four directions, then repeatedly collapse the least
 * constrained cell and propagate the consequences. The one addition is that a
 * solve can be seeded with cells whose character is already fixed, which is
 * what lets a newly exposed strip of the world agree with the terrain it is
 * being stitched onto.
 */

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const OPPOSITE = [1, 0, 3, 2];

/** Deterministic PRNG. The same seed must always produce the same world. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WfcModel {
  readonly n: number;
  /** Alphabet: index -> character. */
  readonly chars: string[];
  /** Each pattern is n*n character indices, row major. */
  readonly patterns: Uint8Array[];
  readonly weights: Float64Array;
  /** propagator[dir][pattern] = patterns allowed in that direction. */
  readonly propagator: Int32Array[][];
  /** Character index a pattern contributes to the output (its top-left cell). */
  readonly output: Uint8Array;
  /** Most common pattern, used when a solve has to give up on a cell. */
  readonly fallbackPattern: number;

  constructor(sample: string[], n = 3) {
    if (sample.length < n) throw new Error(`WFC sample needs at least ${n} rows.`);
    this.n = n;

    const width = sample.reduce((w, r) => Math.max(w, r.length), 0);
    if (width < n) throw new Error(`WFC sample needs at least ${n} columns.`);
    const rows = sample.map((r) => r.padEnd(width, r[r.length - 1] ?? ' '));
    const height = rows.length;

    // Build the alphabet in first-seen order.
    const charIndex = new Map<string, number>();
    this.chars = [];
    const grid = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ch = rows[y][x];
        let idx = charIndex.get(ch);
        if (idx === undefined) {
          idx = this.chars.length;
          charIndex.set(ch, idx);
          this.chars.push(ch);
        }
        grid[y * width + x] = idx;
      }
    }

    // Extract patterns. Sampling is non-periodic: wrapping a sample that was
    // drawn with a solid border would splice its top edge onto its bottom and
    // teach the model walls that do not exist.
    const seen = new Map<string, number>();
    const patterns: Uint8Array[] = [];
    const counts: number[] = [];
    for (let y = 0; y + n <= height; y++) {
      for (let x = 0; x + n <= width; x++) {
        const p = new Uint8Array(n * n);
        for (let dy = 0; dy < n; dy++) {
          for (let dx = 0; dx < n; dx++) {
            p[dy * n + dx] = grid[(y + dy) * width + (x + dx)];
          }
        }
        const key = String.fromCharCode(...p);
        const at = seen.get(key);
        if (at === undefined) {
          seen.set(key, patterns.length);
          patterns.push(p);
          counts.push(1);
        } else {
          counts[at]++;
        }
      }
    }

    this.patterns = patterns;
    this.weights = Float64Array.from(counts);
    this.output = new Uint8Array(patterns.map((p) => p[0]));

    let best = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
    this.fallbackPattern = best;

    // Adjacency: two patterns may sit side by side when their overlap agrees.
    const P = patterns.length;
    this.propagator = [];
    for (let d = 0; d < 4; d++) {
      const [dx, dy] = DIRS[d];
      const perPattern: Int32Array[] = new Array(P);
      for (let p = 0; p < P; p++) {
        const list: number[] = [];
        for (let q = 0; q < P; q++) {
          if (agrees(patterns[p], patterns[q], dx, dy, n)) list.push(q);
        }
        perPattern[p] = Int32Array.from(list);
      }
      this.propagator.push(perPattern);
    }
  }

  charToIndex(ch: string): number {
    return this.chars.indexOf(ch);
  }
}

function agrees(a: Uint8Array, b: Uint8Array, dx: number, dy: number, n: number): boolean {
  const xmin = dx < 0 ? 0 : dx;
  const xmax = dx < 0 ? dx + n : n;
  const ymin = dy < 0 ? 0 : dy;
  const ymax = dy < 0 ? dy + n : n;
  for (let y = ymin; y < ymax; y++) {
    for (let x = xmin; x < xmax; x++) {
      if (a[y * n + x] !== b[(y - dy) * n + (x - dx)]) return false;
    }
  }
  return true;
}

export interface SolveRequest {
  width: number;
  height: number;
  /** Per cell: a character index to hold fixed, or -1 to solve for. */
  known: Int16Array;
  seed: number;
  /** Retries before falling back. A contradiction is always possible. */
  attempts?: number;
}

export interface SolveResult {
  /** Character indices, row major, always fully populated. */
  chars: Uint8Array;
  /** True when WFC resolved every cell without giving up. */
  ok: boolean;
  attempts: number;
}

/**
 * Solve a rectangle. Never throws and never loops forever: on repeated
 * contradiction it returns the best partial assignment, filling whatever is
 * left from the most common pattern. The frame loop depends on that.
 */
export function solveRegion(model: WfcModel, req: SolveRequest): SolveResult {
  const attempts = req.attempts ?? 6;
  let last: SolveResult | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const r = attemptSolve(model, req, req.seed + attempt * 0x9e3779b9);
    if (r.ok) return { ...r, attempts: attempt + 1 };
    last = r;
  }
  return { ...(last as SolveResult), attempts };
}

function attemptSolve(model: WfcModel, req: SolveRequest, seed: number): SolveResult {
  const { width: w, height: h, known } = req;
  const cells = w * h;
  const P = model.patterns.length;
  const rand = mulberry32(seed);

  const wave = new Uint8Array(cells * P).fill(1);
  const remaining = new Int32Array(cells).fill(P);
  // compatible[cell][pattern][dir]: how many patterns in the neighbour on that
  // side still support this pattern. When it reaches zero the pattern is dead.
  const compatible = new Int32Array(cells * P * 4);
  for (let c = 0; c < cells; c++) {
    for (let p = 0; p < P; p++) {
      const base = (c * P + p) * 4;
      for (let d = 0; d < 4; d++) compatible[base + d] = model.propagator[OPPOSITE[d]][p].length;
    }
  }

  const stackCell: number[] = [];
  const stackPattern: number[] = [];
  let contradiction = false;

  const ban = (c: number, p: number): void => {
    if (!wave[c * P + p]) return;
    wave[c * P + p] = 0;
    const base = (c * P + p) * 4;
    for (let d = 0; d < 4; d++) compatible[base + d] = 0;
    remaining[c]--;
    if (remaining[c] === 0) contradiction = true;
    stackCell.push(c);
    stackPattern.push(p);
  };

  const propagate = (): void => {
    while (stackCell.length > 0 && !contradiction) {
      const c1 = stackCell.pop() as number;
      const p1 = stackPattern.pop() as number;
      const x1 = c1 % w;
      const y1 = (c1 - x1) / w;

      for (let d = 0; d < 4; d++) {
        const x2 = x1 + DIRS[d][0];
        const y2 = y1 + DIRS[d][1];
        if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
        const c2 = y2 * w + x2;
        const allowed = model.propagator[d][p1];
        for (let i = 0; i < allowed.length; i++) {
          const p2 = allowed[i];
          if (!wave[c2 * P + p2]) continue;
          const at = (c2 * P + p2) * 4 + d;
          compatible[at]--;
          if (compatible[at] === 0) ban(c2, p2);
        }
      }
    }
  };

  // Seed the fixed cells first: everything else is solved around them.
  for (let c = 0; c < cells && !contradiction; c++) {
    const want = known[c];
    if (want < 0) continue;
    for (let p = 0; p < P; p++) {
      if (model.output[p] !== want && wave[c * P + p]) ban(c, p);
    }
  }
  if (!contradiction) propagate();

  while (!contradiction) {
    // Observe: fewest options left, with noise so ties do not comb the grid.
    let bestCell = -1;
    let bestScore = Infinity;
    for (let c = 0; c < cells; c++) {
      if (remaining[c] <= 1) continue;
      const score = remaining[c] + rand() * 0.5;
      if (score < bestScore) {
        bestScore = score;
        bestCell = c;
      }
    }
    if (bestCell < 0) break; // fully resolved

    // Collapse by weight.
    let total = 0;
    for (let p = 0; p < P; p++) if (wave[bestCell * P + p]) total += model.weights[p];
    let roll = rand() * total;
    let chosen = -1;
    for (let p = 0; p < P; p++) {
      if (!wave[bestCell * P + p]) continue;
      roll -= model.weights[p];
      if (roll <= 0) {
        chosen = p;
        break;
      }
    }
    if (chosen < 0) {
      for (let p = P - 1; p >= 0; p--) {
        if (wave[bestCell * P + p]) {
          chosen = p;
          break;
        }
      }
    }
    for (let p = 0; p < P; p++) if (p !== chosen && wave[bestCell * P + p]) ban(bestCell, p);
    propagate();
  }

  // Read out. On a failed solve most cells are still undecided, so pick each
  // one's *likeliest* remaining pattern rather than its first: pattern 0 is
  // whatever sat in the sample's top-left corner, and biasing a whole region
  // toward one arbitrary patch turns every failure into a slab of it.
  const chars = new Uint8Array(cells);
  for (let c = 0; c < cells; c++) {
    let picked = -1;
    let bestWeight = -1;
    for (let p = 0; p < P; p++) {
      if (!wave[c * P + p]) continue;
      if (model.weights[p] > bestWeight) {
        bestWeight = model.weights[p];
        picked = p;
      }
    }
    if (picked >= 0) chars[c] = model.output[picked];
    else if (known[c] >= 0) chars[c] = known[c];
    else chars[c] = model.output[model.fallbackPattern];
  }

  return { chars, ok: !contradiction, attempts: 1 };
}
