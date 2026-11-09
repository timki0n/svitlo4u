/**
 * «Кольори» — the classic shedding game of colours and numbers, a game of «Вечорниці» for 2–6
 * players and 108 cards. In turn each player covers the top card of the pile with one of the same
 * colour or the same value, or with a wild that names the colour to follow; who cannot (or will
 * not) play draws a card. Skips, reverses and draw-twos in every colour, wilds and wild draw-fours
 * on top. Whoever gets rid of all their cards first wins.
 *
 * Pure state: the core keeps a game in memory, feeds every move through act(), shows each player
 * viewColors() and runs the clock on waitingFor(). Nothing here mutates its arguments: a move returns
 * a new game, and an illegal one throws Error(code) for the core to pass on as an API error.
 */

export type ColorsColor = "r" | "y" | "g" | "b";
/** The four colours, in the order a hand is sorted. */
export const COLORS: readonly ColorsColor[] = ["r", "y", "g", "b"];
/**
 * A card, always two characters: colour + value — "r0".."r9", "gS" (skip), "bR" (reverse),
 * "yD" (draw two) — or "WW" (wild) and "W4" (wild draw four).
 */
export type ColorsCard = string;
/** Cards dealt to each player. */
export const COLORS_HAND = 7;
/** Most players. */
export const COLORS_MAX = 6;

/** Values of the coloured cards, in the order a hand is sorted; the first ten are numbers. */
const VALUES = "0123456789SRD";
const WILDS: readonly ColorsCard[] = ["WW", "W4"];

/** `out` = gave up or timed out: no cards, no turns, only watching. */
export type ColorsPlayer = { id: number; hand: ColorsCard[]; out: boolean };
/**
 * What the last move did, for the screen: who, the card played (null when they drew or passed),
 * whether they drew a card themselves, and whom a +2/+4 made draw how many.
 */
export type ColorsLast = {
  id: number;
  card: ColorsCard | null;
  drew: boolean;
  penalty: { id: number; cards: number } | null;
};
export type ColorsGame = {
  phase: "playing" | "done";
  /** Seat order; every index below refers to this array. */
  players: ColorsPlayer[];
  /** The draw pile, drawn from index 0. */
  deck: ColorsCard[];
  /** Played cards; the top card is the LAST element. */
  discard: ColorsCard[];
  /** The colour to follow (after a wild: the colour chosen). */
  color: ColorsColor;
  /** Whose turn it is. */
  turn: number;
  /** 1 = seat order. */
  direction: 1 | -1;
  /** The card the player on turn just drew and may still play (else they pass). */
  drawn: ColorsCard | null;
  winner: number | null;
  last: ColorsLast | null;
};
export type ColorsMove =
  /** `color` is required for "WW" / "W4" and ignored for the rest. */
  { type: "play"; card: ColorsCard; color?: ColorsColor } | { type: "draw" } | { type: "pass" };
export type ColorsLegal = {
  /** Cards this player may play now, sorted like the hand, each once. */
  play: ColorsCard[];
  draw: boolean;
  pass: boolean;
};
export type ColorsView = Omit<ColorsGame, "players" | "deck" | "discard" | "drawn"> & {
  players: { id: number; cards: number; out: boolean }[];
  /** Cards left in the draw pile. */
  deck: number;
  /** The top of the discard pile. */
  top: ColorsCard;
  /** Cards in the discard pile. */
  played: number;
  /** The viewer's own cards, sorted; [] for a spectator. */
  hand: ColorsCard[];
  /** Only for the viewer whose turn it is and who just drew; else null. */
  drawn: ColorsCard | null;
  /** The viewer's moves when it is their turn; else null. */
  legal: ColorsLegal | null;
};

function fail(code: string): never {
  throw new Error(code);
}

const colorOf = (card: ColorsCard): string => card.charAt(0);
const valueOfCard = (card: ColorsCard): string => card.charAt(1);
const isColor = (c: unknown): c is ColorsColor =>
  typeof c === "string" && (COLORS as readonly string[]).includes(c);
const isWild = (card: ColorsCard): boolean => WILDS.includes(card);
const isColored = (card: ColorsCard): boolean =>
  typeof card === "string" &&
  card.length === 2 &&
  isColor(colorOf(card)) &&
  VALUES.includes(valueOfCard(card));
const isCard = (card: ColorsCard): boolean => isWild(card) || isColored(card);
// "W4" ends in a digit too, so a number card has to be a coloured one
const isNumber = (card: ColorsCard): boolean =>
  isColored(card) && VALUES.indexOf(valueOfCard(card)) < 10;

/** A whole number in [0, n); clamped so a sloppy rand() returning 1 (or below 0) still fits. */
const below = (n: number, rand: () => number): number =>
  Math.min(n - 1, Math.max(0, Math.floor(rand() * n)));

/** Fisher–Yates in place; rand() is expected in [0, 1). */
function shuffle(cards: ColorsCard[], rand: () => number): ColorsCard[] {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = below(i + 1, rand);
    const card = cards[i] as ColorsCard;
    cards[i] = cards[j] as ColorsCard;
    cards[j] = card;
  }
  return cards;
}

