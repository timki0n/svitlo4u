/**
 * «Вечорниці»: the five doors on the ground floor of the facade. A door opens in a session (an
 * outage) once three different players have each passed one of its three parts — a hard puzzle,
 * 50 points each. Behind an open door stands one table of its game, played for the points of the
 * session: «Графік» for two, poker for two to six, and the round games for two to six (dealt
 * at once after a short gathering: «Дурень», «Кольори», «Блекаут» — see rounds.ts). Anyone may
 * watch live.
 *
 * Stakes come only from the player's points of the current session, never below zero: what sits
 * on tables is set aside. «Графік»: each picks a stake; the winner takes from the loser at most
 * the smaller one. Poker: a cash table — chips bought with points, each hand paid as it ends (side
 * pots keep «from each, at most what you put in»). The round games settle at their end, each by
 * its own rule (rounds.ts), never taking from anyone more than their stake.
 *
 * Tables live in memory: a restart ends them (a game not over pays nothing; poker hands played
 * are already paid). A game under way when the next outage starts is played out, and paid in the
 * session it began in.
 */
import { randomInt } from "node:crypto";
import type { Store } from "@svitlo/storage";
import {
  BATTLE_BLOCKS,
  BATTLE_DAYS,
  BATTLE_SLOTS,
  type BattleBlock,
  type BattleGame,
  type BattleView,
  forfeit,
  newBattle,
  randomBlocks,
  ready,
  shoot,
  viewBattle,
  waitingFor,
} from "../evenings/battle.ts";
import type { BlackoutView } from "../evenings/blackout.ts";
import type { ColorsView } from "../evenings/colors.ts";
import type { DurakView } from "../evenings/durak.ts";
import {
  type PokerAction,
  type PokerHand,
  type PokerResult,
  act as pokerAct,
  legal as pokerLegal,
  viewFor as pokerView,
  startHand,
} from "../evenings/poker.ts";
import type { Clock } from "../runtime/clock.ts";
import { type GamePlayerView, type GameService, PRESENCE_MS } from "./game.ts";
import { CALL_MS, HOLD_MS, NOPE_MS, ROUNDS, roundRules } from "./rounds.ts";

export const EVENING_DOORS = 5;
export const EVENING_PARTS = 3;
export const EVENING_PART_POINTS = 50;
export const EVENING_GAMES = ["battle", "poker", "durak", "colors", "blackout"] as const;
export type EveningGame = (typeof EVENING_GAMES)[number];
/** The least a player may bring to a table. */
export const EVENING_MIN_STAKE: Record<EveningGame, number> = {
  battle: 10,
  poker: 20,
  durak: 10,
  colors: 10,
  blackout: 10,
};
export const POKER_BLINDS = { small: 1, big: 2 };
export const POKER_SEATS = 6;
/** Seats at a table, by its game. */
const ROOM: Record<EveningGame, number> = {
  battle: 2,
  poker: POKER_SEATS,
  durak: ROUNDS.durak.max,
  colors: ROUNDS.colors.max,
  blackout: ROUNDS.blackout.max,
};
/** Silent this long on a move: «Графік» and a round game are lost, a poker hand folded (and the
 *  seat left). */
export const EVENING_TURN_MS = 90_000;
/** A round game starts this long after the second player sits down (at once with a full table). */
const LOBBY_MS = 15_000;
/** A part's puzzle solved faster than this after opening it does not count. */
const PART_MIN_MS = 3_000;
const LONG_POLL_MS = 25_000;
/** The pause after a hand: long enough to read the showdown on a phone. */
const BETWEEN_HANDS_MS = 6_000;
const RESULT_SHOWN_MS = 8_000;
/**
 * One is in the room while their screen holds a request for the table open (it asks again at once
 * after each answer); none open this long, they left it.
 */
const GONE_MS = 10_000;
/**
 * The emojis a player at a table may send (one watching too, while a game is played): each rises
 * over their face on every screen.
 */
export const EVENING_EMOTES = ["👍", "😂", "😎", "😱", "😢", "😡", "🤔", "🔥"] as const;
export type EveningEmote = (typeof EVENING_EMOTES)[number];
/** What one watching may say while the table gathers (no game under way), over their face too. */
export const EVENING_PHRASES = [
  "Привіт!",
  "Граєм?",
  "ГО!",
  "Я все.",
  "В іншу гру!",
  "Удачі!",
  "Скоро буду!",
  "Дякую за гру!",
  "Було весело!",
] as const;
export type EveningPhrase = (typeof EVENING_PHRASES)[number];
export type EveningReaction = EveningEmote | EveningPhrase;
/** How long a reaction sent stays in the view (screens show it once, as it comes). */
const EMOTE_MS = 4_000;
/** One's reactions: at most one this often. */
const EMOTE_GAP_MS = 1_000;

const rand = () => randomInt(0, 2 ** 30) / 2 ** 30;

/**
 * The doors' games in a session, seeded by it: every game at least once, the rest at random — the
 * same for everyone, known before the doors open.
 */
