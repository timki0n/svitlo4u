import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDay } from "@svitlo/domain";
import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Core, startCore } from "../app.ts";
import { loadConfig } from "../config.ts";
import type { CoreEvents } from "../runtime/bus.ts";
import { ManualClock } from "../runtime/clock.ts";
import type { ScheduleImages } from "../services/images.ts";
import { webhookSecret } from "./telegram.ts";

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

const TOKEN = "123:test-token";
const ADMIN = 42;
const T0 = Date.UTC(2026, 10, 6, 10, 0, 0); // 12:00 Kyiv
const BOT_INFO = {
  id: 123,
  is_bot: true,
  first_name: "svitlo4u",
  username: "svitlo4u_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
} as UserFromGetMe;

type Call = { method: string; payload: Record<string, unknown> };
type Reply =
  | { ok: true; result: unknown }
  | { ok: false; error_code: number; description: string; parameters?: object };

/** Bot API stand-in: records calls; `respond` may fail a call, everything else succeeds. */
function fakeTelegram() {
  const calls: Call[] = [];
  let respond: (call: Call) => Reply | "network" | undefined = () => undefined;
  let messageId = 1;
  const transformer = (async (_prev, method, payload) => {
    const call = { method, payload: payload as Record<string, unknown> };
    calls.push(call);
    const custom = respond(call);
    if (custom === "network") throw new Error("connect ECONNREFUSED");
    if (custom) return custom;
    if (method === "sendMessage")
      return {
        ok: true,
        result: { message_id: messageId++, date: 0, chat: { id: call.payload.chat_id } },
      };
    if (method === "getChatMember")
      return { ok: true, result: { status: "member", user: { id: 1 } } };
    return { ok: true, result: true };
  }) as Transformer;
  return {
    calls,
    transformer,
    respondWith(fn: typeof respond) {
      respond = fn;
    },
    sent: () => calls.filter((c) => c.method === "sendMessage"),
    sentTo: (chatId: number) =>
      calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === chatId),
  };
}

function sitesYaml(telegram: string) {
  return `
sites:
  - id: 4u
    name: ЖК 4U
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: esp-4u, kind: esp, transport: udp, secretEnv: ESP_4U_SECRET }
    telegram:
      botTokenEnv: TG_4U_TOKEN
      adminChatId: ${ADMIN}
${telegram}
`;
}

const LIVE_CHATS = `      shadow: false
      chats: ["-1001", "-1002_7"]
      blockedChats: ["-1003"]
      silentChats: ["-1002_7"]`;

let dir: string;
let core: Core | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "svitlo-channels-"));
});
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  telegramYaml: string,
  options: {
    clock?: ManualClock;
    listen?: boolean;
    tg?: ReturnType<typeof fakeTelegram>;
    images?: ScheduleImages | null;
  } = {},
) {
  const tg = options.tg ?? fakeTelegram();
  const clock = options.clock ?? new ManualClock(T0);
  writeFileSync(join(dir, "sites.yaml"), sitesYaml(telegramYaml));
  const config = {
    ...loadConfig({ LOG_LEVEL: "silent", PUBLIC_URL: "https://svitlo4u.test" }),
    host: "127.0.0.1",
    port: 0,
    dbPath: join(dir, "core.db"),
    sitesPath: join(dir, "sites.yaml"),
    udpPort: 0,
  };
  core = await startCore(config, {
    clock,
    env: { ESP_4U_SECRET: "s", TG_4U_TOKEN: TOKEN },
    fetch: fakeYasno,
    listen: options.listen ?? false,
    telegram: { transformer: tg.transformer, botInfo: BOT_INFO, paceMs: 0 },
    ...(options.images !== undefined ? { images: options.images } : {}),
  });
  await core.outbox.idle();
  return { core, tg, clock };
}

const flush = async (c: Core) => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setImmediate(r));
    await c.outbox.idle();
  }
};

const powerEvent = (
  state: "on" | "off",
  overrides: Partial<CoreEvents["power.changed"]> = {},
): CoreEvents["power.changed"] => ({
  siteId: "4u",
  state,
  at: T0 - 9_000,
  detectedAt: T0,
  reason: "probe-timeout",
  approximate: false,
  previous: state === "off" ? "on" : "off",
  previousSince: T0 - 3 * 3_600_000 - 9_000,
  ...overrides,
});

