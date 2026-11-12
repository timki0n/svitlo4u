import { describe, expect, it } from "vitest";
import { GAMES, windowGame } from "./games.ts";
import {
  BATTERY_CAP,
  batteryMinMoves,
  batteryPuzzle,
  batterySorted,
  beamGreedy,
  beamMinFlips,
  beamPuzzle,
  chainPowered,
  chainPuzzle,
  chainTaps,
  chargeFirstFit,
  chargePuzzle,
  chargeSolutions,
  crossingCount,
  FUSE_HITS,
  fusePuzzle,
  JIGSAW_GRID,
  JIGSAW_SCENES,
  JIGSAW_SIZE,
  jigsawEdge,
  jigsawGroup,
  jigsawOutline,
  jigsawPuzzle,
  MAX_CHARGE_SOLUTIONS,
  MAX_PACK_SOLUTIONS,
  MIN_BATTERY_MOVES,
  MIN_BEAM_FLIPS,
  MIN_CHAIN_TAPS,
  MIN_SLIDE_MOVES,
  MIN_UNTANGLE_CROSSINGS,
  packPuzzle,
  packShapeOf,
  packSolutions,
  petsPuzzle,
  SPARK_REACH,
  SPARK_SNAP,
  SPARK_TIERS,
  STORE_LEVELS,
  STORE_TIERS,
  type StoreItem,
  type StorePuzzle,
  SUDOKU_TIERS,
  slideMinMoves,
  slidePuzzle,
  sparkDistance,
  sparkPath,
  sparkPuzzle,
  sparkSlack,
  sparkSnap,
  storeAround,
  storeHand,
  storeMerge,
  storePuzzle,
  storeStart,
  storeStuck,
  sudokuPuzzle,
  sudokuReason,
  type Tier,
  tierOf,
  traceBeam,
  untanglePuzzle,
  VOLT_CORNER,
  VOLT_SIZES,
  VOLT_STRAIGHT,
  VOLT_TARGET,
  type VoltBlock,
  type VoltCell,
  voltPuzzle,
  voltTrace,
  voltTurns,
} from "./puzzles.ts";
import { rngOf } from "./rng.ts";

const TIERS: Tier[] = [0, 1, 2];
/** Windows of many outages: every generator, every tier, many seeds. */
const keys = (count: number) =>
  Array.from({ length: count }, (_, i) => `o17940${i}:${2 + (i % 26)}-${1 + (i % 8)}`);

describe("window games", () => {
  it("the same window of the same outage is the same game; floors set the tier", () => {
    const a = windowGame("o1794028691041", 14, 3);
    const b = windowGame("o1794028691041", 14, 3);
    expect(b.game.id).toBe(a.game.id);
    expect(a.tier).toBe(1);
    expect([tierOf(2), tierOf(9), tierOf(10), tierOf(18), tierOf(19), tierOf(27)]).toEqual([
      0, 0, 1, 1, 2, 2,
    ]);
    const ids = new Set(keys(200).map((k) => windowGame(k, 5, 1).game.id));
    expect(ids.size).toBe(GAMES.length);
  });

  it("every generator gives the same puzzle for the same key", () => {
    for (const make of [
      chainPuzzle,
      beamPuzzle,
      untanglePuzzle,
      fusePuzzle,
      petsPuzzle,
      chargePuzzle,
      packPuzzle,
      batteryPuzzle,
      voltPuzzle,
      jigsawPuzzle,
      sudokuPuzzle,
      sparkPuzzle,
      storePuzzle,
    ])
      for (const t of TIERS) expect(make(rngOf(`k${t}`), t)).toEqual(make(rngOf(`k${t}`), t));
    expect(slidePuzzle(rngOf("k"), 1)).toEqual(slidePuzzle(rngOf("k"), 1));
  });
});

