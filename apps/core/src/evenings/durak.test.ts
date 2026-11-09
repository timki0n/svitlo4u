import { describe, expect, it } from "vitest";
import {
  act,
  beats,
  DURAK_RANKS,
  type DurakCard,
  type DurakGame,
  type DurakMove,
  forfeit,
  legalFor,
  newDurak,
  viewDurak,
  waitingFor,
} from "./durak.ts";

/** Seeded LCG so every deck in these tests is the same on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Never swaps: the deck stays in order, 6s 7s … As 6h … Ah 6d … Ad 6c … Ac. */
const inOrder = () => 0.999999;

/** Ids differ from seat indexes so a mix-up between the two cannot pass. */
const A = 11;
const B = 12;
const C = 13;
const D = 14;

const cards = (s: string): DurakCard[] => (s === "" ? [] : s.split(" "));

/**
 * A position by hand: hands by seat (ids 11, 12, …), the stock (drawn from the front), seat 0
 * attacking seat 1 in a fresh bout. `over` sets anything else.
 */
function position(
  trump: DurakCard,
  hands: string[],
  stock: string,
  over: Partial<DurakGame> = {},
): DurakGame {
  const players = hands.map((h, i) => ({ id: 11 + i, hand: cards(h), out: false }));
  return {
    phase: "playing",
    players,
    deck: cards(stock),
    trump,
    table: [],
    attacker: 0,
    defender: 1,
    took: false,
    limit: Math.min(6, players[over.defender ?? 1]?.hand.length ?? 0),
    discard: 0,
    bout: 1,
    finished: [],
    durak: null,
    ...over,
  };
}

const put = (card: DurakCard): DurakMove => ({ type: "throw", card });
const beat = (card: DurakCard, target: number): DurakMove => ({ type: "beat", card, target });
const take: DurakMove = { type: "take" };
const done: DurakMove = { type: "done" };
const nothing = { throw: [], beat: [], take: false, done: false };

const hand = (g: DurakGame, id: number) => g.players.find((p) => p.id === id)?.hand;
/** Every card still in play: hands, stock and table. */
const inPlay = (g: DurakGame) => [
  ...g.players.flatMap((p) => p.hand),
  ...g.deck,
  ...g.table.flatMap((p) => (p.defense === null ? [p.attack] : [p.attack, p.defense])),
];

