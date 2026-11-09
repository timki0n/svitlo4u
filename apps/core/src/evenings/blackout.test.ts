import { describe, expect, it } from "vitest";
import {
  act,
  BLACKOUT_ACTIONS,
  BLACKOUT_MAX,
  type BlackoutCard,
  type BlackoutGame,
  type BlackoutLast,
  type BlackoutLegal,
  type BlackoutMove,
  forfeit,
  legalFor,
  newBlackout,
  resolve,
  viewBlackout,
  waitingFor,
} from "./blackout.ts";

/** Seeded LCG so every deck in these tests is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Never swaps: the action cards stay kind by kind (PK SH SK AT ST NO), the pile keeps the rest in
 * order followed by GN GN and the blackouts, and the last seat starts.
 */
const inOrder = () => 0.999999;

/** Gives `values` one by one, then behaves like inOrder. */
function scripted(...values: number[]): () => number {
  let k = 0;
  return () => values[k++] ?? 0.999999;
}

/** Ids differ from seat indexes so a mix-up between the two cannot pass. */
const A = 11;
const B = 12;
const C = 13;
const D = 14;

const cards = (s: string): BlackoutCard[] => (s === "" ? [] : (s.split(" ") as BlackoutCard[]));

/**
 * A position by hand: hands by seat (ids 11, 12, …) and the draw pile (top first); seat 0 on its
 * only turn, nothing pending, nothing discarded. `over` sets anything else.
 */
function position(hands: string[], deck: string, over: Partial<BlackoutGame> = {}): BlackoutGame {
  return {
    phase: "playing",
    players: hands.map((h, i) => ({ id: 11 + i, hand: cards(h), out: false })),
    deck: cards(deck),
    discard: [],
    turn: 0,
    turns: 1,
    pending: null,
    defusing: false,
    peek: null,
    winner: null,
    out: [],
    last: null,
    ...over,
  };
}

/** The same position with these players out (and their hands gone). */
const withOut = (g: BlackoutGame, ...ids: number[]): BlackoutGame => ({
  ...g,
  players: g.players.map((p) => (ids.includes(p.id) ? { ...p, hand: [], out: true } : p)),
  out: [...g.out, ...ids],
});

const play = (card: BlackoutCard, target?: number): BlackoutMove =>
  target === undefined ? { type: "play", card } : { type: "play", card, target };
const draw: BlackoutMove = { type: "draw" };
const nope: BlackoutMove = { type: "nope" };
const tuck = (at: number): BlackoutMove => ({ type: "tuck", at });
const nothing: BlackoutLegal = { play: [], targets: [], draw: false, nope: false, tuck: false };

/** A move where a random tuck (if any) goes to the bottom. */
const go = (g: BlackoutGame, id: number, move: BlackoutMove) => act(g, id, move, inOrder);
/** Plays an action and lets it happen; a shuffle keeps the order, a steal takes the last card. */
const played = (g: BlackoutGame, id: number, card: BlackoutCard, target?: number) =>
  resolve(go(g, id, play(card, target)), inOrder);

const hand = (g: BlackoutGame, id: number) => g.players.find((p) => p.id === id)?.hand;
/** Every card of the game: hands, both piles, and a blackout held aside to tuck back. */
const everyCard = (g: BlackoutGame): BlackoutCard[] => [
  ...g.players.flatMap((p) => p.hand),
  ...g.deck,
  ...g.discard,
  ...(g.defusing ? (["BL"] as BlackoutCard[]) : []),
];
const tally = (all: BlackoutCard[]) => {
  const count = new Map<BlackoutCard, number>();
  for (const c of all) count.set(c, (count.get(c) ?? 0) + 1);
  return count;
};

