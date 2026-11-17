/**
 * Hub owners and their buildings.
 *
 * A hub made at the bench (`cli/hub.ts new`) has an id and a secret, no building and no owner. Its
 * sticker carries a QR with `t.me/<bot>?start=own-<hub id>-<code>`, the code derived from the
 * secret, so only who holds the hub can claim it. The first scan makes the person the owner and,
 * with their Yasno group and a name, creates the building (address svitlo4u.info/b-…, only by
 * link). The owner gets the hub's service alerts and «Мої будинки» in the Mini App; releasing the hub
 * lets the next person with the sticker take it (with the building and its history).
 */
import { createHmac, randomBytes } from "node:crypto";
import { KYIV_TZ } from "@svitlo/domain";
import type { HubRow, Store } from "@svitlo/storage";
import type { HubStatus, OwnedBuilding, OwnedChat } from "../api/me-view.ts";
import type { Clock } from "../runtime/clock.ts";
import {
  defaultSite,
  type HubDeviceConfig,
  ownerSiteConfig,
  type SiteConfig,
} from "../sites-config.ts";

/** Yasno feeds a new building may follow (Kyiv for now). */
export const YASNO_FEEDS = [{ key: "kyiv", name: "Київ", region: 25, dso: 902 }] as const;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const CLAIM = /^own-(hub-[0-9a-f]{6})-([a-z2-7]{10})$/;
export const NAME_MAX = 60;

function base32(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) out += BASE32[(bytes[i % bytes.length] as number) % 32];
  return out;
}

/** The sticker's code: derived from the hub's secret, so the core and the hub agree on it. */
export function claimCode(secret: string): string {
  return base32(createHmac("sha256", secret).update("svitlo4u-claim").digest(), 10);
}

export function claimPayload(hubId: string, secret: string): string {
  return `own-${hubId}-${claimCode(secret)}`;
}

export function parseClaim(payload: string): { hubId: string; code: string } | null {
  const m = CLAIM.exec(payload);
  return m ? { hubId: m[1] as string, code: m[2] as string } : null;
}

/** "Мій дім", trimmed, no line breaks, at most NAME_MAX characters; null when nothing is left. */
export function cleanName(text: string): string | null {
  const name = [...text]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch === "\u007f" || ch === "<" || ch === ">" ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return name ? [...name].slice(0, NAME_MAX).join("") : null;
}

export type { HubStatus, OwnedBuilding };

export const NO_STATUS: HubStatus = {
  lastReportAt: null,
  fw: null,
  paired: null,
  mains: null,
  voltage: null,
  linkGaps: null,
  alertDelay: null,
  rssi: null,
};

export type ClaimResult =
  | { kind: "bad-code" }
  | { kind: "taken" }
  | { kind: "mine"; hubId: string; site: SiteConfig | null }
  | { kind: "claimed"; hubId: string; site: SiteConfig }
  | { kind: "needs-building"; hubId: string };

export type OwnershipDeps = {
  store: Store;
  clock: Clock;
  /** The live list of buildings (sites.yaml first, then the owners'). */
  sites: () => readonly SiteConfig[];
  /** Hubs from sites.yaml (their secrets come from the environment). */
  configHubs: readonly HubDeviceConfig[];
  /** Start serving a new building (state, schedules, its hub, the bot). */
  addSite: (site: SiteConfig) => void;
  /** A hub got its building: reports drive it from now on. */
  hubReady: (device: HubDeviceConfig) => void;
  status: (siteId: string) => HubStatus;
  /** The light at a building now. */
  light: (siteId: string) => { power: "on" | "off" | "unknown"; since: number | null };
};

export class HubOwnership {
  private readonly deps: OwnershipDeps;

  constructor(deps: OwnershipDeps) {
    this.deps = deps;
    // sites.yaml hubs get a row too: their owner lives there.
    for (const hub of deps.configHubs) deps.store.hubs.ensure(hub.id, hub.siteId, deps.clock.now());
  }

  /** A hub made at the bench: its id, secret and the sticker's /start payload. */
  newHub(): { id: string; secret: string; payload: string } {
    const { store, clock } = this.deps;
    let id: string;
    do id = `hub-${randomBytes(3).toString("hex")}`;
    while (store.hubs.get(id) || this.deps.configHubs.some((h) => h.id === id));
    const secret = randomBytes(32).toString("hex");
    store.hubs.create(id, secret, clock.now());
    return { id, secret, payload: claimPayload(id, secret) };
  }