let updateId = 1;
function message(chat: { id: number; type: string }, text: string, extra: object = {}) {
  const isCommand = text.startsWith("/");
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 0,
      chat,
      from: { id: 7, is_bot: false, first_name: "Ann", username: "ann" },
      text,
      ...(isCommand
        ? {
            entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }],
          }
        : {}),
      ...extra,
    },
  };
}

async function postUpdate(c: Core, update: object, secret = webhookSecret(TOKEN)) {
  return c.app.inject({
    method: "POST",
    url: "/telegram/4u",
    headers: { "x-telegram-bot-api-secret-token": secret },
    payload: update,
  });
}

describe("Telegram channel", () => {
  it("registers the webhook with a secret and the command menu on start; says hello to the admin", async () => {
    const { tg } = await start(LIVE_CHATS);
    await vi.waitFor(() => expect(tg.calls.some((c) => c.method === "setWebhook")).toBe(true));
    const webhook = tg.calls.find((c) => c.method === "setWebhook");
    expect(webhook?.payload).toMatchObject({
      url: "https://svitlo4u.test/telegram/4u",
      secret_token: webhookSecret(TOKEN),
      allowed_updates: ["message"],
    });
    expect(tg.calls.some((c) => c.method === "setMyCommands")).toBe(true);
    expect(tg.sentTo(ADMIN)[0]?.payload.text).toMatch(/Ядро svitlo4u .* запущено/);
  });

  it("announces power changes to every chat and topic with the legacy wording", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    c.bus.emit("power.changed", powerEvent("off"));
    await flush(c);
    const off = tg.sentTo(-1001);
    expect(off).toHaveLength(1);
    expect(off[0]?.payload).toMatchObject({ parse_mode: "HTML" });
    expect(String(off[0]?.payload.text)).toMatch(/^🔔⚠️ Світло ЗНИКЛО\.\nЧас зі світлом: 3 год\.\n/);
    expect(tg.sentTo(-1002)[0]?.payload).toMatchObject({ message_thread_id: 7 });

    c.bus.emit(
      "power.changed",
      powerEvent("on", { previousSince: T0 - 9_000, at: T0 + 3_600_000 }),
    );
    await flush(c);
    expect(String(tg.sentTo(-1001)[1]?.payload.text)).toMatch(
      /^🔔✅ Світло ВІДНОВЛЕНО\.\nЧас без світла: 1 год\.\n/,
    );
  });

  it("says when it happened if the news is late, and corrects a false alarm", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    c.bus.emit("power.changed", powerEvent("off", { at: T0 - 20 * 60_000, approximate: true }));
    c.bus.emit("power.false-alarm", {
      siteId: "4u",
      outageStartedAt: T0 - 20 * 60_000,
      detectedAt: T0,
    });
    await flush(c);
    const texts = tg.sentTo(-1001).map((m) => String(m.payload.text));
    expect(texts[0]).toMatch(/\(орієнтовно\)\nЗникло орієнтовно о 11:40\./);
    expect(texts[1]).toMatch(/Хибна тривога/);
  });

  it("announces low and high voltage and when it stabilized", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    c.bus.emit("voltage.alert", { siteId: "4u", kind: "low", voltage: 189, since: T0 });
    c.bus.emit("voltage.stabilized", {
      siteId: "4u",
      kind: "low",
      voltage: 206,
      since: T0,
      at: T0 + 14 * 60_000,
    });
    c.bus.emit("voltage.alert", { siteId: "4u", kind: "high", voltage: 251, since: T0 });
    c.bus.emit("voltage.stabilized", {
      siteId: "4u",
      kind: "high",
      voltage: 236,
      since: T0,
      at: T0 + 6 * 60_000,
    });
    await flush(c);
    expect(tg.sentTo(-1001).map((m) => m.payload.text)).toEqual([
      "⚠️ Низька напруга: 189 В.\nБережіть техніку.",
      "✅ Напругу стабілізовано: 206 В (середня за 2 хв).\nНизька напруга трималася 14 хв.",
      "⚠️ Висока напруга: 251 В.\nБережіть техніку.",
      "✅ Напругу стабілізовано: 236 В (середня за 2 хв).\nВисока напруга трималася 6 хв.",
    ]);
  });

  it("does not announce the first state after a fresh start", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    c.bus.emit("power.changed", powerEvent("on", { previous: "unknown", previousSince: null }));
    await flush(c);
    expect(tg.sentTo(-1001)).toHaveLength(0);
    expect(String(tg.sentTo(ADMIN).at(-1)?.payload.text)).toMatch(/перший стан після запуску/);
  });

  it("shadow mode: only the admin gets a marked copy with measured latency", async () => {
    const { core: c, tg } = await start('      chats: ["-1001"]');
    c.bus.emit("power.changed", powerEvent("off"));
    await flush(c);
    expect(tg.sentTo(-1001)).toHaveLength(0);
    const copy = String(tg.sentTo(ADMIN).at(-1)?.payload.text);
    expect(copy).toMatch(/^🧪 <b>shadow<\/b> · 4u → 1 чат\n🔔⚠️ Світло ЗНИКЛО\./);
    expect(copy).toMatch(/⏱ виявлено через 9\.0 с · відправка через 0\.0 с після виявлення$/);
  });

  it("retries while the internet is down and delivers in order when it is back", async () => {
    const { core: c, tg, clock } = await start(LIVE_CHATS);
    let online = false;
    tg.respondWith((call) => (call.method === "sendMessage" && !online ? "network" : undefined));
    c.bus.emit("power.changed", powerEvent("off"));
    await flush(c);
    clock.advanceBy(5_000);
    await flush(c);
    online = true;
    c.bus.emit("power.changed", powerEvent("on", { at: T0 + 6_000, previousSince: T0 - 9_000 }));
    await flush(c);
    const delivered = tg.calls
      .filter((m) => m.method === "sendMessage" && m.payload.chat_id === -1001)
      .map((m) => String(m.payload.text).split("\n")[0]);
    expect(delivered.slice(-2)).toEqual(["🔔⚠️ Світло ЗНИКЛО.", "🔔✅ Світло ВІДНОВЛЕНО."]);
    expect(c.store.outbox.pending()).toEqual([]);
  });

  it("drops subscribers who blocked the bot quietly; alerts the admin about a broken configured chat", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    c.store.telegram.subscribe("4u", 555);
    tg.respondWith((call) => {
      if (call.method !== "sendMessage") return undefined;
      if (call.payload.chat_id === 555)
        return {
          ok: false,
          error_code: 403,
          description: "Forbidden: bot was blocked by the user",
        };
      if (call.payload.chat_id === -1001)
        return { ok: false, error_code: 400, description: "Bad Request: chat not found" };
      return undefined;
    });
    c.bus.emit("power.changed", powerEvent("off"));
    await flush(c);
    expect(c.store.telegram.list("4u")).toEqual([]);
    const alerts = tg.sentTo(ADMIN).map((m) => String(m.payload.text));
    expect(alerts.filter((t) => t.includes("Не доставлено"))).toEqual([
      "⚠️ Не доставлено «power» в -1001: 400 Bad Request: chat not found",
    ]);
  });

  it("follows a group that became a supergroup", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    c.store.telegram.subscribe("4u", -500);
    tg.respondWith((call) =>
      call.method === "sendMessage" && call.payload.chat_id === -500
        ? {
            ok: false,
            error_code: 400,
            description: "Bad Request: group chat was upgraded to a supergroup chat",
            parameters: { migrate_to_chat_id: -100500 },
          }
        : undefined,
    );
    c.bus.emit("power.changed", powerEvent("off"));
    await flush(c);
    expect(tg.sentTo(-100500)).toHaveLength(1);
    expect(c.store.telegram.list("4u").map((s) => s.chatId)).toEqual([-100500]);
  });
});

