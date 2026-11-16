/**
 * Site configuration (config/sites.yaml): locations, Yasno group, devices.
 * Secrets never live in the file — a device names the environment variable holding its key.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_DETECTOR_CONFIG, type DetectorConfig, KYIV_TZ } from "@svitlo/domain";
import { parse } from "yaml";
import { z } from "zod";

const espDevice = z.object({
  id: z.string().min(1),
  kind: z.literal("esp"),
  /** udp: signed v2 packets; http: POST /iot/ping with X-Signature (light_bot_tg firmware). */
  transport: z.enum(["udp", "http"]),
  secretEnv: z.string().min(1),
  /** UDP only, migration: accept unsigned legacy {"ping": uptime} packets from these addresses. */
  legacyIps: z.array(z.string()).default([]),
});

const plugDevice = z.object({
  id: z.string().min(1),
  kind: z.literal("plug"),
  /** friendly_name in zigbee2mqtt. */
  zigbeeName: z.string().min(1),
});

/** Hub: ESP32-C6 with its own Zigbee plug, reports to POST /iot/hub (docs/hub-protocol.md). */
const hubDevice = z.object({
  id: z.string().min(1),
  kind: z.literal("hub"),
  secretEnv: z.string().min(1),
  /** No report from the hub this long → admin alert (on a UPS its silence is not an outage). */
  silentAlertMs: z
    .number()
    .int()
    .positive()
    .default(2 * 60_000),
  /**
   * Updates over the air: "latest" (the newest released `hub-v*`, upgrades only), a pinned
   * "x.y.z" (also a downgrade) or "off".
   */
  firmware: z
    .union([z.literal("latest"), z.literal("off"), z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/)])
    .default("latest"),
});

/** What a site announces to its chats ("manual" = /notify). */
const announceKind = z.enum(["power", "false-alarm", "schedule", "voltage", "manual"]);

const detectorOverrides = z
  .object({
    suspectAfterMs: z.number().int().positive(),
    probeTimeoutMs: z.number().int().positive(),
    probeAttempts: z.number().int().positive(),
    reprobeIntervalMs: z.number().int().positive(),
    plugKeepaliveMs: z.number().int().positive(),
    zigbeeStaleMs: z.number().int().positive(),
    espOnlyOffAfterMs: z.number().int().positive(),
    noVoltageMax: z.number(),
    uptimeToleranceMs: z.number().int().positive(),
  })
  .partial();

/** "chatId" or "chatId_threadId" (forum topic), as in the legacy ALERT_CHAT_ID. */
const chatTarget = z.string().regex(/^-?\d+(_\d+)?$/, 'chat id or "chatId_threadId"');

const telegramSchema = z.object({
  /** Env variable with the bot token. Sites may share a bot or use their own. */
  botTokenEnv: z.string().min(1),
  /** Chats (and forum topics) where announcements go. */
  chats: z.array(chatTarget).default([]),
  /** Commands here are ignored and deleted. */
  blockedChats: z.array(chatTarget).default([]),
  /** Messages from non-admins are deleted here (announcement-only topics). */
  silentChats: z.array(chatTarget).default([]),
  /** Admin chat: alerts, /status log, admin commands. */
  adminChatId: z.number().int().optional(),
  logStatusRequests: z.boolean().default(true),
  /**
   * Shadow mode (default): announcements go only to the admin chat, marked and with measured
   * latency, while the legacy bots still serve users. Set false to switch over.
   */
  shadow: z.boolean().default(true),
  /**
   * Receive updates (commands, moderation). false = send only, e.g. a bot shared with a legacy app.
   * Sites on one bot share it: a chat's commands answer for the building it follows.
   */
  commands: z.boolean().default(true),
  /** Only these kinds of announcements (default: all). A test site: ["power", "voltage"]. */
  announce: z.array(announceKind).optional(),
  /** The web app as a Telegram Mini App: the menu button by the input field opens it. */
  webApp: z
    .object({ url: z.url(), text: z.string().min(1).max(64).default("Відкрити") })
    .optional(),
});