  /** The secret of any hub (bench hubs: the DB; sites.yaml hubs: the environment). */
  secretOf(hubId: string): string | null {
    const config = this.deps.configHubs.find((h) => h.id === hubId);
    if (config) return config.secret;
    return this.deps.store.hubs.get(hubId)?.secret ?? null;
  }

  /** The device config of a bench hub, for the report verifier ("" = no building yet). */
  benchDevice(hubId: string): HubDeviceConfig | undefined {
    const row = this.deps.store.hubs.get(hubId);
    if (!row?.secret) return undefined;
    return deviceOf(row);
  }

  /** The bench hubs that already have a building (served from the start). */
  benchSites(): { row: HubRow; device: HubDeviceConfig }[] {
    return this.deps.store.hubs
      .listWithSecret()
      .filter((row) => row.siteId)
      .map((row) => ({ row, device: deviceOf(row) }));
  }

  /** A scan of the sticker by `userId`. */
  claim(payload: string, userId: number): ClaimResult {
    const parsed = parseClaim(payload);
    const secret = parsed ? this.secretOf(parsed.hubId) : null;
    if (!parsed || !secret || claimCode(secret) !== parsed.code) return { kind: "bad-code" };
    const { store, clock } = this.deps;
    const row = store.hubs.get(parsed.hubId);
    if (!row) return { kind: "bad-code" };
    const site = row.siteId ? this.site(row.siteId) : null;
    if (row.ownerUserId === userId) return { kind: "mine", hubId: row.id, site };
    if (row.ownerUserId !== null) return { kind: "taken" };
    if (!site) return { kind: "needs-building", hubId: row.id };
    store.hubs.claim(row.id, userId, null, clock.now());
    return { kind: "claimed", hubId: row.id, site };
  }

  /** The owner of a hub without a building names it and picks the Yasno group. */
  createBuilding(
    hubId: string,
    userId: number,
    building: { name: string; feed: (typeof YASNO_FEEDS)[number]; group: string },
  ): SiteConfig | null {
    const { store, clock } = this.deps;
    const row = store.hubs.get(hubId);
    if (!row?.secret || row.siteId || (row.ownerUserId !== null && row.ownerUserId !== userId))
      return null;
    if (!/^\d{1,3}\.\d$/.test(building.group)) return null;
    let id: string;
    do id = `b-${base32(randomBytes(10), 10)}`;
    while (store.sites.get(id));
    const now = clock.now();
    const siteRow = {
      id,
      name: building.name,
      tz: KYIV_TZ,
      yasnoRegion: building.feed.region,
      yasnoDso: building.feed.dso,
      yasnoGroup: building.group,
      access: "link",
      origin: "owner",
    };
    store.sites.upsert(siteRow, now);
    store.hubs.claim(hubId, userId, id, now);
    const device = deviceOf({ ...row, siteId: id });
    const site = ownerSiteConfig(siteRow, device, defaultSite(this.deps.sites()));
    this.deps.addSite(site);
    this.deps.hubReady(device);
    return site;
  }

  /** The buildings created by owners, as configs (at the start). */
  ownerSites(): SiteConfig[] {
    const home = defaultSite(this.deps.sites());
    const bench = new Map(this.benchSites().map((b) => [b.row.siteId, b.device]));
    return this.deps.store.sites
      .listOwned()
      .map((row) => ownerSiteConfig(row, bench.get(row.id) ?? null, home));
  }

  /** «Мої будинки»: the buildings a person owns, with their hub there and their chats. */
  buildingsOf(userId: number): OwnedBuilding[] {
    const hubs = this.deps.store.hubs.listByOwner(userId);
    return this.sitesOwnedBy(userId).flatMap((siteId) => {
      const site = this.site(siteId);
      if (!site) return [];
      const hub = hubs.find((row) => row.siteId === siteId);
      return [
        {
          site: {
            id: site.id,
            name: site.name,
            access: site.access,
            renamable: site.origin === "owner" && hub !== undefined,
          },
          ...this.deps.light(site.id),
          hub: hub ? { id: hub.id, status: this.deps.status(site.id) } : null,
          chats: this.chatsOf(site.id),
        },
      ];
    });
  }

