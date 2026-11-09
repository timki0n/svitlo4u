/**
 * No-limit Texas Hold'em for a cash table of 2–6 neighbours betting their game points.
 *
 * Pure and synchronous: the core keeps the hand in memory, feeds every move through act(), shows
 * each player viewFor() and records `results` once the street is "done". Chips are whole points.
 * Every exported function returns fresh data and never mutates its arguments, so the core can keep
 * the previous hand around (for a retry or a log) without defensive copies.
 */

export type Card = string; // rank + suit: "Ah", "Td", "7c", "2s"
export type PokerPlayer = { id: number; stack: number };
export type PokerSeat = {
  id: number;
  /** Chips behind. */
  stack: number;
  /** Two hole cards. */
  cards: Card[];
  /** Put in on this street. */
  bet: number;
  /** Put in this hand. */
  total: number;
  folded: boolean;
  allIn: boolean;
  /** Has acted since the last full raise on this street (posting a blind does not count). */
  acted: boolean;
};
export type PokerStreet = "preflop" | "flop" | "turn" | "river" | "done";
export type PokerResult = {
  id: number;
  /** Chips taken from the pots, own uncalled chips included. */
  won: number;
  /** Stack at the end − stack at the start of the hand. */
  net: number;
  /** Hole cards shown at showdown, null if not shown. */
  shown: Card[] | null;
  /** Ukrainian name of the made hand when shown. */
  hand: string | null;
};
export type PokerHand = {
  /** In seat order; every index below refers to this array. */
  seats: PokerSeat[];
  button: number;
  small: number;
  big: number;
  /** What is left to deal, top first. */
  deck: Card[];
  board: Card[];
  street: PokerStreet;
  /** Index of the seat to act, null once the hand is done. */
  turn: number | null;
  /** Highest bet on this street. */
  currentBet: number;
  /** Size of the last full raise on this street (at least the big blind). */
  minRaise: number;
  /** Set when street is "done". */
  results: PokerResult[] | null;
};
export type PokerAction =
  | { type: "fold" }
  | { type: "check" }
  | { type: "call" }
  /** `to` is this seat's total bet on this street after the raise; a first bet counts too. */
  | { type: "raise"; to: number };
/** What the seat to act may do. Raising is not allowed when minRaiseTo and maxRaiseTo are 0. */
export type PokerLegal = {
  toCall: number;
  canCheck: boolean;
  minRaiseTo: number;
  maxRaiseTo: number;
};
export type PokerView = Omit<PokerHand, "deck">;

export const MAX_SEATS = 6;

const RANKS = "23456789TJQKA";
const SUITS = "shdc";
const HAND_NAMES = [
  "старша карта",
  "пара",
  "дві пари",
  "трійка",
  "стріт",
  "флеш",
  "фул-хаус",
  "каре",
  "стріт-флеш",
] as const;
const ROYAL_FLUSH = "роял-флеш";

/** Every refusal is the same error, so the core can map it to one response. */
function illegal(): never {
  throw new Error("illegal");
}

const isChips = (n: number) => Number.isSafeInteger(n) && n > 0;

/** 52 cards shuffled with Fisher–Yates; rand() is expected in [0, 1). */
export function newDeck(rand: () => number): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
  for (let i = deck.length - 1; i > 0; i--) {
    // Clamped so a sloppy rand() returning 1 (or below 0) still picks a real card.
    const j = Math.min(i, Math.max(0, Math.floor(rand() * (i + 1))));
    const card = deck[i] as Card;
    deck[i] = deck[j] as Card;
    deck[j] = card;
  }
  return deck;
}

