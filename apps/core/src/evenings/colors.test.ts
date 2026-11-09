import { describe, expect, it } from "vitest";
import {
  act,
  COLORS,
  COLORS_HAND,
  type ColorsCard,
  type ColorsColor,
  type ColorsGame,
  type ColorsMove,
  forfeit,
  legalFor,
  newColors,
  playable,
  viewColors,
  waitingFor,
} from "./colors.ts";

/** Seeded LCG so every deck in these tests is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Never swaps: the deck stays in order — colour by colour (r y g b), each as 0, 1 1, 2 2 … 9 9,
 * S S, R R, D D, then WW ×4 and W4 ×4 — and the last seat starts.
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

const cards = (s: string): ColorsCard[] => (s === "" ? [] : s.split(" "));

/**
 * A position by hand: hands by seat (ids 11, 12, …), the discard pile (top last) and the draw pile
 * (drawn from the front); seat 0 on turn, seat order, the top card's colour to follow. `over` sets
 * anything else.
 */
function position(
  hands: string[],
  discard: string,
  deck: string,
  over: Partial<ColorsGame> = {},
): ColorsGame {
  const pile = cards(discard);
  return {
    phase: "playing",
    players: hands.map((h, i) => ({ id: 11 + i, hand: cards(h), out: false })),
    deck: cards(deck),
    discard: pile,
    color: (pile.at(-1) ?? "r").charAt(0) as ColorsColor,
    turn: 0,
    direction: 1,
    drawn: null,
    winner: null,
    last: null,
    ...over,
  };
}

/** The same position with these players out (and their hands gone). */
const withOut = (g: ColorsGame, ...ids: number[]): ColorsGame => ({
  ...g,
  players: g.players.map((p) => (ids.includes(p.id) ? { ...p, hand: [], out: true } : p)),
});

const play = (card: ColorsCard, color?: ColorsColor): ColorsMove =>
  color === undefined ? { type: "play", card } : { type: "play", card, color };
const draw: ColorsMove = { type: "draw" };
const pass: ColorsMove = { type: "pass" };
const nothing = { play: [], draw: false, pass: false };

/** A move where a reshuffle (if any) keeps the order. */
const go = (g: ColorsGame, id: number, move: ColorsMove) => act(g, id, move, inOrder);

const hand = (g: ColorsGame, id: number) => g.players.find((p) => p.id === id)?.hand;
/** Every card of the game: hands, draw pile and discard pile. */
const everyCard = (g: ColorsGame) => [...g.players.flatMap((p) => p.hand), ...g.deck, ...g.discard];
const tally = (all: ColorsCard[]) => {
  const count = new Map<ColorsCard, number>();
  for (const c of all) count.set(c, (count.get(c) ?? 0) + 1);
  return count;
};
const isNumberCard = (c: ColorsCard) => /^[rygb][0-9]$/.test(c);

