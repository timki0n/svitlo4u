/**
 * SQLite schema. All instants are epoch milliseconds (INTEGER), calendar dates are 'YYYY-MM-DD'.
 * Every table carries site_id so several locations live in one database.
 */
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** Locations. Source of truth is the config file; rows are upserted at startup. */
export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tz: text("tz").notNull(),
  yasnoRegion: integer("yasno_region").notNull(),
  yasnoDso: integer("yasno_dso").notNull(),
  yasnoGroup: text("yasno_group").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Persisted power detector state (one row per site, rewritten every few seconds). */
export const detectorState = sqliteTable("detector_state", {
  siteId: text("site_id")
    .primaryKey()
    .references(() => sites.id),
  stateJson: text("state_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Everything the detector decided, append-only (audit + analytics of Wi-Fi gaps and blips). */
export const powerEvents = sqliteTable(
  "power_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    /** off | on | false-alarm | blip | network-gap */
    type: text("type").notNull(),
    at: integer("at").notNull(),
    /** End of a blip / network gap. */
    until: integer("until"),
    detectedAt: integer("detected_at").notNull(),
    reason: text("reason"),
    approximate: integer("approximate", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("power_events_site_at").on(t.siteId, t.at)],
);

/** Outages derived from power events (and imported history). */
export const outages = sqliteTable(
  "outages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    start: integer("start").notNull(),
    /** null while ongoing. */
    end: integer("end"),
    startApproximate: integer("start_approximate", { mode: "boolean" }).notNull().default(false),
    falseAlarm: integer("false_alarm", { mode: "boolean" }).notNull().default(false),
    /** detector | legacy */
    source: text("source").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("outages_site_start").on(t.siteId, t.start),
    index("outages_site_end").on(t.siteId, t.end),
  ],
);

/** Every distinct version of a day's schedule, as fetched from Yasno. */
export const scheduleSnapshots = sqliteTable(
  "schedule_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    /** Day the schedule is for. */
    date: text("date").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
    status: text("status").notNull(),
    rawStatus: text("raw_status").notNull(),
    /** [[start_min, end_min, type], …] */
    slotsJson: text("slots_json").notNull(),
    signature: text("signature").notNull(),
    updatedOn: text("updated_on"),
    /** poller | legacy */
    source: text("source").notNull(),
  },
  (t) => [
    index("schedule_snapshots_site_date").on(t.siteId, t.date, t.fetchedAt),
    uniqueIndex("schedule_snapshots_version").on(t.siteId, t.date, t.fetchedAt),
  ],
);

/** Plug voltage readings. */
export const voltageSamples = sqliteTable(
  "voltage_samples",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    t: integer("t").notNull(),
    voltage: real("voltage").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.t] })],
);

/** Per-minute ESP heartbeat quality (packets, gaps, reboots) — not every packet. */
export const heartbeatMinutes = sqliteTable(
  "heartbeat_minutes",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    deviceId: text("device_id").notNull(),
    minute: integer("minute").notNull(),
    packets: integer("packets").notNull().default(0),
    maxGapMs: integer("max_gap_ms").notNull().default(0),
    reboots: integer("reboots").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.minute] })],
);

/** Notifications waiting for delivery or retry. Sent immediately; the row only guards retries. */
export const notificationOutbox = sqliteTable(
  "notification_outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    /** telegram | webpush | mobile */
    channel: text("channel").notNull(),
    /** Chat id, push endpoint or "broadcast". */
    target: text("target").notNull(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json").notNull(),
    /** Same key → enqueued once. */
    dedupeKey: text("dedupe_key"),
    /** pending | sent | failed */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (t) => [
    uniqueIndex("notification_outbox_dedupe").on(t.dedupeKey),
    index("notification_outbox_due").on(t.status, t.nextAttemptAt),
  ],
);

/** Reminders already sent (survives restarts). */
export const reminderLog = sqliteTable(
  "reminder_log",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    key: text("key").notNull(),
    sentAt: integer("sent_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.key] })],
);

/** Web Push subscriptions with per-subscriber preferences. */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  siteId: text("site_id")
    .notNull()
    .references(() => sites.id),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  preferencesJson: text("preferences_json").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Personal Telegram subscriptions (/sub), on top of the configured group chats. */
export const telegramSubscribers = sqliteTable(
  "telegram_subscribers",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    chatId: integer("chat_id").notNull(),
    threadId: integer("thread_id").notNull().default(0),
    /** A feed topic (/feed): only its admins may write there, the bot deletes everything else. */
    readOnly: integer("read_only", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.chatId, t.threadId] })],
);

/** Players of the window game: a Telegram user as their Mini App last introduced them. */
export const gamePlayers = sqliteTable(
  "game_players",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    userId: integer("user_id").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    username: text("username"),
    /** Profile photo saved by the core (file name); null = none or not fetched yet. */
    avatar: text("avatar"),
    avatarCheckedAt: integer("avatar_checked_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.userId] })],
);

/** Windows solved: one row per player and window of a session (a session = an outage). */
export const gameSolves = sqliteTable(
  "game_solves",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    /** Start of the outage the session belongs to. */
    session: integer("session").notNull(),
    floor: integer("floor").notNull(),
    col: integer("col").notNull(),
    userId: integer("user_id").notNull(),
    points: integer("points").notNull(),
    durationMs: integer("duration_ms").notNull(),
    solvedAt: integer("solved_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.session, t.floor, t.col, t.userId] }),
    index("game_solves_by_time").on(t.siteId, t.solvedAt),
  ],
);
