import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KYIV_TZ, zonedToEpoch } from "@svitlo/domain";
import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Core, startCore } from "../app.ts";
import { loadConfig } from "../config.ts";
import { cellOf } from "../evenings/battle.ts";
import { ManualClock } from "../runtime/clock.ts";
import type { EveningsOverview, EveningTableView } from "../services/evenings.ts";
import type { GameRating } from "../services/game.ts";
import { signInitData } from "./telegram-auth.ts";

const TOKEN = "123:test-token";
const LIVE = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../packages/domain/test/fixtures/yasno/live-2026-11-06.json",
      import.meta.url,
    ),
  ),
  "utf8",
);
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, KYIV_TZ);
};
const NOW = at("2026-11-07", "20:00");
const OUTAGE = NOW + 30_000;
const SITES = `
sites:
  - id: 4u
    name: ЖК 4U
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: esp-4u, kind: esp, transport: udp, secretEnv: ESP_4U_SECRET }
    telegram:
      botTokenEnv: TG_4U_TOKEN
      shadow: false
      chats: []
`;
const BOT = {
  id: 123,
  is_bot: true,
  first_name: "svitlo4u",
  username: "svitlo4u_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as UserFromGetMe;

type Person = { id: number; first_name: string };
const ANN: Person = { id: 7, first_name: "Анна" };
const BOB: Person = { id: 8, first_name: "Богдан" };
const CAT: Person = { id: 9, first_name: "Катя" };

let dir: string;
let core: Core | null = null;
let clock: ManualClock;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "svitlo-evenings-"));
  clock = new ManualClock(NOW);
  writeFileSync(join(dir, "sites.yaml"), SITES);
  core = await startCore(
    {
      ...loadConfig({ LOG_LEVEL: "silent", PUBLIC_URL: "https://svitlo4u.test" }),
      host: "127.0.0.1",
      port: 0,
      dbPath: join(dir, "core.db"),
      sitesPath: join(dir, "sites.yaml"),
      udpPort: 0,
      apiRatePerMinute: 0,
    },
    {
      clock,
      env: { ESP_4U_SECRET: "s", TG_4U_TOKEN: TOKEN },
      fetch: async () => new Response(LIVE, { status: 200 }),
      listen: false,
      telegram: {
        transformer: (async () => ({ ok: true, result: true })) as unknown as Transformer,
        botInfo: BOT,
        paceMs: 0,
      },
      gameFetch: async () => Response.json({ ok: false }),
      eveningTimings: {
        turnMs: 300,
        betweenHandsMs: 20,
        resultMs: 20,
        lobbyMs: 150,
        nopeMs: 60,
        holdMs: 60,
        callMs: 200,
      },
    },
  );
  // an outage: the session
  (core as Core).store.power.record(
    "4u",
    {
      type: "power",
      state: "off",
      at: OUTAGE,
      detectedAt: OUTAGE,
      reason: "plug",
      approximate: false,
    },
    OUTAGE,
  );
  clock.advanceTo(OUTAGE + 60_000);
});
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(dir, { recursive: true, force: true });
});

async function call<T>(
  method: "GET" | "POST",
  path: string,
  person: Person,
  body?: object,
): Promise<{ status: number; body: T }> {
  const initData = signInitData(
    { user: JSON.stringify(person), auth_date: String(Math.floor(clock.now() / 1000)) },
    TOKEN,
  );
  const res = await (core as Core).app.inject({
    method,
    url: `/api/v1/sites/4u/game${path}`,
    headers: { authorization: `tma ${initData}` },
    ...(body ? { payload: body } : {}),
  });
  return { status: res.statusCode, body: res.json() as T };
}

const overview = async () =>
  (await call<{ evenings: EveningsOverview }>("GET", "", ANN)).body.evenings;
const table = async (door: number, who: Person) =>
  (await call<EveningTableView>("GET", `/evenings/${door}`, who)).body;
