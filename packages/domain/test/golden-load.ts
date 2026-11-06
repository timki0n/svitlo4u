import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addDays,
  isTransitionDay,
  KYIV_TZ,
  localDate,
  type RawDay,
  type RawGroupBlock,
} from "../src/index.ts";

const GOLDEN = fileURLToPath(new URL("./golden/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/yasno/", import.meta.url));

/** Links in legacy texts point here; production passes its own domain (R11). */
export const LEGACY_LINK = "https://svitlo4u.online";

type Run<T> = [number, T];

export type GoldenDay = {
  id: string;
  source: string;
  description: string | null;
  input: RawGroupBlock;
  originUtc: string;
  static: {
    todayInfo: GoldenInfo;
    tomorrowInfo: GoldenInfo;
    todayBody: string;
    tomorrowBody: string;
    todayCommand: string;
    tomorrowCommand: string;
    todayWithoutOutages: boolean;
    tomorrowWithoutOutages: boolean;
    planSegments: [string, string][];
    remindersAtOrigin: {
      fields: string[];
      rows: [string, number, string, string, string, number][];
    };
  };
  samples: number[];
  timeline: {
    nearestRestoreMessage: Run<string>[];
    nearestOutageMessage: Run<string>[];
    nearestOutage: Run<string | null>[];
  };
};

export type GoldenInfo = {
  date: string;
  status: string;
  outages: { start: string; end: string; type: string }[];
  updatedOn: string | null;
};

export type GoldenMonitorScenario = {
  id: string;
  monitor: "today" | "tomorrow";
  description: string;
  snapshots: RawDay[];
  iterations: { telegram: string[]; web: Record<string, unknown>[] }[];
};

export type GoldenFormatting = {
  fmtDurationLong: [number, string][];
  formatDuration: [number, number, string][];
  formatLastScheduleUpdate: [string | null, string | null][];
  formatLeadLabel: [number, string][];
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadGoldenDays(): GoldenDay[] {
  return readdirSync(`${GOLDEN}days`)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson<GoldenDay>(`${GOLDEN}days/${name}`));
}

export function loadMonitorScenarios(): GoldenMonitorScenario[] {
  return readJson<{ scenarios: GoldenMonitorScenario[] }>(`${GOLDEN}monitor-transitions.json`)
    .scenarios;
}

export function loadFormatting(): GoldenFormatting {
  return readJson<GoldenFormatting>(`${GOLDEN}formatting.json`);
}

export function loadSynthetic(id: string): RawGroupBlock {
  const cases = readJson<{ cases: { id: string; block: RawGroupBlock }[] }>(
    `${FIXTURES}synthetic.json`,
  ).cases;
  const found = cases.find((c) => c.id === id);
  if (!found) throw new Error(`synthetic fixture not found: ${id}`);
  return found.block;
}

/**
 * Fixture touches a DST transition day. Legacy compares wall-clock times there, the new code uses
 * absolute time — excluded from parity until REVIEW.md R10 is decided.
 */
export function isDstFixture(day: GoldenDay): boolean {
  const today = localDate(Date.parse(day.originUtc), KYIV_TZ);
  return isTransitionDay(today, KYIV_TZ) || isTransitionDay(addDays(today, 1), KYIV_TZ);
}

/** Expand run-length encoded values onto the sample list: values[i] belongs to samples[i]. */
export function expandRuns<T>(samples: readonly number[], runs: readonly Run<T>[]): T[] {
  const values: T[] = [];
  let runIndex = 0;
  for (const minute of samples) {
    while (runIndex + 1 < runs.length && (runs[runIndex + 1] as Run<T>)[0] <= minute) runIndex++;
    values.push((runs[runIndex] as Run<T>)[1]);
  }
  return values;
}
