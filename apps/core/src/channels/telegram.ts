/**
 * Telegram channel: one grammY bot per token, shared by the buildings that use it (a building may
 * keep a bot of its own, e.g. a legacy one with its subscribers). Announcements go through the
 * outbox; command replies are sent directly.
 *
 * One bot, many buildings: a chat talks about the building it follows — a chat named in
 * sites.yaml, a /sub or t.me/<bot>?start=<building> (startgroup for a group), a person's own
 * building — else about the bot's home (the first building in sites.yaml, ЖК 4U). The sticker of
 * a hub opens /start own-<hub>-<code>: its owner claims it and creates the building (ownership.ts).
 *
 * Updates arrive by webhook (`POST /telegram/<home building>`, checked with the secret token
 * header) or, without a public URL, by long polling. `shadow` sites send every announcement to the
 * admin chat only, with measured latency — the new core runs next to the legacy bots until
 * switch-over.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
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
import { Bot, type Context, GrammyError, HttpError, InputFile, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { AddressItem, YasnoAddresses } from "../adapters/yasno-addresses.ts";
import type { Clock, Timer } from "../runtime/clock.ts";
import type { ScheduleImages } from "../services/images.ts";
import { cleanName, type HubOwnership, YASNO_FEEDS } from "../services/ownership.ts";
import { lastFixedSchedule } from "../services/schedule.ts";
import type { SiteStateStore } from "../services/state.ts";
import {
  type ChatTarget,
  parseChatTarget,
  type SiteConfig,
  type TelegramSiteConfig,
} from "../sites-config.ts";
import {
  CLAIM_BAD_CODE_TEXT,
  CLAIM_FAILED_TEXT,
  CLAIM_NO_GROUP_TEXT,
  CLAIM_NO_HOUSE_TEXT,
  CLAIM_NO_STREET_TEXT,
  CLAIM_PRIVATE_TEXT,
  CLAIM_TAKEN_TEXT,
  claimHouseText,
  claimNameText,
  claimStreetText,
  escapeHtml,
  FEED_USAGE_TEXT,
  feedText,
  followText,
  latencyFooter,
  OWNER_NOTES,
  type OwnerNote,
  ownerWelcomeText,
  SUB_ADMINS_ONLY_TEXT,
  shadowHeader,
  startText,
  statusText,
  subscribeText,
} from "./messages.ts";
import type { DeliveryResult, EnqueueItem, Outbox } from "./outbox.ts";

export const TELEGRAM = "telegram";

export type TelegramPayload = {
  /** HTML; the photo's caption when there is a photo (may be empty). */
  text: string;
  /** A picture (PNG file) sent with the text as its caption. */
  photo?: string;
  silent?: boolean;
  /** Shadow copies: append measured latency at send time. */
  latency?: { eventAt: number; detectedAt: number | null };
  /** Buttons under the message (callback data, at most 64 bytes each). */
  buttons?: AlertButton[][];
};

export type AlertButton = { text: string; data: string };

/** «Дати знати» under an admin alert: `tell:<building>:<what>` sends its owners a note. */
export function tellButton(siteId: string, what: OwnerNote): AlertButton {
  return { text: "Дати знати", data: `tell:${siteId}:${what}` };
}

export type AnnounceOptions = {
  /** Schedule picture to send with the text (see ScheduleImages). */
  photo?: string;
  silent?: boolean;
  eventAt?: number;
  detectedAt?: number | null;
  dedupeKey?: string;
};

export type AdminReports = {
  health: (siteId: string) => string;
  stats: (siteId: string) => string;
  /** /hubs: every hub, its building, owner and last report. */
  hubs?: () => string;
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
  /** Schedule pictures (/testscreenshot); null: not configured. */
  images?: ScheduleImages | null;
  /** How long the /feed notice stays in the topic. */
  noticeMs?: number;
  /** Hub owners (claims by the sticker's QR, their buildings); null: no hubs. */
  ownership?: () => HubOwnership | null;
  /** YASNO's address search: a claimed hub's building gets its queue by the address. */
  addresses?: YasnoAddresses | null;
};

const COMMANDS = [
  { command: "status", description: "Чи є світло зараз" },
  { command: "today", description: "Графік на сьогодні" },
  { command: "tomorrow", description: "Графік на завтра" },
  { command: "sub", description: "Підписка на сповіщення" },
  { command: "start", description: "Про бота" },
];

/**
 * Telegram could not take a picture: its own processing (IMAGE_PROCESS_FAILED comes now and then
 * for a good PNG that goes through a moment later), the picture's sizes, a stale file_id.
 */
const PHOTO_REFUSED = [
  "image_process_failed",
  "photo_invalid_dimensions",
  "photo_save_file_invalid",
  "photo_ext_invalid",
  "wrong file identifier",
  "wrong remote file identifier",
  "file_reference",
];
/** Tries with the picture (now, +5 s, +15 s) before the text goes alone. */
export const PHOTO_ATTEMPTS = 3;

function photoRefused(error: unknown): error is GrammyError {
  if (!(error instanceof GrammyError) || error.error_code !== 400) return false;
  const description = error.description.toLowerCase();
  return PHOTO_REFUSED.some((marker) => description.includes(marker));
}

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
/** Messages, plus the buttons of a hub's claim. */
/** Messages, the buttons of a hub's claim and «Дати знати», the bot added to / removed from chats. */
const ALLOWED_UPDATES: ("message" | "callback_query" | "my_chat_member")[] = [
  "message",
  "callback_query",
  "my_chat_member",
];
const DEFAULT_HOUSE_NAME = "Мій дім";
/** Telegram's caption limit, in characters of the rendered text. */
const CAPTION_MAX = 1024;
/** Room for the latency footer that shadow copies get at send time. */
const SHADOW_FOOTER = 120;

