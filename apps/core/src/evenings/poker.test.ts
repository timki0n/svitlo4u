import { describe, expect, it } from "vitest";
import {
  act,
  type Card,
  compareScores,
  evaluate,
  legal,
  newDeck,
  type PokerAction,
  type PokerHand,
  startHand,
  viewFor,
} from "./poker.ts";

/** Seeded LCG so every deck in these tests is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const BLINDS = { small: 5, big: 10 };
const cards = (s: string): Card[] => s.split(" ");
/** Ids differ from seat indexes so a mix-up between the two cannot pass. */
const table = (...stacks: number[]) => stacks.map((stack, i) => ({ id: 100 + i, stack }));
const deal = (stacks: number[], button = 0, seed = 1) =>
  startHand(table(...stacks), button, BLINDS, lcg(seed));

/** Fixes every seat's hole cards and the board to come (only valid before the flop). */
function rig(h: PokerHand, holes: string[], board: string): PokerHand {
  const fixed = [...holes.flatMap(cards), ...cards(board)];
  return {
    ...h,
    seats: h.seats.map((s, i) => ({ ...s, cards: cards(holes[i] ?? "") })),
    deck: [...cards(board), ...newDeck(lcg(99)).filter((c) => !fixed.includes(c))],
  };
}

/** Plays moves in turn order: each move is made by whoever is to act. */
function play(h: PokerHand, ...moves: PokerAction[]): PokerHand {
  let cur = h;
  for (const move of moves) cur = act(cur, idToAct(cur), move);
  return cur;
}

function idToAct(h: PokerHand): number {
  const seat = h.turn === null ? undefined : h.seats[h.turn];
  if (!seat) throw new Error("nobody to act");
  return seat.id;
}

const fold: PokerAction = { type: "fold" };
const check: PokerAction = { type: "check" };
const call: PokerAction = { type: "call" };
const raise = (to: number): PokerAction => ({ type: "raise", to });

const results = (h: PokerHand) => h.results ?? [];
const nets = (h: PokerHand) => results(h).map((r) => r.net);
const won = (h: PokerHand) => results(h).map((r) => r.won);

describe("deck", () => {
  it("shuffles 52 distinct cards, the same for the same seed", () => {
    const deck = newDeck(lcg(7));
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    for (const c of deck) expect(c).toMatch(/^[2-9TJQKA][shdc]$/);
    expect(newDeck(lcg(7))).toEqual(deck);
    expect(newDeck(lcg(8))).not.toEqual(deck);
  });
});

