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
  /** Receive updates (commands, moderation). false = send only, e.g. a bot shared with a legacy app. */
  commands: z.boolean().default(true),
  /** The web app as a Telegram Mini App: the menu button by the input field opens it. */
  webApp: z
    .object({ url: z.url(), text: z.string().min(1).max(64).default("Відкрити") })
    .optional(),
});

const siteSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, digits and dashes"),
  name: z.string().min(1),
  tz: z.string().default(KYIV_TZ),
  /** Domain used in links inside texts. */
  linkUrl: z.url().default("https://svitlo4u.info"),
  yasno: z.object({ region: z.number().int(), dso: z.number().int(), group: z.string().min(1) }),
  devices: z.array(z.discriminatedUnion("kind", [espDevice, plugDevice])).min(1),
  detector: detectorOverrides.default({}),
  telegram: telegramSchema.optional(),
});

const fileSchema = z.object({ sites: z.array(siteSchema).min(1) });

export type EspDeviceConfig = z.infer<typeof espDevice> & { siteId: string; secret: string };
export type PlugDeviceConfig = z.infer<typeof plugDevice> & { siteId: string };
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
export type SiteConfig = Omit<z.infer<typeof siteSchema>, "devices" | "detector" | "telegram"> & {
  esp: EspDeviceConfig[];
  plug: PlugDeviceConfig | null;
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
  const botTokens = new Set<string>();
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
    if (esp.length === 0) throw new Error(`sites config: site "${site.id}" needs an esp device`);
    const plug = plugs[0] ? { ...plugs[0], siteId: site.id } : null;
    let telegram: TelegramSiteConfig | null = null;
    if (site.telegram) {
      const botToken = env[site.telegram.botTokenEnv];
      if (!botToken)
        throw new Error(
          `sites config: env ${site.telegram.botTokenEnv} (bot of ${site.id}) is not set`,
        );
      // One webhook per bot: two sites on one bot would take it from each other.
      if (botTokens.has(botToken))
        throw new Error(`sites config: site "${site.id}" reuses another site's Telegram bot`);
      botTokens.add(botToken);
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
      esp,
      plug,
      detector: { ...DEFAULT_DETECTOR_CONFIG, ...detector, zigbee: plug !== null },
      telegram,
    };
  });
}

export function loadSitesConfig(path: string, env: NodeJS.ProcessEnv = process.env): SiteConfig[] {
  return parseSitesConfig(readFileSync(path, "utf8"), env);
}
