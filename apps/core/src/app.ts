/**
 * Wires the core: database, sites, adapters (UDP/HTTP heartbeat, Zigbee plug, Yasno), services
 * (power, schedules, reminders) and channels (Telegram via the outbox, SSE) around one event bus.
 */
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KYIV_TZ } from "@svitlo/domain";
import { closeDatabase, createStore, openDatabase, type Store } from "@svitlo/storage";
import type { FastifyInstance } from "fastify";
import type { Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { connect, type MqttClient } from "mqtt";
import {
  type HeartbeatEvent,
  HttpHeartbeatVerifier,
  registerIotRoutes,
  startUdpHeartbeat,
  type UdpHeartbeatServer,
  UdpHeartbeatVerifier,
} from "./adapters/heartbeat.ts";
import { HubVerifier, registerHubRoutes } from "./adapters/hub.ts";
import { type MqttLike, type PlugAdapter, startPlugAdapter } from "./adapters/plug.ts";
import { YasnoPoller } from "./adapters/yasno.ts";
import { YasnoAddresses } from "./adapters/yasno-addresses.ts";
import { registerAddresses } from "./api/addresses.ts";
import { registerGame } from "./api/game.ts";
import { registerMe } from "./api/me.ts";
import { RateLimiter, registerApiGuards } from "./api/rate-limit.ts";
import { registerApi } from "./api/routes.ts";
import { Notifier } from "./channels/notifier.ts";
import { type ChannelSender, Outbox } from "./channels/outbox.ts";
import { SseHub } from "./channels/sse.ts";
import { TELEGRAM, TelegramChannel } from "./channels/telegram.ts";
import type { CoreConfig } from "./config.ts";
import { type Bus, EventBus } from "./runtime/bus.ts";
import { type Clock, SystemClock } from "./runtime/clock.ts";
import { buildServer } from "./server.ts";
import { BackupService, loadBackupConfig } from "./services/backup.ts";
import { EveningService, type EveningTimings } from "./services/evenings.ts";
import { FirmwareService, loadFirmwareConfig, registerFirmwareRoute } from "./services/firmware.ts";
import { GameService } from "./services/game.ts";
import { HubPowerService } from "./services/hub-power.ts";
import { ChromiumScheduleImages, type ScheduleImages } from "./services/images.ts";
import { HubOwnership, type HubStatus, NO_STATUS } from "./services/ownership.ts";
import { PowerService } from "./services/power.ts";
import { ReminderService } from "./services/reminders.ts";
import { ScheduleService } from "./services/schedule.ts";
import { SiteStateStore } from "./services/state.ts";
import { VoltageMonitor } from "./services/voltage.ts";
import { NO_WEATHER, WeatherService } from "./services/weather.ts";
import { loadSitesConfig, type SiteConfig } from "./sites-config.ts";

export type CoreDeps = {
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  /** Replace the MQTT connection (tests). */
  mqtt?: MqttLike & { end?: (force?: boolean) => unknown };
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Do not bind a TCP port (tests use app.inject). */
  listen?: boolean;
  /** Tests: answer Telegram Bot API calls without the network. */
  telegram?: {
    transformer: Transformer;
    /** Skip getMe (absent: the bot connects through `transformer` like in production). */
    botInfo?: UserFromGetMe;
    paceMs?: number;
    noticeMs?: number;
  };
  /** Validate every API response against the contract (default: on under Vitest). */
  strictApi?: boolean;
  /** Replace the network of the backup uploads (tests). */
  backupFetch?: (request: Request) => Promise<Response>;
  /** Replace the network of the hub firmware mirror: GitHub and R2 (tests). */
  firmwareFetch?: (request: Request) => Promise<Response>;
  /** Replace the schedule pictures (tests); null turns them off. */
  images?: ScheduleImages | null;
  /** Replace the Bot API calls for the game's avatars (tests). */
  gameFetch?: (url: string) => Promise<Response>;
  /** Shorter clocks for the tables of «Вечорниці» (tests). */
  eveningTimings?: Partial<EveningTimings>;
  /** Replace Open-Meteo (tests); without it tests ask no weather. */
  weatherFetch?: (url: string, init?: RequestInit) => Promise<Response>;
};

export type Core = {
  app: FastifyInstance;
  bus: Bus;
  store: Store;
  state: SiteStateStore;
  sites: SiteConfig[];
  power: Map<string, PowerService>;
  /** Power of hub sites (docs/hub-protocol.md). */
  hubs: Map<string, HubPowerService>;
  /** Hub owners and the buildings they created in the bot. */
  ownership: HubOwnership;
  schedules: ScheduleService;
  pollers: YasnoPoller[];
  udp: UdpHeartbeatServer | null;
  outbox: Outbox;
  telegram: TelegramChannel;
  notifier: Notifier;
  sse: SseHub;
  backup: BackupService | null;
  /** The weather for the snow round the 3D buildings; null when off (WEATHER=off, tests). */
  weather: WeatherService | null;
  /** Hub firmware updates; null without hub sites. */
  firmware: FirmwareService | null;
  stop: () => Promise<void>;
};

export async function startCore(config: CoreConfig, deps: CoreDeps = {}): Promise<Core> {
  const clock = deps.clock ?? new SystemClock();
  const env = deps.env ?? process.env;
  const app = buildServer(config);
  const log = app.log;

  const sites = existsSync(config.sitesPath) ? loadSitesConfig(config.sitesPath, env) : [];
  if (sites.length === 0)
    log.warn({ path: config.sitesPath }, "no sites configured — running without monitoring");

  if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
  const db = openDatabase(config.dbPath);
  const store = createStore(db);
  for (const site of sites) {
    store.sites.upsert({
      id: site.id,
      name: site.name,
      tz: site.tz,
      yasnoRegion: site.yasno.region,
      yasnoDso: site.yasno.dso,
      yasnoGroup: site.yasno.group,
      access: site.access,
      origin: "config",
    });
  }

  // Hub owners and the buildings they created in the bot: served like the configured ones, and a
  // new one joins while the core runs (addSite, set up once the services exist).
  const hubs = new Map<string, HubPowerService>();
  let hubVerifier: HubVerifier | null = null;
  let addSite: (site: SiteConfig) => void = () => {};
  const ownership = new HubOwnership({
    store,
    clock,
    sites: () => sites,
    configHubs: sites.flatMap((s) => (s.hub ? [s.hub] : [])),
    addSite: (site) => addSite(site),
    hubReady: (device) => hubVerifier?.set(device),
    status: (siteId) => hubs.get(siteId)?.status() ?? NO_STATUS,
    light: (siteId) => {
      const now = state.has(siteId) ? state.get(siteId) : null;
      return { power: now?.power ?? "unknown", since: now?.since ?? null };
    },
  });
  sites.push(...ownership.ownerSites());

  // ≈ when the core last ran (the detector state is saved every few seconds, at least once a
  // minute even during an outage).
  const previousRunAt = sites.reduce<number | null>((latest, site) => {
    const savedAt = store.detector.savedAt(site.id);
    return savedAt === null ? latest : Math.max(latest ?? 0, savedAt);
  }, null);

  const bus: Bus = new EventBus((type, err) => log.error({ type, err }, "event handler failed"));
  const state = new SiteStateStore(sites);
  logEvents(bus, log, clock);

  // Channels subscribe before any service starts, so no event is missed.
  const senders = new Map<string, ChannelSender>();
  const pollers: YasnoPoller[] = [];
  let backup: BackupService | null = null;
  const sse = new SseHub({ bus, state, clock });
  const images: ScheduleImages | null =
    deps.images !== undefined
      ? deps.images
      : config.rendererCdpUrl
        ? new ChromiumScheduleImages({
            cdpUrl: config.rendererCdpUrl,
            webUrl: config.renderWebUrl,
            dir: join(config.dbPath === ":memory:" ? tmpdir() : dirname(config.dbPath), "images"),
            log,
          })
        : null;
  let notifier: Notifier | null = null;
  let telegramChannel: TelegramChannel | null = null;
  const outbox = new Outbox({
    store,
    clock,
    senders,
    log,
    // After a start the bot sends once it has set up with Telegram (no repeats into a half-up net).
    ready: (siteId, channel) => channel !== TELEGRAM || (telegramChannel?.canSend(siteId) ?? true),
    onUndelivered: (item, error) => notifier?.onUndelivered(item, error),
    onSent: (item, sentAt) =>
      log.info(
        { id: item.id, kind: item.kind, target: item.target, ms: sentAt - item.createdAt },
        "notification sent",
      ),
  });
  // YASNO's address search («Знайти мій будинок», a claimed hub's queue), the home building's region.
  const home = sites[0];
  const addresses = new YasnoAddresses({
    region: home?.yasno.region ?? 25,
    dso: home?.yasno.dso ?? 902,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    now: () => clock.now(),
  });
  const telegram = new TelegramChannel({
    sites,
    store,
    state,
    clock,
    outbox,
    reports: {
      health: (id) => notifier?.reports.health(id) ?? "",
      stats: (id) => notifier?.reports.stats(id) ?? "",
      hubs: () =>
        hubsReport(store, sites, (id) => hubs.get(id)?.status() ?? NO_STATUS, clock.now()),
    },
    ownership: () => ownership,
    addresses,
    publicUrl: config.publicUrl,
    updates: config.telegramUpdates,
    images,
    log,
    ...(deps.telegram
      ? {
          transformer: deps.telegram.transformer,
          ...(deps.telegram.botInfo ? { botInfo: deps.telegram.botInfo } : {}),
          ...(deps.telegram.paceMs !== undefined ? { paceMs: deps.telegram.paceMs } : {}),
          ...(deps.telegram.noticeMs !== undefined ? { noticeMs: deps.telegram.noticeMs } : {}),
        }
      : {}),
  });
  telegramChannel = telegram;
  senders.set(TELEGRAM, telegram.send);
  const notifierInstance = new Notifier({
    bus,
    telegram,
    state,
    store,
    clock,
    sites,
    version: config.version,
    pollers: () => pollers,
    sseClients: () => sse.count,
    backup: () => backup?.status ?? null,
    images,
    log,
  });
  notifier = notifierInstance;
  // Public API: rate limit + no-store first, then the routes.
  registerApiGuards(
    app,
    new RateLimiter({
      perMinute: config.apiRatePerMinute,
      burst: Math.max(1, Math.ceil(config.apiRatePerMinute / 2)),
      now: () => clock.now(),
    }),
  );
  // The weather in Kyiv (Open-Meteo): while anything falls, the site's 3D buildings are in snow.
  const weatherOn =
    deps.weatherFetch !== undefined ||
    (env.WEATHER ?? (process.env.VITEST ? "off" : "on")) !== "off";
  const weather = weatherOn
    ? new WeatherService({
        clock,
        log,
        ...(deps.weatherFetch ? { fetch: deps.weatherFetch } : {}),
      })
    : null;
  registerApi(app, {
    sites,
    state,
    store,
    clock,
    weather: () => weather?.now() ?? NO_WEATHER,
    strict: deps.strictApi ?? Boolean(process.env.VITEST),
  });
  const game = new GameService({
    sites,
    store,
    clock,
    avatarDir: config.dbPath === ":memory:" ? null : join(dirname(config.dbPath), "avatars"),
    ...(deps.gameFetch ? { fetch: deps.gameFetch } : {}),
    log,
  });
  const evenings = new EveningService({
    store,
    clock,
    game,
    ...(deps.eveningTimings ? { timings: deps.eveningTimings } : {}),
  });
  registerGame(app, game, clock, evenings);
  registerMe(app, {
    sites: () => sites,
    store,
    clock,
    ownership,
    botUsername: () => telegram.botUsername(),
    leaveChat: (siteId, chatId) => telegram.leaveChat(siteId, chatId),
  });
  registerAddresses(app, { addresses, sites: () => sites, store, clock, bus });
  telegram.registerRoutes(app);
  sse.registerRoutes(app);

  // Zigbee plug
  const plugs = sites.flatMap((s) => (s.plug ? [s.plug] : []));
  let mqtt: (MqttLike & { end?: (force?: boolean) => unknown }) | null = null;
  let plugAdapter: PlugAdapter | null = null;
  const power = new Map<string, PowerService>();
  if (plugs.length > 0 && (deps.mqtt || (config.mqttUrl && config.mqttPassword))) {
    mqtt =
      deps.mqtt ??
      (connect(config.mqttUrl as string, {
        username: config.mqttUser,
        password: config.mqttPassword as string,
        reconnectPeriod: 2_000,
      }) as MqttClient);
    plugAdapter = startPlugAdapter({
      client: mqtt,
      plugs,
      now: () => clock.now(),
      onPlug: (event) => power.get(event.siteId)?.onPlug(event),
      onBridgeState: (online) => bus.emit("zigbee.bridge", { online }),
    });
    // The broker gone means zigbee2mqtt is gone for us too (its "offline" never reaches us).
    let mqttConnected = false;
    mqtt.on("connect", () => {
      mqttConnected = true;
    });
    mqtt.on("close", () => {
      if (!mqttConnected) return;
      mqttConnected = false;
      bus.emit("zigbee.bridge", { online: false });
    });
    notifierInstance.watchZigbee(plugs.map((p) => p.siteId));
  } else if (plugs.length > 0) {
    log.warn(
      "plugs configured but MQTT_URL / MQTT_CORE_PASSWORD missing — plug confirmation disabled",
    );
  }

  for (const site of sites) {
    if (site.hub) {
      hubs.set(site.id, new HubPowerService({ site, hub: site.hub, store, bus, clock, state }));
      continue;
    }
    const service = new PowerService({
      site,
      store,
      bus,
      clock,
      state,
      probe: (siteId) => plugAdapter?.probe(siteId) ?? false,
    });
    power.set(site.id, service);
  }

  const schedules = new ScheduleService({ sites, store, bus, clock, state });
  schedules.hydrate();
  const reminders = sites.map((site) => new ReminderService({ site, store, bus, clock, state }));
  const voltage = sites
    .filter((site) => site.plug)
    .map(
      (site) =>
        new VoltageMonitor({
          siteId: site.id,
          bus,
          clock,
          read: () => plugAdapter?.probe(site.id),
        }),
    );

  // ESP heartbeats
  const onHeartbeat = (event: HeartbeatEvent) => power.get(event.siteId)?.onHeartbeat(event);
  const espDevices = sites.flatMap((s) => s.esp);
  if (espDevices.some((d) => d.transport === "http")) {
    registerIotRoutes(app, {
      verifier: new HttpHeartbeatVerifier(espDevices),
      onEvent: onHeartbeat,
      onReject: (reason, remote) => bus.emit("heartbeat.rejected", { reason, remote }),
      now: () => clock.now(),
    });
  }
  const hubDevices = sites.flatMap((s) => (s.hub ? [s.hub] : []));
  // Backups and hub firmware share the R2 bucket.
  const backupConfig = loadBackupConfig(env, sites[0]?.tz ?? KYIV_TZ);
  let firmware: FirmwareService | null = null;
  // Hubs report here always: one made at the bench may show up before it has a building.
  {
    const benchHubs = store.hubs.listWithSecret().length;
    const firmwareConfig =
      hubDevices.length > 0 || benchHubs > 0
        ? loadFirmwareConfig(env, config.dbPath, backupConfig)
        : null;
    if (firmwareConfig) {
      firmware = new FirmwareService({
        config: firmwareConfig,
        clock,
        log,
        ...(deps.firmwareFetch ? { fetch: deps.firmwareFetch } : {}),
      });
      registerFirmwareRoute(app, firmware);
    }
    const verifier = new HubVerifier(hubDevices, (id) => ownership.benchDevice(id));
    hubVerifier = verifier;
    const firmwareService = firmware;
    registerHubRoutes(app, {
      verifier,
      onReport: (event) => hubs.get(event.siteId)?.onReport(event),
      onReject: (reason, remote, deviceId) =>
        bus.emit("heartbeat.rejected", { reason, remote, ...(deviceId ? { deviceId } : {}) }),
      offer: (event) => {
        const device = verifier.device(event.deviceId);
        return firmwareService && device ? firmwareService.offer(device.firmware, event) : null;
      },
      onOfferError: (error, event) =>
        log.warn({ err: error, deviceId: event.deviceId }, "hub firmware offer failed"),
      now: () => clock.now(),
    });
  }
  let udp: UdpHeartbeatServer | null = null;
  if (espDevices.some((d) => d.transport === "udp")) {
    udp = await startUdpHeartbeat({
      port: config.udpPort,
      verifier: new UdpHeartbeatVerifier(espDevices),
      onEvent: onHeartbeat,
      onReject: (reason, remote, deviceId) =>
        bus.emit("heartbeat.rejected", { reason, remote, deviceId }),
      now: () => clock.now(),
    });
  }

  // Yasno: one poller per region/DSO serving all its groups.
  const byFeed = new Map<string, { region: number; dso: number; groups: Set<string> }>();
  for (const site of sites) {
    const key = `${site.yasno.region}/${site.yasno.dso}`;
    const feed = byFeed.get(key) ?? {
      region: site.yasno.region,
      dso: site.yasno.dso,
      groups: new Set<string>(),
    };
    feed.groups.add(site.yasno.group);
    byFeed.set(key, feed);
  }
  const makePoller = (region: number, dso: number, groups: string[]) =>
    new YasnoPoller({
      region,
      dso,
      groups,
      now: () => clock.now(),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      onUpdate: (update) => schedules.onYasnoUpdate(update),
      onError: (error, failures) => bus.emit("yasno.error", { error, failures }),
      onRecovered: (failures) => bus.emit("yasno.recovered", { failures }),
    });
  pollers.push(
    ...[...byFeed.values()].map((feed) => makePoller(feed.region, feed.dso, [...feed.groups])),
  );

  // A building created by its owner while the core runs: the same services as at the start.
  addSite = (site) => {
    if (state.has(site.id)) return;
    sites.push(site);
    state.add(site);
    if (site.hub) {
      const service = new HubPowerService({ site, hub: site.hub, store, bus, clock, state });
      hubs.set(site.id, service);
      service.start();
      hubVerifier?.set(site.hub);
    }
    const reminder = new ReminderService({ site, store, bus, clock, state });
    reminders.push(reminder);
    reminder.start();
    schedules.hydrateSite(site);
    const feed = `${site.yasno.region}/${site.yasno.dso}`;
    const poller = pollers.find((p) => p.feed === feed);
    if (poller) poller.addGroup(site.yasno.group);
    else {
      const added = makePoller(site.yasno.region, site.yasno.dso, [site.yasno.group]);
      pollers.push(added);
      added.start();
    }
    telegram.addSite(site);
    log.info({ site: site.id, name: site.name, group: site.yasno.group }, "building added");
  };

  // Nightly backup to S3-compatible storage (Cloudflare R2), when configured.
  if (backupConfig && config.dbPath !== ":memory:") {
    backup = new BackupService({
      db,
      config: backupConfig,
      clock,
      log,
      onResult: (status, result) => notifierInstance.onBackup(status, result),
      ...(deps.backupFetch ? { fetch: deps.backupFetch } : {}),
    });
    log.info(
      {
        bucket: backupConfig.bucket,
        at: backupConfig.time,
        next: new Date(backup.nextRunAt(clock.now())),
      },
      "backups enabled",
    );
  }

  for (const service of power.values()) service.start();
  for (const service of hubs.values()) service.start();
  for (const service of reminders) service.start();
  for (const poller of pollers) poller.start();

  await app.ready();
  if (deps.listen ?? true) await app.listen({ host: config.host, port: config.port });
  outbox.start();
  telegram.start();
  backup?.start();
  weather?.start();
  firmware?.start();
  notifierInstance.coreStarted(previousRunAt);

  return {
    app,
    bus,
    store,
    state,
    sites,
    power,
    hubs,
    ownership,
    schedules,
    pollers,
    udp,
    outbox,
    telegram,
    notifier: notifierInstance,
    sse,
    backup,
    weather,
    firmware,
    stop: async () => {
      backup?.stop();
      weather?.stop();
      firmware?.stop();
      for (const poller of pollers) poller.stop();
      await udp?.close();
      for (const service of reminders) service.stop();
      for (const monitor of voltage) monitor.stop();
      for (const service of power.values()) service.stop();
      for (const service of hubs.values()) service.stop();
      mqtt?.end?.(true);
      notifierInstance.stop();
      evenings.stop();
      await telegram.stop();
      // Let sends in progress finish; what is left stays in the outbox for the next start.
      outbox.stop();
      await Promise.race([outbox.idle(), new Promise((r) => setTimeout(r, 3_000).unref())]);
      await app.close();
      closeDatabase(db);
    },
  };
}

/** Every decision is visible in the log too (channels may be off or in shadow mode). */
function logEvents(bus: Bus, log: FastifyInstance["log"], clock: Clock): void {
  const iso = (t: number) => new Date(t).toISOString();
  bus.on("power.changed", (e) =>
    log.info(
      {
        site: e.siteId,
        at: iso(e.at),
        detectedAt: iso(e.detectedAt),
        reason: e.reason,
        approximate: e.approximate,
      },
      `power ${e.state}`,
    ),
  );
  bus.on("power.false-alarm", (e) =>
    log.info({ site: e.siteId, outageStartedAt: iso(e.outageStartedAt) }, "false alarm retracted"),
  );
  bus.on("power.blip", (e) =>
    log.info({ site: e.siteId, from: iso(e.from), ms: e.to - e.from }, "power blip"),
  );
  bus.on("power.network-gap", (e) =>
    log.info({ site: e.siteId, ms: e.to - e.from, confirmedBy: e.confirmedBy }, "esp network gap"),
  );
  bus.on("schedule.notification", (e) =>
    log.info({ site: e.siteId, kind: e.notification.kind }, e.notification.web.title),
  );
  bus.on("reminder.due", (e) =>
    log.info(
      { site: e.siteId, kind: e.event.kind, lead: e.event.leadMinutes, power: e.power },
      "reminder due",
    ),
  );
  bus.on("zigbee.bridge", (e) => log.info(`zigbee2mqtt ${e.online ? "online" : "offline"}`));
  bus.on("hub.updated", (e) => log.info(e, "hub firmware changed"));
  bus.on("hub.update-rejected", (e) => log.warn(e, "hub rolled a firmware back"));
  bus.on("hub.link-gap", (e) =>
    log.warn(e, "hub lost its plug's radio for a while (not the mains)"),
  );
  bus.on("yasno.error", (e) => log.warn({ failures: e.failures }, `yasno: ${e.error}`));
  const lastRejectLog = new Map<string, number>();
  bus.on("heartbeat.rejected", (e) => {
    const key = `${e.reason}|${e.remote}`;
    const now = clock.now();
    if (now - (lastRejectLog.get(key) ?? Number.NEGATIVE_INFINITY) < 10 * 60_000) return;
    lastRejectLog.set(key, now);
    log.warn(
      { reason: e.reason, remote: e.remote, device: e.deviceId },
      "heartbeat rejected (repeats muted for 10 min)",
    );
  });
}

/** /hubs in the admin chat: every hub, its building, owner and last report. */
function hubsReport(
  store: Store,
  sites: readonly SiteConfig[],
  status: (siteId: string) => HubStatus,
  now: number,
): string {
  const rows = [
    ...sites.flatMap((s) => (s.hub ? [{ id: s.hub.id, siteId: s.id }] : [])),
    ...store.hubs
      .listWithSecret()
      .filter((h) => !h.siteId)
      .map((h) => ({ id: h.id, siteId: null })),
  ];
  if (rows.length === 0) return "Хабів немає.";
  return [
    "🛰 Хаби:",
    ...rows.map(({ id, siteId }) => {
      const site = siteId ? sites.find((s) => s.id === siteId) : undefined;
      const owner = store.hubs.get(id)?.ownerUserId ?? null;
      const last = site ? status(site.id) : null;
      const seen =
        last?.lastReportAt != null
          ? `звіт ${Math.round((now - last.lastReportAt) / 60_000)} хв тому, ${last.fw ?? "?"}${last.rssi !== null ? `, сигнал ${last.rssi} dBm` : ""}${last.alertDelay !== null ? `, сповіщає за ${last.alertDelay} с` : ""}${last.linkGaps ? `, коротких мовчань ${last.linkGaps}` : ""}`
          : "звітів не було";
      return `• ${id}: ${site ? `«${site.name}» (${site.id})` : "без будинку"}, ${owner !== null ? `власник ${owner}` : "без власника"}, ${seen}`;
    }),
  ].join("\n");
}