describe("dealing", () => {
  it("deals six to each seat from the front; the last card of the deck is the trump card", () => {
    const g = newDurak([A, B], inOrder);
    expect(g.players.map((p) => p.hand)).toEqual([
      cards("6s 7s 8s 9s Ts Js"),
      cards("Qs Ks As 6h 7h 8h"),
    ]);
    expect(g.deck).toHaveLength(36 - 12);
    expect(g.deck[0]).toBe("9h");
    expect(g.trump).toBe("Ac");
    expect(g.deck.at(-1)).toBe("Ac");
    expect(g).toMatchObject({
      phase: "playing",
      table: [],
      took: false,
      limit: 6,
      discard: 0,
      bout: 1,
      finished: [],
      durak: null,
    });

    const shuffled = newDurak([A, B, C, D], lcg(5));
    for (const p of shuffled.players) expect(p.hand).toHaveLength(6);
    expect(shuffled.deck).toHaveLength(12);
    expect(shuffled.trump).toBe(shuffled.deck.at(-1));
    expect(new Set(inPlay(shuffled)).size).toBe(36);
    for (const c of inPlay(shuffled)) expect(c).toMatch(/^[6-9TJQKA][shdc]$/);
    expect(newDurak([A, B, C, D], lcg(5))).toEqual(shuffled);
    expect(newDurak([A, B, C, D], lcg(6))).not.toEqual(shuffled);
  });

  it("six players: the stock is empty and the trump card sits in the last hand", () => {
    const g = newDurak([1, 2, 3, 4, 5, 6], inOrder);
    expect(g.deck).toEqual([]);
    expect(g.trump).toBe("Ac");
    expect(g.players[4]?.hand).toEqual(cards("Qd Kd Ad 6c 7c 8c"));
    expect(g.players[5]?.hand).toEqual(cards("9c Tc Jc Qc Kc Ac"));
    // 6c is the lowest trump: seat 4 leads, seat 5 defends
    expect(g.attacker).toBe(4);
    expect(g.defender).toBe(5);
    expect(g.limit).toBe(6);
  });

  it("refuses fewer than two players, more than six, or the same one twice", () => {
    expect(() => newDurak([A], inOrder)).toThrow("bad_players");
    expect(() => newDurak([], inOrder)).toThrow("bad_players");
    expect(() => newDurak([1, 2, 3, 4, 5, 6, 7], inOrder)).toThrow("bad_players");
    expect(() => newDurak([A, A], inOrder)).toThrow("bad_players");
  });

  it("the lowest trump leads and the next seat defends; with no trump dealt, the first seat", () => {
    // in order with 5 players, clubs are trumps and the last seat holds 6c: the defender wraps
    const five = newDurak([1, 2, 3, 4, 5], inOrder);
    expect(five.attacker).toBe(4);
    expect(five.defender).toBe(0);
    // with 2 players no club is dealt
    const two = newDurak([A, B], inOrder);
    expect(two.attacker).toBe(0);
    expect(two.defender).toBe(1);

    for (let seed = 1; seed <= 200; seed++) {
      const n = 2 + (seed % 5);
      const g = newDurak([1, 2, 3, 4, 5, 6].slice(0, n), lcg(seed));
      const suit = g.trump.charAt(1);
      const lows = g.players.map((p) =>
        Math.min(
          ...p.hand
            .filter((c) => c.charAt(1) === suit)
            .map((c) => DURAK_RANKS.indexOf(c.charAt(0))),
        ),
      );
      const lowest = Math.min(...lows);
      expect(g.attacker).toBe(lowest === Number.POSITIVE_INFINITY ? 0 : lows.indexOf(lowest));
      expect(g.defender).toBe((g.attacker + 1) % n);
    }
  });
});

describe("beats", () => {
  it("a higher card of the same suit, or any trump on a plain card", () => {
    expect(beats("6s", "7s", "h")).toBe(true);
    expect(beats("Ts", "Js", "h")).toBe(true);
    expect(beats("7s", "6s", "h")).toBe(false);
    expect(beats("7s", "7s", "h")).toBe(false);
    expect(beats("6s", "Ad", "h")).toBe(false); // another plain suit never beats
    expect(beats("As", "6h", "h")).toBe(true); // the lowest trump beats the highest plain card
    expect(beats("6h", "As", "h")).toBe(false); // a plain card never beats a trump
    expect(beats("6h", "7h", "h")).toBe(true); // trump on trump: the higher one
    expect(beats("7h", "6h", "h")).toBe(false);
    expect(beats("6s", "7x", "h")).toBe(false);
    expect(beats("6s", "", "h")).toBe(false);
  });
});

