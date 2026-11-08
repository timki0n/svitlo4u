import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GAME_WINDOWS, KYIV_TZ, zonedToEpoch } from "@svitlo/domain";
import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Core, startCore } from "../app.ts";
import { loadConfig } from "../config.ts";
import { ManualClock } from "../runtime/clock.ts";
import type { GameBuildings, GameRating, GameState } from "../services/game.ts";
import { signInitData, verifyInitData } from "./telegram-auth.ts";

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
const fakeYasno = async () =>
  new Response(LIVE, { status: 200, headers: { "content-type": "application/json" } });
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, KYIV_TZ);
};
// Saturday evening. The core starts with no heartbeat, so its own detector notes an outage from
// the start; the game's outage comes half a minute later and is the latest one.
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
const telegramApi = (async () => ({ ok: true, result: true })) as unknown as Transformer;

type Person = { id: number; first_name: string; username?: string };
const ANN: Person = { id: 7, first_name: "Анна", username: "ann" };
const BOB: Person = { id: 8, first_name: "Богдан" };

let dir: string;
let core: Core | null = null;
let clock: ManualClock;
const avatarCalls: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "svitlo-game-"));
  clock = new ManualClock(NOW);
  avatarCalls.length = 0;
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
      fetch: fakeYasno,
      listen: false,
      telegram: { transformer: telegramApi, botInfo: BOT, paceMs: 0 },
      gameFetch: async (url) => {
        avatarCalls.push(url);
        if (url.includes("getUserProfilePhotos"))
          return Response.json({
            ok: true,
            result: {
              photos: [
                [
                  { file_id: "small", width: 160 },
                  { file_id: "big", width: 640 },
                ],
              ],
            },
          });
        if (url.includes("getFile"))
          return Response.json({ ok: true, result: { file_path: "photos/file_1.jpg" } });
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      },
    },
  );
});
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(dir, { recursive: true, force: true });
});

const tma = (person: Person, authDate = Math.floor(clock.now() / 1000)) =>
  `tma ${signInitData({ user: JSON.stringify(person), auth_date: String(authDate), query_id: "q" }, TOKEN)}`;

async function call<T>(
  method: "GET" | "POST",
  path: string,
  person: Person | null = ANN,
): Promise<{ status: number; body: T }> {
  const res = await (core as Core).app.inject({
    method,
    url: `/api/v1/sites/4u/game${path}`,
    headers: person ? { authorization: tma(person) } : {},
  });
  return { status: res.statusCode, body: res.json() as T };
}

/** The light goes out at `start`; the clock moves just past it. */
const outage = (start: number) => {
  record("off", start);
  clock.advanceTo(start + 60_000);
};
const lightBack = (time: number) => record("on", time);
const record = (state: "on" | "off", time: number) =>
  (core as Core).store.power.record(
    "4u",
    { type: "power", state, at: time, detectedAt: time, reason: "plug", approximate: false },
    time,
  );

describe("Telegram Mini App sign-in", () => {
  it("accepts genuine fresh initData only", () => {
    const now = Date.now();
    const data = signInitData(
      { user: JSON.stringify(ANN), auth_date: String(Math.floor(now / 1000)) },
      TOKEN,
    );
    expect(verifyInitData(data, TOKEN, now)).toEqual({
      id: 7,
      firstName: "Анна",
      lastName: null,
      username: "ann",
    });
    expect(verifyInitData(data, "123:other-token", now)).toBeNull();
    expect(verifyInitData(data.replace("%D0%90", "%D0%91"), TOKEN, now)).toBeNull();
    expect(verifyInitData(data, TOKEN, now + 25 * 3_600_000)).toBeNull();
  });

  it("the game API answers only the Mini App", async () => {
    expect((await call("GET", "", null)).status).toBe(401);
    const forged = await (core as Core).app.inject({
      method: "GET",
      url: "/api/v1/sites/4u/game",
      headers: { authorization: `${tma(ANN)}&extra=1` },
    });
    expect(forged.statusCode).toBe(401);
    const ok = await call<GameState>("GET", "");
    expect(ok.status).toBe(200);
    expect(ok.body.session).toBeNull();
  });
});