describe("the deck and the deal", () => {
  it("108 cards: per colour one 0 and two of every other value; four of each wild", () => {
    for (const n of [2, 4, 6]) {
      const all = everyCard(newColors([1, 2, 3, 4, 5, 6].slice(0, n), lcg(n)));
      expect(all).toHaveLength(108);
      const count = tally(all);
      for (const color of COLORS) {
        expect(count.get(`${color}0`)).toBe(1);
        for (const value of "123456789SRD") expect(count.get(color + value)).toBe(2);
      }
      expect(count.get("WW")).toBe(4);
      expect(count.get("W4")).toBe(4);
      expect(count.size).toBe(4 * 13 + 2);
    }
  });

  it("deals seven to each seat from the front; the first number card starts the pile", () => {
    const g = newColors([A, B], inOrder);
    expect(g.players).toEqual([
      { id: A, hand: cards("r0 r1 r1 r2 r2 r3 r3"), out: false },
      { id: B, hand: cards("r4 r4 r5 r5 r6 r6 r7"), out: false },
    ]);
    expect(g.discard).toEqual(["r7"]);
    expect(g.color).toBe("r");
    expect(g.deck).toHaveLength(108 - 15);
    expect(g.deck[0]).toBe("r8");
    expect(g).toMatchObject({
      phase: "playing",
      turn: 1,
      direction: 1,
      drawn: null,
      winner: null,
      last: null,
    });

    const six = newColors([1, 2, 3, 4, 5, 6], inOrder);
    expect(six.players[5]?.hand).toEqual(cards("y5 y6 y6 y7 y7 y8 y8"));
    expect(six.discard).toEqual(["y9"]);
    expect(six.color).toBe("y");
    expect(six.deck).toHaveLength(108 - 43);

    for (let n = 2; n <= 6; n++) {
      const ids = [1, 2, 3, 4, 5, 6].slice(0, n);
      const shuffled = newColors(ids, lcg(n));
      for (const p of shuffled.players) expect(p.hand).toHaveLength(COLORS_HAND);
      expect(shuffled.deck).toHaveLength(108 - COLORS_HAND * n - 1);
      expect(newColors(ids, lcg(n))).toEqual(shuffled);
      expect(newColors(ids, lcg(n + 10))).not.toEqual(shuffled);
    }
  });

  it("cards turned up before the first number go to the bottom of the deck, in order", () => {
    // The first swaps bring W4 (from the end) to index 14 and WW (index 103) to index 15: right
    // after the 14 cards dealt to two players.
    const g = newColors([A, B], scripted(14.5 / 108, 0.999999, 0.999999, 0.999999, 15.5 / 104));
    expect(g.players.map((p) => p.hand)).toEqual([
      cards("r0 r1 r1 r2 r2 r3 r3"),
      cards("r4 r4 r5 r5 r6 r6 r7"),
    ]);
    expect(g.discard).toEqual(["r8"]);
    expect(g.color).toBe("r");
    expect(g.deck[0]).toBe("r9");
    // ... WW WW WW r8 (swapped to 103) W4 W4 W4 r7 (swapped to 107), then the two turned up
    expect(g.deck.slice(-7)).toEqual(cards("r8 W4 W4 W4 r7 W4 WW"));
    expect(g.deck).toHaveLength(108 - 15);
    expect(everyCard(g)).toHaveLength(108);
  });

  it("the first discard is always a number card and sets the colour; a random seat starts", () => {
    const starts = new Set<number>();
    for (let seed = 1; seed <= 200; seed++) {
      const n = 2 + (seed % 5);
      const g = newColors([1, 2, 3, 4, 5, 6].slice(0, n), lcg(seed));
      expect(g.discard).toHaveLength(1);
      const first = g.discard[0] as ColorsCard;
      expect(isNumberCard(first)).toBe(true);
      expect(g.color).toBe(first.charAt(0));
      expect(g.turn).toBeGreaterThanOrEqual(0);
      expect(g.turn).toBeLessThan(n);
      expect(g.direction).toBe(1);
      if (n === 3) starts.add(g.turn);
    }
    expect([...starts].sort()).toEqual([0, 1, 2]);
    // the call after the shuffle (107 swaps) picks the seat: Math.floor(rand() * n)
    const filler = Array<number>(107).fill(0.999999);
    expect(newColors([A, B, C, D], scripted(...filler, 0.5)).turn).toBe(2);
    expect(newColors([A, B, C, D], scripted(...filler, 0)).turn).toBe(0);
    // a sloppy rand() of 1 still picks a seat
    expect(newColors([A, B, C], () => 1).turn).toBe(2);
  });

  it("refuses fewer than two players, more than six, or the same one twice", () => {
    expect(() => newColors([A], inOrder)).toThrow("bad_players");
    expect(() => newColors([], inOrder)).toThrow("bad_players");
    expect(() => newColors([1, 2, 3, 4, 5, 6, 7], inOrder)).toThrow("bad_players");
    expect(() => newColors([A, B, A], inOrder)).toThrow("bad_players");
  });
});

describe("playable", () => {
  it("the colour to follow, the same value, or a wild", () => {
    // by colour
    expect(playable("r3", "r7", "r")).toBe(true);
    expect(playable("rS", "r7", "r")).toBe(true);
    expect(playable("g3", "r7", "r")).toBe(false);
    // by value, across colours
    expect(playable("b7", "r7", "r")).toBe(true);
    expect(playable("gS", "yS", "y")).toBe(true);
    expect(playable("bR", "gR", "g")).toBe(true);
    expect(playable("rD", "yD", "y")).toBe(true);
    expect(playable("gS", "yR", "y")).toBe(false);
    expect(playable("g7", "y5", "y")).toBe(false);
    // wilds always (the wild-four rule is not playable's business)
    for (const top of ["r7", "yS", "WW", "W4"]) {
      expect(playable("WW", top, "b")).toBe(true);
      expect(playable("W4", top, "b")).toBe(true);
    }
    // on a wild only the colour chosen counts; "W4" is no 4
    expect(playable("r4", "WW", "r")).toBe(true);
    expect(playable("b4", "WW", "r")).toBe(false);
    expect(playable("g4", "W4", "g")).toBe(true);
    expect(playable("b4", "W4", "g")).toBe(false);
    // not a card
    for (const bad of ["", "r", "x1", "rX", "r10", "W5", "w4"])
      expect(playable(bad, "r1", "r")).toBe(false);
  });
});

