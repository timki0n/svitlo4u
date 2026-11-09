/**
 * The round games of «Вечорниці»: dealt at once to everyone seated (two to six) after a short
 * gathering, played in turns, settled when the game ends — «Дурень», «Кольори», «Блекаут». Each engine stands
 * behind one shape here, so the tables drive them all alike: start, a move, whose clock, leaving,
 * the view, the payout.
 */
import {
  BLACKOUT_MAX,
  type BlackoutCard,
  type BlackoutGame,
  type BlackoutMove,
  type BlackoutView,
  act as blackoutAct,
  forfeit as blackoutForfeit,
  resolve as blackoutResolve,
  waitingFor as blackoutWaitingFor,
  newBlackout,
  viewBlackout,
} from "../evenings/blackout.ts";
import {
  COLORS_MAX,
  type ColorsColor,
  type ColorsGame,
  type ColorsMove,
  type ColorsView,
  act as colorsAct,
  forfeit as colorsForfeit,
  waitingFor as colorsWaitingFor,
  newColors,
  viewColors,
} from "../evenings/colors.ts";
import {
  DURAK_MAX,
  type DurakGame,
  type DurakMove,
  type DurakView,
  act as durakAct,
  forfeit as durakForfeit,
  waitingFor as durakWaitingFor,
  newDurak,
  viewDurak,
} from "../evenings/durak.ts";
import type { EveningMove } from "./evenings.ts";

export type RoundGame = "durak" | "colors" | "blackout";
export type RoundViews = { durak: DurakView; colors: ColorsView; blackout: BlackoutView };
/** «Блекаут»: how long anyone may cancel an action played (the service may shorten it in tests). */
export const NOPE_MS = 4_000;

export type RoundRules<G, V> = {
  /** Most players. */
  max: number;
  /** As the ledger names it. */
  name: string;
  start(ids: number[], rand: () => number): G;
  done(g: G): boolean;
  /** An API move played; throws Error(code) when it is not allowed (or not this game's). */
  act(g: G, id: number, move: EveningMove, rand: () => number): G;
  /** Whose move the clock runs on (null: nobody's). */
  waitingFor(g: G): number | null;
  /** Gives up, or stayed silent: the game as it goes on (or ends). */
  forfeit(g: G, id: number): G;
  /** Whether one leaving now gives up (true), or keeps their seat — already out of play (false). */
  inPlay(g: G, id: number): boolean;
  view(g: G, viewer: number | null): V;
  /** Once over: what each player gets (+) or pays (−), from their stakes. */
  settle(g: G, stakeOf: (id: number) => number): Record<string, number>;
  /**
   * A step the game takes by itself after a while (none: the move's clock runs instead) — in
   * «Блекаут», an action played happens once the window to cancel it is over.
   */
  auto?(g: G): { ms: number; run: (g: G, rand: () => number) => G } | null;
};

const bad = (): never => {
  throw new Error("bad_move");
};

/**
 * «Дурень»: the durak pays everyone else an equal share of their stake, each taking at most their
 * own stake (what is left of it stays with the durak); a draw pays nothing.
 */
const durak: RoundRules<DurakGame, DurakView> = {
  max: DURAK_MAX,
  name: "«Дурень»",
  start: newDurak,
  done: (g) => g.phase === "done",
  act(g, id, move) {
    let m: DurakMove;
    if (move.type === "throw") m = { type: "throw", card: move.card };
    else if (move.type === "beat") m = { type: "beat", card: move.card, target: move.target };
    else if (move.type === "take" || move.type === "done") m = { type: move.type };
    else return bad();
    return durakAct(g, id, m);
  },
  waitingFor: durakWaitingFor,
  forfeit: durakForfeit,
  inPlay: (g, id) => g.players.some((p) => p.id === id && !p.out),
  view: viewDurak,
  settle(g, stakeOf) {
    const pay: Record<string, number> = {};
    if (g.durak === null) return pay;
    const others = g.players.map((p) => p.id).filter((id) => id !== g.durak);
    const share = Math.floor(stakeOf(g.durak) / Math.max(1, others.length));
    let paid = 0;
    for (const id of others) {
      const amount = Math.min(share, stakeOf(id));
      pay[String(id)] = amount;
      paid += amount;
    }
    pay[String(g.durak)] = -paid;
    return pay;
  },
};