describe("window game", () => {
  it("points per window: opened a moment ago, first one half more, once per player", async () => {
    outage(OUTAGE);
    expect((await call<GameState>("GET", "")).body.session).toEqual({ start: OUTAGE, end: null });

    expect((await call("POST", "/windows/14-3/solve")).body).toEqual({ error: "start_first" });
    await call("POST", "/windows/14-3/start");
    clock.advanceBy(1000);
    expect((await call("POST", "/windows/14-3/solve")).body).toEqual({ error: "too_fast" });
    clock.advanceBy(5000);
    expect((await call("POST", "/windows/14-3/solve")).body).toEqual({
      ok: true,
      points: 30,
      first: true,
      already: false,
    });

    await call("POST", "/windows/14-3/start", BOB);
    clock.advanceBy(4000);
    expect((await call("POST", "/windows/14-3/solve", BOB)).body).toMatchObject({
      points: 20,
      first: false,
    });
    await call("POST", "/windows/14-3/start");
    clock.advanceBy(4000);
    expect((await call("POST", "/windows/14-3/solve")).body).toMatchObject({
      points: 0,
      already: true,
    });
    expect((await call("POST", "/windows/1-3/start")).status).toBe(400);

    const state = (await call<GameState>("GET", "")).body;
    expect(state.windows).toEqual([
      {
        floor: 14,
        col: 3,
        solvers: [
          { id: 7, points: 30, at: expect.any(Number) },
          { id: 8, points: 20, at: expect.any(Number) },
        ],
      },
    ]);
    expect(state.me.points).toEqual({ session: 30, week: 30, all: 30 });
    expect(state.players["7"]).toMatchObject({ name: "Анна", username: "ann" });
    expect(state.players["8"]).toMatchObject({ name: "Богдан", username: null });
  });

  it("shows who is playing a window right now, until they stop checking in", async () => {
    outage(OUTAGE);
    await call("POST", "/windows/20-2/start", BOB);
    expect((await call<GameState>("GET", "")).body.playing).toEqual([
      { floor: 20, col: 2, ids: [8] },
    ]);
    clock.advanceBy(20_000);
    await call("POST", "/windows/20-2/start", BOB);
    clock.advanceBy(20_000);
    expect((await call<GameState>("GET", "")).body.playing).toHaveLength(1);
    clock.advanceBy(31_000);
    expect((await call<GameState>("GET", "")).body.playing).toEqual([]);
    await call("POST", "/windows/20-2/start", BOB);
    await call("POST", "/windows/20-2/leave", BOB);
    expect((await call<GameState>("GET", "")).body.playing).toEqual([]);
  });

  it("a new outage starts a dark facade; the light coming back does not", async () => {
    outage(OUTAGE);
    await call("POST", "/windows/2-1/start");
    clock.advanceBy(5000);
    await call("POST", "/windows/2-1/solve");
    lightBack(at("2026-11-07", "21:00"));
    clock.advanceTo(at("2026-11-07", "21:30"));
    const after = (await call<GameState>("GET", "")).body;
    expect(after.session).toEqual({ start: OUTAGE, end: at("2026-11-07", "21:00") });
    expect(after.windows).toHaveLength(1);

    outage(at("2026-11-07", "22:00"));
    const next = (await call<GameState>("GET", "")).body;
    expect(next.session?.start).toBe(at("2026-11-07", "22:00"));
    expect(next.windows).toEqual([]);
    expect(next.me.points).toEqual({ session: 0, week: 15, all: 15 });
  });

  it("rating: this outage, the week from Monday, all time — with avatars by signed links", async () => {
    outage(OUTAGE);
    for (const [who, w] of [
      [ANN, "2-1"],
      [BOB, "20-1"],
      [BOB, "2-2"],
    ] as const) {
      await call("POST", `/windows/${w}/start`, who);
      clock.advanceBy(4000);
      await call("POST", `/windows/${w}/solve`, who);
    }
    await vi.waitFor(() => expect(avatarCalls.length).toBeGreaterThan(0));
    const rating = (await call<GameRating>("GET", "/rating?period=session")).body;
    expect(rating.rows.map((r) => [r.rank, r.name, r.points, r.windows])).toEqual([
      [1, "Богдан", 60, 2],
      [2, "Анна", 15, 1],
    ]);
    expect(rating.me).toMatchObject({ rank: 2, id: 7 });

    // the week starts over on Monday, all time keeps everything
    clock.advanceTo(at("2026-11-09", "00:05"));
    const week = (await call<GameRating>("GET", "/rating?period=week")).body;
    expect(week.rows).toEqual([]);
    expect(week.since).toBe(at("2026-11-09", "00:00"));
    expect(week.resetsAt).toBe(at("2026-11-16", "00:00"));
    expect((await call<GameRating>("GET", "/rating?period=all")).body.rows).toHaveLength(2);

    await vi.waitFor(async () => {
      const state = (await call<GameState>("GET", "")).body;
      expect(state.players["7"]?.avatar).toMatch(
        /^\/api\/v1\/sites\/4u\/game\/avatars\/4u-7\.jpg\?s=/,
      );
    });
    const link = (await call<GameState>("GET", "")).body.players["7"]?.avatar as string;
    expect(existsSync(join(dir, "avatars", "4u-7.jpg"))).toBe(true);
    const photo = await (core as Core).app.inject({ method: "GET", url: link });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers["content-type"]).toBe("image/jpeg");
    const wrong = await (core as Core).app.inject({
      method: "GET",
      url: link.replace(/s=\w/, "s=0"),
    });
    expect(wrong.statusCode).toBe(404);
    expect(avatarCalls.every((u) => u.includes("api.telegram.org"))).toBe(true);
  });

  it("buildings: every facade lit beyond 10%, its outage, players and who lit most first", async () => {
    const before = at("2026-11-07", "16:00");
    const earlier = at("2026-11-07", "18:00");
    outage(before);
    lightBack(at("2026-11-07", "17:00"));
    outage(earlier);
    lightBack(at("2026-11-07", "19:00"));
    outage(OUTAGE);
    await call("GET", "");
    await call("GET", "", BOB);
    const store = (core as Core).store;
    /** `floors` whole storeys from the 2nd, every window by one player, from `from` on. */
    const light = (session: number, user: number, floors: number, from: number) => {
      for (let f = 2; f < 2 + floors; f++)
        for (let c = 1; c <= 22; c++)
          store.game.addSolve({
            siteId: "4u",
            session,
            floor: f,
            col: c,
            userId: user,
            points: 10,
            durationMs: 5000,
            solvedAt: from + f * 100 + c,
          });
    };
    light(before, 7, 2, before + 1000); // 44 windows, 7.7%: not shown
    light(earlier, 7, 3, earlier + 1000); // 66 windows, Ann first
    light(earlier, 8, 1, earlier + 600_000); // Bob after her on one storey
    light(OUTAGE, 7, 3, OUTAGE + 1000); // this outage, then the game is rebuilt…
    expect(store.game.clearFacade("4u", OUTAGE)).toBe(66);
    light(OUTAGE, 8, 4, OUTAGE + 600_000); // …and Bob lights the new building

    const { body } = await call<GameBuildings>("GET", "/buildings");
    expect(body.minShare).toBe(0.1);
    // the facade emptied in this outage is no building of the history
    expect(body.buildings.map((b) => [b.start, b.end, b.current, b.windows, b.players])).toEqual([
      [OUTAGE, null, true, 88, 1],
      [earlier, at("2026-11-07", "19:00"), false, 66, 2],
    ]);
    const past = body.buildings[1];
    expect(past).toMatchObject({ solves: 88, points: 880, share: 66 / GAME_WINDOWS });
    expect(past?.top).toEqual([expect.objectContaining({ id: 7, name: "Анна", firsts: 66 })]);
    expect(body.buildings[0]?.top).toEqual([
      expect.objectContaining({ id: 8, name: "Богдан", firsts: 88 }),
    ]);
  });
});