/**
 * The 108 cards before the shuffle: colour by colour (r y g b), each as 0, 1 1, 2 2 … 9 9, S S,
 * R R, D D (25 a colour), then four "WW" and four "W4".
 */
function fullDeck(): ColorsCard[] {
  const deck: ColorsCard[] = [];
  for (const color of COLORS)
    for (const value of VALUES) {
      deck.push(color + value);
      if (value !== "0") deck.push(color + value);
    }
  for (const wild of WILDS) for (let k = 0; k < 4; k++) deck.push(wild);
  return deck;
}

export function newColors(ids: number[], rand: () => number): ColorsGame {
  if (ids.length < 2 || ids.length > COLORS_MAX || new Set(ids).size !== ids.length)
    fail("bad_players");
  const deck = shuffle(fullDeck(), rand);
  // Seven to a seat from the front, in seat order.
  const players = ids.map((id) => ({ id, hand: deck.splice(0, COLORS_HAND), out: false }));
  // The pile starts with the first number card; whatever turns up before it goes to the bottom.
  // At most 42 cards are dealt and only 32 are not numbers, so a number card is always left.
  const turnedUp = deck.splice(0, deck.findIndex(isNumber));
  const first = deck.shift() as ColorsCard;
  deck.push(...turnedUp);
  return {
    phase: "playing",
    players,
    deck,
    discard: [first],
    color: colorOf(first) as ColorsColor,
    turn: below(players.length, rand),
    direction: 1,
    drawn: null,
    winner: null,
    last: null,
  };
}

/** May `card` go on `top` while `color` is to be followed (ignores the wild-four rule). */
export function playable(card: ColorsCard, top: ColorsCard, color: ColorsColor): boolean {
  if (!isCard(card)) return false;
  if (isWild(card)) return true;
  // A wild on top has no value to match ("W4" is not a 4): only the colour chosen counts.
  return colorOf(card) === color || (isColored(top) && valueOfCard(card) === valueOfCard(top));
}

/** What player `id` may do now; nothing at all unless it is their turn in a game still going. */
export function legalFor(g: ColorsGame, id: number): ColorsLegal {
  const me = g.players[g.turn];
  if (g.phase !== "playing" || !me || me.id !== id || me.out) return nothing();
  const play = [...new Set(sortHand(me.hand))].filter(
    (card) => playRefusal(g, g.turn, card) === null,
  );
  return { play, draw: g.drawn === null, pass: g.drawn !== null };
}

/**
 * Applies one move of player `id`; throws Error(code) when it is not theirs to make. `rand` is used
 * only to reshuffle the discard pile into a new draw pile.
 */
export function act(g: ColorsGame, id: number, move: ColorsMove, rand: () => number): ColorsGame {
  if (g.phase !== "playing") fail("not_playing");
  const i = g.players.findIndex((p) => p.id === id);
  // who is out has no cards and no turns: they only watch the rest
  if (i < 0 || seat(g, i).out) fail("not_in_game");
  if (i !== g.turn) fail("not_your_turn");
  const next = clone(g);
  const me = seat(next, i);
  switch (move.type) {
    case "play": {
      const refusal = playRefusal(g, i, move.card);
      if (refusal !== null) fail(refusal);
      // A wild names the colour to follow; any other card sets its own.
      const wild = isWild(move.card);
      if (wild && !isColor(move.color)) fail("pick_color");
      me.hand.splice(me.hand.indexOf(move.card), 1);
      next.discard.push(move.card);
      next.color = (wild ? move.color : colorOf(move.card)) as ColorsColor;
      next.drawn = null;
      next.last = { id, card: move.card, drew: false, penalty: null };
      if (me.hand.length === 0) {
        // The last card wins at once: its skip or penalty no longer matters.
        next.phase = "done";
        next.winner = id;
        return next;
      }
      return afterPlay(next, i, move.card, rand);
    }
    case "draw": {
      if (g.drawn !== null) fail("drew_already");
      next.last = { id, card: null, drew: true, penalty: null };
      const card = take(next, rand);
      // Nothing left to draw anywhere (every card is in a hand): the turn just passes.
      if (card === null) {
        next.turn = after(next, i);
        return next;
      }
      me.hand.push(card);
      // A playable card may be played at once (or kept with a pass); any other ends the turn.
      if (playRefusal(next, i, card) === null) next.drawn = card;
      else next.turn = after(next, i);
      return next;
    }
    case "pass":
      if (g.drawn === null) fail("nothing_drawn");
      next.drawn = null;
      next.turn = after(next, i);
      next.last = { id, card: null, drew: false, penalty: null };
      return next;
    default:
      fail("bad_move");
  }
}

/** Whose move the clock runs on (null when done). */
export function waitingFor(g: ColorsGame): number | null {
  if (g.phase === "done") return null;
  return g.players[g.turn]?.id ?? null;
}

