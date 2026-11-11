/**
 * Turns core events into channel messages: power notices and schedule changes for users,
 * operational alerts for the admin chat, and the /health and /stats reports.
 */
import { formatDurationLong, formatHHMM, localDate, outageSummary } from "@svitlo/domain";
import type { OutboxItem, Store } from "@svitlo/storage";
import type { YasnoPoller } from "../adapters/yasno.ts";
import type { Bus, CoreEvents } from "../runtime/bus.ts";
import type { Clock, Timer } from "../runtime/clock.ts";
import type { BackupResult, BackupStatus } from "../services/backup.ts";
import type { RenderDay, ScheduleImages } from "../services/images.ts";
import type { SiteStateStore } from "../services/state.ts";
import type { SiteConfig } from "../sites-config.ts";
import {
  escapeHtml,
  FALSE_ALARM_TEXT,
  formatAge,
  formatSeconds,
  plural,
  powerLabel,
  powerOffText,
  powerOnText,
  voltageAlertText,
  voltageStabilizedText,
} from "./messages.ts";
import type { AdminReports, TelegramChannel } from "./telegram.ts";

export const ZIGBEE_OFFLINE_ALERT_MS = 60_000;
/**
 * No word from zigbee2mqtt this long after the start → alert. 2026-11-11: after a power loss the
 * MQTT broker did not start, and nobody knew for 14 hours.
 */
export const ZIGBEE_START_ALERT_MS = 3 * 60_000;
/** The plug answers probes every 30 s while there is power: silent this long → alert. */
export const PLUG_SILENT_ALERT_MS = 10 * 60_000;
const PLUG_CHECK_EVERY_MS = 60_000;
export const REJECT_ALERT_EVERY_MS = 6 * 3_600_000;
export const YASNO_ALERT_AFTER = 3;
export const NETWORK_GAP_ALERT_MS = 2 * 60_000;
/** The startup alert waits this long: the detector settles the power state first. */
export const STARTUP_ALERT_DELAY_MS = 30_000;
const DAY = 86_400_000;

export type NotifierDeps = {
  bus: Bus;
  telegram: TelegramChannel;
  state: SiteStateStore;
  store: Store;
  clock: Clock;
  sites: readonly SiteConfig[];
  version: string;
  pollers: () => readonly YasnoPoller[];
  sseClients: () => number;
  /** Null when backups are not configured. */
  backup?: () => BackupStatus | null;
  /** Schedule pictures for the notices; null: text only. */
  images?: ScheduleImages | null;
  log: { info: (obj: object, msg: string) => void };
};

export const BACKUP_ALERT_AFTER = 3;

export class Notifier {
  private readonly deps: NotifierDeps;
  private readonly startedAt: number;
  private readonly unsubscribe: (() => void)[] = [];
  private zigbeeOnline: boolean | null = null;
  private zigbeeTimer: Timer | null = null;
  private startTimer: Timer | null = null;
  /** Sites whose plug is watched (MQTT configured), the check timer, alerted sites → when. */
  private plugSites: readonly string[] = [];
  private plugTimer: Timer | null = null;
  private readonly plugAlerted = new Map<string, number>();
  private zigbeeAlerted = false;
  private yasnoAlerted = false;
  private backupAlerted = false;
  private readonly rejectAlerts = new Map<string, number>();