export function doorGames(session: number): EveningGame[] {
  let a = (Math.abs(session) % 2 ** 32) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const games: EveningGame[] = [...EVENING_GAMES];
  while (games.length < EVENING_DOORS)
    games.push(EVENING_GAMES[Math.floor(next() * EVENING_GAMES.length)] as EveningGame);
  for (let i = games.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [games[i], games[j]] = [games[j] as EveningGame, games[i] as EveningGame];
  }
  return games.slice(0, EVENING_DOORS);
}

export type EveningDoor = {
  door: number;
  game: EveningGame;
  /** Who opened each part (null: still closed). */
  parts: (number | null)[];
  /** Who is opening each part right now (its puzzle open on their phone), as windows show it. */
  opening: number[][];
  open: boolean;
  /** Seated players, in seat order. */
  players: number[];
  /** A game is being played right now. */
  live: boolean;
  watchers: number;
};
export type EveningsOverview = { session: number | null; doors: EveningDoor[] };

export type EveningSeat = { id: number; stake: number; leaving: boolean };
/** A round game's table: the game under way (or just over; null while players gather) and, once
 *  over, what each player got (+) or paid (−). */
export type RoundTableView<V> = { game: V | null; pay: Record<string, number> | null };
export type EveningTableView = {
  version: number;
  door: number;
  game: EveningGame;
  open: boolean;
  now: number;
  /** When the move under way runs out (null: nobody's move). */
  deadline: number | null;
  minStake: number;
  /** Points of the session the viewer may still bring to a table. */
  available: number;
  seats: EveningSeat[];
  queue: number[];
  /** Who watches the table (not sitting at it), the first to come first. */
  watchers: number[];
  /** A game (a hand) is under way: one watching sends emojis now, phrases otherwise. */
  live: boolean;
  me: { id: number; seated: boolean; queued: boolean };
  battle:
    | (BattleView & {
        draft: BattleBlock[] | null;
        days: number;
        slots: number;
        /** Blocks each hides. */
        total: number;
      })
    | null;
  poker: {
    hand: Omit<PokerHand, "deck"> | null;
    /** The viewer's choices when it is their move. */
    legal: ReturnType<typeof pokerLegal> | null;
    handNo: number;
    blinds: typeof POKER_BLINDS;
  } | null;
  durak: RoundTableView<DurakView> | null;
  colors: RoundTableView<ColorsView> | null;
  blackout: RoundTableView<BlackoutView> | null;
  /**
   * Reactions sent in the last few seconds (an emoji, or a phrase of one watching): `n` tells each
   * apart (screens show each once).
   */
  emotes: { n: number; id: number; emoji: EveningReaction; at: number }[];
  /** The last game or hand that ended, for a moment. */
  result: {
    winners: number[];
    text: string;
    at: number;
    /** What each player got (+) or paid (−): the screens fly the points across. */
    pay: Record<string, number>;
  } | null;
  players: Record<string, GamePlayerView>;
};

export type EveningTimings = {
  /** A move's time (see EVENING_TURN_MS). */
  turnMs: number;
  /** The pause between poker hands. */
  betweenHandsMs: number;
  /** How long a finished «Графік» or round game stays on the table. */
  resultMs: number;
  /** Round games: the wait for more players once two sit (see LOBBY_MS). */
  lobbyMs: number;
  /** «Блекаут»: the window to cancel an action (see NOPE_MS). */
  nopeMs: number;
  /** «Дурень»: a bout nobody may add to, shown before it closes (see HOLD_MS). */
  holdMs: number;
  /** «Дурень»: the attacker's time to add or call «Бито» (see CALL_MS). */
  callMs: number;
  /** One whose screen has no request open this long has left the room (see GONE_MS). */
  goneMs: number;
};
export type EveningsDeps = {
  store: Store;
  clock: Clock;
  game: GameService;
  timings?: Partial<EveningTimings>;
};

type Seat = EveningSeat & { silent: number };
/** A part's puzzle on someone's phone: when they first opened it, when the phone last checked in. */
type Opening = { at: number; seen: number };
/** A screen on the table: its requests open, when one last opened or closed, the timer to drop it. */
type Watcher = { open: number; last: number; gone: ReturnType<typeof setTimeout> | null };
type Table = {
  site: string;
  door: number;
  game: EveningGame;
  /** The session it is played (and paid) in. */
  session: number;
  version: number;
  seats: Seat[];
  queue: { id: number; stake: number }[];
  battle: { game: BattleGame; drafts: Map<number, BattleBlock[]> } | null;
  poker: { hand: PokerHand | null; button: number; handNo: number };
  /** A round game (rounds.ts) under way or just over. */
  round: { game: unknown; pay: Record<string, number> | null } | null;
  result: EveningTableView["result"];
  emotes: EveningTableView["emotes"];
  deadline: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Set<() => void>;
  /** Everyone whose screen is on the table, seated or not, the first to come first. */
  watchers: Map<number, Watcher>;
};

export class EveningError extends Error {}
const fail = (code: string): never => {
  throw new EveningError(code);
};

