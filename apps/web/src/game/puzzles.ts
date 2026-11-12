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
export const MIN_BEAM_FLIPS = [3, 4, 6] as const;
export const MIN_UNTANGLE_CROSSINGS = [5, 8, 12] as const;
export const MIN_SLIDE_MOVES = [4, 7, 9] as const;
/** How far above the floor a slide puzzle may go. */
const SLIDE_SPREAD = [2, 3, 5] as const;
/** At most this many ways to plug everything in (fewer = more thinking). */
export const MAX_CHARGE_SOLUTIONS = [3, 2, 1] as const;
/** «Тривожна валізка»: at most this many ways to pack the bag full. */
export const MAX_PACK_SOLUTIONS = [40, 20, 24] as const;
/** «Батарейки по зарядках»: at least this many pours to sort them. */
export const MIN_BATTERY_MOVES = [6, 10, 14] as const;

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

// ── «Промінь»: turn mirrors so the torch beam runs through every solar panel ─────────────────

export type Mirror = "/" | "\\";
export const reflect = (m: Mirror, [dx, dy]: readonly [number, number]): [number, number] =>
  m === "/" ? [-dy, -dx] : [dy, dx];
const turned = (m: Mirror): Mirror => (m === "/" ? "\\" : "/");

/** Board side, panels to light at once, turns of the path it is built on, decoy mirrors. */
const BEAM_N = [6, 7, 8] as const;
const BEAM_PANELS = [2, 3, 4] as const;
const BEAM_TURNS = [4, 6, 8] as const;
const BEAM_DECOYS = [5, 9, 13] as const;

export type BeamPuzzle = {
  n: number;
  /** The torch shines from the left edge along this row. */
  row: number;
  /** Solar panels the beam must run through, all at once (it passes them straight). */
  panels: number[];
  mirrors: Map<number, Mirror>;
  /** The mirrors of the path it was built on, as they must stand. */
  solution: Map<number, Mirror>;
};

export function traceBeam(
  p: Pick<BeamPuzzle, "n" | "row" | "panels">,
  mirrors: ReadonlyMap<number, Mirror>,
): { points: [number, number][]; lit: Set<number>; hit: boolean } {
  const { n } = p;
  const panels = new Set(p.panels);
  const lit = new Set<number>();
  let x = -1;
  let y = p.row;
  let d: [number, number] = [1, 0];
  const points: [number, number][] = [[0, p.row + 0.5]];
  for (let guard = 0; guard < n * n * 4; guard++) {
    const nx = x + d[0];
    const ny = y + d[1];
    if (nx < 0 || ny < 0 || nx >= n || ny >= n) {
      points.push([x + 0.5 + d[0] * 0.5, y + 0.5 + d[1] * 0.5]);
      break;
    }
    x = nx;
    y = ny;
    const cell = y * n + x;
    if (panels.has(cell)) lit.add(cell);
    const m = mirrors.get(cell);
    if (m) {
      points.push([x + 0.5, y + 0.5]);
      d = reflect(m, d);
    }
  }
  return { points, lit, hit: lit.size === panels.size };
}

/**
 * A winding path from the torch out of the board with the panels spread along it; its mirrors
 * start turned wrong (at least MIN_BEAM_FLIPS of them), decoys stand everywhere else. Kept when
 * no cheaper way lights every panel and when following the beam and
 * turning each mirror towards the nearest dark panel does not solve it (beamGreedy).
 */
export function beamPuzzle(rng: Rng, tier: Tier): BeamPuzzle {
  let best: { p: BeamPuzzle; score: number } | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const p = beamAttempt(rng, tier);
    if (!p) continue;
    const built = [...p.solution].filter(([c, m]) => p.mirrors.get(c) !== m).length;
    const flips = beamMinFlips(p, built + 1);
    const outwits = !beamGreedy(p);
    if (flips >= MIN_BEAM_FLIPS[tier] && outwits) return p;
    const score = flips + (outwits ? 100 : 0);
    if (!best || score > best.score) best = { p, score };
  }
  if (best) return best.p;
  const n = BEAM_N[tier];
  return { n, row: 0, panels: [1], mirrors: new Map(), solution: new Map() };
}

function beamAttempt(rng: Rng, tier: Tier): BeamPuzzle | null {
  const n = BEAM_N[tier];
  const inGrid = (a: number, b: number) => a >= 0 && b >= 0 && a < n && b < n;
  for (let attempt = 0; attempt < 400; attempt++) {
    const row = ri(rng, n);
    const solution = new Map<number, Mirror>();
    const path: number[] = [];
    const used = new Set<number>();
    let x = 0;
    let y = row;
    let d: [number, number] = [1, 0];
    let done = false;
    for (let guard = 0; guard < n * n; guard++) {
      const here = y * n + x;
      used.add(here);
      path.push(here);
      const ax = x + d[0];
      const ay = y + d[1];
      const out = !inGrid(ax, ay);
      const free = out || !used.has(ay * n + ax);
      const sides = (
        d[0]
          ? [
              [0, 1],
              [0, -1],
            ]
          : [
              [1, 0],
              [-1, 0],
            ]
      ).filter(
        ([a, b]) =>
          inGrid(x + (a as number), y + (b as number)) &&
          !used.has((y + (b as number)) * n + x + (a as number)),
      ) as [number, number][];
      const owed = BEAM_TURNS[tier] - solution.size;
      const turn = sides.length > 0 && (!free || (out && owed > 0) || (owed > 0 && rng() < 0.42));
      if (turn) {
        const nd = sides[ri(rng, sides.length)] as [number, number];
        const slash = reflect("/", d);
        solution.set(here, slash[0] === nd[0] && slash[1] === nd[1] ? "/" : "\\");
        d = nd;
      } else if (!free) {
        break;
      } else if (out) {
        done = owed <= 0 && path.length >= n * 2;
        break;
      }
      x += d[0];
      y += d[1];
    }
    if (!done) continue;
    // the panels: straight cells of the path, one in each stretch of it, the last near its end
    const straight = path.slice(1).filter((c) => !solution.has(c));
    const k = BEAM_PANELS[tier];
    if (straight.length < k * 2) continue;
    const panels: number[] = [];
    for (let i = 0; i < k; i++) {
      const from = Math.floor((straight.length * i) / k);
      const to = Math.floor((straight.length * (i + 1)) / k);
      panels.push(straight[from + ri(rng, to - from)] as number);
    }
    // the path's mirrors start wrong, at least MIN_BEAM_FLIPS of them; decoys fill the rest
    const mirrors = new Map<number, Mirror>();
    shuffle(rng, [...solution.keys()]).forEach((c, i) => {
      const m = solution.get(c) as Mirror;
      mirrors.set(c, i < MIN_BEAM_FLIPS[tier] || rng() < 0.5 ? turned(m) : m);
    });
    const onPath = new Set(path);
    const off = shuffle(
      rng,
      [...Array(n * n).keys()].filter((c) => !onPath.has(c)),
    );
    for (const c of off.slice(0, BEAM_DECOYS[tier])) mirrors.set(c, rng() < 0.5 ? "/" : "\\");
    return { n, row, panels, mirrors, solution };
  }
  return null;
}

/**
 * Fewest mirror turns that send the beam through every panel, up to `cap`: follow the beam and,
 * at each mirror it meets for the first time, try it as it stands and turned.
 */
export function beamMinFlips(
  p: Pick<BeamPuzzle, "n" | "row" | "panels" | "mirrors">,
  cap = Number.POSITIVE_INFINITY,
): number {
  const { n } = p;
  const bit = new Map(p.panels.map((c, i) => [c, 1 << i]));
  const all = (1 << p.panels.length) - 1;
  const chosen = new Map<number, Mirror>();
  let best = cap;
  const run = (x0: number, y0: number, dx0: number, dy0: number, lit0: number, cost: number) => {
    if (cost >= best) return;
    let x = x0;
    let y = y0;
    let dx = dx0;
    let dy = dy0;
    let lit = lit0;
    for (let guard = 0; guard < n * n * 4; guard++) {
      x += dx;
      y += dy;
      if (x < 0 || y < 0 || x >= n || y >= n) {
        if (lit === all) best = cost;
        return;
      }
      const c = y * n + x;
      lit |= bit.get(c) ?? 0;
      const start = p.mirrors.get(c);
      if (!start) continue;
      const set = chosen.get(c);
      if (set) {
        [dx, dy] = reflect(set, [dx, dy]);
        continue;
      }
      for (const m of [start, turned(start)]) {
        chosen.set(c, m);
        const [ndx, ndy] = reflect(m, [dx, dy]);
        run(x, y, ndx, ndy, lit, cost + (m === start ? 0 : 1));
        chosen.delete(c);
      }
      return;
    }
  };
  run(-1, p.row, 1, 0, 0, 0);
  return best;
}

/**
 * The quick idea: follow the beam and, at each mirror met for the first time, send it where it
 * looks best — into a dark panel straight ahead, else towards the nearest dark panel. True when
 * that alone lights them all: the board asks for no planning.
 */