describe("the deal", () => {
  it("a GN and four actions a hand; the pile: the rest, two more GN, a BL for all but one", () => {
    for (let n = 2; n <= BLACKOUT_MAX; n++) {
      const ids = [1, 2, 3, 4, 5, 6].slice(0, n);
      const g = newBlackout(ids, lcg(n));
      const sets = n <= 3 ? 1 : 2;
      for (const p of g.players) {
        expect(p.hand).toHaveLength(5);
        expect(p.hand.filter((c) => c === "GN")).toHaveLength(1);
        expect(p.hand).not.toContain("BL");
        expect(p.out).toBe(false);
      }
      expect(g.players.map((p) => p.id)).toEqual(ids);
      const pile = tally(g.deck);
      expect(pile.get("BL")).toBe(n - 1);
      expect(pile.get("GN")).toBe(2);
      const all = tally(everyCard(g));
      for (const [card, count] of Object.entries(BLACKOUT_ACTIONS))
        expect(all.get(card as BlackoutCard)).toBe(count * sets);
      expect(all.get("GN")).toBe(n + 2);
      expect(all.get("BL")).toBe(n - 1);
      expect(all.size).toBe(8);
      expect(g.deck).toHaveLength(23 * sets - 4 * n + 2 + (n - 1));
      expect(g.discard).toEqual([]);
      expect(g).toMatchObject({
        phase: "playing",
        turns: 1,
        pending: null,
        defusing: false,
        peek: null,
        winner: null,
        out: [],
        last: null,
      });
      expect(viewBlackout(g, null).blackouts).toBe(n - 1);
      expect(newBlackout(ids, lcg(n))).toEqual(g);
      expect(newBlackout(ids, lcg(n + 10))).not.toEqual(g);
    }
  });

  it("deals from the front of the shuffled actions, in seat order; one set or two", () => {
    const g = newBlackout([A, B], inOrder);
    expect(g.players).toEqual([
      { id: A, hand: cards("GN PK PK PK PK"), out: false },
      { id: B, hand: cards("GN SH SH SH SH"), out: false },
    ]);
    expect(g.deck).toEqual(cards("SK SK SK SK AT AT AT ST ST ST ST NO NO NO NO GN GN BL"));
    expect(g.turn).toBe(1);

    const four = newBlackout([A, B, C, D], inOrder);
    expect(four.players.map((p) => p.hand)).toEqual([
      cards("GN PK PK PK PK"),
      cards("GN PK PK PK PK"),
      cards("GN SH SH SH SH"),
      cards("GN SH SH SH SH"),
    ]);
    // two sets: eight of each kind but six "AT"; 16 of the 46 dealt, two GN and three BL added
    expect(four.deck).toEqual([
      ...cards("SK SK SK SK SK SK SK SK AT AT AT AT AT AT"),
      ...cards("ST ST ST ST ST ST ST ST NO NO NO NO NO NO NO NO"),
      ...cards("GN GN BL BL BL"),
    ]);
    expect(four.turn).toBe(3);
    expect(newBlackout([1, 2, 3, 4, 5, 6], inOrder).deck).toHaveLength(46 - 24 + 2 + 5);
  });

  it("a random seat starts: Math.floor(rand() * n) after the two shuffles", () => {
    const starts = new Set<number>();
    for (let seed = 1; seed <= 100; seed++) starts.add(newBlackout([A, B, C], lcg(seed)).turn);
    expect([...starts].sort()).toEqual([0, 1, 2]);
    // three players: 22 swaps for the 23 action cards, then 14 for the pile of 15
    const filler = Array<number>(36).fill(0.999999);
    expect(newBlackout([A, B, C], scripted(...filler, 0.5)).turn).toBe(1);
    expect(newBlackout([A, B, C], scripted(...filler, 0)).turn).toBe(0);
    // a sloppy rand() of 1 still picks a seat
    expect(newBlackout([A, B, C], () => 1).turn).toBe(2);
  });

  it("refuses fewer than two players, more than six, or the same one twice", () => {
    expect(() => newBlackout([A], inOrder)).toThrow("bad_players");
    expect(() => newBlackout([], inOrder)).toThrow("bad_players");
    expect(() => newBlackout([1, 2, 3, 4, 5, 6, 7], inOrder)).toThrow("bad_players");
    expect(() => newBlackout([A, B, A], inOrder)).toThrow("bad_players");
  });
});

describe("playing an action", () => {
  it("the card goes to the discard pile at once and waits as pending; nothing happens yet", () => {
    const g0 = position(["PK SH NO", "NO GN", "SK"], "SK AT ST BL");
    const g = go(g0, A, play("PK"));
    expect(hand(g, A)).toEqual(cards("SH NO"));
    expect(g.discard).toEqual(["PK"]);
    expect(g.pending).toEqual({ by: A, card: "PK", target: null, nopes: 0 });
    expect(g.last).toEqual({ id: A, kind: "play", card: "PK", target: null });
    expect(g.peek).toBeNull();
    expect(g.deck).toEqual(g0.deck);
    expect(g).toMatchObject({ turn: 0, turns: 1 });
    // the window has its own timer
    expect(waitingFor(g)).toBeNull();
    expect(legalFor(g, A)).toEqual({ ...nothing, nope: true });
    expect(legalFor(g, B)).toEqual({ ...nothing, nope: true });
    expect(legalFor(g, C)).toEqual(nothing);
    expect(() => go(g, A, play("SH"))).toThrow("pending");
    expect(() => go(g, A, draw)).toThrow("pending");
    // a target given with any card but "ST" is ignored
    expect(go(g0, A, play("SH", B)).pending).toEqual({ by: A, card: "SH", target: null, nopes: 0 });
  });

  it("any number of actions one after another, then the draw ends the turn", () => {
    let g = position(["PK SH SH GN", "GN"], "SK AT ST BL");
    g = played(g, A, "PK");
    g = played(g, A, "SH");
    g = played(g, A, "SH");
    expect(waitingFor(g)).toBe(A);
    g = go(g, A, draw);
    expect(hand(g, A)).toEqual(cards("GN SK"));
    expect(g.discard).toEqual(cards("PK SH SH"));
    expect(g.turn).toBe(1);
  });
});

