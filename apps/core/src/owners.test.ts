import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signHub } from "./adapters/hub.ts";
import { type Core, startCore } from "./app.ts";
import {
  CLAIM_BAD_CODE_TEXT,
  CLAIM_TAKEN_TEXT,
  SUB_ADMINS_ONLY_TEXT,
} from "./channels/messages.ts";
import { webhookSecret } from "./channels/telegram.ts";
import { loadConfig } from "./config.ts";
import { ManualClock } from "./runtime/clock.ts";
import { claimPayload } from "./services/ownership.ts";

const TOKEN = "123:test-token";
const ADMIN = 42;
const OWNER = 7;
const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);
const BOT_INFO = {
  id: 123,
  is_bot: true,
  first_name: "svitlo4u",
  username: "svitlo4u_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
} as UserFromGetMe;

const SITES = `
sites:
  - id: 4u
    name: ЖК 4U
    scene: 4u
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: esp-4u, kind: esp, transport: udp, secretEnv: ESP_4U_SECRET }
    telegram:
      botTokenEnv: TG_4U_TOKEN
      adminChatId: ${ADMIN}
      shadow: false
      webApp: { url: "https://svitlo4u.test" }
`;

type Call = { method: string; payload: Record<string, unknown> };

function fakeTelegram() {
  const calls: Call[] = [];
  let admins = new Set<number>();
  const transformer = (async (_prev, method, payload) => {
    const call = { method, payload: payload as Record<string, unknown> };
    calls.push(call);
    if (method === "sendMessage")
      return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: 1 } } };
    if (method === "getChatMember") {
      const admin = admins.has(call.payload.user_id as number);
      return { ok: true, result: { status: admin ? "administrator" : "member", user: { id: 1 } } };
    }
    return { ok: true, result: true };
  }) as Transformer;
  return {
    calls,
    transformer,
    setAdmins: (ids: number[]) => {
      admins = new Set(ids);
    },
    textsTo: (chatId: number) =>
      calls
        .filter((c) => c.method === "sendMessage" && c.payload.chat_id === chatId)
        .map((c) => c.payload.text as string),
    lastTo: (chatId: number) =>
      calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === chatId).at(-1),
  };
}

let dir: string;
let core: Core | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "svitlo-owners-"));
});
afterEach(async () => {
  await core?.stop();
  core = null;
  rmSync(dir, { recursive: true, force: true });
});

async function start(clock = new ManualClock(T0), tg = fakeTelegram()) {
  writeFileSync(join(dir, "sites.yaml"), SITES);
  core = await startCore(
    {
      ...loadConfig({ LOG_LEVEL: "silent", PUBLIC_URL: "https://svitlo4u.test" }),
      dbPath: join(dir, "core.db"),
      sitesPath: join(dir, "sites.yaml"),
      udpPort: 0,
    },
    {
      clock,
      env: { ESP_4U_SECRET: "s", TG_4U_TOKEN: TOKEN, FIRMWARE_REPO: "off" },
      fetch: async () => new Response("{}", { status: 500 }),
      listen: false,
      images: null,
      telegram: { transformer: tg.transformer, botInfo: BOT_INFO, paceMs: 0, noticeMs: 0 },
    },
  );
  core.telegram.start();
  return { core, tg, clock };
}

const flush = async (c: Core) => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
    await c.outbox.idle();
  }
};

let updateId = 1;
const user = (id: number) => ({ id, is_bot: false, first_name: `U${id}` });
const message = (chat: { id: number; type: string }, from: number, text: string) => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    date: 0,
    chat,
    from: user(from),
    text,
    ...(text.startsWith("/")
      ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }] }
      : {}),
  },
});
const press = (from: number, data: string) => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    from: user(from),
    chat_instance: "x",
    data,
    message: { message_id: 99, date: 0, chat: { id: from, type: "private" }, text: "…" },
  },
});
const dm = (id: number) => ({ id, type: "private" });

async function post(c: Core, update: object) {
  const r = await c.app.inject({
    method: "POST",
    url: "/telegram/4u",
    headers: { "x-telegram-bot-api-secret-token": webhookSecret(TOKEN) },
    payload: update,
  });
  expect(r.statusCode).toBe(200);
  await flush(c);
}

/** Telegram's signed launch data of the Mini App for a user. */
function initData(userId: number, now: number): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(now / 1000)),
    user: JSON.stringify({ id: userId, first_name: `U${userId}` }),
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

/** A hub of the bench reporting the light on. */
async function report(c: Core, hub: { id: string; secret: string }, seq: number) {
  const raw = JSON.stringify({
    v: 1,
    dev: hub.id,
    boot: "b1",
    seq,
    up: 60 + seq,
    rst: "poweron",
    fw: "0.2.0",
    plug: { paired: true, mains: "on", since: 5, voltage: 225, rssi: -60 },
    events: [],
    ota: { state: "idle", version: null, error: null, rejected: null },
  });
  return c.app.inject({
    method: "POST",
    url: "/iot/hub",
    headers: { "content-type": "application/json", "x-signature": signHub(hub.secret, raw) },
    payload: raw,
  });
}

