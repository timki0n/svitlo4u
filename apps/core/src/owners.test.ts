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

/** YASNO's address search: one street, two houses, the first in queue 19.1. */
async function fakeYasnoAddresses(url: string): Promise<Response> {
  if (url.includes("/addresses/v2/streets"))
    return Response.json(url.includes("query=") ? [{ id: 997, value: "вул. Хрещатик" }] : []);
  if (url.includes("/addresses/v2/houses"))
    return Response.json([
      { id: 40856, value: "1/2" },
      { id: 40858, value: "10,12" },
    ]);
  if (url.includes("/addresses/v2/group"))
    return Response.json(url.includes("houseId=40856") ? { group: 19, subgroup: 1 } : {});
  return new Response("{}", { status: 500 });
}

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

async function start(clock = new ManualClock(T0), tg = fakeTelegram(), extra4u = "") {
  writeFileSync(
    join(dir, "sites.yaml"),
    SITES.replace("    scene: 4u\n", `    scene: 4u\n${extra4u}`),
  );
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
      fetch: fakeYasnoAddresses,
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
  await post(c, message(dm(OWNER), OWNER, "Хрещатик"));
  await post(c, press(OWNER, `st:${hub.id}:997`));
  await post(c, message(dm(OWNER), OWNER, "1"));
  await post(c, press(OWNER, `hs:${hub.id}:40856`));
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
    expect(tg.lastTo(OWNER)?.payload.text).toContain(`Хаб ${hub.id} тепер ваш`);
    type Markup = { inline_keyboard: { callback_data: string }[][] } | undefined;
    const keys = () =>
      ((tg.lastTo(OWNER)?.payload.reply_markup as Markup)?.inline_keyboard ?? [])
        .flat()
        .map((k) => k.callback_data);

    // The address gives the queue: the street, the house — buttons from YASNO's search.
    await post(c, message(dm(OWNER), OWNER, "Хрещатик"));
    expect(keys()).toEqual([`st:${hub.id}:997`]);
    await post(c, press(OWNER, `st:${hub.id}:997`));
    expect(
      tg.calls.filter((call) => call.method === "editMessageText").at(-1)?.payload.text,
    ).toContain("Вулиця: вул. Хрещатик");
    await post(c, message(dm(OWNER), OWNER, "1"));
    expect(keys()).toEqual([`hs:${hub.id}:40856`, `hs:${hub.id}:40858`]);
    // A house YASNO has no queue for: try another one.
    await post(c, press(OWNER, `hs:${hub.id}:40858`));
    expect(
      tg.calls.filter((call) => call.method === "editMessageText").at(-1)?.payload.text,
    ).toContain("YASNO не знає черги");
    await post(c, message(dm(OWNER), OWNER, "1"));
    await post(c, press(OWNER, `hs:${hub.id}:40856`));
    expect(
      tg.calls.filter((call) => call.method === "editMessageText").at(-1)?.payload.text,
    ).toContain("вул. Хрещатик, 1/2: черга 19.1");

    await post(c, message(dm(OWNER), OWNER, "Дім на <Оболоні>"));
    const site = c.sites.find((s) => s.origin === "owner");
    expect(site).toMatchObject({
      name: "Дім на Оболоні",
      access: "link",
      scene: "none",
      yasno: { region: 25, dso: 902, group: "19.1" },
      hub: { id: hub.id, siteId: site?.id },
    });
    expect(site?.id).toMatch(/^b-[a-z2-7]{10}$/);
    // The address gave the queue only: whose address it is in the search, the admin decides.
    expect(c.store.siteAddresses.siteAt(997, 40856)).toBeNull();
    const welcome = tg.lastTo(OWNER);
    expect(welcome?.payload.text).toContain("Готово! Хаб");
    expect(welcome?.payload.text).toContain(`https://svitlo4u.info/${site?.id}`);
    expect(welcome?.payload.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: "Мої будинки", web_app: { url: "https://svitlo4u.test/my" } }],
        [
          {
            text: "Додати бота в чат будинку",
            url: `https://t.me/svitlo4u_test_bot?startgroup=${site?.id}`,
          },
        ],
      ],
    });
    // The admin hears about the new building.
    expect(
      tg
        .textsTo(ADMIN)
        .some((t) =>
          t.includes(
            `новий будинок «Дім на Оболоні» (${site?.id}, вул. Хрещатик, 1/2, черга 19.1)`,
          ),
        ),
    ).toBe(true);

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

  it("«Дати знати» under the admin's note about a weak link sends the owner a hint", async () => {
    const { core: c, tg } = await start();
    const { site } = await claim(c, tg, "Дім");
    c.bus.emit("hub.link-gap", {
      siteId: site.id,
      deviceId: "x",
      gaps: 2,
      longest: 15,
      rssi: -79,
    });
    await flush(c);
    const note = tg.lastTo(ADMIN);
    expect(note?.payload.text).toContain("це проблема зі зв'язком, не світло");
    expect(note?.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Дати знати", callback_data: `tell:${site.id}:gap` }]],
    });
    const before = tg.textsTo(OWNER).length;

    // Only the admin chat may press it.
    await post(c, press(OWNER, `tell:${site.id}:gap`));
    expect(tg.textsTo(OWNER)).toHaveLength(before);

    await post(c, press(ADMIN, `tell:${site.id}:gap`));
    expect(tg.textsTo(OWNER).at(-1)).toContain("Дім: хаб інколи не чує свою розетку");
    expect(
      tg.calls.find((call) => call.method === "editMessageReplyMarkup")?.payload,
    ).toMatchObject({
      reply_markup: {
        inline_keyboard: [[{ text: "✓ Власнику надіслано", callback_data: "done" }]],
      },
    });
    expect(
      tg.calls.some(
        (call) =>
          call.method === "answerCallbackQuery" && call.payload.text === "Надіслано власнику",
      ),
    ).toBe(true);
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

  it("«Мої будинки»: my hubs, rename, release — then the sticker's next scan takes it with the building", async () => {
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
      buildings: [
        {
          site: { id: site.id, name: "Дім", access: "link", renamable: true },
          power: "on",
          hub: {
            id: hub.id,
            status: { lastReportAt: T0, fw: "0.2.0", paired: true, mains: "on", voltage: 225 },
          },
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
    expect(renamed.json().buildings[0].site.name).toBe("Дача");
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
    expect(released.json().buildings).toEqual([]);
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

  it("«Мої будинки» lists the building's groups and channels: feed, the rights it needs, removal", async () => {
    const { core: c, tg, clock } = await start();
    const { site } = await claim(c, tg, "Дім");
    const auth = { authorization: `tma ${initData(OWNER, clock.now())}` };
    const me = async () =>
      (await c.app.inject({ method: "GET", url: "/api/v1/me", headers: auth })).json();
    const bot = { id: 123, is_bot: true, first_name: "svitlo4u" };
    const member = (
      chat: { id: number; type: string; title: string },
      from: number,
      old: string,
      next: object,
    ) => ({
      update_id: updateId++,
      my_chat_member: {
        chat,
        from: user(from),
        date: 0,
        old_chat_member: { status: old, user: bot },
        new_chat_member: { user: bot, ...next },
      },
    });

    // A channel: the owner adds the bot as an admin that posts — it follows their building.
    const channel = { id: -1001, type: "channel", title: "Канал дому" };
    await post(
      c,
      member(channel, OWNER, "left", { status: "administrator", can_post_messages: true }),
    );
    expect(c.store.telegram.sitesOf(-1001)).toEqual([site.id]);
    expect(tg.textsTo(-1001).at(-1)).toContain("Сюди приходитимуть сповіщення про світло в «Дім»");
    expect(tg.textsTo(ADMIN).some((t) => t.includes("Канал «Канал дому»"))).toBe(true);

    // A group by the startgroup link, by its admin (the owner).
    const group = { id: -500, type: "supergroup", title: "Сусіди" };
    tg.setAdmins([OWNER]);
    await post(c, member(group, OWNER, "left", { status: "member" }));
    await post(c, message(group, OWNER, `/start ${site.id}`));
    expect((await me()).buildings[0].chats).toEqual([
      {
        chatId: -1001,
        threadId: 0,
        kind: "channel",
        title: "Канал дому",
        feed: false,
        bot: "ok",
        fixed: false,
      },
      {
        chatId: -500,
        threadId: 0,
        kind: "group",
        title: "Сусіди",
        feed: false,
        bot: "ok",
        fixed: false,
      },
    ]);
    expect((await me()).buildings[0].channelLink).toBe(
      "https://t.me/svitlo4u_test_bot?startchannel&admin=post_messages",
    );

    // A feed without the right to delete: the owner is told what to give the bot.
    const feed = await c.app.inject({
      method: "POST",
      url: "/api/v1/me/chats/-500/feed",
      headers: auth,
      payload: { threadId: 0, on: true },
    });
    expect(feed.json().buildings[0].chats[1]).toMatchObject({ feed: true, bot: "no-delete" });
    await post(
      c,
      member(group, OWNER, "member", { status: "administrator", can_delete_messages: true }),
    );
    expect((await me()).buildings[0].chats[1]).toMatchObject({ feed: true, bot: "ok" });
    // Someone else's chats are not theirs to change.
    const foreign = await c.app.inject({
      method: "POST",
      url: "/api/v1/me/chats/-500/feed",
      headers: { authorization: `tma ${initData(8, clock.now())}` },
      payload: { threadId: 0, on: false },
    });
    expect(foreign.statusCode).toBe(403);

    // Removed from «Мої будинки»: no more notices there, the bot leaves.
    const removed = await c.app.inject({
      method: "POST",
      url: "/api/v1/me/chats/-500/remove",
      headers: auth,
      payload: { threadId: 0 },
    });
    expect(removed.json().buildings[0].chats.map((x: { chatId: number }) => x.chatId)).toEqual([
      -1001,
    ]);
    expect(tg.calls.find((call) => call.method === "leaveChat")?.payload.chat_id).toBe(-500);

    // Kicked out of the channel by its admin: it stops following.
    await post(c, member(channel, OWNER, "administrator", { status: "kicked", until_date: 0 }));
    expect(c.store.telegram.sitesOf(-1001)).toEqual([]);
    expect((await me()).buildings[0].chats).toEqual([]);
  });

  it("an owner named in sites.yaml sees the building without a hub in «Мої будинки»", async () => {
    const { core: c, clock } = await start(
      new ManualClock(T0),
      fakeTelegram(),
      "    owners: [7]\n",
    );
    const me = (
      await c.app.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `tma ${initData(OWNER, clock.now())}` },
      })
    ).json();
    expect(me.buildings).toMatchObject([
      {
        site: { id: "4u", name: "ЖК 4U", access: "public", renamable: false },
        hub: null,
        chats: [],
      },
    ]);
  });

  it("«Знайти мій будинок»: any address, the public building there; only the admin gives 4U its address", async () => {
    const { core: c, clock } = await start(
      new ManualClock(T0),
      fakeTelegram(),
      "    owners: [7]\n",
    );
    const get = async (url: string) => (await c.app.inject({ method: "GET", url })).json();
    const auth = (userId: number) => ({ authorization: `tma ${initData(userId, clock.now())}` });

    expect(await get("/api/v1/addresses/streets?q=%D0%A5%D1%80%D0%B5")).toEqual({
      streets: [{ id: 997, name: "вул. Хрещатик" }],
    });
    expect(await get("/api/v1/addresses/houses?street=997&q=1")).toEqual({
      houses: [
        { id: 40856, name: "1/2" },
        { id: 40858, name: "10,12" },
      ],
    });
    expect(await get("/api/v1/addresses/lookup?street=997&house=40856")).toEqual({
      group: "19.1",
      site: null,
    });
    expect(
      (await c.app.inject({ method: "GET", url: "/api/v1/addresses/houses" })).statusCode,
    ).toBe(400);

    const address = {
      siteId: "4u",
      street: 997,
      house: 40856,
      streetName: "вул. Хрещатик",
      houseName: "1/2",
    };
    const attach = (userId: number) =>
      c.app.inject({
        method: "POST",
        url: "/api/v1/admin/addresses",
        headers: auth(userId),
        payload: address,
      });
    // Not even 4U's owner: a building's address is not theirs to claim.
    expect((await attach(OWNER)).json()).toEqual({ error: "admins_only" });
    expect(
      (await c.app.inject({ method: "POST", url: "/api/v1/admin/addresses", payload: address }))
        .statusCode,
    ).toBe(401);
    expect(
      (await c.app.inject({ method: "GET", url: "/api/v1/me", headers: auth(ADMIN) })).json().admin,
    ).toBe(true);
    expect(
      (await c.app.inject({ method: "GET", url: "/api/v1/me", headers: auth(OWNER) })).json().admin,
    ).toBe(false);
    expect((await attach(ADMIN)).json()).toEqual({ ok: true });
    expect(await get("/api/v1/addresses/lookup?street=997&house=40856")).toEqual({
      group: "19.1",
      site: { id: "4u", name: "ЖК 4U" },
    });
  });

  it("a private building is never found by its address, nor given one by the admin", async () => {
    const { core: c, tg, clock } = await start();
    const { site } = await claim(c, tg, "Дім");
    const lookup = async () =>
      (
        await c.app.inject({
          method: "GET",
          url: "/api/v1/addresses/lookup?street=997&house=40856",
        })
      ).json();
    const attach = await c.app.inject({
      method: "POST",
      url: "/api/v1/admin/addresses",
      headers: { authorization: `tma ${initData(ADMIN, clock.now())}` },
      payload: { siteId: site.id, street: 997, house: 40856, streetName: "x", houseName: "1" },
    });
    expect(attach.statusCode).toBe(404);
    // Even with the address in the table (by hand), the search keeps it to itself.
    c.store.siteAddresses.attach(site.id, { streetId: 997, houseId: 40856, text: "x" }, T0);
    expect(await lookup()).toEqual({ group: "19.1", site: null });
  });

  it("«Залишити заявку»: from the Mini App the user is known, on the site a contact is needed", async () => {
    const { core: c, tg, clock } = await start();
    const body = {
      street: 997,
      house: 40856,
      streetName: "вул. Хрещатик",
      houseName: "1/2",
      canAdmin: true,
      sparePhone: true,
      routerOk: true,
      wantsVoltage: true,
    };
    const send = (payload: object, headers: Record<string, string> = {}) =>
      c.app.inject({ method: "POST", url: "/api/v1/requests", headers, payload });

    expect((await send(body)).json()).toEqual({ error: "contact_needed" });
    expect((await send({ ...body, contact: "+380501234567" })).json()).toEqual({ ok: true });
    expect(
      (
        await send(
          // the setup questions say nothing without «можу адмініструвати»
          { ...body, canAdmin: undefined, wantsVoltage: undefined },
          { authorization: `tma ${initData(OWNER, clock.now())}` },
        )
      ).json(),
    ).toEqual({ ok: true });
    await flush(c);

    expect(c.store.requests.list()).toMatchObject([
      {
        address: "вул. Хрещатик, 1/2",
        yasnoGroup: "19.1",
        canAdmin: false,
        sparePhone: false,
        routerOk: false,
        wantsVoltage: false,
        userId: OWNER,
        contact: null,
      },
      {
        address: "вул. Хрещатик, 1/2",
        yasnoGroup: "19.1",
        canAdmin: true,
        sparePhone: true,
        routerOk: true,
        wantsVoltage: true,
        userId: null,
        contact: "+380501234567",
      },
    ]);
    const alerts = tg.textsTo(ADMIN).filter((t) => t.includes("🙋 Заявка"));
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toContain("вул. Хрещатик, 1/2 (черга 19.1)");
    expect(alerts[0]).toContain("Може адмініструвати Світло4U в будинку: так");
    expect(alerts[0]).toContain("Старий Android-смартфон на зарядці: так");
    expect(alerts[0]).toContain("Роутер працює без світла: так");
    expect(alerts[0]).toContain("Хоче бачити напругу: так");
    expect(alerts[1]).toContain("Може адмініструвати Світло4U в будинку: ні");
    expect(alerts[1]).not.toContain("смартфон");
    expect(alerts[0]).toContain("Контакт: +380501234567");
    expect(alerts[1]).toContain(`Контакт: tg ${OWNER}`);

    // A form, not a feed: five in ten minutes from one place.
    for (let i = 0; i < 3; i++) await send({ ...body, contact: "@me" });
    expect((await send({ ...body, contact: "@me" })).statusCode).toBe(429);
    clock.advanceTo(clock.now() + 10 * 60_000);
    expect((await send({ ...body, contact: "@me" })).statusCode).toBe(200);
  });

  it("★ favorites: kept per Telegram user, only buildings that exist", async () => {
    const { core: c, clock } = await start();
    const auth = { authorization: `tma ${initData(OWNER, clock.now())}` };
    const add = await c.app.inject({
      method: "POST",
      url: "/api/v1/me/favorites",
      headers: auth,
      payload: { siteId: "4u" },
    });
    expect(add.json().favorites).toEqual([{ id: "4u", name: "ЖК 4U" }]);
    const unknown = await c.app.inject({
      method: "POST",
      url: "/api/v1/me/favorites",
      headers: auth,
      payload: { siteId: "nope" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(
      (
        await c.app.inject({
          method: "POST",
          url: "/api/v1/me/favorites",
          payload: { siteId: "4u" },
        })
      ).statusCode,
    ).toBe(401);
    const removed = await c.app.inject({
      method: "DELETE",
      url: "/api/v1/me/favorites/4u",
      headers: auth,
    });
    expect(removed.json().favorites).toEqual([]);
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