describe("a bout", () => {
  it("beaten: to «бито», the defender attacks next; the attacker draws first, the defender last", () => {
    let g = position(
      "Ah",
      ["6s 8d Kc Qd Jc 7c", "8s 7d Tc Jd 6c Kd", "7s Ts Qc Ac 9c", "Js Qs Ks As Td"],
      "9s 9d Ah",
    );
    expect(waitingFor(g)).toBe(A);
    g = act(g, A, put("6s"));
    expect(g.table).toEqual([{ attack: "6s", defense: null }]);
    expect(waitingFor(g)).toBe(B);
    g = act(g, B, beat("8s", 0));
    expect(g.table).toEqual([{ attack: "6s", defense: "8s" }]);
    // A still holds an 8, so the bout waits for A to add it or call «Бито»
    expect(waitingFor(g)).toBe(A);
    expect(legalFor(g, A)).toEqual({ throw: ["8d"], beat: [], take: false, done: true });
    expect(legalFor(g, C)).toEqual(nothing);
    g = act(g, A, done);
    expect(g.discard).toBe(2);
    expect(g.table).toEqual([]);
    expect(g.bout).toBe(2);
    // three cards for four hands: A, then C and D, and nothing is left for B
    expect(hand(g, A)).toEqual(cards("8d Kc Qd Jc 7c 9s"));
    expect(hand(g, C)).toEqual(cards("7s Ts Qc Ac 9c 9d"));
    expect(hand(g, D)).toEqual(cards("Js Qs Ks As Td Ah"));
    expect(hand(g, B)).toEqual(cards("7d Tc Jd 6c Kd"));
    expect(g.deck).toEqual([]);
    expect(g.attacker).toBe(1);
    expect(g.defender).toBe(2);
    expect(g.limit).toBe(6);
    expect(g.players.every((p) => !p.out)).toBe(true);
    expect(waitingFor(g)).toBe(B);
  });

  it("taken: the table goes to the defender and the seat after them attacks", () => {
    let g = position(
      "Ah",
      ["6s 9s Jc Qd Kc 7c", "7d 8d 9d Td Jd 6c", "6d Ks As Qs 8c 9c"],
      "Th Ah",
    );
    g = act(g, A, put("6s"));
    expect(legalFor(g, B)).toEqual({ throw: [], beat: [], take: true, done: false });
    expect(() => act(g, B, beat("7d", 0))).toThrow("does_not_beat");
    g = act(g, B, take);
    expect(g.took).toBe(true);
    // others may still add; the clock runs on the attacker
    expect(waitingFor(g)).toBe(A);
    expect(() => act(g, B, take)).toThrow("took_already");
    expect(() => act(g, B, beat("7d", 0))).toThrow("took_already");
    expect(legalFor(g, B)).toEqual(nothing);
    expect(legalFor(g, C)).toEqual({ throw: ["6d"], beat: [], take: false, done: false });
    expect(legalFor(g, A)).toEqual({ throw: [], beat: [], take: false, done: true });
    // C adds the last 6 around: nobody can add more, so the bout ends by itself
    g = act(g, C, put("6d"));
    expect(g.bout).toBe(2);
    expect(g.table).toEqual([]);
    expect(g.took).toBe(false);
    expect(g.discard).toBe(0);
    expect(hand(g, B)).toEqual(cards("7d 8d 9d Td Jd 6c 6s 6d"));
    expect(hand(g, A)).toEqual(cards("9s Jc Qd Kc 7c Th"));
    expect(hand(g, C)).toEqual(cards("Ks As Qs 8c 9c Ah"));
    expect(g.attacker).toBe(2);
    expect(g.defender).toBe(0);
    expect(g.limit).toBe(6);
    expect(waitingFor(g)).toBe(C);
  });

  it("others add only ranks on the table, never the defender, and only up to the limit", () => {
    // B holds 3 cards: at most 3 attack cards this bout
    const g0 = position("Ac", ["7s 7d Ks 9h", "8s 9s Qd", "7h Kd 8h As"], "");
    expect(g0.limit).toBe(3);
    expect(() => act(g0, C, put("7h"))).toThrow("not_your_lead");
    expect(() => act(g0, B, put("8s"))).toThrow("defender_cannot_throw");
    expect(() => act(g0, A, put("Ah"))).toThrow("no_card");
    expect(() => act(g0, 99, put("7s"))).toThrow("not_in_game");
    expect(legalFor(g0, C)).toEqual(nothing);

    let g = act(g0, A, put("7s"));
    expect(() => act(g, C, put("Kd"))).toThrow("rank_not_on_table");
    expect(() => act(g, B, put("9s"))).toThrow("defender_cannot_throw");
    expect(legalFor(g, C).throw).toEqual(["7h"]);
    g = act(g, B, beat("8s", 0));
    // the defense card's rank counts too
    expect(legalFor(g, C).throw).toEqual(["7h", "8h"]);
    g = act(g, C, put("7h"));
    expect(legalFor(g, A)).toEqual({ throw: ["7d"], beat: [], take: false, done: false });
    g = act(g, A, put("7d"));
    expect(g.table).toHaveLength(3);
    expect(() => act(g, C, put("8h"))).toThrow("table_full");
    expect(legalFor(g, C)).toEqual(nothing);
    expect(legalFor(g, B)).toEqual({
      throw: [],
      beat: [{ card: "Qd", targets: [2] }],
      take: true,
      done: false,
    });
    // the table is full, so taking ends the bout at once
    g = act(g, B, take);
    expect(g.bout).toBe(2);
    expect(hand(g, B)).toEqual(cards("9s Qd 7s 8s 7h 7d"));
    expect(g.attacker).toBe(2);
    expect(g.defender).toBe(0);
    // the new defender holds two cards: the new limit is two
    expect(g.limit).toBe(2);
  });

  it("ends by itself once everything is answered and nobody can add", () => {
    const g0 = position("Ah", ["6s 9d", "7s Td", "8c 9c Tc Jc Qc Kc Ac 8d"], "Jh Ah");
    expect(g0.limit).toBe(2);
    let g = act(act(g0, A, put("6s")), B, beat("7s", 0));
    expect(g.bout).toBe(2);
    expect(g.discard).toBe(2);
    expect(g.table).toEqual([]);
    expect(hand(g, A)).toEqual(cards("9d Jh Ah"));
    expect(hand(g, B)).toEqual(cards("Td"));
    expect(g.attacker).toBe(1);
    expect(g.defender).toBe(2);
    // C holds eight cards, but a bout never has more than six attacks
    expect(g.limit).toBe(6);

    // taking with nothing to add: the cards go to the defender at once
    g = act(act(g0, A, put("6s")), B, take);
    expect(g.bout).toBe(2);
    expect(hand(g, B)).toEqual(cards("7s Td 6s"));
    expect(hand(g, A)).toEqual(cards("9d Jh Ah"));
    expect(g.attacker).toBe(2);
    expect(g.defender).toBe(0);
    expect(g.limit).toBe(3);
  });

  it("the attacker calls «Бито» only when it is theirs and everything is answered", () => {
    const g0 = position("Ah", ["6s 6d 8d Qc Kc 9h", "8s 7d Ts 6c Jc Kh", "7c 8c 9c Tc Ac Qs"], "");
    expect(() => act(g0, A, done)).toThrow("not_finished");
    const g1 = act(g0, A, put("6s"));
    expect(() => act(g1, A, done)).toThrow("not_finished");
    expect(() => act(g1, C, done)).toThrow("not_attacker");
    const g2 = act(g1, B, beat("8s", 0));
    expect(() => act(g2, B, done)).toThrow("not_attacker");
    expect(() => act(g2, C, done)).toThrow("not_attacker");
    // C could still add an 8, but the attacker's «Бито» closes the bout
    expect(legalFor(g2, C).throw).toEqual(["8c"]);
    const g3 = act(g2, A, done);
    expect(g3.bout).toBe(2);
    expect(g3.discard).toBe(2);
  });
});