describe("resolve", () => {
  it("«Глянути графік»: the top three, shown only to the one who looked", () => {
    const g0 = position(["PK GN", "GN", "GN"], "SK BL AT ST NO");
    const g = played(g0, A, "PK");
    expect(g.peek).toEqual({ id: A, cards: cards("SK BL AT") });
    expect(g.pending).toBeNull();
    expect(g.last).toEqual({ id: A, kind: "done", card: "PK", target: null });
    expect(g.deck).toEqual(g0.deck);
    expect(g).toMatchObject({ turn: 0, turns: 1 });
    expect(waitingFor(g)).toBe(A);
    expect(viewBlackout(g, A).peek).toEqual(cards("SK BL AT"));
    for (const viewer of [B, C, null, 99]) expect(viewBlackout(g, viewer).peek).toBeNull();
    // fewer when the pile is short
    expect(played(position(["PK", "GN"], "BL ST"), A, "PK").peek).toEqual({
      id: A,
      cards: cards("BL ST"),
    });
    // gone once the pile changes
    const drew = go(g, A, draw);
    expect(drew.peek).toBeNull();
    expect(viewBlackout(drew, A).peek).toBeNull();
  });

  it("the peek stays while the pile does, into the next player's turn", () => {
    let g = played(played(position(["PK SK", "GN", "GN"], "AT BL ST"), A, "PK"), A, "SK");
    expect(g.turn).toBe(1);
    expect(viewBlackout(g, A).peek).toEqual(cards("AT BL ST"));
    expect(viewBlackout(g, B).peek).toBeNull();
    g = go(g, B, draw);
    expect(g.peek).toBeNull();
    expect(viewBlackout(g, A).peek).toBeNull();
  });

  it("«Перемішати» shuffles the pile with rand, and the peek is gone", () => {
    const g0 = position(["PK SH GN", "GN"], "SK AT ST");
    const g = resolve(go(played(g0, A, "PK"), A, play("SH")), scripted(0, 0));
    expect(g.deck).toEqual(cards("AT ST SK"));
    expect(g.peek).toBeNull();
    expect(g.pending).toBeNull();
    expect(g.last).toEqual({ id: A, kind: "done", card: "SH", target: null });
    expect(g).toMatchObject({ turn: 0, turns: 1 });
    // even when the order happens to stay
    expect(played(played(g0, A, "PK"), A, "SH")).toMatchObject({
      deck: cards("SK AT ST"),
      peek: null,
    });
  });

  it("«Пропустити» ends a turn without drawing; with two turns to take, one is left", () => {
    const g0 = position(["SK SK GN", "GN", "GN"], "AT BL");
    const g = played(g0, A, "SK");
    expect(g).toMatchObject({ turn: 1, turns: 1 });
    expect(hand(g, A)).toEqual(cards("SK GN"));
    expect(g.deck).toEqual(g0.deck);
    expect(g.discard).toEqual(["SK"]);
    expect(g.last).toEqual({ id: A, kind: "done", card: "SK", target: null });
    expect(waitingFor(g)).toBe(B);

    const two = played({ ...g0, turns: 2 }, A, "SK");
    expect(two).toMatchObject({ turn: 0, turns: 1 });
    expect(played(two, A, "SK")).toMatchObject({ turn: 1, turns: 1 });
    // past a player who is out
    expect(played(withOut(g0, B), A, "SK").turn).toBe(2);
    // from the last seat round to the first
    expect(played(position(["GN", "GN", "SK"], "BL", { turn: 2 }), C, "SK").turn).toBe(0);
  });

  it("«Перекинути»: the next player takes two turns — never more", () => {
    const g0 = position(["AT GN", "AT GN", "GN"], "SK ST BL BL");
    let g = played(g0, A, "AT");
    expect(g).toMatchObject({ turn: 1, turns: 2 });
    expect(g.deck).toEqual(g0.deck);
    expect(hand(g, A)).toEqual(["GN"]);
    expect(g.last).toEqual({ id: A, kind: "done", card: "AT", target: null });
    // thrown on again: two, not four
    g = played(g, B, "AT");
    expect(g).toMatchObject({ turn: 2, turns: 2 });
    g = go(g, C, draw);
    expect(g).toMatchObject({ turn: 2, turns: 1 });
    g = go(g, C, draw);
    expect(g).toMatchObject({ turn: 0, turns: 1 });
    expect(hand(g, C)).toEqual(cards("GN SK ST"));
    // with two turns of their own still to take, both end
    expect(played({ ...g0, turns: 2 }, A, "AT")).toMatchObject({ turn: 1, turns: 2 });
    // past a player who is out
    expect(played(withOut(g0, B), A, "AT")).toMatchObject({ turn: 2, turns: 2 });
  });

  it("«Вкрасти»: a random card of the target's goes to the thief", () => {
    const g0 = position(["ST GN", "GN NO PK", "SK"], "BL");
    const g1 = go(g0, A, play("ST", B));
    expect(g1.pending).toEqual({ by: A, card: "ST", target: B, nopes: 0 });
    expect(g1.last).toEqual({ id: A, kind: "play", card: "ST", target: B });
    const g = resolve(g1, scripted(0.5));
    expect(hand(g, A)).toEqual(cards("GN NO"));
    expect(hand(g, B)).toEqual(cards("GN PK"));
    expect(hand(g, C)).toEqual(["SK"]);
    expect(g.last).toEqual({ id: A, kind: "steal", card: "ST", target: B });
    expect(g.pending).toBeNull();
    expect(g).toMatchObject({ turn: 0, turns: 1 });
    expect(hand(resolve(g1, scripted(0)), A)).toEqual(cards("GN GN"));
    expect(hand(resolve(g1, scripted(0)), B)).toEqual(cards("NO PK"));
    // the other player
    expect(hand(played(g0, A, "ST", C), A)).toEqual(cards("GN SK"));
  });

  it("«Вкрасти» from an empty hand takes nothing", () => {
    const g = played(position(["ST GN", "", "SK"], "BL"), A, "ST", B);
    expect(hand(g, A)).toEqual(["GN"]);
    expect(hand(g, B)).toEqual([]);
    expect(g.last).toEqual({ id: A, kind: "steal", card: "ST", target: B });
    expect(g.turn).toBe(0);
  });

  it("«Вкрасти» needs another player who is still in", () => {
    const g0 = position(["ST GN", "GN", "SK"], "BL");
    expect(() => go(g0, A, play("ST"))).toThrow("bad_target");
    expect(() => go(g0, A, play("ST", A))).toThrow("bad_target");
    expect(() => go(g0, A, play("ST", 99))).toThrow("bad_target");
    expect(() => go(withOut(g0, C), A, play("ST", C))).toThrow("bad_target");
    expect(go(withOut(g0, C), A, play("ST", B)).pending?.target).toBe(B);
  });

  it("only with an action pending", () => {
    expect(() => resolve(position(["GN", "GN"], "BL"), inOrder)).toThrow("nothing_pending");
  });
});

