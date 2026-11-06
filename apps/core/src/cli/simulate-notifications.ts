/**
 * Sends every schedule notification, plus power notices with schedule hints, to one Telegram chat
 * through the real pipeline (schedule monitors → texts → outbox → bot). Runs a throwaway core:
 * temporary database, no webhook or commands, no UDP 5005, no MQTT — the live core is untouched.
 * Each scenario is announced by a silent "🧪" line. For checking texts by eye.
 *
 *   SIM_BOT_TOKEN=<token> SIM_CHAT_ID=<chat id> node apps/core/src/cli/simulate-notifications.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDays,
  type DaySchedule,
  formatHHMM,
  KYIV_TZ,
  localDate,
  parseDay,
} from "@svitlo/domain";
import { startCore } from "../app.ts";
import { loadConfig } from "../config.ts";

const token = process.env.SIM_BOT_TOKEN;
const chat = Number(process.env.SIM_CHAT_ID);
if (!token || !Number.isInteger(chat)) {
  console.error("set SIM_BOT_TOKEN and SIM_CHAT_ID");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = mkdtempSync(join(tmpdir(), "svitlo-sim-"));
writeFileSync(
  join(dir, "sites.yaml"),
  `sites:
  - id: 4u
    name: ЖК 4U
    yasno: { region: 25, dso: 902, group: "12.1" }
    devices:
      - { id: esp-sim, kind: esp, transport: udp, secretEnv: SIM_ESP_SECRET }
    telegram:
      botTokenEnv: SIM_BOT_TOKEN
      adminChatId: ${chat}
      chats: ["${chat}"]
      shadow: false
      commands: false
`,
);

const core = await startCore(
  {
    ...loadConfig({ LOG_LEVEL: "warn", TELEGRAM_UPDATES: "off", APP_VERSION: "(симуляція)" }),
    dbPath: join(dir, "sim.db"),
    sitesPath: join(dir, "sites.yaml"),
    udpPort: 0,
  },
  {
    env: { SIM_BOT_TOKEN: token, SIM_ESP_SECRET: "sim" },
    fetch: () => new Promise<Response>(() => {}), // never ask the real Yasno
    listen: false,
  },
);

const tz = KYIV_TZ;
const today = localDate(Date.now(), tz);
const tomorrow = addDays(today, 1);
const hour = Number(formatHHMM(Date.now(), tz).slice(0, 2));
const h = (n: number) => Math.max(0, Math.min(24, n));

/** A Yasno day with outage windows given in whole hours. */
const day = (date: string, status: string, windows: [number, number][] = []): DaySchedule =>
  parseDay({
    date: `${date}T00:00:00+02:00`,
    status,
    slots: windows.map(([from, to]) => ({ start: from * 60, end: to * 60, type: "Definite" })),
  });

// Today's plan always has a window around "now", so power notices get real schedule hints.
const plan: [number, number][] = [
  [8, 12],
  [h(hour - 1), h(hour + 1)],
  [h(hour + 3), h(hour + 5)],
];
const todayPlan = plan.filter(([a, b]) => a < b);

let current = {
  today: day(today, "ScheduleApplies", todayPlan),
  tomorrow: day(tomorrow, "WaitingForSchedule"),
};
const yasno = (patch: Partial<typeof current>) => {
  current = { ...current, ...patch };
  core.schedules.onYasnoUpdate({
    fetchedAt: Date.now(),
    source: "origin",
    groups: { "12.1": { ...current, updatedOn: new Date().toISOString() } },
    missingGroups: [],
  });
};
const settle = async () => {
  await core.outbox.idle();
  await sleep(1500);
};
let step = 0;
const label = async (text: string) => {
  core.telegram.alert(null, `🧪 ${++step}. ${text}`, { silent: true });
  await settle();
};

await settle(); // start message
yasno({}); // baseline: the monitors remember the current schedule, nothing is sent
await settle();

await label("На завтра з'явився графік");
yasno({
  tomorrow: day(tomorrow, "ScheduleApplies", [
    [6, 10],
    [14, 18],
  ]),
});
await settle();

await label("Графік на завтра змінили");
yasno({
  tomorrow: day(tomorrow, "ScheduleApplies", [
    [6, 10],
    [18, 22],
  ]),
});
await settle();

await label("Графік на сьогодні оновили");
yasno({ today: day(today, "ScheduleApplies", [[7, 12], ...todayPlan.slice(1)]) });
await settle();

await label("Сьогодні відключень не передбачено");
yasno({ today: day(today, "NoOutages") });
await settle();

await label("Сьогодні знову за графіком");
yasno({ today: day(today, "ScheduleApplies", todayPlan) });
await settle();

await label("На завтра екстрені (під ними — графік, що діяв, R15)");
yasno({ tomorrow: day(tomorrow, "EmergencyShutdowns") });
await settle();

await label("Сьогодні екстрені (під ними — графік, що діяв, R15)");
yasno({ today: day(today, "EmergencyShutdowns") });
await settle();

await label("Екстрені скасували: сьогодні знову графік");
yasno({ today: day(today, "ScheduleApplies", todayPlan) });
await settle();

await label("Екстрені на завтра скасували: графік знову опубліковано");
yasno({
  tomorrow: day(tomorrow, "ScheduleApplies", [
    [6, 10],
    [14, 18],
  ]),
});
await settle();

// Power notices: their hints come from the schedule set above.
const now = Date.now();
const base = { siteId: "4u", reason: "probe-timeout" as const, approximate: false };

await label(`Світло зникло всередині вікна ${todayPlan[1]?.[0]}:00–${todayPlan[1]?.[1]}:00`);
core.bus.emit("power.changed", {
  ...base,
  state: "off",
  at: now - 9_000,
  detectedAt: now,
  previous: "on",
  previousSince: now - 5 * 3_600_000,
});
await settle();

await label("Хибна тривога (ESP мовчав, а розетка бачила напругу)");
core.bus.emit("power.false-alarm", {
  siteId: "4u",
  outageStartedAt: now - 9_000,
  detectedAt: now + 20_000,
});
await settle();

await label("Світло повернулося, хоча вікно ще триває (R3)");
core.bus.emit("power.changed", {
  ...base,
  reason: "esp-reboot",
  state: "on",
  at: now,
  detectedAt: now + 1_000,
  previous: "off",
  previousSince: now - 40 * 60_000,
});
await settle();

await label(
  `Новину виявлено із запізненням (ядро не працювало), зникло о ${formatHHMM(now - 25 * 60_000, tz)}`,
);
core.bus.emit("power.changed", {
  ...base,
  reason: "downtime",
  approximate: true,
  state: "off",
  at: now - 25 * 60_000,
  detectedAt: now,
  previous: "on",
  previousSince: now - 3 * 3_600_000,
});
await settle();

for (const [kind, voltage, stable, minutes, name] of [
  ["low", 189, 206, 14, "Низька"],
  ["high", 251, 236, 6, "Висока"],
] as const) {
  await label(`${name} напруга (підтверджено за хвилину)`);
  core.bus.emit("voltage.alert", { siteId: "4u", kind, voltage, since: Date.now() - 45_000 });
  await settle();

  await label("Напругу стабілізовано (2 хв у нормі)");
  core.bus.emit("voltage.stabilized", {
    siteId: "4u",
    kind,
    voltage: stable,
    since: Date.now() - minutes * 60_000,
    at: Date.now(),
  });
  await settle();
}

core.telegram.alert(null, `🧪 Готово: ${step} сценаріїв.`, { silent: true });
await settle();
await core.stop();
rmSync(dir, { recursive: true, force: true });
console.log(`sent ${step} scenarios`);
