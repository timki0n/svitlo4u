import {
  DEFAULT_DETECTOR_CONFIG,
  formatHHMM,
  KYIV_TZ,
  parseDay,
  type ReminderEvent,
  zonedToEpoch,
} from "@svitlo/domain";
import { closeDatabase, createStore, type Db, openDatabase, type Store } from "@svitlo/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HeartbeatEvent } from "../adapters/heartbeat.ts";
import type { YasnoUpdate } from "../adapters/yasno.ts";
import { type CoreEvents, EventBus } from "../runtime/bus.ts";
import { ManualClock } from "../runtime/clock.ts";
import type { SiteConfig } from "../sites-config.ts";
import { PowerService } from "./power.ts";
import { ReminderService } from "./reminders.ts";
import { ScheduleService } from "./schedule.ts";
import { SiteStateStore } from "./state.ts";

const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return zonedToEpoch(date, h * 60 + m, KYIV_TZ);
};
const T0 = at("2026-11-10", "08:00");

const site: SiteConfig = {
  id: "4u",
  name: "ЖК 4U",
  tz: KYIV_TZ,
  linkUrl: "https://svitlo4u.info",
  yasno: { region: 25, dso: 902, group: "12.1" },
  esp: [
    {
      id: "esp-4u",
      kind: "esp",
      transport: "udp",
      secretEnv: "X",
      legacyIps: [],
      siteId: "4u",
      secret: "s",
    },
  ],
  plug: { id: "4u-plug", kind: "plug", zigbeeName: "4u-plug", siteId: "4u" },
  detector: { ...DEFAULT_DETECTOR_CONFIG, zigbee: true },
  telegram: null,
};

let db: Db;
let store: Store;
let clock: ManualClock;
let bus: EventBus<CoreEvents>;
let state: SiteStateStore;
let events: { type: keyof CoreEvents; payload: unknown }[];

beforeEach(() => {
  db = openDatabase(":memory:");
  store = createStore(db);
  store.sites.upsert({
    id: "4u",
    name: "ЖК 4U",
    tz: KYIV_TZ,
    yasnoRegion: 25,
    yasnoDso: 902,
    yasnoGroup: "12.1",
  });
  clock = new ManualClock(T0);
  bus = new EventBus((type, err) => {
    throw new Error(`${String(type)}: ${String(err)}`);
  });
  state = new SiteStateStore([site]);
  events = [];
  for (const type of [
    "power.changed",
    "power.false-alarm",
    "power.network-gap",
    "schedule.notification",
    "reminder.due",
  ] as const) {
    bus.on(type, (payload) => {
      events.push({ type, payload });
    });
  }
});
afterEach(() => closeDatabase(db));

function heartbeat(t: number, up: number, boot = "b1"): HeartbeatEvent {
  return {
    siteId: "4u",
    deviceId: "esp-4u",
    t,
    up,
    boot,
    resetReason: "poweron",
    transport: "udp",
    remote: "x",
  };
}