/** Paths of the site that cannot be building addresses (svitlo4u.info/<id>). */
export const RESERVED_SITE_IDS: readonly string[] = [
  "api",
  "assets",
  "health",
  "iot",
  "my",
  "render",
  "telegram",
];

export const SITE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const siteSchema = z.object({
  id: z
    .string()
    .regex(SITE_ID, "lowercase letters, digits and dashes")
    .refine((id) => !RESERVED_SITE_IDS.includes(id), "reserved word"),
  name: z.string().min(1),
  tz: z.string().default(KYIV_TZ),
  /** Domain used in links inside texts. */
  linkUrl: z.url().default("https://svitlo4u.info"),
  /** "public": listed on the site; "link": only by its address (svitlo4u.info/<id>). */
  access: z.enum(["public", "link"]).default("public"),
  /** The picture on the main screen: the 3D figure of ЖК 4U, or none. */
  scene: z.enum(["4u", "none"]).default("none"),
  yasno: z.object({ region: z.number().int(), dso: z.number().int(), group: z.string().min(1) }),
  devices: z.array(z.discriminatedUnion("kind", [espDevice, plugDevice, hubDevice])).min(1),
  detector: detectorOverrides.default({}),
  telegram: telegramSchema.optional(),
});

const fileSchema = z.object({ sites: z.array(siteSchema).min(1) });

export type EspDeviceConfig = z.infer<typeof espDevice> & { siteId: string; secret: string };
export type PlugDeviceConfig = z.infer<typeof plugDevice> & { siteId: string };
export type HubDeviceConfig = z.infer<typeof hubDevice> & { siteId: string; secret: string };
export type AnnounceKind = z.infer<typeof announceKind>;
export type ChatTarget = { chatId: number; threadId: number | null };
export type TelegramSiteConfig = Omit<
  z.infer<typeof telegramSchema>,
  "chats" | "blockedChats" | "silentChats"
> & {
  botToken: string;
  chats: ChatTarget[];
  blockedChats: ChatTarget[];
  silentChats: ChatTarget[];
};
export type SiteAccess = "public" | "link";
export type SiteConfig = Omit<z.infer<typeof siteSchema>, "devices" | "detector" | "telegram"> & {
  /** "config": from sites.yaml; "owner": created by a hub's owner in the bot (kept in the DB). */
  origin: "config" | "owner";
  esp: EspDeviceConfig[];
  plug: PlugDeviceConfig | null;
  /** A hub site has its hub instead of ESP devices and a zigbee2mqtt plug. */
  hub: HubDeviceConfig | null;
  detector: DetectorConfig;
  telegram: TelegramSiteConfig | null;
};

export function parseChatTarget(value: string): ChatTarget {
  const at = value.lastIndexOf("_");
  return at > 0
    ? { chatId: Number(value.slice(0, at)), threadId: Number(value.slice(at + 1)) }
    : { chatId: Number(value), threadId: null };
}