describe("playing a card", () => {
  it("a number card: its colour is followed next and the turn passes on", () => {
    let g = position(["r3 b7 g1", "y2 b3 g9", "r5 y7 b1"], "g5 r7", "y1 y2");
    expect(legalFor(g, A)).toEqual({ play: ["r3", "b7"], draw: true, pass: false });
    g = go(g, A, play("b7"));
    expect(g.color).toBe("b");
    expect(g.discard).toEqual(cards("g5 r7 b7"));
    expect(hand(g, A)).toEqual(cards("r3 g1"));
    expect(g.turn).toBe(1);
    expect(waitingFor(g)).toBe(B);
    expect(g.last).toEqual({ id: A, card: "b7", drew: false, penalty: null });
    expect(legalFor(g, B)).toEqual({ play: ["b3"], draw: true, pass: false });
    g = go(g, B, play("b3"));
    expect(legalFor(g, C)).toEqual({ play: ["b1"], draw: true, pass: false });
    g = go(g, C, play("b1"));
    expect(g.turn).toBe(0);
    expect(g.deck).toEqual(cards("y1 y2"));
  });

  it("a skip passes over the next player; with two the player goes again", () => {
    const g = go(position(["rS r1", "r2", "r3"], "r9", ""), A, play("rS"));
    expect(g.turn).toBe(2);
    expect(g.color).toBe("r");
    expect(g.last).toEqual({ id: A, card: "rS", drew: false, penalty: null });
    // a skip on a skip of another colour
    const two = go(position(["gS g1", "r2"], "rS", ""), A, play("gS"));
    expect(two.turn).toBe(0);
    expect(two.color).toBe("g");
    expect(waitingFor(two)).toBe(A);
  });

  it("a reverse turns the direction; with two still in it acts as a skip", () => {
    let g = go(position(["rR r1", "r2 r4", "r3 r5"], "r9", ""), A, play("rR"));
    expect(g.direction).toBe(-1);
    expect(g.turn).toBe(2);
    g = go(g, C, play("r3"));
    expect(g.turn).toBe(1);
    g = go(g, B, play("r2"));
    expect(g.turn).toBe(0);
    // back the other way
    const another = g.players.map((p) => (p.id === A ? { ...p, hand: [...p.hand, "rR"] } : p));
    g = go({ ...g, players: another }, A, play("rR"));
    expect(g.direction).toBe(1);
    expect(g.turn).toBe(1);

    const two = go(position(["rR r1", "r2"], "r9", ""), A, play("rR"));
    expect(two.direction).toBe(-1);
    expect(two.turn).toBe(0);
    // three seats, one of them out: two still in
    const left = go(withOut(position(["rR r1", "r2", "r3"], "r9", ""), B), A, play("rR"));
    expect(left.direction).toBe(-1);
    expect(left.turn).toBe(0);
  });

  it("a draw two: the next player draws two and is skipped", () => {
    const g = go(position(["rD r1", "g2", "b3"], "r9", "y1 y2 y3"), A, play("rD"));
    expect(hand(g, B)).toEqual(cards("g2 y1 y2"));
    expect(g.deck).toEqual(["y3"]);
    expect(g.turn).toBe(2);
    expect(g.color).toBe("r");
    expect(g.last).toEqual({ id: A, card: "rD", drew: false, penalty: { id: B, cards: 2 } });
    // by value on another colour's +2; with two the player goes again
    const two = go(position(["yD r1", "g2"], "rD", "y1 y2"), A, play("yD"));
    expect(hand(two, B)).toEqual(cards("g2 y1 y2"));
    expect(two.turn).toBe(0);
    expect(two.color).toBe("y");
  });

  it("a wild draw four: the colour chosen, the next player draws four and is skipped", () => {
    const g0 = position(["W4 g1", "g2", "b3"], "r9", "y1 y2 y3 y4 y5");
    expect(() => go(g0, A, play("W4"))).toThrow("pick_color");
    const g = go(g0, A, play("W4", "g"));
    expect(g.color).toBe("g");
    expect(g.discard).toEqual(cards("r9 W4"));
    expect(hand(g, B)).toEqual(cards("g2 y1 y2 y3 y4"));
    expect(g.deck).toEqual(["y5"]);
    expect(g.turn).toBe(2);
    expect(g.last).toEqual({ id: A, card: "W4", drew: false, penalty: { id: B, cards: 4 } });
    expect(legalFor(g, C)).toEqual({ play: [], draw: true, pass: false });
  });

  it("a wild draw four only without a card of the colour to follow", () => {
    // red to follow: r1 forbids it; b9 (the top's value, another colour) does not
    const red = position(["W4 r1 b9", "g2"], "r9", "");
    expect(legalFor(red, A).play).toEqual(["r1", "b9"]);
    expect(() => go(red, A, play("W4", "b"))).toThrow("wild_four_has_color");
    const g = position(["W4 b9 WW", "g2"], "r9", "y1 y2 y3 y4");
    expect(legalFor(g, A).play).toEqual(["b9", "WW", "W4"]);
    expect(go(g, A, play("W4", "y")).color).toBe("y");
    // after a wild, the colour chosen is what counts
    const chosen = position(["W4 r1", "g2"], "r9 WW", "", { color: "g" });
    expect(legalFor(chosen, A).play).toEqual(["W4"]);
    const greenInHand = position(["W4 g1", "g2"], "r9 WW", "", { color: "g" });
    expect(legalFor(greenInHand, A).play).toEqual(["g1"]);
  });

  it("a wild names the colour to follow, and must name one", () => {
    const g0 = position(["WW r1", "g2 b2", "y5"], "r9", "");
    expect(() => go(g0, A, play("WW"))).toThrow("pick_color");
    const odd = { type: "play", card: "WW", color: "x" } as unknown as ColorsMove;
    expect(() => go(g0, A, odd)).toThrow("pick_color");
    const g = go(g0, A, play("WW", "b"));
    expect(g.color).toBe("b");
    expect(g.turn).toBe(1);
    expect(g.last).toEqual({ id: A, card: "WW", drew: false, penalty: null });
    expect(legalFor(g, B).play).toEqual(["b2"]);
    // a colour given with a plain card is ignored
    expect(go(g0, A, play("r1", "b")).color).toBe("r");
  });

  it("the next player passes over players who are out, either way round", () => {
    const g0 = withOut(position(["r1 r2 rS rD rR", "", "r3 r4", "r5 r6"], "r9", "y1 y2"), B);
    expect(go(g0, A, play("r1")).turn).toBe(2);
    expect(go(g0, A, play("rS")).turn).toBe(3);
    const d = go(g0, A, play("rD"));
    expect(hand(d, C)).toEqual(cards("r3 r4 y1 y2"));
    expect(d.last?.penalty).toEqual({ id: C, cards: 2 });
    expect(d.turn).toBe(3);
    const r = go(g0, A, play("rR"));
    expect(r.direction).toBe(-1);
    expect(r.turn).toBe(3);
    // backwards from C: B is out, so A
    expect(go({ ...g0, turn: 2, direction: -1 }, C, play("r3")).turn).toBe(0);
  });
});