/** Length of HTML as Telegram counts it (tags and entities rendered). */
function renderedLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(lt|gt|amp|quot|#39);/g, "_").length;
}
const INIT_RETRY_MS = 30_000;
/**
 * After a start messages wait until the bot has set up with Telegram (commands, webhook), at most
 * this long. 2026-11-11 03:11: right after the router rebooted, Telegram answered sends with
 * 502 yet posted them, and the retries came as duplicates.
 */
export const SEND_HOLD_MAX_MS = 2 * 60_000;
const ADMIN_CACHE_MS = 10 * 60_000;
const NOTICE_MS = 10_000;
/** On stop, pending notice deletions get this long before the process goes. */
const CLEANUP_ON_STOP_MS = 2_000;

export function webhookSecret(token: string): string {
  return createHash("sha256").update(`svitlo4u-telegram-webhook:${token}`).digest("hex");
}

export function formatTarget(target: ChatTarget): string {
  return target.threadId === null ? String(target.chatId) : `${target.chatId}_${target.threadId}`;
}

/** The forum topic of a message, 0 outside topics (a reply thread is not a topic). */
function topicOf(msg: { is_topic_message?: boolean; message_thread_id?: number }): number {
  return msg.is_topic_message ? (msg.message_thread_id ?? 0) : 0;
}

/** Legacy rule: a target without a thread matches only messages outside threads. */
function matches(targets: readonly ChatTarget[], chatId: number, threadId: number | null): boolean {
  return targets.some((t) => t.chatId === chatId && t.threadId === threadId);
}

/** One bot (token), shared by the buildings that name it in sites.yaml (and the owners' ones). */
class BotConn {
  readonly bot: Bot;
  readonly secret: string;
  /** Buildings on this bot in config order; the first receiving one is its home. */
  readonly siteIds: string[] = [];
  /** Some building on it receives updates (commands, moderation). */
  receiving = false;
  handled = false;
  ready = false;
  /** Set up with Telegram since the start (commands, webhook): the network is good for sends. */
  connected = false;
  polling = false;
  private nextSendAt = 0;
  private readonly admins = new Map<string, { admin: boolean; until: number }>();