describe("evaluate", () => {
  const score = (s: string) => evaluate(cards(s)).score;
  const name = (s: string) => evaluate(cards(s)).name;

  it("ranks every category in order, the wheel being the lowest straight", () => {
    const ladder = [
      ["Ah Kd 9c 7s 3h", "старша карта"],
      ["2h 2d 5c 7s 9h", "пара"],
      ["3h 3d 2c 2s 9h", "дві пари"],
      ["4h 4d 4c 2s 9h", "трійка"],
      ["Ah 2d 3c 4s 5h", "стріт"],
      ["2h 3d 4c 5s 6h", "стріт"],
      ["Th Jd Qc Ks Ah", "стріт"],
      ["2h 4h 6h 8h Th", "флеш"],
      ["2h 2d 2c 3s 3h", "фул-хаус"],
      ["2h 2d 2c 2s 3h", "каре"],
      ["Ah 2h 3h 4h 5h", "стріт-флеш"],
      ["9h Th Jh Qh Kh", "стріт-флеш"],
      ["Th Jh Qh Kh Ah", "роял-флеш"],
    ] as const;
    ladder.forEach(([hand, label], k) => {
      expect(name(hand)).toBe(label);
      const prev = ladder[k - 1];
      if (prev) expect(compareScores(score(hand), score(prev[0]))).toBeGreaterThan(0);
    });
  });

  it("does not wrap a straight around the ace", () => {
    expect(name("Qh Kd Ac 2s 3h")).toBe("старша карта");
  });

  it("picks the best five of seven", () => {
    // A straight and a flush at once: the flush counts.
    expect(name("5h 6h 7d 8h 9c Kh 2h")).toBe("флеш");
    // Three pairs: the best two with the best kicker.
    expect(score("Ah Ad Kc Ks Qh Qd 2c")).toEqual([2, 14, 13, 12]);
    // Two sets make a full house of the higher one.
    expect(score("9h 9d 9c 4s 4h 4d Ac")).toEqual([6, 9, 4]);
    expect(name("Ah 2h 3h 4h 5h 6h Kd")).toBe("стріт-флеш");
    expect(score("Ah 2h 3h 4h 5h 6h Kd")).toEqual([8, 6]);
  });

  it("lets kickers decide and splits true ties", () => {
    const board = "Ac 9d 7s 4h 2c";
    const kingKicker = score(`${board} Ad Kh`);
    const queenKicker = score(`${board} Ah Qd`);
    expect(compareScores(kingKicker, queenKicker)).toBeGreaterThan(0);
    expect(compareScores(queenKicker, kingKicker)).toBeLessThan(0);
    // A low card that does not make the best five does not break the tie.
    expect(compareScores(score("Ac Kd Qs Jh 9c 3d 2h"), score("Ac Kd Qs Jh 9c 4d 2s"))).toBe(0);
    // The board plays for both.
    expect(compareScores(score("Th Jh Qh Kh Ah 2c 3d"), score("Th Jh Qh Kh Ah 4c 5d"))).toBe(0);
    // Two pair: the second pair, then the kicker.
    expect(compareScores(score("Kh Kd 9c 9s 2h"), score("Kc Ks 8c 8s Ah"))).toBeGreaterThan(0);
    expect(compareScores(score("Kh Kd 9c 9s 3h"), score("Kc Ks 9d 9h 2h"))).toBeGreaterThan(0);
    // A flush is compared card by card.
    expect(compareScores(score("Ah Jh 8h 6h 3h"), score("Ad Jd 8d 6d 2d"))).toBeGreaterThan(0);
  });

  it("refuses wrong card sets", () => {
    expect(() => evaluate(cards("Ah Kd 9c 7s"))).toThrow("illegal");
    expect(() => evaluate(cards("Ah Kd 9c 7s 3h 4h 5h 6h"))).toThrow("illegal");
    expect(() => evaluate(cards("Ah Ah 9c 7s 3h"))).toThrow("illegal");
    expect(() => evaluate(cards("Ah 1d 9c 7s 3h"))).toThrow("illegal");
    expect(() => evaluate(cards("Ah Kx 9c 7s 3h"))).toThrow("illegal");
  });
});

describe("blinds and turn order", () => {
  it("posts the blinds left of the button and starts after the big blind", () => {
    const h = deal([1000, 1000, 1000, 1000], 1);
    expect(h.seats.map((s) => s.bet)).toEqual([0, 0, 5, 10]);
    expect(h.seats.map((s) => s.stack)).toEqual([1000, 1000, 995, 990]);
    expect(h.turn).toBe(0);
    expect(h.street).toBe("preflop");
    expect(h.currentBet).toBe(10);
    expect(h.minRaise).toBe(10);
    for (const s of h.seats) expect(s.cards).toHaveLength(2);
    expect(h.deck).toHaveLength(52 - 8);
    expect(new Set([...h.deck, ...h.seats.flatMap((s) => s.cards)]).size).toBe(52);
    expect(legal(h)).toEqual({ toCall: 10, canCheck: false, minRaiseTo: 20, maxRaiseTo: 1000 });
  });

  it("gives the big blind its option and starts every later street left of the button", () => {
    let h = deal([1000, 1000, 1000], 0);
    expect(h.turn).toBe(0);
    h = play(h, call, call);
    expect(h.turn).toBe(2);
    expect(legal(h)).toEqual({ toCall: 0, canCheck: true, minRaiseTo: 20, maxRaiseTo: 1000 });
    h = play(h, check);
    expect(h.street).toBe("flop");
    expect(h.board).toHaveLength(3);
    expect(h.turn).toBe(1);
    expect(h.currentBet).toBe(0);
    expect(h.minRaise).toBe(10);
    expect(h.seats.map((s) => s.bet)).toEqual([0, 0, 0]);
    expect(h.seats.map((s) => s.total)).toEqual([10, 10, 10]);
  });

  it("heads-up: the button posts the small blind, acts first preflop and last after", () => {
    let h = deal([500, 500], 1);
    expect(h.seats.map((s) => s.bet)).toEqual([10, 5]);
    expect(h.turn).toBe(1);
    expect(legal(h).toCall).toBe(5);
    h = play(h, call);
    expect(h.turn).toBe(0);
    h = play(h, check);
    expect(h.street).toBe("flop");
    expect(h.turn).toBe(0);
    h = play(h, check);
    expect(h.turn).toBe(1);
  });

  it("puts a player who cannot cover the big blind all-in, others still owe the full blind", () => {
    const h = deal([1000, 1000, 4], 0);
    const bb = h.seats[2];
    expect(bb).toMatchObject({ bet: 4, stack: 0, allIn: true });
    expect(h.currentBet).toBe(10);
    expect(h.turn).toBe(0);
    expect(legal(h).toCall).toBe(10);
  });

  it("heads-up with a short small blind runs the board out at once", () => {
    const h = deal([3, 500], 0);
    expect(h.street).toBe("done");
    expect(h.board).toHaveLength(5);
    // The big blind's uncalled 7 comes back: only 3 is at stake.
    expect([-3, 0, 3]).toContain(nets(h)[0]);
    expect(nets(h).reduce((a, b) => a + b, 0)).toBe(0);
    expect(results(h).every((r) => r.shown !== null)).toBe(true);
  });
});

