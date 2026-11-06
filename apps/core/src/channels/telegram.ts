/**
 * Telegram channel: one grammY bot per site (a site may keep a bot of its own, e.g. a legacy one
 * with its subscribers). Announcements go through the outbox; command replies are sent directly.
 *
 * Updates arrive by webhook (`POST /telegram/:siteId`, checked with the secret token header) or,
 * without a public URL, by long polling. `shadow` sites send every announcement to the admin chat
 * only, with measured latency — the new core runs next to the legacy bots until switch-over.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  addDays,
  dayInfo,
  formatDayMessage,
  localDate,
  scheduleLink,
  withLastScheduleUpdate,
} from "@svitlo/domain";
import type { OutboxItem, Store } from "@svitlo/storage";
import type { FastifyInstance } from "fastify";
import { Bot, type Context, GrammyError, HttpError, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { Clock } from "../runtime/clock.ts";
import { lastFixedSchedule } from "../services/schedule.ts";
import type { SiteStateStore } from "../services/state.ts";
import {
  type ChatTarget,
  parseChatTarget,
  type SiteConfig,
  type TelegramSiteConfig,
} from "../sites-config.ts";
import {
  escapeHtml,
  latencyFooter,
  shadowHeader,
  startText,
  statusText,
  subscribeText,
} from "./messages.ts";
import type { DeliveryResult, EnqueueItem, Outbox } from "./outbox.ts";

export const TELEGRAM = "telegram";

export type TelegramPayload = {
  text: string;
  silent?: boolean;
  /** Shadow copies: append measured latency at send time. */
  latency?: { eventAt: number; detectedAt: number | null };
};

export type AnnounceOptions = {
  silent?: boolean;
  eventAt?: number;
  detectedAt?: number | null;
  dedupeKey?: string;
};

export type AdminReports = {
  health: (siteId: string) => string;
  stats: (siteId: string) => string;
};

export type TelegramDeps = {
  sites: readonly SiteConfig[];
  store: Store;
  state: SiteStateStore;
  clock: Clock;
  outbox: Outbox;
  reports: AdminReports;
  /** https://svitlo4u.info — webhook mode when set. */
  publicUrl: string | null;
  updates: "webhook" | "polling" | "off";
  log: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
  /** Tests: answer Bot API calls without the network. */
  transformer?: Transformer;
  /** Tests: skip getMe. */
  botInfo?: UserFromGetMe;
  /** Pause between sends of one bot (Telegram allows ~30 messages/s). */
  paceMs?: number;
};

const COMMANDS = [
  { command: "status", description: "Чи є світло зараз" },
  { command: "today", description: "Графік на сьогодні" },
  { command: "tomorrow", description: "Графік на завтра" },
  { command: "sub", description: "Підписка на сповіщення" },
  { command: "start", description: "Про бота" },
];

const DEAD_CHAT = [
  "chat not found",
  "user is deactivated",
  "bot was kicked",
  "bot was blocked",
  "group chat was deactivated",
  "group chat was deleted",
  "peer_id_invalid",
  "need administrator rights",
  "not enough rights",
];

const SEND_OPTIONS = { parse_mode: "HTML", link_preview_options: { is_disabled: true } } as const;
const INIT_RETRY_MS = 30_000;
const ADMIN_CACHE_MS = 10 * 60_000;

export function webhookSecret(token: string): string {
  return createHash("sha256").update(`svitlo4u-telegram-webhook:${token}`).digest("hex");
}

export function formatTarget(target: ChatTarget): string {
  return target.threadId === null ? String(target.chatId) : `${target.chatId}_${target.threadId}`;
}

/** Legacy rule: a target without a thread matches only messages outside threads. */
function matches(targets: readonly ChatTarget[], chatId: number, threadId: number | null): boolean {
  return targets.some((t) => t.chatId === chatId && t.threadId === threadId);
}

