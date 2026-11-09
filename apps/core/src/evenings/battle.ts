/**
 * «Графік» — a game of «Вечорниці» for two. Each hides outage blocks in a week's schedule (days
 * across, 3-hour slots along a day); in turn they «ring» a slot of the other's schedule: light
 * there (a miss, the turn passes), an outage (a hit, ring again), or a whole block found. Who finds
 * every block of the other first wins.
 *
 * Pure state: the core keeps a game in memory, asks it for moves and shows each side its view.
 */

export const BATTLE_DAYS = 7;
/** Slots of a day: 00–03, 03–06, … 21–24. */
export const BATTLE_SLOTS = 8;
/** Outage blocks to hide, in slots. */
export const BATTLE_BLOCKS = [4, 3, 2, 2, 1] as const;

/** A block of outage: a day and the slots from `from` on (they never wrap to the next day). */
export type BattleBlock = { day: number; from: number; len: number };
/** What a ring found: light, an outage, or the last slot of a block (the block is found). */
export type BattleShot = { cell: number; hit: boolean; sunk: boolean };

type Side = {
  id: number;
  /** Hidden blocks; null until the side is ready. */
  blocks: BattleBlock[] | null;
  /** Slots this side rang on the other's schedule, in order. */
  shots: BattleShot[];
};
export type BattleGame = {
  sides: [Side, Side];
  phase: "placing" | "playing" | "done";
  /** Whose ring it is (index into sides) while playing. */
  turn: 0 | 1;
  winner: number | null;
};

export const cellOf = (day: number, slot: number): number => day * BATTLE_SLOTS + slot;
const cellsOf = (b: BattleBlock): number[] =>
  Array.from({ length: b.len }, (_, i) => cellOf(b.day, b.from + i));

/** Blocks in the schedule, of the right lengths, apart from each other (not even corners touch). */
export function validBlocks(blocks: readonly BattleBlock[]): boolean {
  const lens = blocks.map((b) => b.len).sort((x, y) => y - x);
  if (lens.join() !== [...BATTLE_BLOCKS].sort((x, y) => y - x).join()) return false;
  const taken = new Set<number>();
  for (const b of blocks) {
    if (b.day < 0 || b.day >= BATTLE_DAYS || b.from < 0 || b.from + b.len > BATTLE_SLOTS)
      return false;
    for (let d = b.day - 1; d <= b.day + 1; d++)
      for (let s = b.from - 1; s <= b.from + b.len; s++)
        if (d >= 0 && d < BATTLE_DAYS && s >= 0 && s < BATTLE_SLOTS && taken.has(cellOf(d, s)))
          return false;
    for (const c of cellsOf(b)) taken.add(c);
  }
  return true;
}