describe("drawing", () => {
  const g0 = position(["g1 b2", "y3"], "r9", "r5 y7");

  it("a playable card drawn may be played at once — only that card", () => {
    let g = go(g0, A, draw);
    expect(hand(g, A)).toEqual(cards("g1 b2 r5"));
    expect(g.drawn).toBe("r5");
    expect(g.turn).toBe(0);
    expect(waitingFor(g)).toBe(A);
    expect(g.deck).toEqual(["y7"]);
    expect(g.last).toEqual({ id: A, card: null, drew: true, penalty: null });
    expect(legalFor(g, A)).toEqual({ play: ["r5"], draw: false, pass: true });
    expect(() => go(g, A, draw)).toThrow("drew_already");
    g = go(g, A, play("r5"));
    expect(hand(g, A)).toEqual(cards("g1 b2"));
    expect(g.drawn).toBeNull();
    expect(g.turn).toBe(1);
    expect(g.discard).toEqual(cards("r9 r5"));
    expect(g.last).toEqual({ id: A, card: "r5", drew: false, penalty: null });

    // another card that would fit is not allowed after drawing
    const fits = go(position(["r1 b2", "y3"], "r9", "b9 y7"), A, draw);
    expect(fits.drawn).toBe("b9");
    expect(legalFor(fits, A).play).toEqual(["b9"]);
    expect(() => go(fits, A, play("r1"))).toThrow("must_play_drawn");
  });

  it("… or kept with a pass", () => {
    const g = go(go(g0, A, draw), A, pass);
    expect(hand(g, A)).toEqual(cards("g1 b2 r5"));
    expect(g.drawn).toBeNull();
    expect(g.turn).toBe(1);
    expect(g.last).toEqual({ id: A, card: null, drew: false, penalty: null });
    expect(() => go(g0, A, pass)).toThrow("nothing_drawn");
  });

  it("a card that cannot be played ends the turn at once", () => {
    const g = go(position(["g1 b2", "y3"], "r9", "y7 r5"), A, draw);
    expect(hand(g, A)).toEqual(cards("g1 b2 y7"));
    expect(g.drawn).toBeNull();
    expect(g.turn).toBe(1);
    expect(g.deck).toEqual(["r5"]);
    expect(g.last).toEqual({ id: A, card: null, drew: true, penalty: null });
  });

  it("a wild draw four drawn is playable only without the colour to follow", () => {
    const held = go(position(["r1", "y3"], "r9", "W4"), A, draw);
    expect(held.drawn).toBeNull();
    expect(held.turn).toBe(1);
    expect(hand(held, A)).toEqual(cards("r1 W4"));

    let g = go(position(["b1", "y3"], "r9", "W4 y1 y2 y3 y4"), A, draw);
    expect(g.drawn).toBe("W4");
    expect(legalFor(g, A)).toEqual({ play: ["W4"], draw: false, pass: true });
    g = go(g, A, play("W4", "y"));
    expect(hand(g, B)).toEqual(cards("y3 y1 y2 y3 y4"));
    expect(g.turn).toBe(0);
    expect(g.color).toBe("y");
  });

  it("an empty draw pile: the cards under the top one are shuffled into a new one", () => {
    const g0 = position(["g7", "y6"], "r1 r2 y3 g4 b5", "");
    const g = go(g0, A, draw);
    expect(g.discard).toEqual(["b5"]);
    expect(hand(g, A)).toEqual(cards("g7 r1"));
    expect(g.deck).toEqual(cards("r2 y3 g4"));
    expect(g.turn).toBe(1);
    // the shuffle takes rand(): here the first swap brings g4 to the front
    const r = act(g0, A, draw, scripted(0));
    expect(hand(r, A)).toEqual(cards("g7 g4"));
    expect(r.deck).toEqual(cards("r2 y3 r1"));
    expect(r.discard).toEqual(["b5"]);
    // a drawn card that fits may still be played after a reshuffle
    const fits = go(position(["g7", "y6"], "b1 r2 y3 b5", ""), A, draw);
    expect(fits.drawn).toBe("b1");
    expect(fits.turn).toBe(0);
  });

  it("nothing left to draw at all: the turn passes without a card", () => {
    const g = go(position(["g7", "y6"], "b5", ""), A, draw);
    expect(hand(g, A)).toEqual(["g7"]);
    expect(g.drawn).toBeNull();
    expect(g.turn).toBe(1);
    expect(g.deck).toEqual([]);
    expect(g.discard).toEqual(["b5"]);
    expect(g.last).toEqual({ id: A, card: null, drew: true, penalty: null });
  });

  it("a penalty reshuffles too, and draws only what there is", () => {
    const g = go(position(["W4 b2", "b3", "b4"], "r1 r2 r3 g5", "y1"), A, play("W4", "b"));
    expect(hand(g, B)).toEqual(cards("b3 y1 r1 r2 r3"));
    expect(g.deck).toEqual(["g5"]);
    expect(g.discard).toEqual(["W4"]);
    expect(g.color).toBe("b");
    expect(g.turn).toBe(2);
    expect(g.last?.penalty).toEqual({ id: B, cards: 4 });

    const short = go(position(["gD g1", "b3", "b4"], "g5", ""), A, play("gD"));
    expect(hand(short, B)).toEqual(cards("b3 g5"));
    expect(short.deck).toEqual([]);
    expect(short.discard).toEqual(["gD"]);
    expect(short.last?.penalty).toEqual({ id: B, cards: 1 });
    expect(short.turn).toBe(2);
  });
});