  constructor(deps: NotifierDeps) {
    this.deps = deps;
    this.startedAt = deps.clock.now();
    const { bus } = deps;
    this.unsubscribe.push(
      bus.on("power.changed", (e) => this.onPowerChanged(e)),
      bus.on("power.false-alarm", (e) => {
        deps.telegram.announce(e.siteId, "false-alarm", FALSE_ALARM_TEXT, {
          eventAt: e.detectedAt,
          detectedAt: e.detectedAt,
          dedupeKey: `false-alarm:${e.siteId}:${e.outageStartedAt}`,
        });
      }),
      bus.on("schedule.notification", (e) => {
        const schedule = deps.state.get(e.siteId).schedule;
        const fetchedAt = schedule?.fetchedAt ?? deps.clock.now();
        const publishedAt = schedule?.updatedOn ? Date.parse(schedule.updatedOn) : Number.NaN;
        const announce = (photo: string | null) =>
          deps.telegram.announce(e.siteId, "schedule", e.notification.telegramText, {
            eventAt: Number.isNaN(publishedAt) || publishedAt > fetchedAt ? fetchedAt : publishedAt,
            detectedAt: fetchedAt,
            ...(photo ? { photo } : {}),
          });
        if (!deps.images) {
          announce(null);
          return;
        }
        // The picture of that day goes with the text; without one the text goes alone.
        const day: RenderDay = e.notification.kind === "today_updated" ? "today" : "tomorrow";
        deps.images.render(e.siteId, day).then(announce, () => announce(null));
      }),
      bus.on("voltage.alert", (e) => {
        const text = voltageAlertText(e.kind, e.voltage, e.critical);
        deps.telegram.announce(e.siteId, "voltage", text, {
          eventAt: e.since,
          detectedAt: deps.clock.now(),
        });
      }),
      bus.on("voltage.stabilized", (e) => {
        deps.telegram.announce(
          e.siteId,
          "voltage",
          voltageStabilizedText(e.kind, e.voltage, e.at - e.since),
          { eventAt: e.at, detectedAt: deps.clock.now() },
        );
      }),
      bus.on("power.blip", (e) => {
        const site = deps.state.site(e.siteId);
        deps.telegram.alert(
          e.siteId,
          `⚡ ${escapeHtml(site.name)}: короткий збій живлення ${formatSeconds(e.to - e.from)} о ${formatHHMM(e.from, site.tz)}.`,
          { silent: true },
        );
      }),
      bus.on("power.network-gap", (e) => {
        if (e.to - e.from < NETWORK_GAP_ALERT_MS) return;
        const site = deps.state.site(e.siteId);
        const by = e.confirmedBy === "zigbee" ? "розетка бачила напругу" : "uptime ESP не скинувся";
        deps.telegram.alert(
          e.siteId,
          `📶 ${escapeHtml(site.name)}: ESP мовчав ${formatDurationLong((e.to - e.from) / 1000)} з ${formatHHMM(e.from, site.tz)}, але світло було (${by}).`,
          { silent: true },
        );
      }),
      bus.on("yasno.error", (e) => {
        if (e.failures !== YASNO_ALERT_AFTER) return;
        this.yasnoAlerted = true;
        deps.telegram.alert(
          null,
          `⚠️ Yasno не відповідає (${e.failures} спроби поспіль): ${escapeHtml(e.error.slice(0, 300))}`,
        );
      }),
      bus.on("yasno.recovered", (e) => {
        if (!this.yasnoAlerted) return;
        this.yasnoAlerted = false;
        deps.telegram.alert(null, `✅ Yasno знову відповідає (після ${e.failures} помилок).`, {
          silent: true,
        });
      }),
      bus.on("zigbee.bridge", (e) => this.onZigbee(e.online)),
      bus.on("heartbeat.rejected", (e) => {
        const key = `${e.reason}|${e.remote}`;
        const now = deps.clock.now();
        if (now - (this.rejectAlerts.get(key) ?? Number.NEGATIVE_INFINITY) < REJECT_ALERT_EVERY_MS)
          return;
        this.rejectAlerts.set(key, now);
        deps.telegram.alert(
          null,
          `🛡 Відхилено heartbeat: ${e.reason} від ${escapeHtml(e.remote)}${e.deviceId ? ` (${escapeHtml(e.deviceId)})` : ""}. Повтори приглушено на 6 год.`,
          { silent: true },
        );
      }),
    );
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.deps.clock.clearTimer(this.zigbeeTimer);
    this.zigbeeTimer = null;
    this.deps.clock.clearTimer(this.startTimer);
    this.startTimer = null;
    this.deps.clock.clearTimer(this.plugTimer);
    this.plugTimer = null;
  }