  constructor(token: string, deps: TelegramDeps) {
    this.secret = webhookSecret(token);
    this.bot = new Bot(token, {
      ...(deps.botInfo ? { botInfo: deps.botInfo } : {}),
      client: { timeoutSeconds: 15 },
    });
    if (deps.transformer) this.bot.api.config.use(deps.transformer);
    this.ready = deps.botInfo !== undefined;
    this.connected = this.ready;
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

/** A building's side of its bot: its chats, admin chat, shadow mode. */
type SiteBot = { site: SiteConfig; config: TelegramSiteConfig; conn: BotConn };

/** The claim of a hub without a building, between the scan and the name (by Telegram user). */
type PendingClaim = {
  hubId: string;
  step: "street" | "house" | "name";
  /** What the last search offered (the buttons). */
  streets: AddressItem[];
  houses: AddressItem[];
  street: AddressItem | null;
  address: { streetId: number; houseId: number; text: string } | null;
  group: string | null;
  until: number;
};
const OFFER_STREETS = 8;
const OFFER_HOUSES = 12;
const CLAIM_TTL_MS = 30 * 60_000;

export class TelegramChannel {
  private readonly deps: TelegramDeps;
  private readonly bots = new Map<string, SiteBot>();
  private readonly conns = new Map<string, BotConn>();
  private readonly pending = new Map<number, PendingClaim>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  /** Delayed deletions of /feed notices; run at once on stop. */
  private readonly cleanups = new Map<NodeJS.Timeout, () => Promise<unknown>>();
  /** Uploaded pictures: file → Telegram file_id, so other chats get it without a new upload. */
  private readonly photoIds = new Map<string, string>();
  /** Pictures being uploaded now: file → its file_id once there (null: the upload failed). */
  private readonly uploads = new Map<string, Promise<string | null>>();
  private started = false;
  private stopped = false;
  /** Until then sends wait for the bot to connect; later they go anyway. */
  private holdUntil: number;
  private holdTimer: Timer | null = null;

  constructor(deps: TelegramDeps) {
    this.deps = deps;
    this.holdUntil = deps.clock.now() + SEND_HOLD_MAX_MS;
    for (const site of deps.sites) this.attach(site);
    for (const conn of this.conns.values()) if (conn.receiving) this.setupHandlers(conn);
  }

  /** A building added while the core runs: it joins its bot (the home bot for owners' ones). */
  addSite(site: SiteConfig): void {
    const conn = this.attach(site);
    if (!conn) return;
    if (conn.receiving && !conn.handled) this.setupHandlers(conn);
    if (this.started && !conn.ready) void this.connect(conn);
  }

  private attach(site: SiteConfig): BotConn | null {
    if (!site.telegram || this.bots.has(site.id)) return this.bots.get(site.id)?.conn ?? null;
    const config = site.telegram;
    let conn = this.conns.get(config.botToken);
    if (!conn) {
      conn = new BotConn(config.botToken, this.deps);
      this.conns.set(config.botToken, conn);
    }
    if (config.shadow && config.adminChatId === undefined) {
      this.deps.log.warn(
        { site: site.id },
        "telegram shadow mode without adminChatId: nothing is sent",
      );
    }
    conn.siteIds.push(site.id);
    if (config.commands) conn.receiving = true;
    this.bots.set(site.id, { site, config, conn });
    return conn;
  }

  get enabled(): boolean {
    return this.bots.size > 0;
  }

  bot(siteId: string): Bot | null {
    return this.bots.get(siteId)?.conn.bot ?? null;
  }

  /** The bot leaves a group or channel (its owner removed it in «Мої будинки»). */
  async leaveChat(siteId: string, chatId: number): Promise<boolean> {
    const conn = this.bots.get(siteId)?.conn;
    if (!conn) return false;
    return conn.bot.api.leaveChat(chatId).then(
      () => true,
      () => false,
    );
  }

  /** The @username of the bot that receives updates (t.me links), null until it has connected. */
  botUsername(): string | null {
    for (const conn of this.conns.values()) {
      if (conn.receiving && conn.bot.isInited()) return conn.bot.botInfo.username;
    }
    return null;
  }

  /** The outbox may send for the site: its bot has connected, or waiting for it took too long. */
  canSend(siteId: string): boolean {
    const siteBot = this.bots.get(siteId);
    return !siteBot || siteBot.conn.connected || this.deps.clock.now() >= this.holdUntil;
  }

  /** Queue a message for the site's chats and subscribers (only the admin chat in shadow mode). */
  announce(siteId: string, kind: string, text: string, options: AnnounceOptions = {}): number {
    const siteBot = this.bots.get(siteId);
    if (!siteBot) return 0;
    const { config } = siteBot;
    // A site may announce only some kinds (a test site: just the light and the voltage).
    if (config.announce && !(config.announce as readonly string[]).includes(kind)) return 0;
    const targets = this.audience(siteId, config);
    const base = { siteId, channel: TELEGRAM, kind };
    /** One target's items: the text as the picture's caption, or the picture first when too long. */
    const itemsFor = (target: string, payload: TelegramPayload, dedupe?: string): EnqueueItem[] => {
      const key = (suffix: string) => (dedupe ? { dedupeKey: `${dedupe}${suffix}` } : {});
      if (!options.photo) return [{ ...base, target, payload, ...key("") }];
      const room = CAPTION_MAX - (payload.latency ? SHADOW_FOOTER : 0);
      if (renderedLength(payload.text) <= room) {
        return [{ ...base, target, payload: { ...payload, photo: options.photo }, ...key("") }];
      }
      const picture: TelegramPayload = {
        text: "",
        photo: options.photo,
        ...(payload.silent ? { silent: true } : {}),
      };
      return [
        { ...base, target, payload: picture, ...key("|photo") },
        { ...base, target, payload, ...key("") },
      ];
    };
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
      items = itemsFor(
        String(config.adminChatId),
        payload,
        options.dedupeKey ? `${options.dedupeKey}|shadow` : undefined,
      );
    } else {
      const payload: TelegramPayload = { text, ...(options.silent ? { silent: true } : {}) };
      items = targets.flatMap((target) =>
        itemsFor(target, payload, options.dedupeKey ? `${options.dedupeKey}|${target}` : undefined),
      );
    }
    return this.deps.outbox.enqueue(items);
  }

  /** Message the admin chat of a site, or of every site (null; once per distinct admin chat). */
  alert(
    siteId: string | null,
    text: string,
    options: { silent?: boolean; dedupeKey?: string; buttons?: AlertButton[][] } = {},
  ): void {
    const seen = new Set<number>();
    const items: EnqueueItem[] = [];
    for (const siteBot of this.bots.values()) {
      if (siteId !== null && siteBot.site.id !== siteId) continue;
      const admin = siteBot.config.adminChatId;
      if (admin === undefined || seen.has(admin)) continue;
      seen.add(admin);
      const payload: TelegramPayload = {
        text,
        ...(options.silent ? { silent: true } : {}),
        ...(options.buttons ? { buttons: options.buttons } : {}),
      };
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

  /** Message the owners of the building's hubs in their private chats (not the admin twice). */
  toOwners(
    siteId: string,
    text: string,
    options: { silent?: boolean; includeAdmin?: boolean } = {},
  ): number {
    const siteBot = this.bots.get(siteId);
    const ownership = this.deps.ownership?.();
    if (!siteBot || !ownership) return 0;
    // The admin already has the alert, unless they asked for the owner's note on purpose.
    const owners = ownership
      .ownersOf(siteId)
      .filter((userId) => options.includeAdmin || userId !== siteBot.config.adminChatId);
    return this.deps.outbox.enqueue(
      owners.map((userId) => ({
        siteId,
        channel: TELEGRAM,
        target: String(userId),
        kind: "owner",
        payload: { text, ...(options.silent ? { silent: true } : {}) } satisfies TelegramPayload,
      })),
    );
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
    const { bot } = siteBot.conn;
    const payload = JSON.parse(item.payloadJson) as TelegramPayload;
    const target = parseChatTarget(item.target);
    await siteBot.conn.pace(this.deps.paceMs ?? 40);
    let text = payload.text;
    if (payload.latency) {
      text += `\n\n${latencyFooter(payload.latency.eventAt, payload.latency.detectedAt, this.deps.clock.now())}`;
    }
    if (payload.photo) {
      const result = await this.sendPhoto(bot, item, target, payload.photo, text, payload.silent);
      if (result !== "text") return result;
      // No picture to send (old files are cleaned up, or Telegram kept refusing it): the text
      // alone still goes out.
      if (!text) return { status: "failed", error: "no picture to send", quiet: true };
    }
    try {
      await bot.api.sendMessage(target.chatId, text, {
        ...SEND_OPTIONS,
        ...(target.threadId !== null ? { message_thread_id: target.threadId } : {}),
        ...(payload.silent ? { disable_notification: true } : {}),
        ...(payload.buttons
          ? {
              reply_markup: {
                inline_keyboard: payload.buttons.map((row) =>
                  row.map((b) => ({ text: b.text, callback_data: b.data })),
                ),
              },
            }
          : {}),
      });
      return { status: "sent" };
    } catch (error) {
      return this.classify(item, target, error);
    }
  };

  /**
   * The picture with the text as its caption, or "text": there is no picture to send (the file is
   * gone, or Telegram kept refusing it) and the text goes alone. A new picture is uploaded once:
   * the other chats wait for its file_id instead of uploading the same file at the same moment.
   */
  private async sendPhoto(
    bot: Bot,
    item: OutboxItem,
    target: ChatTarget,
    file: string,
    text: string,
    silent: boolean | undefined,
  ): Promise<DeliveryResult | "text"> {
    let known = this.photoIds.get(file);
    // checked again after each wait: a failed upload lets the next chat try it
    for (
      let pending = this.uploads.get(file);
      !known && pending;
      pending = this.uploads.get(file)
    ) {
      known = (await pending) ?? undefined;
    }
    if (!known && !existsSync(file)) return "text";
    const upload = known ? null : Promise.withResolvers<string | null>();
    if (upload) this.uploads.set(file, upload.promise);
    try {
      const message = await bot.api.sendPhoto(target.chatId, known ?? new InputFile(file), {
        ...(text ? { caption: text, parse_mode: "HTML" as const } : {}),
        ...(target.threadId !== null ? { message_thread_id: target.threadId } : {}),
        ...(silent ? { disable_notification: true } : {}),
      });
      const fileId = message.photo?.at(-1)?.file_id ?? null;
      if (!known && fileId) this.rememberPhoto(file, fileId);
      upload?.resolve(fileId);
      return { status: "sent" };
    } catch (error) {
      upload?.resolve(null);
      if (!photoRefused(error)) return this.classify(item, target, error);
      const description = `${error.error_code} ${error.description}`;
      if (known && /file.?(identifier|reference)/i.test(error.description)) {
        this.photoIds.delete(file);
      }
      if (item.attempts + 1 < PHOTO_ATTEMPTS) return { status: "retry", error: description };
      this.deps.log.warn(
        { site: item.siteId, target: item.target, error: description },
        "picture refused, the text goes alone",
      );
      return "text";
    } finally {
      if (upload && this.uploads.get(file) === upload.promise) this.uploads.delete(file);
    }
  }

  private rememberPhoto(file: string, fileId: string): void {
    this.photoIds.set(file, fileId);
    if (this.photoIds.size > 50) {
      const oldest = this.photoIds.keys().next().value;
      if (oldest !== undefined) this.photoIds.delete(oldest);
    }
  }

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

  /** The bot's home building: answers chats that follow nothing (ЖК 4U). */
  private home(conn: BotConn): SiteBot {
    const id = conn.siteIds.find((s) => this.bots.get(s)?.config.commands) ?? conn.siteIds[0];
    return this.bots.get(id as string) as SiteBot;
  }

  /**
   * The building a chat talks about: a chat named in sites.yaml, then what the chat (topic) follows,
   * then a person's own building in a private chat, then the bot's home.
   */
  private siteFor(conn: BotConn, ctx: Context): SiteBot {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return this.home(conn);
    const sites = conn.siteIds.map((id) => this.bots.get(id) as SiteBot);
    const configured = sites.find(({ config }) =>
      [...config.chats, ...config.blockedChats, ...config.silentChats].some(
        (t) => t.chatId === chatId,
      ),
    );
    if (configured) return configured;
    const msg = ctx.message;
    const thread = msg ? topicOf(msg) : 0;
    for (const threadId of thread ? [thread, 0] : [0]) {
      const follows = this.deps.store.telegram
        .sitesOf(chatId, threadId)
        .filter((id) => conn.siteIds.includes(id));
      const last = follows.at(-1);
      if (last) return this.bots.get(last) as SiteBot;
    }
    if (ctx.chat?.type === "private" && ctx.from) {
      const mine = this.deps.store.telegramUsers.site(ctx.from.id);
      if (mine && conn.siteIds.includes(mine)) return this.bots.get(mine) as SiteBot;
    }
    return this.home(conn);
  }

  /** An admin command's building: its first word when it names one, else the chat's. */
  private adminSite(conn: BotConn, ctx: Context): { siteBot: SiteBot; rest: string } {
    const match = typeof ctx.match === "string" ? ctx.match.trim() : "";
    const [first = "", ...words] = match.split(/\s+/);
    const named = conn.siteIds.includes(first.replace(/:$/, ""))
      ? this.bots.get(first.replace(/:$/, ""))
      : undefined;
    return named
      ? { siteBot: named, rest: words.join(" ") }
      : { siteBot: this.siteFor(conn, ctx), rest: match };
  }

  private setupHandlers(conn: BotConn): void {
    conn.handled = true;
    const { bot } = conn;
    const { state, store, clock, reports } = this.deps;
    const reply = (ctx: Context, text: string, extra: object = {}) =>
      ctx.reply(text, { ...SEND_OPTIONS, ...extra });
    const configs = () => conn.siteIds.map((id) => (this.bots.get(id) as SiteBot).config);
    const isAdminChat = (ctx: Context) =>
      ctx.chat !== undefined && configs().some((c) => c.adminChatId === ctx.chat?.id);
    // The developer: the user behind a private admin chat (user ids are positive, groups are not).
    const isOwner = (ctx: Context) =>
      ctx.from !== undefined &&
      configs().some(
        (c) => c.adminChatId !== undefined && c.adminChatId > 0 && c.adminChatId === ctx.from?.id,
      );
    const isGroupAdmin = async (ctx: Context) => {
      const chatId = ctx.chat?.id as number;
      const msg = ctx.message;
      return (
        isAdminChat(ctx) ||
        msg?.sender_chat?.id === chatId ||
        (msg?.from !== undefined && (await conn.isChatAdmin(ctx, chatId, msg.from.id)))
      );
    };

    bot.on("message", async (ctx, next) => {
      const msg = ctx.message;
      const chatId = msg.chat.id;
      if (isAdminChat(ctx) || msg.chat.type === "private" || isOwner(ctx)) return next();
      const { site, config } = this.siteFor(conn, ctx);
      const threadId = msg.message_thread_id ?? null;
      const isCommand = msg.entities?.some((e) => e.type === "bot_command" && e.offset === 0);
      if (isCommand && matches(config.blockedChats, chatId, threadId)) {
        await ctx.deleteMessage().catch(() => {});
        return;
      }
      // A /feed topic takes nothing from non-admins, commands included; a silent one keeps commands.
      const readOnly = store.telegram.isReadOnly(site.id, chatId, topicOf(msg));
      if (readOnly || (!isCommand && matches(config.silentChats, chatId, threadId))) {
        const fromAdmin =
          msg.sender_chat?.id === chatId ||
          msg.is_automatic_forward === true ||
          (msg.from !== undefined && (await conn.isChatAdmin(ctx, chatId, msg.from.id)));
        if (!fromAdmin) {
          await ctx.deleteMessage().catch(() => {});
          return;
        }
      }
      return next();
    });

    bot.command("start", async (ctx) => {
      const payload = ctx.match.trim();
      if (payload.startsWith("own-")) {
        await this.onClaim(conn, ctx, payload);
        return;
      }
      const target = payload ? this.bots.get(payload) : undefined;
      if (!target || target.conn !== conn) {
        await reply(ctx, startText(this.siteFor(conn, ctx).site));
        return;
      }
      // t.me/<bot>?start=<building> (a person) or ?startgroup=<building> (a group): follow it.
      if (ctx.chat.type !== "private" && !(await isGroupAdmin(ctx))) {
        await reply(ctx, SUB_ADMINS_ONLY_TEXT);
        return;
      }
      const msg = ctx.message;
      store.telegram.follow(target.site.id, ctx.chat.id, msg ? topicOf(msg) : 0, clock.now());
      if (ctx.chat.type === "private" && ctx.from)
        store.telegramUsers.setSite(ctx.from.id, target.site.id, clock.now());
      else
        store.telegramChats.touch(
          {
            chatId: ctx.chat.id,
            type: ctx.chat.type,
            title: "title" in ctx.chat ? (ctx.chat.title ?? null) : null,
            ...(ctx.from ? { addedBy: ctx.from.id } : {}),
          },
          clock.now(),
        );
      await reply(ctx, `${startText(target.site)}\n\n${followText(target.site)}`);
      this.alert(target.site.id, `🔔 /start ${target.site.id}: ${describeSender(ctx)} підписався`, {
        silent: true,
      });
    });

    bot.command("status", async (ctx) => {
      const { site, config } = this.siteFor(conn, ctx);
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
          voltage:
            current.lastVoltage !== null
              ? { value: current.lastVoltage, at: current.lastPlugAt }
              : null,
        }),
      );
      if (config.logStatusRequests && !isAdminChat(ctx)) {
        this.alert(site.id, `📮 /status від ${describeSender(ctx)}`, { silent: true });
      }
    });

    const dayCommand = (which: "today" | "tomorrow") => async (ctx: Context) => {
      const { site } = this.siteFor(conn, ctx);
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
        withLastScheduleUpdate(
          text,
          formatDayMessage(text, info, lastFixed?.outages ?? null),
          schedule.updatedOn,
        ),
      );
    };
    bot.command("today", dayCommand("today"));
    bot.command("tomorrow", dayCommand("tomorrow"));