class SiteBot {
  readonly site: SiteConfig;
  readonly config: TelegramSiteConfig;
  readonly bot: Bot;
  readonly secret: string;
  ready = false;
  polling = false;
  private nextSendAt = 0;
  private readonly admins = new Map<string, { admin: boolean; until: number }>();

  constructor(site: SiteConfig, config: TelegramSiteConfig, deps: TelegramDeps) {
    this.site = site;
    this.config = config;
    this.secret = webhookSecret(config.botToken);
    this.bot = new Bot(config.botToken, {
      ...(deps.botInfo ? { botInfo: deps.botInfo } : {}),
      client: { timeoutSeconds: 15 },
    });
    if (deps.transformer) this.bot.api.config.use(deps.transformer);
    this.ready = deps.botInfo !== undefined;
  }

  /** Space sends so a burst stays under Telegram's limit. */
  async pace(ms: number): Promise<void> {
    if (ms <= 0) return;
    const now = performance.now();
    const at = Math.max(now, this.nextSendAt);
    this.nextSendAt = at + ms;
    if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  }

  async isChatAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
    const key = `${chatId}:${userId}`;
    const cached = this.admins.get(key);
    const now = Date.now();
    if (cached && cached.until > now) return cached.admin;
    let admin = false;
    try {
      const member = await ctx.api.getChatMember(chatId, userId);
      admin = member.status === "creator" || member.status === "administrator";
    } catch {
      admin = false;
    }
    this.admins.set(key, { admin, until: now + ADMIN_CACHE_MS });
    return admin;
  }
}

export class TelegramChannel {
  private readonly deps: TelegramDeps;
  private readonly bots = new Map<string, SiteBot>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(deps: TelegramDeps) {
    this.deps = deps;
    for (const site of deps.sites) {
      if (!site.telegram) continue;
      const siteBot = new SiteBot(site, site.telegram, deps);
      if (site.telegram.shadow && site.telegram.adminChatId === undefined) {
        deps.log.warn(
          { site: site.id },
          "telegram shadow mode without adminChatId: nothing is sent",
        );
      }
      this.setupHandlers(siteBot);
      this.bots.set(site.id, siteBot);
    }
  }

  get enabled(): boolean {
    return this.bots.size > 0;
  }

  bot(siteId: string): Bot | null {
    return this.bots.get(siteId)?.bot ?? null;
  }

  /** Queue a message for the site's chats and subscribers (only the admin chat in shadow mode). */
  announce(siteId: string, kind: string, text: string, options: AnnounceOptions = {}): number {
    const siteBot = this.bots.get(siteId);
    if (!siteBot) return 0;
    const { config } = siteBot;
    const targets = this.audience(siteId, config);
    const base = { siteId, channel: TELEGRAM, kind };
    let items: EnqueueItem[];
    if (config.shadow) {
      if (config.adminChatId === undefined) return 0;
      const payload: TelegramPayload = {
        text: `${shadowHeader(siteId, targets.length)}\n${text}`,
        silent: true,
        ...(options.eventAt !== undefined
          ? { latency: { eventAt: options.eventAt, detectedAt: options.detectedAt ?? null } }
          : {}),
      };
      items = [
        {
          ...base,
          target: String(config.adminChatId),
          payload,
          ...(options.dedupeKey ? { dedupeKey: `${options.dedupeKey}|shadow` } : {}),
        },
      ];
    } else {
      const payload: TelegramPayload = { text, ...(options.silent ? { silent: true } : {}) };
      items = targets.map((target) => ({
        ...base,
        target,
        payload,
        ...(options.dedupeKey ? { dedupeKey: `${options.dedupeKey}|${target}` } : {}),
      }));
    }
    return this.deps.outbox.enqueue(items);
  }