describe("Telegram commands (webhook)", () => {
  const group = { id: -1001, type: "supergroup" };

  it("rejects updates without the secret token", async () => {
    const { core: c } = await start(LIVE_CHATS);
    expect((await postUpdate(c, message(group, "/status"), "wrong")).statusCode).toBe(401);
    expect(
      (await c.app.inject({ method: "POST", url: "/telegram/nope", payload: {} })).statusCode,
    ).toBe(404);
  });

  it("/status answers from memory and logs the request to the admin", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    c.state.update("4u", {
      power: "on",
      since: T0 - 2 * 3_600_000,
      lastVoltage: 228,
      lastPlugAt: T0 - 40_000,
    });
    expect((await postUpdate(c, message(group, "/status@svitlo4u_test_bot"))).statusCode).toBe(200);
    await vi.waitFor(() => expect(tg.sentTo(-1001)).toHaveLength(1));
    expect(String(tg.sentTo(-1001)[0]?.payload.text)).toMatch(
      /^✅ світло є вже 2 год\.\n🔌 Напруга: 228 В\n/,
    );
    await flush(c);
    expect(String(tg.sentTo(ADMIN).at(-1)?.payload.text)).toBe(
      "📮 /status від chat=-1001, login=@ann",
    );
  });

  it("/today and /tomorrow use the schedule in memory; an emergency day lists its own last schedule", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    await vi.waitFor(() => expect(c.state.get("4u").schedule).not.toBeNull());
    // The live fixture has emergency shutdowns on both days. 06.11 had a schedule before the
    // emergency; 07.11 never had one, and the schedule of 05.11 must not stand in for it.
    const published = (date: string) => ({
      ...parseDay({
        date: `${date}T00:00:00+02:00`,
        status: "ScheduleApplies",
        slots: [{ start: 480, end: 720, type: "Definite" }],
      }),
      date,
    });
    c.store.schedules.saveIfChanged("4u", "2026-11-05", published("2026-11-05"), T0 - 86_400_000);
    c.store.schedules.saveIfChanged("4u", "2026-11-06", published("2026-11-06"), T0 - 3_600_000);
    await postUpdate(c, message(group, "/today"));
    await postUpdate(c, message(group, "/tomorrow"));
    await vi.waitFor(() => expect(tg.sentTo(-1001)).toHaveLength(2));
    const [today, tomorrow] = tg.sentTo(-1001).map((m) => String(m.payload.text));
    expect(today).toMatch(/^📅 Розклад на 06\.11\.2026/);
    expect(today).toContain(
      "Діють екстрені відключення.\n\nОстанній згаданий графік:\n1. 08:00 – 12:00 (4 год.)",
    );
    expect(tomorrow).toMatch(/^📅 Розклад на 07\.11\.2026/);
    expect(tomorrow).not.toContain("Останній згаданий графік");
  });

  it("/sub toggles a personal subscription", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    const dm = { id: 7, type: "private" };
    await postUpdate(c, message(dm, "/sub"));
    await vi.waitFor(() => expect(c.store.telegram.list("4u")).toHaveLength(1));
    await postUpdate(c, message(dm, "/sub"));
    await vi.waitFor(() => expect(c.store.telegram.list("4u")).toHaveLength(0));
    const replies = tg.sentTo(7).map((m) => String(m.payload.text).split("\n")[0]);
    expect(replies).toEqual([
      "✅ Ви підписані на сповіщення про світло.",
      "🔕 Ви відписались від сповіщень.",
    ]);
  });

  it("/sub in a group: only its admins, and a topic subscribes just that topic", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    const forum = { id: -1005, type: "supergroup" };
    const inTopic = { message_thread_id: 12, is_topic_message: true };
    await postUpdate(c, message(forum, "/sub", inTopic)); // Ann is a regular member
    await vi.waitFor(() => expect(tg.sentTo(-1005)).toHaveLength(1));
    expect(tg.sentTo(-1005)[0]?.payload).toMatchObject({
      text: "🔒 Підписати групу чи топік на сповіщення може лише адміністратор групи.",
      message_thread_id: 12,
    });
    expect(c.store.telegram.list("4u")).toEqual([]);

    tg.respondWith((call) =>
      call.method === "getChatMember"
        ? { ok: true, result: { status: "administrator", user: { id: 8 } } }
        : undefined,
    );
    await postUpdate(
      c,
      message(forum, "/sub", { ...inTopic, from: { id: 8, is_bot: false, first_name: "Admin" } }),
    );
    await vi.waitFor(() => expect(c.store.telegram.list("4u")).toHaveLength(1));
    expect(c.store.telegram.list("4u")[0]).toMatchObject({ chatId: -1005, threadId: 12 });

    // Announcements now reach that topic.
    c.bus.emit("power.changed", powerEvent("off"));
    await flush(c);
    expect(tg.sentTo(-1005).at(-1)?.payload).toMatchObject({ message_thread_id: 12 });
  });

  it("deletes commands in blocked chats and non-admin messages in silent topics", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    await postUpdate(c, message({ id: -1003, type: "supergroup" }, "/status"));
    await postUpdate(
      c,
      message({ id: -1002, type: "supergroup" }, "hello", {
        message_thread_id: 7,
        is_topic_message: true,
      }),
    );
    await postUpdate(
      c,
      message({ id: -1002, type: "supergroup" }, "elsewhere", {
        message_thread_id: 8,
        is_topic_message: true,
      }),
    );
    await vi.waitFor(() =>
      expect(tg.calls.filter((x) => x.method === "deleteMessage")).toHaveLength(2),
    );
    expect(
      tg.calls.filter((x) => x.method === "deleteMessage").map((x) => x.payload.chat_id),
    ).toEqual([-1003, -1002]);
    expect(tg.sentTo(-1003)).toHaveLength(0);
  });

  it("keeps messages of chat admins in silent topics", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    tg.respondWith((call) =>
      call.method === "getChatMember"
        ? { ok: true, result: { status: "administrator", user: { id: 7 } } }
        : undefined,
    );
    await postUpdate(
      c,
      message({ id: -1002, type: "supergroup" }, "news", {
        message_thread_id: 7,
        is_topic_message: true,
      }),
    );
    await vi.waitFor(() => expect(tg.calls.some((x) => x.method === "getChatMember")).toBe(true));
    await flush(c);
    expect(tg.calls.some((x) => x.method === "deleteMessage")).toBe(false);
  });

  it("admin commands work only in the admin chat", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    const admin = { id: ADMIN, type: "private" };
    await postUpdate(c, message(group, "/health"));
    await postUpdate(c, message(admin, "/health"));
    await postUpdate(c, message(admin, "/stats"));
    await vi.waitFor(() => expect(tg.sentTo(ADMIN).length).toBeGreaterThanOrEqual(3));
    const texts = tg.sentTo(ADMIN).map((m) => String(m.payload.text));
    expect(texts.some((t) => t.startsWith("🩺 <b>svitlo4u</b>"))).toBe(true);
    expect(texts.some((t) => t.startsWith("📊 <b>ЖК 4U</b>"))).toBe(true);
    expect(tg.sentTo(-1001)).toHaveLength(0);

    await postUpdate(c, message(admin, "/notify Тестове <b>оголошення</b>"));
    await vi.waitFor(() => expect(tg.sentTo(-1001)).toHaveLength(1));
    expect(tg.sentTo(-1001)[0]?.payload.text).toBe("Тестове <b>оголошення</b>");
  });
});

