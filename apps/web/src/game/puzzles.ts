/**
 * Puzzles of the window game as pure data from a seeded RNG: every neighbour gets the same puzzle
 * in a window during an outage. Each puzzle keeps its own solution (tests check it is reachable).
 */
import { type GameTier, gameTier } from "../../../../packages/domain/src/game.ts";
import { type Rng, ri, shuffle } from "./rng.ts";

/** Difficulty from the floor (shared with the core, which scores by it). */
export type Tier = GameTier;
export const tierOf = gameTier;

/**
 * Floors of difficulty, per tier (2–9, 10–18, 19–27): no puzzle may be solved in fewer moves.
 * Generators retry until they reach them; tests check them on many keys.
 */
export const MIN_CHAIN_TAPS = [8, 14, 24] as const;
export const MIN_BEAM_FLIPS = [3, 4, 5] as const;
export const MIN_UNTANGLE_CROSSINGS = [5, 8, 12] as const;
export const MIN_SLIDE_MOVES = [4, 7, 9] as const;
/** How far above the floor a slide puzzle may go. */
const SLIDE_SPREAD = [2, 3, 5] as const;
/** At most this many ways to plug everything in (fewer = more thinking). */
export const MAX_CHARGE_SOLUTIONS = [3, 2, 1] as const;

// ── «Ланцюг»: turn tiles until the current reaches every bulb ───────────────────────────────

export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;
type Dir = readonly [dx: number, dy: number, bit: number, back: number];
export const DIRS: readonly Dir[] = [
  [0, -1, N, S],
  [1, 0, E, W],
  [0, 1, S, N],
  [-1, 0, W, E],
];
export const rotate = (v: number): number => ((v << 1) | (v >> 3)) & 15;
export const degree = (v: number): number => [N, E, S, W].filter((b) => v & b).length;

export type ChainPuzzle = { n: number; source: number; solution: number[]; tiles: number[] };

export function chainPowered(n: number, source: number, tiles: readonly number[]): boolean[] {
  const on = new Array<boolean>(n * n).fill(false);
  const queue = [source];
  on[source] = true;
  while (queue.length > 0) {
    const cell = queue.shift() as number;
    const x = cell % n;
    const y = Math.floor(cell / n);
    for (const [dx, dy, bit, back] of DIRS) {
      const a = x + dx;
      const b = y + dy;
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      const next = b * n + a;
      if (!on[next] && (tiles[cell] as number) & bit && (tiles[next] as number) & back) {
        on[next] = true;
        queue.push(next);
      }
    }
  }
  return on;
}

export function chainPuzzle(rng: Rng, tier: Tier): ChainPuzzle {
  const n = [4, 5, 6][tier] as number;
  const solution = new Array<number>(n * n).fill(0);
  const seen = new Array<boolean>(n * n).fill(false);
  const source = ri(rng, n * n);
  const stack = [source];
  seen[source] = true;
  while (stack.length > 0) {
    const cell = stack[stack.length - 1] as number;
    const x = cell % n;
    const y = Math.floor(cell / n);
    const options = DIRS.filter(([dx, dy]) => {
      const a = x + dx;
      const b = y + dy;
      return a >= 0 && b >= 0 && a < n && b < n && !seen[b * n + a];
    });
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const [dx, dy, bit, back] = options[ri(rng, options.length)] as Dir;
    const next = (y + dy) * n + x + dx;
    solution[cell] = (solution[cell] as number) | bit;
    solution[next] = (solution[next] as number) | back;
    seen[next] = true;
    stack.push(next);
  }
  const scramble = () =>
    solution.map((v) => {
      let turns = ri(rng, 4);
      let t = v;
      while (turns-- > 0) t = rotate(t);
      return t;
    });
  let tiles = scramble();
  for (let tries = 0; tries < 60; tries++) {
    const p = { n, source, solution, tiles };
    if (chainTaps(p) >= MIN_CHAIN_TAPS[tier] && !chainPowered(n, source, tiles).every(Boolean))
      break;
    tiles = scramble();
  }
  return { n, source, solution, tiles };
}