describe("legalFor", () => {
  const start = () =>
    position("Ah", ["6s 6d 8d Qc Kc 9h", "8s 7d Ts 6c Jc Kh", "7c 8c 9c Tc Ac Qs"], "Js Ah");

  it("the attacker leads anything; the defender sees which card beats which", () => {
    let g = start();
    // the whole hand, sorted: plain suits s h d c, trumps (hearts) last
    expect(legalFor(g, A)).toEqual({
      throw: cards("6s 6d 8d Qc Kc 9h"),
      beat: [],
      take: false,
      done: false,
    });
    expect(legalFor(g, B)).toEqual(nothing);
    expect(legalFor(g, C)).toEqual(nothing);
    expect(legalFor(g, 99)).toEqual(nothing);

    g = act(act(g, A, put("6s")), A, put("6d"));
    expect(legalFor(g, B)).toEqual({
      throw: [],
      beat: [
        { card: "8s", targets: [0] },
        { card: "Ts", targets: [0] },
        { card: "7d", targets: [1] },
        { card: "Kh", targets: [0, 1] },
      ],
      take: true,
      done: false,
    });
    expect(legalFor(g, A)).toEqual(nothing);
    expect(waitingFor(g)).toBe(B);

    g = act(g, B, beat("Kh", 1));
    expect(legalFor(g, A).throw).toEqual(["Kc"]);
    expect(waitingFor(g)).toBe(B);
    g = act(g, B, beat("8s", 0));
    expect(legalFor(g, A)).toEqual({ throw: ["8d", "Kc"], beat: [], take: false, done: true });
    expect(legalFor(g, B)).toEqual(nothing);
    expect(legalFor(g, C)).toEqual({ throw: ["8c"], beat: [], take: false, done: false });
    expect(waitingFor(g)).toBe(A);
  });

  it("refuses moves out of turn, cards not held and targets that are not there", () => {
    const g0 = start();
    expect(() => act(g0, B, take)).toThrow("nothing_to_take");
    expect(() => act(g0, A, take)).toThrow("not_defender");
    expect(() => act(g0, A, beat("6s", 0))).toThrow("not_defender");
    expect(() => act(g0, B, beat("8s", 0))).toThrow("bad_target");
    expect(() => act(g0, A, { type: "pass" } as unknown as DurakMove)).toThrow("bad_move");
    const g1 = act(g0, A, put("6s"));
    expect(() => act(g1, B, beat("Ah", 0))).toThrow("no_card");
    expect(() => act(g1, B, beat("7d", 0))).toThrow("does_not_beat");
    expect(() => act(g1, B, beat("8s", 1))).toThrow("bad_target");
    expect(() => act(g1, B, beat("8s", -1))).toThrow("bad_target");
    expect(() => act(g1, B, beat("8s", 0.5))).toThrow("bad_target");
    const g2 = act(g1, B, beat("8s", 0));
    expect(() => act(g2, B, beat("Ts", 0))).toThrow("bad_target"); // beaten already
    expect(() => act(g2, B, take)).toThrow("nothing_to_take");
    expect(() => act(g2, C, put("Qs"))).toThrow("rank_not_on_table");
  });
});

