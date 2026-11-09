/**
 * «Блекаут» — draw until somebody's lights go out, a game of «Вечорниці» for 2–6 players. Hidden
 * in the draw pile are the blackouts, one fewer than there are players: who draws one without a
 * generator to save them is out. On their turn a player may play any number of action cards — look
 * at the top of the pile, shuffle it, skip the draw, throw two turns over to the next player, take
 * a card from someone — and then ends the turn by drawing. While a played action waits, anyone may
 * cancel it with «Скасувати» (and the cancel may be cancelled in turn). The last one with the
 * lights still on wins.
 *
 * Pure state: the core keeps a game in memory, feeds every move through act(), lets a played action
 * happen with resolve() once its window runs out, shows each player viewBlackout() and runs the
 * clock on waitingFor(). Nothing here mutates its arguments: a move returns a new game, and an
 * illegal one throws Error(code) for the core to pass on as an API error.
 */

/**
 * The cards, two letters each: "BL" Блекаут (out if drawn without a generator), "GN" Генератор
 * (saves you from a blackout), "PK" Глянути графік (see the top three), "SH" Перемішати (shuffle),
 * "SK" Пропустити (end a turn without drawing), "AT" Перекинути (end your turn; the next player
 * takes two), "ST" Вкрасти (take a random card from a player), "NO" Скасувати (cancel an action).
 */
export type BlackoutCard = "BL" | "GN" | "PK" | "SH" | "SK" | "AT" | "ST" | "NO";
/** Most players. */
export const BLACKOUT_MAX = 6;
/** Action cards, per set: a set for 2–3 players, two sets for 4–6. */
export const BLACKOUT_ACTIONS: Record<"PK" | "SH" | "SK" | "AT" | "ST" | "NO", number> = {
  PK: 4,
  SH: 4,
  SK: 4,
  AT: 3,
  ST: 4,
  NO: 4,
};

/** Action cards dealt to each player, besides their generator. */
const HAND_ACTIONS = 4;
/** Generators shuffled into the draw pile, besides the one in every hand. */
const SPARE_GENERATORS = 2;
/** Cards «Глянути графік» shows. */
const PEEK = 3;
/** The cards played on a turn, in the order legalFor lists them; "NO" only answers an action. */
const PLAYABLE: readonly BlackoutCard[] = ["PK", "SH", "SK", "AT", "ST"];
/** The order a hand is sorted in ("BL" never stays in a hand; last, just in case). */
const HAND_ORDER: readonly BlackoutCard[] = ["GN", "NO", "PK", "SH", "SK", "AT", "ST", "BL"];

/** `out` = drew a blackout without a generator, gave up or timed out: no cards, only watching. */
export type BlackoutPlayer = { id: number; hand: BlackoutCard[]; out: boolean };
/** An action played and waiting out the window in which anyone may cancel it. */
export type BlackoutPending = {
  by: number;
  card: BlackoutCard;
  /** The player id «Вкрасти» takes from; null for the rest. */
  target: number | null;
  /** «Скасувати» played on it so far: odd = cancelled. */
  nopes: number;
};
/** What happened last, for the screen. */
export type BlackoutLast = {
  id: number;
  kind: "play" | "nope" | "cancelled" | "done" | "draw" | "defuse" | "tuck" | "out" | "steal";
  card: BlackoutCard | null;
  target: number | null;
};
export type BlackoutGame = {
  phase: "playing" | "done";
  /** Seat order; every index below refers to this array. */
  players: BlackoutPlayer[];
  /** The draw pile; the top is index 0. */
  deck: BlackoutCard[];
  /** Played and lost cards; the top is the LAST element. */
  discard: BlackoutCard[];
  /** Whose turn it is. */
  turn: number;
  /** Turns the player on turn still has to take (1, or 2 after «Перекинути»). */
  turns: number;
  pending: BlackoutPending | null;
  /**
   * The player on turn drew a blackout and saved themselves: they must tuck it back. That blackout
   * is held aside meanwhile — in no hand and in neither pile.
   */
  defusing: boolean;
  /** The top cards a player saw with «Глянути графік»; cleared whenever the pile changes. */
  peek: { id: number; cards: BlackoutCard[] } | null;
  winner: number | null;
  /** Player ids in the order they went out. */
  out: number[];
  last: BlackoutLast | null;
};
export type BlackoutMove =
  /** `target`: a player id, for "ST"; ignored for the rest. */
  | { type: "play"; card: BlackoutCard; target?: number }
  | { type: "draw" }
  | { type: "nope" }
  /** Where the defused blackout goes: 0 = top … deck.length = bottom; -1 = at random. */
  | { type: "tuck"; at: number };