describe("hands", () => {
  it("everyone folds to a raise: the raiser takes the pot and nobody shows", () => {
    let h = deal([1000, 1000, 1000, 1000], 0);
    expect(h.turn).toBe(3);
    h = play(h, raise(30), fold, fold, fold);
    expect(h.street).toBe("done");
    expect(h.turn).toBeNull();
    expect(h.board).toEqual([]);
    expect(won(h)).toEqual([0, 0, 0, 45]);
    expect(nets(h)).toEqual([0, -5, -10, 15]);
    expect(h.seats.map((s) => s.stack)).toEqual([1000, 995, 990, 1015]);
    for (const r of results(h)) expect(r).toMatchObject({ shown: null, hand: null });
  });

  it("checks down to a showdown", () => {
    let h = rig(deal([1000, 1000, 1000]), ["As Ad", "Kc Kd", "7h 2c"], "Ah 9s 5d 3c Jh");
    h = play(h, call, call, check);
    expect(h.board).toEqual(cards("Ah 9s 5d"));
    h = play(h, check, check, check);
    expect(h.street).toBe("turn");
    expect(h.board).toHaveLength(4);
    h = play(h, check, check, check);
    expect(h.street).toBe("river");
    h = play(h, check, check, check);
    expect(h.street).toBe("done");
    expect(h.board).toEqual(cards("Ah 9s 5d 3c Jh"));
    expect(results(h)).toEqual([
      { id: 100, won: 30, net: 20, shown: cards("As Ad"), hand: "трійка" },
      { id: 101, won: 0, net: -10, shown: cards("Kc Kd"), hand: "пара" },
      { id: 102, won: 0, net: -10, shown: cards("7h 2c"), hand: "старша карта" },
    ]);
    expect(h.seats.map((s) => s.stack)).toEqual([1020, 990, 990]);
  });

  it("folds on a later street leave the folded hand unshown", () => {
    let h = rig(deal([1000, 1000, 1000]), ["As Ad", "Kc Kd", "7h 2c"], "Ah 9s 5d 3c Jh");
    h = play(h, call, call, check);
    h = play(h, raise(20), fold, call);
    expect(h.street).toBe("turn");
    h = play(h, check, check, check, check);
    expect(results(h).map((r) => r.shown !== null)).toEqual([true, true, false]);
    // Pot 70: 3×10 preflop and 2×20 on the flop.
    expect(nets(h)).toEqual([40, -30, -10]);
  });

  it("splits a pot with an odd chip to the first winner left of the button", () => {
    let h = rig(deal([1000, 1000, 1000]), ["2c 3d", "6c 7d", "4c 5d"], "As Ks Qs Js Ts");
    h = play(h, call, fold, check);
    h = play(h, check, check, check, check, check, check);
    expect(h.street).toBe("done");
    // Pot 25: seat 2 sits left of the button, ahead of seat 0, so it gets 13.
    expect(won(h)).toEqual([12, 0, 13]);
    expect(nets(h)).toEqual([2, -5, 3]);
    expect(results(h)[0]?.hand).toBe("роял-флеш");
    expect(results(h)[1]?.shown).toBeNull();
  });

  it("runs the board out when everyone is all-in preflop", () => {
    let h = rig(deal([500, 500]), ["Ah Ad", "Kh Kd"], "2c 7d 9s Jc 3h");
    h = play(h, raise(500));
    expect(h.turn).toBe(1);
    expect(legal(h)).toEqual({ toCall: 490, canCheck: false, minRaiseTo: 0, maxRaiseTo: 0 });
    h = play(h, call);
    expect(h.street).toBe("done");
    expect(h.board).toEqual(cards("2c 7d 9s Jc 3h"));
    expect(nets(h)).toEqual([500, -500]);
    expect(h.seats.map((s) => s.stack)).toEqual([1000, 0]);
    expect(results(h).map((r) => r.hand)).toEqual(["пара", "пара"]);
  });

  it("runs the board out from the flop when one player is left with chips", () => {
    let h = rig(deal([1000, 300]), ["Ah Ad", "Kh Kd"], "2c 7d 9s Jc 3h");
    h = play(h, call, check);
    expect(h.street).toBe("flop");
    h = play(h, raise(290), call);
    expect(h.street).toBe("done");
    expect(h.board).toHaveLength(5);
    expect(nets(h)).toEqual([300, -300]);
  });
});