describe("«Скасувати»", () => {
  const g0 = position(["AT NO GN", "NO GN", "NO"], "SK BL");

  it("one cancel: the action does not happen, its card is spent all the same", () => {
    let g = go(g0, A, play("AT"));
    g = go(g, B, nope);
    expect(g.pending).toEqual({ by: A, card: "AT", target: null, nopes: 1 });
    expect(g.discard).toEqual(cards("AT NO"));
    expect(hand(g, B)).toEqual(["GN"]);
    expect(g.last).toEqual({ id: B, kind: "nope", card: "NO", target: null });
    expect(waitingFor(g)).toBeNull();
    expect(legalFor(g, B)).toEqual(nothing);
    expect(legalFor(g, A)).toEqual({ ...nothing, nope: true });
    expect(legalFor(g, C)).toEqual({ ...nothing, nope: true });
    const r = resolve(g, inOrder);
    expect(r.pending).toBeNull();
    expect(r.last).toEqual({ id: A, kind: "cancelled", card: "AT", target: null });
    expect(r).toMatchObject({ turn: 0, turns: 1 });
    expect(r.discard).toEqual(cards("AT NO"));
    expect(waitingFor(r)).toBe(A);
    expect(legalFor(r, A).draw).toBe(true);
  });

  it("a cancel cancelled: the action happens; a third cancels it again", () => {
    let g = go(go(go(g0, A, play("AT")), B, nope), C, nope);
    expect(g.pending?.nopes).toBe(2);
    const happened = resolve(g, inOrder);
    expect(happened.last).toEqual({ id: A, kind: "done", card: "AT", target: null });
    expect(happened).toMatchObject({ turn: 1, turns: 2 });
    g = go(g, A, nope);
    expect(g.pending?.nopes).toBe(3);
    expect(g.discard).toEqual(cards("AT NO NO NO"));
    const cancelled = resolve(g, inOrder);
    expect(cancelled.last?.kind).toBe("cancelled");
    expect(cancelled).toMatchObject({ turn: 0, turns: 1 });
  });

  it("the one who played the action may cancel it themselves", () => {
    const own = go(go(position(["ST NO GN", "PK"], ""), A, play("ST", B)), A, nope);
    expect(own.pending).toEqual({ by: A, card: "ST", target: B, nopes: 1 });
    expect(own.last).toEqual({ id: A, kind: "nope", card: "NO", target: null });
    const r = resolve(own, inOrder);
    expect(r.last).toEqual({ id: A, kind: "cancelled", card: "ST", target: B });
    expect(hand(r, A)).toEqual(["GN"]);
    expect(hand(r, B)).toEqual(["PK"]);
  });

  it("only with one in hand, only while an action is pending, only while still in", () => {
    const g = go(position(["PK GN", "GN", "NO"], "BL"), A, play("PK"));
    expect(() => go(g, B, nope)).toThrow("no_card");
    expect(() => go(g, A, nope)).toThrow("no_card");
    expect(() => go(position(["PK", "NO"], "BL"), B, nope)).toThrow("nothing_pending");
    expect(() => go(withOut(g, C), C, nope)).toThrow("not_in_game");
  });
});

describe("drawing", () => {
  it("any card but a blackout goes to the hand, unnamed in `last`; the turn passes", () => {
    const g0 = position(["GN", "GN", "GN"], "SK BL");
    const g = go(g0, A, draw);
    expect(hand(g, A)).toEqual(cards("GN SK"));
    expect(g.deck).toEqual(["BL"]);
    expect(g.discard).toEqual([]);
    expect(g.last).toEqual({ id: A, kind: "draw", card: null, target: null });
    expect(g).toMatchObject({ turn: 1, turns: 1, defusing: false });
    expect(waitingFor(g)).toBe(B);
    for (const viewer of [B, C, null])
      expect(JSON.stringify(viewBlackout(g, viewer))).not.toContain('"SK"');
    expect(viewBlackout(g, A).hand).toEqual(cards("GN SK"));
  });

  it("with two turns to take, the first draw leaves one", () => {
    let g = go(position(["GN", "GN"], "SK AT BL", { turns: 2 }), A, draw);
    expect(g).toMatchObject({ turn: 0, turns: 1 });
    g = go(g, A, draw);
    expect(g).toMatchObject({ turn: 1, turns: 1 });
    expect(hand(g, A)).toEqual(cards("GN SK AT"));
  });

  it("the turn passes over players who are out", () => {
    const g0 = withOut(position(["GN", "", "GN", "GN"], "SK AT BL"), B);
    expect(go(g0, A, draw).turn).toBe(2);
    expect(go({ ...g0, turn: 3 }, D, draw).turn).toBe(0);
  });

  it("an empty pile (which cannot happen while two are in) just ends the turn", () => {
    const g = go(position(["GN", "GN"], ""), A, draw);
    expect(hand(g, A)).toEqual(["GN"]);
    expect(g).toMatchObject({ turn: 1, turns: 1, phase: "playing" });
    expect(g.last).toEqual({ id: A, kind: "draw", card: null, target: null });
  });
});