describe("the end", () => {
  it("with the stock empty, who has no cards goes out; the last one holding cards is the durak", () => {
    let g = position("Ac", ["6s", "7s 9d", "Kd Qc"], "");
    g = act(act(g, A, put("6s")), B, beat("7s", 0));
    expect(g.phase).toBe("playing");
    expect(g.players.map((p) => p.out)).toEqual([true, false, false]);
    expect(g.finished).toEqual([A]);
    expect(g.attacker).toBe(1);
    expect(g.defender).toBe(2);
    expect(g.limit).toBe(2);
    expect(legalFor(g, A)).toEqual(nothing);
    expect(viewDurak(g, A).legal).toBeNull();
    expect(() => act(g, A, put("6s"))).toThrow("not_in_game");

    g = act(act(g, B, put("9d")), C, beat("Kd", 0));
    expect(g.phase).toBe("done");
    expect(g.durak).toBe(C);
    expect(g.finished).toEqual([A, B]);
    expect(g.discard).toBe(4);
    expect(hand(g, C)).toEqual(["Qc"]);
    expect(waitingFor(g)).toBeNull();
    expect(legalFor(g, C)).toEqual(nothing);
    expect(() => act(g, C, put("Qc"))).toThrow("not_playing");
  });

  it("a defender who goes out passes the attack on to the next seat", () => {
    let g = position("Ac", ["6s 9d", "7s", "Kd Qc"], "");
    expect(g.limit).toBe(1);
    g = act(act(g, A, put("6s")), B, beat("7s", 0));
    expect(g.finished).toEqual([B]);
    expect(g.attacker).toBe(2);
    expect(g.defender).toBe(0);
    expect(g.limit).toBe(1);
  });

  it("skips a seat that is out when passing the attack", () => {
    const g0 = position("Ac", ["6s 8h", "7d 9d", "", "Ks Qs Js"], "");
    const players = g0.players.map((p) => (p.id === C ? { ...p, out: true } : p));
    let g: DurakGame = { ...g0, players, finished: [C] };
    g = act(act(g, A, put("6s")), B, take);
    expect(hand(g, B)).toEqual(cards("7d 9d 6s"));
    // C would attack next but is out: D attacks, A (after D) defends
    expect(g.attacker).toBe(3);
    expect(g.defender).toBe(0);
    expect(g.limit).toBe(1);
    expect(g.finished).toEqual([C]);
  });

  it("a draw when the last two go out together", () => {
    const g = act(act(position("Ac", ["6s", "7s"], ""), A, put("6s")), B, beat("7s", 0));
    expect(g.phase).toBe("done");
    expect(g.durak).toBeNull();
    expect(g.finished).toEqual([A, B]);
    expect(g.discard).toBe(2);
    expect(waitingFor(g)).toBeNull();
  });

  it("whoever gives up or goes silent is the durak", () => {
    const g = newDurak([A, B, C], lcg(3));
    const lost = forfeit(g, B);
    expect(lost.phase).toBe("done");
    expect(lost.durak).toBe(B);
    expect(g.phase).toBe("playing");
    expect(forfeit(lost, A)).toBe(lost); // over is over
    expect(waitingFor(lost)).toBeNull();
    expect(() => act(lost, A, done)).toThrow("not_playing");
    expect(() => forfeit(g, 99)).toThrow("not_in_game");
  });
});