describe("raises", () => {
  it("needs at least the last full raise on top, and a re-raise grows the minimum", () => {
    let h = deal([1000, 1000, 1000]);
    expect(() => play(h, raise(19))).toThrow("illegal");
    h = play(h, raise(35));
    expect(h.currentBet).toBe(35);
    expect(h.minRaise).toBe(25);
    expect(legal(h)).toEqual({ toCall: 30, canCheck: false, minRaiseTo: 60, maxRaiseTo: 1000 });
    expect(() => play(h, raise(59))).toThrow("illegal");
    expect(() => play(h, raise(1001))).toThrow("illegal");
    h = play(h, raise(100));
    expect(h.minRaise).toBe(65);
    expect(legal(h).minRaiseTo).toBe(165);
    // The first raiser faces a full re-raise, so the betting is open again.
    h = play(h, fold);
    expect(h.turn).toBe(0);
    expect(legal(h).minRaiseTo).toBe(165);
    h = play(h, call);
    expect(h.street).toBe("flop");
    // A first bet after the flop needs at least the big blind.
    expect(legal(h)).toMatchObject({ canCheck: true, minRaiseTo: 10, maxRaiseTo: 900 });
    expect(() => play(h, raise(9))).toThrow("illegal");
  });

  it("allows an all-in for less than a minimum raise", () => {
    let h = deal([1000, 1000, 25]);
    h = play(h, raise(20), call);
    expect(legal(h)).toMatchObject({ minRaiseTo: 25, maxRaiseTo: 25 });
    h = play(h, raise(25));
    expect(h.seats[2]).toMatchObject({ allIn: true, stack: 0, bet: 25 });
    expect(h.currentBet).toBe(25);
    expect(h.minRaise).toBe(10);
  });

  it("a short all-in does not reopen the betting for those who already acted", () => {
    // Button 0, blinds on 1 and 2, seat 3 opens.
    let h = deal([55, 1000, 1000, 1000]);
    h = play(h, raise(40));
    expect(h.minRaise).toBe(30);
    h = play(h, raise(55)); // all-in, 15 more than 40: not a full raise
    expect(h.currentBet).toBe(55);
    expect(h.minRaise).toBe(30);
    // The blinds have not acted yet and may still raise.
    expect(legal(h)).toMatchObject({ toCall: 50, minRaiseTo: 85 });
    h = play(h, call, call);
    // The opener has: only call or fold.
    expect(h.turn).toBe(3);
    expect(legal(h)).toEqual({ toCall: 15, canCheck: false, minRaiseTo: 0, maxRaiseTo: 0 });
    expect(() => play(h, raise(85))).toThrow("illegal");
    expect(() => play(h, raise(1000))).toThrow("illegal");
    h = play(h, call);
    expect(h.street).toBe("flop");
  });

  it("short all-ins that add up to a full raise do reopen it", () => {
    // Button 0 (55), small blind 1 (75), big blind 2, seat 3 opens, seat 4 folds.
    let h = deal([55, 75, 1000, 1000, 1000]);
    h = play(h, raise(40), fold, raise(55), raise(75), call);
    // The opener now faces 35 more, beyond the last full raise of 30.
    expect(h.turn).toBe(3);
    expect(legal(h)).toEqual({ toCall: 35, canCheck: false, minRaiseTo: 105, maxRaiseTo: 1000 });
  });

  it("does not let anyone raise when every opponent is all-in", () => {
    let h = deal([1000, 1000, 1000]);
    h = play(h, raise(1000), fold);
    expect(legal(h)).toEqual({ toCall: 990, canCheck: false, minRaiseTo: 0, maxRaiseTo: 0 });
  });
});