describe("the end", () => {
  it("who plays their last card wins at once", () => {
    const g = go(position(["r1", "b2", "y3"], "r9", "g1 g2"), A, play("r1"));
    expect(g.phase).toBe("done");
    expect(g.winner).toBe(A);
    expect(hand(g, A)).toEqual([]);
    expect(g.last).toEqual({ id: A, card: "r1", drew: false, penalty: null });
    expect(waitingFor(g)).toBeNull();
    for (const id of [A, B, C]) expect(legalFor(g, id)).toEqual(nothing);
    expect(() => go(g, B, draw)).toThrow("not_playing");

    // the last card's penalty no longer matters
    const d = go(position(["rD", "b2", "y3"], "r9", "g1 g2"), A, play("rD"));
    expect(d.winner).toBe(A);
    expect(hand(d, B)).toEqual(["b2"]);
    expect(d.deck).toEqual(cards("g1 g2"));
    expect(d.last?.penalty).toBeNull();
    // a last wild still names its colour
    const w = go(position(["WW", "b2"], "r9", ""), A, play("WW", "g"));
    expect(w.winner).toBe(A);
    expect(w.color).toBe("g");
  });
});

describe("forfeit", () => {
  it("who gives up is out, their cards go under the draw pile, and play goes on", () => {
    const g0 = position(["r1 r2", "b3 b4", "y5 y6"], "r9", "g1");
    const g = forfeit(g0, B);
    expect(g.players[1]).toEqual({ id: B, hand: [], out: true });
    expect(g.deck).toEqual(cards("g1 b3 b4"));
    expect(g.turn).toBe(0);
    expect(g.phase).toBe("playing");
    expect(() => go(g, B, draw)).toThrow("not_in_game");
    expect(legalFor(g, B)).toEqual(nothing);
    // the turn passes over them
    expect(go(g, A, play("r1")).turn).toBe(2);
    // out already: nothing changes
    expect(forfeit(g, B)).toBe(g);
  });

  it("on their turn: the turn passes on, and a card drawn stays with the hand", () => {
    const drew = go(position(["g1", "b3", "y5"], "r9", "r4"), A, draw);
    expect(drew.drawn).toBe("r4");
    const g = forfeit(drew, A);
    expect(g.turn).toBe(1);
    expect(g.drawn).toBeNull();
    expect(g.deck).toEqual(cards("g1 r4"));
    expect(waitingFor(g)).toBe(B);
    // against the direction too
    const back = forfeit(position(["g1", "b3", "y5"], "r9", "", { direction: -1 }), A);
    expect(back.turn).toBe(2);
  });

  it("the last one still in wins", () => {
    let g = forfeit(position(["r1", "b3", "y5"], "r9", ""), A);
    g = forfeit(g, C);
    expect(g.phase).toBe("done");
    expect(g.winner).toBe(B);
    expect(g.drawn).toBeNull();
    expect(waitingFor(g)).toBeNull();
    expect(legalFor(g, B)).toEqual(nothing);
    expect(forfeit(g, B)).toBe(g); // over is over

    const fresh = newColors([A, B], lcg(1));
    const two = forfeit(fresh, A);
    expect(two.winner).toBe(B);
    expect(fresh.phase).toBe("playing");
    expect(everyCard(two)).toHaveLength(108);
    expect(() => forfeit(fresh, 99)).toThrow("not_in_game");
  });
});