export function parseSitesConfig(text: string, env: NodeJS.ProcessEnv = process.env): SiteConfig[] {
  const parsed = fileSchema.safeParse(parse(text));
  if (!parsed.success) throw new Error(`sites config: ${z.prettifyError(parsed.error)}`);

  const ids = new Set<string>();
  const deviceIds = new Set<string>();
  return parsed.data.sites.map((site) => {
    if (ids.has(site.id)) throw new Error(`sites config: duplicate site id "${site.id}"`);
    ids.add(site.id);
    for (const d of site.devices) {
      if (deviceIds.has(d.id)) throw new Error(`sites config: duplicate device id "${d.id}"`);
      deviceIds.add(d.id);
    }
    const esp = site.devices
      .filter((d) => d.kind === "esp")
      .map((d) => {
        const secret = env[d.secretEnv];
        if (!secret)
          throw new Error(`sites config: env ${d.secretEnv} (secret of ${d.id}) is not set`);
        return { ...d, siteId: site.id, secret };
      });
    const plugs = site.devices.filter((d) => d.kind === "plug");
    if (plugs.length > 1) throw new Error(`sites config: site "${site.id}" has more than one plug`);
    const hubs = site.devices
      .filter((d) => d.kind === "hub")
      .map((d) => {
        const secret = env[d.secretEnv];
        if (!secret)
          throw new Error(`sites config: env ${d.secretEnv} (secret of ${d.id}) is not set`);
        return { ...d, siteId: site.id, secret };
      });
    if (hubs.length > 1) throw new Error(`sites config: site "${site.id}" has more than one hub`);
    const hub = hubs[0] ?? null;
    if (hub && (esp.length > 0 || plugs.length > 0))
      throw new Error(`sites config: site "${site.id}" mixes a hub with esp/plug devices`);
    if (esp.length === 0 && !hub)
      throw new Error(`sites config: site "${site.id}" needs an esp or a hub device`);
    const plug = plugs[0] ? { ...plugs[0], siteId: site.id } : null;
    let telegram: TelegramSiteConfig | null = null;
    if (site.telegram) {
      const botToken = env[site.telegram.botTokenEnv];
      if (!botToken)
        throw new Error(
          `sites config: env ${site.telegram.botTokenEnv} (bot of ${site.id}) is not set`,
        );
      telegram = {
        ...site.telegram,
        botToken,
        chats: site.telegram.chats.map(parseChatTarget),
        blockedChats: site.telegram.blockedChats.map(parseChatTarget),
        silentChats: site.telegram.silentChats.map(parseChatTarget),
      };
    }
    const { devices: _devices, detector, telegram: _telegram, ...rest } = site;
    return {
      ...rest,
      origin: "config" as const,
      esp,
      plug,
      hub,
      detector: { ...DEFAULT_DETECTOR_CONFIG, ...detector, zigbee: plug !== null },
      telegram,
    };
  });
}

/** The building's row as the DB keeps it (origin "owner"). */
export type OwnerSiteRow = {
  id: string;
  name: string;
  tz: string;
  yasnoRegion: number;
  yasnoDso: number;
  yasnoGroup: string;
  access: string;
};

/**
 * A building its owner created in the bot: served by the home site's bot (announcements to its
 * subscribers, no shadow), its hub reports like any other.
 */
export function ownerSiteConfig(
  row: OwnerSiteRow,
  hub: HubDeviceConfig | null,
  home: SiteConfig | undefined,
): SiteConfig {
  const bot = home?.telegram;
  return {
    id: row.id,
    name: row.name,
    tz: row.tz,
    linkUrl: home?.linkUrl ?? "https://svitlo4u.info",
    access: row.access === "public" ? "public" : "link",
    scene: "none",
    yasno: { region: row.yasnoRegion, dso: row.yasnoDso, group: row.yasnoGroup },
    origin: "owner",
    esp: [],
    plug: null,
    hub: hub ? { ...hub, siteId: row.id } : null,
    detector: { ...DEFAULT_DETECTOR_CONFIG, zigbee: false },
    telegram: bot
      ? {
          botTokenEnv: bot.botTokenEnv,
          botToken: bot.botToken,
          chats: [],
          blockedChats: [],
          silentChats: [],
          ...(bot.adminChatId !== undefined ? { adminChatId: bot.adminChatId } : {}),
          logStatusRequests: false,
          shadow: false,
          commands: bot.commands,
          ...(bot.webApp ? { webApp: bot.webApp } : {}),
        }
      : null,
  };
}

/** The building new visitors see: the first public one in sites.yaml (ЖК 4U). */
export function defaultSite(sites: readonly SiteConfig[]): SiteConfig | undefined {
  return sites.find((s) => s.access === "public" && s.origin === "config") ?? sites[0];
}

export function loadSitesConfig(path: string, env: NodeJS.ProcessEnv = process.env): SiteConfig[] {
  return parseSitesConfig(readFileSync(path, "utf8"), env);
}
