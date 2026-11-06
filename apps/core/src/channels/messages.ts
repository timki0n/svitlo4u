/**
 * Telegram texts (HTML). Power notices keep the legacy bot's wording so subscribers see the same
 * messages; new ones (false alarm, admin alerts, /health) follow the same style.
 */
import { formatDurationLong, formatHHMM, type PowerState, scheduleLink } from "@svitlo/domain";
import type { SiteConfig } from "../sites-config.ts";

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const seconds = (ms: number) => Math.max(0, ms) / 1000;

/** "Світло ЗНИКЛО" — legacy power_monitor text plus a time line when the news is late. */
export function powerOffText(options: {
  at: number;
  detectedAt: number;
  previousSince: number | null;
  approximate: boolean;
  restore: string | null;
  tz: string;
}): string {
  const lines = ["🔔⚠️ Світло ЗНИКЛО."];
  if (options.previousSince !== null && options.previousSince <= options.at) {
    lines.push(
      `Час зі світлом: ${formatDurationLong(seconds(options.at - options.previousSince))}${options.approximate ? " (орієнтовно)" : ""}`,
    );
  }
  const late = lateLine("Зникло", options);
  if (late) lines.push(late);
  if (options.restore) lines.push(options.restore);
  return lines.join("\n");
}

/** "Світло ВІДНОВЛЕНО" — legacy text. */
export function powerOnText(options: {
  at: number;
  detectedAt: number;
  previousSince: number | null;
  approximate: boolean;
  outage: string | null;
  tz: string;
}): string {
  const lines = ["🔔✅ Світло ВІДНОВЛЕНО."];
  if (options.previousSince !== null && options.previousSince <= options.at) {
    lines.push(
      `Час без світла: ${formatDurationLong(seconds(options.at - options.previousSince))}${options.approximate ? " (орієнтовно)" : ""}`,
    );
  }
  const late = lateLine("Відновилося", options);
  if (late) lines.push(late);
  if (options.outage) lines.push(options.outage);
  return lines.join("\n");
}

/** When the change was noticed long after it happened (core was down), say when it happened. */
const LATE_AFTER_MS = 2 * 60_000;
function lateLine(
  verb: string,
  options: { at: number; detectedAt: number; approximate: boolean; tz: string },
): string | null {
  if (options.detectedAt - options.at < LATE_AFTER_MS) return null;
  return `${verb} ${options.approximate ? "орієнтовно о" : "о"} ${formatHHMM(options.at, options.tz)}.`;
}

export const FALSE_ALARM_TEXT =
  "↩️ Хибна тривога: світло не зникало. Вибачте за попереднє повідомлення.";

/** /status — legacy wording. */
export function statusText(options: {
  power: PowerState;
  since: number | null;
  now: number;
  plan: { restore: string; outage: string } | null;
  linkUrl: string;
}): string {
  const duration =
    options.since !== null ? formatDurationLong(seconds(options.now - options.since)) : "";
  const noSchedule = `⚠️ Не вдалося отримати ${scheduleLink({ tz: "UTC", linkUrl: options.linkUrl }, "графік")}`;
  if (options.power === "off") {
    const state = duration ? `❌ світла немає ${duration}` : "❌ світла немає";
    return `${state}\n${options.plan?.restore ?? noSchedule}`;
  }
  if (options.power === "on") {
    const state = duration ? `✅ світло є вже ${duration}` : "✅ світло є";
    return `${state}\n${options.plan?.outage ?? noSchedule}`;
  }
  return `❔ Стан світла поки невідомий: датчик ще не відповів.\n${options.plan?.outage ?? noSchedule}`;
}

export function startText(site: SiteConfig): string {
  return [
    `👋 Бот моніторингу живлення ${escapeHtml(site.name)} з ${scheduleLink({ tz: site.tz, linkUrl: site.linkUrl }, "графіками")} відключень YASNO.`,
    `Група: ${escapeHtml(site.yasno.group)}`,
    "",
    "/status — чи є світло зараз",
    "/today — графік на сьогодні",
    "/tomorrow — графік на завтра",
    "/sub — підписатись або відписатись від сповіщень",
  ].join("\n");
}

export function subscribeText(subscribed: boolean): string {
  return subscribed
    ? "✅ Ви підписані на сповіщення про світло.\nЩе раз /sub — щоб відписатись."
    : "🔕 Ви відписались від сповіщень.\nЩе раз /sub — щоб підписатись знову.";
}

export function shadowHeader(siteId: string, targets: number): string {
  return `🧪 <b>shadow</b> · ${escapeHtml(siteId)} → ${targets} ${plural(targets, "чат", "чати", "чатів")}`;
}

/** Shadow mode: how long detection and delivery took. */
export function latencyFooter(eventAt: number, detectedAt: number | null, now: number): string {
  const parts: string[] = [];
  if (detectedAt !== null) parts.push(`виявлено через ${formatSeconds(detectedAt - eventAt)}`);
  parts.push(`відправка через ${formatSeconds(now - (detectedAt ?? eventAt))} після виявлення`);
  return `⏱ ${parts.join(" · ")}`;
}

export function formatSeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? `${s.toFixed(1)} с` : `${Math.round(s)} с`;
}

/** Age for /health: "12 с тому", "5 хв тому", "3 год 2 хв тому", "ніколи". */
export function formatAge(at: number | null, now: number): string {
  if (at === null) return "ніколи";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} с тому`;
  if (s < 3600) return `${Math.floor(s / 60)} хв тому`;
  return `${formatDurationLong(s)} тому`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function powerLabel(power: PowerState): string {
  return power === "on" ? "є" : power === "off" ? "немає" : "невідомо";
}