describe("side pots", () => {
  /** Button 600 shoves, the small blind (300) and the big blind (100) call. */
  const allIn = (holes: string[]) => {
    const h = rig(deal([600, 300, 100]), holes, "2c 7d 9s Jc 3h");
    return play(h, raise(600), call, call);
  };

  /** Nobody may win from an opponent more than they staked themselves. */
  function expectCapped(h: PokerHand) {
    h.seats.forEach((s, i) => {
      const cap = h.seats.reduce((sum, o) => (o === s ? sum : sum + Math.min(s.total, o.total)), 0);
      expect(results(h)[i]?.net ?? 0).toBeLessThanOrEqual(cap);
    });
    expect(nets(h).reduce((a, b) => a + b, 0)).toBe(0);
  }

  it("pays the main pot to the short stack and the side pot to the middle one", () => {
    const h = allIn(["5h 5d", "Kh Kd", "Ah Ad"]);
    expect(h.street).toBe("done");
    expect(h.board).toHaveLength(5);
    expect(h.seats.map((s) => s.total)).toEqual([600, 300, 100]);
    // Main 3×100 to seat 2, side 2×200 to seat 1, the uncalled 300 back to seat 0.
    expect(won(h)).toEqual([300, 400, 300]);
    expect(nets(h)).toEqual([-300, 100, 200]);
    expect(h.seats.map((s) => s.stack)).toEqual([300, 400, 300]);
    expectCapped(h);
  });

  it("lets the big stack win only what each opponent staked", () => {
    const h = allIn(["Ah Ad", "Kh Kd", "5h 5d"]);
    expect(won(h)).toEqual([1000, 0, 0]);
    expect(nets(h)).toEqual([400, -300, -100]);
    expectCapped(h);
  });

  it("splits a side pot and leaves the main pot to its winner", () => {
    const h = allIn(["Ah Kc", "As Kd", "Qh Qd"]);
    // Seat 2 wins the main 300; seats 0 and 1 split the side 400; seat 0 gets back 300.
    expect(won(h)).toEqual([500, 200, 300]);
    expect(nets(h)).toEqual([-100, -100, 200]);
    expectCapped(h);
  });

  it("keeps folded chips in the pot without letting the folder win them back", () => {
    let h = rig(deal([1000, 1000, 50]), ["Kh Kd", "Ah Ad", "5h 5d"], "2c 7d 9s Jc 3h");
    h = play(h, raise(100), call, call); // the big blind is all-in for 50
    h = play(h, raise(200), fold); // small blind bets, button folds
    expect(h.street).toBe("done");
    // Main 3×50 to the best hand left (seat 1), side 2×50 to seat 1 as well, uncalled 200 back.
    expect(won(h)).toEqual([0, 450, 0]);
    expect(nets(h)).toEqual([-100, 150, -50]);
    expect(results(h)[0]?.shown).toBeNull();
  });
});

describe("illegal moves", () => {
  it("refuses a wrong turn, a wrong move or amount, and moves after the end", () => {
    const h = deal([1000, 1000, 1000]);
    expect(() => act(h, 101, call)).toThrow("illegal");
    expect(() => act(h, 999, call)).toThrow("illegal");
    expect(() => act(h, 100, check)).toThrow("illegal");
    expect(() => act(h, 100, raise(32.5))).toThrow("illegal");
    expect(() => act(h, 100, raise(Number.NaN))).toThrow("illegal");
    expect(() => act(h, 100, { type: "bet" } as unknown as PokerAction)).toThrow("illegal");
    const option = play(h, call, call);
    expect(() => play(option, call)).toThrow("illegal");
    const done = play(h, fold, fold);
    expect(done.street).toBe("done");
    expect(() => act(done, 102, check)).toThrow("illegal");
    expect(() => legal(done)).toThrow("illegal");
  });

  it("refuses a bad table", () => {
    const rand = lcg(1);
    expect(() => startHand(table(100), 0, BLINDS, rand)).toThrow("illegal");
    expect(() => startHand(table(1, 1, 1, 1, 1, 1, 1), 0, BLINDS, rand)).toThrow("illegal");
    expect(() => startHand(table(100, 0), 0, BLINDS, rand)).toThrow("illegal");
    expect(() => startHand(table(100, 2.5), 0, BLINDS, rand)).toThrow("illegal");
    expect(() => startHand(table(100, 100), 2, BLINDS, rand)).toThrow("illegal");
    expect(() => startHand(table(100, 100), 0, { small: 10, big: 5 }, rand)).toThrow("illegal");
    expect(() => startHand(table(100, 100), 0, { small: 0, big: 5 }, rand)).toThrow("illegal");
    const twins = [
      { id: 1, stack: 100 },
      { id: 1, stack: 100 },
    ];
    expect(() => startHand(twins, 0, BLINDS, rand)).toThrow("illegal");
  });

  it("never changes the hand it was given", () => {
    const h = deal([1000, 1000, 1000]);
    const before = structuredClone(h);
    const after = play(h, raise(30));
    expect(h).toEqual(before);
    expect(after).not.toBe(h);
    expect(viewFor(after, 100)).toBeDefined();
    expect(h).toEqual(before);
  });
});