  /**
   * Watch zigbee2mqtt and the sites' plugs (MQTT is configured): alert when zigbee2mqtt has not
   * come up since the start, and when a plug stays silent while there is power.
   */
  watchZigbee(siteIds: readonly string[]): void {
    this.plugSites = siteIds;
    if (this.zigbeeOnline !== true && !this.zigbeeTimer) {
      this.armZigbeeAlert(
        ZIGBEE_START_ALERT_MS,
        `⚠️ Немає зв'язку з zigbee2mqtt ${Math.round(ZIGBEE_START_ALERT_MS / 60_000)} хв від запуску ядра — розетка не підтверджує стан світла й не міряє напругу. Перевір контейнери mosquitto і zigbee2mqtt.`,
      );
    }
    this.schedulePlugCheck();
  }

  private schedulePlugCheck(): void {
    const { clock } = this.deps;
    clock.clearTimer(this.plugTimer);
    this.plugTimer = clock.setTimer(clock.now() + PLUG_CHECK_EVERY_MS, () => {
      this.plugTimer = null;
      this.checkPlugs();
      this.schedulePlugCheck();
    });
  }

  /** The plug answers every probe while there is power; a long silence means it is lost. */
  private checkPlugs(): void {
    const { clock, state, telegram } = this.deps;
    const now = clock.now();
    for (const siteId of this.plugSites) {
      const current = state.get(siteId);
      const name = escapeHtml(state.site(siteId).name);
      const alertedAt = this.plugAlerted.get(siteId);
      if (alertedAt !== undefined) {
        if (current.lastPlugAt !== null && current.lastPlugAt > alertedAt) {
          this.plugAlerted.delete(siteId);
          telegram.alert(null, `✅ ${name}: розетка знову на зв'язку.`, { silent: true });
        }
        continue;
      }
      // zigbee2mqtt itself is down: its own alert says so.
      if (current.power !== "on" || this.zigbeeOnline !== true) continue;
      const quietSince = Math.max(current.lastPlugAt ?? 0, current.since ?? 0, this.startedAt);
      if (now - quietSince < PLUG_SILENT_ALERT_MS) continue;
      this.plugAlerted.set(siteId, now);
      telegram.alert(
        null,
        `⚠️ ${name}: розетка мовчить ${Math.round((now - quietSince) / 60_000)} хв, хоча світло є — напруга не міряється, світло видно лише по ESP. Перевір розетку в zigbee2mqtt.`,
      );
    }
  }

  /**
   * Admin alert `STARTUP_ALERT_DELAY_MS` after the start, with the power state the detector has
   * settled by then; mentions how long the core was down (e.g. the Pi lost power).
   */
  coreStarted(previousRunAt: number | null): void {
    const { clock } = this.deps;
    const startedAt = clock.now();
    clock.clearTimer(this.startTimer);
    this.startTimer = clock.setTimer(startedAt + STARTUP_ALERT_DELAY_MS, () => {
      this.startTimer = null;
      this.sendCoreStarted(previousRunAt, startedAt);
    });
  }

  private sendCoreStarted(previousRunAt: number | null, startedAt: number): void {
    const { sites, state, version } = this.deps;
    const lines = [`🟢 Ядро svitlo4u ${escapeHtml(version)} запущено.`];
    const down = previousRunAt !== null ? startedAt - previousRunAt : 0;
    const tz = sites[0]?.tz ?? "Europe/Kyiv";
    if (previousRunAt !== null && down >= 2 * 60_000) {
      lines.push(
        `Перерва в роботі: ${formatDurationLong(down / 1000)} (з ${formatHHMM(previousRunAt, tz)} ${shortDate(previousRunAt, tz)}).`,
      );
    }
    for (const site of sites) {
      lines.push(`${escapeHtml(site.name)}: світло ${powerLabel(state.get(site.id).power)}`);
    }
    this.deps.telegram.alert(null, lines.join("\n"), { silent: down < 10 * 60_000 });
  }

