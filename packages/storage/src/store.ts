/**
 * Thin repositories over the schema. Synchronous on purpose: better-sqlite3 calls take
 * microseconds and keep event handling ordered without awaits.
 */
import {
  type DaySchedule,
  type DetectorEffect,
  daySignature,
  type Interval,
  type OutageRecord,
  type PersistedDetector,
  parseDay,
  type ScheduleSnapshot,
  type ScheduleStatus,
  type VoltageSample,
} from "@svitlo/domain";
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import {
  detectorState,
  heartbeatMinutes,
  notificationOutbox,
  outages,
  powerEvents,
  pushSubscriptions,
  reminderLog,
  scheduleSnapshots,
  sites,
  telegramSubscribers,
  voltageSamples,
} from "./schema.ts";

export type SiteRow = typeof sites.$inferInsert;
export type OutboxItem = typeof notificationOutbox.$inferSelect;

export type Store = ReturnType<typeof createStore>;

export function createStore(db: Db) {
  const store = {
    db,

    sites: {
      upsert(site: Omit<SiteRow, "updatedAt">, now = Date.now()): void {
        const row = { ...site, updatedAt: now };
        db.insert(sites).values(row).onConflictDoUpdate({ target: sites.id, set: row }).run();
      },
      get(id: string) {
        return db.select().from(sites).where(eq(sites.id, id)).get() ?? null;
      },
      list() {
        return db.select().from(sites).orderBy(asc(sites.id)).all();
      },
    },

    detector: {
      load(siteId: string): PersistedDetector | null {
        const row = db.select().from(detectorState).where(eq(detectorState.siteId, siteId)).get();
        return row ? (JSON.parse(row.stateJson) as PersistedDetector) : null;
      },
      /** When the detector state was last saved (≈ when the core last ran). */
      savedAt(siteId: string): number | null {
        return (
          db
            .select({ updatedAt: detectorState.updatedAt })
            .from(detectorState)
            .where(eq(detectorState.siteId, siteId))
            .get()?.updatedAt ?? null
        );
      },
      save(siteId: string, state: PersistedDetector, now = Date.now()): void {
        const row = { siteId, stateJson: JSON.stringify(state), updatedAt: now };
        db.insert(detectorState)
          .values(row)
          .onConflictDoUpdate({ target: detectorState.siteId, set: row })
          .run();
      },
    },

    power: {
      /**
       * Store one detector effect: append to the event log and keep the outages table in sync.
       * Probes are not stored.
       */
      record(siteId: string, effect: DetectorEffect, now = Date.now()): void {
        if (effect.type === "probe") return;
        db.transaction((tx) => {
          if (effect.type === "power") {
            tx.insert(powerEvents)
              .values({
                siteId,
                type: effect.state,
                at: effect.at,
                detectedAt: effect.detectedAt,
                reason: effect.reason,
                approximate: effect.approximate,
              })
              .run();
            if (effect.state === "off") {
              tx.insert(outages)
                .values({
                  siteId,
                  start: effect.at,
                  end: null,
                  startApproximate: effect.approximate,
                  source: "detector",
                  createdAt: now,
                  updatedAt: now,
                })
                .onConflictDoNothing()
                .run();
            } else {
              const open = tx
                .select({ id: outages.id })
                .from(outages)
                .where(
                  and(
                    eq(outages.siteId, siteId),
                    isNull(outages.end),
                    lte(outages.start, effect.at),
                  ),
                )
                .orderBy(desc(outages.start))
                .get();
              if (open)
                tx.update(outages)
                  .set({ end: effect.at, updatedAt: now })
                  .where(eq(outages.id, open.id))
                  .run();
            }
            return;
          }
          if (effect.type === "false-alarm") {
            tx.insert(powerEvents)
              .values({
                siteId,
                type: "false-alarm",
                at: effect.outageStartedAt,
                detectedAt: effect.detectedAt,
              })
              .run();
            tx.update(outages)
              .set({
                falseAlarm: true,
                end: sql`coalesce(${outages.end}, ${effect.detectedAt})`,
                updatedAt: now,
              })
              .where(and(eq(outages.siteId, siteId), eq(outages.start, effect.outageStartedAt)))
              .run();
            return;
          }
          // network-gap | blip: log only (a blip is too short to be an outage in statistics).
          tx.insert(powerEvents)
            .values({
              siteId,
              type: effect.type,
              at: effect.from,
              until: effect.to,
              detectedAt: effect.to,
            })
            .run();
        });
      },
      events(siteId: string, range: Interval) {
        return db
          .select()
          .from(powerEvents)
          .where(
            and(
              eq(powerEvents.siteId, siteId),
              gte(powerEvents.at, range.start),
              lt(powerEvents.at, range.end),
            ),
          )
          .orderBy(asc(powerEvents.at))
          .all();
      },
    },

    outages: {
      /** Outages overlapping the range, ready for the analytics functions. */
      list(siteId: string, range: Interval): OutageRecord[] {
        return db
          .select({ start: outages.start, end: outages.end, falseAlarm: outages.falseAlarm })
          .from(outages)
          .where(
            and(
              eq(outages.siteId, siteId),
              lt(outages.start, range.end),
              or(isNull(outages.end), gte(outages.end, range.start)),
            ),
          )
          .orderBy(asc(outages.start))
          .all();
      },
      open(siteId: string) {
        return (
          db
            .select()
            .from(outages)
            .where(and(eq(outages.siteId, siteId), isNull(outages.end)))
            .orderBy(desc(outages.start))
            .get() ?? null
        );
      },
    },

    schedules: {
      /** Store a day's schedule if it differs from the latest stored version. Returns true when stored. */
      saveIfChanged(
        siteId: string,
        date: string,
        day: DaySchedule,
        fetchedAt: number,
        options: { updatedOn?: string | null; source?: "poller" | "legacy" } = {},
      ): boolean {
        const signature = daySignature(day);
        const latest = db
          .select({ signature: scheduleSnapshots.signature })
          .from(scheduleSnapshots)
          .where(and(eq(scheduleSnapshots.siteId, siteId), eq(scheduleSnapshots.date, date)))
          .orderBy(desc(scheduleSnapshots.fetchedAt))
          .get();
        if (latest?.signature === signature) return false;
        const result = db
          .insert(scheduleSnapshots)
          .values({
            siteId,
            date,
            fetchedAt,
            status: day.status,
            rawStatus: day.rawStatus,
            slotsJson: JSON.stringify(day.slots.map((s) => [s.start, s.end, s.type])),
            signature,
            updatedOn: options.updatedOn ?? null,
            source: options.source ?? "poller",
          })
          .onConflictDoNothing()
          .run();
        return result.changes > 0;
      },
      /** Latest version of every day in [fromDate, toDate] — the plan as it finally stood. */
      finalDays(
        siteId: string,
        fromDate: string,
        toDate: string,
      ): { date: string; day: DaySchedule }[] {
        const rows = db
          .select()
          .from(scheduleSnapshots)
          .where(
            and(
              eq(scheduleSnapshots.siteId, siteId),
              gte(scheduleSnapshots.date, fromDate),
              lte(scheduleSnapshots.date, toDate),
            ),
          )
          .orderBy(asc(scheduleSnapshots.date), asc(scheduleSnapshots.fetchedAt))
          .all();
        const latest = new Map<string, (typeof rows)[number]>();
        for (const row of rows) latest.set(row.date, row);
        return [...latest.values()].map((row) => ({ date: row.date, day: rowToDay(row) }));
      },
      /**
       * R15: the latest version of `date` with planned outages (ScheduleApplies) — the plan that
       * emergency shutdowns cancelled. Null when the day never had one.
       */
      lastFixed(siteId: string, date: string): { day: DaySchedule; fetchedAt: number } | null {
        const row = db
          .select()
          .from(scheduleSnapshots)
          .where(
            and(
              eq(scheduleSnapshots.siteId, siteId),
              eq(scheduleSnapshots.date, date),
              eq(scheduleSnapshots.status, "ScheduleApplies"),
            ),
          )
          .orderBy(desc(scheduleSnapshots.fetchedAt))
          .get();
        return row ? { day: rowToDay(row), fetchedAt: row.fetchedAt } : null;
      },
      /** Every stored version (for schedule-change analytics). */
      versions(siteId: string, fromDate: string, toDate: string): ScheduleSnapshot[] {
        return db
          .select({
            date: scheduleSnapshots.date,
            fetchedAt: scheduleSnapshots.fetchedAt,
            status: scheduleSnapshots.status,
            signature: scheduleSnapshots.signature,
          })
          .from(scheduleSnapshots)
          .where(
            and(
              eq(scheduleSnapshots.siteId, siteId),
              gte(scheduleSnapshots.date, fromDate),
              lte(scheduleSnapshots.date, toDate),
            ),
          )
          .orderBy(asc(scheduleSnapshots.date), asc(scheduleSnapshots.fetchedAt))
          .all()
          .map((row) => ({ ...row, status: row.status as ScheduleStatus }));
      },
    },

    voltage: {
      /**
       * Store readings, thinning bursts: a reading is skipped when the previous stored one is
       * less than `minIntervalMs` older and has the same voltage. Returns how many were stored.
       */
      add(siteId: string, samples: readonly VoltageSample[], minIntervalMs = 10_000): number {
        let stored = 0;
        db.transaction((tx) => {
          let last = tx
            .select({ t: voltageSamples.t, voltage: voltageSamples.voltage })
            .from(voltageSamples)
            .where(eq(voltageSamples.siteId, siteId))
            .orderBy(desc(voltageSamples.t))
            .get();
          for (const sample of [...samples].sort((a, b) => a.t - b.t)) {
            if (last && sample.t - last.t < minIntervalMs && sample.voltage === last.voltage)
              continue;
            const result = tx
              .insert(voltageSamples)
              .values({ siteId, t: sample.t, voltage: sample.voltage })
              .onConflictDoNothing()
              .run();
            if (result.changes > 0) {
              stored++;
              last = sample;
            }
          }
        });
        return stored;
      },
      list(siteId: string, range: Interval): VoltageSample[] {
        return db
          .select({ t: voltageSamples.t, voltage: voltageSamples.voltage })
          .from(voltageSamples)
          .where(
            and(
              eq(voltageSamples.siteId, siteId),
              gte(voltageSamples.t, range.start),
              lt(voltageSamples.t, range.end),
            ),
          )
          .orderBy(asc(voltageSamples.t))
          .all();
      },
    },

    heartbeat: {
      /** Accumulate one minute of ESP heartbeat quality. */
      addMinute(
        siteId: string,
        deviceId: string,
        minute: number,
        stats: { packets: number; maxGapMs: number; reboots: number },
      ): void {
        db.insert(heartbeatMinutes)
          .values({ siteId, deviceId, minute, ...stats })
          .onConflictDoUpdate({
            target: [heartbeatMinutes.deviceId, heartbeatMinutes.minute],
            set: {
              packets: sql`${heartbeatMinutes.packets} + ${stats.packets}`,
              maxGapMs: sql`max(${heartbeatMinutes.maxGapMs}, ${stats.maxGapMs})`,
              reboots: sql`${heartbeatMinutes.reboots} + ${stats.reboots}`,
            },
          })
          .run();
      },
      list(deviceId: string, range: Interval) {
        return db
          .select()
          .from(heartbeatMinutes)
          .where(
            and(
              eq(heartbeatMinutes.deviceId, deviceId),
              gte(heartbeatMinutes.minute, range.start),
              lt(heartbeatMinutes.minute, range.end),
            ),
          )
          .orderBy(asc(heartbeatMinutes.minute))
          .all();
      },
    },

    outbox: {
      /** Returns the new id, or null when an item with the same dedupe key already exists. */
      enqueue(
        item: {
          siteId: string;
          channel: string;
          target: string;
          kind: string;
          payload: unknown;
          dedupeKey?: string;
        },
        now = Date.now(),
      ): number | null {
        const result = db
          .insert(notificationOutbox)
          .values({
            siteId: item.siteId,
            channel: item.channel,
            target: item.target,
            kind: item.kind,
            payloadJson: JSON.stringify(item.payload),
            dedupeKey: item.dedupeKey ?? null,
            nextAttemptAt: now,
            createdAt: now,
          })
          .onConflictDoNothing()
          .run();
        return result.changes > 0 ? Number(result.lastInsertRowid) : null;
      },
      due(now = Date.now(), limit = 50): OutboxItem[] {
        return db
          .select()
          .from(notificationOutbox)
          .where(
            and(
              eq(notificationOutbox.status, "pending"),
              lte(notificationOutbox.nextAttemptAt, now),
            ),
          )
          .orderBy(asc(notificationOutbox.nextAttemptAt), asc(notificationOutbox.id))
          .limit(limit)
          .all();
      },
      markSent(id: number, now = Date.now()): void {
        db.update(notificationOutbox)
          .set({ status: "sent", sentAt: now, attempts: sql`${notificationOutbox.attempts} + 1` })
          .where(eq(notificationOutbox.id, id))
          .run();
      },
      /** Retry at `nextAttemptAt`, or give up when it is null. */
      markFailed(id: number, error: string, nextAttemptAt: number | null): void {
        db.update(notificationOutbox)
          .set({
            status: nextAttemptAt === null ? "failed" : "pending",
            lastError: error,
            attempts: sql`${notificationOutbox.attempts} + 1`,
            ...(nextAttemptAt === null ? {} : { nextAttemptAt }),
          })
          .where(eq(notificationOutbox.id, id))
          .run();
      },
      /** Every pending item in creation order (the queue is small: it only holds undelivered items). */
      pending(): OutboxItem[] {
        return db
          .select()
          .from(notificationOutbox)
          .where(eq(notificationOutbox.status, "pending"))
          .orderBy(asc(notificationOutbox.id))
          .all();
      },
      /** Pull waiting retries of a site/channel forward to now (connectivity is back). 429s keep their wait. */
      retryNow(siteId: string, channel: string, now = Date.now()): number {
        return db
          .update(notificationOutbox)
          .set({ nextAttemptAt: now })
          .where(
            and(
              eq(notificationOutbox.siteId, siteId),
              eq(notificationOutbox.channel, channel),
              eq(notificationOutbox.status, "pending"),
              gt(notificationOutbox.nextAttemptAt, now),
              or(
                isNull(notificationOutbox.lastError),
                sql`${notificationOutbox.lastError} NOT LIKE '429%'`,
              ),
            ),
          )
          .run().changes;
      },
      stats(since: number): { pending: number; failed: number; sent: number } {
        const rows = db
          .select({ status: notificationOutbox.status, n: sql<number>`count(*)` })
          .from(notificationOutbox)
          .where(
            or(eq(notificationOutbox.status, "pending"), gte(notificationOutbox.createdAt, since)),
          )
          .groupBy(notificationOutbox.status)
          .all();
        const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
        return { pending: count("pending"), failed: count("failed"), sent: count("sent") };
      },
      get(id: number): OutboxItem | null {
        return (
          db.select().from(notificationOutbox).where(eq(notificationOutbox.id, id)).get() ?? null
        );
      },
    },

    reminders: {
      /** Atomically claim a reminder: true only for the first caller with this key. */
      claim(siteId: string, key: string, now = Date.now()): boolean {
        return (
          db.insert(reminderLog).values({ siteId, key, sentAt: now }).onConflictDoNothing().run()
            .changes > 0
        );
      },
      prune(before: number): number {
        return db.delete(reminderLog).where(lt(reminderLog.sentAt, before)).run().changes;
      },
    },

    push: {
      upsert(
        sub: {
          endpoint: string;
          siteId: string;
          p256dh: string;
          auth: string;
          preferences: unknown;
        },
        now = Date.now(),
      ): void {
        const row = {
          endpoint: sub.endpoint,
          siteId: sub.siteId,
          p256dh: sub.p256dh,
          auth: sub.auth,
          preferencesJson: JSON.stringify(sub.preferences),
          createdAt: now,
          updatedAt: now,
        };
        const { createdAt: _keep, ...update } = row;
        db.insert(pushSubscriptions)
          .values(row)
          .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: update })
          .run();
      },
      remove(endpoint: string): boolean {
        return (
          db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run()
            .changes > 0
        );
      },
      list(siteId: string) {
        return db
          .select()
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.siteId, siteId))
          .all()
          .map((row) => ({ ...row, preferences: JSON.parse(row.preferencesJson) as unknown }));
      },
    },

    telegram: {
      subscribe(siteId: string, chatId: number, threadId = 0, now = Date.now()): boolean {
        return (
          db
            .insert(telegramSubscribers)
            .values({ siteId, chatId, threadId, createdAt: now })
            .onConflictDoNothing()
            .run().changes > 0
        );
      },
      unsubscribe(siteId: string, chatId: number, threadId = 0): boolean {
        return (
          db
            .delete(telegramSubscribers)
            .where(
              and(
                eq(telegramSubscribers.siteId, siteId),
                eq(telegramSubscribers.chatId, chatId),
                eq(telegramSubscribers.threadId, threadId),
              ),
            )
            .run().changes > 0
        );
      },
      list(siteId: string) {
        return db
          .select()
          .from(telegramSubscribers)
          .where(eq(telegramSubscribers.siteId, siteId))
          .all();
      },
      /** /feed: subscribe the topic and make it read-only for everyone but its admins. */
      feed(siteId: string, chatId: number, threadId = 0, now = Date.now()): void {
        db.insert(telegramSubscribers)
          .values({ siteId, chatId, threadId, readOnly: true, createdAt: now })
          .onConflictDoUpdate({
            target: [
              telegramSubscribers.siteId,
              telegramSubscribers.chatId,
              telegramSubscribers.threadId,
            ],
            set: { readOnly: true },
          })
          .run();
      },
      isReadOnly(siteId: string, chatId: number, threadId = 0): boolean {
        const row = db
          .select({ readOnly: telegramSubscribers.readOnly })
          .from(telegramSubscribers)
          .where(
            and(
              eq(telegramSubscribers.siteId, siteId),
              eq(telegramSubscribers.chatId, chatId),
              eq(telegramSubscribers.threadId, threadId),
            ),
          )
          .get();
        return row?.readOnly === true;
      },
      /** /sub: subscribe when not subscribed, otherwise unsubscribe. Returns the new state. */
      toggle(siteId: string, chatId: number, threadId = 0, now = Date.now()): boolean {
        return db.transaction(() => {
          if (store.telegram.unsubscribe(siteId, chatId, threadId)) return false;
          store.telegram.subscribe(siteId, chatId, threadId, now);
          return true;
        });
      },
      /** A group became a supergroup: its chat id changed. */
      move(siteId: string, fromChatId: number, toChatId: number, now = Date.now()): void {
        db.transaction(() => {
          for (const row of store.telegram.list(siteId)) {
            if (row.chatId !== fromChatId) continue;
            store.telegram.unsubscribe(siteId, row.chatId, row.threadId);
            store.telegram.subscribe(siteId, toChatId, row.threadId, now);
            if (row.readOnly) store.telegram.feed(siteId, toChatId, row.threadId, now);
          }
        });
      },
    },
  };
  return store;
}

function rowToDay(row: typeof scheduleSnapshots.$inferSelect): DaySchedule {
  const slots = (JSON.parse(row.slotsJson) as [number, number, string][]).map(
    ([start, end, type]) => ({
      start,
      end,
      type,
    }),
  );
  return { ...parseDay({ date: row.date, status: row.rawStatus, slots }), date: row.date };
}
