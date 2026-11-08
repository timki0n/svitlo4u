/**
 * Puzzles of the window game as pure data from a seeded RNG: every neighbour gets the same puzzle
 * in a window during an outage. Each puzzle keeps its own solution (tests check it is reachable).
 */
import { type GameTier, gameTier } from "../../../../packages/domain/src/game.ts";
import { type Rng, ri, shuffle } from "./rng.ts";

/** Difficulty from the floor (shared with the core, which scores by it). */
export type Tier = GameTier;
export const tierOf = gameTier;

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
  const tiles = solution.map((v) => {
    let turns = ri(rng, 4);
    let t = v;
    while (turns-- > 0) t = rotate(t);
    return t;
  });
  if (chainPowered(n, source, tiles).every(Boolean)) {
    const i = tiles.findIndex((v) => v !== 15 && v !== 5 && v !== 10);
    if (i >= 0) tiles[i] = rotate(tiles[i] as number);
  }
  return { n, source, solution, tiles };
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

export function beamPuzzle(rng: Rng, tier: Tier): BeamPuzzle {
  const n = [5, 6, 7][tier] as number;
  const turnsNeeded = [2, 3, 4][tier] as number;
  const decoys = [2, 4, 6][tier] as number;
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
  if (target < 0) {
    solution = new Map();
    target = row * n + n - 1;
  }
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
  const mirrors = new Map<number, Mirror>();
  for (const c of solution.keys()) mirrors.set(c, rng() < 0.5 ? "/" : "\\");
  const free = [...Array(n * n).keys()].filter(
    (c) => c !== target && !solution.has(c) && !onPath.has(c),
  );
  for (const c of shuffle(rng, free).slice(0, decoys)) mirrors.set(c, rng() < 0.5 ? "/" : "\\");
  const p = { n, row, target };
  // A start that already hits the panel (through the decoys too) is shuffled again.
  for (let tries = 0; tries < 50 && traceBeam(p, mirrors).hit; tries++)
    for (const c of mirrors.keys()) mirrors.set(c, rng() < 0.5 ? "/" : "\\");
  return { ...p, mirrors, solution };
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
  const order = shuffle(rng, [...Array(count).keys()]);
  const start = new Array<Point>(count);
  order.forEach((node, i) => {
    const a = (2 * Math.PI * i) / count - Math.PI / 2;
    start[node] = { x: 150 + 118 * Math.cos(a), y: 150 + 118 * Math.sin(a) };
  });
  if (crossingEdges(edges, start).size === 0) {
    const a = order[0] as number;
    const b = order[Math.floor(count / 2)] as number;
    [start[a], start[b]] = [start[b] as Point, start[a] as Point];
  }
  return { size, edges, start, solved };
}

/** Indices of edges that cross another edge (shared ends do not count). */
export function crossingEdges(
  edges: readonly [number, number][],
  pos: readonly Point[],
): Set<number> {
  const o = (p: Point, q: Point, r: Point) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const bad = new Set<number>();
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i] as [number, number];
      const [c, d] = edges[j] as [number, number];
      if (a === c || a === d || b === c || b === d) continue;
      const [A, B, C, D] = [pos[a], pos[b], pos[c], pos[d]] as [Point, Point, Point, Point];
      if (o(A, B, C) !== o(A, B, D) && o(C, D, A) !== o(C, D, B)) {
        bad.add(i);
        bad.add(j);
      }
    }
  }
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

export function slidePuzzle(rng: Rng, tier: Tier): SlidePuzzle {
  const n = 6;
  const row = 2;
  const boxes = [6, 8, 10][tier] as number;
  const scramble = [150, 300, 600][tier] as number;
  let blocks: Block[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    blocks = [{ r: row, c: n - 2, len: 2, h: true, gen: true }];
    for (let tries = 0; blocks.length < boxes + 1 && tries < 400; tries++) {
      const h = rng() < 0.5;
      const len = rng() < 0.7 ? 2 : 3;
      const r = ri(rng, h ? n : n - len + 1);
      const c = ri(rng, h ? n - len + 1 : n);
      if (h && r === row) continue;
      const b = { r, c, len, h, gen: false };
      if (slideFits(n, slideGrid(n, blocks), b, r, c)) blocks.push(b);
    }
    const gen = blocks[0] as Block;
    for (let i = 0; i < scramble || (gen.c > 1 && i < scramble * 4); i++) {
      const bi = ri(rng, blocks.length);
      const b = blocks[bi] as Block;
      const d = rng() < 0.5 ? -1 : 1;
      const r = b.r + (b.h ? 0 : d);
      const c = b.c + (b.h ? d : 0);
      if (slideFits(n, slideGrid(n, blocks, bi), b, r, c)) {
        b.r = r;
        b.c = c;
      }
    }
    const g = slideGrid(n, blocks, 0);
    let blocked = false;
    for (let c = gen.c + 2; c < n; c++) if ((g[row * n + c] as number) >= 0) blocked = true;
    if (gen.c <= 2 && blocked) break;
  }
  return { n, row, blocks };
}

/** Breadth-first search for a way out (tests; the puzzle is built by legal moves, so it has one). */
export function slideSolvable(p: SlidePuzzle, limit = 200_000): boolean {
  const key = (bs: readonly Block[]) => bs.map((b) => `${b.r},${b.c}`).join(";");
  const seen = new Set([key(p.blocks)]);
  let frontier = [p.blocks.map((b) => ({ ...b }))];
  while (frontier.length > 0 && seen.size < limit) {
    const next: Block[][] = [];
    for (const bs of frontier) {
      if ((bs[0] as Block).c === p.n - 2) return true;
      bs.forEach((b, i) => {
        const g = slideGrid(p.n, bs, i);
        for (const d of [-1, 1]) {
          const r = b.r + (b.h ? 0 : d);
          const c = b.c + (b.h ? d : 0);
          if (!slideFits(p.n, g, b, r, c)) continue;
          const moved = bs.map((x, j) => (j === i ? { ...x, r, c } : x));
          const k = key(moved);
          if (!seen.has(k)) {
            seen.add(k);
            next.push(moved);
          }
        }
      });
    }
    frontier = next;
  }
  return false;
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

export function chargePuzzle(rng: Rng, tier: Tier): ChargePuzzle {
  const banksCount = [2, 3, 3][tier] as number;
  const count = [4, 6, 7][tier] as number;
  const slack = [2, 1, 0][tier] as number;
  const extra = [1, 1, 0][tier] as number;
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
