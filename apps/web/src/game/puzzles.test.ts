import { describe, expect, it } from "vitest";
import { GAMES, windowGame } from "./games.ts";
import {
  beamPuzzle,
  chainPowered,
  chainPuzzle,
  chargePuzzle,
  crossingEdges,
  fusePuzzle,
  petsPuzzle,
  slidePuzzle,
  slideSolvable,
  type Tier,
  tierOf,
  traceBeam,
  untanglePuzzle,
} from "./puzzles.ts";
import { rngOf } from "./rng.ts";

const TIERS: Tier[] = [0, 1, 2];
/** Many windows of a few outages: every generator, every tier. */
const keys = (count: number) =>
  Array.from({ length: count }, (_, i) => `o179400${i % 7}000000:${2 + (i % 26)}-${1 + (i % 8)}`);

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

  it("Ланцюг: deterministic, scrambled, and its solution powers every tile", () => {
    for (const k of keys(60))
      for (const t of TIERS) {
        const p = chainPuzzle(rngOf(k), t);
        expect(chainPuzzle(rngOf(k), t)).toEqual(p);
        expect(chainPowered(p.n, p.source, p.solution).every(Boolean)).toBe(true);
        expect(chainPowered(p.n, p.source, p.tiles).every(Boolean)).toBe(false);
      }
  });

  it("Промінь: the solution mirrors take the beam to the panel, the start does not", () => {
    for (const k of keys(60))
      for (const t of TIERS) {
        const p = beamPuzzle(rngOf(k), t);
        expect(traceBeam(p, p.solution).hit).toBe(true);
        expect(traceBeam(p, p.mirrors).hit).toBe(false);
      }
  });

  it("Розплутай дроти: starts tangled, a layout without crossings exists", () => {
    for (const k of keys(40))
      for (const t of TIERS) {
        const p = untanglePuzzle(rngOf(k), t);
        expect(crossingEdges(p.edges, p.solved).size).toBe(0);
        expect(crossingEdges(p.edges, p.start).size).toBeGreaterThan(0);
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

  it("Винеси генератор: blocked at the start, a way out exists", () => {
    for (const k of keys(12))
      for (const t of TIERS) {
        const p = slidePuzzle(rngOf(k), t);
        expect(p.blocks[0]?.c).toBeLessThan(p.n - 2);
        expect(slideSolvable(p)).toBe(true);
      }
  });

  it("Розклади заряд: the intended split fits every bank in charge and ports", () => {
    for (const k of keys(60))
      for (const t of TIERS) {
        const p = chargePuzzle(rngOf(k), t);
        p.banks.forEach((bank, b) => {
          const mine = p.devices.filter((_, i) => p.home[i] === b);
          expect(mine.reduce((s, d) => s + d.need, 0)).toBeLessThanOrEqual(bank.cap);
          expect(mine.length).toBeLessThanOrEqual(bank.ports.length);
          expect(mine.filter((d) => d.usbC).length).toBeLessThanOrEqual(
            bank.ports.filter((port) => port === "C").length,
          );
        });
        if (t === 2) {
          const total = p.banks.reduce((s, b) => s + b.cap, 0);
          expect(p.devices.reduce((s, d) => s + d.need, 0)).toBe(total);
        }
      }
  });
});