  /** Message the admin chat of a site, or of every site (null; once per distinct admin chat). */
  alert(
    siteId: string | null,
    text: string,
    options: { silent?: boolean; dedupeKey?: string } = {},
  ): void {
    const seen = new Set<number>();
    const items: EnqueueItem[] = [];
    for (const siteBot of this.bots.values()) {
      if (siteId !== null && siteBot.site.id !== siteId) continue;
      const admin = siteBot.config.adminChatId;
      if (admin === undefined || seen.has(admin)) continue;
      seen.add(admin);
      const payload: TelegramPayload = { text, ...(options.silent ? { silent: true } : {}) };
      items.push({
        siteId: siteBot.site.id,
        channel: TELEGRAM,
        target: String(admin),
        kind: "alert",
        payload,
        ...(options.dedupeKey ? { dedupeKey: `${options.dedupeKey}|${admin}` } : {}),
      });
    }
    if (items.length > 0) this.deps.outbox.enqueue(items);
  }

  /** Configured chats + /sub subscribers, without duplicates. */
  private audience(siteId: string, config: TelegramSiteConfig): string[] {
    const targets = new Set(config.chats.map(formatTarget));
    for (const row of this.deps.store.telegram.list(siteId)) {
      targets.add(formatTarget({ chatId: row.chatId, threadId: row.threadId || null }));
    }
    return [...targets];
  }

  /** Outbox sender for the "telegram" channel. */
  readonly send = async (item: OutboxItem): Promise<DeliveryResult> => {
    const siteBot = this.bots.get(item.siteId);
    if (!siteBot) return { status: "failed", error: `no Telegram bot for site ${item.siteId}` };
    const payload = JSON.parse(item.payloadJson) as TelegramPayload;
    const target = parseChatTarget(item.target);
    await siteBot.pace(this.deps.paceMs ?? 40);
    let text = payload.text;
    if (payload.latency) {
      text += `\n\n${latencyFooter(payload.latency.eventAt, payload.latency.detectedAt, this.deps.clock.now())}`;
    }
    try {
      await siteBot.bot.api.sendMessage(target.chatId, text, {
        ...SEND_OPTIONS,
        ...(target.threadId !== null ? { message_thread_id: target.threadId } : {}),
        ...(payload.silent ? { disable_notification: true } : {}),
      });
      return { status: "sent" };
    } catch (error) {
      return this.classify(item, target, error);
    }
  };

  private classify(item: OutboxItem, target: ChatTarget, error: unknown): DeliveryResult {
    if (error instanceof GrammyError) {
      const description = `${error.error_code} ${error.description}`;
      if (error.error_code === 429) {
        const after = (error.parameters.retry_after ?? 5) * 1000;
        return { status: "retry", error: description, retryAt: this.deps.clock.now() + after };
      }
      const migrated = error.parameters.migrate_to_chat_id;
      if (migrated !== undefined) {
        const next = formatTarget({ chatId: migrated, threadId: target.threadId });
        if (this.isSubscriber(item.siteId, target)) {
          this.deps.store.telegram.move(
            item.siteId,
            target.chatId,
            migrated,
            this.deps.clock.now(),
          );
        } else {
          this.alert(
            item.siteId,
            `⚠️ Чат ${item.target} став супергрупою ${next} — онови telegram.chats у sites.yaml.`,
          );
        }
        return { status: "redirect", error: description, target: next };
      }
      if (error.error_code >= 500) return { status: "retry", error: description };
      const dead =
        error.error_code === 403 ||
        DEAD_CHAT.some((marker) => error.description.toLowerCase().includes(marker));
      if (dead && this.isSubscriber(item.siteId, target)) {
        this.deps.store.telegram.unsubscribe(item.siteId, target.chatId, target.threadId ?? 0);
        this.deps.log.info(
          { site: item.siteId, target: item.target, error: description },
          "subscriber unreachable, removed",
        );
        return { status: "failed", error: description, quiet: true };
      }
      return { status: "failed", error: description };
    }
    if (error instanceof HttpError) return { status: "retry", error: `network: ${error.message}` };
    return { status: "retry", error: error instanceof Error ? error.message : String(error) };
  }