export function startHand(
  players: PokerPlayer[],
  button: number,
  blinds: { small: number; big: number },
  rand: () => number,
): PokerHand {
  const n = players.length;
  const { small, big } = blinds;
  if (n < 2 || n > MAX_SEATS) illegal();
  if (!Number.isSafeInteger(button) || button < 0 || button >= n) illegal();
  if (!isChips(small) || !isChips(big) || small > big) illegal();
  if (players.some((p) => !Number.isSafeInteger(p.id) || !isChips(p.stack))) illegal();
  if (new Set(players.map((p) => p.id)).size !== n) illegal();

  const h: PokerHand = {
    seats: players.map((p) => ({
      id: p.id,
      stack: p.stack,
      cards: [],
      bet: 0,
      total: 0,
      folded: false,
      allIn: false,
      acted: false,
    })),
    button,
    small,
    big,
    deck: newDeck(rand),
    board: [],
    street: "preflop",
    turn: null,
    // A big blind short of chips still sets the price to enter the pot; the excess comes back
    // through the side pots if nobody else matches it.
    currentBet: big,
    minRaise: big,
    results: null,
  };
  // One card at a time starting left of the button, as at a real table.
  for (let round = 0; round < 2; round++) {
    for (let k = 1; k <= n; k++) seatAt(h, (button + k) % n).cards.push(draw(h));
  }
  // Heads-up the button is the small blind, so it acts first preflop and last after the flop.
  const sb = n === 2 ? button : (button + 1) % n;
  const bb = (sb + 1) % n;
  pay(seatAt(h, sb), small);
  pay(seatAt(h, bb), big);
  return settle(h, bb);
}

/** Options of seats[turn]; throws when nobody is to act. */
export function legal(h: PokerHand): PokerLegal {
  if (h.street === "done" || h.turn === null) illegal();
  const s = seatAt(h, h.turn);
  const owe = Math.max(0, h.currentBet - s.bet);
  const all = s.bet + s.stack;
  // Raising needs someone left to answer it, chips beyond a call, and an open betting round:
  // a seat that already acted may raise again only when the all-ins since then add up to a
  // full raise (TDA: cumulative short all-ins do reopen).
  const canRaise =
    h.seats.some((o) => o !== s && canAct(o)) &&
    all > h.currentBet &&
    (!s.acted || owe >= h.minRaise);
  return {
    toCall: Math.min(owe, s.stack),
    canCheck: owe === 0,
    minRaiseTo: canRaise ? Math.min(h.currentBet + h.minRaise, all) : 0,
    maxRaiseTo: canRaise ? all : 0,
  };
}

/** Applies one move of player `id`; throws Error("illegal") on a wrong turn, move or amount. */
export function act(h: PokerHand, id: number, action: PokerAction): PokerHand {
  const rules = legal(h);
  const next = clone(h);
  const i = next.turn as number;
  const s = seatAt(next, i);
  if (s.id !== id) illegal();
  switch (action.type) {
    case "fold":
      s.folded = true;
      break;
    case "check":
      if (!rules.canCheck) illegal();
      break;
    case "call":
      // Strict on purpose: a "call" of nothing is a client bug worth surfacing.
      if (rules.toCall === 0) illegal();
      pay(s, rules.toCall);
      break;
    case "raise": {
      const to = action.to;
      if (rules.maxRaiseTo === 0 || !Number.isSafeInteger(to)) illegal();
      if (to < rules.minRaiseTo || to > rules.maxRaiseTo) illegal();
      const size = to - next.currentBet;
      // Only a full raise reopens the betting; a short all-in just raises the price to call.
      if (size >= next.minRaise) {
        next.minRaise = size;
        for (const o of next.seats) if (o !== s) o.acted = false;
      }
      next.currentBet = to;
      pay(s, to - s.bet);
      break;
    }
    default:
      illegal();
  }
  s.acted = true;
  return settle(next, i);
}

/** The hand as `viewer` may see it (null for a spectator): no deck, no hidden hole cards. */
export function viewFor(h: PokerHand, viewer: number | null): PokerView {
  const { deck: _deck, ...rest } = clone(h);
  const shown = new Set((h.results ?? []).filter((r) => r.shown !== null).map((r) => r.id));
  return {
    ...rest,
    seats: rest.seats.map((s) => (s.id === viewer || shown.has(s.id) ? s : { ...s, cards: [] })),
  };
}