export function beamGreedy(p: Pick<BeamPuzzle, "n" | "row" | "panels" | "mirrors">): boolean {
  const { n } = p;
  const panels = new Set(p.panels);
  const lit = new Set<number>();
  const chosen = new Map<number, Mirror>();
  const inGrid = (a: number, b: number) => a >= 0 && b >= 0 && a < n && b < n;
  const promise = (x: number, y: number, [dx, dy]: [number, number]) => {
    if (!inGrid(x + dx, y + dy)) return 1000; // out of the board
    for (let ax = x + dx, ay = y + dy; inGrid(ax, ay); ax += dx, ay += dy) {
      const c = ay * n + ax;
      if (panels.has(c) && !lit.has(c)) return 0;
      if (p.mirrors.has(c)) break;
    }
    let near = 100;
    for (const c of panels)
      if (!lit.has(c))
        near = Math.min(
          near,
          Math.abs((c % n) - (x + dx)) + Math.abs(Math.floor(c / n) - (y + dy)),
        );
    return 1 + near;
  };
  let x = -1;
  let y = p.row;
  let d: [number, number] = [1, 0];
  for (let guard = 0; guard < n * n * 4; guard++) {
    x += d[0];
    y += d[1];
    if (!inGrid(x, y)) break;
    const c = y * n + x;
    if (panels.has(c)) lit.add(c);
    const start = p.mirrors.get(c);
    if (!start) continue;
    let m = chosen.get(c);
    if (!m) {
      const other = turned(start);
      m = promise(x, y, reflect(other, d)) < promise(x, y, reflect(start, d)) ? other : start;
      chosen.set(c, m);
    }
    d = reflect(m, d);
  }
  return lit.size === panels.size;
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

// ── «Запобіжник»: stop the swinging needle in its zone, every time in a row ─────────────────

/** Hits in a row it takes, per tier: a miss burns the fuse and the run starts over. */
export const FUSE_HITS = [3, 4, 5] as const;
/** The needle swings this much faster after every hit. */
export const FUSE_SPEEDUP = 0.15;

export type FusePuzzle = { zones: [number, number][]; speed: number; phase: number };

export function fusePuzzle(rng: Rng, tier: Tier): FusePuzzle {
  const base = [0.2, 0.15, 0.11][tier] as number;
  const zones = [...Array(FUSE_HITS[tier]).keys()].map((i): [number, number] => {
    const w = base * (1 - i * 0.08); // each one narrower
    const c = w / 2 + rng() * (1 - w);
    return [c - w / 2, c + w / 2];
  });
  return { zones, speed: [1.6, 2.0, 2.5][tier] as number, phase: rng() * Math.PI * 2 };
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

// ── «Тривожна валізка»: pack the emergency bag full, every item inside ───────────────────────

export type PackKind =
  | "docs"
  | "candle"
  | "torch"
  | "bank"
  | "aid"
  | "water"
  | "radio"
  | "food"
  | "blanket"
  | "clothes"
  | "sleep"
  | "cash"
  | "thermos"
  | "book"
  | "plug";
/** Items by how many cells they take. */
const PACK_ITEMS: Record<number, [PackKind, string][]> = {
  2: [
    ["docs", "Документи"],
    ["candle", "Свічки"],
    ["cash", "Гроші"],
  ],
  3: [
    ["torch", "Ліхтарик"],
    ["bank", "Павербанк"],
    ["aid", "Аптечка"],
    ["plug", "Зарядка"],
  ],
  4: [
    ["water", "Вода"],
    ["radio", "Радіо"],
    ["food", "Їжа"],
    ["thermos", "Термос"],
    ["book", "Книжка"],
  ],
  6: [
    ["blanket", "Ковдра"],
    ["clothes", "Одяг"],
    ["sleep", "Спальник"],
  ],
};
/** The only shapes items come in: plain bars and blocks, and L corners. */
const PACK_SHAPES = {
  bar2: [
    [0, 0],
    [0, 1],
  ],
  bar3: [
    [0, 0],
    [0, 1],
    [0, 2],
  ],
  corner3: [
    [0, 0],
    [1, 0],
    [1, 1],
  ],
  bar4: [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
  ],
  block4: [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ],
  l4: [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
  ],
  j4: [
    [0, 1],
    [1, 1],
    [2, 1],
    [2, 0],
  ],
  block6: [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 1],
    [1, 2],
  ],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;
type PackShape = keyof typeof PACK_SHAPES;

/** Which of the plain shapes an item has, whichever way it is turned; null for any other. */
export function packShapeOf(cells: readonly (readonly [number, number])[]): PackShape | null {
  const key = (c: readonly (readonly [number, number])[]) => JSON.stringify(packNormal(c));
  const mine = new Set(packTurns(cells).map(key));
  for (const [name, shape] of Object.entries(PACK_SHAPES))
    if (mine.has(key(shape))) return name as PackShape;
  return null;
}
/** The bag (a box less some corners), the shapes its items may have and how many, per tier. */
const PACK_SIZES: readonly {
  w: number;
  h: number;
  corners: number;
  shapes: readonly PackShape[];
  items: readonly [number, number];
}[] = [
  {
    w: 4,
    h: 3,
    corners: 0,
    shapes: ["bar2", "bar3", "corner3", "block4", "l4", "j4"],
    items: [4, 4],
  },
  {
    w: 5,
    h: 4,
    corners: 2,
    shapes: ["bar3", "corner3", "bar4", "block4", "l4", "j4"],
    items: [5, 5],
  },
  {
    w: 6,
    h: 5,
    corners: 3,
    shapes: ["bar3", "corner3", "bar4", "block4", "l4", "j4", "block6"],
    items: [6, 7],
  },
];

export type PackPiece = { kind: PackKind; name: string; cells: [row: number, col: number][] };
export type PackPuzzle = {
  w: number;
  h: number;
  /** Cells of the bag, r * w + c; the rest of the w × h box is outside it. */
  bag: number[];
  /** As they lie next to the bag: turned any way. */
  pieces: PackPiece[];
  /** The packing it was cut from: which piece fills each bag cell. */
  cut: Map<number, number>;
};

/** Cells of a shape moved to start at row 0, column 0, in reading order. */
export function packNormal(cells: readonly (readonly [number, number])[]): [number, number][] {
  const r0 = Math.min(...cells.map(([r]) => r));
  const c0 = Math.min(...cells.map(([, c]) => c));
  return cells
    .map(([r, c]) => [r - r0, c - c0] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** A quarter turn clockwise. */
export const packTurn = (cells: readonly (readonly [number, number])[]): [number, number][] =>
  packNormal(cells.map(([r, c]) => [c, -r] as [number, number]));

const shapeKey = (cells: readonly (readonly [number, number])[]) =>
  cells.map(([r, c]) => `${r}.${c}`).join(" ");

/** The distinct turns of a shape. */
function packTurns(cells: readonly (readonly [number, number])[]): [number, number][][] {
  const out: [number, number][][] = [];
  let s = packNormal(cells);
  for (let i = 0; i < 4; i++) {
    if (!out.some((o) => shapeKey(o) === shapeKey(s))) out.push(s);
    s = packTurn(s);
  }
  return out;
}

/**
 * The bag filled at random with items of the given shapes, at most `most` of them (the first empty
 * cell takes a shape that fits, backing off when stuck); the items' cells, or none.
 */
function packTile(
  rng: Rng,
  w: number,
  h: number,
  bag: readonly number[],
  shapes: readonly PackShape[],
  most: number,
): [number, number][][] | null {
  const inBag = new Set(bag);
  const turns = shapes.flatMap((name) => packTurns(PACK_SHAPES[name]));
  const biggest = Math.max(...turns.map((t) => t.length));
  const order = [...bag].sort((x, y) => x - y);
  const filled = new Set<number>();
  const items: [number, number][][] = [];
  let budget = 4000;
  const go = (): boolean => {
    if (budget-- <= 0) return false;
    const first = order.find((c) => !filled.has(c));
    if (first === undefined) return true;
    // what is left cannot be filled with the items still allowed
    if (order.length - filled.size > (most - items.length) * biggest) return false;
    const fr = Math.floor(first / w);
    const fc = first % w;
    // bigger shapes first more often: fewer, plainer items
    const tries = turns
      .map((t) => ({ t, key: t.length + rng() * 3 }))
      .sort((a, b) => b.key - a.key)
      .map(({ t }) => t);
    for (const shape of tries) {
      const [r0, c0] = shape[0] as [number, number];
      const cells = shape.map(([r, c]) => [fr + r - r0, fc + c - c0] as [number, number]);
      if (
        !cells.every(
          ([r, c]) =>
            r >= 0 && r < h && c >= 0 && c < w && inBag.has(r * w + c) && !filled.has(r * w + c),
        )
      )
        continue;
      for (const [r, c] of cells) filled.add(r * w + c);
      items.push(cells);
      if (go()) return true;
      items.pop();
      for (const [r, c] of cells) filled.delete(r * w + c);
    }
    return false;
  };
  return go() ? items : null;
}

/**
 * A bag filled with items of simple shapes, each handed over turned at random. Kept when it
 * packs in at most MAX_PACK_SOLUTIONS ways (alike items swapped count once): a puzzle, not a heap.
 */
export function packPuzzle(rng: Rng, tier: Tier): PackPuzzle {
  const s = PACK_SIZES[tier] as (typeof PACK_SIZES)[number];
  let best: { p: PackPuzzle; ways: number } | null = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    const all = [...Array(s.w * s.h).keys()];
    const corners = shuffle(rng, [0, s.w - 1, s.w * (s.h - 1), s.w * s.h - 1]).slice(0, s.corners);
    const bag = all.filter((c) => !corners.includes(c));
    const tiled = packTile(rng, s.w, s.h, bag, s.shapes, s.items[1]);
    if (!tiled || tiled.length < s.items[0]) continue;
    // a name of its own for every item: no more items of a size than names for it
    const count = new Map<number, number>();
    for (const cells of tiled) count.set(cells.length, (count.get(cells.length) ?? 0) + 1);
    if ([...count].some(([size, n]) => n > (PACK_ITEMS[size]?.length ?? 0))) continue;
    const left = new Map(
      Object.entries(PACK_ITEMS).map(([size, list]) => [Number(size), shuffle(rng, list)]),
    );
    const named = tiled.map((cells) => {
      const names = left.get(cells.length) as [PackKind, string][];
      const [kind, name] = names.pop() as [PackKind, string];
      let shape = packNormal(cells);
      for (let t = ri(rng, 4); t > 0; t--) shape = packTurn(shape);
      return { piece: { kind, name, cells: shape }, cells };
    });
    const order = shuffle(rng, [...named.keys()]);
    const pieces = order.map((i) => (named[i] as (typeof named)[number]).piece);
    const cut = new Map<number, number>();
    order.forEach((i, at) => {
      for (const [r, c] of (named[i] as (typeof named)[number]).cells) cut.set(r * s.w + c, at);
    });
    const p: PackPuzzle = { w: s.w, h: s.h, bag, pieces, cut };
    const ways = packSolutions(p, MAX_PACK_SOLUTIONS[tier] + 1);
    if (ways <= MAX_PACK_SOLUTIONS[tier]) return p;
    if (!best || ways < best.ways) best = { p, ways };
  }
  return (best as { p: PackPuzzle }).p;
}

/** Ways to pack the bag full, up to `stopAt`; items of the same shape swapped count once. */
export function packSolutions(p: Pick<PackPuzzle, "w" | "h" | "bag" | "pieces">, stopAt = 1000) {
  const { w, h } = p;
  const bag = new Set(p.bag);
  const turns = p.pieces.map((piece) => packTurns(piece.cells));
  const shapes = turns.map((t) => t.map(shapeKey).sort()[0]);
  const order = [...p.bag].sort((a, b) => a - b);
  const filled = new Set<number>();
  const used = p.pieces.map(() => false);
  let count = 0;
  const go = () => {
    if (count >= stopAt) return;
    const first = order.find((c) => !filled.has(c));
    if (first === undefined) {
      count++;
      return;
    }
    const fr = Math.floor(first / w);
    const fc = first % w;
    for (let i = 0; i < turns.length; i++) {
      if (used[i]) continue;
      // an item like one already tried here gives the same packings again
      if (shapes.findIndex((s, j) => !used[j] && s === shapes[i]) !== i) continue;
      for (const shape of turns[i] as [number, number][][]) {
        const [r0, c0] = shape[0] as [number, number];
        const cells: number[] = [];
        for (const [r, c] of shape) {
          const rr = fr + r - r0;
          const cc = fc + c - c0;
          const cell = rr * w + cc;
          if (rr < 0 || rr >= h || cc < 0 || cc >= w || !bag.has(cell) || filled.has(cell)) break;
          cells.push(cell);
        }
        if (cells.length !== shape.length) continue;
        for (const c of cells) filled.add(c);
        used[i] = true;
        go();
        used[i] = false;
        for (const c of cells) filled.delete(c);
      }
    }
  };
  go();
  return count;
}

// ── «Батарейки по зарядках»: sort the batteries so each charger holds one kind ──────────────

export const BATTERY_KINDS = ["AA", "AAA", "C", "D", "9V"] as const;
export const BATTERY_CAP = 4;
export type BatteryPuzzle = { cap: number; stacks: number[][] };

/** How many batteries go from one charger onto another (the same kind on top, while room). */
export function batteryPour(stacks: readonly (readonly number[])[], from: number, to: number) {
  const a = stacks[from] as readonly number[];
  const b = stacks[to] as readonly number[];
  if (from === to || a.length === 0 || b.length >= BATTERY_CAP) return 0;
  const top = a[a.length - 1] as number;
  if (b.length > 0 && b[b.length - 1] !== top) return 0;
  let run = 1;
  while (run < a.length && a[a.length - 1 - run] === top) run++;
  return Math.min(run, BATTERY_CAP - b.length);
}

const full = (s: readonly number[]) => s.length === BATTERY_CAP && s.every((k) => k === s[0]);

export const batterySorted = (stacks: readonly (readonly number[])[]): boolean =>
  stacks.every((s) => s.length === 0 || full(s));

/**
 * Fewest pours to sort them (breadth first over the chargers' states), −1 when more than `limit`
 * states had to be seen, Infinity when it cannot be done.
 */
export function batteryMinMoves(p: BatteryPuzzle, limit = 150_000): number {
  const key = (st: number[][]) =>
    st
      .map((s) => s.join(""))
      .sort()
      .join("|");
  const seen = new Set([key(p.stacks)]);
  let level = [p.stacks.map((s) => [...s])];
  for (let moves = 0; level.length > 0; moves++) {
    const next: number[][][] = [];
    for (const st of level) {
      if (batterySorted(st)) return moves;
      for (let a = 0; a < st.length; a++) {
        const from = st[a] as number[];
        if (from.length === 0 || full(from)) continue;
        for (let b = 0; b < st.length; b++) {
          const n = batteryPour(st, a, b);
          if (n === 0) continue;
          // the whole charger onto an empty one changes nothing
          if (n === from.length && (st[b] as number[]).length === 0) continue;
          const moved = st.map((s) => [...s]);
          const lift = (moved[a] as number[]).splice(from.length - n, n);
          (moved[b] as number[]).push(...lift);
          const k = key(moved);
          if (seen.has(k)) continue;
          seen.add(k);
          if (seen.size > limit) return -1;
          next.push(moved);
        }
      }
    }
    level = next;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Kinds of batteries (4 each) mixed over as many chargers, two chargers empty. Kept when the
 * fewest pours that sort them reach MIN_BATTERY_MOVES.
 */
export function batteryPuzzle(rng: Rng, tier: Tier): BatteryPuzzle {
  const kinds = [3, 4, 5][tier] as number;
  let best: { p: BatteryPuzzle; moves: number } | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const all = shuffle(
      rng,
      [...Array(kinds).keys()].flatMap((k) => Array<number>(BATTERY_CAP).fill(k)),
    );
    const stacks = [...Array(kinds).keys()].map((i) =>
      all.slice(i * BATTERY_CAP, (i + 1) * BATTERY_CAP),
    );
    if (stacks.some(full)) continue;
    stacks.push([], []);
    const p = { cap: BATTERY_CAP, stacks };
    const moves = batteryMinMoves(p);
    if (moves === Number.POSITIVE_INFINITY) continue;
    // too many states to count means plenty of pours
    const score = moves < 0 ? 99 : moves;
    if (score >= MIN_BATTERY_MOVES[tier]) return p;
    if (!best || score > best.moves) best = { p, moves: score };
  }
  return (best as { p: BatteryPuzzle }).p;
}

// ── «Точна напруга»: numbered blocks from the generator to the lamp, exactly what it needs ────

/**
 * A cell of the board: free for a block, locked, or fixed in place — the generator (one port),
 * the lamp (one port), a numbered block of its own. `ports`: the sides a cell joins, as in
 * «Ланцюг» (N E S W bits).
 */
export type VoltCell =
  | { kind: "free" }
  | { kind: "lock" }
  | { kind: "source"; ports: number }
  | { kind: "lamp"; ports: number }
  | { kind: "block"; ports: number; value: number };
/** A block one lays: a straight wire or a corner, and the number it adds (or takes away). */
export type VoltBlock = { ports: number; value: number };
export type VoltPuzzle = {
  /** A square board, n × n. */
  n: number;
  cells: VoltCell[];
  /** The voltage the lamp needs. */
  target: number;
  /** The blocks next to the board, each turned some way; above the easy floors, not all needed. */
  blocks: VoltBlock[];
  /** How it was made: which block lies on which free cell, turned how. */
  solution: { block: number; cell: number; ports: number }[];
};
/** Where the current went from the generator: the cells in order, what the blocks added. */
export type VoltTrace = { path: number[]; sum: number; lit: boolean };

/** A straight wire's two turns, a corner's four. */
export const VOLT_STRAIGHT: readonly number[] = [E | W, N | S];
export const VOLT_CORNER: readonly number[] = [N | E, E | S, S | W, W | N];

/**
 * Per tier: the board, the wire's run (cells), fixed blocks on it and off it, locked cells, blocks
 * handed over not needed.
 */
export const VOLT_SIZES = [
  { n: 4, len: [4, 6], fixed: 1, fixedOff: 0, locks: 1, spare: 1 },
  { n: 5, len: [5, 8], fixed: 1, fixedOff: 1, locks: 2, spare: 2 },
  { n: 5, len: [7, 10], fixed: 2, fixedOff: 1, locks: 2, spare: 3 },
] as const;
/** What a block may carry: on the easy floors only additions, higher up some that take away. */
const VOLT_VALUES = [
  [1, 2, 3],
  [-2, -1, 1, 2, 3],
  [-3, -2, -1, 1, 2, 3, 4],
] as const;
/** Above the easy floors the lamp needs 1–9. */
export const VOLT_TARGET = [1, 9] as const;

/** The other turns of the same kind of wire: straight stays straight, a corner a corner. */
export const voltTurns = (ports: number): readonly number[] =>
  VOLT_STRAIGHT.includes(ports) ? VOLT_STRAIGHT : VOLT_CORNER;

/**
 * Where the current goes: out of the generator's port, into each next cell joined back to it and
 * out of its other side, adding the numbers of the blocks it runs through (fixed ones and those
 * laid) — until the lamp, or a side nothing joins. `laid`: free cell → the block on it.
 */
export function voltTrace(
  p: Pick<VoltPuzzle, "n" | "cells">,
  laid: ReadonlyMap<number, VoltBlock>,
): VoltTrace {
  const { n, cells } = p;
  const portsOf = (i: number) => {
    const c = cells[i];
    if (!c || c.kind === "lock") return 0;
    return c.kind === "free" ? (laid.get(i)?.ports ?? 0) : c.ports;
  };
  const source = cells.findIndex((c) => c.kind === "source");
  const path = [source];
  let sum = 0;
  let at = source;
  let came = 0;
  for (let guard = 0; guard < n * n; guard++) {
    const out = portsOf(at) & ~came;
    const dir = DIRS.find(([, , bit]) => out & bit);
    if (!dir) break;
    const [dx, dy, , back] = dir;
    const x = (at % n) + dx;
    const y = Math.floor(at / n) + dy;
    if (x < 0 || y < 0 || x >= n || y >= n) break;
    const next = y * n + x;
    if (!(portsOf(next) & back) || path.includes(next)) break;
    path.push(next);
    const c = cells[next] as VoltCell;
    if (c.kind === "lamp") return { path, sum, lit: true };
    sum += c.kind === "block" ? c.value : (laid.get(next)?.value ?? 0);
    at = next;
    came = back;
  }
  return { path, sum, lit: false };
}

/** The side of `a` that faces `b`, a neighbour. */
function voltSide(n: number, a: number, b: number): number {
  const dx = (b % n) - (a % n);
  const dy = Math.floor(b / n) - Math.floor(a / n);
  return (DIRS.find(([x, y]) => x === dx && y === dy) as Dir)[2];
}

/** A cell on the board's edge (not a corner) facing in: the cell, its port, the one inside. */
function voltEdge(rng: Rng, n: number): [cell: number, port: number, inner: number] {
  const k = 1 + ri(rng, n - 2);
  const side = ri(rng, 4);
  if (side === 0) return [k, S, n + k];
  if (side === 1) return [k * n + n - 1, W, k * n + n - 2];
  if (side === 2) return [(n - 1) * n + k, N, (n - 2) * n + k];
  return [k * n, E, k * n + 1];
}

/** A run of `len` cells from `a` to `b`, wandering, keeping off `avoid`; or none. */
function voltRun(rng: Rng, n: number, a: number, b: number, len: number, avoid: Set<number>) {
  const dist = (cell: number) =>
    Math.abs(Math.floor(cell / n) - Math.floor(b / n)) + Math.abs((cell % n) - (b % n));
  const run = [a];
  const seen = new Set([...avoid, a]);
  let budget = 4000;
  const go = (): boolean => {
    if (budget-- <= 0) return false;
    const cell = run[run.length - 1] as number;
    if (run.length === len) return cell === b;
    if (cell === b) return false;
    for (const [dx, dy] of shuffle(rng, DIRS)) {
      const x = (cell % n) + dx;
      const y = Math.floor(cell / n) + dy;
      const next = y * n + x;
      if (x < 0 || y < 0 || x >= n || y >= n || seen.has(next)) continue;
      // still able to reach the lamp in the steps left
      if (dist(next) > len - run.length - 1) continue;
      seen.add(next);
      run.push(next);
      if (go()) return true;
      run.pop();
      seen.delete(next);
    }
    return false;
  };
  return go() ? run : null;
}

/**
 * The generator and the lamp on the board's edge, a wire's run between them made of numbered
 * blocks whose numbers add up to what the lamp needs: some of them fixed on the board (one builds
 * round them), the rest handed over — with more next to them: alike in shape but numbered otherwise,
 * so one chooses by the number. Above the easy floors some numbers take away; fixed blocks off the
 * run stand as temptations or in the way, and some cells are locked.
 */
export function voltPuzzle(rng: Rng, tier: Tier): VoltPuzzle {
  const s = VOLT_SIZES[tier] as (typeof VOLT_SIZES)[number];
  const { n } = s;
  const values = VOLT_VALUES[tier] as readonly number[];
  const pick = () => values[ri(rng, values.length)] as number;
  for (;;) {
    const [source, sourcePort, a] = voltEdge(rng, n);
    const [lamp, lampPort, b] = voltEdge(rng, n);
    if (lamp === source || a === b || a === lamp || b === source) continue;
    const least = Math.abs(Math.floor(a / n) - Math.floor(b / n)) + Math.abs((a % n) - (b % n)) + 1;
    const lengths: number[] = [];
    for (let len = s.len[0]; len <= s.len[1]; len++)
      if (len >= least && (len - least) % 2 === 0) lengths.push(len);
    if (lengths.length === 0) continue;
    const run = voltRun(
      rng,
      n,
      a,
      b,
      lengths[ri(rng, lengths.length)] as number,
      new Set([source, lamp]),
    );
    if (!run) continue;
    // each cell of the run joins the one before it and the one after
    const ports = run.map(
      (cell, i) =>
        voltSide(n, cell, i === 0 ? source : (run[i - 1] as number)) |
        voltSide(n, cell, i === run.length - 1 ? lamp : (run[i + 1] as number)),
    );
    // the run's numbers: on the easy floors any, the lamp needing their sum; above, some negative
    // and the lamp needing 1–9
    let vals: number[] = [];
    for (let v = 0; v < 40 && vals.length === 0; v++) {
      const tried = run.map(pick);
      const sum = tried.reduce((x, y) => x + y, 0);
      if (
        tier === 0 ||
        (tried.some((x) => x < 0) && sum >= VOLT_TARGET[0] && sum <= VOLT_TARGET[1])
      )
        vals = tried;
    }
    if (vals.length === 0) continue;
    const target = vals.reduce((x, y) => x + y, 0);
    // fixed blocks on the run, off its ends (the current would read them at once)
    const inner = shuffle(
      rng,
      run.map((_, i) => i).filter((i) => i > 0 && i < run.length - 1),
    );
    if (inner.length < s.fixed) continue;
    const fixed = inner.slice(0, s.fixed);
    const cells: VoltCell[] = Array.from({ length: n * n }, () => ({ kind: "free" }));
    cells[source] = { kind: "source", ports: sourcePort };
    cells[lamp] = { kind: "lamp", ports: lampPort };
    for (const i of fixed)
      cells[run[i] as number] = {
        kind: "block",
        ports: ports[i] as number,
        value: vals[i] as number,
      };
    // off the run: fixed blocks near it first, then locked cells
    const onRun = new Set(run);
    const near = (cell: number) =>
      run.some(
        (r) =>
          Math.abs(Math.floor(r / n) - Math.floor(cell / n)) + Math.abs((r % n) - (cell % n)) === 1,
      );
    const off = shuffle(
      rng,
      cells.map((_, i) => i).filter((i) => !onRun.has(i) && cells[i]?.kind === "free"),
    ).sort((x, y) => Number(near(y)) - Number(near(x)));
    for (const cell of off.slice(0, s.fixedOff))
      cells[cell] = { kind: "block", ports: VOLT_STRAIGHT[ri(rng, 2)] as number, value: pick() };
    for (const cell of shuffle(rng, off.slice(s.fixedOff)).slice(0, s.locks))
      cells[cell] = { kind: "lock" };
    // the blocks one gets: those of the run, and spares shaped like some of them, numbered otherwise
    const needed = run.flatMap((cell, i) =>
      fixed.includes(i) ? [] : [{ cell, ports: ports[i] as number, value: vals[i] as number }],
    );
    const spares = shuffle(rng, needed)
      .slice(0, s.spare)
      .map((like) => {
        let value = pick();
        while (value === like.value) value = pick();
        return { ports: like.ports, value };
      });
    const all = [...needed.map(({ ports: q, value }) => ({ ports: q, value })), ...spares];
    const order = shuffle(rng, [...all.keys()]);
    const blocks = order.map((i) => {
      const block = all[i] as VoltBlock;
      const turns = voltTurns(block.ports);
      return { ports: turns[ri(rng, turns.length)] as number, value: block.value };
    });
    const solution = needed.map((x, i) => ({
      block: order.indexOf(i),
      cell: x.cell,
      ports: x.ports,
    }));
    const p: VoltPuzzle = { n, cells, target, blocks, solution };
    const laid = new Map(
      solution.map((x) => [
        x.cell,
        { ports: x.ports, value: (blocks[x.block] as VoltBlock).value },
      ]),
    );
    const trace = voltTrace(p, laid);
    if (!trace.lit || trace.sum !== target) continue;
    return p;
  }
}

// ── «Пазл»: a picture cut into knobbed pieces, put back together ────────────────────────────────

/** A shape of the picture (its coordinates on a JIGSAW_SIZE square). */
export type ArtShape =
  | {
      kind: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      fill: string;
      rx?: number;
      opacity?: number;
    }
  | { kind: "circle"; cx: number; cy: number; r: number; fill: string; opacity?: number }
  | { kind: "path"; d: string; fill: string; stroke?: string; width?: number; opacity?: number };
/** An edge between two pieces: which way its knob bulges (0: the board's edge, flat), nudged. */
export type JigsawEdge = { knob: -1 | 0 | 1; shift: number; scale: number };
/** What a picture can be of. */
export const JIGSAW_SCENES = ["street", "village", "pylons", "candle", "winter"] as const;
export type JigsawScene = (typeof JIGSAW_SCENES)[number];
export type JigsawPuzzle = {
  /** The pieces in a square, n × n. */
  n: number;
  /** The picture: what it is of, its background (top colour, bottom colour), what is in it. */
  scene: JigsawScene;
  sky: [string, string];
  art: ArtShape[];
  /** Edges across the board, n + 1 lines of n; down it, n lines of n + 1. */
  across: JigsawEdge[][];
  down: JigsawEdge[][];
  /** The order the pieces lie in next to the board. */
  order: number[];
};

/** The picture's side. */
export const JIGSAW_SIZE = 300;
/** Pieces in a row, per tier. */
export const JIGSAW_GRID = [4, 5, 6] as const;

/**
 * A knob along an edge from (0, 0) to (1, 0), bulging towards +v: the points of the cubic curves
 * one after another (a straight stretch, the neck, the head, the neck, a straight stretch).
 */
const KNOB: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.12, 0],
  [0.24, 0],
  [0.36, 0],
  [0.42, 0],
  [0.44, 0.04],
  [0.41, 0.09],
  [0.36, 0.17],
  [0.42, 0.25],
  [0.5, 0.25],
  [0.58, 0.25],
  [0.64, 0.17],
  [0.59, 0.09],
  [0.56, 0.04],
  [0.58, 0],
  [0.64, 0],
  [0.76, 0],
  [0.88, 0],
  [1, 0],
];

/**
 * An edge's points (cubic curves in turn) on the picture: across the board from left to right
 * (the line above row `r`, column `c`), or down it from top to bottom (the line left of column
 * `c`, row `r`). A knob of +1 bulges down (across) or right (down).
 */
export function jigsawEdge(
  p: Pick<JigsawPuzzle, "n" | "across" | "down">,
  dir: "across" | "down",
  r: number,
  c: number,
): [number, number][] {
  const s = JIGSAW_SIZE / p.n;
  const e = (dir === "across" ? p.across[r]?.[c] : p.down[r]?.[c]) as JigsawEdge;
  return KNOB.map(([u, v], k) => {
    const along = k === 0 || k === KNOB.length - 1 ? u : u + e.shift;
    const off = v * e.scale * e.knob;
    return dir === "across" ? [(c + along) * s, (r + off) * s] : [(c + off) * s, (r + along) * s];
  });
}

/** Piece `i`'s outline on the picture (row by row): its four edges round, clockwise. */
export function jigsawOutline(p: Pick<JigsawPuzzle, "n" | "across" | "down">, i: number): string {
  const r = Math.floor(i / p.n);
  const c = i % p.n;
  const points = [
    ...jigsawEdge(p, "across", r, c),
    ...jigsawEdge(p, "down", r, c + 1).slice(1),
    ...jigsawEdge(p, "across", r + 1, c)
      .reverse()
      .slice(1),
    ...jigsawEdge(p, "down", r, c).reverse().slice(1),
  ];
  const f = ([x, y]: [number, number]) => `${+x.toFixed(2)} ${+y.toFixed(2)}`;
  let d = `M${f(points[0] as [number, number])}`;
  for (let k = 1; k + 2 < points.length; k += 3)
    d += `C${f(points[k] as [number, number])} ${f(points[k + 1] as [number, number])} ${f(points[k + 2] as [number, number])}`;
  return `${d}Z`;
}

// ── the rules: a piece lies on any cell; those lying next to each other as in the picture join ──

/** Round a cell: up, down, left, right (rows, columns). */
const AROUND = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

/** Which piece lies on each cell (`at`: the cell each piece lies on, row by row, or null). */
function jigsawLying(at: readonly (number | null)[]) {
  const on = new Map<number, number>();
  at.forEach((cell, j) => {
    if (cell !== null) on.set(cell, j);
  });
  return on;
}

/**
 * The pieces joined with piece `i` (`at`: the cell each piece lies on, row by row, or null if it
 * is off the board): those lying next to it the way they are in the picture, theirs in turn.
 */
export function jigsawGroup(n: number, at: readonly (number | null)[], i: number): number[] {
  if (at[i] === null || at[i] === undefined) return [i];
  const inside = (r: number, c: number) => r >= 0 && r < n && c >= 0 && c < n;
  const on = jigsawLying(at);
  const group = [i];
  const seen = new Set(group);
  for (let k = 0; k < group.length; k++) {
    const j = group[k] as number;
    const cell = at[j] as number;
    for (const [dr, dc] of AROUND) {
      const r = Math.floor(j / n) + dr;
      const c = (j % n) + dc;
      const R = Math.floor(cell / n) + dr;
      const C = (cell % n) + dc;
      if (!inside(r, c) || !inside(R, C)) continue;
      const m = on.get(R * n + C);
      if (m === r * n + c && !seen.has(m)) {
        seen.add(m);
        group.push(m);
      }
    }
  }
  return group;
}

// ── the pictures ──────────────────────────────────────────────────────────────────────────────

type Picture = { sky: [string, string]; art: ArtShape[] };

/** A number short enough for a picture. */
const tenth = (v: number) => Math.round(v * 10) / 10;
/** A path, its numbers rounded to tenths. */
const pathD = (parts: TemplateStringsArray, ...values: number[]) =>
  parts.reduce((s, part, k) => `${s}${tenth(values[k - 1] as number)}${part}`);
/** A shape through points, closed or not. */
const pathOf = (points: readonly (readonly [number, number])[], close = true) =>
  `${points.map(([x, y], k) => `${k ? "L" : "M"}${tenth(x)} ${tenth(y)}`).join("")}${close ? "Z" : ""}`;

/** What a picture is drawn with: shapes laid one over another, and its own randomness. */
function painter(rng: Rng) {
  const W = JIGSAW_SIZE;
  const art: ArtShape[] = [];
  const seen = (opacity: number) => (opacity < 1 ? { opacity: tenth(opacity * 10) / 10 } : {});
  const pick = <T>(list: readonly T[]) => list[ri(rng, list.length)] as T;
  /** Somewhere between `lo` and `hi`. */
  const span = (lo: number, hi: number) => lo + rng() * (hi - lo);
  const box = (x: number, y: number, w: number, h: number, fill: string, rx = 0, opacity = 1) => {
    art.push({
      kind: "rect",
      x: tenth(x),
      y: tenth(y),
      w: tenth(w),
      h: tenth(h),
      fill,
      ...(rx ? { rx } : {}),
      ...seen(opacity),
    });
  };
  const dot = (cx: number, cy: number, r: number, fill: string, opacity = 1) => {
    art.push({ kind: "circle", cx: tenth(cx), cy: tenth(cy), r: tenth(r), fill, ...seen(opacity) });
  };
  const fill = (d: string, color: string, opacity = 1) => {
    art.push({ kind: "path", d, fill: color, ...seen(opacity) });
  };
  const line = (d: string, stroke: string, width: number, opacity = 1) => {
    art.push({ kind: "path", d, fill: "none", stroke, width, ...seen(opacity) });
  };
  const oval = (cx: number, cy: number, rx: number, ry: number, color: string, opacity = 1) =>
    fill(
      pathD`M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`,
      color,
      opacity,
    );
  /** Stars scattered above `low`. */
  const stars = (count: number, low: number) => {
    for (let k = 0; k < count; k++)
      dot(rng() * W, rng() * low, 0.5 + rng() * 1.2, "#ffffff", 0.35 + rng() * 0.6);
  };
  /** The full moon: its halo, its face, its seas. */
  const moon = (cx: number, cy: number, r: number) => {
    dot(cx, cy, r + 12, "#f6e7b8", 0.12);
    dot(cx, cy, r, "#f6e7b8");
    for (let k = 0; k < 3; k++)
      dot(cx + (rng() - 0.5) * r, cy + (rng() - 0.5) * r, r * (0.12 + rng() * 0.12), "#e2cf98");
  };
  /** Hills along `base`, rising up to about `rise` above it, filled down to the bottom. */
  const hills = (base: number, rise: number, color: string, opacity = 1) => {
    const k = 3 + ri(rng, 3);
    let d = pathD`M0 ${base}`;
    for (let j = 1; j <= k; j++) {
      const x = (j / k) * W;
      d += pathD`Q${x - W / k / 2} ${base - rise * (0.5 + rng())} ${x} ${base + (rng() - 0.5) * rise * 0.4}`;
    }
    fill(`${d}L${W} ${W}L0 ${W}Z`, color, opacity);
  };
  return { art, pick, span, box, dot, fill, line, oval, stars, moon, hills };
}

const LIT = ["#ffcf6a", "#ffb347", "#ffe08a", "#ffd9a0"];
const STREET_SKIES: readonly [string, string][] = [
  ["#0b1430", "#3a2a5c"],
  ["#0d1b2a", "#1f4a5a"],
  ["#140f2e", "#5a2f4f"],
  ["#0a1a33", "#2d3f7a"],
];
const STREET_WALLS = ["#2e3550", "#3b2f4a", "#283a3f", "#45372c", "#3a3f52", "#4a3340"];
const STREET_BULBS = ["#ff6b6b", "#ffd93d", "#6bcb77", "#4d96ff", "#ff9a3d"];

/** A night street: the moon over a far skyline, houses lit here and there, a garland, lamps. */
function streetScene(rng: Rng): Picture {
  const W = JIGSAW_SIZE;
  const a = painter(rng);
  const sky = a.pick(STREET_SKIES);
  a.stars(42, W * 0.55);
  a.moon(a.span(40, W - 40), a.span(30, 80), a.span(18, 28));
  // the far skyline
  for (let x = -10; x < W; ) {
    const w = a.span(18, 44);
    const top = a.span(140, 210);
    a.box(x, top, w, W - top, "#1a1f31");
    x += w - 2;
  }
  // the houses near, each its own colour, their windows lit here and there
  for (let x = a.span(-6, 4); x < W; ) {
    const w = a.span(46, 80);
    const top = a.span(110, 200);
    a.box(x, top, w, W - top, a.pick(STREET_WALLS));
    // on the roof: a ledge, a water tank or an aerial
    const roof = ri(rng, 3);
    if (roof === 0) a.box(x - 2, top - 4, w + 4, 5, "#20253a");
    else if (roof === 1) a.box(x + w * 0.6, top - 14, 14, 14, "#2a2f45", 3);
    else {
      const ax = x + w * 0.3;
      a.line(pathD`M${ax} ${top}V${top - 22}M${ax - 7} ${top - 16}H${ax + 7}`, "#3a3f55", 1.6);
    }
    const cols = Math.max(2, Math.floor((w - 10) / 13));
    const gap = (w - cols * 8) / (cols + 1);
    for (let wy = top + 10; wy < W - 34; wy += 15)
      for (let k = 0; k < cols; k++)
        a.box(x + gap + k * (8 + gap), wy, 8, 9, rng() < 0.45 ? a.pick(LIT) : "#151925", 1);
    x += w + 2 + rng() * 6;
  }
  // a garland strung across the street, sagging, its bulbs of all colours
  const gy = a.span(120, 170);
  const sag = a.span(18, 40);
  a.line(pathD`M0 ${gy}Q${W / 2} ${gy + sag * 2} ${W} ${gy}`, "#0c0d12", 1.5);
  for (let k = 1; k < 14; k++) {
    const t = k / 14;
    const y = (1 - t) * (1 - t) * gy + 2 * (1 - t) * t * (gy + sag * 2) + t * t * gy;
    const bulb = STREET_BULBS[k % STREET_BULBS.length] as string;
    a.dot(W * t, y + 3, 7, bulb, 0.2);
    a.dot(W * t, y + 3, 3, bulb);
  }
  // the street, two lamps glowing over it
  a.box(0, W - 22, W, 22, "#101219");
  for (const lx of [a.span(30, 100), a.span(180, 260)]) {
    a.box(lx - 1.5, W - 70, 3, 50, "#2b2f3a");
    a.dot(lx, W - 72, 16, "#ffd27a", 0.2);
    a.dot(lx, W - 72, 4, "#ffe7b0");
  }
  return { sky, art: a.art };
}

const VILLAGE_SKIES: readonly [string, string][] = [
  ["#060a1c", "#1c2a4c"],
  ["#090d22", "#2a2246"],
  ["#050f1b", "#1a3848"],
];
const VILLAGE_WALLS = ["#3d4763", "#43405c", "#394a58"];
const VILLAGE_ROOFS = ["#2b2333", "#3a2a2a", "#26303a", "#3a3326"];
const SHUTTERS = ["#2f5a6a", "#4a6a3a", "#5a3a4a"];
const LEAVES = ["#13251b", "#17301f", "#10201a", "#1b3424"];

/**
 * A village house in the dark: the Milky Way and the crescent moon, the house with a window lit
 * and a Starlink dish on its roof, smoke from the chimney, an apple tree, sunflowers by the fence.
 */
function villageScene(rng: Rng): Picture {
  const W = JIGSAW_SIZE;
  const a = painter(rng);
  const sky = a.pick(VILLAGE_SKIES);
  // the Milky Way: a faint band across, thick with tiny stars
  const band = a.span(50, 100);
  const tilt = a.span(-40, 40);
  a.fill(
    pathOf([
      [0, band - 20 - tilt],
      [W, band - 20 + tilt],
      [W, band + 24 + tilt],
      [0, band + 24 - tilt],
    ]),
    "#c9d6ff",
    0.06,
  );
  for (let k = 0; k < 60; k++) {
    const t = rng();
    const y = band - tilt + 2 * tilt * t + (rng() - 0.5) * 44;
    a.dot(t * W, y, 0.3 + rng() * 0.6, "#e8eeff", 0.25 + rng() * 0.5);
  }
  a.stars(34, 170);
  // the house on one side, the apple tree on the other, the crescent moon above the tree
  const left = rng() < 0.5;
  const hw = a.span(122, 140);
  const hx = left ? a.span(14, 34) : W - hw - a.span(14, 34);
  const tx = left ? a.span(215, 250) : a.span(50, 85);
  const mx = tx + a.span(-20, 20);
  const my = a.span(30, 60);
  const mr = a.span(13, 18);
  a.dot(mx + mr * 0.4, my, mr + 10, "#f3e6b8", 0.1);
  a.fill(
    pathD`M${mx} ${my - mr}A${mr} ${mr} 0 1 1 ${mx} ${my + mr}A${mr * 0.6} ${mr} 0 1 0 ${mx} ${my - mr}Z`,
    "#f3e6b8",
  );
  // far hills, a far village's lights on them, poplars
  a.hills(a.span(172, 186), 30, "#141b2d");
  for (let k = 0; k < 7; k++)
    a.dot(rng() * W, a.span(184, 198), 1.1, a.pick(LIT), 0.5 + rng() * 0.5);
  for (let k = 0; k < 4; k++) {
    const px = rng() * W;
    const pb = a.span(196, 206);
    const ph = a.span(36, 60);
    a.fill(
      pathD`M${px} ${pb}Q${px - 7} ${pb - ph / 2} ${px} ${pb - ph}Q${px + 7} ${pb - ph / 2} ${px} ${pb}Z`,
      "#0b111c",
    );
  }
  a.hills(a.span(204, 214), 18, "#0f1623");
  a.box(0, 236, W, W - 236, "#0d1611");
  // the apple tree
  a.fill(
    pathOf([
      [tx - 5, 262],
      [tx - 3, 200],
      [tx - 14, 178],
      [tx - 10, 175],
      [tx, 190],
      [tx + 9, 171],
      [tx + 13, 174],
      [tx + 3, 200],
      [tx + 5, 262],
    ]),
    "#1d1510",
  );
  for (let k = 0; k < 9; k++)
    a.dot(tx + a.span(-34, 34), a.span(140, 186), a.span(14, 22), a.pick(LEAVES));
  for (let k = 0; k < 6; k++) a.dot(tx + a.span(-30, 30), a.span(145, 185), 2.3, "#8a2f2a");
  // the house: the chimney on one slope smoking, the dish on the other
  const wallTop = a.span(188, 198);
  const base = 262;
  const peakX = hx + hw / 2;
  const peakY = wallTop - a.span(46, 58);
  const eave = wallTop + 2;
  const roofAt = (x: number) => peakY + (Math.abs(x - peakX) / (hw / 2 + 10)) * (eave - peakY);
  const ds = left ? 1 : -1;
  const chx = peakX - ds * hw * 0.24;
  const chTop = roofAt(chx) - 18;
  a.box(chx - 5, chTop, 10, roofAt(chx) - chTop + 8, "#2c2830");
  a.box(chx - 7, chTop - 3, 14, 4, "#24202a");
  const drift = a.span(-6, 6);
  for (let k = 0; k < 4; k++)
    a.dot(chx + (k + 1) * drift, chTop - 8 - k * 9, 3 + k * 2, "#9aa3b5", 0.16 - k * 0.03);
  a.box(hx, wallTop, hw, base - wallTop, a.pick(VILLAGE_WALLS));
  a.box(hx - 3, base - 8, hw + 6, 8, "#262b3a");
  a.fill(
    pathOf([
      [hx - 10, eave],
      [peakX, peakY],
      [hx + hw + 10, eave],
    ]),
    a.pick(VILLAGE_ROOFS),
  );
  let tin = "";
  for (const t of [0.3, 0.55, 0.8]) {
    const half = t * (hw / 2 + 10);
    tin += pathD`M${peakX - half} ${peakY + t * (eave - peakY)}H${peakX + half}`;
  }
  a.line(tin, "#000000", 1.2, 0.25);
  // two windows with shutters, one lit or both; the door towards the yard
  const along = (t: number) => hx + (left ? t : 1 - t) * hw;
  const lit = a.pick([
    [true, false],
    [false, true],
    [true, true],
  ]);
  const shutter = a.pick(SHUTTERS);
  [0.2, 0.5].forEach((t, k) => {
    const cx = along(t);
    const wy = wallTop + 16;
    const on = lit[k];
    const glass = on ? a.pick(LIT) : "#121826";
    if (on) a.dot(cx, wy + 12, 22, glass, 0.07);
    a.box(cx - 19, wy - 1, 8, 26, shutter);
    a.box(cx + 11, wy - 1, 8, 26, shutter);
    a.box(cx - 11, wy, 22, 24, glass, 1);
    a.line(pathD`M${cx} ${wy}V${wy + 24}M${cx - 11} ${wy + 9}H${cx + 11}`, "#2a2230", 2);
    if (on)
      a.fill(
        pathOf([
          [cx - 11, base],
          [cx + 11, base],
          [cx + 26, W],
          [cx - 26, W],
        ]),
        glass,
        0.06,
      );
  });
  const dx = along(0.8);
  a.box(dx - 9, base - 48, 18, 40, "#2a2026", 2);
  a.dot(dx - ds * 5, base - 28, 1.4, "#8a7a5a");
  // the Starlink dish halfway down the other slope: a mast, a flat panel turned to the sky
  const sx = peakX + ds * hw * 0.25;
  const sy = roofAt(sx);
  a.line(pathD`M${sx} ${sy}V${sy - 13}`, "#8a93a3", 2);
  const tiltA = -ds * a.span(0.3, 0.5);
  const panel = (
    [
      [-13, -5],
      [13, -5],
      [13, 5],
      [-13, 5],
    ] as const
  ).map(
    ([u, v]) =>
      [
        sx + u * Math.cos(tiltA) - v * Math.sin(tiltA),
        sy - 19 + u * Math.sin(tiltA) + v * Math.cos(tiltA),
      ] as const,
  );
  a.fill(pathOf(panel), "#e6ebf2");
  a.line(
    pathOf([panel[3] as [number, number], panel[2] as [number, number]], false),
    "#9aa3b2",
    1.6,
  );
  a.line(pathD`M${sx} ${sy}L${peakX + ds * (hw / 2 + 2)} ${eave + 1}V${base - 30}`, "#111318", 1);
  // the sunflowers behind the fence, by the tree
  for (let k = 0; k < 3 + ri(rng, 2); k++) {
    const fx = tx + a.span(-50, 50);
    const fy = a.span(226, 242);
    a.line(pathD`M${fx} 290Q${fx + a.span(-6, 6)} ${(fy + 290) / 2} ${fx} ${fy}`, "#24361f", 2);
    for (let p = 0; p < 8; p++) {
      const ang = (p / 8) * Math.PI * 2;
      a.dot(fx + Math.cos(ang) * 7, fy + Math.sin(ang) * 7, 2.6, "#d4a22e");
    }
    a.dot(fx, fy, 5, "#3a2412");
  }
  // the fence across the yard, its gate in front of the door
  a.box(0, 258, W, 3, "#2a221b");
  a.box(0, 274, W, 3, "#2a221b");
  for (let x = -3; x < W; x += 9) {
    const top = 249 + rng() * 4;
    a.fill(
      pathOf([
        [x, 288],
        [x, top + 4],
        [x + 3, top],
        [x + 6, top + 4],
        [x + 6, 288],
      ]),
      Math.abs(x + 3 - dx) < 14 ? "#4a3a2c" : "#3a2f26",
    );
  }
  a.box(0, 288, W, 12, "#0a120d");
  for (let x = a.span(0, 8); x < W; x += a.span(8, 18))
    a.line(pathD`M${x} ${W}L${x - 2} ${W - 8}M${x} ${W}L${x + 2} ${W - 9}`, "#1c2c20", 1.2);
  // fireflies
  for (let k = 0; k < 6; k++) {
    const fx = rng() * W;
    const fy = a.span(200, 285);
    a.dot(fx, fy, 4, "#d8ff7a", 0.18);
    a.dot(fx, fy, 1.2, "#eaff9a");
  }
  return { sky, art: a.art };
}

const PYLON_SKIES: readonly [string, string][] = [
  ["#2a1838", "#f08a4b"],
  ["#1f2245", "#f2a65a"],
  ["#381a36", "#ff8a5c"],
];
const CLOUDS = ["#f6b07a", "#e98a7a", "#b0607a", "#ffd2a0"];
const FIELDS = ["#4a3a22", "#3a3424", "#5a4626", "#2f3322", "#6a5428", "#3e2e1e"];

/** A power line at sunset: towers striding off over the fields, birds on the wires, a far village. */
function pylonScene(rng: Rng): Picture {
  const W = JIGSAW_SIZE;
  const a = painter(rng);
  const sky = a.pick(PYLON_SKIES);
  const hz = a.span(204, 218);
  const flip = rng() < 0.5;
  const mirror = (x: number) => (flip ? W - x : x);
  // the sun low, its glow, streaks of cloud lit from below
  const sx = a.span(70, 230);
  const sr = a.span(20, 30);
  const sy = hz - a.span(4, 26);
  a.dot(sx, sy, sr * 2.8, "#ffd27a", 0.08);
  a.dot(sx, sy, sr * 1.7, "#ffd9a0", 0.14);
  a.dot(sx, sy, sr, "#ffe6b0");
  for (let k = 0; k < 7; k++)
    a.box(
      a.span(-40, W - 40),
      a.span(30, hz - 40),
      a.span(50, 140),
      a.span(3, 7),
      a.pick(CLOUDS),
      3,
      a.span(0.3, 0.7),
    );
  for (let k = 0; k < 5; k++) {
    const bx = a.span(20, 280);
    const by = a.span(30, 140);
    const w = a.span(3, 6);
    a.line(
      pathD`M${bx - w} ${by - w * 0.4}Q${bx - w * 0.4} ${by - w * 0.6} ${bx} ${by}Q${bx + w * 0.4} ${by - w * 0.6} ${bx + w} ${by - w * 0.4}`,
      "#2a1a2a",
      1.2,
    );
  }
  // far hills, a village on them: little houses, a window lit here and there, a church
  a.hills(hz - 2, 16, "#3a2238", 0.75);
  for (let k = 0; k < 7; k++) {
    const vx = a.span(10, 290);
    const vw = a.span(7, 13);
    const vh = a.span(5, 9);
    a.fill(
      pathOf([
        [vx, hz + 2],
        [vx, hz - vh],
        [vx + vw / 2, hz - vh - 5],
        [vx + vw, hz - vh],
        [vx + vw, hz + 2],
      ]),
      "#2a1828",
    );
    if (rng() < 0.5) a.dot(vx + vw / 2, hz - vh / 2, 1, a.pick(LIT));
  }
  const kx = a.span(30, 270);
  a.box(kx - 5, hz - 16, 10, 18, "#2a1828");
  a.dot(kx, hz - 18, 5.5, "#2a1828");
  a.line(pathD`M${kx} ${hz - 23}V${hz - 31}M${kx - 3} ${hz - 28}H${kx + 3}`, "#2a1828", 1.2);
  // the fields, their strips running off to where the sun sets, a road through them
  a.box(0, hz, W, W - hz, "#2b2620");
  for (let k = -7; k < 7; k++)
    a.fill(
      pathOf([
        [sx, hz],
        [sx + k * 46, W],
        [sx + (k + 1) * 46, W],
      ]),
      a.pick(FIELDS),
    );
  let rows = "";
  for (let k = -20; k <= 20; k++) rows += pathD`M${sx} ${hz}L${sx + k * 16} ${W}`;
  a.line(rows, "#000000", 0.6, 0.15);
  const rx = a.span(90, 210);
  const bend = (rx + sx) / 2 + a.span(-40, 40);
  const by = hz + (W - hz) * 0.55;
  a.fill(
    pathD`M${rx - 18} ${W}Q${bend - 6} ${by} ${sx - 1} ${hz}L${sx + 1} ${hz}Q${bend + 6} ${by} ${rx + 18} ${W}Z`,
    "#6a4a34",
    0.85,
  );
  // the towers: lattice legs, braces, two crossarms with the insulators hanging
  const pylon = (x: number, foot: number, top: number) => {
    const h = foot - top;
    const wb = h * 0.17;
    const wt = h * 0.035;
    const waist = top + h * 0.3;
    const half = (y: number) => wt + ((wb - wt) * (y - waist)) / (foot - waist);
    let d = pathD`M${x - wb} ${foot}L${x - wt} ${waist}L${x - wt} ${top + h * 0.06}L${x} ${top}L${x + wt} ${top + h * 0.06}L${x + wt} ${waist}L${x + wb} ${foot}`;
    for (let k = 0; k < 6; k++) {
      const y0 = foot - ((foot - waist) * k) / 6;
      const y1 = foot - ((foot - waist) * (k + 1)) / 6;
      d += pathD`M${x - half(y0)} ${y0}L${x + half(y1)} ${y1}M${x + half(y0)} ${y0}L${x - half(y1)} ${y1}M${x - half(y1)} ${y1}H${x + half(y1)}`;
    }
    const tips: [number, number][] = [];
    for (const [ay, arm] of [
      [top + h * 0.12, h * 0.2],
      [top + h * 0.26, h * 0.26],
    ] as const) {
      d += pathD`M${x - arm} ${ay}H${x + arm}M${x - arm} ${ay}L${x - wt} ${ay + h * 0.05}M${x + arm} ${ay}L${x + wt} ${ay + h * 0.05}`;
      for (const side of [-1, 1]) {
        const ix = x + side * arm * 0.92;
        d += pathD`M${ix} ${ay}V${ay + h * 0.04}`;
        tips.push([ix, ay + h * 0.04]);
      }
    }
    a.line(d, "#17121d", Math.max(0.8, h * 0.006));
    return tips;
  };
  const x1 = a.span(55, 90);
  const x2 = x1 + a.span(115, 140);
  const x3 = x2 + a.span(60, 75);
  const towers = [
    pylon(mirror(x1), W + 8, a.span(40, 62)),
    pylon(mirror(x2), hz + 30, hz - 105),
    pylon(mirror(x3), hz + 8, hz - 48),
  ];
  // the wires, sagging from tower to tower, from behind us and off into the distance
  const sagged = (p: [number, number], q: [number, number]) =>
    pathD`Q${(p[0] + q[0]) / 2} ${(p[1] + q[1]) / 2 + Math.abs(q[0] - p[0]) * 0.12} ${q[0]} ${q[1]}`;
  for (let k = 0; k < 4; k++) {
    const [p1, p2, p3] = towers.map((tips) => tips[k] as [number, number]) as [
      [number, number],
      [number, number],
      [number, number],
    ];
    const from: [number, number] = [mirror(-30), p1[1] - 10];
    const to: [number, number] = [mirror(W + 40), p3[1] + 4];
    a.line(
      `${pathD`M${from[0]} ${from[1]}`}${sagged(from, p1)}${sagged(p1, p2)}${sagged(p2, p3)}${sagged(p3, to)}`,
      "#17121d",
      1,
    );
  }
  // birds sat on one of the near wires
  const [w1, w2] = [towers[0]?.[2], towers[1]?.[2]] as [[number, number], [number, number]];
  const cx = (w1[0] + w2[0]) / 2;
  const cy = (w1[1] + w2[1]) / 2 + Math.abs(w2[0] - w1[0]) * 0.12;
  for (let k = 0; k < 3 + ri(rng, 3); k++) {
    const t = a.span(0.2, 0.8);
    const bx = (1 - t) * (1 - t) * w1[0] + 2 * (1 - t) * t * cx + t * t * w2[0];
    const by2 = (1 - t) * (1 - t) * w1[1] + 2 * (1 - t) * t * cy + t * t * w2[1];
    const face = rng() < 0.5 ? -1 : 1;
    a.oval(bx, by2 - 3, 3.2, 2.4, "#17121d");
    a.dot(bx + face * 2.6, by2 - 5.4, 1.7, "#17121d");
    a.line(pathD`M${bx - face * 2.5} ${by2 - 2.5}L${bx - face * 6} ${by2 + 1}`, "#17121d", 1.2);
  }
  for (let x = a.span(0, 8); x < W; x += a.span(6, 14))
    a.line(pathD`M${x} ${W}L${x - 2} ${W - 9}M${x} ${W}L${x + 3} ${W - 7}`, "#1c1712", 1.2);
  return { sky, art: a.art };
}

const CANDLE_WALLS: readonly [string, string][] = [
  ["#18121e", "#2e1e18"],
  ["#121624", "#2c2018"],
  ["#1c1318", "#33211a"],
];
const CURTAINS = ["#5a2434", "#2f4a5a", "#5a4a24", "#3a2a4a"];
const CATS = ["#0d0a0c", "#3a3a40", "#6a4428"];
const MUGS = ["#7a8aa8", "#a85a4a", "#5a8a6a", "#c9b48a"];
const BOOKS = ["#7a2a2a", "#2a4a6a", "#4a6a3a", "#8a6a2a", "#5a3a6a"];
const TABLES = ["#3a2416", "#2e1e14", "#40291a"];

/**
 * At home in an outage: a candle on the table and its glow, a mug steaming, a phone charging from
 * a power bank, books; the window with the cat on its sill, a clock and a picture on the wall.
 */
function candleScene(rng: Rng): Picture {
  const W = JIGSAW_SIZE;
  const a = painter(rng);
  const sky = a.pick(CANDLE_WALLS);
  // the wallpaper's stripes
  for (let x = a.span(0, 12); x < W; x += 24) a.box(x, 0, 10, 240, "#ffffff", 0, 0.03);
  // the window: the night outside, the houses across the street dark but for a window or two
  const right = rng() < 0.5;
  const ww = a.span(118, 132);
  const wh = a.span(120, 134);
  const wx = right ? W - ww - a.span(18, 34) : a.span(18, 34);
  const wy = a.span(22, 34);
  const sill = wy + wh;
  a.box(wx, wy, ww, wh, "#0a1428");
  for (let k = 0; k < 14; k++)
    a.dot(wx + rng() * ww, wy + rng() * wh * 0.5, 0.5 + rng(), "#ffffff", 0.4 + rng() * 0.5);
  a.dot(wx + ww * a.span(0.2, 0.8), wy + a.span(16, 34), a.span(7, 10), "#f3e6b8");
  for (let x = wx; x < wx + ww - 2; ) {
    const bw = Math.min(a.span(16, 30), wx + ww - x);
    const top = wy + wh * a.span(0.35, 0.6);
    a.box(x, top, bw, sill - top, "#060a15");
    for (let y = top + 5; y < sill - 6; y += 9)
      for (let xx = x + 3; xx < x + bw - 4; xx += 7)
        if (rng() < 0.12) a.box(xx, y, 3, 4, a.pick(LIT));
    x += bw + 1;
  }
  a.line(
    pathD`M${wx} ${wy}H${wx + ww}V${sill}H${wx}ZM${wx + ww / 2} ${wy + wh * 0.3}V${sill}M${wx} ${wy + wh * 0.3}H${wx + ww}`,
    "#4a3626",
    5,
  );
  a.box(wx - 10, sill, ww + 20, 8, "#55402f", 2);
  // a plant in a pot on the sill
  const px = wx + ww * a.span(0.12, 0.28);
  for (let k = 0; k < 5; k++) {
    const ang = -Math.PI / 2 + (k - 2) * 0.45;
    const lx = px + Math.cos(ang) * 16;
    const ly = sill - 16 + Math.sin(ang) * 16;
    a.line(pathD`M${px} ${sill - 16}Q${px + (lx - px) * 0.3} ${ly + 4} ${lx} ${ly}`, "#3a6a3a", 4);
  }
  a.fill(
    pathOf([
      [px - 9, sill - 16],
      [px + 9, sill - 16],
      [px + 7, sill],
      [px - 7, sill],
    ]),
    "#9a4e2e",
  );
  // the curtains, drawn back
  const cloth = a.pick(CURTAINS);
  for (const [x0, x1, bow] of [
    [wx - 26, wx + 14, 6],
    [wx + ww + 26, wx + ww - 14, -6],
  ] as const) {
    a.fill(
      pathD`M${x0} ${wy - 12}L${x1} ${wy - 12}Q${x1 + bow} ${wy + wh * 0.5} ${x1 - bow * 0.3} ${sill + 14}L${x0} ${sill + 14}Z`,
      cloth,
    );
    const mid = (x0 + x1) / 2;
    a.line(
      pathD`M${mid} ${wy - 12}Q${mid + 4} ${wy + wh * 0.5} ${mid - 2} ${sill + 14}`,
      "#000000",
      1.5,
      0.25,
    );
  }
  a.line(pathD`M${wx - 34} ${wy - 13}H${wx + ww + 34}`, "#2a1e16", 3);
  // the cat on the sill, looking out
  const cx = wx + ww * a.span(0.48, 0.7);
  const fur = a.pick(CATS);
  a.fill(
    pathD`M${cx - 13} ${sill}Q${cx - 16} ${sill - 22} ${cx - 6} ${sill - 30}L${cx + 6} ${sill - 30}Q${cx + 16} ${sill - 22} ${cx + 13} ${sill}Z`,
    fur,
  );
  a.dot(cx, sill - 34, 9, fur);
  for (const side of [-1, 1])
    a.fill(
      pathOf([
        [cx + side * 8, sill - 37],
        [cx + side * 7, sill - 48],
        [cx + side * 2, sill - 41],
      ]),
      fur,
    );
  a.line(pathD`M${cx + 11} ${sill - 2}Q${cx + 24} ${sill + 2} ${cx + 20} ${sill + 18}`, fur, 4);
  // on the other wall: a clock and a picture in a frame
  const ox = right ? a.span(42, 70) : W - a.span(42, 70);
  const oy = a.span(46, 66);
  a.dot(ox, oy, 19, "#3a2c22");
  a.dot(ox, oy, 16, "#d9ceb6");
  let ticks = "";
  for (let k = 0; k < 12; k++) {
    const ang = (k / 12) * Math.PI * 2;
    ticks += pathD`M${ox + Math.cos(ang) * 12} ${oy + Math.sin(ang) * 12}L${ox + Math.cos(ang) * 14.5} ${oy + Math.sin(ang) * 14.5}`;
  }
  a.line(ticks, "#3a2c22", 1.2);
  const hour = rng() * Math.PI * 2;
  const minute = rng() * Math.PI * 2;
  a.line(
    pathD`M${ox} ${oy}L${ox + Math.sin(hour) * 8} ${oy - Math.cos(hour) * 8}M${ox} ${oy}L${ox + Math.sin(minute) * 12} ${oy - Math.cos(minute) * 12}`,
    "#1a120c",
    1.6,
  );
  const fw = a.span(46, 58);
  const fy = oy + a.span(32, 42);
  a.box(ox - fw / 2 - 4, fy - 4, fw + 8, 46, "#6a4a28", 1);
  a.box(ox - fw / 2, fy, fw, 38, "#4f7ea6");
  a.fill(
    pathD`M${ox - fw / 2} ${fy + 24}Q${ox} ${fy + 10} ${ox + fw / 2} ${fy + 27}V${fy + 38}H${ox - fw / 2}Z`,
    "#4a7a3a",
  );
  a.dot(ox + fw * 0.22, fy + 10, 4, "#ffd27a");
  // the candle's glow over the wall
  const ty = a.span(212, 222);
  const fx = a.span(115, 185);
  const ct = ty - a.span(50, 62);
  for (const [r, o] of [
    [150, 0.05],
    [95, 0.07],
    [55, 0.09],
    [26, 0.16],
  ] as const)
    a.dot(fx, ct - 14, r, "#ffb85a", o);
  // the table, its grain, the light on it
  a.box(0, ty, W, W - ty, a.pick(TABLES));
  a.box(0, ty, W, 4, "#ffffff", 0, 0.08);
  for (let k = 0; k < 5; k++) {
    const y = ty + 14 + k * 16 + a.span(-4, 4);
    a.line(
      pathD`M0 ${y}Q${W / 2} ${y + a.span(-6, 6)} ${W} ${y + a.span(-3, 3)}`,
      "#000000",
      1,
      0.2,
    );
  }
  a.oval(fx, ty + 16, 100, 16, "#ffb85a", 0.1);
  // the candle in its saucer, the wax run down, the flame
  a.oval(fx, ty - 4, 22, 6, "#9a7a44");
  a.box(fx - 7, ct, 14, ty - 6 - ct, "#efe2c4", 1);
  a.box(fx + 2, ct, 5, ty - 6 - ct, "#d6c6a2");
  a.fill(
    pathD`M${fx - 7} ${ct}V${ct + 9}Q${fx - 5} ${ct + 13} ${fx - 3} ${ct + 7}V${ct}Z`,
    "#f8eed8",
  );
  a.line(pathD`M${fx} ${ct}V${ct - 5}`, "#2a1a10", 1.2);
  a.fill(
    pathD`M${fx} ${ct - 4}Q${fx - 6} ${ct - 11} ${fx} ${ct - 26}Q${fx + 6} ${ct - 11} ${fx} ${ct - 4}Z`,
    "#ffab3d",
  );
  a.fill(
    pathD`M${fx} ${ct - 5}Q${fx - 3} ${ct - 10} ${fx} ${ct - 18}Q${fx + 3} ${ct - 10} ${fx} ${ct - 5}Z`,
    "#fff2b8",
  );
  // the mug to one side, steaming
  const side = rng() < 0.5 ? 1 : -1;
  const mx = fx + side * a.span(50, 62);
  const mug = a.pick(MUGS);
  a.line(
    pathD`M${mx + side * 12} ${ty - 24}C${mx + side * 22} ${ty - 24} ${mx + side * 22} ${ty - 10} ${mx + side * 12} ${ty - 10}`,
    mug,
    3.5,
  );
  a.box(mx - 13, ty - 30, 26, 28, mug, 3);
  a.oval(mx, ty - 30, 13, 3.5, "#000000", 0.35);
  for (const sx of [mx - 4, mx + 5])
    a.line(
      pathD`M${sx} ${ty - 36}Q${sx - 5} ${ty - 46} ${sx} ${ty - 54}Q${sx + 5} ${ty - 62} ${sx} ${ty - 70}`,
      "#ffffff",
      1.5,
      0.2,
    );
  // books stacked beyond the mug
  const bx = Math.min(W - 28, Math.max(28, mx + side * a.span(40, 50)));
  let top = ty - 2;
  for (let k = 0; k < 3; k++) {
    const bw = a.span(38, 50);
    const bh = a.span(7, 10);
    top -= bh;
    const x = bx - bw / 2 + a.span(-4, 4);
    a.box(x, top, bw, bh, a.pick(BOOKS), 1);
    a.box(x + bw * 0.12, top + 1.5, 2, bh - 3, "#ffffff", 0, 0.3);
  }
  // the phone standing, charging from the power bank on the other side
  const pb = fx - side * a.span(52, 66);
  a.box(pb - 22, ty - 12, 44, 12, "#262a32", 3);
  const charge = 1 + ri(rng, 3);
  for (let k = 0; k < 4; k++)
    a.dot(pb - 14 + k * 5, ty - 6, 1.2, k < charge ? "#5cff8a" : "#1a3a22");
  const phx = Math.min(W - 14, Math.max(14, pb - side * 36));
  a.line(
    pathD`M${pb - side * 22} ${ty - 6}Q${(pb - side * 22 + phx) / 2} ${ty + 10} ${phx} ${ty - 2}`,
    "#d8d8d8",
    1.2,
  );
  a.dot(phx, ty - 22, 26, "#6a9ad8", 0.1);
  a.box(phx - 10, ty - 38, 20, 36, "#0e0f12", 3);
  a.box(phx - 8, ty - 35, 16, 28, "#3d6fae", 1);
  a.box(phx - 4, ty - 27, 8, 13, "#ffffff", 1, 0.85);
  a.box(phx - 3, ty - 19, 6, 4, "#5cff8a");
  return { sky, art: a.art };
}

const WINTER_SKIES: readonly [string, string][] = [
  ["#0b1530", "#3c5282"],
  ["#121838", "#4a5a8c"],
  ["#0a1a2e", "#356a8a"],
];
const BLOCKS = ["#1e2846", "#252c4a", "#1c2a3e"];
const FIRS = ["#183a34", "#1f4a3c", "#16362c"];
const SCARVES = ["#c0392b", "#2e86c1", "#d4ac0d", "#8e44ad"];

/** A winter evening: blocks of flats lit here and there, firs in snow, a snowman, a lamp, a sledge. */
function winterScene(rng: Rng): Picture {
  const W = JIGSAW_SIZE;
  const a = painter(rng);
  const sky = a.pick(WINTER_SKIES);
  a.stars(24, 110);
  a.moon(a.span(30, 270), a.span(26, 50), a.span(12, 16));
  // the blocks of flats behind, snow on their roofs, their windows lit here and there
  for (let x = a.span(-20, 10); x < W; ) {
    const bw = a.span(56, 84);
    const top = a.span(66, 120);
    a.box(x, top, bw, 220 - top, a.pick(BLOCKS));
    a.box(x - 1, top - 3, bw + 2, 4, "#dfe8f6", 1);
    for (let y = top + 8; y < 205; y += 13)
      for (let k = 0; k < Math.floor((bw - 6) / 11); k++) {
        const r = rng();
        if (r < 0.6) a.box(x + 6 + k * 11, y, 5, 6, r < 0.3 ? a.pick(LIT) : "#151b33");
      }
    x += bw + a.span(14, 34);
  }
  // the snow: drifts far and near
  a.hills(212, 16, "#b9c6dd");
  a.box(0, 228, W, W - 228, "#d3dcec");
  for (let k = 0; k < 5; k++)
    a.oval(a.span(0, W), a.span(240, 295), a.span(30, 60), a.span(4, 8), "#bccae0");
  // firs, snow on every tier
  const fir = (fx: number, base: number, h: number) => {
    a.box(fx - 2.5, base - h * 0.12, 5, h * 0.12, "#3a2a20");
    const green = a.pick(FIRS);
    for (let k = 2; k >= 0; k--) {
      const ay = base - h + k * h * 0.24;
      const hw = h * (0.16 + k * 0.08);
      a.fill(
        pathOf([
          [fx, ay],
          [fx + hw, ay + h * 0.4],
          [fx - hw, ay + h * 0.4],
        ]),
        green,
      );
      a.fill(
        pathD`M${fx} ${ay}L${fx + hw * 0.6} ${ay + h * 0.24}Q${fx + hw * 0.2} ${ay + h * 0.19} ${fx} ${ay + h * 0.25}Q${fx - hw * 0.25} ${ay + h * 0.19} ${fx - hw * 0.6} ${ay + h * 0.24}Z`,
        "#e9f0f8",
      );
    }
  };
  for (let k = 0; k < 3 + ri(rng, 2); k++) fir(a.span(10, 290), a.span(226, 248), a.span(50, 90));
  // the lamp, its light falling on the snow
  const sx = a.span(70, 230);
  const lx = sx < W / 2 ? a.span(215, 270) : a.span(30, 85);
  a.fill(
    pathOf([
      [lx - 7, 132],
      [lx + 7, 132],
      [lx + 40, 262],
      [lx - 40, 262],
    ]),
    "#ffe2a0",
    0.1,
  );
  a.oval(lx, 262, 42, 7, "#ffe2a0", 0.22);
  a.box(lx - 1.8, 128, 3.6, 134, "#1e2333");
  a.box(lx - 8, 122, 16, 10, "#1e2333", 2);
  a.dot(lx, 133, 14, "#ffe2a0", 0.2);
  a.dot(lx, 133, 4, "#fff0c0");
  a.box(lx - 9, 119, 18, 3, "#eef3fa", 1);
  // footprints up to the snowman
  const fx0 = a.span(40, 260);
  for (let k = 0; k < 8; k++) {
    const t = k / 8;
    a.oval(fx0 + (sx - fx0) * t + (k % 2 ? 4 : -4), W - 4 - k * 4.5, 2.6, 1.4, "#a9b7cf");
  }
  // the snowman: three balls, a bucket, a carrot, a scarf, arms of sticks
  const sb = a.span(262, 274);
  const ball = (cy: number, r: number) => {
    a.dot(sx, cy, r, "#c5d1e4");
    a.dot(sx - r * 0.12, cy - r * 0.1, r * 0.88, "#f3f6fb");
  };
  ball(sb - 24, 26);
  ball(sb - 62, 19);
  ball(sb - 90, 13);
  a.line(
    pathD`M${sx - 17} ${sb - 66}L${sx - 40} ${sb - 82}M${sx - 33} ${sb - 78}L${sx - 38} ${sb - 88}M${sx + 17} ${sb - 66}L${sx + 38} ${sb - 76}M${sx + 32} ${sb - 73}L${sx + 40} ${sb - 68}`,
    "#4a3020",
    2,
  );
  const look = rng() < 0.5 ? -1 : 1;
  a.dot(sx - 4, sb - 93, 1.6, "#1a1a1a");
  a.dot(sx + 4, sb - 93, 1.6, "#1a1a1a");
  a.fill(
    pathOf([
      [sx, sb - 90],
      [sx + look * 13, sb - 88],
      [sx, sb - 86.5],
    ]),
    "#f07a2a",
  );
  for (const y of [sb - 70, sb - 60, sb - 50]) a.dot(sx, y, 1.8, "#1a1a1a");
  const scarf = a.pick(SCARVES);
  a.fill(
    pathD`M${sx - 14} ${sb - 79}Q${sx} ${sb - 73} ${sx + 14} ${sb - 79}L${sx + 14} ${sb - 75}Q${sx} ${sb - 69} ${sx - 14} ${sb - 75}Z`,
    scarf,
  );
  a.box(sx + 5, sb - 76, 6, 16, scarf, 1);
  a.fill(
    pathOf([
      [sx - 10, sb - 99],
      [sx + 10, sb - 99],
      [sx + 8, sb - 114],
      [sx - 8, sb - 114],
    ]),
    "#5a6170",
  );
  a.box(sx - 12, sb - 101, 24, 3, "#4a505e");
  // the sledge left in the snow
  const kx = sx < W / 2 ? a.span(190, 250) : a.span(14, 70);
  const ky = a.span(282, 292);
  a.line(pathD`M${kx + 6} ${ky - 4}V${ky - 1}M${kx + 28} ${ky - 4}V${ky - 1}`, "#6a2a1a", 1.6);
  a.box(kx, ky - 8, 36, 4, "#b0492e", 1);
  a.line(
    pathD`M${kx - 2} ${ky - 1}H${kx + 34}Q${kx + 40} ${ky - 1} ${kx + 40} ${ky - 6}`,
    "#6a2a1a",
    2,
  );
  a.line(pathD`M${kx + 40} ${ky - 6}Q${kx + 52} ${ky + 2} ${kx + 58} ${ky - 4}`, "#c9a46a", 1);
  // snow falling
  for (let k = 0; k < 60; k++)
    a.dot(rng() * W, rng() * W, 0.7 + rng() * 1.5, "#ffffff", 0.45 + rng() * 0.5);
  return { sky, art: a.art };
}

const JIGSAW_PAINT: Record<JigsawScene, (rng: Rng) => Picture> = {
  street: streetScene,
  village: villageScene,
  pylons: pylonScene,
  candle: candleScene,
  winter: winterScene,
};

/**
 * A picture of its own (one of the scenes, drawn afresh), cut into n × n pieces with knobs (each
 * inner edge bulging one way or the other, nudged a little so no two look alike), the pieces
 * handed over shuffled. Nothing on the board to go by: up the floors only more pieces.
 */
export function jigsawPuzzle(rng: Rng, tier: Tier): JigsawPuzzle {
  const n = JIGSAW_GRID[tier] as number;
  const scene = JIGSAW_SCENES[ri(rng, JIGSAW_SCENES.length)] as JigsawScene;
  const { sky, art } = JIGSAW_PAINT[scene](rng);
  const edge = (inner: boolean): JigsawEdge =>
    inner
      ? { knob: rng() < 0.5 ? -1 : 1, shift: (rng() - 0.5) * 0.08, scale: 0.85 + rng() * 0.25 }
      : { knob: 0, shift: 0, scale: 1 };
  const across = Array.from({ length: n + 1 }, (_, r) =>
    Array.from({ length: n }, () => edge(r > 0 && r < n)),
  );
  const down = Array.from({ length: n }, () =>
    Array.from({ length: n + 1 }, (_, c) => edge(c > 0 && c < n)),
  );
  return { n, scene, sky, art, across, down, order: shuffle(rng, [...Array(n * n).keys()]) };
}

// ── «Судоку»: every row, column and box holds each digit once ────────────────────────────────────

export type SudokuPuzzle = {
  /** The side: 4 (boxes of 2 × 2), 6 (boxes of 2 rows × 3 columns) or 9 (boxes of 3 × 3). */
  n: number;
  /** A box's rows and columns. */
  box: [number, number];
  /** The cells row by row: the digit given, 0 for an empty one. */
  givens: number[];
  /** The one way to fill it. */
  solution: number[];
};

/**
 * Per tier: the side and its boxes, how many cells are given (fewest and most; 0: as few as the
 * reasoning allows), and whether it takes more than singles to solve.
 */
export const SUDOKU_TIERS = [
  { n: 4, box: [2, 2], givens: [6, 8], deep: false },
  { n: 6, box: [2, 3], givens: [11, 14], deep: false },
  { n: 9, box: [3, 3], givens: [0, 0], deep: true },
] as const;

/** A grid's lines: its rows, columns and boxes (cells row by row), and which three hold a cell. */
type SudokuShape = { n: number; units: number[][]; unitsOf: [number, number, number][] };
const sudokuShapes = new Map<string, SudokuShape>();

function sudokuShape(n: number, [bh, bw]: readonly [number, number]): SudokuShape {
  const key = `${n}:${bh}x${bw}`;
  const known = sudokuShapes.get(key);
  if (known) return known;
  const units: number[][] = [];
  for (let r = 0; r < n; r++) units.push(Array.from({ length: n }, (_, c) => r * n + c));
  for (let c = 0; c < n; c++) units.push(Array.from({ length: n }, (_, r) => r * n + c));
  for (let b = 0; b < n; b++) {
    const r0 = Math.floor(b / (n / bw)) * bh;
    const c0 = (b % (n / bw)) * bw;
    units.push(Array.from({ length: n }, (_, k) => (r0 + Math.floor(k / bw)) * n + c0 + (k % bw)));
  }
  const unitsOf = Array.from({ length: n * n }, () => [0, 0, 0] as [number, number, number]);
  units.forEach((unit, u) => {
    for (const i of unit) (unitsOf[i] as [number, number, number])[Math.floor(u / n)] = u;
  });
  const shape = { n, units, unitsOf };
  sudokuShapes.set(key, shape);
  return shape;
}

const bits = (mask: number) => {
  let count = 0;
  for (let m = mask; m; m &= m - 1) count++;
  return count;
};

/** Every way to pick `k` of `items`. */
function choose<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of choose(items.slice(i + 1), k - 1)) out.push([item, ...rest]);
  });
  return out;
}