export class EveningService {
  private readonly deps: EveningsDeps;
  /** site → door → table */
  private readonly tables = new Map<string, Map<number, Table>>();
  /** site → "session:door-part" → player → their part's puzzle: when first opened, last seen */
  private readonly opened = new Map<string, Map<string, Map<number, Opening>>>();

  private readonly timings: EveningTimings;

  constructor(deps: EveningsDeps) {
    this.deps = deps;
    this.timings = {
      turnMs: EVENING_TURN_MS,
      betweenHandsMs: BETWEEN_HANDS_MS,
      resultMs: RESULT_SHOWN_MS,
      lobbyMs: LOBBY_MS,
      nopeMs: NOPE_MS,
      holdMs: HOLD_MS,
      callMs: CALL_MS,
      goneMs: GONE_MS,
      ...deps.timings,
    };
  }

  /** Every pending timer off (the core stops). */
  stop(): void {
    for (const doors of this.tables.values())
      for (const t of doors.values()) {
        if (t.timer) clearTimeout(t.timer);
        for (const w of t.watchers.values()) if (w.gone) clearTimeout(w.gone);
      }
  }

  overview(siteId: string): EveningsOverview {
    const session = this.deps.game.session(siteId)?.start ?? null;
    const now = this.deps.clock.now();
    const games = session === null ? [] : doorGames(session);
    const unlocks = session === null ? [] : this.deps.store.game.unlocks(siteId, session);
    const doors = games.map((game, i): EveningDoor => {
      const door = i + 1;
      const parts = Array.from(
        { length: EVENING_PARTS },
        (_, p) => unlocks.find((u) => u.door === door && u.part === p + 1)?.userId ?? null,
      );
      const table = this.tables.get(siteId)?.get(door);
      const opening = parts.map((by, p) =>
        by !== null || session === null ? [] : this.opening(siteId, session, door, p + 1, now),
      );
      return {
        door,
        game: table?.game ?? game,
        parts,
        opening,
        open: parts.every((p) => p !== null),
        players: table?.seats.map((s) => s.id) ?? [],
        live: table ? this.live(table) : false,
        watchers: table ? this.watching(table, now).length : 0,
      };
    });
    return { session, doors };
  }

  // ── the doors' parts ────────────────────────────────────────────────────────────────────────

  /**
   * Opened a part's puzzle, or still at it (the phone checks in, as on a window): the others see
   * the part being opened. The first opening counts for how fast it was solved.
   */
  partStart(siteId: string, userId: number, door: number, part: number): void {
    const { session } = this.partCheck(siteId, userId, door, part);
    const parts = this.opened.get(siteId) ?? new Map<string, Map<number, Opening>>();
    this.opened.set(siteId, parts);
    const players = parts.get(`${session}:${door}-${part}`) ?? new Map<number, Opening>();
    parts.set(`${session}:${door}-${part}`, players);
    const now = this.deps.clock.now();
    players.set(userId, { at: players.get(userId)?.at ?? now, seen: now });
  }

  /** Left a part's puzzle unsolved: no longer opening it (the first opening still counts). */
  partLeave(siteId: string, userId: number, door: number, part: number): void {
    const session = this.deps.game.session(siteId)?.start;
    if (session === undefined) return;
    const mine = this.opened.get(siteId)?.get(`${session}:${door}-${part}`)?.get(userId);
    if (mine) mine.seen = Number.NEGATIVE_INFINITY;
  }

  /** Who has a part's puzzle open now: their phone checked in lately. */
  private opening(siteId: string, session: number, door: number, part: number, now: number) {
    const players = this.opened.get(siteId)?.get(`${session}:${door}-${part}`);
    return [...(players ?? [])].filter(([, o]) => now - o.seen <= PRESENCE_MS).map(([id]) => id);
  }

  /** The part's puzzle solved: the part opens, 50 points. */
  partSolve(siteId: string, userId: number, door: number, part: number): { points: number } {
    const { session } = this.partCheck(siteId, userId, door, part);
    const now = this.deps.clock.now();
    const players = this.opened.get(siteId)?.get(`${session}:${door}-${part}`);
    const started = players?.get(userId)?.at;
    if (started === undefined) fail("start_first");
    if (now - (started as number) < PART_MIN_MS) fail("too_fast");
    const { store } = this.deps;
    if (!store.game.unlock({ siteId, session, door, part, userId, unlockedAt: now })) fail("taken");
    store.game.addLedger({
      siteId,
      session,
      userId,
      points: EVENING_PART_POINTS,
      kind: "door",
      ref: `двері ${door}, частина ${part}`,
      at: now,
    });
    players?.delete(userId);
    return { points: EVENING_PART_POINTS };
  }

  private partCheck(siteId: string, userId: number, door: number, part: number) {
    const session = this.deps.game.session(siteId)?.start;
    if (session === undefined) fail("no_session");
    if (door < 1 || door > EVENING_DOORS || part < 1 || part > EVENING_PARTS) fail("bad_door");
    const unlocks = this.deps.store.game.unlocks(siteId, session as number);
    if (unlocks.some((u) => u.door === door && u.part === part)) fail("taken");
    if (unlocks.some((u) => u.door === door && u.userId === userId)) fail("one_part_each");
    return { session: session as number };
  }