describe("PowerService", () => {
  function setup(plugAlive: () => boolean) {
    let service: PowerService | null = null;
    service = new PowerService({
      site,
      store,
      bus,
      clock,
      state,
      probe: () => {
        // The plug answers synchronously in the same instant when it has power.
        if (plugAlive())
          service?.onPlug({ siteId: "4u", deviceId: "4u-plug", t: clock.now(), voltage: 231 });
        return true;
      },
    });
    service.start();
    return service;
  }

  it("packets stop → 'off' 9 s after the last packet, stored, persisted; back at the ESP boot moment", () => {
    let mains = true;
    const service = setup(() => mains);
    for (let s = 1; s <= 30; s++) {
      clock.advanceTo(T0 + s * 1000);
      service.onHeartbeat(heartbeat(clock.now(), 1000 + s));
    }
    mains = false; // power lost right after the packet at +30 s
    clock.advanceTo(T0 + 60_000);

    const off = events.find((e) => e.type === "power.changed")
      ?.payload as CoreEvents["power.changed"];
    expect(off).toMatchObject({
      state: "off",
      at: T0 + 30_000,
      detectedAt: T0 + 39_000,
      reason: "probe-timeout",
    });
    expect(off.previousSince).toBe(T0 + 1000 - 1001 * 1000); // light was on since the ESP booted
    expect(state.get("4u").power).toBe("off");
    expect(store.outages.open("4u")?.start).toBe(T0 + 30_000);
    expect(store.detector.load("4u")?.power).toBe("off");

    clock.advanceTo(T0 + 600_000);
    mains = true;
    service.onHeartbeat(heartbeat(clock.now(), 5, "b2"));
    const on = events.filter((e) => e.type === "power.changed")[1]
      ?.payload as CoreEvents["power.changed"];
    expect(on).toMatchObject({
      state: "on",
      at: T0 + 595_000,
      reason: "esp-reboot",
      previousSince: T0 + 30_000,
    });
    expect(store.outages.list("4u", { start: T0, end: T0 + 700_000 })).toEqual([
      { start: T0 + 30_000, end: T0 + 595_000, falseAlarm: false },
    ]);
    service.stop();
  });

  it("an 11 s Wi-Fi gap with a live plug is only a logged gap; heartbeat minutes are stored", () => {
    const service = setup(() => true);
    for (let s = 1; s <= 20; s++) {
      clock.advanceTo(T0 + s * 1000);
      service.onHeartbeat(heartbeat(clock.now(), 1000 + s));
    }
    clock.advanceTo(T0 + 31_000);
    service.onHeartbeat(heartbeat(clock.now(), 1031));
    clock.advanceTo(T0 + 125_000);
    expect(events.map((e) => e.type)).toEqual(["power.network-gap"]);
    service.stop();
    const minutes = store.heartbeat.list("esp-4u", { start: T0, end: T0 + 120_000 });
    expect(minutes.reduce((n, m) => n + m.packets, 0)).toBe(21);
    expect(Math.max(...minutes.map((m) => m.maxGapMs))).toBe(11_000);
  });

  it("after a restart the detector continues from the stored state (no event if uptime continued)", () => {
    const first = setup(() => true);
    clock.advanceTo(T0 + 1000);
    first.onHeartbeat(heartbeat(clock.now(), 1001));
    first.stop();
    clock.advanceTo(T0 + 300_000);
    const second = setup(() => true);
    second.onHeartbeat(heartbeat(clock.now(), 1300));
    expect(events).toEqual([]);
    expect(state.get("4u").power).toBe("on");
    second.stop();
  });
});