/**
 * Solves by reasoning alone, as a person would, never guessing: a cell with one digit left, a digit
 * with one cell left in a line or box; with `deep`, also a digit a box keeps to one row or column
 * (or a line to one box), and two or three cells sharing two or three digits (or two or three
 * digits sharing two or three cells). The filled grid, or null if reasoning does not get there.
 * Every step is sound, so a grid it fills has no other solution.
 */
export function sudokuReason(
  p: Pick<SudokuPuzzle, "n" | "box">,
  cells: readonly number[],
  deep: boolean,
): number[] | null {
  const { n, units, unitsOf } = sudokuShape(p.n, p.box);
  const grid = new Array<number>(n * n).fill(0);
  const cand = new Array<number>(n * n).fill((1 << n) - 1);
  let left = n * n;
  const place = (i: number, d: number) => {
    grid[i] = d;
    cand[i] = 0;
    left--;
    for (const u of unitsOf[i] as number[])
      for (const j of units[u] as number[]) cand[j] = (cand[j] as number) & ~(1 << (d - 1));
  };
  for (const [i, d] of cells.entries()) {
    if (!d) continue;
    if (!((cand[i] as number) & (1 << (d - 1)))) return null;
    place(i, d);
  }
  /** Takes digits `mask` out of cell `j`; whether that changed anything. */
  const drop = (j: number, mask: number) => {
    const before = cand[j] as number;
    cand[j] = before & ~mask;
    return cand[j] !== before;
  };
  while (left > 0) {
    let moved = false;
    // a cell with one digit left
    for (let i = 0; i < n * n; i++) {
      if (grid[i]) continue;
      const c = cand[i] as number;
      if (!c) return null;
      if (bits(c) === 1) {
        place(i, 31 - Math.clz32(c) + 1);
        moved = true;
      }
    }
    if (moved) continue;
    // a digit with one cell left in a line or box
    for (const unit of units)
      for (let d = 1; d <= n; d++) {
        const bit = 1 << (d - 1);
        if (unit.some((i) => grid[i] === d)) continue;
        const spots = unit.filter((i) => (cand[i] as number) & bit);
        if (spots.length === 0) return null;
        if (spots.length === 1) {
          place(spots[0] as number, d);
          moved = true;
        }
      }
    if (moved) continue;
    if (!deep) return null;
    for (const [u, unit] of units.entries()) {
      // a digit kept to where this unit meets another: out of the rest of that other one
      for (let d = 1; d <= n; d++) {
        const bit = 1 << (d - 1);
        const spots = unit.filter((i) => (cand[i] as number) & bit);
        if (spots.length < 2) continue;
        for (let k = 0; k < 3; k++) {
          const other = (unitsOf[spots[0] as number] as number[])[k] as number;
          if (other === u || !spots.every((i) => (unitsOf[i] as number[])[k] === other)) continue;
          for (const j of units[other] as number[])
            if (!spots.includes(j) && drop(j, bit)) moved = true;
        }
      }
      // two or three cells with only two or three digits between them: those digits are theirs
      const open = unit.filter((i) => !grid[i]);
      for (const k of [2, 3]) {
        if (open.length <= k) continue;
        for (const set of choose(open, k)) {
          const mask = set.reduce((m, i) => m | (cand[i] as number), 0);
          if (bits(mask) !== k) continue;
          for (const j of open) if (!set.includes(j) && drop(j, mask)) moved = true;
        }
        // two or three digits with only two or three cells between them: those cells are theirs
        const digits = Array.from({ length: n }, (_, d) => d + 1).filter(
          (d) => !unit.some((i) => grid[i] === d),
        );
        if (digits.length <= k) continue;
        for (const set of choose(digits, k)) {
          const mask = set.reduce((m, d) => m | (1 << (d - 1)), 0);
          const spots = open.filter((i) => (cand[i] as number) & mask);
          if (spots.length !== k) continue;
          for (const j of spots) if (drop(j, ~mask)) moved = true;
        }
      }
    }
    if (!moved) return null;
  }
  return grid;
}