const COLOR_CODES = new Set<string>(["r", "y", "g", "b"]);

/** One winner takes from each of the others at most what the winner put in. */
function winnerTakes(
  players: { id: number }[],
  winner: number | null,
  stakeOf: (id: number) => number,
): Record<string, number> {
  const pay: Record<string, number> = {};
  if (winner === null) return pay;
  const top = stakeOf(winner);
  let won = 0;
  for (const p of players) {
    if (p.id === winner) continue;
    const amount = Math.min(stakeOf(p.id), top);
    pay[String(p.id)] = -amount;
    won += amount;
  }
  pay[String(winner)] = won;
  return pay;
}

/** «Кольори»: the winner takes from each of the others at most what the winner put in. */
const colors: RoundRules<ColorsGame, ColorsView> = {
  max: COLORS_MAX,
  name: "«Кольори»",
  start: newColors,
  done: (g) => g.phase === "done",
  act(g, id, move, rand) {
    let m: ColorsMove;
    if (move.type === "play") {
      m = { type: "play", card: move.card };
      if (move.color !== undefined) {
        if (!COLOR_CODES.has(move.color)) return bad();
        m.color = move.color as ColorsColor;
      }
    } else if (move.type === "draw" || move.type === "pass") m = { type: move.type };
    else return bad();
    return colorsAct(g, id, m, rand);
  },
  waitingFor: colorsWaitingFor,
  forfeit: colorsForfeit,
  inPlay: (g, id) => g.players.some((p) => p.id === id && !p.out),
  view: viewColors,
  settle: (g, stakeOf) => winnerTakes(g.players, g.winner, stakeOf),
};

const BLACKOUT_CARDS = new Set<string>(["BL", "GN", "PK", "SH", "SK", "AT", "ST", "NO"]);

/** «Блекаут»: the last one left takes from each of the others at most what they put in. */
const blackout: RoundRules<BlackoutGame, BlackoutView> = {
  max: BLACKOUT_MAX,
  name: "«Блекаут»",
  start: newBlackout,
  done: (g) => g.phase === "done",
  act(g, id, move, rand) {
    let m: BlackoutMove;
    if (move.type === "play") {
      if (!BLACKOUT_CARDS.has(move.card)) return bad();
      m = { type: "play", card: move.card as BlackoutCard };
      if (move.target !== undefined) m.target = move.target;
    } else if (move.type === "draw" || move.type === "nope") m = { type: move.type };
    else if (move.type === "tuck") m = { type: "tuck", at: move.at };
    else return bad();
    return blackoutAct(g, id, m, rand);
  },
  waitingFor: blackoutWaitingFor,
  forfeit: blackoutForfeit,
  inPlay: (g, id) => g.players.some((p) => p.id === id && !p.out),
  view: viewBlackout,
  settle: (g, stakeOf) => winnerTakes(g.players, g.winner, stakeOf),
  auto: (g) => (g.pending ? { ms: NOPE_MS, run: blackoutResolve } : null),
};

export const ROUNDS: { durak: typeof durak; colors: typeof colors; blackout: typeof blackout } = {
  durak,
  colors,
  blackout,
};

/** The rules of a round game, untyped for the tables that hold any of them. */
export function roundRules(game: string): RoundRules<unknown, unknown> | null {
  return game === "durak" || game === "colors" || game === "blackout"
    ? (ROUNDS[game] as unknown as RoundRules<unknown, unknown>)
    : null;
}