describe("a blackout", () => {
  const g0 = position(["GN PK", "GN", "GN"], "BL SK AT ST", {
    peek: { id: A, cards: cards("BL SK AT") },
  });
  const defusing = go(g0, A, draw);

  it("with a generator: it is spent, and the blackout must be tucked back", () => {
    expect(hand(defusing, A)).toEqual(["PK"]);
    expect(defusing.discard).toEqual(["GN"]);
    expect(defusing.deck).toEqual(cards("SK AT ST"));
    expect(defusing.defusing).toBe(true);
    expect(defusing.peek).toBeNull();
    expect(defusing.last).toEqual({ id: A, kind: "defuse", card: "BL", target: null });
    expect(defusing).toMatchObject({ turn: 0, turns: 1 });
    expect(waitingFor(defusing)).toBe(A);
    expect(legalFor(defusing, A)).toEqual({ ...nothing, tuck: true });
    expect(legalFor(defusing, B)).toEqual(nothing);
    expect(viewBlackout(defusing, B).blackouts).toBe(0);
    expect(() => go(defusing, A, draw)).toThrow("defusing");
    expect(() => go(defusing, A, play("PK"))).toThrow("defusing");
    expect(() => go(defusing, B, tuck(0))).toThrow("not_your_turn");
    expect(everyCard(defusing)).toHaveLength(everyCard(g0).length);
  });

  it("tucked back on top, at the bottom, anywhere between or at random; the turn ends", () => {
    const top = go(defusing, A, tuck(0));
    expect(top.deck).toEqual(cards("BL SK AT ST"));
    expect(top.defusing).toBe(false);
    expect(top.last).toEqual({ id: A, kind: "tuck", card: null, target: null });
    expect(top).toMatchObject({ turn: 1, turns: 1 });
    expect(waitingFor(top)).toBe(B);
    expect(viewBlackout(top, B).blackouts).toBe(1);
    expect(go(defusing, A, tuck(1)).deck).toEqual(cards("SK BL AT ST"));
    expect(go(defusing, A, tuck(3)).deck).toEqual(cards("SK AT ST BL"));
    // at random: any of the four places, by rand
    expect(act(defusing, A, tuck(-1), scripted(0)).deck).toEqual(cards("BL SK AT ST"));
    expect(act(defusing, A, tuck(-1), scripted(0.5)).deck).toEqual(cards("SK AT BL ST"));
    expect(act(defusing, A, tuck(-1), scripted(0.99)).deck).toEqual(cards("SK AT ST BL"));
    for (const at of [4, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => go(defusing, A, tuck(at))).toThrow("bad_position");
    // with two turns to take, the tuck ends one of them
    const twice = go(go({ ...g0, turns: 2 }, A, draw), A, tuck(0));
    expect(twice).toMatchObject({ turn: 0, turns: 1, defusing: false });
    expect(twice.deck[0]).toBe("BL");
  });

  it("without a generator: out — their cards and the blackout to the discard pile", () => {
    const g = go(position(["PK SK", "GN", "GN"], "BL ST", { turns: 2 }), A, draw);
    expect(g.players[0]).toEqual({ id: A, hand: [], out: true });
    expect(g.discard).toEqual(cards("PK SK BL"));
    expect(g.deck).toEqual(["ST"]);
    expect(g.out).toEqual([A]);
    expect(g.last).toEqual({ id: A, kind: "out", card: "BL", target: null });
    expect(g).toMatchObject({ phase: "playing", turn: 1, turns: 1, defusing: false });
    expect(waitingFor(g)).toBe(B);
    expect(legalFor(g, A)).toEqual(nothing);
    expect(legalFor(g, B).targets).toEqual([C]);
    expect(viewBlackout(g, A).legal).toBeNull();
    expect(() => go(g, A, draw)).toThrow("not_in_game");
    // from now on the turn passes over them
    expect(go(go(g, B, draw), C, draw).turn).toBe(1);
  });

  it("the last one still in wins", () => {
    const g = go(position(["SK", "GN"], "BL SK"), A, draw);
    expect(g).toMatchObject({ phase: "done", winner: B, out: [A] });
    expect(waitingFor(g)).toBeNull();
    for (const id of [A, B]) expect(legalFor(g, id)).toEqual(nothing);
    expect(viewBlackout(g, B).legal).toBeNull();
    expect(() => go(g, B, draw)).toThrow("not_playing");
    expect(() => resolve(g, inOrder)).toThrow("not_playing");
    expect(forfeit(g, B)).toBe(g);

    const three = go(withOut(position(["", "GN", "PK"], "BL", { turn: 2 }), A), C, draw);
    expect(three).toMatchObject({ phase: "done", winner: B, out: [A, C] });
  });
});

describe("forfeit", () => {
  it("off turn: out, their cards to the discard pile; play goes on without them", () => {
    const g0 = position(["GN PK", "GN NO", "GN"], "SK BL BL");
    const g = forfeit(g0, B);
    expect(g.players[1]).toEqual({ id: B, hand: [], out: true });
    expect(g.discard).toEqual(cards("GN NO"));
    expect(g.out).toEqual([B]);
    expect(g).toMatchObject({ phase: "playing", turn: 0, turns: 1, last: null });
    expect(() => go(g, B, draw)).toThrow("not_in_game");
    expect(legalFor(g, B)).toEqual(nothing);
    expect(legalFor(g, A).targets).toEqual([C]);
    expect(go(g, A, draw).turn).toBe(2);
    // out already: nothing changes
    expect(forfeit(g, B)).toBe(g);
  });

  it("on turn: the next player is on, with a single turn", () => {
    const g = forfeit(position(["GN", "GN", "GN"], "BL BL", { turns: 2 }), A);
    expect(g).toMatchObject({ turn: 1, turns: 1 });
    expect(waitingFor(g)).toBe(B);
    expect(forfeit(position(["GN", "GN", "GN"], "BL BL", { turn: 2 }), C).turn).toBe(0);
  });

  it("while defusing: the blackout goes to the discard pile too", () => {
    const defusing = go(position(["GN PK", "GN", "GN"], "BL SK BL"), A, draw);
    const g = forfeit(defusing, A);
    expect(g.defusing).toBe(false);
    expect(g.discard).toEqual(cards("GN PK BL"));
    expect(g.deck).toEqual(cards("SK BL"));
    expect(g).toMatchObject({ turn: 1, turns: 1, out: [A] });
    expect(everyCard(g)).toHaveLength(everyCard(defusing).length);
  });

  it("an action of theirs still pending is dropped; another's stays", () => {
    const mine = go(position(["ST GN", "NO GN", "GN"], "BL BL"), A, play("ST", B));
    const g = forfeit(mine, A);
    expect(g.pending).toBeNull();
    expect(g.discard).toEqual(cards("ST GN"));
    expect(g).toMatchObject({ turn: 1, turns: 1 });
    expect(waitingFor(g)).toBe(B);
    expect(() => resolve(g, inOrder)).toThrow("nothing_pending");
    // the target gives up: the steal still happens, and takes nothing
    const theirs = forfeit(mine, B);
    expect(theirs.pending).toEqual({ by: A, card: "ST", target: B, nopes: 0 });
    expect(waitingFor(theirs)).toBeNull();
    const r = resolve(theirs, inOrder);
    expect(hand(r, A)).toEqual(["GN"]);
    expect(r.last).toEqual({ id: A, kind: "steal", card: "ST", target: B });
  });

  it("what they peeked at goes with them", () => {
    const looked = played(position(["PK GN", "GN", "GN"], "SK BL BL"), A, "PK");
    expect(forfeit(looked, A).peek).toBeNull();
    expect(forfeit(looked, B).peek).toEqual(looked.peek);
  });

  it("the last one still in wins; a pending action or a held blackout ends with the game", () => {
    let g = forfeit(position(["GN", "GN", "GN"], "BL BL"), A);
    g = forfeit(g, C);
    expect(g).toMatchObject({ phase: "done", winner: B, out: [A, C] });
    expect(waitingFor(g)).toBeNull();
    expect(legalFor(g, B)).toEqual(nothing);
    expect(forfeit(g, B)).toBe(g); // over is over
    expect(forfeit(g, 99)).toBe(g);

    const pending = go(position(["PK GN", "GN"], "BL"), A, play("PK"));
    expect(forfeit(pending, B)).toMatchObject({ phase: "done", winner: A, pending: null });

    const defusing = go(position(["GN", "GN"], "BL SK"), A, draw);
    const d = forfeit(defusing, B);
    expect(d).toMatchObject({ phase: "done", winner: A, defusing: false });
    expect(d.discard).toEqual(cards("GN GN BL"));
    expect(everyCard(d)).toHaveLength(everyCard(defusing).length);

    const fresh = newBlackout([A, B], lcg(1));
    const two = forfeit(fresh, A);
    expect(two).toMatchObject({ phase: "done", winner: B });
    expect(fresh.phase).toBe("playing");
    expect(() => forfeit(fresh, 99)).toThrow("not_in_game");
  });
});

describe("legalFor", () => {
  const g = position(["ST PK NO GN SK PK AT SH", "NO", "GN"], "BL BL");

  it("on turn: each action kind once, the others still in as targets, and the draw", () => {
    expect(legalFor(g, A)).toEqual({
      play: cards("PK SH SK AT ST"),
      targets: [B, C],
      draw: true,
      nope: false,
      tuck: false,
    });
    for (const id of [B, C, 99]) expect(legalFor(g, id)).toEqual(nothing);
    // a generator and a cancel are never played this way
    expect(legalFor(position(["GN NO", "GN"], "BL"), A)).toEqual({
      play: [],
      targets: [B],
      draw: true,
      nope: false,
      tuck: false,
    });
  });

  it("pending: only «Скасувати», for whoever holds one; defusing: only the tuck", () => {
    const pending = go(g, A, play("PK"));
    expect(legalFor(pending, A)).toEqual({ ...nothing, nope: true });
    expect(legalFor(pending, B)).toEqual({ ...nothing, nope: true });
    expect(legalFor(pending, C)).toEqual(nothing);
    const defusing = go(position(["GN NO ST", "NO"], "BL SK"), A, draw);
    expect(legalFor(defusing, A)).toEqual({ ...nothing, tuck: true });
    expect(legalFor(defusing, B)).toEqual(nothing);
  });

  it("nothing for one who is out, once it is over, or on a broken position", () => {
    const out = withOut(g, B);
    expect(legalFor(out, B)).toEqual(nothing);
    expect(legalFor(out, A).targets).toEqual([C]);
    expect(legalFor({ ...g, phase: "done" }, A)).toEqual(nothing);
    // never throws
    expect(legalFor({ ...g, turn: 7 }, A)).toEqual(nothing);
  });
});

describe("viewBlackout", () => {
  const g = position(["ST PK NO GN SK AT SH", "GN NO", "PK"], "SK BL AT BL ST", {
    discard: ["SH"],
  });

  it("the viewer's own cards, sorted; other hands and the pile as counts", () => {
    const view = viewBlackout(g, A);
    expect(view.hand).toEqual(cards("GN NO PK SH SK AT ST"));
    expect(view.players).toEqual([
      { id: A, cards: 7, out: false },
      { id: B, cards: 2, out: false },
      { id: C, cards: 1, out: false },
    ]);
    expect(view).toMatchObject({
      phase: "playing",
      deck: 5,
      blackouts: 2,
      discard: ["SH"],
      turn: 0,
      turns: 1,
      pending: null,
      defusing: false,
      peek: null,
      winner: null,
      out: [],
      last: null,
    });
    expect(view.legal).toEqual(legalFor(g, A));

    // C holds only PK and sees SH on the discard pile: no other card shows up anywhere
    const theirs = viewBlackout(g, C);
    expect(theirs.hand).toEqual(["PK"]);
    expect(theirs.legal).toEqual(nothing);
    const json = JSON.stringify(theirs);
    for (const c of cards("GN NO SK AT ST BL")) expect(json).not.toContain(`"${c}"`);
  });

  it("a spectator sees no hand and has no moves; one who is out or a game over has none", () => {
    for (const viewer of [null, 99]) {
      const view = viewBlackout(g, viewer);
      expect(view.hand).toEqual([]);
      expect(view.legal).toBeNull();
      expect(view.peek).toBeNull();
      expect(view.deck).toBe(5);
    }
    expect(viewBlackout(withOut(g, B), B).legal).toBeNull();
    const over = viewBlackout({ ...g, phase: "done", winner: A }, A);
    expect(over.legal).toBeNull();
    expect(over.hand).toEqual(cards("GN NO PK SH SK AT ST"));
  });
});

describe("refusals", () => {
  it("names every illegal move", () => {
    const g = position(["PK SK GN NO", "GN", "GN"], "BL SK");
    const pending = go(g, A, play("PK"));
    const defusing = go(position(["GN", "GN"], "BL SK"), A, draw);
    const cases: [() => unknown, string][] = [
      [() => newBlackout([A], inOrder), "bad_players"],
      [() => go({ ...g, phase: "done" }, A, draw), "not_playing"],
      [() => resolve({ ...pending, phase: "done" }, inOrder), "not_playing"],
      [() => go(g, 99, draw), "not_in_game"],
      [() => go(withOut(g, C), C, nope), "not_in_game"],
      [() => forfeit(g, 99), "not_in_game"],
      [() => go(g, B, draw), "not_your_turn"],
      [() => go(g, B, play("PK")), "not_your_turn"],
      [() => go(defusing, B, tuck(0)), "not_your_turn"],
      [() => go(g, A, play("SH")), "no_card"],
      [() => go(pending, B, nope), "no_card"],
      [() => go(g, A, play("GN")), "not_playable"],
      [() => go(g, A, play("NO")), "not_playable"],
      [() => go(g, A, play("BL")), "not_playable"],
      [() => go(g, A, play("XX" as BlackoutCard)), "not_playable"],
      [() => go(position(["ST", "GN"], "BL"), A, play("ST", A)), "bad_target"],
      [() => go(pending, A, play("SK")), "pending"],
      [() => go(pending, A, draw), "pending"],
      [() => go(defusing, A, draw), "defusing"],
      [() => go(defusing, A, play("PK")), "defusing"],
      [() => go(g, A, tuck(0)), "not_defusing"],
      [() => go(g, A, nope), "nothing_pending"],
      [() => resolve(g, inOrder), "nothing_pending"],
      [() => go(defusing, A, tuck(3)), "bad_position"],
      [() => go(g, A, { type: "pass" } as unknown as BlackoutMove), "bad_move"],
    ];
    for (const [f, code] of cases) expect(f).toThrowError(new RegExp(`^${code}$`));
  });
});

describe("purity", () => {
  it("never changes the game it was given", () => {
    const ids = [A, B, C];
    newBlackout(ids, lcg(1));
    expect(ids).toEqual([A, B, C]);

    const g0 = position(["PK SH ST AT NO GN", "SK NO GN", "GN SK"], "SK BL ST BL AT GN");
    const line: ((g: BlackoutGame) => BlackoutGame)[] = [
      (g) => go(g, A, play("PK")),
      (g) => resolve(g, inOrder), // A sees SK BL ST
      (g) => go(g, A, play("ST", B)),
      (g) => go(g, B, nope),
      (g) => go(g, A, nope),
      (g) => resolve(g, scripted(0)), // A takes B's SK
      (g) => go(g, A, play("SH")),
      (g) => resolve(g, inOrder),
      (g) => go(g, A, play("AT")),
      (g) => resolve(g, inOrder), // B takes two turns
      (g) => go(g, B, draw), // SK
      (g) => go(g, B, draw), // a blackout: B's generator saves them
      (g) => act(g, B, tuck(-1), scripted(0)), // back on top
      (g) => go(g, C, draw), // the same blackout: C's generator
      (g) => forfeit(g, C), // C gives up holding it
      (g) => go(g, A, draw), // ST
      (g) => go(g, B, draw), // a blackout, no generator left
    ];
    let g = g0;
    for (const step of line) {
      const before = structuredClone(g);
      const next = step(g);
      expect(g).toEqual(before);
      expect(next).not.toBe(g);
      expect(everyCard(next)).toHaveLength(everyCard(g0).length);
      const after = structuredClone(next);
      for (const id of ids) {
        const view = viewBlackout(next, id);
        view.hand.push("BL");
        view.discard.push("BL");
        view.out.push(99);
        view.peek?.push("BL");
        view.legal?.play.push("BL");
        view.legal?.targets.push(99);
        if (view.pending) view.pending.nopes = 99;
        if (view.last) view.last.kind = "out";
        legalFor(next, id).play.push("BL");
        forfeit(next, id);
      }
      expect(next).toEqual(after);
      g = next;
    }
    expect(g).toMatchObject({ phase: "done", winner: A, out: [C, B] });
    expect(hand(g, A)).toEqual(cards("GN SK ST"));
    expect(g0.deck).toEqual(cards("SK BL ST BL AT GN"));
    expect(g0.discard).toEqual([]);
  });
});

describe("random play", () => {
  it("keeps every card, never gets stuck, and always ends with a winner", () => {
    const rand = lcg(2026);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const kinds = new Set<BlackoutLast["kind"]>();
    let longest = 0;
    for (let game = 0; game < 300; game++) {
      const n = 2 + (game % 5);
      const ids = Array.from({ length: n }, (_, i) => 100 + i);
      let g = newBlackout(ids, rand);
      const full = [...everyCard(g)].sort();
      let moves = 0;
      for (; g.phase === "playing"; moves++) {
        expect(moves).toBeLessThan(2000);
        const before = moves % 20 === 0 ? structuredClone(g) : null;
        const prev = g;
        if (rand() < 0.003) {
          // now and then somebody gives up: on turn or not, defusing, with an action pending …
          g = forfeit(g, pick(g.players.filter((p) => !p.out)).id);
        } else if (g.pending !== null) {
          expect(waitingFor(g)).toBeNull();
          const nopers = ids.filter((id) => legalFor(g, id).nope);
          g =
            nopers.length > 0 && rand() < 0.4 ? act(g, pick(nopers), nope, rand) : resolve(g, rand);
        } else {
          const id = waitingFor(g) as number;
          const me = g.players[g.turn];
          expect(me?.id).toBe(id);
          expect(me?.out).toBe(false);
          for (const p of g.players) if (p.id !== id) expect(legalFor(g, p.id)).toEqual(nothing);
          const legal = legalFor(g, id);
          // whoever the clock runs on can always do something: draw, or tuck a blackout back
          expect(legal.draw).toBe(!g.defusing);
          expect(legal.tuck).toBe(g.defusing);
          if (legal.tuck) {
            const at = pick(Array.from({ length: g.deck.length + 2 }, (_, k) => k - 1));
            g = act(g, id, tuck(at), rand);
          } else if (legal.play.length > 0 && rand() < 0.6) {
            const card = pick(legal.play);
            g = act(g, id, card === "ST" ? play(card, pick(legal.targets)) : play(card), rand);
          } else {
            g = act(g, id, draw, rand);
          }
        }
        if (before) expect(prev).toEqual(before);
        if (g.last) kinds.add(g.last.kind);
        expect([...everyCard(g)].sort()).toEqual(full);
        for (const p of g.players) {
          expect(p.hand).not.toContain("BL");
          if (p.out) expect(p.hand).toEqual([]);
        }
        const out = g.players.filter((p) => p.out).map((p) => p.id);
        expect([...g.out].sort((a, b) => a - b)).toEqual(out);
        if (g.phase === "playing") {
          const left = n - out.length;
          expect(left).toBeGreaterThanOrEqual(2);
          // a blackout for all but one is always left (more once somebody gives up)
          const blackouts = g.deck.filter((c) => c === "BL").length + (g.defusing ? 1 : 0);
          expect(blackouts).toBeGreaterThanOrEqual(left - 1);
          expect([1, 2]).toContain(g.turns);
          if (g.pending) expect(g.pending.by).toBe(g.players[g.turn]?.id);
          if (g.pending) expect(g.defusing).toBe(false);
          // what was peeked at is still the top of the pile
          if (g.peek) expect(g.peek.cards).toEqual(g.deck.slice(0, 3));
        }
      }
      longest = Math.max(longest, moves);
      expect(g.winner).not.toBeNull();
      expect(g.players.filter((p) => !p.out).map((p) => p.id)).toEqual([g.winner]);
      expect(g.out).toHaveLength(n - 1);
      expect(g.pending).toBeNull();
      expect(g.defusing).toBe(false);
      expect(waitingFor(g)).toBeNull();
      expect(viewBlackout(g, g.winner).legal).toBeNull();
    }
    expect(longest).toBeGreaterThan(30);
    expect([...kinds].sort()).toEqual(
      ["cancelled", "defuse", "done", "draw", "nope", "out", "play", "steal", "tuck"].sort(),
    );
  });
});