/** A whole grid of its own: the cells filled one by one, each with a digit drawn at random that fits. */
function sudokuFull(rng: Rng, p: Pick<SudokuPuzzle, "n" | "box">): number[] {
  const { n, units, unitsOf } = sudokuShape(p.n, p.box);
  const grid = new Array<number>(n * n).fill(0);
  const digits = Array.from({ length: n }, (_, d) => d + 1);
  const fill = (i: number): boolean => {
    if (i === n * n) return true;
    const taken = new Set(
      (unitsOf[i] as number[]).flatMap((u) => (units[u] as number[]).map((j) => grid[j])),
    );
    for (const d of shuffle(rng, digits)) {
      if (taken.has(d)) continue;
      grid[i] = d;
      if (fill(i + 1)) return true;
    }
    grid[i] = 0;
    return false;
  };
  fill(0);
  return grid;
}

/**
 * A grid of its own with cells taken out two at a time, each facing the other across the centre,
 * for as long as reasoning still fills it (so it has one solution, found without guessing) and
 * the tier's count of givens allows. The hard one must take more than singles: if the grid it got
 * to can be solved without, another grid is tried.
 */
export function sudokuPuzzle(rng: Rng, tier: Tier): SudokuPuzzle {
  const t = SUDOKU_TIERS[tier];
  const n = t.n;
  const box: [number, number] = [t.box[0], t.box[1]];
  const shape = { n, box };
  let last: SudokuPuzzle | null = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const solution = sudokuFull(rng, shape);
    const givens = solution.slice();
    const fewest = t.givens[0] + ri(rng, t.givens[1] - t.givens[0] + 1);
    let count = n * n;
    for (const i of shuffle(rng, [...Array(Math.ceil((n * n) / 2)).keys()])) {
      const j = n * n - 1 - i;
      const pair = i === j ? 1 : 2;
      if (count - pair < fewest) continue;
      const kept = [givens[i] as number, givens[j] as number];
      givens[i] = 0;
      givens[j] = 0;
      if (sudokuReason(shape, givens, t.deep)) count -= pair;
      else [givens[i], givens[j]] = kept as [number, number];
    }
    last = { n, box, givens, solution };
    if (!t.deep || !sudokuReason(shape, givens, false)) return last;
  }
  return last as SudokuPuzzle;
}