describe("legalFor", () => {
  it("moves only for the player on turn while the game goes on; each card once", () => {
    const g = position(["r5 W4 b5 r1 WW r5 y9", "g2", "b3"], "g5", "");
    expect(legalFor(g, A)).toEqual({ play: ["r5", "b5", "WW", "W4"], draw: true, pass: false });
    for (const id of [B, C, 99]) expect(legalFor(g, id)).toEqual(nothing);
    expect(legalFor({ ...g, phase: "done" }, A)).toEqual(nothing);
    // never throws, even on a broken position
    expect(legalFor({ ...g, turn: 7 }, A)).toEqual(nothing);
    expect(legalFor({ ...g, discard: [] }, A).play).toEqual(["WW", "W4"]);
  });
});

describe("viewColors", () => {
  const g = position(["W4 b1 rD y0 WW r7 gS r0", "g6 g8", "y4 y8"], "b6 b9", "r2 r3 r4");

  it("shows the viewer only their own cards, sorted; the piles as counts and the top", () => {
    const view = viewColors(g, A);
    expect(view.hand).toEqual(cards("r0 r7 rD y0 gS b1 WW W4"));
    expect(view.players).toEqual([
      { id: A, cards: 8, out: false },
      { id: B, cards: 2, out: false },
      { id: C, cards: 2, out: false },
    ]);
    expect(view).toMatchObject({
      phase: "playing",
      deck: 3,
      top: "b9",
      played: 2,
      color: "b",
      turn: 0,
      direction: 1,
      drawn: null,
      winner: null,
      last: null,
    });
    expect(view.legal).toEqual(legalFor(g, A));
    expect(view.legal?.play).toEqual(cards("b1 WW"));
    expect("discard" in view).toBe(false);
    const json = JSON.stringify(view);
    for (const c of cards("g6 g8 y4 y8 r2 r3 r4 b6")) expect(json).not.toContain(`"${c}"`);

    const other = viewColors(g, B);
    expect(other.hand).toEqual(cards("g6 g8"));
    expect(other.legal).toBeNull();
    expect(other.drawn).toBeNull();
  });

  it("the drawn card only to whoever drew it; a spectator sees no hand", () => {
    const drew = go(position(["g1", "y3"], "r9", "r5 b2"), A, draw);
    const mine = viewColors(drew, A);
    expect(mine.drawn).toBe("r5");
    expect(mine.legal).toEqual({ play: ["r5"], draw: false, pass: true });
    expect(mine.last).toEqual({ id: A, card: null, drew: true, penalty: null });
    const theirs = viewColors(drew, B);
    expect(theirs.drawn).toBeNull();
    expect(theirs.legal).toBeNull();
    expect(JSON.stringify(theirs)).not.toContain('"r5"');
    for (const viewer of [null, 99]) {
      const view = viewColors(drew, viewer);
      expect(view.hand).toEqual([]);
      expect(view.drawn).toBeNull();
      expect(view.legal).toBeNull();
      expect(JSON.stringify(view)).not.toContain('"r5"');
    }
    // nobody moves once it is over
    const over = viewColors(forfeit(drew, B), A);
    expect(over.winner).toBe(A);
    expect(over.legal).toBeNull();
    expect(over.drawn).toBeNull();
    expect(over.hand).toEqual(cards("r5 g1"));
  });
});