  // ── tables ──────────────────────────────────────────────────────────────────────────────────

  /** Points of the session the player may still bring: theirs, less what sits on tables. */
  available(siteId: string, userId: number): number {
    const session = this.deps.game.session(siteId)?.start;
    if (session === undefined) return 0;
    const mine =
      this.deps.store.game.totals(siteId, { session }).find((t) => t.userId === userId)?.points ??
      0;
    let held = 0;
    for (const t of this.tables.get(siteId)?.values() ?? [])
      if (t.session === session) for (const s of t.seats) if (s.id === userId) held += s.stake;
    return Math.max(0, mine - held);
  }

  /** Sit at the door's table with a stake (poker: chips), or queue for a seat. */
  join(siteId: string, userId: number, door: number, stake: number): void {
    const session = this.deps.game.session(siteId)?.start;
    if (session === undefined) fail("no_session");
    const overview = this.overview(siteId).doors[door - 1];
    if (!overview) fail("bad_door");
    if (!overview?.open) fail("closed");
    for (const t of this.tables.get(siteId)?.values() ?? [])
      if (t.seats.some((s) => s.id === userId) || t.queue.some((q) => q.id === userId))
        fail("at_a_table");
    const game = overview?.game as EveningGame;
    if (!Number.isInteger(stake) || stake < EVENING_MIN_STAKE[game]) fail("stake_too_small");
    if (stake > this.available(siteId, userId)) fail("not_enough_points");
    const table = this.table(siteId, door, game, session as number);
    // «Графік» and the round games take new players only between games
    const busy =
      game === "battle" ? table.battle !== null : roundRules(game) ? table.round !== null : false;
    if (table.seats.length < ROOM[game] && !busy)
      table.seats.push({ id: userId, stake, leaving: false, silent: 0 });
    else table.queue.push({ id: userId, stake });
    this.advance(table);
  }

  /** Leave the table or the queue: «Графік» or a round game under way is lost, a poker hand folded. */
  leave(siteId: string, userId: number, door: number): void {
    const table = this.tables.get(siteId)?.get(door);
    if (!table) return;
    table.queue = table.queue.filter((q) => q.id !== userId);
    const seat = table.seats.find((s) => s.id === userId);
    if (seat) {
      const rules = roundRules(table.game);
      if (rules) {
        const r = table.round;
        if (r && !rules.done(r.game)) {
          // one still in play gives up; one already out of it keeps their seat till the end
          if (rules.inPlay(r.game, userId)) {
            r.game = rules.forfeit(r.game, userId);
            this.roundNext(table);
          }
          return;
        }
        // not begun yet (or over): nobody pays
        if (!r) table.seats = table.seats.filter((s) => s.id !== userId);
      } else if (table.game === "battle") {
        const b = table.battle;
        if (b && b.game.phase === "playing") {
          b.game = forfeit(b.game, userId);
          this.battleOver(table);
          return;
        }
        // not begun yet: nobody pays
        if (b && b.game.phase === "placing") {
          table.battle = null;
          this.deadline(table, null);
        }
        table.seats = table.seats.filter((s) => s.id !== userId);
      } else {
        const hand = table.poker.hand;
        const inHand = hand?.street !== "done" && hand?.seats.some((s) => s.id === userId);
        if (inHand) {
          seat.leaving = true;
          if (hand?.turn != null && hand.seats[hand.turn]?.id === userId)
            this.pokerMove(table, userId, { type: "fold" });
        } else table.seats = table.seats.filter((s) => s.id !== userId);
      }
    }
    this.advance(table);
  }

  /**
   * A move: «Графік» — shuffle, ready, ring; poker — fold, check, call, raise; «Дурень» — throw,
   * beat, take, done; «Кольори» — play, draw, pass.
   */
  act(siteId: string, userId: number, door: number, move: EveningMove): void {
    const table = this.tables.get(siteId)?.get(door);
    if (!table?.seats.some((s) => s.id === userId)) fail("not_seated");
    const t = table as Table;
    try {
      if (t.game === "battle") this.battleMove(t, userId, move);
      else if (roundRules(t.game)) this.roundMove(t, userId, move);
      else if (move.type === "fold" || move.type === "check" || move.type === "call")
        this.pokerMove(t, userId, { type: move.type });
      else if (move.type === "raise") this.pokerMove(t, userId, { type: "raise", to: move.to });
      else fail("bad_move");
    } catch (e) {
      if (e instanceof EveningError) throw e;
      throw new EveningError(e instanceof Error ? e.message : "bad_move");
    }
  }