  private isSubscriber(siteId: string, target: ChatTarget): boolean {
    return this.deps.store.telegram
      .list(siteId)
      .some((row) => row.chatId === target.chatId && (row.threadId || null) === target.threadId);
  }

  // ─── updates ────────────────────────────────────────────────────────────────────────────

  private setupHandlers(siteBot: SiteBot): void {
    const { bot, config, site } = siteBot;
    const { state, store, clock, reports } = this.deps;
    const reply = (ctx: Context, text: string) => ctx.reply(text, SEND_OPTIONS);
    const isAdminChat = (ctx: Context) =>
      config.adminChatId !== undefined && ctx.chat?.id === config.adminChatId;

    bot.on("message", async (ctx, next) => {
      const msg = ctx.message;
      const chatId = msg.chat.id;
      if (chatId === config.adminChatId || msg.chat.type === "private") return next();
      const threadId = msg.message_thread_id ?? null;
      const isCommand = msg.entities?.some((e) => e.type === "bot_command" && e.offset === 0);
      if (isCommand && matches(config.blockedChats, chatId, threadId)) {
        await ctx.deleteMessage().catch(() => {});
        return;
      }
      if (!isCommand && matches(config.silentChats, chatId, threadId)) {
        const fromAdmin =
          msg.sender_chat?.id === chatId ||
          msg.is_automatic_forward === true ||
          (msg.from !== undefined && (await siteBot.isChatAdmin(ctx, chatId, msg.from.id)));
        if (!fromAdmin) {
          await ctx.deleteMessage().catch(() => {});
          return;
        }
      }
      return next();
    });

    bot.command("start", (ctx) => reply(ctx, startText(site)));

    bot.command("status", async (ctx) => {
      const now = clock.now();
      const current = state.get(site.id);
      await reply(
        ctx,
        statusText({
          power: current.power,
          since: current.since,
          now,
          plan: state.planTexts(site.id, now),
          linkUrl: site.linkUrl,
        }),
      );
      if (config.logStatusRequests && !isAdminChat(ctx)) {
        this.alert(site.id, `📮 /status від ${describeSender(ctx)}`, { silent: true });
      }
    });

    const dayCommand = (which: "today" | "tomorrow") => async (ctx: Context) => {
      const schedule = state.get(site.id).schedule;
      const text = { tz: site.tz, linkUrl: site.linkUrl };
      if (!schedule) {
        await reply(ctx, `❌ Помилка при завантаженні ${scheduleLink(text, "графіку")}`);
        return;
      }
      const today = localDate(clock.now(), site.tz);
      const day = which === "today" ? schedule.today : schedule.tomorrow;
      const date = which === "today" ? today : addDays(today, 1);
      const info = dayInfo(day, date, site.tz, schedule.updatedOn);
      const lastFixed =
        info.status === "EmergencyShutdowns" ? lastFixedSchedule(store, site, info.date) : null;
      await reply(
        ctx,
        withLastScheduleUpdate(text, formatDayMessage(text, info, lastFixed), schedule.updatedOn),
      );
    };
    bot.command("today", dayCommand("today"));
    bot.command("tomorrow", dayCommand("tomorrow"));

    bot.command("sub", async (ctx) => {
      const chatId = ctx.chat.id;
      const threadId = ctx.message?.is_topic_message ? (ctx.message.message_thread_id ?? 0) : 0;
      const subscribed = store.telegram.toggle(site.id, chatId, threadId, clock.now());
      await reply(ctx, subscribeText(subscribed));
      this.alert(
        site.id,
        `🔔 /sub: ${describeSender(ctx)} ${subscribed ? "підписався" : "відписався"}`,
        { silent: true },
      );
    });

    // Admin chat only.
    bot.command("health", async (ctx) => {
      if (isAdminChat(ctx)) await reply(ctx, reports.health(site.id));
    });
    bot.command("stats", async (ctx) => {
      if (isAdminChat(ctx)) await reply(ctx, reports.stats(site.id));
    });
    bot.command("notify", async (ctx) => {
      if (!isAdminChat(ctx)) return;
      const text = ctx.match.trim();
      if (!text) {
        await reply(ctx, "Використання: /notify текст (HTML) — розсилка в усі чати локації.");
        return;
      }
      const queued = this.announce(site.id, "manual", text);
      await reply(
        ctx,
        config.shadow
          ? `🧪 shadow: копія піде лише сюди (${queued}).`
          : `✅ Поставлено в чергу: ${queued}.`,
      );
    });

    bot.catch((err) => {
      this.deps.log.error({ site: site.id, err: err.error }, "telegram update failed");
    });
  }

