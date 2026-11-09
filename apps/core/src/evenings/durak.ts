/**
 * «Дурень» — the classic «підкидний», without transfers — a game of «Вечорниці» for 2–6 players
 * and 36 cards. The attacker leads a card; the defender beats it or takes the table; everyone but
 * the defender may add cards of the ranks already down. After every bout the hands are refilled to
 * six from the stock; once it is empty, whoever has no cards left is out, and the last one still
 * holding cards is the durak.
 *
 * Pure state: the core keeps a game in memory, feeds every move through act(), shows each player
 * viewDurak() and runs the clock on waitingFor(). Nothing here mutates its arguments: a move returns
 * a new game, and an illegal one throws Error(code) for the core to pass on as an API error.
 */

/** A card: rank then suit, e.g. "6s", "Td", "Ah". Ranks 6789TJQKA (T = 10), suits s h d c. */
export type DurakCard = string;
export const DURAK_RANKS = "6789TJQKA";
export const DURAK_SUITS = "shdc";
/** Cards dealt to each player and refilled to after every bout. */
export const DURAK_HAND = 6;
/** Most players: six hands of six take the whole deck. */
export const DURAK_MAX = 6;

/** Most attack cards in one bout, however many cards the defender holds. */
const BOUT_MAX = 6;

export type DurakPair = { attack: DurakCard; defense: DurakCard | null };
export type DurakPlayer = { id: number; hand: DurakCard[]; out: boolean };
export type DurakGame = {
  phase: "playing" | "done";
  /** Seat order (clockwise); every index below refers to this array. */
  players: DurakPlayer[];
  /** The stock, drawn from index 0; its last card is the trump card. */
  deck: DurakCard[];
  /** The trump card (its suit is trumps); stays set after it is drawn. */
  trump: DurakCard;
  table: DurakPair[];
  /** Who leads this bout. */
  attacker: number;
  defender: number;
  /** The defender said «беру»: others may still add, then all goes to them. */
  took: boolean;
  /** Most attack cards this bout: min(6, the defender's hand when the bout began). */
  limit: number;
  /** Cards gone to «бито». */
  discard: number;
  /** 1, 2, … */
  bout: number;
  /** Player ids in the order they went out. */
  finished: number[];
  /** The loser once phase is "done"; null when done means a draw. */
  durak: number | null;
};
export type DurakMove =
  | { type: "throw"; card: DurakCard }
  /** `target` is an index into the table. */
  | { type: "beat"; card: DurakCard; target: number }
  | { type: "take" }
  | { type: "done" };
export type DurakLegal = {
  /** Cards this player may put down now. */
  throw: DurakCard[];
  /** For the defender: hand cards and the table pairs each of them can beat. */
  beat: { card: DurakCard; targets: number[] }[];
  take: boolean;
  done: boolean;
};
export type DurakView = Omit<DurakGame, "players" | "deck"> & {
  players: { id: number; cards: number; out: boolean }[];
  /** Cards left in the stock. */
  deck: number;
  /** The viewer's own cards, sorted: plain suits in the order s h d c, trumps last; [] for others. */
  hand: DurakCard[];
  /** The viewer's moves; null for a spectator, for one who is out, or when the game is done. */
  legal: DurakLegal | null;
};

function fail(code: string): never {
  throw new Error(code);
}

const rankOf = (card: DurakCard): number => DURAK_RANKS.indexOf(card.charAt(0));
const suitOf = (card: DurakCard): string => card.charAt(1);
const isCard = (card: DurakCard): boolean =>
  typeof card === "string" &&
  card.length === 2 &&
  rankOf(card) >= 0 &&
  DURAK_SUITS.includes(suitOf(card));

/** 36 cards shuffled with Fisher–Yates; rand() is expected in [0, 1). */
function shuffled(rand: () => number): DurakCard[] {
  const deck: DurakCard[] = [];
  for (const suit of DURAK_SUITS) for (const rank of DURAK_RANKS) deck.push(rank + suit);
  for (let i = deck.length - 1; i > 0; i--) {
    // Clamped so a sloppy rand() returning 1 (or below 0) still picks a real card.
    const j = Math.min(i, Math.max(0, Math.floor(rand() * (i + 1))));
    const card = deck[i] as DurakCard;
    deck[i] = deck[j] as DurakCard;
    deck[j] = card;
  }
  return deck;
}

