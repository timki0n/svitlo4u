/**
 * Wires the core: database, sites, adapters (UDP/HTTP heartbeat, Zigbee plug, Yasno) and services
 * (power, schedules, reminders) around one event bus. Channels subscribe to the bus (stage 5).
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { closeDatabase, createStore, openDatabase, type Store } from "@svitlo/storage";
import type { FastifyInstance } from "fastify";
import { connect, type MqttClient } from "mqtt";
import {
  type HeartbeatEvent,
  HttpHeartbeatVerifier,
  registerIotRoutes,
  startUdpHeartbeat,
  type UdpHeartbeatServer,
  UdpHeartbeatVerifier,
} from "./adapters/heartbeat.ts";
import { type MqttLike, type PlugAdapter, startPlugAdapter } from "./adapters/plug.ts";
import { YasnoPoller } from "./adapters/yasno.ts";
import type { CoreConfig } from "./config.ts";
import { type Bus, EventBus } from "./runtime/bus.ts";
import { type Clock, SystemClock } from "./runtime/clock.ts";
import { buildServer } from "./server.ts";
import { PowerService } from "./services/power.ts";
import { ReminderService } from "./services/reminders.ts";
import { ScheduleService } from "./services/schedule.ts";
import { SiteStateStore } from "./services/state.ts";
import { loadSitesConfig, type SiteConfig } from "./sites-config.ts";

export type CoreDeps = {
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  /** Replace the MQTT connection (tests). */
  mqtt?: MqttLike & { end?: (force?: boolean) => unknown };
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Do not bind a TCP port (tests use app.inject). */
  listen?: boolean;
};

export type Core = {
  app: FastifyInstance;
  bus: Bus;
  store: Store;
  state: SiteStateStore;
  sites: SiteConfig[];
  power: Map<string, PowerService>;
  schedules: ScheduleService;
  pollers: YasnoPoller[];
  udp: UdpHeartbeatServer | null;
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
    });
  }

  const bus: Bus = new EventBus((type, err) => log.error({ type, err }, "event handler failed"));
  const state = new SiteStateStore(sites);
  logEvents(bus, log, clock);

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
  } else if (plugs.length > 0) {
    log.warn(
      "plugs configured but MQTT_URL / MQTT_CORE_PASSWORD missing — plug confirmation disabled",
    );
  }

  for (const site of sites) {
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
  const pollers = [...byFeed.values()].map(
    (feed) =>
      new YasnoPoller({
        region: feed.region,
        dso: feed.dso,
        groups: [...feed.groups],
        now: () => clock.now(),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        onUpdate: (update) => schedules.onYasnoUpdate(update),
        onError: (error, failures) => bus.emit("yasno.error", { error, failures }),
      }),
  );

  for (const service of power.values()) service.start();
  for (const service of reminders) service.start();
  for (const poller of pollers) poller.start();

  await app.ready();
  if (deps.listen ?? true) await app.listen({ host: config.host, port: config.port });

  return {
    app,
    bus,
    store,
    state,
    sites,
    power,
    schedules,
    pollers,
    udp,
    stop: async () => {
      for (const poller of pollers) poller.stop();
      await udp?.close();
      for (const service of reminders) service.stop();
      for (const service of power.values()) service.stop();
      mqtt?.end?.(true);
      await app.close();
      closeDatabase(db);
    },
  };
}

/** Until channels exist (stage 5), every decision is visible in the log. */
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