describe("viewFor", () => {
  it("shows a player only their own cards while the hand is on", () => {
    const h = deal([1000, 1000, 1000]);
    const mine = viewFor(h, 101);
    expect("deck" in mine).toBe(false);
    expect(mine.seats.map((s) => s.cards.length)).toEqual([0, 2, 0]);
    expect(mine.seats[1]?.cards).toEqual(h.seats[1]?.cards);
    expect(viewFor(h, null).seats.every((s) => s.cards.length === 0)).toBe(true);
  });

  it("reveals shown cards after a showdown, but not a folded hand", () => {
    let h = rig(deal([1000, 1000, 1000]), ["As Ad", "Kc Kd", "7h 2c"], "Ah 9s 5d 3c Jh");
    h = play(h, call, fold, check);
    h = play(h, check, check, check, check, check, check);
    const spectator = viewFor(h, null);
    expect(spectator.seats.map((s) => s.cards)).toEqual([cards("As Ad"), [], cards("7h 2c")]);
    expect(viewFor(h, 101).seats[1]?.cards).toEqual(cards("Kc Kd"));
  });

  it("reveals nothing when the hand is won without a showdown", () => {
    const h = play(deal([1000, 1000, 1000]), raise(30), fold, fold);
    expect(viewFor(h, null).seats.every((s) => s.cards.length === 0)).toBe(true);
    expect(viewFor(h, 100).seats.map((s) => s.cards.length)).toEqual([2, 0, 0]);
  });
});

describe("random play", () => {
  it("keeps every chip and the side-pot cap over many hands", () => {
    const rand = lcg(2024);
    const pick = (n: number) => Math.floor(rand() * n);
    for (let game = 0; game < 400; game++) {
      const n = 2 + pick(5);
      const stacks = Array.from({ length: n }, () => 1 + pick(400));
      const chips = stacks.reduce((a, b) => a + b, 0);
      let h = startHand(table(...stacks), pick(n), BLINDS, rand);
      for (let moves = 0; h.street !== "done"; moves++) {
        expect(moves).toBeLessThan(200);
        const seat = h.seats[h.turn ?? -1];
        expect(seat && !seat.folded && !seat.allIn).toBe(true);
        const rules = legal(h);
        const roll = rand();
        let move: PokerAction;
        if (roll < 0.15) move = fold;
        else if (roll < 0.35 && rules.maxRaiseTo > 0)
          move = raise(rules.minRaiseTo + pick(rules.maxRaiseTo - rules.minRaiseTo + 1));
        else move = rules.canCheck ? check : call;
        h = act(h, idToAct(h), move);
        if (h.street !== "done") {
          expect(h.seats.reduce((sum, s) => sum + s.stack + s.total, 0)).toBe(chips);
        }
        for (const s of h.seats) expect(s.stack).toBeGreaterThanOrEqual(0);
      }
      expect(h.turn).toBeNull();
      expect(h.seats.reduce((sum, s) => sum + s.stack, 0)).toBe(chips);
      expect(nets(h).reduce((a, b) => a + b, 0)).toBe(0);
      h.seats.forEach((s, i) => {
        const r = results(h)[i];
        expect(r?.id).toBe(s.id);
        expect(r?.won).toBeGreaterThanOrEqual(0);
        expect(s.stack).toBe((stacks[i] ?? 0) + (r?.net ?? 0));
        const cap = h.seats.reduce(
          (sum, o) => (o === s ? sum : sum + Math.min(s.total, o.total)),
          0,
        );
        expect(r?.net ?? 0).toBeLessThanOrEqual(cap);
        if (r?.shown) expect(h.board).toHaveLength(5);
      });
    }
  });
});