/** Taps (quarter turns) that bring every tile to its place. */
export function chainTaps(p: ChainPuzzle): number {
  return p.tiles.reduce((sum, tile, i) => {
    let v = tile;
    for (let r = 0; r < 4; r++) {
      if (v === p.solution[i]) return sum + r;
      v = rotate(v);
    }
    return sum;
  }, 0);
}

// ── «Промінь»: turn mirrors so the torch beam hits the solar panel ──────────────────────────

export type Mirror = "/" | "\\";
export const reflect = (m: Mirror, [dx, dy]: readonly [number, number]): [number, number] =>
  m === "/" ? [-dy, -dx] : [dy, dx];

export type BeamPuzzle = {
  n: number;
  /** The torch shines from the left edge along this row. */
  row: number;
  target: number;
  mirrors: Map<number, Mirror>;
  /** Mirrors on the solution path, as they must stand. */
  solution: Map<number, Mirror>;
};

export function traceBeam(
  p: Pick<BeamPuzzle, "n" | "row" | "target">,
  mirrors: ReadonlyMap<number, Mirror>,
): { points: [number, number][]; hit: boolean } {
  const { n } = p;
  let x = -1;
  let y = p.row;
  let d: [number, number] = [1, 0];
  const points: [number, number][] = [[0, p.row + 0.5]];
  for (let guard = 0; guard < n * n * 4; guard++) {
    const nx = x + d[0];
    const ny = y + d[1];
    if (nx < 0 || ny < 0 || nx >= n || ny >= n) {
      points.push([x + 0.5 + d[0] * 0.5, y + 0.5 + d[1] * 0.5]);
      return { points, hit: false };
    }
    x = nx;
    y = ny;
    const cell = y * n + x;
    if (cell === p.target) {
      points.push([x + 0.5, y + 0.5]);
      return { points, hit: true };
    }
    const m = mirrors.get(cell);
    if (m) {
      points.push([x + 0.5, y + 0.5]);
      d = reflect(m, d);
    }
  }
  return { points, hit: false };
}

/**
 * A path with MIN_BEAM_FLIPS turns from the torch to the panel; every mirror on it starts wrong,
 * decoys stand off the path. Rebuilt whole while any shorter way to the panel exists.
 */
export function beamPuzzle(rng: Rng, tier: Tier): BeamPuzzle {
  const want = MIN_BEAM_FLIPS[tier];
  let best: { p: BeamPuzzle; flips: number } | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const p = beamAttempt(rng, tier);
    if (!p) continue;
    const flips = beamMinFlips(p, want);
    if (flips >= want) return p;
    if (!best || flips > best.flips) best = { p, flips };
  }
  if (best) return best.p;
  const n = [5, 6, 7][tier] as number;
  return { n, row: 0, target: n - 1, mirrors: new Map([[1, "/"]]), solution: new Map() };
}

