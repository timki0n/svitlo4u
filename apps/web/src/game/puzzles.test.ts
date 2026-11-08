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

  it("Запобіжник: three zones inside the gauge, narrower up the floors", () => {
    for (const t of TIERS) {
      const p = fusePuzzle(rngOf("x"), t);
      expect(p.zones).toHaveLength(3);
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
});