describe("ScheduleService", () => {
  const day = (date: string, status: string, slots: [number, number, string][] = []) =>
    parseDay({
      date: `${date}T00:00:00+02:00`,
      status,
      slots: slots.map(([start, end, type]) => ({ start, end, type })),
    });
  const update = (
    today: ReturnType<typeof day>,
    tomorrow: ReturnType<typeof day>,
  ): YasnoUpdate => ({
    fetchedAt: clock.now(),
    source: "origin",
    groups: { "12.1": { today, tomorrow, updatedOn: "2026-11-10T05:00:00+00:00" } },
    missingGroups: [],
  });
  const A: [number, number, string][] = [
    [0, 1260, "NotPlanned"],
    [1260, 1440, "Definite"],
  ];

  it("stores versions, fills state and announces a published tomorrow", () => {
    const schedules = new ScheduleService({ sites: [site], store, bus, clock, state });
    schedules.onYasnoUpdate(
      update(day("2026-11-10", "ScheduleApplies", A), day("2026-11-11", "WaitingForSchedule")),
    );
    clock.advanceBy(20_000); // next poll
    schedules.onYasnoUpdate(
      update(
        day("2026-11-10", "ScheduleApplies", A),
        day("2026-11-11", "NoOutages", [[0, 1440, "NotPlanned"]]),
      ),
    );
    expect(
      events.map((e) => (e.payload as CoreEvents["schedule.notification"]).notification?.kind),
    ).toEqual(["tomorrow_published"]);
    expect(store.schedules.versions("4u", "2026-11-10", "2026-11-11")).toHaveLength(3);
    expect(state.planTexts("4u", at("2026-11-10", "20:00"))?.outage).toBe(
      "Найближче відключення о 21:00",
    );
  });

  it("a change made while the core was down is announced after the restart", () => {
    new ScheduleService({ sites: [site], store, bus, clock, state }).onYasnoUpdate(
      update(day("2026-11-10", "ScheduleApplies", A), day("2026-11-11", "WaitingForSchedule")),
    );
    events = [];
    clock.advanceBy(3_600_000);
    const restarted = new ScheduleService({ sites: [site], store, bus, clock, state });
    restarted.hydrate();
    restarted.onYasnoUpdate(
      update(day("2026-11-10", "EmergencyShutdowns"), day("2026-11-11", "WaitingForSchedule")),
    );
    expect(
      events.map((e) => (e.payload as CoreEvents["schedule.notification"]).notification?.kind),
    ).toEqual(["today_updated"]);
  });

  describe("at midnight today is compared with the version stored as tomorrow", () => {
    const B: [number, number, string][] = [
      [0, 360, "NotPlanned"],
      [360, 810, "Definite"],
      [810, 1440, "NotPlanned"],
    ];
    const kinds = () =>
      events.map((e) => (e.payload as CoreEvents["schedule.notification"]).notification?.kind);
    const night = (atMidnight: [number, number, string][]) => {
      clock.advanceTo(at("2026-11-10", "23:15"));
      const schedules = new ScheduleService({ sites: [site], store, bus, clock, state });
      schedules.onYasnoUpdate(
        update(day("2026-11-10", "ScheduleApplies", A), day("2026-11-11", "ScheduleApplies", B)),
      );
      clock.advanceTo(at("2026-11-11", "00:00") + 2_000);
      schedules.onYasnoUpdate(
        update(
          day("2026-11-11", "ScheduleApplies", atMidnight),
          day("2026-11-12", "WaitingForSchedule"),
        ),
      );
    };

    it("the day as announced the evening before: silent", () => {
      night(B);
      expect(kinds()).toEqual([]);
    });

    it("the provider adds 00:00–01:00 right at 00:00 (2026-11-08): a change of today", () => {
      night([[0, 60, "Definite"], [60, 360, "NotPlanned"], ...B.slice(1)]);
      expect(kinds()).toEqual(["today_updated"]);
    });
  });
});

describe("ReminderService", () => {
  const midnight = (): YasnoUpdate => ({
    fetchedAt: clock.now(),
    source: "origin",
    groups: {
      "12.1": {
        today: parseDay({
          date: "2026-11-10T00:00:00+02:00",
          status: "ScheduleApplies",
          slots: [
            { start: 0, end: 1260, type: "NotPlanned" },
            { start: 1260, end: 1440, type: "Definite" },
          ],
        }),
        tomorrow: parseDay({
          date: "2026-11-11T00:00:00+02:00",
          status: "ScheduleApplies",
          slots: [
            { start: 0, end: 180, type: "Definite" },
            { start: 180, end: 1440, type: "NotPlanned" },
          ],
        }),
        updatedOn: null,
      },
    },
    missingGroups: [],
  });

  it("fires at exact moments, skips what the power state makes pointless, never twice", () => {
    const schedules = new ScheduleService({ sites: [site], store, bus, clock, state });
    const reminders = new ReminderService({ site, store, bus, clock, state });
    reminders.start();
    schedules.onYasnoUpdate(midnight());
    state.update("4u", { power: "on" });
    expect(reminders.pending()).toBe(8);

    clock.advanceTo(at("2026-11-10", "21:00"));
    state.update("4u", { power: "off" });
    clock.advanceTo(at("2026-11-11", "04:00"));

    const due = events
      .filter((e) => e.type === "reminder.due")
      .map((e) => (e.payload as { event: ReminderEvent }).event);
    expect(due.map((e) => `${e.kind}@${formatHHMM(e.triggerAt, KYIV_TZ)}`)).toEqual([
      "outage@20:00",
      "outage@20:30",
      "outage@20:40",
      "outage@20:50",
      "restore@02:00",
      "restore@02:30",
      "restore@02:40",
      "restore@02:50",
    ]);

    // A restart re-plans the same reminders, but the claims in the DB stop repeats.
    const again = new ReminderService({ site, store, bus, clock, state });
    clock.advanceTo(at("2026-11-10", "19:59"));
    again.start();
    reminders.stop();
    again.stop();
  });
});