describe("admin alerts", () => {
  it("zigbee2mqtt: alert only when offline for over a minute, then on recovery", async () => {
    const { core: c, tg, clock } = await start(LIVE_CHATS);
    const alerts = () => tg.sentTo(ADMIN).map((m) => String(m.payload.text));
    c.bus.emit("zigbee.bridge", { online: true });
    c.bus.emit("zigbee.bridge", { online: false });
    clock.advanceBy(30_000);
    c.bus.emit("zigbee.bridge", { online: true }); // a restart
    clock.advanceBy(60_000);
    await flush(c);
    expect(alerts().some((t) => t.includes("zigbee2mqtt"))).toBe(false);

    c.bus.emit("zigbee.bridge", { online: false });
    clock.advanceBy(61_000);
    await flush(c);
    c.bus.emit("zigbee.bridge", { online: true });
    await flush(c);
    expect(alerts().filter((t) => t.includes("zigbee2mqtt"))).toEqual([
      "⚠️ zigbee2mqtt offline понад хвилину — розетка не підтверджує стан світла.",
      "✅ zigbee2mqtt знову online.",
    ]);
  });

  it("Yasno: alert after 3 failures in a row and on recovery; rejected packets at most every 6 h", async () => {
    const { core: c, tg, clock } = await start(LIVE_CHATS);
    for (let n = 1; n <= 4; n++) c.bus.emit("yasno.error", { error: "timeout", failures: n });
    c.bus.emit("yasno.recovered", { failures: 4 });
    await flush(c);
    for (let i = 0; i < 3; i++) {
      c.bus.emit("heartbeat.rejected", { reason: "bad-signature", remote: "192.0.2.5" });
      await flush(c);
      clock.advanceBy(3_600_000);
    }
    clock.advanceBy(3 * 3_600_000);
    c.bus.emit("heartbeat.rejected", { reason: "bad-signature", remote: "192.0.2.5" });
    await flush(c);
    const alerts = tg.sentTo(ADMIN).map((m) => String(m.payload.text));
    expect(alerts.filter((t) => t.includes("Yasno"))).toEqual([
      "⚠️ Yasno не відповідає (3 спроби поспіль): timeout",
      "✅ Yasno знову відповідає (після 4 помилок).",
    ]);
    expect(alerts.filter((t) => t.includes("heartbeat"))).toHaveLength(2);
  });

  it("backup: alert after 3 failures in a row, then once when it works again", async () => {
    const { core: c, tg } = await start(LIVE_CHATS);
    const failed = (n: number) => ({
      lastOk: null,
      lastError: { at: T0, error: "upload failed: 403 AccessDenied" },
      failuresInRow: n,
    });
    for (const n of [1, 2, 3, 4]) c.notifier.onBackup(failed(n), null);
    c.notifier.onBackup(
      { lastOk: { at: T0, gzBytes: 50_000, key: "k" }, lastError: null, failuresInRow: 0 },
      { keys: ["k"], bytes: 200_000, gzBytes: 50_000, ms: 300, counts: {} },
    );
    await flush(c);
    const alerts = tg.sentTo(ADMIN).map((m) => String(m.payload.text));
    expect(alerts.filter((t) => t.includes("Бекап"))).toEqual([
      "⚠️ Бекап БД не вдався 3 рази поспіль: upload failed: 403 AccessDenied",
      "✅ Бекап БД знову працює.",
    ]);
  });

  it("tells how long the core was down", async () => {
    const clock = new ManualClock(T0);
    await start(LIVE_CHATS, { clock });
    await core?.stop(); // saves the detector state at T0
    core = null;
    const { tg } = await start(LIVE_CHATS, { clock: new ManualClock(T0 + 21 * 3_600_000) });
    expect(String(tg.sentTo(ADMIN)[0]?.payload.text)).toMatch(
      /Перерва в роботі: 21 год\. \(з 12:00 06\.11\)/,
    );
  });
});