  /**
   * A reaction over one's face on every screen (one a second at most): one at the table sends an
   * emoji; one watching, an emoji while a game is played, else a phrase.
   */
  emote(siteId: string, userId: number, door: number, emoji: string): void {
    const table = this.tables.get(siteId)?.get(door);
    if (!table) fail("not_here");
    const t = table as Table;
    const now = this.deps.clock.now();
    const seated = t.seats.some((s) => s.id === userId);
    if (!seated && !this.watching(t, now).includes(userId)) fail("not_here");
    const allowed: readonly string[] = seated || this.live(t) ? EVENING_EMOTES : EVENING_PHRASES;
    if (!allowed.includes(emoji)) fail("bad_emote");
    t.emotes = t.emotes.filter((e) => now - e.at < EMOTE_MS);
    if (t.emotes.some((e) => e.id === userId && now - e.at < EMOTE_GAP_MS)) fail("too_fast");
    const n = (t.emotes[t.emotes.length - 1]?.n ?? now) + 1;
    t.emotes.push({ n, id: userId, emoji: emoji as EveningReaction, at: now });
    this.changed(t);
  }

  /**
   * The table as the viewer may see it; waits (up to ~25 s) until it changes past `since`, or until
   * `gone` — the screen closed. While a screen waits, its viewer is in the room.
   */
  async view(
    siteId: string,
    userId: number,
    door: number,
    since = -1,
    gone?: AbortSignal,
  ): Promise<EveningTableView> {
    const overview = this.overview(siteId).doors[door - 1];
    if (!overview) fail("bad_door");
    const session = this.deps.game.session(siteId)?.start ?? 0;
    const table =
      this.tables.get(siteId)?.get(door) ??
      this.table(siteId, door, (overview as EveningDoor).game, session);
    this.arrive(table, userId);
    try {
      if (table.version <= since && !gone?.aborted) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            table.waiters.delete(done);
            gone?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, LONG_POLL_MS);
          table.waiters.add(done);
          gone?.addEventListener("abort", done);
        });
      }
      return this.viewOf(table, userId, (overview as EveningDoor).open);
    } finally {
      this.depart(table, userId);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────

  private table(siteId: string, door: number, game: EveningGame, session: number): Table {
    const doors = this.tables.get(siteId) ?? new Map<number, Table>();
    this.tables.set(siteId, doors);
    let t = doors.get(door);
    // a table with nobody at it belongs to whatever the door holds now
    if (t && t.seats.length === 0 && t.queue.length === 0 && !this.live(t)) {
      t.game = game;
      t.session = session;
    }
    if (!t) {
      t = {
        site: siteId,
        door,
        game,
        session,
        version: 1,
        seats: [],
        queue: [],
        battle: null,
        poker: { hand: null, button: 0, handNo: 0 },
        round: null,
        result: null,
        emotes: [],
        deadline: null,
        timer: null,
        waiters: new Set(),
        watchers: new Map(),
      };
      doors.set(door, t);
    }
    return t;
  }

  private live(t: Table): boolean {
    if (t.game === "battle") return t.battle !== null && t.battle.game.phase !== "done";
    const rules = roundRules(t.game);
    if (rules) return t.round !== null && !rules.done(t.round.game);
    return t.poker.hand !== null && t.poker.hand.street !== "done";
  }

  /** Who watches the table now, not sitting at it (their screens on it). */
  private watching(t: Table, now: number): number[] {
    for (const [id, w] of t.watchers)
      if (w.open === 0 && now - w.last > this.timings.goneMs) this.drop(t, id);
    return [...t.watchers.keys()].filter((id) => !t.seats.some((s) => s.id === id));
  }

  /** A screen asks for the table: its viewer is in the room — the others learn of one new. */
  private arrive(t: Table, userId: number): void {
    const now = this.deps.clock.now();
    const w = t.watchers.get(userId);
    const fresh = !w || (w.open === 0 && now - w.last > this.timings.goneMs);
    if (w?.gone) clearTimeout(w.gone);
    if (fresh) t.watchers.delete(userId); // the first to come first: back in, at the end
    t.watchers.set(userId, { open: (fresh ? 0 : (w?.open ?? 0)) + 1, last: now, gone: null });
    if (fresh && !t.seats.some((s) => s.id === userId)) this.changed(t);
  }

  /** A screen's request is over (answered, or the screen closed); none asks again soon: gone. */
  private depart(t: Table, userId: number): void {
    const w = t.watchers.get(userId);
    if (!w) return;
    w.open = Math.max(0, w.open - 1);
    w.last = this.deps.clock.now();
    if (w.open > 0) return;
    if (w.gone) clearTimeout(w.gone);
    w.gone = setTimeout(() => {
      if (t.watchers.get(userId) === w && w.open === 0) this.drop(t, userId);
    }, this.timings.goneMs);
    w.gone.unref?.();
  }

  /** One left the room: the others see them gone. */
  private drop(t: Table, userId: number): void {
    const w = t.watchers.get(userId);
    if (!w) return;
    if (w.gone) clearTimeout(w.gone);
    t.watchers.delete(userId);
    if (!t.seats.some((s) => s.id === userId)) this.changed(t);
  }

  /** Something changed: wake the screens waiting on it. */
  private changed(t: Table): void {
    t.version++;
    for (const wake of [...t.waiters]) wake();
  }

  /** A move's clock: the view shows it, and `then` runs when it runs out. */
  private deadline(t: Table, ms: number | null, then?: () => void): void {
    this.pause(t, ms, then);
    t.deadline = ms === null ? null : this.deps.clock.now() + ms;
  }

  /** A pause nobody has to act in (the board after a game, between hands): no clock shown. */
  private pause(t: Table, ms: number | null, then?: () => void): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    t.deadline = null;
    if (ms !== null && then) t.timer = setTimeout(then, ms);
  }

  /** Move the table on: seat the queue, start a game or a hand, or close an old session's table. */
  private advance(t: Table): void {
    const current = this.deps.game.session(t.site)?.start;
    const stale = t.session !== current;
    // a table of an earlier outage plays its game out, then empties
    if (stale && !this.live(t) && !((t.battle || t.round) && t.timer)) {
      t.seats = [];
      t.queue = [];
    }
    if (!stale) {
      // the queue fills free seats, if they can still pay their stake
      const between =
        t.game === "battle" ? t.battle === null : roundRules(t.game) ? t.round === null : true;
      while (between && t.seats.length < ROOM[t.game] && t.queue.length > 0) {
        const q = t.queue.shift() as { id: number; stake: number };
        if (q.stake <= this.available(t.site, q.id))
          t.seats.push({ id: q.id, stake: q.stake, leaving: false, silent: 0 });
      }
    }
    if (t.game === "battle") {
      if (!t.battle && t.seats.length === 2 && !stale) this.battleStart(t);
    } else if (roundRules(t.game)) {
      if (!t.round) {
        // two seated: a moment for more to come; a full table starts at once; under two: wait
        if (stale || t.seats.length < 2) this.deadline(t, null);
        else if (t.seats.length >= ROOM[t.game]) this.roundStart(t);
        else if (!t.timer) this.deadline(t, this.timings.lobbyMs, () => this.roundStart(t));
      }
    } else if (!this.live(t) && !stale) {
      // between hands: the next one comes in a moment while two can play; with fewer, the hand
      // just played leaves the table after that moment, and the table waits for players
      const ready = t.seats.filter((s) => s.stake > 0).length >= 2;
      if (!t.timer && (ready || t.poker.hand))
        this.pause(t, this.timings.betweenHandsMs, () => this.pokerStart(t));
    }
    this.changed(t);
  }

  // ── «Графік» ────────────────────────────────────────────────────────────────────────────────

  private battleStart(t: Table): void {
    const [a, b] = t.seats as [Seat, Seat];
    t.battle = {
      game: newBattle(a.id, b.id),
      drafts: new Map([
        [a.id, randomBlocks(rand)],
        [b.id, randomBlocks(rand)],
      ]),
    };
    t.result = null;
    this.battleClock(t);
  }

  /** The clock of the move under way: silent players lose (before the first ring: just leave). */
  private battleClock(t: Table): void {
    const b = t.battle;
    if (!b || b.game.phase === "done") {
      this.deadline(t, null);
      return;
    }
    this.deadline(t, this.timings.turnMs, () => {
      const g = t.battle?.game;
      if (!g) return;
      const silent = waitingFor(g);
      if (g.phase === "placing") {
        // not begun: nobody pays; the silent ones stand up
        t.battle = null;
        t.seats = t.seats.filter((s) => !silent.includes(s.id));
        this.deadline(t, null);
        this.advance(t);
        return;
      }
      const id = silent[0];
      if (id !== undefined && t.battle) t.battle.game = forfeit(g, id);
      this.battleOver(t);
    });
  }

  private battleMove(t: Table, userId: number, move: EveningMove): void {
    const b = t.battle;
    if (!b) fail("not_started");
    const battle = b as NonNullable<Table["battle"]>;
    if (move.type === "shuffle") {
      if (battle.game.phase !== "placing") fail("not_placing");
      battle.drafts.set(userId, randomBlocks(rand));
    } else if (move.type === "ready") {
      const blocks = battle.drafts.get(userId) ?? fail("no_draft");
      const first: 0 | 1 = rand() < 0.5 ? 0 : 1;
      battle.game = ready(battle.game, userId, blocks as BattleBlock[], first);
      if (battle.game.phase === "playing") this.battleClock(t);
    } else if (move.type === "ring") {
      battle.game = shoot(battle.game, userId, move.cell);
      if (battle.game.phase === "done") {
        this.battleOver(t);
        return;
      }
      this.battleClock(t); // every ring gives the one to ring next their full time
    } else fail("bad_move");
    this.changed(t);
  }

  /** «Графік» over: the winner takes from the loser at most the smaller stake. */
  private battleOver(t: Table): void {
    const g = t.battle?.game;
    if (!g || g.winner === null) return;
    const winner = t.seats.find((s) => s.id === g.winner);
    const loser = t.seats.find((s) => s.id !== g.winner);
    const now = this.deps.clock.now();
    if (winner && loser) {
      const amount = Math.min(winner.stake, loser.stake);
      const ref = `«Графік», двері ${t.door}`;
      for (const [id, points] of [
        [winner.id, amount],
        [loser.id, -amount],
      ] as const)
        this.deps.store.game.addLedger({
          siteId: t.site,
          session: t.session,
          userId: id,
          points,
          kind: "battle",
          ref,
          at: now,
        });
      t.result = {
        winners: [winner.id],
        text: `+${amount}`,
        at: now,
        pay: { [winner.id]: amount, [loser.id]: -amount },
      };
    }
    this.pause(t, this.timings.resultMs, () => {
      // the board stays a moment, then the table is free for the next two
      t.battle = null;
      t.seats = [];
      this.pause(t, null);
      this.advance(t);
    });
    this.changed(t);
  }

  // ── round games (rounds.ts) ─────────────────────────────────────────────────────────────────

  private roundStart(t: Table): void {
    this.deadline(t, null);
    const rules = roundRules(t.game);
    if (
      !rules ||
      t.round ||
      this.deps.game.session(t.site)?.start !== t.session ||
      t.seats.length < 2
    ) {
      this.advance(t);
      return;
    }
    t.round = { game: rules.start(t.seats.map((s) => s.id).slice(0, rules.max), rand), pay: null };
    t.result = null;
    this.roundClock(t);
    this.changed(t);
  }

  /** The clock of whoever must move: silent that long, they give up (the game's own way). */
  private roundClock(t: Table): void {
    const rules = roundRules(t.game);
    const r = t.round;
    if (!rules || !r || rules.done(r.game)) {
      this.deadline(t, null);
      return;
    }
    const step = rules.auto?.(r.game);
    if (step) {
      // a step the game takes by itself (an action waiting out the window to cancel it, a bout
      // closing): its time is shown as the clock
      this.deadline(t, this.timings[step.wait], () => {
        if (!t.round || rules.done(t.round.game)) return;
        t.round.game = step.run(t.round.game, rand);
        this.roundNext(t);
      });
      return;
    }
    this.deadline(t, this.timings.turnMs, () => {
      const g = t.round?.game;
      if (!g || !t.round || rules.done(g)) return;
      const id = rules.waitingFor(g);
      if (id === null) return;
      t.round.game = rules.forfeit(g, id);
      this.roundNext(t);
    });
  }

  private roundMove(t: Table, userId: number, move: EveningMove): void {
    const rules = roundRules(t.game);
    const r = t.round;
    if (!rules || !r || rules.done(r.game)) throw new EveningError("not_started");
    r.game = rules.act(r.game, userId, move, rand);
    this.roundNext(t);
  }

  /** After a move or a forfeit: settle a game that ended, else the next one's clock. */
  private roundNext(t: Table): void {
    const rules = roundRules(t.game);
    const r = t.round;
    if (!rules || !r) return;
    if (!rules.done(r.game)) {
      this.roundClock(t); // every move gives whoever is next their full time
      this.changed(t);
      return;
    }
    const now = this.deps.clock.now();
    const stakeOf = (id: number) => t.seats.find((s) => s.id === id)?.stake ?? 0;
    r.pay = rules.settle(r.game, stakeOf);
    const ref = `${rules.name}, двері ${t.door}`;
    for (const [id, points] of Object.entries(r.pay))
      if (points !== 0)
        this.deps.store.game.addLedger({
          siteId: t.site,
          session: t.session,
          userId: Number(id),
          points,
          kind: t.game,
          ref,
          at: now,
        });
    const winners = Object.entries(r.pay)
      .filter(([, points]) => points > 0)
      .map(([id]) => Number(id));
    t.result = { winners, text: winners.length ? ref : "нічия", at: now, pay: { ...r.pay } };
    this.pause(t, this.timings.resultMs, () => {
      // the table stays a moment, then it is free for the next ones
      t.round = null;
      t.seats = [];
      this.pause(t, null);
      this.advance(t);
    });
    this.changed(t);
  }

  // ── poker ───────────────────────────────────────────────────────────────────────────────────

  private pokerStart(t: Table): void {
    this.deadline(t, null);
    const players = t.seats.filter((s) => s.stake > 0 && !s.leaving);
    if (this.deps.game.session(t.site)?.start !== t.session || players.length < 2) {
      // nobody to play with (or an earlier outage's table): the hand played leaves the table
      t.poker.hand = null;
      this.advance(t);
      return;
    }
    const button = t.poker.button % players.length;
    t.poker.hand = startHand(
      players.map((s) => ({ id: s.id, stack: s.stake })),
      button,
      POKER_BLINDS,
      rand,
    );
    t.poker.handNo++;
    t.result = null;
    this.pokerClock(t);
    this.changed(t);
  }

  private pokerClock(t: Table): void {
    const hand = t.poker.hand;
    if (!hand || hand.street === "done" || hand.turn === null) {
      this.deadline(t, null);
      return;
    }
    const seat = hand.seats[hand.turn];
    if (!seat) {
      this.deadline(t, null);
      return;
    }
    // someone who said they leave folds at once
    const leaving = t.seats.find((s) => s.id === seat.id)?.leaving;
    if (leaving) {
      this.pokerMove(t, seat.id, { type: "fold" });
      return;
    }
    this.deadline(t, this.timings.turnMs, () => {
      const h = t.poker.hand;
      if (!h || h.turn === null) return;
      const id = h.seats[h.turn]?.id;
      if (id === undefined) return;
      const s = t.seats.find((x) => x.id === id);
      if (s) {
        s.silent++;
        s.leaving = true; // silent once: folds, and stands up after the hand
      }
      this.pokerMove(t, id, pokerLegal(h).canCheck ? { type: "check" } : { type: "fold" });
    });
  }

  private pokerMove(t: Table, userId: number, action: PokerAction): void {
    const hand = t.poker.hand;
    if (!hand || hand.street === "done") fail("no_hand");
    t.poker.hand = pokerAct(hand as PokerHand, userId, action);
    const s = t.seats.find((x) => x.id === userId);
    if (s && action.type !== "fold") s.silent = 0;
    if (t.poker.hand.street === "done") this.pokerOver(t);
    else {
      this.pokerClock(t);
      this.changed(t);
    }
  }

  /** A hand ends: each player's net goes to the ledger now; the broke and the leaving stand up. */
  private pokerOver(t: Table): void {
    const hand = t.poker.hand as PokerHand;
    const results = hand.results ?? [];
    const now = this.deps.clock.now();
    const ref = `покер, двері ${t.door}, роздача ${t.poker.handNo}`;
    for (const r of results) {
      if (r.net !== 0)
        this.deps.store.game.addLedger({
          siteId: t.site,
          session: t.session,
          userId: r.id,
          points: r.net,
          kind: "poker",
          ref,
          at: now,
        });
      const seat = t.seats.find((s) => s.id === r.id);
      const end = hand.seats.find((s) => s.id === r.id);
      if (seat && end) seat.stake = end.stack;
    }
    const pay: Record<string, number> = {};
    for (const r of results) if (r.net !== 0) pay[r.id] = r.net;
    t.result = { winners: winnersOf(results), text: ref, at: now, pay };
    t.seats = t.seats.filter((s) => s.stake > 0 && !s.leaving);
    t.poker.button++;
    this.deadline(t, null);
    this.advance(t);
  }

  private roundView(t: Table, viewer: number | null): RoundTableView<unknown> {
    const rules = roundRules(t.game);
    return {
      game: t.round && rules ? rules.view(t.round.game, viewer) : null,
      pay: t.round?.pay ?? null,
    };
  }

  private viewOf(t: Table, userId: number, open: boolean): EveningTableView {
    const now = this.deps.clock.now();
    const seated = t.seats.some((s) => s.id === userId);
    const b = t.battle;
    const hand = t.poker.hand;
    const watchers = this.watching(t, now);
    const ids = new Set<number>([
      userId,
      ...watchers,
      ...t.seats.map((s) => s.id),
      ...t.queue.map((q) => q.id),
      ...(t.result?.winners ?? []),
      ...(hand?.seats.map((s) => s.id) ?? []),
      ...(t.round ? Object.keys(t.round.pay ?? {}).map(Number) : []),
    ]);
    const myTurn =
      hand && hand.street !== "done" && hand.turn !== null && hand.seats[hand.turn]?.id === userId;
    return {
      version: t.version,
      door: t.door,
      game: t.game,
      open,
      now,
      deadline: t.deadline,
      minStake: EVENING_MIN_STAKE[t.game],
      available: this.available(t.site, userId),
      seats: t.seats.map(({ id, stake, leaving }) => ({ id, stake, leaving })),
      queue: t.queue.map((q) => q.id),
      watchers,
      live: this.live(t),
      me: { id: userId, seated, queued: t.queue.some((q) => q.id === userId) },
      battle:
        t.game === "battle" && b
          ? {
              ...viewBattle(b.game, seated ? userId : null),
              draft: b.game.phase === "placing" ? (b.drafts.get(userId) ?? null) : null,
              days: BATTLE_DAYS,
              slots: BATTLE_SLOTS,
              total: BATTLE_BLOCKS.length,
            }
          : null,
      poker:
        t.game === "poker"
          ? {
              hand: hand ? pokerView(hand, seated ? userId : null) : null,
              legal: myTurn ? pokerLegal(hand as PokerHand) : null,
              handNo: t.poker.handNo,
              blinds: POKER_BLINDS,
            }
          : null,
      durak: t.game === "durak" ? (this.roundView(t, seated ? userId : null) as never) : null,
      colors: t.game === "colors" ? (this.roundView(t, seated ? userId : null) as never) : null,
      blackout: t.game === "blackout" ? (this.roundView(t, seated ? userId : null) as never) : null,
      emotes: t.emotes.filter((e) => now - e.at < EMOTE_MS),
      result: t.result,
      players: this.deps.game.views(t.site, [...ids]),
    };
  }
}

export type EveningMove =
  | { type: "shuffle" }
  | { type: "ready" }
  | { type: "ring"; cell: number }
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  | { type: "raise"; to: number }
  | { type: "throw"; card: string }
  | { type: "beat"; card: string; target: number }
  | { type: "take" }
  | { type: "done" }
  | { type: "play"; card: string; color?: string | undefined; target?: number | undefined }
  | { type: "draw" }
  | { type: "pass" }
  | { type: "nope" }
  | { type: "tuck"; at: number };

function winnersOf(results: readonly PokerResult[]): number[] {
  return results.filter((r) => r.won > 0).map((r) => r.id);
}