export type BlackoutLegal = {
  /** Action cards this player may play now, each kind once. */
  play: BlackoutCard[];
  /** Who "ST" may take from. */
  targets: number[];
  draw: boolean;
  nope: boolean;
  tuck: boolean;
};
export type BlackoutView = Omit<BlackoutGame, "players" | "deck" | "peek"> & {
  players: { id: number; cards: number; out: boolean }[];
  /** Cards in the draw pile. */
  deck: number;
  /** Blackouts in the draw pile (public: all know how many there are). */
  blackouts: number;
  /** The viewer's own cards, sorted; [] for a spectator. */
  hand: BlackoutCard[];
  /** The top cards, only for the one who looked (until the pile changes). */
  peek: BlackoutCard[] | null;
  /** The viewer's moves; null for a spectator, one who is out, or when done. */
  legal: BlackoutLegal | null;
};

function fail(code: string): never {
  throw new Error(code);
}

/** A whole number in [0, n); clamped so a sloppy rand() returning 1 (or below 0) still fits. */
const below = (n: number, rand: () => number): number =>
  Math.min(n - 1, Math.max(0, Math.floor(rand() * n)));

/** Fisher–Yates in place; rand() is expected in [0, 1). */
function shuffle(cards: BlackoutCard[], rand: () => number): BlackoutCard[] {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = below(i + 1, rand);
    const card = cards[i] as BlackoutCard;
    cards[i] = cards[j] as BlackoutCard;
    cards[j] = card;
  }
  return cards;
}

export function newBlackout(ids: number[], rand: () => number): BlackoutGame {
  if (ids.length < 2 || ids.length > BLACKOUT_MAX || new Set(ids).size !== ids.length)
    fail("bad_players");
  const sets = ids.length <= 3 ? 1 : 2;
  // Kind by kind before the shuffle: PK PK … SH … SK … AT … ST … NO …
  const actions: BlackoutCard[] = [];
  for (const [card, count] of Object.entries(BLACKOUT_ACTIONS) as [BlackoutCard, number][])
    for (let k = 0; k < count * sets; k++) actions.push(card);
  shuffle(actions, rand);
  // A generator and four action cards to a seat, from the front, in seat order. The blackouts and
  // the spare generators join the pile only after the deal, so nobody starts with either.
  const players = ids.map((id) => ({
    id,
    hand: ["GN" as BlackoutCard, ...actions.splice(0, HAND_ACTIONS)],
    out: false,
  }));
  const deck = shuffle(
    [
      ...actions,
      ...Array<BlackoutCard>(SPARE_GENERATORS).fill("GN"),
      ...Array<BlackoutCard>(ids.length - 1).fill("BL"),
    ],
    rand,
  );
  return {
    phase: "playing",
    players,
    deck,
    discard: [],
    turn: below(players.length, rand),
    turns: 1,
    pending: null,
    defusing: false,
    peek: null,
    winner: null,
    out: [],
    last: null,
  };
}

/** What player `id` may do now; nothing at all for one who is out, not in the game, or after it. */
export function legalFor(g: BlackoutGame, id: number): BlackoutLegal {
  const i = g.players.findIndex((p) => p.id === id);
  const me = g.players[i];
  if (g.phase !== "playing" || !me || me.out) return nothing();
  const onTurn = i === g.turn;
  // Actions and the draw only with nothing pending and no blackout to tuck back.
  const free = onTurn && g.pending === null && !g.defusing;
  return {
    play: free ? PLAYABLE.filter((card) => me.hand.includes(card)) : [],
    targets: free ? g.players.filter((p) => !p.out && p.id !== id).map((p) => p.id) : [],
    draw: free,
    // Anyone still in may cancel, the one who played the action too.
    nope: g.pending !== null && me.hand.includes("NO"),
    tuck: onTurn && g.defusing,
  };
}

/**
 * Applies one move of player `id`; throws Error(code) when it is not theirs to make. `rand` is used
 * only to tuck a blackout back at random.
 */