export function newDurak(ids: number[], rand: () => number): DurakGame {
  if (ids.length < 2 || ids.length > DURAK_MAX || new Set(ids).size !== ids.length)
    fail("bad_players");
  const deck = shuffled(rand);
  const trump = deck.at(-1) as DurakCard;
  // Six to a seat from the front, in seat order; with six players nothing is left to draw and
  // the trump card ends up in the last hand.
  const players = ids.map((id) => ({ id, hand: deck.splice(0, DURAK_HAND), out: false }));
  // The lowest trump in hand leads the first bout; with no trump dealt at all, the first seat does.
  let attacker = 0;
  let lowest = DURAK_RANKS.length;
  for (const [i, p] of players.entries())
    for (const card of p.hand)
      if (suitOf(card) === suitOf(trump) && rankOf(card) < lowest) {
        lowest = rankOf(card);
        attacker = i;
      }
  const defender = (attacker + 1) % players.length;
  return {
    phase: "playing",
    players,
    deck,
    trump,
    table: [],
    attacker,
    defender,
    took: false,
    limit: Math.min(BOUT_MAX, players[defender]?.hand.length ?? 0),
    discard: 0,
    bout: 1,
    finished: [],
    durak: null,
  };
}

/** Whether `defense` beats `attack`: a higher card of the same suit, or any trump on a plain card. */
export function beats(attack: DurakCard, defense: DurakCard, trumpSuit: string): boolean {
  if (!isCard(attack) || !isCard(defense)) return false;
  if (suitOf(defense) === suitOf(attack)) return rankOf(defense) > rankOf(attack);
  return suitOf(defense) === trumpSuit;
}

/** What player `id` may do now; nothing at all for one who is out, not in the game, or after it. */
export function legalFor(g: DurakGame, id: number): DurakLegal {
  const i = g.players.findIndex((p) => p.id === id);
  const me = g.players[i];
  if (g.phase !== "playing" || !me || me.out) return nothing();
  const trumps = suitOf(g.trump);
  const hand = sortHand(me.hand, trumps);
  if (i !== g.defender)
    return {
      throw: hand.filter((card) => throwRefusal(g, i, card) === null),
      beat: [],
      take: false,
      done: i === g.attacker && answered(g),
    };
  if (g.took) return nothing();
  const beat = hand.flatMap((card) => {
    const targets = g.table.flatMap((pair, k) =>
      pair.defense === null && beats(pair.attack, card, trumps) ? [k] : [],
    );
    return targets.length > 0 ? [{ card, targets }] : [];
  });
  return { throw: [], beat, take: unbeaten(g), done: false };
}

/** Applies one move of player `id`; throws Error(code) when it is not theirs to make. */
export function act(g: DurakGame, id: number, move: DurakMove): DurakGame {
  if (g.phase !== "playing") fail("not_playing");
  const i = g.players.findIndex((p) => p.id === id);
  // who is out has nothing left to play: they only watch the rest
  if (i < 0 || seat(g, i).out) fail("not_in_game");
  const next = clone(g);
  const me = seat(next, i);
  switch (move.type) {
    case "throw": {
      const refusal = throwRefusal(g, i, move.card);
      if (refusal !== null) fail(refusal);
      me.hand.splice(me.hand.indexOf(move.card), 1);
      next.table.push({ attack: move.card, defense: null });
      break;
    }
    case "beat": {
      if (i !== g.defender) fail("not_defender");
      if (g.took) fail("took_already");
      if (!me.hand.includes(move.card)) fail("no_card");
      const pair = Number.isInteger(move.target) ? next.table[move.target] : undefined;
      if (!pair || pair.defense !== null) fail("bad_target");
      if (!beats(pair.attack, move.card, suitOf(g.trump))) fail("does_not_beat");
      me.hand.splice(me.hand.indexOf(move.card), 1);
      pair.defense = move.card;
      break;
    }
    case "take":
      if (i !== g.defender) fail("not_defender");
      if (g.took) fail("took_already");
      if (!unbeaten(g)) fail("nothing_to_take");
      next.took = true;
      break;
    case "done":
      if (i !== g.attacker) fail("not_attacker");
      if (!answered(g)) fail("not_finished");
      return endBout(next);
    default:
      fail("bad_move");
  }
  // Everything answered and nobody able to add: the bout ends without waiting for «Бито».
  return answered(next) && !canAdd(next) ? endBout(next) : next;
}

/** Whose move the clock runs on (null when done). */
export function waitingFor(g: DurakGame): number | null {
  if (g.phase === "done") return null;
  // An unbeaten card waits for the defender; otherwise the attacker leads or calls «Бито».
  const who = unbeaten(g) && !g.took ? g.defender : g.attacker;
  return g.players[who]?.id ?? null;
}

/** A player gives up or stays silent too long: the game ends with them as the durak. */
export function forfeit(g: DurakGame, id: number): DurakGame {
  if (g.phase === "done") return g;
  if (!g.players.some((p) => p.id === id)) fail("not_in_game");
  return { ...clone(g), phase: "done", durak: id };
}

