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

/**
 * Locations (buildings). `origin` "config": sites.yaml is the source of truth, the row is upserted
 * at startup. "owner": created by a hub's owner in the bot; this row is the source of truth.
 */
export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tz: text("tz").notNull(),
  yasnoRegion: integer("yasno_region").notNull(),
  yasnoDso: integer("yasno_dso").notNull(),
  yasnoGroup: text("yasno_group").notNull(),
  /** "public": listed on the site; "link": only by its address (a private house). */
  access: text("access").notNull().default("public"),
  origin: text("origin").notNull().default("config"),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Hubs (docs/hub-protocol.md). A hub made at the bench has its secret here and no site until its
 * owner claims it; a hub from sites.yaml keeps its secret in the environment (null here) and gets
 * a row only for its owner.
 */
export const hubs = sqliteTable(
  "hubs",
  {
    id: text("id").primaryKey(),
    /** Hex HMAC key; null when it is in the environment (sites.yaml `secretEnv`). */
    secret: text("secret"),
    siteId: text("site_id").references(() => sites.id),
    /** Telegram user id of the owner: hub alerts and «Мої будинки». */
    ownerUserId: integer("owner_user_id"),
    /** sites.yaml-like policy: "latest", "off" or a pinned "x.y.z". */
    firmware: text("firmware").notNull().default("latest"),
    createdAt: integer("created_at").notNull(),
    claimedAt: integer("claimed_at"),
  },
  (t) => [index("hubs_by_owner").on(t.ownerUserId)],
);

/** A Telegram user's building ("my building" on every device, the Mini App's start). */
export const telegramUsers = sqliteTable("telegram_users", {
  userId: integer("user_id").primaryKey(),
  siteId: text("site_id").references(() => sites.id),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Groups and channels the bot is in, as Telegram last told it (my_chat_member): who added it and
 * what it may do there. The building a chat follows lives in telegram_subscribers.
 */
export const telegramChats = sqliteTable("telegram_chats", {
  chatId: integer("chat_id").primaryKey(),
  /** group | supergroup | channel */
  type: text("type").notNull(),
  title: text("title"),
  /** The Telegram user who added the bot. */
  addedBy: integer("added_by"),
  /** The bot there: member | administrator | restricted | left | kicked */
  status: text("status").notNull(),
  canDelete: integer("can_delete", { mode: "boolean" }).notNull().default(false),
  canPost: integer("can_post", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Addresses of buildings, as YASNO knows them (its street and house ids): the address search finds
 * a public building by one; an owner's building keeps the address it was created with.
 */
export const siteAddresses = sqliteTable(
  "site_addresses",
  {
    streetId: integer("street_id").notNull(),
    houseId: integer("house_id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    /** "вул. Хрещатик, 22" */
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.streetId, t.houseId] }),
    index("site_addresses_by_site").on(t.siteId),
  ],
);

/** Buildings a Telegram user keeps at hand (★ in «Мої будинки»). */
export const telegramFavorites = sqliteTable(
  "telegram_favorites",
  {
    userId: integer("user_id").notNull(),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.siteId] })],
);

/** «Залишити заявку»: someone wants Світло4U at an address that has no building yet. */
export const requests = sqliteTable(
  "requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    streetId: integer("street_id").notNull(),
    houseId: integer("house_id").notNull(),
    address: text("address").notNull(),
    /** The YASNO queue there, "12.1". */
    yasnoGroup: text("yasno_group"),
    /**
     * The person can run Світло4U in the building (set it up, the building's chats). The three
     * below are asked only then (false otherwise).
     */
    canAdmin: integer("can_admin", { mode: "boolean" }).notNull(),
    /** An old Android phone that can stay on charge: it could watch the power there. */
    sparePhone: integer("spare_phone", { mode: "boolean" }).notNull(),
    /** The router (and internet) keep working when the light goes. */
    routerOk: integer("router_ok", { mode: "boolean" }).notNull(),
    /** They want the voltage in volts (a plug that measures it). */
    wantsVoltage: integer("wants_voltage", { mode: "boolean" }).notNull(),
    /** Phone or @telegram typed on the site; null from the Mini App (the user is known). */
    contact: text("contact"),
    userId: integer("user_id"),
    username: text("username"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("requests_by_time").on(t.createdAt)],
);

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

/**
 * A hub's Wi-Fi as it reports it (firmware 0.2.5+): a row when something changed — a drop, a
 * reconnect the watchdog forced, a report without an answer, the channel, a new boot — and at
 * least every 10 minutes. Counters run since the hub's boot.
 */