export function act(
  g: BlackoutGame,
  id: number,
  move: BlackoutMove,
  rand: () => number,
): BlackoutGame {
  if (g.phase !== "playing") fail("not_playing");
  const i = g.players.findIndex((p) => p.id === id);
  // who is out has no cards and no turns: they only watch the rest
  if (i < 0 || seat(g, i).out) fail("not_in_game");
  const next = clone(g);
  const me = seat(next, i);
  switch (move.type) {
    case "play": {
      mustBeFree(g, i);
      if (!PLAYABLE.includes(move.card)) fail("not_playable");
      if (!me.hand.includes(move.card)) fail("no_card");
      let target: number | null = null;
      if (move.card === "ST") {
        const victim = g.players.find((p) => p.id === move.target);
        if (!victim || victim.out || victim.id === id) fail("bad_target");
        target = victim.id;
      }
      // The card is spent at once, even if it ends up cancelled; it acts only on resolve().
      me.hand.splice(me.hand.indexOf(move.card), 1);
      next.discard.push(move.card);
      next.pending = { by: id, card: move.card, target, nopes: 0 };
      next.last = { id, kind: "play", card: move.card, target };
      return next;
    }
    case "nope": {
      const pending = next.pending ?? fail("nothing_pending");
      if (!me.hand.includes("NO")) fail("no_card");
      me.hand.splice(me.hand.indexOf("NO"), 1);
      next.discard.push("NO");
      pending.nopes += 1;
      next.last = { id, kind: "nope", card: "NO", target: null };
      return next;
    }
    case "draw": {
      mustBeFree(g, i);
      next.peek = null;
      const card = next.deck.shift();
      next.last = { id, kind: "draw", card: null, target: null };
      // Cannot happen while two are in (a blackout is always left), but an empty pile just ends
      // the turn.
      if (card === undefined) return endTurn(next);
      if (card !== "BL") {
        // Others must not learn what was drawn: `last` never names the card.
        me.hand.push(card);
        return endTurn(next);
      }
      if (me.hand.includes("GN")) {
        me.hand.splice(me.hand.indexOf("GN"), 1);
        next.discard.push("GN");
        next.defusing = true;
        next.last = { id, kind: "defuse", card: "BL", target: null };
        return next;
      }
      next.last = { id, kind: "out", card: "BL", target: null };
      leave(next, i);
      // their hand first, the blackout on top
      next.discard.push("BL");
      return next;
    }
    case "tuck": {
      if (i !== g.turn) fail("not_your_turn");
      if (!g.defusing) fail("not_defusing");
      const at = move.at === -1 ? below(next.deck.length + 1, rand) : move.at;
      if (!Number.isInteger(at) || at < 0 || at > next.deck.length) fail("bad_position");
      next.deck.splice(at, 0, "BL");
      next.defusing = false;
      next.peek = null;
      next.last = { id, kind: "tuck", card: null, target: null };
      return endTurn(next);
    }
    default:
      fail("bad_move");
  }
}

/** The window for «Скасувати» ran out: the pending action happens, or is cancelled (odd nopes). */
export function resolve(g: BlackoutGame, rand: () => number): BlackoutGame {
  if (g.phase !== "playing") fail("not_playing");
  const { by, card, target, nopes } = g.pending ?? fail("nothing_pending");
  const next = clone(g);
  next.pending = null;
  // A cancel cancels the action, a second one cancels the cancel, and so on.
  if (nopes % 2 === 1) {
    next.last = { id: by, kind: "cancelled", card, target };
    return next;
  }
  next.last = { id: by, kind: "done", card, target };
  // Only the player on turn plays actions, and theirs is dropped if they leave: `by` is on turn.
  switch (card) {
    case "PK":
      next.peek = { id: by, cards: next.deck.slice(0, PEEK) };
      break;
    case "SH":
      shuffle(next.deck, rand);
      next.peek = null;
      break;
    case "SK":
      endTurn(next);
      break;
    case "AT":
      // No stacking: whoever is attacked takes two, however many turns the attacker had left.
      next.turn = after(next, next.turn);
      next.turns = 2;
      break;
    case "ST": {
      const victim = next.players.find((p) => p.id === target);
      const thief = next.players.find((p) => p.id === by);
      // A target with no cards (or gone out since) has nothing to give.
      if (victim && thief && victim.hand.length > 0)
        thief.hand.push(...victim.hand.splice(below(victim.hand.length, rand), 1));
      next.last.kind = "steal";
      break;
    }
  }
  return next;
}

