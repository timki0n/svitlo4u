/**
 * The window games and which one a window holds. A window's game, its layout and difficulty come
 * from «outage + window» alone, so every neighbour meets the same puzzle there.
 */
import {
  type Cleanup,
  type GameCtx,
  mountBatteries,
  mountBeam,
  mountChain,
  mountCharge,
  mountFuse,
  mountJigsaw,
  mountMemo,
  mountPack,
  mountPets,
  mountSlide,
  mountSpark,
  mountStore,
  mountSudoku,
  mountUntangle,
  mountVolt,
} from "./mount.ts";
import {
  batteryPuzzle,
  beamPuzzle,
  chainPuzzle,
  chargePuzzle,
  fusePuzzle,
  jigsawPuzzle,
  memoPuzzle,
  packPuzzle,
  petsPuzzle,
  slidePuzzle,
  sparkPuzzle,
  storePuzzle,
  sudokuPuzzle,
  type Tier,
  tierOf,
  untanglePuzzle,
  voltPuzzle,
} from "./puzzles.ts";
import { type Rng, ri, rngOf } from "./rng.ts";

export type GameDef = {
  id: string;
  name: string;
  start(root: HTMLElement, key: string, tier: Tier, ctx: GameCtx): Cleanup;
};

function game<P>(
  id: string,
  name: string,
  make: (rng: Rng, tier: Tier) => P,
  mount: (root: HTMLElement, puzzle: P, ctx: GameCtx) => Cleanup,
): GameDef {
  return {
    id,
    name,
    start: (root, key, tier, ctx) => mount(root, make(rngOf(`${key}:${id}`), tier), ctx),
  };
}

export const GAMES: readonly GameDef[] = [
  game("chain", "Ланцюг", chainPuzzle, mountChain),
  game("beam", "Промінь", beamPuzzle, mountBeam),
  game("untangle", "Розплутай дроти", untanglePuzzle, mountUntangle),
  game("fuse", "Запобіжник", fusePuzzle, mountFuse),
  game("pets", "Кіт чи пес", petsPuzzle, mountPets),
  game("slide", "Винеси генератор", slidePuzzle, mountSlide),
  game("charge", "Розклади заряд", chargePuzzle, mountCharge),
  game("pack", "Тривожна валізка", packPuzzle, mountPack),
  game("batteries", "Батарейки по зарядках", batteryPuzzle, mountBatteries),
  game("volt", "Точна напруга", voltPuzzle, mountVolt),
  game("jigsaw", "Пазл", jigsawPuzzle, mountJigsaw),
  game("sudoku", "Судоку", sudokuPuzzle, mountSudoku),
  game("spark", "Іскра", sparkPuzzle, mountSpark),
  game("store", "Комора", storePuzzle, mountStore),
  game("memo", "Запам'яталка", memoPuzzle, mountMemo),
];

export const TIER_LABEL = ["легкий рівень", "середній рівень", "важкий рівень"] as const;

export type WindowGame = { key: string; game: GameDef; tier: Tier };

export function windowGame(outage: string, floor: number, col: number): WindowGame {
  const key = `${outage}:${floor}-${col}`;
  const index = ri(rngOf(key), GAMES.length);
  return { key, game: GAMES[index] as GameDef, tier: tierOf(floor) };
}

/** A part of a door of «Вечорниці»: one of the window games, always on the hard level. */
export function partGame(outage: string, door: number, part: number): WindowGame {
  const key = `${outage}:door${door}-${part}`;
  const index = ri(rngOf(key), GAMES.length);
  return { key, game: GAMES[index] as GameDef, tier: 2 };
}