function beamAttempt(rng: Rng, tier: Tier): BeamPuzzle | null {
  const n = [5, 6, 7][tier] as number;
  const turnsNeeded = MIN_BEAM_FLIPS[tier];
  const decoys = [3, 5, 7][tier] as number;
  const inGrid = (a: number, b: number) => a >= 0 && b >= 0 && a < n && b < n;
  let row = 0;
  let target = -1;
  let solution = new Map<number, Mirror>();
  outer: for (let attempt = 0; attempt < 800; attempt++) {
    row = ri(rng, n);
    solution = new Map();
    const used = new Set<number>();
    let x = 0;
    let y = row;
    let d: [number, number] = [1, 0];
    let turns = 0;
    let len = 1;
    used.add(y * n + x);
    for (let guard = 0; guard < n * n; guard++) {
      const here = y * n + x;
      const nx = x + d[0];
      const ny = y + d[1];
      const straight = inGrid(nx, ny) && !used.has(ny * n + nx);
      const sides: [number, number][] = d[0]
        ? [
            [0, 1],
            [0, -1],
          ]
        : [
            [1, 0],
            [-1, 0],
          ];
      const perp = sides.filter(([a, b]) => inGrid(x + a, y + b) && !used.has((y + b) * n + x + a));
      const canEnd = turns >= turnsNeeded && len >= Math.max(4, n - 1) && !solution.has(here);
      if (canEnd && (rng() < 0.35 || (!straight && perp.length === 0))) {
        target = here;
        break outer;
      }
      if ((!straight || (turns < turnsNeeded && rng() < 0.4)) && perp.length > 0) {
        const nd = perp[ri(rng, perp.length)] as [number, number];
        const slash = reflect("/", d);
        solution.set(here, slash[0] === nd[0] && slash[1] === nd[1] ? "/" : "\\");
        d = nd;
        turns++;
        x += d[0];
        y += d[1];
        used.add(y * n + x);
        len++;
        continue;
      }
      if (!straight) continue outer;
      x = nx;
      y = ny;
      used.add(y * n + x);
      len++;
    }
  }
  if (target < 0) return null;
  const onPath = new Set<number>();
  {
    let x = -1;
    let y = row;
    let d: [number, number] = [1, 0];
    for (let g = 0; g < n * n * 2; g++) {
      x += d[0];
      y += d[1];
      if (!inGrid(x, y)) break;
      const c = y * n + x;
      onPath.add(c);
      if (c === target) break;
      const m = solution.get(c);
      if (m) d = reflect(m, d);
    }
  }
  const free = [...Array(n * n).keys()].filter(
    (c) => c !== target && !solution.has(c) && !onPath.has(c),
  );
  const decoyCells = shuffle(rng, free).slice(0, decoys);
  const flip = (m: Mirror | undefined): Mirror => (m === "/" ? "\\" : "/");
  const p = { n, row, target };
  const mirrors = new Map<number, Mirror>();
  for (const [c, m] of solution) mirrors.set(c, flip(m));
  for (const c of decoyCells) mirrors.set(c, rng() < 0.5 ? "/" : "\\");
  return { ...p, mirrors, solution };
}

/** Fewest mirror turns that bring the beam to the panel, counted up to `cap`. */
export function beamMinFlips(
  p: Pick<BeamPuzzle, "n" | "row" | "target" | "mirrors">,
  cap = Number.POSITIVE_INFINITY,
): number {
  const cells = [...p.mirrors.keys()];
  const limit = Math.min(cap, cells.length + 1);
  const mirrors = new Map(p.mirrors);
  const turn = (c: number) => mirrors.set(c, mirrors.get(c) === "/" ? "\\" : "/");
  // try every set of `size` mirrors, smallest sets first
  const tryChoose = (size: number, from: number): boolean => {
    if (size === 0) return traceBeam(p, mirrors).hit;
    for (let i = from; i <= cells.length - size; i++) {
      const c = cells[i] as number;
      turn(c);
      const hit = tryChoose(size - 1, i + 1);
      turn(c);
      if (hit) return true;
    }
    return false;
  };
  for (let size = 0; size < limit; size++) if (tryChoose(size, 0)) return size;
  return limit;
}

// ── «Розплутай дроти»: drag junction boxes until no wire crosses another ────────────────────

export type Point = { x: number; y: number };
export type UntanglePuzzle = {
  size: number;
  edges: [number, number][];
  start: Point[];
  /** A layout without crossings (the grid it was built from). */
  solved: Point[];
};

export function untanglePuzzle(rng: Rng, tier: Tier): UntanglePuzzle {
  const [cols, rows] = [
    [3, 3],
    [4, 3],
    [4, 4],
  ][tier] as [number, number];
  const id = (x: number, y: number) => y * cols + x;
  const count = cols * rows;
  const edges: [number, number][] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (x + 1 < cols) edges.push([id(x, y), id(x + 1, y)]);
      if (y + 1 < rows) edges.push([id(x, y), id(x, y + 1)]);
      if (x + 1 < cols && y + 1 < rows && rng() < 0.55)
        edges.push(rng() < 0.5 ? [id(x, y), id(x + 1, y + 1)] : [id(x + 1, y), id(x, y + 1)]);
    }
  }
  const size = 300;
  const solved = [...Array(count).keys()].map((i) => ({
    x: 50 + ((i % cols) * 200) / (cols - 1),
    y: 50 + (Math.floor(i / cols) * 200) / (rows - 1),
  }));
  // boxes round a circle in a shuffled order; the most tangled of a few orders is kept
  let start: Point[] = [];
  let most = -1;
  for (let tries = 0; tries < 40 && most < MIN_UNTANGLE_CROSSINGS[tier]; tries++) {
    const order = shuffle(rng, [...Array(count).keys()]);
    const layout = new Array<Point>(count);
    order.forEach((node, i) => {
      const a = (2 * Math.PI * i) / count - Math.PI / 2;
      layout[node] = { x: 150 + 118 * Math.cos(a), y: 150 + 118 * Math.sin(a) };
    });
    const crossings = crossingCount(edges, layout);
    if (crossings > most) {
      most = crossings;
      start = layout;
    }
  }
  return { size, edges, start, solved };
}