  /** Webhook endpoint. Answers at once; the update is handled in the background. */
  registerRoutes(app: FastifyInstance): void {
    if (this.deps.updates !== "webhook") return;
    app.post<{ Params: { siteId: string } }>("/telegram/:siteId", async (request, reply) => {
      const siteBot = this.bots.get(request.params.siteId);
      if (!siteBot?.config.commands) return reply.code(404).send();
      const header = request.headers["x-telegram-bot-api-secret-token"];
      if (typeof header !== "string" || !safeEqual(header, siteBot.secret)) {
        return reply.code(401).send();
      }
      if (!siteBot.ready) return reply.code(503).send();
      void siteBot.bot.handleUpdate(request.body as Update).catch((err: unknown) => {
        this.deps.log.error({ site: siteBot.site.id, err }, "telegram update failed");
      });
      return reply.code(200).send();
    });
  }

  /** Connect bots in the background: getMe, commands menu, webhook or polling. Never blocks. */
  start(): void {
    this.stopped = false;
    for (const siteBot of this.bots.values()) void this.connect(siteBot);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    await Promise.all(
      [...this.bots.values()].filter((b) => b.polling).map((b) => b.bot.stop().catch(() => {})),
    );
  }

  private async connect(siteBot: SiteBot): Promise<void> {
    if (this.stopped) return;
    const { bot, config, site } = siteBot;
    const { log, updates, publicUrl } = this.deps;
    try {
      if (!bot.isInited()) await bot.init();
      siteBot.ready = true;
      if (!config.commands || updates === "off") {
        log.info({ site: site.id, bot: bot.botInfo.username }, "telegram bot ready (send only)");
        return;
      }
      await bot.api.setMyCommands(COMMANDS);
      if (updates === "webhook" && publicUrl) {
        await bot.api.setWebhook(`${publicUrl.replace(/\/$/, "")}/telegram/${site.id}`, {
          secret_token: siteBot.secret,
          allowed_updates: ["message"],
        });
        log.info({ site: site.id, bot: bot.botInfo.username }, "telegram webhook set");
      } else if (updates === "polling") {
        siteBot.polling = true;
        void bot
          .start({ allowed_updates: ["message"], drop_pending_updates: true })
          .catch((err: unknown) => {
            siteBot.polling = false;
            log.error({ site: site.id, err }, "telegram polling stopped");
            this.retry(siteBot);
          });
        log.info({ site: site.id, bot: bot.botInfo.username }, "telegram polling started");
      }
    } catch (err) {
      log.warn({ site: site.id, err: String(err) }, "telegram bot not connected, retrying in 30 s");
      this.retry(siteBot);
    }
  }

  private retry(siteBot: SiteBot): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.connect(siteBot);
    }, INIT_RETRY_MS);
    this.retryTimers.add(timer);
  }
}

function describeSender(ctx: Context): string {
  const user = ctx.from;
  const name = user
    ? user.username
      ? `@${user.username}`
      : [user.first_name, user.last_name].filter(Boolean).join(" ")
    : "";
  const parts = [`chat=${ctx.chat?.id}`];
  if (name) parts.push(`login=${escapeHtml(name)}`);
  const thread = ctx.message?.message_thread_id;
  if (thread !== undefined) parts.push(`thread=${thread}`);
  return parts.join(", ");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