    bot.command("sub", async (ctx) => {
      const { site } = this.siteFor(conn, ctx);
      const chatId = ctx.chat.id;
      const msg = ctx.message;
      // In a group /sub (un)subscribes everyone there: only the group's admins may do it.
      if (ctx.chat.type !== "private" && !(await isGroupAdmin(ctx))) {
        await reply(ctx, SUB_ADMINS_ONLY_TEXT);
        return;
      }
      const threadId = msg ? topicOf(msg) : 0;
      const subscribed = store.telegram.toggle(site.id, chatId, threadId, clock.now());
      await reply(ctx, subscribeText(subscribed));
      this.alert(
        site.id,
        `🔔 /sub: ${describeSender(ctx)} ${subscribed ? "підписався" : "відписався"}`,
        { silent: true },
      );
    });

    // Developer only, not in the menu: make a topic the bot's feed and leave no trace of it.
    bot.command("feed", async (ctx) => {
      const msg = ctx.message;
      if (!isOwner(ctx) || !msg) return;
      if (ctx.chat.type === "private") {
        await reply(ctx, FEED_USAGE_TEXT);
        return;
      }
      const { site } = this.siteFor(conn, ctx);
      const chatId = ctx.chat.id;
      const threadId = topicOf(msg);
      const on = !/^(off|вимк)/i.test(ctx.match.trim());
      if (on) store.telegram.feed(site.id, chatId, threadId, clock.now());
      else store.telegram.unsubscribe(site.id, chatId, threadId);
      const deleted = await ctx.deleteMessage().then(
        () => true,
        () => false,
      );
      const notice = await reply(ctx, feedText(on));
      this.later(
        () => ctx.api.deleteMessage(chatId, notice.message_id).catch(() => {}),
        this.deps.noticeMs ?? NOTICE_MS,
      );
      const where = `chat=${chatId}${threadId ? `, thread=${threadId}` : ""}`;
      this.alert(
        site.id,
        [
          on
            ? `🔇 /feed: ${where} підписано, писати там можуть лише адміни.`
            : `🔊 /feed off: ${where} відписано, писати знову можуть усі.`,
          ...(deleted
            ? []
            : [
                "⚠️ Бот не зміг видалити команду: дай йому в групі адмінку з правом видаляти повідомлення, інакше тиша не працюватиме.",
              ]),
        ].join("\n"),
        { silent: true },
      );
    });