/** Pairs of wires that cross. */
export function crossingCount(edges: readonly [number, number][], pos: readonly Point[]): number {
  let count = 0;
  forEachCrossing(edges, pos, () => {
    count++;
  });
  return count;
}

function forEachCrossing(
  edges: readonly [number, number][],
  pos: readonly Point[],
  visit: (i: number, j: number) => void,
): void {
  const o = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i] as [number, number];
      const [c, d] = edges[j] as [number, number];
      if (a === c || a === d || b === c || b === d) continue;
      const [A, B, C, D] = [pos[a], pos[b], pos[c], pos[d]] as [Point, Point, Point, Point];
      if (o(A, B, C) !== o(A, B, D) && o(C, D, A) !== o(C, D, B)) visit(i, j);
    }
  }
}

/** Indices of edges that cross another edge (shared ends do not count). */
export function crossingEdges(
  edges: readonly [number, number][],
  pos: readonly Point[],
): Set<number> {
  const bad = new Set<number>();
  forEachCrossing(edges, pos, (i, j) => {
    bad.add(i);
    bad.add(j);
  });
  return bad;
}

// ── «Запобіжник»: stop the swinging needle in the zone three times ──────────────────────────

export type FusePuzzle = { zones: [number, number][]; speed: number; phase: number };

export function fusePuzzle(rng: Rng, tier: Tier): FusePuzzle {
  const base = [0.22, 0.16, 0.11][tier] as number;
  const zones = [0, 1, 2].map((i): [number, number] => {
    const w = base * (1 - i * 0.15);
    const c = w / 2 + rng() * (1 - w);
    return [c - w / 2, c + w / 2];
  });
  return { zones, speed: [1.7, 2.2, 2.8][tier] as number, phase: rng() * Math.PI * 2 };
}

// ── «Кіт чи пес»: tap only the chosen animal in the windows ─────────────────────────────────

export type Creature = "cat" | "dog" | "man";
export type PetsPuzzle = {
  target: "cat" | "dog";
  need: number;
  showMs: number;
  gapMs: number;
  /** 16 windows (4 × 4); each wave opens a few of them. */
  waves: { window: number; kind: Creature }[][];
};

export function petsPuzzle(rng: Rng, tier: Tier): PetsPuzzle {
  const target = rng() < 0.5 ? "cat" : "dog";
  const other = target === "cat" ? "dog" : "cat";
  const need = [5, 7, 9][tier] as number;
  const perWave = [1, 2, 3][tier] as number;
  const waves: { window: number; kind: Creature }[][] = [];
  let previous = new Set<number>();
  for (let i = 0; i < need * 3 + 6; i++) {
    const open = shuffle(
      rng,
      [...Array(16).keys()].filter((w) => !previous.has(w)),
    ).slice(0, perWave);
    waves.push(
      open.map((window) => {
        const r = rng();
        return { window, kind: r < 0.4 ? target : r < 0.7 ? other : "man" };
      }),
    );
    previous = new Set(open);
  }
  let targets = waves.flat().filter((s) => s.kind === target).length;
  for (let i = 0; targets < need + 3 && i < waves.length; i++) {
    const s = waves[i]?.find((x) => x.kind !== target);
    if (s) {
      s.kind = target;
      targets++;
    }
  }
  return {
    target,
    need,
    showMs: [1000, 850, 700][tier] as number,
    gapMs: [480, 400, 320][tier] as number,
    waves,
  };
}