describe("refusals", () => {
  it("names every illegal move", () => {
    const g = position(["r1 g2 W4 WW", "b3"], "r9", "y1 y2");
    const drew = go(position(["g1", "b3"], "r9", "r5"), A, draw);
    const cases: [() => unknown, string][] = [
      [() => newColors([A], inOrder), "bad_players"],
      [() => go(forfeit(g, B), A, draw), "not_playing"],
      [() => go(g, 99, draw), "not_in_game"],
      [() => go(withOut(position(["r1", "b3", "y3"], "r9", ""), C), C, draw), "not_in_game"],
      [() => forfeit(g, 99), "not_in_game"],
      [() => go(g, B, draw), "not_your_turn"],
      [() => go(g, A, play("r5")), "no_card"],
      [() => go(g, A, play("WX")), "no_card"],
      [() => go(g, A, play("g2")), "not_playable"],
      [() => go(g, A, play("WW")), "pick_color"],
      [() => go(g, A, play("W4", "g")), "wild_four_has_color"],
      [() => go(drew, A, draw), "drew_already"],
      [() => go(drew, A, play("g1")), "must_play_drawn"],
      [() => go(g, A, pass), "nothing_drawn"],
      [() => go(g, A, { type: "fold" } as unknown as ColorsMove), "bad_move"],
    ];
    for (const [f, code] of cases) expect(f).toThrowError(new RegExp(`^${code}$`));
  });
});

