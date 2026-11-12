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
  slideMinMoves,
  slidePuzzle,
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
});
