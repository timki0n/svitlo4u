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