export const hubHealth = sqliteTable(
  "hub_health",
  {
    hubId: text("hub_id").notNull(),
    t: integer("t").notNull(),
    boot: text("boot").notNull(),
    /** The router's signal at the hub, dBm, and its channel. */
    wifiRssi: integer("wifi_rssi"),
    wifiChannel: integer("wifi_channel"),
    drops: integer("drops").notNull(),
    /** The last drop: its reason (esp_wifi codes) and how long it lasted, s. */
    dropReason: integer("drop_reason").notNull(),
    lastDown: real("last_down").notNull(),
    kicks: integer("kicks").notNull(),
    /** Reports that got no answer on either connection / that the second try saved. */
    lost: integer("lost").notNull(),
    redone: integer("redone").notNull(),
    plugRssi: integer("plug_rssi"),
    plugGaps: integer("plug_gaps"),
  },
  (t) => [primaryKey({ columns: [t.hubId, t.t] })],
);

/**
 * Every boot of a hub the core heard of: why it started (`rst`, as in its reports) and, when the
 * hub restarted itself, its own word on it (`why`, firmware 0.2.6+: the watchdog's rule, an
 * update, the setup page). On 2026-11-20 a hub restarted 85 minutes into a morning without
 * internet and nothing kept why.
 */
export const hubBoots = sqliteTable(
  "hub_boots",
  {
    hubId: text("hub_id").notNull(),
    boot: text("boot").notNull(),
    /** When the core first heard of the boot, and when it began (by the hub's uptime). */
    t: integer("t").notNull(),
    startedAt: integer("started_at").notNull(),
    rst: text("rst").notNull(),
    why: text("why"),
    fw: text("fw"),
  },
  (t) => [primaryKey({ columns: [t.hubId, t.boot] })],
);

/**
 * The plug's silences of 3 s and more as the hub journals them (firmware 0.2.6+): how long, what
 * the radio and Wi-Fi did meanwhile, what ended it. For learning why a plug with the mains on goes
 * quiet (the false outages of 2026-11-18 and 2026-11-20).
 */
export const hubSilences = sqliteTable(
  "hub_silences",
  {
    hubId: text("hub_id").notNull(),
    boot: text("boot").notNull(),
    /** The plug's last answer before it: hub uptime, ms (with `boot` it names the silence)… */
    upMs: integer("up_ms").notNull(),
    /** …and the same moment by the core's clock. */
    t: integer("t").notNull(),
    lenMs: integer("len_ms").notNull(),
    /** Reads within it that the radio delivered / did not. */
    readsOk: integer("reads_ok").notNull(),
    readsFailed: integer("reads_failed").notNull(),
    /** Of it, Wi-Fi had the radio, ms. */
    heldMs: integer("held_ms").notNull(),
    /** Requests to the core started within it, those of them on a new connection, Wi-Fi drops. */
    reports: integer("reports").notNull(),
    conns: integer("conns").notNull(),
    drops: integer("drops").notNull(),
    /** From the start of the last request before it to its start; of the last request to its end. */
    sinceReportMs: integer("since_report_ms"),
    endSinceReportMs: integer("end_since_report_ms"),
    /** The plug's message that ended it: read, report, default, announce. */
    end: text("end").notNull(),
    /** Told as an outage; outlasted the alert delay and the plug answered in the last look. */
    off: integer("off", { mode: "boolean" }).notNull(),
    saved: integer("saved", { mode: "boolean" }).notNull(),
    plugRssi: integer("plug_rssi"),
  },
  (t) => [primaryKey({ columns: [t.hubId, t.boot, t.upMs] })],
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

/**
 * «Вечорниці»: the ground floor's doors, each in three parts. A part is opened once per session by
 * one player, and a player opens at most one part of a door.
 */
export const gameUnlocks = sqliteTable(
  "game_unlocks",
  {
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    session: integer("session").notNull(),
    door: integer("door").notNull(),
    part: integer("part").notNull(),
    userId: integer("user_id").notNull(),
    unlockedAt: integer("unlocked_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.session, t.door, t.part] }),
    uniqueIndex("game_unlocks_one_part").on(t.siteId, t.session, t.door, t.userId),
  ],
);

/**
 * Points won and lost besides windows: a door's part opened, a game of «Вечорниці» played. They
 * count in the session they belong to, like windows.
 */
export const gameLedger = sqliteTable(
  "game_ledger",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    siteId: text("site_id")
      .notNull()
      .references(() => sites.id),
    session: integer("session").notNull(),
    userId: integer("user_id").notNull(),
    /** Points won (+) or lost (−). */
    points: integer("points").notNull(),
    /** door | poker | battle */
    kind: text("kind").notNull(),
    /** What it was for: "door 3 part 2", a table and hand. */
    ref: text("ref").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [
    index("game_ledger_by_session").on(t.siteId, t.session),
    index("game_ledger_by_time").on(t.siteId, t.at),
  ],
);