const points = async (who: Person) =>
  (await call<GameRating>("GET", "/rating?period=session", who)).body.me?.points ?? 0;

/** Ann, Bob and Kate each open a part of the door. */
async function openDoor(door: number) {
  for (const [part, who] of [ANN, BOB, CAT].entries()) {
    await call("POST", `/evenings/${door}/parts/${part + 1}/start`, who);
    clock.advanceBy(4000);
    const solved = await call<{ points: number }>(
      "POST",
      `/evenings/${door}/parts/${part + 1}/solve`,
      who,
    );
    expect(solved.body.points).toBe(50);
  }
}
const doorOf = async (game: "battle" | "poker" | "durak" | "colors" | "blackout") =>
  ((await overview()).doors.find((d) => d.game === game)?.door as number) ?? 0;

describe("«Вечорниці»", () => {
  it("five doors, each opened by three players, a part each, 50 points a part", async () => {
    const o = await overview();
    expect(o.session).toBe(OUTAGE);
    expect(o.doors).toHaveLength(5);
    expect(new Set(o.doors.map((d) => d.game))).toEqual(
      new Set(["battle", "poker", "durak", "colors", "blackout"]),
    );
    expect(o.doors.every((d) => !d.open && d.parts.every((p) => p === null))).toBe(true);

    expect((await call("POST", "/evenings/1/parts/1/solve", ANN)).body).toEqual({
      error: "start_first",
    });
    await call("POST", "/evenings/1/parts/1/start", ANN);
    clock.advanceBy(1000);
    expect((await call("POST", "/evenings/1/parts/1/solve", ANN)).body).toEqual({
      error: "too_fast",
    });
    clock.advanceBy(3000);
    expect((await call("POST", "/evenings/1/parts/1/solve", ANN)).status).toBe(200);
    // the part is taken; one part of a door each
    expect((await call("POST", "/evenings/1/parts/1/start", BOB)).body).toEqual({ error: "taken" });
    expect((await call("POST", "/evenings/1/parts/2/start", ANN)).body).toEqual({
      error: "one_part_each",
    });
    expect((await call("POST", "/evenings/1/join", ANN, { stake: 20 })).body).toEqual({
      error: "closed",
    });
    for (const [part, who] of [
      [2, BOB],
      [3, CAT],
    ] as const) {
      await call("POST", `/evenings/1/parts/${part}/start`, who);
      clock.advanceBy(4000);
      await call("POST", `/evenings/1/parts/${part}/solve`, who);
    }
    const door = (await overview()).doors[0];
    expect(door?.open).toBe(true);
    expect(door?.parts).toEqual([7, 8, 9]);
    expect([await points(ANN), await points(BOB), await points(CAT)]).toEqual([50, 50, 50]);
  });

  it("«Графік»: stakes from the session's points, the winner takes at most the smaller one", async () => {
    const door = await doorOf("battle");
    await openDoor(door);
    expect((await call("POST", `/evenings/${door}/join`, ANN, { stake: 60 })).body).toEqual({
      error: "not_enough_points",
    });
    expect((await call("POST", `/evenings/${door}/join`, ANN, { stake: 5 })).body).toEqual({
      error: "stake_too_small",
    });
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 30 });
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 50 });
    // the third one waits in the queue; nobody sits at two tables
    await call("POST", `/evenings/${door}/join`, CAT, { stake: 20 });
    let t = await table(door, CAT);
    expect(t.seats.map((s) => s.id)).toEqual([7, 8]);
    expect(t.queue).toEqual([9]);
    expect(t.battle?.phase).toBe("placing");
    expect(t.battle?.draft).toBeNull(); // nothing to place for the one waiting

    const mine = await table(door, ANN);
    expect(mine.battle?.draft).toHaveLength(5);
    expect(mine.available).toBe(20); // 50 less the 30 on the table
    await call("POST", `/evenings/${door}/move`, ANN, { type: "shuffle" });
    await call("POST", `/evenings/${door}/move`, ANN, { type: "ready" });
    await call("POST", `/evenings/${door}/move`, BOB, { type: "ready" });
    // Bob's blocks, as only Bob sees them; Ann's light slots, as only Ann knows
    const bobs = (await table(door, BOB)).battle?.sides[1].blocks ?? [];
    const anns = new Set(
      ((await table(door, ANN)).battle?.sides[0].blocks ?? []).flatMap((b) =>
        Array.from({ length: b.len }, (_, i) => cellOf(b.day, b.from + i)),
      ),
    );
    expect((await table(door, CAT)).battle?.sides[1].blocks).toEqual([]); // spectators see none
    const targets = bobs.flatMap((b) =>
      Array.from({ length: b.len }, (_, i) => cellOf(b.day, b.from + i)),
    );
    const misses = [...Array(56).keys()].filter((c) => !anns.has(c));
    for (let guard = 0; guard < 40; guard++) {
      t = await table(door, ANN);
      if (t.battle?.phase === "done") break;
      if (t.battle?.turn === 7) {
        await call("POST", `/evenings/${door}/move`, ANN, {
          type: "ring",
          cell: targets.shift(),
        });
      } else
        await call("POST", `/evenings/${door}/move`, BOB, { type: "ring", cell: misses.shift() });
    }
    t = await table(door, CAT);
    expect(t.battle?.winner).toBe(7);
    expect(t.result?.winners).toEqual([7]);
    // the finished board stays a moment, with nobody's move on a clock
    expect(t.deadline).toBeNull();
    expect([await points(ANN), await points(BOB)]).toEqual([80, 20]);
    // a moment later the table is free, and the queue sits down
    await vi.waitFor(async () =>
      expect((await table(door, CAT)).seats.map((s) => s.id)).toEqual([9]),
    );
  });

  it("«Графік»: whoever stays silent before the first ring stands up, nobody pays", async () => {
    const door = await doorOf("battle");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 20 });
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 20 });
    await call("POST", `/evenings/${door}/move`, ANN, { type: "ready" });
    await vi.waitFor(async () => {
      const t = await table(door, ANN);
      expect(t.battle).toBeNull();
      expect(t.seats.map((s) => s.id)).toEqual([7]);
    });
    expect([await points(ANN), await points(BOB)]).toEqual([50, 50]);
  });

  it("poker: a cash table — chips from the session's points, every hand paid as it ends", async () => {
    const door = await doorOf("poker");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 40 });
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 40 });
    expect(
      (await call("POST", `/evenings/${door === 1 ? 2 : 1}/join`, ANN, { stake: 20 })).body,
    ).toMatchObject({ error: expect.any(String) }); // one table at a time (or a closed door)
    await vi.waitFor(async () => expect((await table(door, ANN)).poker?.hand).not.toBeNull());
    let t = await table(door, ANN);
    const first = t.poker?.legal ? ANN : BOB;
    // spectators see no hole cards
    const seen = (await table(door, CAT)).poker?.hand?.seats.map((s) => s.cards.length);
    expect(seen).toEqual([0, 0]);
    expect((await table(door, first)).poker?.hand?.seats.some((s) => s.cards.length === 2)).toBe(
      true,
    );
    await call("POST", `/evenings/${door}/move`, first, { type: "fold" });
    // the one who folded the small blind loses it
    const loser = first.id === 7 ? ANN : BOB;
    const winner = first.id === 7 ? BOB : ANN;
    expect([await points(loser), await points(winner)]).toEqual([49, 51]);
    t = await table(door, ANN);
    expect(t.seats.find((s) => s.id === loser.id)?.stake).toBe(39);
    // standing up between hands keeps what was won and lost
    await call("POST", `/evenings/${door}/leave`, ANN);
    await call("POST", `/evenings/${door}/leave`, BOB);
    await vi.waitFor(async () => expect((await table(door, ANN)).seats).toEqual([]));
    expect((await points(loser)) + (await points(winner))).toBe(100);
  });

  it("poker: when the other stands up after a hand, the hand leaves the table and it waits", async () => {
    const door = await doorOf("poker");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 40 });
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 40 });
    await vi.waitFor(async () => expect((await table(door, ANN)).poker?.hand).not.toBeNull());
    const first = (await table(door, ANN)).poker?.legal ? ANN : BOB;
    const other = first === ANN ? BOB : ANN;
    await call("POST", `/evenings/${door}/move`, first, { type: "fold" });
    expect((await table(door, ANN)).poker?.hand?.street).toBe("done");
    // the other stands up straight after: nobody to play the next hand with
    await call("POST", `/evenings/${door}/leave`, other);
    await vi.waitFor(async () => expect((await table(door, first)).poker?.hand).toBeNull());
    expect((await table(door, first)).seats.map((s) => s.id)).toEqual([first.id]);
    // someone sits down: the next hand is dealt
    await call("POST", `/evenings/${door}/join`, CAT, { stake: 30 });
    await vi.waitFor(async () => {
      const t = await table(door, first);
      expect(t.poker?.hand?.street).not.toBe("done");
      expect(t.poker?.handNo).toBe(2);
    });
  });

  it("who watches a table: their ids, with their names, not those sitting at it", async () => {
    const door = await doorOf("durak");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 30 });
    await table(door, CAT);
    await table(door, BOB);
    const t = await table(door, ANN);
    expect(t.watchers).toEqual([9, 8]); // Kate first: she came first; Ann sits, so not her
    expect(t.players["9"]?.name).toBe("Катя");
    clock.advanceBy(41_000); // their screens went quiet
    expect((await table(door, ANN)).watchers).toEqual([]);
  });

  it("emojis: one at the table sends them, everyone sees them a few seconds, one a second", async () => {
    const door = await doorOf("durak");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 30 });
    const send = (who: Person, emoji: string) =>
      call<{ error?: string }>("POST", `/evenings/${door}/emote`, who, { emoji });

    expect((await send(BOB, "👍")).body.error).toBe("not_seated"); // a spectator has no face here
    expect((await send(ANN, "🍕")).body.error).toBe("bad_emote");
    expect((await send(ANN, "😂")).status).toBe(200);
    expect((await send(ANN, "🔥")).body.error).toBe("too_fast");

    const seen = (await table(door, CAT)).emotes;
    expect(seen.map((e) => [e.id, e.emoji])).toEqual([[7, "😂"]]);
    clock.advanceBy(1_000);
    expect((await send(ANN, "🔥")).status).toBe(200);
    const both = (await table(door, BOB)).emotes;
    expect(both.map((e) => e.emoji)).toEqual(["😂", "🔥"]);
    expect(both[1]?.n).toBeGreaterThan(both[0]?.n ?? Infinity);
    clock.advanceBy(3_500);
    expect((await table(door, BOB)).emotes.map((e) => e.emoji)).toEqual(["🔥"]); // the first is gone
  });

  it("«Дурень»: two sit, a moment later the cards are dealt; giving up makes you the durak", async () => {
    const door = await doorOf("durak");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 30 });
    let t = await table(door, ANN);
    expect(t.durak?.game).toBeNull(); // one alone waits
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 20 });
    await vi.waitFor(async () => expect((await table(door, ANN)).durak?.game).not.toBeNull());
    t = await table(door, ANN);
    const g = t.durak?.game;
    expect(g?.players.map((p) => p.cards)).toEqual([6, 6]);
    expect(g?.hand).toHaveLength(6);
    expect((await table(door, CAT)).durak?.game?.hand).toEqual([]); // a spectator sees no cards

    // the attacker leads, the defender takes; once the bout ends they hold more than six
    const attacker = g?.players[g.attacker]?.id === 7 ? ANN : BOB;
    const defender = attacker === ANN ? BOB : ANN;
    const lead = (await table(door, attacker)).durak?.game?.legal?.throw[0];
    expect(
      (await call("POST", `/evenings/${door}/move`, attacker, { type: "throw", card: lead }))
        .status,
    ).toBe(200);
    expect((await table(door, defender)).durak?.game?.legal?.take).toBe(true);
    await call("POST", `/evenings/${door}/move`, defender, { type: "take" });
    // the table waits for the attacker («Готово»), whether or not they have more to add
    t = await table(door, attacker);
    expect(t.durak?.game?.bout).toBe(1);
    expect(t.durak?.game?.table).toHaveLength(1);
    expect(t.durak?.game?.legal?.done).toBe(true);
    await call("POST", `/evenings/${door}/move`, attacker, { type: "done" });
    t = await table(door, defender);
    expect(t.durak?.game?.bout).toBe(2);
    expect(t.durak?.game?.hand.length).toBeGreaterThan(6);

    // giving up: Ann is the durak and pays Bob — at most what Bob put on the table
    await call("POST", `/evenings/${door}/leave`, ANN);
    t = await table(door, CAT);
    expect(t.durak?.game?.durak).toBe(7);
    expect(t.durak?.pay).toEqual({ 7: -20, 8: 20 });
    expect([await points(ANN), await points(BOB)]).toEqual([30, 70]);
    await vi.waitFor(async () => expect((await table(door, ANN)).seats).toEqual([]));
  });

  it("«Дурень»: a bout all answered waits for «Бито»; silent on it, the game says it for you", async () => {
    const door = await doorOf("durak");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 30 });
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 20 });
    await vi.waitFor(async () => expect((await table(door, ANN)).durak?.game).not.toBeNull());
    const g = (await table(door, ANN)).durak?.game;
    const attacker = g?.players[g.attacker]?.id === 7 ? ANN : BOB;
    const defender = attacker === ANN ? BOB : ANN;
    const lead = (await table(door, attacker)).durak?.game?.legal?.throw[0];
    await call("POST", `/evenings/${door}/move`, attacker, { type: "throw", card: lead });
    await call("POST", `/evenings/${door}/move`, defender, { type: "take" });
    const t = await table(door, CAT);
    expect(t.durak?.game?.bout).toBe(1);
    expect(t.deadline).not.toBeNull(); // the clock on the attacker's «Готово»
    // nobody says it: the bout closes all the same, and nobody loses the game for that silence
    await vi.waitFor(async () => expect((await table(door, CAT)).durak?.game?.bout).toBe(2));
    const after = (await table(door, CAT)).durak?.game;
    expect(after?.phase).toBe("playing");
    expect(after?.table).toEqual([]);
  });

  it("«Дурень»: whoever stays silent on their move is the durak, and pays the rest evenly", async () => {
    const door = await doorOf("durak");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 40 });
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 10 });
    await call("POST", `/evenings/${door}/join`, CAT, { stake: 30 });
    await vi.waitFor(async () => expect((await table(door, ANN)).durak?.game).not.toBeNull());
    const g = (await table(door, ANN)).durak?.game;
    const silent = g?.players[g.attacker]?.id as number;
    await vi.waitFor(async () => expect((await table(door, ANN)).durak?.game?.durak).toBe(silent));
    // the durak's stake split in two, each taking at most their own stake
    const stakes: Record<number, number> = { 7: 40, 8: 10, 9: 30 };
    const share = Math.floor((stakes[silent] as number) / 2);
    const expected = Object.fromEntries(
      [7, 8, 9]
        .filter((id) => id !== silent)
        .map((id) => [id, Math.min(share, stakes[id] as number)]),
    );
    const paid = Object.values(expected).reduce((a, b) => a + b, 0);
    expect((await table(door, ANN)).durak?.pay).toEqual({ ...expected, [silent]: -paid });
  });

  it("«Кольори»: seven cards each; giving up leaves the other the winner, who takes at most their stake", async () => {
    const door = await doorOf("colors");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 30 });
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 20 });
    await vi.waitFor(async () => expect((await table(door, ANN)).colors?.game).not.toBeNull());
    const g = (await table(door, ANN)).colors?.game;
    expect(g?.players.map((p) => p.cards)).toEqual([7, 7]);
    expect(g?.hand).toHaveLength(7);
    expect((await table(door, CAT)).colors?.game?.hand).toEqual([]); // a spectator sees no cards
    // whoever is on turn may draw
    const first = g?.players[g.turn]?.id === 7 ? ANN : BOB;
    expect((await table(door, first)).colors?.game?.legal?.draw).toBe(true);
    expect((await call("POST", `/evenings/${door}/move`, first, { type: "draw" })).status).toBe(
      200,
    );

    await call("POST", `/evenings/${door}/leave`, ANN);
    const t = await table(door, CAT);
    expect(t.colors?.game?.winner).toBe(8);
    expect(t.colors?.pay).toEqual({ 7: -20, 8: 20 });
    expect([await points(ANN), await points(BOB)]).toEqual([30, 70]);
  });

  it("«Кольори»: one giving up leaves the game going; the winner takes from each at most their own stake", async () => {
    const door = await doorOf("colors");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 40 });
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 10 });
    await call("POST", `/evenings/${door}/join`, CAT, { stake: 30 });
    await vi.waitFor(async () => expect((await table(door, ANN)).colors?.game).not.toBeNull());
    await call("POST", `/evenings/${door}/leave`, BOB);
    let t = await table(door, CAT);
    expect(t.colors?.game?.phase).toBe("playing");
    expect(t.colors?.game?.players.find((p) => p.id === 8)?.out).toBe(true);
    await call("POST", `/evenings/${door}/leave`, ANN);
    t = await table(door, CAT);
    expect(t.colors?.game?.winner).toBe(9);
    expect(t.colors?.pay).toEqual({ 7: -30, 8: -10, 9: 40 });
  });

  it("«Блекаут»: an action waits out the window to cancel it, then happens; the last one in wins", async () => {
    const door = await doorOf("blackout");
    await openDoor(door);
    await call("POST", `/evenings/${door}/join`, ANN, { stake: 30 });
    await call("POST", `/evenings/${door}/join`, BOB, { stake: 20 });
    await vi.waitFor(async () => expect((await table(door, ANN)).blackout?.game).not.toBeNull());
    const g = (await table(door, ANN)).blackout?.game;
    expect(g?.players.map((p) => p.cards)).toEqual([5, 5]);
    expect(g?.hand).toContain("GN");
    expect(g?.blackouts).toBe(1);
    expect((await table(door, CAT)).blackout?.game?.hand).toEqual([]); // a spectator sees no cards

    const first = g?.players[g.turn]?.id === 7 ? ANN : BOB;
    const legal = (await table(door, first)).blackout?.game?.legal;
    const card = legal?.play.find((c) => c !== "ST");
    if (card) {
      expect(
        (await call("POST", `/evenings/${door}/move`, first, { type: "play", card })).status,
      ).toBe(200);
      expect((await table(door, CAT)).blackout?.game?.pending?.card).toBe(card);
      // nobody cancels: a moment later it has happened
      await vi.waitFor(async () =>
        expect((await table(door, CAT)).blackout?.game?.pending).toBeNull(),
      );
      expect((await table(door, CAT)).blackout?.game?.last?.kind).toMatch(/done|steal/);
    }

    await call("POST", `/evenings/${door}/leave`, ANN);
    const t = await table(door, CAT);
    expect(t.blackout?.game?.winner).toBe(8);
    expect(t.blackout?.pay).toEqual({ 7: -20, 8: 20 });
    expect([await points(ANN), await points(BOB)]).toEqual([30, 70]);
  });
});