/** A random schedule of blocks (the player may shuffle it again before getting ready). */
export function randomBlocks(rand: () => number): BattleBlock[] {
  for (;;) {
    const blocks: BattleBlock[] = [];
    let ok = true;
    for (const len of BATTLE_BLOCKS) {
      let placed = false;
      for (let tries = 0; tries < 200 && !placed; tries++) {
        const b = {
          day: Math.floor(rand() * BATTLE_DAYS),
          from: Math.floor(rand() * (BATTLE_SLOTS - len + 1)),
          len,
        };
        if (validPartial([...blocks, b])) {
          blocks.push(b);
          placed = true;
        }
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return blocks;
  }
}

/** Like validBlocks, for a schedule still being filled. */
function validPartial(blocks: readonly BattleBlock[]): boolean {
  const taken = new Set<number>();
  for (const b of blocks) {
    for (let d = b.day - 1; d <= b.day + 1; d++)
      for (let s = b.from - 1; s <= b.from + b.len; s++)
        // off the schedule nothing can touch (and slot 8 of a day is not slot 0 of the next)
        if (d >= 0 && d < BATTLE_DAYS && s >= 0 && s < BATTLE_SLOTS && taken.has(cellOf(d, s)))
          return false;
    for (const c of cellsOf(b)) taken.add(c);
  }
  return true;
}

export function newBattle(a: number, b: number): BattleGame {
  return {
    sides: [
      { id: a, blocks: null, shots: [] },
      { id: b, blocks: null, shots: [] },
    ],
    phase: "placing",
    turn: 0,
    winner: null,
  };
}

const sideOf = (g: BattleGame, id: number): 0 | 1 => {
  if (g.sides[0].id === id) return 0;
  if (g.sides[1].id === id) return 1;
  throw new Error("not_playing");
};

/** A side is ready with its blocks; once both are, the one `first` rings first. */
export function ready(
  g: BattleGame,
  id: number,
  blocks: readonly BattleBlock[],
  first: 0 | 1,
): BattleGame {
  if (g.phase !== "placing") throw new Error("not_placing");
  if (!validBlocks(blocks)) throw new Error("bad_blocks");
  const i = sideOf(g, id);
  const sides = structuredClone(g.sides);
  sides[i].blocks = blocks.map((b) => ({ ...b }));
  const both = sides[0].blocks !== null && sides[1].blocks !== null;
  return { ...g, sides, phase: both ? "playing" : "placing", turn: both ? first : g.turn };
}

/** Ring a slot of the other's schedule. */
export function shoot(g: BattleGame, id: number, cell: number): BattleGame {
  if (g.phase !== "playing") throw new Error("not_playing");
  const i = sideOf(g, id);
  if (g.turn !== i) throw new Error("not_your_turn");
  if (!Number.isInteger(cell) || cell < 0 || cell >= BATTLE_DAYS * BATTLE_SLOTS)
    throw new Error("bad_cell");
  const me = g.sides[i];
  if (me.shots.some((s) => s.cell === cell)) throw new Error("rung_already");
  const other = g.sides[i === 0 ? 1 : 0];
  const block = (other.blocks ?? []).find((b) => cellsOf(b).includes(cell));
  const rung = new Set([...me.shots.map((s) => s.cell), cell]);
  const sunk = block !== undefined && cellsOf(block).every((c) => rung.has(c));
  const sides = structuredClone(g.sides);
  sides[i].shots.push({ cell, hit: block !== undefined, sunk });
  const found = (other.blocks ?? []).every((b) => cellsOf(b).every((c) => rung.has(c)));
  if (found) return { ...g, sides, phase: "done", winner: id };
  // a hit rings again; light passes the turn
  return { ...g, sides, turn: block ? g.turn : g.turn === 0 ? 1 : 0 };
}

/** A side gave up or went silent: the other wins. */
export function forfeit(g: BattleGame, id: number): BattleGame {
  if (g.phase === "done") return g;
  const i = sideOf(g, id);
  return { ...g, phase: "done", winner: g.sides[i === 0 ? 1 : 0].id };
}

/** Whose move it is now: both while placing (those not ready), one while playing, none after. */
export function waitingFor(g: BattleGame): number[] {
  if (g.phase === "placing") return g.sides.filter((s) => s.blocks === null).map((s) => s.id);
  if (g.phase === "playing") return [g.sides[g.turn].id];
  return [];
}

export type BattleSideView = {
  id: number;
  ready: boolean;
  /** Own blocks for the side itself; everyone's when the game is over; else the found ones. */
  blocks: BattleBlock[];
  shots: BattleShot[];
};
export type BattleView = {
  phase: BattleGame["phase"];
  turn: number | null;
  winner: number | null;
  sides: [BattleSideView, BattleSideView];
};

/** What a player (or a spectator, null) may see: hidden blocks stay hidden until found. */
export function viewBattle(g: BattleGame, viewer: number | null): BattleView {
  const view = (i: 0 | 1): BattleSideView => {
    const s = g.sides[i];
    const rival = g.sides[i === 0 ? 1 : 0];
    const rung = new Set(rival.shots.map((x) => x.cell));
    const blocks = s.blocks ?? [];
    const shown =
      g.phase === "done" || s.id === viewer
        ? blocks
        : blocks.filter((b) => cellsOf(b).every((c) => rung.has(c)));
    return { id: s.id, ready: s.blocks !== null, blocks: shown, shots: s.shots };
  };
  return {
    phase: g.phase,
    turn: g.phase === "playing" ? g.sides[g.turn].id : null,
    winner: g.winner,
    sides: [view(0), view(1)],
  };
}