describe("SSE", () => {
  it("streams a snapshot on connect and changes as they happen", async () => {
    const { core: c } = await start(LIVE_CHATS, { listen: true });
    const { port } = c.app.server.address() as AddressInfo;
    expect((await c.app.inject({ url: "/api/v1/sites/nope/events" })).statusCode).toBe(404);

    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/sites/4u/events`, {
      signal: abort.signal,
    });
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (pattern: RegExp) => {
      while (!pattern.test(buffer)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value);
      }
    };
    await readUntil(/event: state\ndata: .*\n\n/);
    expect(buffer).toMatch(/^retry: 3000\n\n/);
    expect(c.sse.count).toBe(1);

    c.bus.emit("power.changed", powerEvent("off"));
    await readUntil(/event: power\n/);
    expect(buffer).toMatch(/event: power\ndata: \{"state":"off","at":\d+/);
    c.bus.emit("voltage.sample", { siteId: "4u", t: T0, voltage: 229.5 });
    await readUntil(/event: voltage\n/);

    abort.abort();
    await vi.waitFor(() => expect(c.sse.count).toBe(0));
  });
});

describe("schedule pictures", () => {
  /** A picture renderer that hands out one PNG file and remembers what it was asked for. */
  function fakeImages(file: string | null) {
    const asked: string[] = [];
    const images: ScheduleImages = {
      render: async (siteId, day) => {
        asked.push(`${siteId}/${day}`);
        return file;
      },
    };
    return { images, asked };
  }
  const png = () => {
    const file = join(dir, "pic.png");
    writeFileSync(file, "png");
    return file;
  };
  const photoReply = (call: Call): Reply | undefined =>
    call.method === "sendPhoto"
      ? {
          ok: true,
          result: {
            message_id: 1,
            date: 0,
            chat: { id: call.payload.chat_id },
            photo: [{ file_id: "SMALL" }, { file_id: "PHOTO-1" }],
          },
        }
      : undefined;
  const notice = (kind: "today_updated" | "tomorrow_published", text: string) => ({
    siteId: "4u",
    notification: {
      kind,
      telegramText: text,
      web: {
        type: "schedule_updated" as const,
        category: "schedule_change" as const,
        title: "",
        body: "",
      },
    },
  });
  const photos = (tg: ReturnType<typeof fakeTelegram>, chatId: number) =>
    tg.calls.filter((c) => c.method === "sendPhoto" && c.payload.chat_id === chatId);

  it("the day's picture goes with the notice as its caption; later sends reuse the upload", async () => {
    const tg = fakeTelegram();
    tg.respondWith(photoReply);
    const { images, asked } = fakeImages(png());
    const { core: c } = await start(LIVE_CHATS, { tg, images });
    c.bus.emit("schedule.notification", notice("tomorrow_published", "📅 Графік на завтра"));
    await flush(c);
    expect(asked).toEqual(["4u/tomorrow"]);
    for (const chat of [-1001, -1002]) {
      expect(photos(tg, chat)).toHaveLength(1);
      expect(photos(tg, chat)[0]?.payload).toMatchObject({
        caption: "📅 Графік на завтра",
        parse_mode: "HTML",
      });
      expect(tg.sentTo(chat)).toHaveLength(0);
    }
    expect(photos(tg, -1002)[0]?.payload).toMatchObject({ message_thread_id: 7 });

    c.bus.emit("schedule.notification", notice("today_updated", "📅 Графік змінено"));
    await flush(c);
    expect(asked).toEqual(["4u/tomorrow", "4u/today"]);
    expect(photos(tg, -1001)[1]?.payload.photo).toBe("PHOTO-1");
  });

  it("a text too long for a caption follows the picture; no picture → text alone", async () => {
    const tg = fakeTelegram();
    tg.respondWith(photoReply);
    const long = `📅 ${"дуже довгий графік ".repeat(70)}`;
    const { core: c } = await start(LIVE_CHATS, { tg, images: fakeImages(png()).images });
    c.bus.emit("schedule.notification", notice("tomorrow_published", long));
    await flush(c);
    const toFirst = tg.calls.filter(
      (call) => call.payload.chat_id === -1001 && /^send(Photo|Message)$/.test(call.method),
    );
    expect(toFirst.map((call) => call.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(toFirst[0]?.payload.caption).toBeUndefined();
    expect(toFirst[1]?.payload.text).toBe(long);
    await core?.stop();
    core = null;

    const tg2 = fakeTelegram();
    const { core: c2 } = await start(LIVE_CHATS, { tg: tg2, images: fakeImages(null).images });
    c2.bus.emit("schedule.notification", notice("today_updated", "📅 Графік змінено"));
    await flush(c2);
    expect(tg2.calls.some((call) => call.method === "sendPhoto")).toBe(false);
    expect(tg2.sentTo(-1001)[0]?.payload.text).toBe("📅 Графік змінено");
  });

  it("/testscreenshot sends the picture to the admin chat only", async () => {
    const tg = fakeTelegram();
    tg.respondWith(photoReply);
    const { images, asked } = fakeImages(png());
    const { core: c } = await start(LIVE_CHATS, { tg, images });
    await postUpdate(c, message({ id: ADMIN, type: "private" }, "/testscreenshot завтра"));
    await vi.waitFor(() => expect(photos(tg, ADMIN)).toHaveLength(1));
    expect(photos(tg, ADMIN)[0]?.payload).toMatchObject({ caption: "🧪 Графік на завтра" });
    expect(asked).toEqual(["4u/tomorrow"]);

    await postUpdate(c, message({ id: 555, type: "private" }, "/testscreenshot"));
    await flush(c);
    expect(asked).toHaveLength(1);
  });
});