describe("purity", () => {
  it("never changes the game it was given", () => {
    const g0 = position(["rD W4 g1 r2 rS", "b3 bR y4", "y5 yS r6"], "y1 g2 b9 r7", "g3");
    const line: [number, ColorsMove][] = [
      [A, play("rD")], // B draws g3, then the pile is reshuffled for the second card
      [C, play("r6")],
      [A, play("rS")],
      [C, play("yS")],
      [B, play("y4")],
      [C, draw], // g2 does not fit
      [A, play("W4", "r")], // B draws four, another reshuffle
      [C, draw], // a red card: playable
      [C, pass],
      [A, play("r2")],
    ];
    let g = g0;
    for (const [id, move] of line) {
      const before = structuredClone(g);
      const next = go(g, id, move);
      expect(g).toEqual(before);
      expect(next).not.toBe(g);
      expect(everyCard(next)).toHaveLength(everyCard(g0).length);
      const after = structuredClone(next);
      const view = viewColors(next, id);
      view.hand.push("Xx");
      view.legal?.play.push("Xx");
      if (view.last?.penalty) view.last.penalty.cards = 99;
      legalFor(next, id).play.push("Xx");
      forfeit(next, id);
      expect(next).toEqual(after);
      g = next;
    }
    expect(hand(g, A)).toEqual(["g1"]);
    expect(g.turn).toBe(1);
    expect(g0.deck).toEqual(["g3"]);
    expect(g0.discard).toEqual(cards("y1 g2 b9 r7"));
  });
});

describe("random play", () => {
  it("keeps all 108 cards, never gets stuck, and always ends with a winner", () => {
    const rand = lcg(2026);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const full = everyCard(newColors([1, 2], rand)).sort();
    let longest = 0;
    for (let game = 0; game < 300; game++) {
      const n = 2 + (game % 5);
      const ids = Array.from({ length: n }, (_, i) => 100 + i);
      let g = newColors(ids, rand);
      let moves = 0;
      for (; g.phase === "playing"; moves++) {
        expect(moves).toBeLessThan(1000);
        const id = waitingFor(g) as number;
        expect(g.players[g.turn]?.id).toBe(id);
        expect(g.players[g.turn]?.out).toBe(false);
        for (const p of g.players) if (p.id !== id) expect(legalFor(g, p.id)).toEqual(nothing);
        const legal = legalFor(g, id);
        // whoever the clock runs on can always do something
        expect(legal.draw || legal.pass).toBe(true);
        if (g.drawn !== null) expect(legal.play).toEqual([g.drawn]);
        const plays = legal.play.map((card) =>
          card.startsWith("W") ? play(card, pick(COLORS)) : play(card),
        );
        const before = moves % 25 === 0 ? structuredClone(g) : null;
        if (moves >= 300 && moves % 50 === 0) {
          // a game that drags on loses players to the clock
          g = forfeit(g, id);
        } else if (rand() < 0.003) {
          // now and then somebody gives up, on turn or not
          g = forfeit(g, pick(g.players.filter((p) => !p.out)).id);
        } else {
          const next = act(
            g,
            id,
            plays.length > 0 && rand() < 0.85 ? pick(plays) : legal.draw ? draw : pass,
            rand,
          );
          if (before) expect(g).toEqual(before);
          g = next;
        }
        expect([...everyCard(g)].sort()).toEqual(full);
        if (g.phase === "playing") {
          expect(COLORS).toContain(g.color);
          const top = g.discard.at(-1) as ColorsCard;
          if (!top.startsWith("W")) expect(g.color).toBe(top.charAt(0));
          if (g.drawn !== null) expect(g.players[g.turn]?.hand).toContain(g.drawn);
          expect(g.players.filter((p) => !p.out).length).toBeGreaterThanOrEqual(2);
          for (const p of g.players) if (p.out) expect(p.hand).toEqual([]);
        }
      }
      longest = Math.max(longest, moves);
      expect(g.winner).not.toBeNull();
      const winner = g.players.find((p) => p.id === g.winner);
      expect(winner?.out).toBe(false);
      // the winner emptied their hand, or everyone else gave up
      const left = g.players.filter((p) => !p.out);
      expect(winner?.hand.length === 0 || left.length === 1).toBe(true);
      expect(g.drawn).toBeNull();
      expect(waitingFor(g)).toBeNull();
    }
    expect(longest).toBeGreaterThan(20);
  });
});