// ── «Винеси генератор»: slide the boxes, push the generator out ─────────────────────────────

export type Block = { r: number; c: number; len: number; h: boolean; gen: boolean };
export type SlidePuzzle = { n: number; row: number; blocks: Block[] };

export function slideGrid(n: number, blocks: readonly Block[], skip = -1): number[] {
  const g = new Array<number>(n * n).fill(-1);
  blocks.forEach((b, i) => {
    if (i === skip) return;
    for (let j = 0; j < b.len; j++) g[(b.r + (b.h ? 0 : j)) * n + b.c + (b.h ? j : 0)] = i;
  });
  return g;
}

export function slideFits(
  n: number,
  grid: readonly number[],
  b: Block,
  r: number,
  c: number,
): boolean {
  for (let j = 0; j < b.len; j++) {
    const rr = r + (b.h ? 0 : j);
    const cc = c + (b.h ? j : 0);
    if (rr < 0 || cc < 0 || rr >= n || cc >= n || (grid[rr * n + cc] as number) >= 0) return false;
  }
  return true;
}

/**
 * A random layout with the generator at the exit, then every arrangement its boxes can reach and
 * how many moves each is from freeing the generator (a move slides one box any distance). The
 * puzzle is an arrangement at least MIN_SLIDE_MOVES away — the farthest one on the top tier.
 */
export function slidePuzzle(rng: Rng, tier: Tier): SlidePuzzle {
  const n = 6;
  const row = 2;
  const boxes = [9, 11, 12][tier] as number;
  const want = MIN_SLIDE_MOVES[tier];
  let best: { blocks: Block[]; moves: number } | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const layout = slideLayout(rng, n, row, boxes);
    const space = slideSpace(n, layout, 12_000);
    if (!space) continue;
    const far = Math.max(...space.dist);
    const pickAt = (d: number) => {
      const at = space.states.filter((_, i) => space.dist[i] === d);
      return at[ri(rng, at.length)] as number[];
    };
    if (far >= want) {
      // not much above the floor: easy floors stay easy, the top ones as hard as allowed
      const top = Math.min(far, want + SLIDE_SPREAD[tier]);
      const d = tier === 2 ? top : want + ri(rng, top - want + 1);
      return { n, row, blocks: slidePlace(layout, pickAt(d)) };
    }
    if (far > 0 && (!best || far > best.moves))
      best = { blocks: slidePlace(layout, pickAt(far)), moves: far };
  }
  return { n, row, blocks: best?.blocks ?? slideLayout(rng, n, row, boxes) };
}

function slideLayout(rng: Rng, n: number, row: number, boxes: number): Block[] {
  const blocks: Block[] = [{ r: row, c: n - 2, len: 2, h: true, gen: true }];
  for (let tries = 0; blocks.length < boxes + 1 && tries < 500; tries++) {
    const h = rng() < 0.5;
    const len = rng() < 0.75 ? 2 : 3;
    const r = ri(rng, h ? n : n - len + 1);
    const c = ri(rng, h ? n - len + 1 : n);
    if (h && r === row) continue; // a box across the exit row could never let the generator out
    const b = { r, c, len, h, gen: false };
    if (slideFits(n, slideGrid(n, blocks), b, r, c)) blocks.push(b);
  }
  return blocks;
}

/** Blocks of a layout moved to the given positions (column of a horizontal box, row of a vertical). */
function slidePlace(layout: readonly Block[], pos: readonly number[]): Block[] {
  return layout.map((b, i) =>
    b.h ? { ...b, c: pos[i] as number } : { ...b, r: pos[i] as number },
  );
}