    // The bot added to a group or channel, promoted, restricted or removed: what it may do there.
    bot.on("my_chat_member", async (ctx) => {
      const update = ctx.myChatMember;
      const chat = update.chat;
      if (chat.type === "private") return;
      const member = update.new_chat_member;
      const gone = member.status === "left" || member.status === "kicked";
      const joined =
        !gone &&
        (update.old_chat_member.status === "left" || update.old_chat_member.status === "kicked");
      const admin = member.status === "administrator" ? member : null;
      store.telegramChats.upsert(
        {
          chatId: chat.id,
          type: chat.type,
          title: chat.title ?? null,
          status: member.status,
          canDelete: admin?.can_delete_messages === true,
          canPost: chat.type === "channel" ? admin?.can_post_messages === true : !gone,
          ...(joined ? { addedBy: update.from.id } : {}),
        },
        clock.now(),
      );
      const follows = store.telegram.ofChat(chat.id).filter((s) => conn.siteIds.includes(s.siteId));
      if (gone) {
        for (const s of follows) store.telegram.unsubscribe(s.siteId, chat.id, s.threadId);
        const site = follows[0] ? (this.bots.get(follows[0].siteId) as SiteBot).site : null;
        if (site)
          this.alert(site.id, `🔕 Бота прибрали з «${escapeHtml(chat.title)}»`, {
            silent: true,
          });
        return;
      }
      // A channel takes the building of whoever added the bot (they chose it in «Мої будинки»).
      if (chat.type === "channel" && admin?.can_post_messages && follows.length === 0) {
        const siteId = this.deps.ownership?.()?.buildingOf(update.from.id) ?? null;
        const target = siteId ? this.bots.get(siteId) : undefined;
        if (!target || target.conn !== conn) return;
        store.telegram.follow(target.site.id, chat.id, 0, clock.now());
        await bot.api.sendMessage(chat.id, followText(target.site), SEND_OPTIONS).catch(() => {});
        this.alert(
          target.site.id,
          `📣 Канал «${escapeHtml(chat.title)}» отримуватиме сповіщення «${escapeHtml(target.site.name)}»`,
          { silent: true },
        );
      }
    });

