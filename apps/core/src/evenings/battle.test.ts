import { describe, expect, it } from "vitest";
import {
  BATTLE_BLOCKS,
  type BattleBlock,
  cellOf,
  forfeit,
  newBattle,
  randomBlocks,
  ready,
  shoot,
  validBlocks,
  viewBattle,
  waitingFor,
} from "./battle.ts";

/** A seeded generator, so schedules repeat. */
const lcg = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const A = 7;
const B = 8;
/** Monday 00–12, Wednesday 03–12, Friday 06–12, Sunday 00–06 and 15–18. */
const SCHEDULE: BattleBlock[] = [
  { day: 0, from: 0, len: 4 },
  { day: 2, from: 1, len: 3 },
  { day: 4, from: 2, len: 2 },
  { day: 6, from: 0, len: 2 },
  { day: 6, from: 5, len: 1 },
];
const cells = (bs: BattleBlock[]) =>
  bs.flatMap((b) => Array.from({ length: b.len }, (_, i) => cellOf(b.day, b.from + i)));

describe("«Графік»", () => {
  it("schedules: the right blocks, inside the week, never touching", () => {
    expect(validBlocks(SCHEDULE)).toBe(true);
    expect(validBlocks(SCHEDULE.slice(1))).toBe(false); // a block missing
    expect(validBlocks([...SCHEDULE.slice(0, 4), { day: 6, from: 2, len: 1 }])).toBe(false); // touches
    expect(validBlocks([...SCHEDULE.slice(0, 4), { day: 5, from: 1, len: 1 }])).toBe(false); // a corner
    expect(validBlocks([{ ...SCHEDULE[0], from: 6 } as BattleBlock, ...SCHEDULE.slice(1)])).toBe(
      false,
    ); // past midnight
    // the end of one day does not touch the start of the next
    expect(
      validBlocks([
        { day: 0, from: 4, len: 4 },
        { day: 2, from: 0, len: 3 },
        { day: 4, from: 0, len: 2 },
        { day: 4, from: 6, len: 2 },
        { day: 6, from: 0, len: 1 },
      ]),
    ).toBe(true);
    for (let seed = 1; seed < 200; seed++) {
      const blocks = randomBlocks(lcg(seed));
      expect(validBlocks(blocks)).toBe(true);
      expect(blocks.map((b) => b.len)).toEqual([...BATTLE_BLOCKS]);
    }
  });

  it("both get ready, then ring in turn: light passes the turn, an outage rings again", () => {
    let g = newBattle(A, B);
    expect(waitingFor(g)).toEqual([A, B]);
    expect(() => shoot(g, A, 0)).toThrow("not_playing");
    expect(() => ready(g, A, SCHEDULE.slice(1), 0)).toThrow("bad_blocks");
    g = ready(g, A, SCHEDULE, 0);
    expect(g.phase).toBe("placing");
    expect(waitingFor(g)).toEqual([B]);
    g = ready(g, B, SCHEDULE, 1);
    expect(g.phase).toBe("playing");
    expect(waitingFor(g)).toEqual([B]);
    expect(() => shoot(g, A, 0)).toThrow("not_your_turn");

    g = shoot(g, B, cellOf(1, 0)); // Tuesday is light
    expect(g.sides[1].shots).toEqual([{ cell: cellOf(1, 0), hit: false, sunk: false }]);
    expect(waitingFor(g)).toEqual([A]);
    g = shoot(g, A, cellOf(6, 5)); // the one-slot block: found at once
    expect(g.sides[0].shots.at(-1)).toEqual({ cell: cellOf(6, 5), hit: true, sunk: true });
    expect(waitingFor(g)).toEqual([A]);
    g = shoot(g, A, cellOf(4, 2));
    expect(g.sides[0].shots.at(-1)).toMatchObject({ hit: true, sunk: false });
    expect(() => shoot(g, A, cellOf(4, 2))).toThrow("rung_already");
    expect(() => shoot(g, A, 99)).toThrow("bad_cell");
  });

  it("finding every block wins; the view hides what is not found yet", () => {
    let g = ready(ready(newBattle(A, B), A, SCHEDULE, 0), B, SCHEDULE, 0);
    const targets = cells(SCHEDULE);
    for (const c of targets.slice(0, -1)) g = shoot(g, A, c);
    // B's own view: all its blocks; A and spectators: only the blocks found so far
    expect(viewBattle(g, B).sides[1].blocks).toHaveLength(5);
    const seen = viewBattle(g, null).sides[1].blocks;
    // the one-slot block is rung last: the other four are found
    expect(seen.map((b) => b.len).sort()).toEqual([2, 2, 3, 4]);
    expect(viewBattle(g, A).sides[1].blocks).toEqual(seen);
    expect(viewBattle(g, null).turn).toBe(A);
    g = shoot(g, A, targets.at(-1) as number);
    expect(g.phase).toBe("done");
    expect(g.winner).toBe(A);
    expect(viewBattle(g, null).sides[0].blocks).toHaveLength(5); // all shown at the end
    expect(waitingFor(g)).toEqual([]);
  });

  it("whoever goes silent or leaves loses", () => {
    const g = ready(ready(newBattle(A, B), A, SCHEDULE, 0), B, SCHEDULE, 0);
    const lost = forfeit(g, A);
    expect(lost.phase).toBe("done");
    expect(lost.winner).toBe(B);
    expect(forfeit(lost, B).winner).toBe(B); // over is over
    expect(forfeit(newBattle(A, B), B).winner).toBe(A); // even before the first ring
  });
});