describe("viewDurak", () => {
  const g = position(
    "9h",
    ["Ah 6c Ks 7s 6h 9d", "8s Td Qc Jd Kc 6d", "7c 8c Tc Jc 7d 8d"],
    "Ts Js 9h",
  );

  it("shows the viewer only their own cards, sorted, and the stock as a count", () => {
    const view = viewDurak(g, A);
    expect(view.hand).toEqual(cards("7s Ks 9d 6c 6h Ah"));
    expect(view.players).toEqual([
      { id: A, cards: 6, out: false },
      { id: B, cards: 6, out: false },
      { id: C, cards: 6, out: false },
    ]);
    expect(view.deck).toBe(3);
    expect(view.trump).toBe("9h");
    expect(view.legal).toEqual(legalFor(g, A));
    expect(view.legal?.throw).toEqual(view.hand);
    const json = JSON.stringify(view);
    for (const c of [...(hand(g, B) ?? []), ...(hand(g, C) ?? []), "Ts", "Js"])
      expect(json).not.toContain(`"${c}"`);
    expect(viewDurak(g, B).legal).toEqual(nothing);
  });

  it("gives a spectator no hand and no moves, and nobody moves once it is over", () => {
    for (const viewer of [null, 99]) {
      const view = viewDurak(g, viewer);
      expect(view.hand).toEqual([]);
      expect(view.legal).toBeNull();
      expect(JSON.stringify(view)).not.toContain('"Ah"');
    }
    const over = viewDurak(forfeit(g, B), A);
    expect(over.legal).toBeNull();
    expect(over.durak).toBe(B);
    expect(over.hand).toHaveLength(6);
  });

  it("shows the table to everyone", () => {
    const view = viewDurak(act(g, A, put("7s")), null);
    expect(view.table).toEqual([{ attack: "7s", defense: null }]);
    expect(view.players[0]?.cards).toBe(5);
  });
});