/** What `viewer` (null for a spectator) may see: own cards only, the stock as a count. */
export function viewDurak(g: DurakGame, viewer: number | null): DurakView {
  const { players, deck, ...rest } = g;
  const me = players.find((p) => p.id === viewer);
  return {
    ...rest,
    table: rest.table.map((pair) => ({ ...pair })),
    finished: [...rest.finished],
    players: players.map((p) => ({ id: p.id, cards: p.hand.length, out: p.out })),
    deck: deck.length,
    hand: me ? sortHand(me.hand, suitOf(g.trump)) : [],
    legal: me && !me.out && g.phase === "playing" ? legalFor(g, me.id) : null,
  };
}

// ---------------------------------------------------------------------------------------------

function seat(g: DurakGame, i: number): DurakPlayer {
  return g.players[i] ?? fail("not_in_game");
}

function nothing(): DurakLegal {
  return { throw: [], beat: [], take: false, done: false };
}

function clone(g: DurakGame): DurakGame {
  return {
    ...g,
    players: g.players.map((p) => ({ ...p, hand: [...p.hand] })),
    deck: [...g.deck],
    table: g.table.map((pair) => ({ ...pair })),
    finished: [...g.finished],
  };
}

/** Plain suits in the order s h d c, trumps last; each suit from the lowest rank up. */
function sortHand(hand: DurakCard[], trumps: string): DurakCard[] {
  const key = (card: DurakCard) =>
    (suitOf(card) === trumps ? DURAK_SUITS.length : DURAK_SUITS.indexOf(suitOf(card))) *
      DURAK_RANKS.length +
    rankOf(card);
  return [...hand].sort((a, b) => key(a) - key(b));
}

const tableCards = (g: DurakGame): DurakCard[] =>
  g.table.flatMap((pair) => (pair.defense === null ? [pair.attack] : [pair.attack, pair.defense]));

const unbeaten = (g: DurakGame): boolean => g.table.some((pair) => pair.defense === null);

/** Every card on the table is answered: beaten, or the defender is taking them all. */
const answered = (g: DurakGame): boolean => g.table.length > 0 && (g.took || !unbeaten(g));

/** Why player `i` may not put `card` down now, or null if they may. */
function throwRefusal(g: DurakGame, i: number, card: DurakCard): string | null {
  if (i === g.defender) return "defender_cannot_throw";
  if (g.table.length === 0 && i !== g.attacker) return "not_your_lead";
  if (!seat(g, i).hand.includes(card)) return "no_card";
  // The limit was set by the defender's hand, so they can always answer every card (or take).
  if (g.table.length >= g.limit) return "table_full";
  // Once the bout is open, only ranks already down (attack or defense) may be added.
  if (g.table.length > 0 && !tableCards(g).some((c) => rankOf(c) === rankOf(card)))
    return "rank_not_on_table";
  return null;
}

/** Somebody may still put a card down this bout. */
const canAdd = (g: DurakGame): boolean =>
  g.players.some((p, i) => !p.out && p.hand.some((card) => throwRefusal(g, i, card) === null));

/** The first seat from `from` on, clockwise, that is not out. */
function seatFrom(g: DurakGame, from: number): number {
  const n = g.players.length;
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    if (!seat(g, i).out) return i;
  }
  return from % n;
}

/**
 * Clears the table — into the defender's hand if they took, else to «бито» — refills the hands,
 * lets out whoever has nothing left, then sets up the next bout or ends the game. Works on the copy
 * act() already made.
 */
function endBout(g: DurakGame): DurakGame {
  const n = g.players.length;
  const cards = tableCards(g);
  let lead: number;
  if (g.took) {
    seat(g, g.defender).hand.push(...cards);
    // Who takes loses their turn to attack: it passes over them.
    lead = (g.defender + 1) % n;
  } else {
    g.discard += cards.length;
    lead = g.defender;
  }
  g.table = [];
  g.took = false;
  // The attacker draws first, then the others clockwise from them, the defender last.
  const order = Array.from({ length: n }, (_, k) => (g.attacker + k) % n).filter(
    (i) => i !== g.defender,
  );
  order.push(g.defender);
  for (const i of order) {
    const p = seat(g, i);
    while (!p.out && p.hand.length < DURAK_HAND && g.deck.length > 0)
      p.hand.push(g.deck.shift() as DurakCard);
  }
  for (const i of order) {
    const p = seat(g, i);
    if (!p.out && p.hand.length === 0 && g.deck.length === 0) {
      p.out = true;
      g.finished.push(p.id);
    }
  }
  const left = g.players.filter((p) => !p.out);
  if (left.length <= 1) {
    g.phase = "done";
    // Nobody left with cards: the last ones went out together, a draw.
    g.durak = left[0]?.id ?? null;
    return g;
  }
  g.attacker = seatFrom(g, lead);
  g.defender = seatFrom(g, g.attacker + 1);
  g.limit = Math.min(BOUT_MAX, seat(g, g.defender).hand.length);
  g.bout += 1;
  return g;
}
