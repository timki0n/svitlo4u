/**
 * One-off import of the legacy databases:
 * - svitlo.db    (svitlo_web bot, ЖК 4U):    outages, schedules (slots in minutes)
 * - light_bot.db (light_bot_tg, group 6.1): outages, schedules (slots in hours), subscribers
 *
 * Idempotent: re-running imports nothing new. Ongoing (open) outages are skipped so they do not
 * clash with the live detector. Web Push subscriptions are not imported: they are bound to the old
 * origin (svitlo4u.online) and cannot be reused on the new domain.
 *
 * Open a *copy* of a live legacy DB: it may be in WAL mode and is opened read-only here.
 */
import { parseDay } from "@svitlo/domain";
import Database from "better-sqlite3";
import { outages } from "./schema.ts";
import type { Store } from "./store.ts";

export type LegacyFormat = "svitlo" | "light_bot";

export type ImportReport = {
  outages: { imported: number; existing: number; open: number };
  schedules: { imported: number; unchanged: number };
  subscribers: { imported: number; existing: number };
};

type LegacyOutage = { start_ts: number; end_ts: number | null };
type LegacySchedule = {
  schedule_date: string;
  status: string | null;
  slots_json: string | null;
  updated_at: number;
};
type LegacySubscriber = { chat_id: number; thread_id: number; created_at: number };

export function importLegacyDatabase(
  store: Store,
  options: { siteId: string; path: string; format: LegacyFormat; now?: number },
): ImportReport {
  if (!store.sites.get(options.siteId)) throw new Error(`site ${options.siteId} does not exist`);
  const legacy = new Database(options.path, { readonly: true, fileMustExist: true });
  const now = options.now ?? Date.now();
  const report: ImportReport = {
    outages: { imported: 0, existing: 0, open: 0 },
    schedules: { imported: 0, unchanged: 0 },
    subscribers: { imported: 0, existing: 0 },
  };
  try {
    store.db.transaction((tx) => {
      for (const row of legacy
        .prepare("SELECT start_ts, end_ts FROM outages ORDER BY start_ts")
        .all() as LegacyOutage[]) {
        if (row.end_ts === null) {
          report.outages.open++;
          continue;
        }
        const result = tx
          .insert(outages)
          .values({
            siteId: options.siteId,
            start: Math.round(row.start_ts * 1000),
            end: Math.round(row.end_ts * 1000),
            source: "legacy",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
        if (result.changes > 0) report.outages.imported++;
        else report.outages.existing++;
      }
    });

    const schedules = legacy
      .prepare(
        "SELECT schedule_date, status, slots_json, updated_at FROM schedules ORDER BY schedule_date",
      )
      .all() as LegacySchedule[];
    for (const row of schedules) {
      const date = row.schedule_date.slice(0, 10);
      const day = {
        ...parseDay({
          date,
          status: row.status,
          slots: legacySlots(row.slots_json, options.format),
        }),
        date,
      };
      const stored = store.schedules.saveIfChanged(
        options.siteId,
        date,
        day,
        Math.round(row.updated_at * 1000),
        {
          source: "legacy",
        },
      );
      if (stored) report.schedules.imported++;
      else report.schedules.unchanged++;
    }

    const hasSubscribers = legacy
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subscribers'")
      .get();
    if (hasSubscribers) {
      const rows = legacy
        .prepare("SELECT chat_id, thread_id, created_at FROM subscribers")
        .all() as LegacySubscriber[];
      for (const row of rows) {
        const added = store.telegram.subscribe(
          options.siteId,
          row.chat_id,
          row.thread_id,
          Math.round(row.created_at * 1000),
        );
        if (added) report.subscribers.imported++;
        else report.subscribers.existing++;
      }
    }
  } finally {
    legacy.close();
  }
  return report;
}

/** svitlo.db stores minutes ({start_min, end_min}); light_bot.db stores hours ({start_hour, end_hour}). */
function legacySlots(
  json: string | null,
  format: LegacyFormat,
): { start: number; end: number; type: string }[] {
  const raw = JSON.parse(json ?? "[]") as Record<string, number | string>[];
  return raw.map((slot) =>
    format === "svitlo"
      ? { start: Number(slot.start_min), end: Number(slot.end_min), type: String(slot.type ?? "") }
      : {
          start: Math.round(Number(slot.start_hour) * 60),
          end: Math.round(Number(slot.end_hour) * 60),
          type: String(slot.type ?? ""),
        },
  );
}