  /** The groups (topics) and channels that follow a building — not people's private chats. */
  chatsOf(siteId: string): OwnedChat[] {
    const { store } = this.deps;
    const config = this.site(siteId)?.telegram;
    const followed = store.telegram.list(siteId).filter((row) => row.chatId < 0);
    // Chats named in sites.yaml (ЖК 4U's group topics): shown as they are, not changed here.
    const fixed = (config?.chats ?? [])
      .filter((t) => t.chatId < 0)
      .filter(
        (t) => !followed.some((r) => r.chatId === t.chatId && r.threadId === (t.threadId ?? 0)),
      )
      .map((t) => {
        const chat = store.telegramChats.get(t.chatId);
        return {
          chatId: t.chatId,
          threadId: t.threadId ?? 0,
          kind: chat?.type === "channel" ? "channel" : "group",
          title: chat?.title ?? null,
          feed: (config?.silentChats ?? []).some(
            (s) => s.chatId === t.chatId && s.threadId === t.threadId,
          ),
          bot: "ok",
          fixed: true,
        } satisfies OwnedChat;
      });
    return [
      ...fixed,
      ...followed.map((row) => {
        const chat = store.telegramChats.get(row.chatId);
        const kind = chat?.type === "channel" ? "channel" : "group";
        const bot =
          kind === "channel"
            ? chat && !chat.canPost
              ? "no-post"
              : "ok"
            : row.readOnly && chat && !chat.canDelete
              ? "no-delete"
              : "ok";
        return {
          chatId: row.chatId,
          threadId: row.threadId,
          kind,
          title: chat?.title ?? null,
          feed: row.readOnly,
          bot,
          fixed: false,
        } satisfies OwnedChat;
      }),
    ];
  }

  /** The building of a person's chat (topic), if they own it; null for anyone else. */
  ownedFollow(userId: number, chatId: number, threadId: number): string | null {
    const owned = this.sitesOwnedBy(userId);
    return (
      this.deps.store.telegram
        .ofChat(chatId)
        .find((row) => row.threadId === threadId && owned.includes(row.siteId))?.siteId ?? null
    );
  }

  /** The buildings a person owns: named in sites.yaml (`owners`) first, then those of their hubs. */
  sitesOwnedBy(userId: number): string[] {
    return [
      ...new Set([
        ...this.deps
          .sites()
          .filter((s) => s.owners.includes(userId))
          .map((s) => s.id),
        ...this.deps.store.hubs
          .listByOwner(userId)
          .flatMap((row) => (row.siteId && this.site(row.siteId) ? [row.siteId] : [])),
      ]),
    ];
  }

  /** The building a person's channel should follow: the one they chose, if theirs, else their first. */
  buildingOf(userId: number): string | null {
    const owned = this.sitesOwnedBy(userId);
    const chosen = this.deps.store.telegramUsers.site(userId);
    return chosen && owned.includes(chosen) ? chosen : (owned[0] ?? null);
  }

  /** The building's owners: of its hubs and in sites.yaml (its hub's service news go to them). */
  ownersOf(siteId: string): number[] {
    const owners = new Set<number>(this.site(siteId)?.owners ?? []);
    for (const hub of [...this.deps.configHubs, ...this.benchSites().map((b) => b.device)]) {
      if (hub.siteId !== siteId) continue;
      const owner = this.deps.store.hubs.get(hub.id)?.ownerUserId;
      if (owner !== null && owner !== undefined) owners.add(owner);
    }
    return [...owners];
  }

  rename(userId: number, hubId: string, name: string): SiteConfig | null {
    const row = this.deps.store.hubs.get(hubId);
    const site = row?.siteId ? this.site(row.siteId) : null;
    if (!row || row.ownerUserId !== userId || !site || site.origin !== "owner") return null;
    this.deps.store.sites.rename(site.id, name, this.deps.clock.now());
    (site as { name: string }).name = name;
    return site;
  }

  /** The owner lets the hub go: the next scan of its sticker takes it, with the building. */
  release(userId: number, hubId: string): boolean {
    const row = this.deps.store.hubs.get(hubId);
    if (!row || row.ownerUserId !== userId) return false;
    this.deps.store.hubs.setOwner(hubId, null, this.deps.clock.now());
    return true;
  }

  private site(siteId: string): SiteConfig | null {
    return this.deps.sites().find((s) => s.id === siteId) ?? null;
  }
}

function deviceOf(row: HubRow): HubDeviceConfig {
  return {
    id: row.id,
    kind: "hub",
    secretEnv: "",
    silentAlertMs: 2 * 60_000,
    firmware: row.firmware,
    siteId: row.siteId ?? "",
    secret: row.secret as string,
  };
}