// ── «Іскра»: a spark runs up a zigzag wire; a tap turns it; off the wire it goes out ───────────

export type SparkPuzzle = {
  /** The runs of the zigzag, in steps (a step: one across and one up), turning after each. */
  runs: number[];
  /** Which way the first run goes: 1 right, -1 left. */
  first: 1 | -1;
  /** The wire's width, in steps across it. */
  width: number;
  /** Steps a second at the start and at the lamp. */
  speed: [number, number];
};

/** The path keeps within this many steps either side of the middle. */
export const SPARK_REACH = 4;
/**
 * Per tier: turns to the lamp, the runs' lengths (shortest, longest), how often a run is a single
 * step besides (two turns in quick succession; never twice in a row), the width, the speed.
 */
export const SPARK_TIERS = [
  { turns: 12, runs: [2, 5], quick: 0, width: 1.5, speed: [2.6, 2.6] },
  { turns: 20, runs: [1, 5], quick: 0, width: 1.3, speed: [3.4, 3.8] },
  { turns: 30, runs: [2, 4], quick: 0.1, width: 1.2, speed: [4, 4.6] },
] as const;

/**
 * How late (or early) a tap may come at a turn, in steps: turned that far off the corner, the
 * spark runs alongside the next stretch √2 times as far from its middle, and must stay on it.
 */