/** Scan, pick 2.1, name it: the owner's new building. */
async function claim(c: Core, tg: ReturnType<typeof fakeTelegram>, name: string) {
  const hub = c.ownership.newHub();
  await post(c, message(dm(OWNER), OWNER, `/start ${hub.payload}`));
  await post(c, press(OWNER, `g:${hub.id}:2.1`));
  await post(c, message(dm(OWNER), OWNER, name));
  const site = c.sites.find((s) => s.origin === "owner");
  if (!site) throw new Error(`no building: ${tg.textsTo(OWNER).join(" | ")}`);
  return { hub, site };
}

describe("hub owners (integration)", () => {
  it("a sticker's QR: the owner picks the group, names the building, it is served at once", async () => {
    const { core: c, tg } = await start();
    const hub = c.ownership.newHub();

    await post(c, message(dm(OWNER), OWNER, `/start ${hub.payload}`));
    const ask = tg.lastTo(OWNER);
    expect(ask?.payload.text).toContain(`Хаб ${hub.id} тепер ваш`);
    const markup = ask?.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] };
    const keys = markup.inline_keyboard.flat().map((k) => k.callback_data);
    expect(keys).toContain(`g:${hub.id}:2.1`);
    expect(keys).toHaveLength(12);

    await post(c, press(OWNER, `g:${hub.id}:2.1`));
    expect(tg.calls.find((call) => call.method === "editMessageText")?.payload.text).toContain(
      "Черга 2.1",
    );

    await post(c, message(dm(OWNER), OWNER, "Дім на <Оболоні>"));
    const site = c.sites.find((s) => s.origin === "owner");
    expect(site).toMatchObject({
      name: "Дім на Оболоні",
      access: "link",
      scene: "none",
      yasno: { region: 25, dso: 902, group: "2.1" },
      hub: { id: hub.id, siteId: site?.id },
    });
    expect(site?.id).toMatch(/^b-[a-z2-7]{10}$/);
    const welcome = tg.lastTo(OWNER);
    expect(welcome?.payload.text).toContain("Готово! Хаб");
    expect(welcome?.payload.text).toContain(`https://svitlo4u.info/${site?.id}`);
    expect(welcome?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "Мій хаб", web_app: { url: "https://svitlo4u.test/my" } }],
        [
          {
            text: "Додати бота в чат будинку",
            url: `https://t.me/svitlo4u_test_bot?startgroup=${site?.id}`,
          },
        ],
      ],
    });
    // The admin hears about the new building.
    expect(tg.textsTo(ADMIN).some((t) => t.includes("новий будинок «Дім на Оболоні»"))).toBe(true);

    // Only by its address: not in the list.
    const id = site?.id as string;
    const list = (await c.app.inject({ method: "GET", url: "/api/v1/sites" })).json();
    expect(list.sites.map((s: { id: string }) => s.id)).toEqual(["4u"]);
    expect(list.defaultSiteId).toBe("4u");
    expect(
      (await c.app.inject({ method: "GET", url: `/api/v1/sites/${id}` })).json(),
    ).toMatchObject({ id, name: "Дім на Оболоні", access: "link", scene: "none" });

    // Its hub's reports drive it; the owner's chat follows it.
    expect((await report(c, hub, 0)).json()).toEqual({ ok: true, ack: 0 });
    expect(c.state.get(id).power).toBe("on");
    expect(c.store.telegram.sitesOf(OWNER)).toEqual([id]);
    expect(c.store.telegramUsers.site(OWNER)).toBe(id);

    // Plain /start in the owner's chat now talks about the building.
    await post(c, message(dm(OWNER), OWNER, "/start"));
    expect(tg.lastTo(OWNER)?.payload.text).toContain("Дім на Оболоні");
  });

  it("the sticker belongs to whoever has the hub: another scan is refused, a wrong code too", async () => {
    const { core: c, tg } = await start();
    const { hub } = await claim(c, tg, "Дім");
    await post(c, message(dm(8), 8, `/start ${hub.payload}`));
    expect(tg.lastTo(8)?.payload.text).toBe(CLAIM_TAKEN_TEXT);
    await post(c, message(dm(8), 8, `/start own-${hub.id}-aaaaaaaaaa`));
    expect(tg.lastTo(8)?.payload.text).toBe(CLAIM_BAD_CODE_TEXT);
    // The owner scanning again just gets the welcome.
    await post(c, message(dm(OWNER), OWNER, `/start ${hub.payload}`));
    expect(tg.lastTo(OWNER)?.payload.text).toContain("Готово! Хаб");
  });

  it("the hub's service news reach its owner as well as the admin", async () => {
    const { core: c, tg } = await start();
    const { site } = await claim(c, tg, "Дім");
    c.bus.emit("hub.silent", {
      siteId: site.id,
      deviceId: "x",
      since: T0 - 180_000,
      detectedAt: T0,
    });
    await flush(c);
    expect(tg.textsTo(OWNER).at(-1)).toContain("Дім: хаб мовчить");
    expect(tg.textsTo(ADMIN).at(-1)).toContain("Дім: хаб мовчить");
  });

  it("«Мій хаб»: my hubs, rename, release — then the sticker's next scan takes it with the building", async () => {
    const { core: c, tg, clock } = await start();
    const { hub, site } = await claim(c, tg, "Дім");
    await report(c, hub, 0);
    const auth = (userId: number) => ({ authorization: `tma ${initData(userId, clock.now())}` });

    expect((await c.app.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
    const me = (
      await c.app.inject({ method: "GET", url: "/api/v1/me", headers: auth(OWNER) })
    ).json();
    expect(me).toMatchObject({
      user: { id: OWNER },
      siteId: site.id,
      hubs: [
        {
          id: hub.id,
          site: { id: site.id, name: "Дім", access: "link", renamable: true },
          status: { lastReportAt: T0, fw: "0.2.0", paired: true, mains: "on", voltage: 225 },
          groupLink: `https://t.me/svitlo4u_test_bot?startgroup=${site.id}`,
        },
      ],
    });

    const renamed = await c.app.inject({
      method: "POST",
      url: `/api/v1/me/hubs/${hub.id}/name`,
      headers: auth(OWNER),
      payload: { name: "  Дача  " },
    });
    expect(renamed.json().hubs[0].site.name).toBe("Дача");
    expect(c.state.site(site.id).name).toBe("Дача");
    expect(c.store.sites.get(site.id)?.name).toBe("Дача");
    // Not someone else's.
    const foreign = await c.app.inject({
      method: "POST",
      url: `/api/v1/me/hubs/${hub.id}/release`,
      headers: auth(8),
    });
    expect(foreign.statusCode).toBe(403);

    const released = await c.app.inject({
      method: "POST",
      url: `/api/v1/me/hubs/${hub.id}/release`,
      headers: auth(OWNER),
    });
    expect(released.json().hubs).toEqual([]);
    await post(c, message(dm(8), 8, `/start ${hub.payload}`));
    expect(tg.lastTo(8)?.payload.text).toContain("«Дача»");
    expect(c.store.hubs.get(hub.id)?.ownerUserId).toBe(8);

    // My building on every device.
    const put = await c.app.inject({
      method: "PUT",
      url: "/api/v1/me/site",
      headers: auth(9),
      payload: { siteId: "4u" },
    });
    expect(put.json().siteId).toBe("4u");
  });

  it("a group follows a building by the startgroup link — only its admin may do it", async () => {
    const { core: c, tg } = await start();
    const { site } = await claim(c, tg, "Дім");
    const group = { id: -500, type: "supergroup" };
    tg.setAdmins([8]);
    await post(c, message(group, 9, `/start ${site.id}`));
    expect(tg.lastTo(-500)?.payload.text).toBe(SUB_ADMINS_ONLY_TEXT);
    await post(c, message(group, 8, `/start ${site.id}`));
    expect(tg.lastTo(-500)?.payload.text).toContain(
      "Сюди приходитимуть сповіщення про світло в «Дім»",
    );
    expect(c.store.telegram.sitesOf(-500)).toEqual([site.id]);
    // The building's announcements reach it; ЖК 4U's do not.
    c.telegram.announce(site.id, "manual", "тест будинку");
    c.telegram.announce("4u", "manual", "тест 4U");
    await flush(c);
    expect(tg.textsTo(-500)).toContain("тест будинку");
    expect(tg.textsTo(-500)).not.toContain("тест 4U");
  });

  it("owners' buildings and bench hubs come back after a restart", async () => {
    const first = await start();
    const { hub, site } = await claim(first.core, first.tg, "Дім");
    const pending = first.core.ownership.newHub(); // no building yet
    await first.core.stop();
    core = null;

    const { core: c } = await start(new ManualClock(T0 + 60_000));
    expect(c.sites.find((s) => s.id === site.id)).toMatchObject({ name: "Дім", origin: "owner" });
    expect((await report(c, hub, 5)).json()).toEqual({ ok: true, ack: 5 });
    expect(c.state.get(site.id).power).toBe("on");
    // A hub without a building is answered (and may update) but drives nothing.
    expect((await report(c, pending, 0)).json()).toEqual({ ok: true, ack: 0 });
    expect(claimPayload(pending.id, pending.secret)).toBe(pending.payload);
  });
});