    // Admin chat only. The first word may name the building (`/health hub-test`).
    bot.command("health", async (ctx) => {
      if (isAdminChat(ctx))
        await reply(ctx, reports.health(this.adminSite(conn, ctx).siteBot.site.id));
    });
    bot.command("stats", async (ctx) => {
      if (isAdminChat(ctx))
        await reply(ctx, reports.stats(this.adminSite(conn, ctx).siteBot.site.id));
    });
    bot.command("hubs", async (ctx) => {
      if (isAdminChat(ctx)) await reply(ctx, reports.hubs?.() ?? "Хабів немає.");
    });
    bot.command("testscreenshot", async (ctx) => {
      if (!isAdminChat(ctx)) return;
      const { siteBot } = this.adminSite(conn, ctx);
      const day = /завтра|tomorrow/i.test(ctx.match) ? "tomorrow" : "today";
      const which = day === "today" ? "сьогодні" : "завтра";
      const images = this.deps.images;
      if (!images) {
        await reply(ctx, "Картинки вимкнено: не задано RENDERER_CDP_URL.");
        return;
      }
      const file = await images.render(siteBot.site.id, day);
      if (!file) {
        await reply(
          ctx,
          `Картинку на ${which} не зроблено: графіка немає або рендер не відповів (деталі в логах).`,
        );
        return;
      }
      await ctx.replyWithPhoto(new InputFile(file), { caption: `🧪 Графік на ${which}` });
    });
    bot.command("notify", async (ctx) => {
      if (!isAdminChat(ctx)) return;
      const { siteBot, rest } = this.adminSite(conn, ctx);
      const text = rest.trim();
      if (!text) {
        await reply(
          ctx,
          "Використання: /notify [будинок] текст (HTML) — розсилка в усі чати будинку (без нього — домашнього).",
        );
        return;
      }
      const queued = this.announce(siteBot.site.id, "manual", text);
      await reply(
        ctx,
        siteBot.config.shadow
          ? `🧪 shadow: копія піде лише сюди (${queued}).`
          : `✅ Поставлено в чергу: ${queued}.`,
      );
    });

    // The claim of a hub without a building: the group, then the name.
    bot.on("callback_query:data", async (ctx, next) => {
      const data = ctx.callbackQuery.data;
      const tell = /^tell:([a-z0-9][a-z0-9-]{0,39}):([a-z-]{1,16})$/.exec(data);
      if (!tell) return next();
      // «Дати знати» under an admin alert: the building's owners get the note.
      const target = this.bots.get(tell[1] as string);
      const note = tell[2] as OwnerNote;
      if (!isAdminChat(ctx) || !target || target.conn !== conn || !(note in OWNER_NOTES)) {
        await ctx.answerCallbackQuery().catch(() => {});
        return;
      }
      const sent = this.toOwners(target.site.id, OWNER_NOTES[note](target.site), {
        includeAdmin: true,
      });
      await ctx
        .answerCallbackQuery({ text: sent > 0 ? "Надіслано власнику" : "У хаба немає власника" })
        .catch(() => {});
      if (sent > 0) {
        await ctx
          .editMessageReplyMarkup({
            reply_markup: {
              inline_keyboard: [[{ text: "✓ Власнику надіслано", callback_data: "done" }]],
            },
          })
          .catch(() => {});
      }
    });