/** Calls `visit` with every arrangement one move away. */
function slideMoves(
  n: number,
  layout: readonly Block[],
  pos: readonly number[],
  grid: Int8Array,
  visit: (next: number[]) => void,
): void {
  grid.fill(-1);
  layout.forEach((b, i) => {
    const p = pos[i] as number;
    for (let j = 0; j < b.len; j++) grid[(b.h ? b.r : p + j) * n + (b.h ? p + j : b.c)] = i;
  });
  layout.forEach((b, i) => {
    for (const dir of [-1, 1]) {
      for (let p = (pos[i] as number) + dir; ; p += dir) {
        const lead = dir < 0 ? p : p + b.len - 1;
        if (lead < 0 || lead >= n) break;
        if ((grid[(b.h ? b.r : lead) * n + (b.h ? lead : b.c)] as number) >= 0) break;
        const next = pos.slice();
        next[i] = p;
        visit(next);
      }
    }
  });
}

/** Every arrangement reachable from a layout and its distance to a freed generator; null if huge. */
function slideSpace(
  n: number,
  layout: readonly Block[],
  cap: number,
): { states: number[][]; dist: number[] } | null {
  const k = layout.length;
  const key = (pos: readonly number[]) => {
    let x = 0;
    for (let i = k - 1; i >= 0; i--) x = x * n + (pos[i] as number);
    return x;
  };
  const grid = new Int8Array(n * n);
  const index = new Map<number, number>();
  const states: number[][] = [];
  const add = (pos: number[]) => {
    const e = key(pos);
    if (index.has(e)) return;
    index.set(e, states.length);
    states.push(pos);
  };
  add(layout.map((b) => (b.h ? b.c : b.r)));
  for (let i = 0; i < states.length; i++) {
    if (states.length > cap) return null;
    slideMoves(n, layout, states[i] as number[], grid, add);
  }
  const dist = new Array<number>(states.length).fill(-1);
  const queue: number[] = [];
  states.forEach((pos, i) => {
    if (pos[0] === n - 2) {
      dist[i] = 0;
      queue.push(i);
    }
  });
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q] as number;
    slideMoves(n, layout, states[i] as number[], grid, (next) => {
      const j = index.get(key(next));
      if (j !== undefined && dist[j] === -1) {
        dist[j] = (dist[i] as number) + 1;
        queue.push(j);
      }
    });
  }
  return { states, dist };
}

/** Fewest moves that free the generator (-1: none within `limit` arrangements). */
export function slideMinMoves(p: SlidePuzzle, limit = 200_000): number {
  const grid = new Int8Array(p.n * p.n);
  const k = p.blocks.length;
  const key = (pos: readonly number[]) => pos.join(",");
  let frontier = [p.blocks.map((b) => (b.h ? b.c : b.r))];
  const seen = new Set([key(frontier[0] as number[])]);
  for (let depth = 0; frontier.length > 0 && seen.size < limit; depth++) {
    const next: number[][] = [];
    for (const pos of frontier) {
      if (pos[0] === p.n - 2) return depth;
      slideMoves(p.n, p.blocks, pos, grid, (q) => {
        const e = key(q);
        if (!seen.has(e) && q.length === k) {
          seen.add(e);
          next.push(q);
        }
      });
    }
    frontier = next;
  }
  return -1;
}

// ── «Розклади заряд»: drag cables from devices to power banks ───────────────────────────────

export type DeviceKind =
  | "phone"
  | "lamp"
  | "router"
  | "laptop"
  | "speaker"
  | "headphones"
  | "tablet"
  | "camera";
export type Port = "A" | "C";
export type ChargeDevice = { kind: DeviceKind; name: string; need: number; usbC: boolean };
export type ChargeBank = { name: string; cap: number; ports: Port[] };
export type ChargePuzzle = { devices: ChargeDevice[]; banks: ChargeBank[]; home: number[] };

const DEVICES: [DeviceKind, string, number, number, boolean][] = [
  ["phone", "Телефон", 4, 6, false],
  ["lamp", "Лампа", 2, 3, false],
  ["router", "Роутер", 6, 8, false],
  ["laptop", "Ноутбук", 14, 20, true],
  ["speaker", "Колонка", 3, 5, false],
  ["headphones", "Навушники", 1, 2, false],
  ["tablet", "Планшет", 8, 11, true],
  ["camera", "Камера", 2, 4, false],
];