describe("difficulty: no puzzle is a tap or two away", () => {
  it(`Ланцюг: at least ${MIN_CHAIN_TAPS.join(" / ")} quarter turns; the solution lights everything`, () => {
    for (const k of keys(150))
      for (const t of TIERS) {
        const p = chainPuzzle(rngOf(k), t);
        expect(chainTaps(p)).toBeGreaterThanOrEqual(MIN_CHAIN_TAPS[t]);
        expect(chainPowered(p.n, p.source, p.solution).every(Boolean)).toBe(true);
        expect(chainPowered(p.n, p.source, p.tiles).every(Boolean)).toBe(false);
      }
  });

  it(`Промінь: every panel at once, at least ${MIN_BEAM_FLIPS.join(" / ")} mirrors to turn; following the beam is not enough`, () => {
    for (const k of keys(150))
      for (const t of TIERS) {
        const p = beamPuzzle(rngOf(k), t);
        expect(p.panels).toHaveLength(t + 2);
        expect(traceBeam(p, p.mirrors).hit).toBe(false);
        expect(traceBeam(p, new Map([...p.mirrors, ...p.solution])).hit).toBe(true);
        expect(beamMinFlips(p)).toBeGreaterThanOrEqual(MIN_BEAM_FLIPS[t]);
        expect(beamGreedy(p)).toBe(false);
      }
  });

  it(`Розплутай дроти: at least ${MIN_UNTANGLE_CROSSINGS.join(" / ")} crossings; a clean layout exists`, () => {
    for (const k of keys(150))
      for (const t of TIERS) {
        const p = untanglePuzzle(rngOf(k), t);
        expect(crossingCount(p.edges, p.start)).toBeGreaterThanOrEqual(MIN_UNTANGLE_CROSSINGS[t]);
        expect(crossingCount(p.edges, p.solved)).toBe(0);
      }
  });

  // every puzzle is a search over the whole layout: slow on a shared CI runner
  it(`Винеси генератор: at least ${MIN_SLIDE_MOVES.join(" / ")} moves, and a way out`, {
    timeout: 60_000,
  }, () => {
    for (const k of keys(20))
      for (const t of TIERS) {
        const moves = slideMinMoves(slidePuzzle(rngOf(k), t));
        expect(moves).toBeGreaterThanOrEqual(MIN_SLIDE_MOVES[t]);
      }
  });

  it(`Розклади заряд: at most ${MAX_CHARGE_SOLUTIONS.join(" / ")} ways; plugging in order fails above the easy floors`, () => {
    for (const k of keys(150))
      for (const t of TIERS) {
        const p = chargePuzzle(rngOf(k), t);
        const ways = chargeSolutions(p);
        expect(ways).toBeGreaterThanOrEqual(1);
        expect(ways).toBeLessThanOrEqual(MAX_CHARGE_SOLUTIONS[t]);
        if (t > 0) expect(chargeFirstFit(p)).toBe(false);
      }
  });

  it(`Запобіжник: ${FUSE_HITS.join(" / ")} zones in a row inside the gauge, narrower up the floors`, () => {
    for (const t of TIERS) {
      const p = fusePuzzle(rngOf("x"), t);
      expect(p.zones).toHaveLength(FUSE_HITS[t]);
      // every next zone of the run is narrower
      const widths = p.zones.map(([a, b]) => b - a);
      for (let i = 1; i < widths.length; i++)
        expect(widths[i] as number).toBeLessThan(widths[i - 1] as number);
      for (const [a, b] of p.zones) {
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1);
      }
    }
    const width = (t: Tier) => {
      const [a, b] = fusePuzzle(rngOf("x"), t).zones[0] as [number, number];
      return b - a;
    };
    expect(width(2)).toBeLessThan(width(0));
  });

  it("Кіт чи пес: enough of the chosen animal, and the others to avoid", () => {
    for (const k of keys(40))
      for (const t of TIERS) {
        const p = petsPuzzle(rngOf(k), t);
        const all = p.waves.flat();
        expect(all.filter((s) => s.kind === p.target).length).toBeGreaterThanOrEqual(p.need);
        expect(all.some((s) => s.kind !== p.target)).toBe(true);
      }
  });
  it(`Тривожна валізка: plain items, all different, fill the bag exactly, in at most ${MAX_PACK_SOLUTIONS.join(" / ")} ways`, () => {
    for (const k of keys(100))
      for (const t of TIERS) {
        const p = packPuzzle(rngOf(k), t);
        const cells = p.pieces.reduce((n, piece) => n + piece.cells.length, 0);
        // plain items only: bars, blocks, L corners
        for (const piece of p.pieces) expect(packShapeOf(piece.cells)).not.toBeNull();
        expect(new Set(p.pieces.map((piece) => piece.kind)).size).toBe(p.pieces.length);
        expect(cells).toBe(p.bag.length);
        // the cut it was made from is one packing: each item's cells, turned, are its shape
        expect(new Set(p.cut.keys())).toEqual(new Set(p.bag));
        const ways = packSolutions(p, MAX_PACK_SOLUTIONS[t] + 1);
        expect(ways).toBeGreaterThanOrEqual(1);
        expect(ways).toBeLessThanOrEqual(MAX_PACK_SOLUTIONS[t]);
      }
  });

  it(`Батарейки по зарядках: mixed, sortable, at least ${MIN_BATTERY_MOVES.join(" / ")} pours`, () => {
    for (const k of keys(30))
      for (const t of TIERS) {
        const p = batteryPuzzle(rngOf(k), t);
        expect(p.stacks).toHaveLength(t + 5);
        expect(p.stacks.flat()).toHaveLength((t + 3) * BATTERY_CAP);
        expect(batterySorted(p.stacks)).toBe(false);
        const moves = batteryMinMoves(p);
        // −1: more states than counted, which means plenty of pours
        if (moves !== -1) expect(moves).toBeGreaterThanOrEqual(MIN_BATTERY_MOVES[t]);
        expect(moves).not.toBe(Number.POSITIVE_INFINITY);
      }
  });

  it("Точна напруга: as made, the numbered blocks light the lamp at exactly its voltage; spares look like needed ones", () => {
    for (const k of keys(150))
      for (const t of TIERS) {
        const p = voltPuzzle(rngOf(k), t);
        const s = VOLT_SIZES[t];
        const count = (kind: VoltCell["kind"]) => p.cells.filter((c) => c.kind === kind).length;
        expect(s.n).toBeLessThanOrEqual(5);
        expect(p.cells).toHaveLength(s.n * s.n);
        expect([count("source"), count("lamp")]).toEqual([1, 1]);
        expect(count("block")).toBe(s.fixed + s.fixedOff);
        expect(count("lock")).toBe(s.locks);
        expect(p.blocks).toHaveLength(p.solution.length + s.spare);
        // every block one gets is numbered, a straight wire or a corner
        for (const b of p.blocks) {
          expect(b.value).not.toBe(0);
          expect([...VOLT_STRAIGHT, ...VOLT_CORNER]).toContain(b.ports);
        }
        // the way it was made: each block on a free cell, only turned
        const laid = new Map<number, VoltBlock>();
        for (const x of p.solution) {
          const block = p.blocks[x.block] as VoltBlock;
          expect(p.cells[x.cell]?.kind).toBe("free");
          expect(voltTurns(block.ports)).toContain(x.ports);
          laid.set(x.cell, { ports: x.ports, value: block.value });
        }
        expect(new Set(p.solution.map((x) => x.block)).size).toBe(p.solution.length);
        const trace = voltTrace(p, laid);
        expect(trace).toMatchObject({ lit: true, sum: p.target });
        // it runs through the fixed blocks put on the way
        expect(trace.path.filter((c) => p.cells[c]?.kind === "block")).toHaveLength(s.fixed);
        expect(voltTrace(p, new Map()).lit).toBe(false);
        // a spare: shaped like a needed block, numbered otherwise
        const used = new Set(p.solution.map((x) => x.block));
        const needed = [...used].map((i) => p.blocks[i] as VoltBlock);
        for (const [i, b] of p.blocks.entries())
          if (!used.has(i))
            expect(
              needed.some((x) => voltTurns(x.ports) === voltTurns(b.ports) && x.value !== b.value),
            ).toBe(true);
        if (t > 0) {
          // some number on the way takes voltage away
          const onWay = trace.path.map((c) => {
            const cell = p.cells[c];
            return cell?.kind === "block" ? cell.value : (laid.get(c)?.value ?? 0);
          });
          expect(onWay.some((v) => v < 0)).toBe(true);
          expect(p.target).toBeGreaterThanOrEqual(VOLT_TARGET[0]);
          expect(p.target).toBeLessThanOrEqual(VOLT_TARGET[1]);
        }
      }
  });

  it("Точна напруга: the current runs from the generator through joined cells, adding their numbers", () => {
    // a 3 × 3 board: the generator on the left of the middle row, the lamp on its right, a fixed
    // +2 on top
    const cells: VoltCell[] = Array.from({ length: 9 }, () => ({ kind: "free" }));
    cells[3] = { kind: "source", ports: 2 };
    cells[5] = { kind: "lamp", ports: 8 };
    cells[1] = { kind: "block", ports: 2 | 8, value: 2 };
    const p = { n: 3, cells };
    // a −1 straight across: lit, −1
    expect(voltTrace(p, new Map([[4, { ports: 2 | 8, value: -1 }]]))).toMatchObject({
      lit: true,
      sum: -1,
      path: [3, 4, 5],
    });
    // turned the wrong way: the current stops at the generator
    expect(voltTrace(p, new Map([[4, { ports: 1 | 4, value: -1 }]]))).toMatchObject({
      lit: false,
      path: [3],
    });
    // a corner up to the +2, whose wire runs across: it stops at the corner, having added its 3
    expect(voltTrace(p, new Map([[4, { ports: 8 | 1, value: 3 }]]))).toMatchObject({
      lit: false,
      sum: 3,
      path: [3, 4],
    });
  });

  it("Пазл: n × n pieces, flat round the frame, knobbed inside; neighbours share their edge", () => {
    for (const k of keys(60))
      for (const t of TIERS) {
        const p = jigsawPuzzle(rngOf(k), t);
        const n = JIGSAW_GRID[t];
        const s = JIGSAW_SIZE / n;
        expect(p.n).toBe(n);
        expect(JIGSAW_SCENES).toContain(p.scene);
        expect(JSON.stringify(p.art)).not.toMatch(/NaN|Infinity|null/);
        expect([...p.order].sort((a, b) => a - b)).toEqual([...Array(n * n).keys()]);
        expect(p.art.length).toBeGreaterThan(60);
        expect(p.across).toHaveLength(n + 1);
        expect(p.down).toHaveLength(n);
        for (const [r, line] of p.across.entries()) {
          expect(line).toHaveLength(n);
          for (const e of line) expect(e.knob === 0).toBe(r === 0 || r === n);
        }
        for (const line of p.down) {
          expect(line).toHaveLength(n + 1);
          line.forEach((e, c) => {
            expect(e.knob === 0).toBe(c === 0 || c === n);
          });
        }
        for (let i = 0; i < n * n; i++) {
          const r = Math.floor(i / n);
          const c = i % n;
          // four edges round: 24 curves, starting at the piece's top left corner
          const d = jigsawOutline(p, i);
          expect(d.startsWith(`M${c * s} ${r * s}C`)).toBe(true);
          expect(d.endsWith("Z")).toBe(true);
          expect(d.split("C")).toHaveLength(25);
        }
        // an edge runs between the corners of its cell, its knob within a quarter of a piece
        for (let r = 0; r <= n; r++)
          for (let c = 0; c < n; c++) {
            const e = jigsawEdge(p, "across", r, c);
            expect(e[0]).toEqual([c * s, r * s]);
            expect(e.at(-1)?.[0]).toBeCloseTo((c + 1) * s);
            for (const [, y] of e) expect(Math.abs(y - r * s)).toBeLessThanOrEqual(s * 0.25 * 1.1);
          }
      }
  });

  it("Пазл: every scene comes up, each drawn afresh", () => {
    const seen = new Map<string, Set<string>>();
    for (const k of keys(200)) {
      const p = jigsawPuzzle(rngOf(k), 2);
      const pictures = seen.get(p.scene) ?? new Set();
      pictures.add(JSON.stringify(p.art));
      seen.set(p.scene, pictures);
    }
    expect([...seen.keys()].sort()).toEqual([...JIGSAW_SCENES].sort());
    for (const pictures of seen.values()) expect(pictures.size).toBeGreaterThan(5);
  });

  it("Пазл: pieces lying next to each other as in the picture join; any others lie alone", () => {
    // 3 × 3: piece i belongs at cell i
    const at: (number | null)[] = Array(9).fill(null);
    at[0] = 4;
    at[1] = 5;
    at[3] = 7;
    expect(jigsawGroup(3, at, 0).sort()).toEqual([0, 1, 3]);
    expect(jigsawGroup(3, at, 3).sort()).toEqual([0, 1, 3]);
    // a piece that does not belong there lies next to them all the same, on its own
    at[2] = 3;
    expect(jigsawGroup(3, at, 2)).toEqual([2]);
    expect(jigsawGroup(3, at, 0).sort()).toEqual([0, 1, 3]);
    // off the board, alone; the wrong way round, apart; the end of a row is not next to the next one
    expect(jigsawGroup(3, at, 8)).toEqual([8]);
    expect(jigsawGroup(3, [1, 0, null, null, null, null, null, null, null], 0)).toEqual([0]);
    expect(jigsawGroup(3, [null, null, 2, 3, null, null, null, null, null], 2)).toEqual([2]);
    // all home: one group
    expect(jigsawGroup(3, [...Array(9).keys()], 4)).toHaveLength(9);
  });

  /** A grid's rows, columns and boxes, cells row by row. */
  const sudokuUnits = (n: number, [bh, bw]: readonly [number, number]) => {
    const units: number[][] = [];
    for (let r = 0; r < n; r++) units.push([...Array(n).keys()].map((c) => r * n + c));
    for (let c = 0; c < n; c++) units.push([...Array(n).keys()].map((r) => r * n + c));
    for (let b = 0; b < n; b++) {
      const r0 = Math.floor(b / (n / bw)) * bh;
      const c0 = (b % (n / bw)) * bw;
      units.push([...Array(n).keys()].map((k) => (r0 + Math.floor(k / bw)) * n + c0 + (k % bw)));
    }
    return units;
  };
  /** Solutions counted by trying digits (up to two), apart from the reasoning that made the grid. */
  const sudokuCount = (n: number, box: readonly [number, number], cells: readonly number[]) => {
    const units = sudokuUnits(n, box);
    const of = [...Array(n * n).keys()].map((i) => units.filter((u) => u.includes(i)));
    const grid = cells.slice();
    let found = 0;
    const go = (): void => {
      let best = -1;
      let bestFree: number[] = [];
      for (let i = 0; i < n * n; i++) {
        if (grid[i]) continue;
        const taken = new Set((of[i] as number[][]).flat().map((j) => grid[j]));
        const free = [...Array(n).keys()].map((d) => d + 1).filter((d) => !taken.has(d));
        if (best < 0 || free.length < bestFree.length) [best, bestFree] = [i, free];
      }
      if (best < 0) {
        found++;
        return;
      }
      for (const d of bestFree) {
        grid[best] = d;
        go();
        if (found > 1) break;
      }
      grid[best] = 0;
    };
    go();
    return found;
  };

  it("Судоку: 4 × 4, 6 × 6, 9 × 9; one solution, reached by reasoning; the 9 × 9 takes more than singles", () => {
    const range = [
      [6, 9],
      [11, 15],
      [20, 32],
    ] as const;
    for (const k of keys(30))
      for (const t of TIERS) {
        const p = sudokuPuzzle(rngOf(k), t);
        const { n, box } = p;
        expect(n).toBe(SUDOKU_TIERS[t].n);
        expect(box).toEqual(SUDOKU_TIERS[t].box);
        // the solution keeps the rules; the givens are its digits, in pairs facing across the centre
        for (const unit of sudokuUnits(n, box))
          expect(unit.map((i) => p.solution[i]).sort()).toEqual(
            [...Array(n).keys()].map((d) => d + 1),
          );
        p.givens.forEach((d, i) => {
          if (d) expect(d).toBe(p.solution[i]);
          expect(d > 0).toBe((p.givens[n * n - 1 - i] as number) > 0);
        });
        const count = p.givens.filter(Boolean).length;
        expect(count).toBeGreaterThanOrEqual(range[t][0]);
        expect(count).toBeLessThanOrEqual(range[t][1]);
        expect(sudokuReason(p, p.givens, t === 2)).toEqual(p.solution);
        if (t < 2) expect(sudokuReason(p, p.givens, false)).toEqual(p.solution);
        else expect(sudokuReason(p, p.givens, false)).toBeNull();
        expect(sudokuCount(n, box, p.givens)).toBe(1);
      }
  });

  it("Судоку: reasoning never guesses, nor fills a grid that breaks the rules", () => {
    const p = sudokuPuzzle(rngOf("k"), 2);
    expect(sudokuReason(p, p.solution, false)).toEqual(p.solution);
    expect(sudokuReason(p, Array(81).fill(0), true)).toBeNull();
    const broken = p.givens.slice();
    const i = broken.indexOf(0);
    // the same digit twice in a row
    const row = Math.floor(i / 9);
    const other = [...Array(9).keys()].map((c) => row * 9 + c).find((j) => broken[j]) as number;
    broken[i] = broken[other] as number;
    expect(sudokuReason(p, broken, true)).toBeNull();
  });

  it("Іскра: a zigzag within reach; taps on time reach the lamp, taps too late or too early fall off", () => {
    for (const k of keys(60))
      for (const t of TIERS) {
        const p = sparkPuzzle(rngOf(k), t);
        const tier = SPARK_TIERS[t];
        expect(p.runs).toHaveLength(tier.turns + 1);
        expect(p.runs[0]).toBeGreaterThanOrEqual(3);
        for (const len of p.runs) {
          expect(len).toBeGreaterThanOrEqual(1);
          expect(len).toBeLessThanOrEqual(5);
        }
        const path = sparkPath(p);
        expect(path).toHaveLength(tier.turns + 2);
        for (const [x] of path) expect(Math.abs(x)).toBeLessThanOrEqual(SPARK_REACH);
        // a player tapping at every turn `late` steps after its corner (before it, if below 0)
        const fly = (late: number) => {
          const end = path.at(-1) as [number, number];
          let [x, y] = [0, 0];
          let dir: number = p.first;
          let corner = 1;
          while (y < end[1]) {
            const turn =
              corner < path.length - 1 ? (path[corner] as [number, number])[1] + late : end[1];
            const h = Math.min(0.01, turn - y);
            x += dir * h;
            y += h;
            if (sparkDistance(path, x, y) > p.width / 2) return false;
            if (y >= turn && corner < path.length - 1) {
              dir = -dir;
              corner++;
            }
          }
          return true;
        };
        const slack = sparkSlack(p);
        expect(fly(0)).toBe(true);
        expect(fly(slack * 0.9)).toBe(true);
        expect(fly(-slack * 0.9)).toBe(true);
        expect(fly(slack * 1.1)).toBe(false);
        expect(fly(-slack * 1.1)).toBe(false);
      }
  });

  it("Іскра: the hard wire has few quick double turns, never two in a row", () => {
    let quick = 0;
    for (const k of keys(60)) {
      const p = sparkPuzzle(rngOf(k), 2);
      p.runs.forEach((len, i) => {
        if (len === 1) quick++;
        if (i) expect(len === 1 && p.runs[i - 1] === 1).toBe(false);
      });
    }
    expect(quick / 60).toBeLessThan(4);
  });

  it("Іскра: a turn close to its corner pulls the spark onto the middle; one further off does not", () => {
    for (const k of keys(30))
      for (const t of TIERS) {
        const p = sparkPuzzle(rngOf(k), t);
        const path = sparkPath(p);
        // turned this late (or early): this far off the middle of the next stretch, √2 times
        const near = (SPARK_SNAP * p.width) / Math.SQRT2;
        for (let c = 1; c < path.length - 1; c++) {
          const [cx, cy] = path[c] as [number, number];
          const came = Math.sign(cx - (path[c - 1] as [number, number])[0]);
          for (const [late, pulled] of [
            [0, true],
            [near * 0.9, true],
            [-near * 0.9, true],
            [near * 1.1, false],
            [-near * 1.1, false],
          ] as const)
            expect(sparkSnap(p, path, cx + came * late, cy + late, -came)).toBe(pulled ? c : null);
          // turned the way it came from: no stretch goes there
          expect(sparkSnap(p, path, cx, cy, came)).toBeNull();
        }
      }
  });

  it("Комора: built backwards from the order — its own way through opens the boxes and makes every thing wanted", () => {
    for (const k of keys(60))
      for (const t of TIERS) {
        const p = storePuzzle(rngOf(k), t);
        const tier = STORE_TIERS[t];
        expect([p.rows, p.cols]).toEqual([tier.rows, tier.cols]);
        expect(p.cells).toHaveLength(p.rows * p.cols);
        expect(p.order.map((o) => o.level)).toEqual([...tier.order]);
        // each thing wanted of a kind of its own
        expect(new Set(p.order.map((o) => o.kind)).size).toBe(p.order.length);
        expect(p.boxed).toHaveLength(tier.boxes);
        expect(p.moves).toBe(p.solution.length + tier.slack);
        for (const c of p.boxed) expect(p.cells[c]).not.toBeNull();
        let s = storeStart(p);
        // nothing wanted lying there from the start; something to do
        for (const o of p.order)
          expect(
            s.cells.some((c, i) => !s.boxed.has(i) && c?.kind === o.kind && c.level === o.level),
          ).toBe(false);
        expect(storeStuck(p, s)).toBe(false);
        for (const [from, to] of p.solution) {
          const next = storeMerge(p, s, from, to);
          expect(next).not.toBeNull();
          s = (next as { state: typeof s }).state;
        }
        p.order.forEach((o, slot) => {
          const cell = s.cells.findIndex(
            (c, i) => !s.boxed.has(i) && c?.kind === o.kind && c.level === o.level,
          );
          const next = storeHand(p, s, cell, slot);
          expect(next).not.toBeNull();
          s = next as typeof s;
        });
        expect(s.handed.every(Boolean)).toBe(true);
      }
  });

  it("Комора: only two alike join, out of the boxes and below the top; the boxes round the join open", () => {
    const item = (kind: 0 | 1, level: number): StoreItem => ({ kind, level });
    // 3 × 3: a pair of batteries, a match, a box (a candle in it) beside the middle, two generators
    const p: StorePuzzle = {
      rows: 3,
      cols: 3,
      cells: [
        item(0, 1),
        item(1, 1),
        item(0, 1),
        null,
        null,
        item(1, 2),
        item(0, STORE_LEVELS),
        null,
        item(0, STORE_LEVELS),
      ],
      boxed: [5],
      order: [item(0, 2), item(1, 2)],
      solution: [],
      moves: 1,
    };
    expect(storeAround(p, 4).sort()).toEqual([1, 3, 5, 7]);
    expect(storeAround(p, 0).sort()).toEqual([1, 3]);
    let s = storeStart(p);
    expect(storeMerge(p, s, 0, 1)).toBeNull(); // a battery onto a match
    expect(storeMerge(p, s, 0, 0)).toBeNull(); // onto itself
    expect(storeMerge(p, s, 6, 8)).toBeNull(); // two generators: the top already
    expect(storeHand(p, s, 5, 1)).toBeNull(); // the candle is in its box
    expect(storeStuck(p, s)).toBe(false);
    // the batteries joined at the top right corner: the box below it opens
    const joined = storeMerge(p, s, 0, 2);
    expect(joined?.opened).toEqual([5]);
    s = (joined as { state: typeof s }).state;
    expect(s.cells[2]).toEqual(item(0, 2));
    expect(s.cells[0]).toBeNull();
    // handed in where wanted, not twice, not for the other slot
    expect(storeHand(p, s, 2, 1)).toBeNull();
    s = storeHand(p, s, 2, 0) as typeof s;
    expect(storeHand(p, s, 5, 0)).toBeNull();
    s = storeHand(p, s, 5, 1) as typeof s;
    expect(s.handed).toEqual([true, true]);
    expect(storeStuck(p, s)).toBe(false);
    // a match alone and two generators at the top, the order not in: stuck
    expect(
      storeStuck({ order: [item(1, 3)] }, { cells: p.cells, boxed: new Set([5]), handed: [false] }),
    ).toBe(false);
    expect(
      storeStuck(
        { order: [item(1, 3)] },
        {
          cells: [item(1, 1), null, null, null, null, null, item(0, 5), null, item(0, 5)],
          boxed: new Set(),
          handed: [false],
        },
      ),
    ).toBe(true);
  });
});