export const sparkSlack = (p: Pick<SparkPuzzle, "width">) => p.width / 2 / Math.SQRT2;

/**
 * A zigzag of its own: runs of a few steps, longer at the start (time to get going) and into the
 * lamp, never out past the reach either side.
 */
export function sparkPuzzle(rng: Rng, tier: Tier): SparkPuzzle {
  const t = SPARK_TIERS[tier];
  const first: 1 | -1 = rng() < 0.5 ? 1 : -1;
  const runs: number[] = [];
  let x = 0;
  let dir: number = first;
  for (let k = 0; k <= t.turns; k++) {
    const room = SPARK_REACH - dir * x;
    const lo = k === 0 ? 3 : k === t.turns ? 2 : t.runs[0];
    // a single step, if the run after it has room for two (not forced into another single)
    const quick =
      k > 0 &&
      k < t.turns &&
      t.quick > 0 &&
      runs.at(-1) !== 1 &&
      SPARK_REACH + dir * x >= 1 &&
      rng() < t.quick;
    const len = quick ? 1 : Math.min(room, lo + ri(rng, Math.max(1, t.runs[1] - lo + 1)));
    runs.push(len);
    x += dir * len;
    dir = -dir;
  }
  return { runs, first, width: t.width, speed: [t.speed[0], t.speed[1]] };
}