/**
 * Devices split among the banks, each bank sized to its share (a little slack only on the first
 * tier). Kept only when there are few ways to plug everything in, and above the first tier only
 * when plugging each device into the first bank that takes it, in the order shown, fails.
 */
export function chargePuzzle(rng: Rng, tier: Tier): ChargePuzzle {
  let best: { p: ChargePuzzle; score: number } | null = null;
  for (let attempt = 0; attempt < 150; attempt++) {
    const p = chargeAttempt(rng, tier);
    const ways = chargeSolutions(p);
    const naive = chargeFirstFit(p);
    if (ways <= MAX_CHARGE_SOLUTIONS[tier] && (tier === 0 || !naive)) return p;
    const score = ways + (naive ? 100 : 0);
    if (!best || score < best.score) best = { p, score };
  }
  return (best as { p: ChargePuzzle }).p;
}

function bankTakes(
  bank: ChargeBank,
  load: { need: number; all: number; c: number },
  d: ChargeDevice,
): boolean {
  const cPorts = bank.ports.filter((x) => x === "C").length;
  return (
    load.need + d.need <= bank.cap && load.all < bank.ports.length && (!d.usbC || load.c < cPorts)
  );
}

/** Ways to plug every device in (energy and ports; a C device needs a C port). */
export function chargeSolutions(p: ChargePuzzle, stopAt = 1000): number {
  const load = p.banks.map(() => ({ need: 0, all: 0, c: 0 }));
  let count = 0;
  const go = (i: number) => {
    if (count >= stopAt) return;
    const d = p.devices[i];
    if (!d) {
      count++;
      return;
    }
    p.banks.forEach((bank, b) => {
      const l = load[b] as { need: number; all: number; c: number };
      if (!bankTakes(bank, l, d)) return;
      l.need += d.need;
      l.all++;
      if (d.usbC) l.c++;
      go(i + 1);
      l.need -= d.need;
      l.all--;
      if (d.usbC) l.c--;
    });
  };
  go(0);
  return count;
}

/** Does plugging each device, in the order shown, into the first bank that takes it work? */
export function chargeFirstFit(p: ChargePuzzle): boolean {
  const load = p.banks.map(() => ({ need: 0, all: 0, c: 0 }));
  return p.devices.every((d) => {
    const b = p.banks.findIndex((bank, k) =>
      bankTakes(bank, load[k] as { need: number; all: number; c: number }, d),
    );
    if (b < 0) return false;
    const l = load[b] as { need: number; all: number; c: number };
    l.need += d.need;
    l.all++;
    if (d.usbC) l.c++;
    return true;
  });
}

function chargeAttempt(rng: Rng, tier: Tier): ChargePuzzle {
  const banksCount = [2, 3, 3][tier] as number;
  const count = [4, 6, 7][tier] as number;
  const slack = [1, 0, 0][tier] as number;
  const extra = [1, 0, 0][tier] as number;
  const maxPorts = banksCount === 3 ? 4 : 6;
  const devices = shuffle(rng, DEVICES)
    .slice(0, count)
    .map(([kind, name, lo, hi, usbC]) => ({ kind, name, need: lo + ri(rng, hi - lo + 1), usbC }));
  const used = new Array<number>(banksCount).fill(0);
  const home = devices.map((_, i) => {
    let b = i;
    if (i >= banksCount) {
      const open = [...Array(banksCount).keys()].filter((k) => (used[k] as number) < maxPorts);
      b = open[ri(rng, open.length)] as number;
    }
    used[b] = (used[b] as number) + 1;
    return b;
  });
  const banks = ["A", "Б", "В"].slice(0, banksCount).map((name, b) => {
    const mine = devices.filter((_, i) => home[i] === b);
    const ports: Port[] = mine.map((d) => (d.usbC || rng() < 0.25 ? "C" : "A"));
    for (let k = 0; k < extra; k++) if (ports.length < maxPorts && rng() < 0.6) ports.push("A");
    return { name, cap: mine.reduce((s, d) => s + d.need, 0) + slack, ports: shuffle(rng, ports) };
  });
  return { devices, banks, home };
}