/** A player gives up or stays silent too long: they are out; the game goes on without them. */
export function forfeit(g: ColorsGame, id: number): ColorsGame {
  if (g.phase === "done") return g;
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) fail("not_in_game");
  // out already: nothing left to give up
  if (seat(g, i).out) return g;
  const next = clone(g);
  const me = seat(next, i);
  me.out = true;
  // Their cards stay in the game, under the draw pile.
  next.deck.push(...me.hand);
  me.hand = [];
  if (i === next.turn) {
    next.turn = after(next, i);
    next.drawn = null;
  }
  const left = next.players.filter((p) => !p.out);
  if (left.length <= 1) {
    next.phase = "done";
    next.winner = left[0]?.id ?? null;
    next.drawn = null;
  }
  return next;
}

/** What `viewer` (null for a spectator) may see: own cards only, both piles as counts and the top. */
export function viewColors(g: ColorsGame, viewer: number | null): ColorsView {
  const { players, deck, discard, drawn, ...rest } = g;
  const me = players.find((p) => p.id === viewer);
  const onTurn = me !== undefined && g.phase === "playing" && players[g.turn]?.id === me.id;
  return {
    ...rest,
    last: copyLast(rest.last),
    players: players.map((p) => ({ id: p.id, cards: p.hand.length, out: p.out })),
    deck: deck.length,
    top: top(g),
    played: discard.length,
    hand: me ? sortHand(me.hand) : [],
    drawn: onTurn ? drawn : null,
    legal: onTurn ? legalFor(g, me.id) : null,
  };
}

// ---------------------------------------------------------------------------------------------

function seat(g: ColorsGame, i: number): ColorsPlayer {
  return g.players[i] ?? fail("not_in_game");
}

function nothing(): ColorsLegal {
  return { play: [], draw: false, pass: false };
}

const top = (g: ColorsGame): ColorsCard => g.discard.at(-1) ?? "";

const copyLast = (last: ColorsLast | null): ColorsLast | null =>
  last && { ...last, penalty: last.penalty && { ...last.penalty } };

function clone(g: ColorsGame): ColorsGame {
  return {
    ...g,
    players: g.players.map((p) => ({ ...p, hand: [...p.hand] })),
    deck: [...g.deck],
    discard: [...g.discard],
    last: copyLast(g.last),
  };
}

/** By colour r y g b, each from 0 up to 9, then S R D; the wilds last, "WW" before "W4". */
function sortHand(hand: ColorsCard[]): ColorsCard[] {
  const key = (card: ColorsCard) =>
    isWild(card)
      ? COLORS.length * VALUES.length + WILDS.indexOf(card)
      : COLORS.indexOf(colorOf(card) as ColorsColor) * VALUES.length +
        VALUES.indexOf(valueOfCard(card));
  return [...hand].sort((a, b) => key(a) - key(b));
}

/** Why player `i`, on turn, may not play `card` now (the colour a wild names aside), or null. */
function playRefusal(g: ColorsGame, i: number, card: ColorsCard): string | null {
  const hand = seat(g, i).hand;
  if (!hand.includes(card)) return "no_card";
  if (g.drawn !== null && card !== g.drawn) return "must_play_drawn";
  if (!playable(card, top(g), g.color)) return "not_playable";
  // No challenge here: a +4 is simply refused while the hand holds the colour to follow (a card
  // matching only by value does not count, and neither do wilds).
  if (card === "W4" && hand.some((c) => colorOf(c) === g.color)) return "wild_four_has_color";
  return null;
}

/** The next seat from `from` in the current direction that is still in. */
function after(g: ColorsGame, from: number): number {
  const n = g.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + k * g.direction) % n) + n) % n;
    if (!seat(g, i).out) return i;
  }
  return from;
}

/**
 * Takes the first card of the draw pile; when it is empty, the played cards under the top one are
 * shuffled into a new one first. Null when there is nothing left to draw at all. Works on a copy.
 */
function take(g: ColorsGame, rand: () => number): ColorsCard | null {
  if (g.deck.length === 0 && g.discard.length > 1) {
    g.deck = shuffle(g.discard.slice(0, -1), rand);
    g.discard = g.discard.slice(-1);
  }
  return g.deck.shift() ?? null;
}

/** The card just played by seat `i` (who still holds cards) takes effect; the turn moves on. */
function afterPlay(g: ColorsGame, i: number, card: ColorsCard, rand: () => number): ColorsGame {
  const kind = isWild(card) ? card : valueOfCard(card);
  switch (kind) {
    case "S":
      g.turn = after(g, after(g, i));
      break;
    case "R":
      g.direction = g.direction === 1 ? -1 : 1;
      // With two still in, the turn comes straight back: a reverse acts as a skip.
      g.turn = g.players.filter((p) => !p.out).length === 2 ? i : after(g, i);
      break;
    case "D":
    case "W4": {
      // The next player draws and loses their turn.
      const victim = after(g, i);
      const hand = seat(g, victim).hand;
      let cards = 0;
      for (const want = kind === "D" ? 2 : 4; cards < want; cards++) {
        const drawn = take(g, rand);
        if (drawn === null) break;
        hand.push(drawn);
      }
      g.last = { id: seat(g, i).id, card, drew: false, penalty: { id: seat(g, victim).id, cards } };
      g.turn = after(g, victim);
      break;
    }
    default:
      g.turn = after(g, i);
  }
  return g;
}