describe("purity", () => {
  it("never changes the game it was given", () => {
    const g0 = position(
      "Ah",
      ["6s 8d Kc Qd Jc 7c", "8s 7d Tc Jd 6c Kd", "7s Ts Qc Ac 9c", "Js Qs Ks As Td"],
      "9s 9d Ah",
    );
    // one bout closed by «Бито», one taken and closed by itself (both refill from the stock)
    const lines: [number, DurakMove][][] = [
      [
        [A, put("6s")],
        [B, beat("8s", 0)],
        [A, done],
      ],
      [
        [A, put("6s")],
        [B, beat("8s", 0)],
        [A, put("8d")],
        [B, take],
      ],
    ];
    for (const line of lines) {
      let g = g0;
      for (const [id, move] of line) {
        const before = structuredClone(g);
        const next = act(g, id, move);
        expect(g).toEqual(before);
        expect(next).not.toBe(g);
        const after = structuredClone(next);
        viewDurak(next, id).hand.push("Xx");
        legalFor(next, id).throw.push("Xx");
        forfeit(next, id);
        expect(next).toEqual(after);
        g = next;
      }
      expect(g.bout).toBe(2);
    }
    expect(g0.deck).toEqual(cards("9s 9d Ah"));
    expect(g0.table).toEqual([]);
  });
});

describe("random play", () => {
  // hundreds of whole games: quick here, slow on a shared CI runner
  it("keeps all 36 cards, never gets stuck, and ends with a durak or a draw", {
    timeout: 60_000,
  }, () => {
    const rand = lcg(2024);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    for (let game = 0; game < 300; game++) {
      const n = 2 + (game % 5);
      const ids = Array.from({ length: n }, (_, i) => 100 + i);
      let g = newDurak(ids, rand);
      for (let moves = 0; g.phase === "playing"; moves++) {
        expect(moves).toBeLessThan(5000);
        const turn = waitingFor(g);
        expect(g.players.find((p) => p.id === turn)?.out).toBe(false);
        const options: [number, DurakMove][] = [];
        for (const p of g.players) {
          const legal = legalFor(g, p.id);
          for (const card of legal.throw) options.push([p.id, put(card)]);
          for (const b of legal.beat)
            for (const target of b.targets) options.push([p.id, beat(b.card, target)]);
          if (legal.take) options.push([p.id, take]);
          if (legal.done) options.push([p.id, done]);
        }
        // whoever the clock runs on always has a move, and every listed move is accepted
        expect(options.some(([id]) => id === turn)).toBe(true);
        const [id, move] = pick(options);
        g = act(g, id, move);
        const all = inPlay(g);
        expect(new Set(all).size).toBe(all.length);
        expect(all.length + g.discard).toBe(36);
        if (g.phase === "playing") {
          expect(g.table.length).toBeLessThanOrEqual(g.limit);
          // the defender can always answer every card still open
          const open = g.table.filter((p) => p.defense === null).length;
          expect(open).toBeLessThanOrEqual(g.players[g.defender]?.hand.length ?? 0);
          expect(g.players[g.attacker]?.out).toBe(false);
          expect(g.players[g.defender]?.out).toBe(false);
          expect(g.attacker).not.toBe(g.defender);
        }
      }
      const left = g.players.filter((p) => !p.out).map((p) => p.id);
      if (g.durak === null) {
        expect(left).toEqual([]);
        expect([...g.finished].sort((x, y) => x - y)).toEqual(ids);
      } else {
        expect(left).toEqual([g.durak]);
        expect(g.finished).toHaveLength(n - 1);
        expect(g.finished).not.toContain(g.durak);
      }
      expect(g.deck).toEqual([]);
      expect(waitingFor(g)).toBeNull();
    }
  });
});