    // The claim of a hub without a building: the street, the house (→ its queue), the name.
    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const userId = ctx.from.id;
      const claim = this.pendingClaim(userId);
      const pick = /^(st|hs):(hub-[0-9a-f]{6}):(\d{1,10})$/.exec(data);
      const noName = /^n:(hub-[0-9a-f]{6})$/.exec(data);
      await ctx.answerCallbackQuery().catch(() => {});
      if (!claim) return;
      const edit = (text: string, keyboard?: { text: string; callback_data: string }[][]) =>
        ctx
          .editMessageText(text, {
            ...SEND_OPTIONS,
            ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
          })
          .catch(() => {});
      if (pick && claim.hubId === pick[2]) {
        const id = Number(pick[3]);
        if (pick[1] === "st") {
          const street = claim.streets.find((s) => s.id === id);
          if (!street) return;
          claim.street = street;
          claim.step = "house";
          await edit(claimHouseText(street.name));
          return;
        }
        const house = claim.houses.find((h) => h.id === id);
        if (!house || !claim.street) return;
        const group = await this.deps.addresses?.group(claim.street.id, house.id);
        if (!group) {
          await edit(CLAIM_NO_GROUP_TEXT);
          return;
        }
        claim.address = {
          streetId: claim.street.id,
          houseId: house.id,
          text: `${claim.street.name}, ${house.name}`,
        };
        claim.group = group;
        claim.step = "name";
        await edit(claimNameText(group, claim.address.text), [
          [{ text: `Без назви: «${DEFAULT_HOUSE_NAME}»`, callback_data: `n:${claim.hubId}` }],
        ]);
        return;
      }
      if (noName && claim.hubId === noName[1] && claim.group) {
        await this.finishClaim(conn, ctx, userId, claim, DEFAULT_HOUSE_NAME);
      }
    });

    // What a person in the middle of a claim types: the street, the house number, the name.
    bot.on("message:text", async (ctx, next) => {
      const claim = ctx.chat.type === "private" ? this.pendingClaim(ctx.from.id) : null;
      const text = ctx.message.text;
      if (!claim || text.startsWith("/")) return next();
      const addresses = this.deps.addresses;
      const buttons = (items: AddressItem[], kind: string) =>
        items.map((item) => [
          { text: item.name, callback_data: `${kind}:${claim.hubId}:${item.id}` },
        ]);
      if (claim.step === "street" && addresses) {
        const streets = (await addresses.streets(text).catch(() => [])).slice(0, OFFER_STREETS);
        claim.streets = streets;
        if (streets.length === 0) {
          await reply(ctx, CLAIM_NO_STREET_TEXT);
          return;
        }
        await reply(ctx, "Оберіть вулицю:", {
          reply_markup: { inline_keyboard: buttons(streets, "st") },
        });
        return;
      }
      if (claim.step === "house" && addresses && claim.street) {
        const houses = (await addresses.houses(claim.street.id, text).catch(() => [])).slice(
          0,
          OFFER_HOUSES,
        );
        claim.houses = houses;
        if (houses.length === 0) {
          await reply(ctx, CLAIM_NO_HOUSE_TEXT);
          return;
        }
        await reply(ctx, "Оберіть будинок:", {
          reply_markup: { inline_keyboard: buttons(houses, "hs") },
        });
        return;
      }
      if (claim.step !== "name" || !claim.group) return next();
      const name = cleanName(text);
      if (!name) return next();
      await this.finishClaim(conn, ctx, ctx.from.id, claim, name);
    });

    bot.catch((err) => {
      this.deps.log.error(
        { site: this.home(conn).site.id, err: err.error },
        "telegram update failed",
      );
    });
  }

  private pendingClaim(userId: number): PendingClaim | null {
    const claim = this.pending.get(userId);
    if (!claim) return null;
    if (claim.until > this.deps.clock.now()) return claim;
    this.pending.delete(userId);
    return null;
  }

  /** /start own-<hub>-<code>: the sticker's QR. */
  private async onClaim(conn: BotConn, ctx: Context, payload: string): Promise<void> {
    const reply = (text: string, extra: object = {}) =>
      ctx.reply(text, { ...SEND_OPTIONS, ...extra });
    const ownership = this.deps.ownership?.();
    if (!ownership) return;
    if (ctx.chat?.type !== "private" || !ctx.from) {
      await reply(CLAIM_PRIVATE_TEXT);
      return;
    }
    const result = ownership.claim(payload, ctx.from.id);
    switch (result.kind) {
      case "bad-code":
        await reply(CLAIM_BAD_CODE_TEXT);
        return;
      case "taken":
        await reply(CLAIM_TAKEN_TEXT);
        return;
      case "mine":
        if (result.site) await this.welcomeOwner(conn, ctx, result.site, result.hubId);
        else await this.askAddress(ctx, result.hubId);
        return;
      case "claimed":
        this.alert(
          result.site.id,
          `🔑 ${result.hubId}: новий власник ${describeSender(ctx)} («${escapeHtml(result.site.name)}»)`,
          { silent: true },
        );
        await this.welcomeOwner(conn, ctx, result.site, result.hubId);
        return;
      case "needs-building":
        await this.askAddress(ctx, result.hubId);
        return;
    }
  }

  /** A hub without a building: its address gives the queue (YASNO), then the name. */
  private async askAddress(ctx: Context, hubId: string): Promise<void> {
    const userId = ctx.from?.id as number;
    this.pending.set(userId, {
      hubId,
      step: "street",
      streets: [],
      houses: [],
      street: null,
      address: null,
      group: null,
      until: this.deps.clock.now() + CLAIM_TTL_MS,
    });
    await ctx.reply(claimStreetText(hubId), SEND_OPTIONS);
  }

  private async finishClaim(
    conn: BotConn,
    ctx: Context,
    userId: number,
    claim: PendingClaim,
    name: string,
  ): Promise<void> {
    this.pending.delete(userId);
    const site = this.deps.ownership?.()?.createBuilding(claim.hubId, userId, {
      name,
      feed: YASNO_FEEDS[0],
      group: claim.group as string,
    });
    if (!site) {
      await ctx.reply(CLAIM_FAILED_TEXT, SEND_OPTIONS);
      return;
    }
    // The address gave the queue; it is the admin's to give a building in the search, not the owner's.
    const where = claim.address ? `${escapeHtml(claim.address.text)}, ` : "";
    this.alert(
      site.id,
      `🏠 ${claim.hubId}: новий будинок «${escapeHtml(site.name)}» (${site.id}, ${where}черга ${site.yasno.group}), власник ${describeSender(ctx)}`,
      { silent: true },
    );
    await this.welcomeOwner(conn, ctx, site, claim.hubId);
  }

  /** The owner follows the building in their private chat; buttons: «Мої будинки», the group. */
  private async welcomeOwner(
    conn: BotConn,
    ctx: Context,
    site: SiteConfig,
    hubId: string,
  ): Promise<void> {
    const { store, clock } = this.deps;
    const userId = ctx.from?.id as number;
    store.telegram.follow(site.id, userId, 0, clock.now());
    store.telegramUsers.setSite(userId, site.id, clock.now());
    const username = conn.bot.isInited() ? conn.bot.botInfo.username : null;
    const webApp = site.telegram?.webApp ?? this.home(conn).config.webApp;
    const keyboard = [
      ...(webApp
        ? [[{ text: "Мої будинки", web_app: { url: `${webApp.url.replace(/\/+$/, "")}/my` } }]]
        : []),
      ...(username
        ? [
            [
              {
                text: "Додати бота в чат будинку",
                url: `https://t.me/${username}?startgroup=${site.id}`,
              },
            ],
          ]
        : []),
    ];
    await ctx.reply(ownerWelcomeText(site, hubId), {
      ...SEND_OPTIONS,
      ...(keyboard.length > 0 ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }

  /** Webhook endpoint (`/telegram/<the bot's home building>`). The update is handled in the background. */
  registerRoutes(app: FastifyInstance): void {
    if (this.deps.updates !== "webhook") return;
    app.post<{ Params: { siteId: string } }>("/telegram/:siteId", async (request, reply) => {
      const siteBot = this.bots.get(request.params.siteId);
      const conn = siteBot?.conn;
      if (!conn?.receiving || this.home(conn).site.id !== request.params.siteId) {
        return reply.code(404).send();
      }
      const header = request.headers["x-telegram-bot-api-secret-token"];
      if (typeof header !== "string" || !safeEqual(header, conn.secret)) {
        return reply.code(401).send();
      }
      if (!conn.ready) return reply.code(503).send();
      void conn.bot.handleUpdate(request.body as Update).catch((err: unknown) => {
        this.deps.log.error({ site: request.params.siteId, err }, "telegram update failed");
      });
      return reply.code(200).send();
    });
  }

  /** Connect bots in the background: getMe, commands menu, webhook or polling. Never blocks. */
  start(): void {
    this.started = true;
    this.stopped = false;
    const { clock, outbox } = this.deps;
    this.holdUntil = clock.now() + SEND_HOLD_MAX_MS;
    clock.clearTimer(this.holdTimer);
    this.holdTimer = clock.setTimer(this.holdUntil, () => {
      this.holdTimer = null;
      outbox.resume();
    });
    for (const conn of this.conns.values()) void this.connect(conn);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.deps.clock.clearTimer(this.holdTimer);
    this.holdTimer = null;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    const cleanups = [...this.cleanups].map(([timer, run]) => {
      clearTimeout(timer);
      return run();
    });
    this.cleanups.clear();
    if (cleanups.length > 0) {
      await Promise.race([
        Promise.all(cleanups),
        new Promise((resolve) => setTimeout(resolve, CLEANUP_ON_STOP_MS)),
      ]);
    }
    await Promise.all(
      [...this.conns.values()].filter((c) => c.polling).map((c) => c.bot.stop().catch(() => {})),
    );
  }

  private async connect(conn: BotConn): Promise<void> {
    if (this.stopped) return;
    const { bot } = conn;
    const { site, config } = this.home(conn);
    const { log, updates, publicUrl } = this.deps;
    try {
      if (!bot.isInited()) await bot.init();
      conn.ready = true;
      if (!conn.receiving || updates === "off") {
        log.info({ site: site.id, bot: bot.botInfo.username }, "telegram bot ready (send only)");
        this.markConnected(conn);
        return;
      }
      await bot.api.setMyCommands(COMMANDS);
      if (config.webApp) {
        await bot.api.setChatMenuButton({
          menu_button: {
            type: "web_app",
            text: config.webApp.text,
            web_app: { url: config.webApp.url },
          },
        });
      }
      if (updates === "webhook" && publicUrl) {
        await bot.api.setWebhook(`${publicUrl.replace(/\/$/, "")}/telegram/${site.id}`, {
          secret_token: conn.secret,
          allowed_updates: ALLOWED_UPDATES,
        });
        log.info(
          { site: site.id, sites: conn.siteIds.length, bot: bot.botInfo.username },
          "telegram webhook set",
        );
      } else if (updates === "polling") {
        conn.polling = true;
        void bot
          .start({ allowed_updates: ALLOWED_UPDATES, drop_pending_updates: true })
          .catch((err: unknown) => {
            conn.polling = false;
            log.error({ site: site.id, err }, "telegram polling stopped");
            this.retry(conn);
          });
        log.info({ site: site.id, bot: bot.botInfo.username }, "telegram polling started");
      }
      this.markConnected(conn);
    } catch (err) {
      log.warn({ site: site.id, err: String(err) }, "telegram bot not connected, retrying in 30 s");
      this.retry(conn);
    }
  }

  private markConnected(conn: BotConn): void {
    if (conn.connected) return;
    conn.connected = true;
    this.deps.outbox.resume();
  }

  /** Run a cleanup later (or at once on stop). */
  private later(run: () => Promise<unknown>, ms: number): void {
    const timer = setTimeout(() => {
      this.cleanups.delete(timer);
      void run();
    }, ms);
    this.cleanups.set(timer, run);
  }

  private retry(conn: BotConn): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.connect(conn);
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