  /** Backup results: alert after a few failures in a row (night outages take the internet too). */
  readonly onBackup = (status: BackupStatus, result: BackupResult | null): void => {
    if (!result) {
      if (status.failuresInRow === BACKUP_ALERT_AFTER) {
        this.backupAlerted = true;
        this.deps.telegram.alert(
          null,
          `⚠️ Бекап БД не вдався ${status.failuresInRow} рази поспіль: ${escapeHtml((status.lastError?.error ?? "?").slice(0, 300))}`,
        );
      }
      return;
    }
    if (this.backupAlerted) {
      this.backupAlerted = false;
      this.deps.telegram.alert(null, "✅ Бекап БД знову працює.", { silent: true });
    }
  };

  /** Delivery gave up: tell the admin (never about alerts themselves — no loops). */
  readonly onUndelivered = (item: OutboxItem, error: string): void => {
    if (item.kind === "alert") return;
    this.deps.telegram.alert(
      item.siteId,
      `⚠️ Не доставлено «${escapeHtml(item.kind)}» в ${escapeHtml(item.target)}: ${escapeHtml(error.slice(0, 300))}`,
    );
  };

  readonly reports: AdminReports = {
    health: (siteId) => this.health(siteId),
    stats: (siteId) => this.stats(siteId),
  };

  private onPowerChanged(e: CoreEvents["power.changed"]): void {
    const { state, telegram, clock } = this.deps;
    const site = state.site(e.siteId);
    if (e.previous === "unknown") {
      // First reading after a fresh start: nothing changed for users.
      telegram.alert(
        e.siteId,
        `ℹ️ ${escapeHtml(site.name)}: перший стан після запуску — світло ${powerLabel(e.state)} (без сповіщення).`,
        { silent: true },
      );
      return;
    }
    const plan = state.planTexts(e.siteId, clock.now());
    const base = {
      at: e.at,
      detectedAt: e.detectedAt,
      previousSince: e.previousSince,
      approximate: e.approximate,
      tz: site.tz,
    };
    const text =
      e.state === "off"
        ? powerOffText({ ...base, restore: plan?.restore ?? null })
        : powerOnText({ ...base, outage: plan?.outage ?? null });
    telegram.announce(e.siteId, "power", text, {
      eventAt: e.at,
      detectedAt: e.detectedAt,
      dedupeKey: `power:${e.siteId}:${e.state}:${e.at}`,
    });
  }

  private health(siteId: string): string {
    const { clock, state, store, version } = this.deps;
    const now = clock.now();
    const site = state.site(siteId);
    const current = state.get(siteId);
    const pollers = this.deps.pollers();
    const lastYasno = pollers.reduce<number | null>(
      (latest, p) => (p.lastSuccessAt === null ? latest : Math.max(latest ?? 0, p.lastSuccessAt)),
      null,
    );
    const yasnoFailures = Math.max(0, ...pollers.map((p) => p.consecutiveFailures));
    const outbox = store.outbox.stats(now - DAY);
    const since =
      current.since !== null
        ? ` з ${formatHHMM(current.since, site.tz)} ${shortDate(current.since, site.tz)} (${formatDurationLong((now - current.since) / 1000)})`
        : "";
    const zigbee =
      this.zigbeeOnline === null ? "невідомо" : this.zigbeeOnline ? "online" : "offline";
    return [
      `🩺 <b>svitlo4u</b> ${escapeHtml(version)} · працює ${formatDurationLong((now - this.startedAt) / 1000)}`,
      `⚡ ${escapeHtml(site.name)}: світло ${powerLabel(current.power)}${since}`,
      `📡 ESP: ${formatAge(current.lastEspAt, now)}`,
      site.plug
        ? `🔌 Розетка: ${formatAge(current.lastPlugAt, now)}${current.lastVoltage !== null ? `, ${Math.round(current.lastVoltage)} В` : ""} · zigbee2mqtt ${zigbee}`
        : "🔌 Розетки немає",
      `📅 Yasno: ${formatAge(lastYasno, now)}${yasnoFailures > 0 ? ` · помилок поспіль: ${yasnoFailures}` : ""}`,
      `📬 Черга: ${outbox.pending} в очікуванні · за добу ${outbox.sent} надіслано, ${outbox.failed} не доставлено`,
      `🔭 SSE: ${this.deps.sseClients()} ${plural(this.deps.sseClients(), "клієнт", "клієнти", "клієнтів")}`,
      this.backupLine(now),
      `🧪 Telegram: ${site.telegram?.shadow ? "shadow (лише адмін-чат)" : "live"}`,
    ].join("\n");
  }