/** The middle of the wire: its corners from the start (0, 0) to the lamp, y going up. */
export function sparkPath(p: Pick<SparkPuzzle, "runs" | "first">): [number, number][] {
  const points: [number, number][] = [[0, 0]];
  let [x, y] = [0, 0];
  p.runs.forEach((len, k) => {
    x += (k % 2 ? -p.first : p.first) * len;
    y += len;
    points.push([x, y]);
  });
  return points;
}

/** How far (x, y) is from the middle of the wire. */
export function sparkDistance(path: readonly (readonly [number, number])[], x: number, y: number) {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 1; k < path.length; k++) {
    const [ax, ay] = path[k - 1] as [number, number];
    const [bx, by] = path[k] as [number, number];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** A turn close to its corner pulls the spark onto the middle of the wire: within this share of its width. */
export const SPARK_SNAP = 0.25;

/**
 * Just turned at (x, y) to go `dir`: the corner of the stretch it has turned onto, if it runs
 * within SPARK_SNAP of the wire's width off that stretch's middle (then it is pulled onto it);
 * null if it is further off, or the nearest corner turns the other way.
 */
export function sparkSnap(
  p: Pick<SparkPuzzle, "width">,
  path: readonly (readonly [number, number])[],
  x: number,
  y: number,
  dir: number,
): number | null {
  let best = -1;
  let gap = Number.POSITIVE_INFINITY;
  for (let c = 1; c < path.length - 1; c++) {
    const d = Math.abs((path[c] as [number, number])[1] - y);
    if (d < gap) [best, gap] = [c, d];
  }
  if (best < 0) return null;
  const [cx, cy] = path[best] as [number, number];
  if (Math.sign((path[best + 1] as [number, number])[0] - cx) !== dir) return null;
  const off = Math.abs(x - cx - (y - cy) * dir) / Math.SQRT2;
  return off <= SPARK_SNAP * p.width ? best : null;
}

// ── «Комора»: drag a thing onto one just like it, and the two become the next one up ──────────

/**
 * A thing in the store: of the power (a battery up to a generator), the light (a match up to a
 * garland) or the connection (headphones up to a TV), and its level.
 */
export type StoreItem = { kind: StoreKind; level: number };
export type StoreKind = 0 | 1 | 2;
/** How many kinds of things there are. */
export const STORE_KINDS = 3;
/** The levels of each kind. */
export const STORE_LEVELS = 5;
export const STORE_NAMES = [
  ["Батарейка", "Павербанк", "Акумулятор", "Зарядна станція", "Генератор"],
  ["Сірник", "Свічка", "Ліхтарик", "Лампа", "Гірлянда"],
  ["Навушники", "Телефон", "Планшет", "Ноутбук", "Телевізор"],
] as const;

export type StorePuzzle = {
  rows: number;
  cols: number;
  /** What lies in each cell, row by row (in a box too), or null. */
  cells: (StoreItem | null)[];
  /** The cells under a box: it opens when two things become one next to it. */
  boxed: number[];
  /** What is wanted. */
  order: StoreItem[];
  /** One way through: things dragged (from, onto) in turn; then the order handed in. */
  solution: [number, number][];
  /** How many joins there are to do it in: the way through's, and a few to spare. */
  moves: number;
};

/**
 * Per tier: the store's size, the levels wanted, the boxes, spare pairs (tempting, a join wasted),
 * odd things lying about, how many small things are split once more, and the joins to spare.
 */
export const STORE_TIERS = [
  { rows: 5, cols: 5, order: [4, 3], boxes: 4, spare: 1, odd: 1, extra: 3, slack: 2 },
  { rows: 6, cols: 6, order: [4, 4, 3], boxes: 8, spare: 1, odd: 2, extra: 4, slack: 1 },
  { rows: 6, cols: 6, order: [5, 4, 4], boxes: 11, spare: 0, odd: 3, extra: 5, slack: 0 },
] as const;

export type StoreState = {
  cells: (StoreItem | null)[];
  boxed: ReadonlySet<number>;
  /** Which of the order is handed in. */
  handed: boolean[];
};

const storeSame = (a: StoreItem | null | undefined, b: StoreItem | null | undefined) =>
  Boolean(a && b && a.kind === b.kind && a.level === b.level);

/** The cells next to `i`: up, down, left, right. */
export function storeAround(p: Pick<StorePuzzle, "rows" | "cols">, i: number): number[] {
  const r = Math.floor(i / p.cols);
  const c = i % p.cols;
  const out: number[] = [];
  if (r > 0) out.push(i - p.cols);
  if (r < p.rows - 1) out.push(i + p.cols);
  if (c > 0) out.push(i - 1);
  if (c < p.cols - 1) out.push(i + 1);
  return out;
}

export const storeStart = (p: StorePuzzle): StoreState => ({
  cells: p.cells.map((c) => (c ? { ...c } : null)),
  boxed: new Set(p.boxed),
  handed: p.order.map(() => false),
});

/**
 * `from` dragged onto `to`: the two become one a level up where it was dropped, and the boxes
 * round that cell open. Null if they are not alike, either is in a box, or they are at the top.
 */
export function storeMerge(
  p: Pick<StorePuzzle, "rows" | "cols">,
  s: StoreState,
  from: number,
  to: number,
): { state: StoreState; opened: number[] } | null {
  const a = s.cells[from];
  if (from === to || !a || s.boxed.has(from) || s.boxed.has(to)) return null;
  if (!storeSame(a, s.cells[to]) || a.level >= STORE_LEVELS) return null;
  const cells = s.cells.slice();
  cells[from] = null;
  cells[to] = { kind: a.kind, level: a.level + 1 };
  const boxed = new Set(s.boxed);
  const opened = storeAround(p, to).filter((c) => boxed.has(c));
  for (const c of opened) boxed.delete(c);
  return { state: { cells, boxed, handed: s.handed }, opened };
}

/** The thing in `cell` handed in for the order's `slot`: null if that slot wants another, or has one. */
export function storeHand(
  p: Pick<StorePuzzle, "order">,
  s: StoreState,
  cell: number,
  slot: number,
): StoreState | null {
  if (s.boxed.has(cell) || s.handed[slot] !== false || !storeSame(s.cells[cell], p.order[slot]))
    return null;
  const cells = s.cells.slice();
  cells[cell] = null;
  const handed = s.handed.slice();
  handed[slot] = true;
  return { cells, boxed: s.boxed, handed };
}

/** Nothing left to do: no two alike out of the boxes (below the top), nothing to hand in. */
export function storeStuck(p: Pick<StorePuzzle, "order">, s: StoreState): boolean {
  const free = s.cells.filter((c, i): c is StoreItem => Boolean(c) && !s.boxed.has(i));
  const pair = free.some(
    (a, i) => a.level < STORE_LEVELS && free.some((b, j) => j !== i && storeSame(a, b)),
  );
  const hand = p.order.some((o, k) => !s.handed[k] && free.some((a) => storeSame(a, o)));
  return !pair && !hand && s.handed.some((h) => !h);
}

/**
 * A store of its own, built backwards from the order: each thing wanted split in two (the halves
 * on a free cell anywhere), the biggest first, down to small things; beside where two halves will
 * meet, now and then a small thing is shut in a box — it opens only when they are joined there.
 * Spare pairs and odd things are put about. Played forwards, the splits are a way through.
 */
export function storePuzzle(rng: Rng, tier: Tier): StorePuzzle {
  const t = STORE_TIERS[tier];
  const { rows, cols } = t;
  const size = rows * cols;
  const p = { rows, cols };
  let last: StorePuzzle | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const cells: (StoreItem | null)[] = new Array(size).fill(null);
    const boxed = new Set<number>();
    // each thing wanted of a kind of its own
    const kinds = shuffle(rng, [0, 1, 2] as StoreKind[]);
    const order: StoreItem[] = t.order.map((level, k) => ({
      kind: kinds[k % STORE_KINDS] as StoreKind,
      level,
    }));
    const free = () =>
      shuffle(rng, [...Array(size).keys()]).find((c) => !cells[c] && !boxed.has(c));
    for (const item of order) {
      const c = free();
      if (c !== undefined) cells[c] = { ...item };
    }
    const steps: [number, number][] = [];
    const split = (x: number) => {
      // the other half often right beside it: things lie in heaps, boxes have things round them
      const beside = storeAround(p, x).filter((c) => !cells[c] && !boxed.has(c));
      const y = beside.length && rng() < 0.5 ? beside[ri(rng, beside.length)] : free();
      if (y === undefined) return false;
      const a = cells[x] as StoreItem;
      cells[x] = { kind: a.kind, level: a.level - 1 };
      cells[y] = { kind: a.kind, level: a.level - 1 };
      steps.push([y, x]);
      if (boxed.size < t.boxes && rng() < 0.75) {
        // a small thing beside it shut in a box; with none there, a box with a small thing of its own
        const round = storeAround(p, x).filter((c) => c !== y && !boxed.has(c));
        const near = round.filter((c) => cells[c] && (cells[c] as StoreItem).level <= 2);
        const room = round.filter((c) => !cells[c]);
        if (near.length) boxed.add(near[ri(rng, near.length)] as number);
        else if (room.length) {
          const c = room[ri(rng, room.length)] as number;
          cells[c] = { kind: ri(rng, STORE_KINDS) as StoreKind, level: 1 };
          boxed.add(c);
        }
      }
      return true;
    };
    const open = (c: number) => !boxed.has(c) && cells[c];
    for (;;) {
      const big = [...cells.keys()].filter((c) => open(c) && (cells[c] as StoreItem).level > 2);
      if (!big.length) break;
      const top = Math.max(...big.map((c) => (cells[c] as StoreItem).level));
      const pick = big.filter((c) => (cells[c] as StoreItem).level === top);
      if (!split(pick[ri(rng, pick.length)] as number)) break;
    }
    for (let k = 0; k < t.extra; k++) {
      const two = [...cells.keys()].filter((c) => open(c) && (cells[c] as StoreItem).level === 2);
      if (!two.length || !split(two[ri(rng, two.length)] as number)) break;
    }
    for (let k = 0; k < t.spare; k++) {
      const item = { kind: ri(rng, STORE_KINDS) as StoreKind, level: 1 + ri(rng, 2) };
      for (let h = 0; h < 2; h++) {
        const c = free();
        if (c !== undefined) cells[c] = { ...item };
      }
    }
    for (let k = 0; k < t.odd; k++) {
      const c = free();
      if (c !== undefined)
        cells[c] = { kind: ri(rng, STORE_KINDS) as StoreKind, level: 1 + ri(rng, 3) };
    }
    last = {
      rows,
      cols,
      cells,
      boxed: [...boxed].sort((a, b) => a - b),
      order,
      solution: steps.reverse(),
      moves: steps.length + t.slack,
    };
    // all the boxes, and nothing wanted lying there to hand in from the start
    const ready = order.some((o) => cells.some((c, i) => !boxed.has(i) && storeSame(c, o)));
    if (boxed.size === t.boxes && !ready) return last;
  }
  return last as StorePuzzle;
}