/** Best five of 5–7 cards. `score` compares with compareScores; `name` is Ukrainian. */
export function evaluate(cards: Card[]): { score: number[]; name: string } {
  if (cards.length < 5 || cards.length > 7 || new Set(cards).size !== cards.length) illegal();
  const parsed = cards.map(parseCard);
  let best: number[] | null = null;
  // At most 21 five-card subsets: brute force is clearer than a 7-card evaluator and fast enough
  // for a handful of showdowns.
  for (let mask = 0; mask < 1 << parsed.length; mask++) {
    if (bitCount(mask) !== 5) continue;
    const score = scoreFive(parsed.filter((_, k) => mask & (1 << k)));
    if (best === null || compareScores(score, best) > 0) best = score;
  }
  const score = best as number[];
  const category = score[0] as number;
  const name = category === 8 && score[1] === 14 ? ROYAL_FLUSH : (HAND_NAMES[category] as string);
  return { score, name };
}

/** > 0 if a wins, < 0 if b wins, 0 for a split. */
export function compareScores(a: number[], b: number[]): number {
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const d = (a[k] ?? 0) - (b[k] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------

type Parsed = { rank: number; suit: string };

function parseCard(card: Card): Parsed {
  const rank = RANKS.indexOf(card[0] ?? "");
  const suit = card[1] ?? "";
  if (card.length !== 2 || rank < 0 || !SUITS.includes(suit)) illegal();
  return { rank: rank + 2, suit };
}

function bitCount(n: number): number {
  let count = 0;
  for (let m = n; m; m &= m - 1) count++;
  return count;
}

/** [category, ...tie-breakers]: categories 0 (high card) to 8 (straight flush). */
function scoreFive(cards: Parsed[]): number[] {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0]?.suit);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  // Bigger groups first, then higher ranks: the order the tie-breakers are read in.
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const byGroup = groups.map(([rank]) => rank);
  const [first, second] = groups.map(([, count]) => count);
  const top = ranks[0] as number;
  let straight = 0;
  if (groups.length === 5) {
    if (top - (ranks[4] as number) === 4) straight = top;
    // The wheel: the ace plays low, so it is the lowest straight.
    else if (top === 14 && ranks[1] === 5) straight = 5;
  }
  if (straight && flush) return [8, straight];
  if (first === 4) return [7, ...byGroup];
  if (first === 3 && second === 2) return [6, ...byGroup];
  if (flush) return [5, ...ranks];
  if (straight) return [4, straight];
  if (first === 3) return [3, ...byGroup];
  if (first === 2 && second === 2) return [2, ...byGroup];
  if (first === 2) return [1, ...byGroup];
  return [0, ...ranks];
}

function seatAt(h: PokerHand, i: number): PokerSeat {
  return h.seats[i] ?? illegal();
}

function draw(h: PokerHand): Card {
  return h.deck.shift() ?? illegal();
}

const canAct = (s: PokerSeat) => !s.folded && !s.allIn;

/** Moves up to `amount` from the stack into the pot; whoever runs dry is all-in. */
function pay(s: PokerSeat, amount: number): void {
  const paid = Math.min(s.stack, amount);
  s.stack -= paid;
  s.bet += paid;
  s.total += paid;
  if (s.stack === 0) s.allIn = true;
}

function clone(h: PokerHand): PokerHand {
  return {
    ...h,
    seats: h.seats.map((s) => ({ ...s, cards: [...s.cards] })),
    deck: [...h.deck],
    board: [...h.board],
    results: h.results ? h.results.map((r) => ({ ...r, shown: r.shown && [...r.shown] })) : null,
  };
}

/** Index of the next seat after `from` that still has to act on this street, or null. */
function nextToAct(h: PokerHand, from: number): number | null {
  const actors = h.seats.filter(canAct);
  if (actors.length === 0) return null;
  const only = actors.length === 1 ? actors[0] : undefined;
  if (only) {
    // Alone with chips there is nobody to bet against: act only to match an all-in that is
    // bigger than what this seat has put in.
    const top = Math.max(0, ...h.seats.filter((o) => o !== only && !o.folded).map((o) => o.bet));
    return only.bet < top ? h.seats.indexOf(only) : null;
  }
  const n = h.seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    const s = seatAt(h, i);
    if (canAct(s) && (!s.acted || s.bet < h.currentBet)) return i;
  }
  return null;
}