  private backupLine(now: number): string {
    const status = this.deps.backup?.() ?? null;
    if (!status) return "💾 Бекап: не налаштовано";
    const failures = status.failuresInRow > 0 ? ` · помилок поспіль: ${status.failuresInRow}` : "";
    if (status.lastOk) {
      const kb = Math.max(1, Math.round(status.lastOk.gzBytes / 1024));
      return `💾 Бекап: ${formatAge(status.lastOk.at, now)} (${kb} КБ)${failures}`;
    }
    if (status.lastError) {
      return `💾 Бекап: помилка — ${escapeHtml(status.lastError.error.slice(0, 200))}${failures}`;
    }
    return "💾 Бекап: ще не було з моменту запуску";
  }

  private stats(siteId: string): string {
    const { clock, state, store } = this.deps;
    const now = clock.now();
    const site = state.site(siteId);
    const subscribers = store.telegram.list(siteId).length;
    const chats = site.telegram?.chats.length ?? 0;
    const period = (days: number) => {
      const range = { start: now - days * DAY, end: now };
      const summary = outageSummary(store.outages.list(siteId, range), { range, now });
      const share = Math.round(summary.offShare * 100);
      return `За ${days} ${plural(days, "день", "дні", "днів")}: ${summary.outages} ${plural(summary.outages, "відключення", "відключення", "відключень")}, без світла ${formatDurationLong(summary.offMs / 1000)} (${share}%)`;
    };
    return [
      `📊 <b>${escapeHtml(site.name)}</b>`,
      `👥 Підписників /sub: ${subscribers} · чатів у конфігу: ${chats}`,
      period(7),
      period(30),
    ].join("\n");
  }

  private onZigbee(online: boolean): void {
    const { clock, telegram } = this.deps;
    const previous = this.zigbeeOnline;
    this.zigbeeOnline = online;
    if (online) {
      clock.clearTimer(this.zigbeeTimer);
      this.zigbeeTimer = null;
      if (this.zigbeeAlerted) {
        this.zigbeeAlerted = false;
        telegram.alert(null, "✅ zigbee2mqtt знову online.", { silent: true });
      }
      return;
    }
    if (previous === false || this.zigbeeTimer) return;
    // Restarts of zigbee2mqtt take seconds: alert only when it stays offline.
    this.armZigbeeAlert(
      ZIGBEE_OFFLINE_ALERT_MS,
      "⚠️ zigbee2mqtt offline понад хвилину — розетка не підтверджує стан світла й не міряє напругу.",
    );
  }

  private armZigbeeAlert(ms: number, text: string): void {
    const { clock, telegram } = this.deps;
    this.zigbeeTimer = clock.setTimer(clock.now() + ms, () => {
      this.zigbeeTimer = null;
      if (this.zigbeeOnline === true) return;
      this.zigbeeAlerted = true;
      telegram.alert(null, text);
    });
  }
}

function shortDate(t: number, tz: string): string {
  const [, m, d] = localDate(t, tz).split("-");
  return `${d}.${m}`;
}