/**
 * Whose move the clock runs on: null when done or while an action is pending (the window has its
 * own timer). While defusing, still the player on turn: they have a blackout to tuck back.
 */
export function waitingFor(g: BlackoutGame): number | null {
  if (g.phase === "done" || g.pending !== null) return null;
  return g.players[g.turn]?.id ?? null;
}

/** A player gives up or stays silent too long: they are out. */
export function forfeit(g: BlackoutGame, id: number): BlackoutGame {
  if (g.phase === "done") return g;
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) fail("not_in_game");
  // out already: nothing left to give up
  if (seat(g, i).out) return g;
  const next = clone(g);
  leave(next, i);
  return next;
}

/** What `viewer` (null for a spectator) may see: own cards only, the draw pile as counts. */
export function viewBlackout(g: BlackoutGame, viewer: number | null): BlackoutView {
  const { players, deck, peek, ...rest } = g;
  const me = players.find((p) => p.id === viewer);
  return {
    ...rest,
    discard: [...rest.discard],
    pending: rest.pending && { ...rest.pending },
    out: [...rest.out],
    last: rest.last && { ...rest.last },
    players: players.map((p) => ({ id: p.id, cards: p.hand.length, out: p.out })),
    deck: deck.length,
    blackouts: deck.filter((card) => card === "BL").length,
    hand: me ? sortHand(me.hand) : [],
    peek: me && peek?.id === me.id ? [...peek.cards] : null,
    legal: me && !me.out && g.phase === "playing" ? legalFor(g, me.id) : null,
  };
}

// ---------------------------------------------------------------------------------------------

function seat(g: BlackoutGame, i: number): BlackoutPlayer {
  return g.players[i] ?? fail("not_in_game");
}

function nothing(): BlackoutLegal {
  return { play: [], targets: [], draw: false, nope: false, tuck: false };
}

function clone(g: BlackoutGame): BlackoutGame {
  return {
    ...g,
    players: g.players.map((p) => ({ ...p, hand: [...p.hand] })),
    deck: [...g.deck],
    discard: [...g.discard],
    pending: g.pending && { ...g.pending },
    peek: g.peek && { id: g.peek.id, cards: [...g.peek.cards] },
    out: [...g.out],
    last: g.last && { ...g.last },
  };
}

function sortHand(hand: BlackoutCard[]): BlackoutCard[] {
  return [...hand].sort((a, b) => HAND_ORDER.indexOf(a) - HAND_ORDER.indexOf(b));
}

/** Throws unless seat `i` is on turn with nothing pending and no blackout to tuck back. */
function mustBeFree(g: BlackoutGame, i: number): void {
  if (i !== g.turn) fail("not_your_turn");
  if (g.pending !== null) fail("pending");
  if (g.defusing) fail("defusing");
}

/** The next seat after `from` that is still in. */
function after(g: BlackoutGame, from: number): number {
  const n = g.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (!seat(g, i).out) return i;
  }
  return from;
}

/** The player on turn has taken one of their turns; after the last, the next player is on. */
function endTurn(g: BlackoutGame): BlackoutGame {
  g.turns -= 1;
  if (g.turns <= 0) {
    g.turn = after(g, g.turn);
    g.turns = 1;
  }
  return g;
}

/**
 * Seat `i` is out: their cards go to the discard pile, an action of theirs still pending is
 * dropped, a blackout they held aside goes to the discard pile too, and what they peeked at is
 * forgotten. On their turn the next player is on with a single turn; the last one still in wins.
 * Works on a copy.
 */
function leave(g: BlackoutGame, i: number): void {
  const p = seat(g, i);
  p.out = true;
  g.discard.push(...p.hand);
  p.hand = [];
  g.out.push(p.id);
  if (g.pending?.by === p.id) g.pending = null;
  if (g.peek?.id === p.id) g.peek = null;
  if (i === g.turn) {
    if (g.defusing) g.discard.push("BL");
    g.defusing = false;
    g.turn = after(g, i);
    g.turns = 1;
  }
  const left = g.players.filter((q) => !q.out);
  if (left.length <= 1) {
    g.phase = "done";
    g.winner = left[0]?.id ?? null;
    g.pending = null;
    // the winner was saving themselves from a blackout: it no longer matters
    if (g.defusing) g.discard.push("BL");
    g.defusing = false;
  }
}