/** After a move (or the blinds): pass the turn, deal the next street or finish the hand. */
function settle(h: PokerHand, from: number): PokerHand {
  if (h.seats.filter((s) => !s.folded).length === 1) return finishUncontested(h);
  const next = nextToAct(h, from);
  if (next !== null) {
    h.turn = next;
    return h;
  }
  if (h.seats.filter(canAct).length < 2) {
    while (h.board.length < 5) h.board.push(draw(h));
    return showdown(h);
  }
  if (h.street === "river") return showdown(h);
  for (const s of h.seats) {
    s.bet = 0;
    s.acted = false;
  }
  h.currentBet = 0;
  h.minRaise = h.big;
  h.street = h.street === "preflop" ? "flop" : h.street === "flop" ? "turn" : "river";
  const count = h.street === "flop" ? 3 : 1;
  for (let k = 0; k < count; k++) h.board.push(draw(h));
  // At least two seats can act and nobody has yet, so someone is always found.
  h.turn = nextToAct(h, h.button);
  return h;
}

function finish(h: PokerHand, results: PokerResult[]): PokerHand {
  h.seats.forEach((s, i) => {
    s.stack += results[i]?.won ?? 0;
  });
  h.street = "done";
  h.turn = null;
  h.results = results;
  return h;
}

/** Everybody else folded: the last seat takes every chip in, and nobody shows. */
function finishUncontested(h: PokerHand): PokerHand {
  const pot = h.seats.reduce((sum, s) => sum + s.total, 0);
  return finish(
    h,
    h.seats.map((s) => {
      const won = s.folded ? 0 : pot;
      return { id: s.id, won, net: won - s.total, shown: null, hand: null };
    }),
  );
}

/**
 * Main and side pots by contribution level: a level is paid by everyone who put in at least that
 * much, and only those of them still in may win it, so nobody wins from an opponent more than they
 * staked themselves. Levels with the same contenders merge into one pot (folded chips just add to
 * it). The biggest contributor never folded, so every pot has a contender; a pot with a single
 * contender is that seat's uncalled chips coming back.
 */
function buildPots(seats: PokerSeat[]): { amount: number; contenders: number[] }[] {
  const levels = [...new Set(seats.map((s) => s.total).filter((t) => t > 0))].sort((a, b) => a - b);
  const pots: { amount: number; contenders: number[] }[] = [];
  let prev = 0;
  for (const level of levels) {
    const amount = (level - prev) * seats.filter((s) => s.total >= level).length;
    const contenders = seats.flatMap((s, i) => (!s.folded && s.total >= level ? [i] : []));
    const last = pots.at(-1);
    if (last && last.contenders.join() === contenders.join()) last.amount += amount;
    else pots.push({ amount, contenders });
    prev = level;
  }
  return pots;
}

function showdown(h: PokerHand): PokerHand {
  const n = h.seats.length;
  const made = h.seats.map((s) => (s.folded ? null : evaluate([...s.cards, ...h.board])));
  const won = h.seats.map(() => 0);
  // Seats in order starting left of the button: the first tied winner gets the odd chips.
  const fromButton = (i: number) => (i - h.button - 1 + n) % n;
  for (const pot of buildPots(h.seats)) {
    let winners: number[] = [];
    let best: number[] | null = null;
    for (const i of pot.contenders) {
      const score = made[i]?.score ?? [];
      const cmp = best === null ? 1 : compareScores(score, best);
      if (cmp > 0) {
        best = score;
        winners = [i];
      } else if (cmp === 0) winners.push(i);
    }
    winners.sort((a, b) => fromButton(a) - fromButton(b));
    const share = Math.floor(pot.amount / winners.length);
    for (const i of winners) won[i] = (won[i] ?? 0) + share;
    const odd = winners[0] as number;
    won[odd] = (won[odd] ?? 0) + pot.amount - share * winners.length;
  }
  return finish(
    h,
    h.seats.map((s, i) => {
      const w = won[i] ?? 0;
      const m = made[i];
      return {
        id: s.id,
        won: w,
        net: w - s.total,
        shown: m ? [...s.cards] : null,
        hand: m ? m.name : null,
      };
    }),
  );
}
