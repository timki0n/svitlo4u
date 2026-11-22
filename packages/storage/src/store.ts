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
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "./db.ts";
import {
  detectorState,
  gameLedger,
  gamePlayers,
  gameSolves,
  gameUnlocks,
  heartbeatMinutes,
  hubBoots,
  hubHealth,
  hubSilences,
  hubs,
  notificationOutbox,
  outages,
  powerEvents,
  pushSubscriptions,
  reminderLog,
  requests,
  scheduleSnapshots,
  siteAddresses,
  sites,
  telegramChats,
  telegramFavorites,
  telegramSubscribers,
  telegramUsers,
  voltageSamples,
} from "./schema.ts";

export type SiteRow = typeof sites.$inferInsert;
export type HubRow = typeof hubs.$inferSelect;
export type TelegramChatRow = typeof telegramChats.$inferSelect;
export type RequestRow = typeof requests.$inferSelect;
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
      /** Buildings their owners created in the bot (origin "owner"), oldest first. */
      listOwned() {
        return db
          .select()
          .from(sites)
          .where(eq(sites.origin, "owner"))
          .orderBy(asc(sites.updatedAt))
          .all();
      },
      rename(id: string, name: string, now = Date.now()): boolean {
        return (
          db.update(sites).set({ name, updatedAt: now }).where(eq(sites.id, id)).run().changes > 0
        );
      },
    },

    hubs: {
      get(id: string): HubRow | null {
        return db.select().from(hubs).where(eq(hubs.id, id)).get() ?? null;
      },
      /** A hub made at the bench: its secret, no site and no owner yet. */
      create(id: string, secret: string | null, now = Date.now()): HubRow {
        const row = { id, secret, createdAt: now };
        db.insert(hubs).values(row).run();
        return store.hubs.get(id) as HubRow;
      },
      /** The row of a sites.yaml hub (its secret stays in the environment). */
      ensure(id: string, siteId: string, now = Date.now()): HubRow {
        db.insert(hubs)
          .values({ id, secret: null, siteId, createdAt: now })
          .onConflictDoNothing()
          .run();
        return store.hubs.get(id) as HubRow;
      },
      /** Bench hubs (with their own secret). */
      listWithSecret(): HubRow[] {
        return db
          .select()
          .from(hubs)
          .where(sql`${hubs.secret} is not null`)
          .orderBy(asc(hubs.createdAt))
          .all();
      },
      listByOwner(userId: number): HubRow[] {
        return db
          .select()
          .from(hubs)
          .where(eq(hubs.ownerUserId, userId))
          .orderBy(asc(hubs.claimedAt))
          .all();
      },
      /** The owner takes the hub (and, for a new building, puts it there). */
      claim(id: string, userId: number, siteId: string | null, now = Date.now()): void {
        db.update(hubs)
          .set({ ownerUserId: userId, claimedAt: now, ...(siteId !== null ? { siteId } : {}) })
          .where(eq(hubs.id, id))
          .run();
      },
      setOwner(id: string, userId: number | null, now = Date.now()): void {
        db.update(hubs).set({ ownerUserId: userId, claimedAt: now }).where(eq(hubs.id, id)).run();
      },
    },

    telegramChats: {
      get(chatId: number): TelegramChatRow | null {
        return (
          db.select().from(telegramChats).where(eq(telegramChats.chatId, chatId)).get() ?? null
        );
      },
      /** What Telegram said about the bot there (my_chat_member). `addedBy` only when it joined. */
      upsert(
        row: Omit<TelegramChatRow, "updatedAt" | "addedBy"> & { addedBy?: number },
        now = Date.now(),
      ): void {
        const values = { ...row, updatedAt: now };
        db.insert(telegramChats)
          .values(values)
          .onConflictDoUpdate({ target: telegramChats.chatId, set: values })
          .run();
      },
      /** A chat seen from a message (/start in a group): its name and who brought the bot. */
      touch(
        chat: { chatId: number; type: string; title: string | null; addedBy?: number },
        now = Date.now(),
      ): void {
        const known = store.telegramChats.get(chat.chatId);
        if (!known) {
          db.insert(telegramChats)
            .values({ ...chat, status: "member", updatedAt: now })
            .run();
          return;
        }
        db.update(telegramChats)
          .set({
            type: chat.type,
            title: chat.title,
            ...(chat.addedBy !== undefined && known.addedBy === null
              ? { addedBy: chat.addedBy }
              : {}),
            updatedAt: now,
          })
          .where(eq(telegramChats.chatId, chat.chatId))
          .run();
      },
    },

    siteAddresses: {
      /** The building at a YASNO address, if one is there. */
      siteAt(streetId: number, houseId: number): string | null {
        return (
          db
            .select({ siteId: siteAddresses.siteId })
            .from(siteAddresses)
            .where(and(eq(siteAddresses.streetId, streetId), eq(siteAddresses.houseId, houseId)))
            .get()?.siteId ?? null
        );
      },
      /** The address belongs to this building (from now on). */
      attach(
        siteId: string,
        address: { streetId: number; houseId: number; text: string },
        now = Date.now(),
      ): void {
        const row = { ...address, siteId, createdAt: now };
        db.insert(siteAddresses)
          .values(row)
          .onConflictDoUpdate({
            target: [siteAddresses.streetId, siteAddresses.houseId],
            set: { siteId, text: address.text },
          })
          .run();
      },
      of(siteId: string) {
        return db.select().from(siteAddresses).where(eq(siteAddresses.siteId, siteId)).all();
      },
    },

    favorites: {
      list(userId: number): string[] {
        return db
          .select({ siteId: telegramFavorites.siteId })
          .from(telegramFavorites)
          .where(eq(telegramFavorites.userId, userId))
          .orderBy(asc(telegramFavorites.createdAt))
          .all()
          .map((r) => r.siteId);
      },
      add(userId: number, siteId: string, now = Date.now()): void {
        db.insert(telegramFavorites)
          .values({ userId, siteId, createdAt: now })
          .onConflictDoNothing()
          .run();
      },
      remove(userId: number, siteId: string): void {
        db.delete(telegramFavorites)
          .where(and(eq(telegramFavorites.userId, userId), eq(telegramFavorites.siteId, siteId)))
          .run();
      },
    },

    requests: {
      add(row: Omit<RequestRow, "id">): number {
        return Number(db.insert(requests).values(row).run().lastInsertRowid);
      },
      list(limit = 100): RequestRow[] {
        return db.select().from(requests).orderBy(desc(requests.createdAt)).limit(limit).all();
      },
    },

    telegramUsers: {
      site(userId: number): string | null {
        return (
          db
            .select({ siteId: telegramUsers.siteId })
            .from(telegramUsers)
            .where(eq(telegramUsers.userId, userId))
            .get()?.siteId ?? null
        );
      },
      setSite(userId: number, siteId: string, now = Date.now()): void {
        db.insert(telegramUsers)
          .values({ userId, siteId, updatedAt: now })
          .onConflictDoUpdate({ target: telegramUsers.userId, set: { siteId, updatedAt: now } })
          .run();
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
      /** The latest real outage that has begun by `now` (ongoing or over). */
      latest(siteId: string, now: number) {
        return (
          db
            .select({ start: outages.start, end: outages.end })
            .from(outages)
            .where(
              and(
                eq(outages.siteId, siteId),
                lte(outages.start, now),
                eq(outages.falseAlarm, false),
              ),
            )
            .orderBy(desc(outages.start))
            .get() ?? null
        );
      },
      /** The outages that began at these instants (the game's sessions): start and end. */
      startingAt(siteId: string, starts: readonly number[]) {
        if (starts.length === 0) return [];
        return db
          .select({ start: outages.start, end: outages.end })
          .from(outages)
          .where(and(eq(outages.siteId, siteId), inArray(outages.start, [...starts])))
          .all();
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
      /** The latest published version of `date` (a schedule with or without outages). */
      lastPublished(siteId: string, date: string): DaySchedule | null {
        const row = db
          .select()
          .from(scheduleSnapshots)
          .where(
            and(
              eq(scheduleSnapshots.siteId, siteId),
              eq(scheduleSnapshots.date, date),
              inArray(scheduleSnapshots.status, ["ScheduleApplies", "NoOutages"]),
            ),
          )
          .orderBy(desc(scheduleSnapshots.fetchedAt))
          .get();
        return row ? rowToDay(row) : null;
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

    hubHealth: {
      /** One reading of a hub's Wi-Fi (see the schema: on a change and every 10 minutes). */
      add(row: typeof hubHealth.$inferInsert): void {
        db.insert(hubHealth).values(row).onConflictDoNothing().run();
      },
      list(hubId: string, range: Interval) {
        return db
          .select()
          .from(hubHealth)
          .where(
            and(
              eq(hubHealth.hubId, hubId),
              gte(hubHealth.t, range.start),
              lt(hubHealth.t, range.end),
            ),
          )
          .orderBy(asc(hubHealth.t))
          .all();
      },
    },

    hubBoots: {
      /** A boot of a hub; one the core already has stays as it is. */
      add(row: typeof hubBoots.$inferInsert): void {
        db.insert(hubBoots).values(row).onConflictDoNothing().run();
      },
      list(hubId: string) {
        return db
          .select()
          .from(hubBoots)
          .where(eq(hubBoots.hubId, hubId))
          .orderBy(asc(hubBoots.t))
          .all();
      },
    },

    hubSilences: {
      /** A silence of the plug from a hub's journal; one told twice (a lost answer) is kept once. */
      add(row: typeof hubSilences.$inferInsert): void {
        db.insert(hubSilences).values(row).onConflictDoNothing().run();
      },
      list(hubId: string, range: Interval) {
        return db
          .select()
          .from(hubSilences)
          .where(
            and(
              eq(hubSilences.hubId, hubId),
              gte(hubSilences.t, range.start),
              lt(hubSilences.t, range.end),
            ),
          )
          .orderBy(asc(hubSilences.t))
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

    game: {
      upsertPlayer(
        siteId: string,
        user: {
          userId: number;
          firstName: string;
          lastName: string | null;
          username: string | null;
        },
        now = Date.now(),
      ): void {
        db.insert(gamePlayers)
          .values({ siteId, ...user, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: [gamePlayers.siteId, gamePlayers.userId],
            set: {
              firstName: user.firstName,
              lastName: user.lastName,
              username: user.username,
              updatedAt: now,
            },
          })
          .run();
      },
      player(siteId: string, userId: number) {
        return (
          db
            .select()
            .from(gamePlayers)
            .where(and(eq(gamePlayers.siteId, siteId), eq(gamePlayers.userId, userId)))
            .get() ?? null
        );
      },
      players(siteId: string, userIds: readonly number[]) {
        if (userIds.length === 0) return [];
        return db
          .select()
          .from(gamePlayers)
          .where(and(eq(gamePlayers.siteId, siteId), inArray(gamePlayers.userId, [...userIds])))
          .all();
      },
      setAvatar(siteId: string, userId: number, avatar: string | null, now = Date.now()): void {
        db.update(gamePlayers)
          .set({ avatar, avatarCheckedAt: now })
          .where(and(eq(gamePlayers.siteId, siteId), eq(gamePlayers.userId, userId)))
          .run();
      },
      /** Record a solved window; false when this player already solved it in the session. */
      addSolve(row: typeof gameSolves.$inferInsert): boolean {
        return db.insert(gameSolves).values(row).onConflictDoNothing().run().changes > 0;
      },
      solves(siteId: string, session: number) {
        return db
          .select()
          .from(gameSolves)
          .where(and(eq(gameSolves.siteId, siteId), eq(gameSolves.session, session)))
          .orderBy(asc(gameSolves.solvedAt))
          .all();
      },
      /**
       * Empty the facade of a session for everyone, keeping the points: its solves move under the
       * negative session, which the facade never reads but its totals still count; the windows can
       * be lit again. Returns how many solves moved.
       */
      clearFacade(siteId: string, session: number): number {
        return db
          .update(gameSolves)
          .set({ session: -session })
          .where(and(eq(gameSolves.siteId, siteId), eq(gameSolves.session, session)))
          .run().changes;
      },
      /**
       * Points and windows per player, best first: of one session, since an instant, or ever. The
       * points are the windows' and the ledger's (doors opened, «Вечорниці» won and lost).
       */
      totals(siteId: string, filter: { session?: number; since?: number } = {}) {
        // a session's points include its solves cleared from the facade (clearFacade)
        const inSession = (column: string) =>
          filter.session === undefined
            ? sql``
            : sql` and ${sql.raw(column)} in (${filter.session}, ${-filter.session})`;
        const since = (column: string) =>
          filter.since === undefined ? sql`` : sql` and ${sql.raw(column)} >= ${filter.since}`;
        return db.all<{ userId: number; points: number; windows: number; last: number }>(sql`
          select user_id as userId, sum(points) as points, sum(windows) as windows, max(at) as last
          from (
            select user_id, points, 1 as windows, solved_at as at from game_solves
            where site_id = ${siteId}${inSession("session")}${since("solved_at")}
            union all
            select user_id, points, 0 as windows, at from game_ledger
            where site_id = ${siteId}${inSession("session")}${since("at")}
          )
          group by user_id
          order by sum(points) desc, max(at) asc`);
      },
      /** Open a door's part; false when it is open already or the player opened another part. */
      unlock(row: typeof gameUnlocks.$inferInsert): boolean {
        return db.insert(gameUnlocks).values(row).onConflictDoNothing().run().changes > 0;
      },
      /** The doors' parts opened in a session. */
      unlocks(siteId: string, session: number) {
        return db
          .select()
          .from(gameUnlocks)
          .where(and(eq(gameUnlocks.siteId, siteId), eq(gameUnlocks.session, session)))
          .orderBy(asc(gameUnlocks.unlockedAt))
          .all();
      },
      /** Points won or lost besides windows. */
      addLedger(row: Omit<typeof gameLedger.$inferInsert, "id">): void {
        db.insert(gameLedger).values(row).run();
      },
      /**
       * Every building lit, one per stored session (a negative one is a facade emptied during its
       * outage, see clearFacade): windows lit, solves, players and points.
       */
      buildings(siteId: string) {
        return db
          .select({
            session: gameSolves.session,
            windows: sql<number>`count(distinct ${gameSolves.floor} * 1000 + ${gameSolves.col})`,
            solves: sql<number>`count(*)`,
            players: sql<number>`count(distinct ${gameSolves.userId})`,
            points: sql<number>`sum(${gameSolves.points})`,
          })
          .from(gameSolves)
          .where(eq(gameSolves.siteId, siteId))
          .groupBy(gameSolves.session)
          .all();
      },
      /** How many windows of each building every player lit first. */
      firsts(siteId: string) {
        return db.all<{ session: number; userId: number; firsts: number }>(sql`
          select session, user_id as userId, count(*) as firsts from (
            select session, user_id, row_number() over (
              partition by session, floor, col order by solved_at, user_id
            ) as n
            from ${gameSolves} where site_id = ${siteId}
          ) where n = 1 group by session, user_id`);
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
      /** A followed chat (topic) becomes a feed, or writable again; false when it follows nothing. */
      setReadOnly(siteId: string, chatId: number, threadId: number, readOnly: boolean): boolean {
        return (
          db
            .update(telegramSubscribers)
            .set({ readOnly })
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
      /** Everything a chat follows, its topics included. */
      ofChat(chatId: number) {
        return db
          .select()
          .from(telegramSubscribers)
          .where(eq(telegramSubscribers.chatId, chatId))
          .all();
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
      /** Buildings a chat (topic) is subscribed to. */
      sitesOf(chatId: number, threadId = 0): string[] {
        return db
          .select({ siteId: telegramSubscribers.siteId })
          .from(telegramSubscribers)
          .where(
            and(eq(telegramSubscribers.chatId, chatId), eq(telegramSubscribers.threadId, threadId)),
          )
          .orderBy(asc(telegramSubscribers.createdAt))
          .all()
          .map((r) => r.siteId);
      },
      /** The chat (topic) follows this building only: its other subscriptions go. */
      follow(siteId: string, chatId: number, threadId = 0, now = Date.now()): void {
        db.transaction(() => {
          for (const other of store.telegram.sitesOf(chatId, threadId)) {
            if (other !== siteId) store.telegram.unsubscribe(other, chatId, threadId);
          }
          store.telegram.subscribe(siteId, chatId, threadId, now);
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
