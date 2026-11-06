/**
 * Public API contract (v1): every route with its Zod schemas. Handlers are bound in routes.ts;
 * the OpenAPI document (docs/openapi.json) is generated from this file, so the code and the
 * published contract cannot drift apart.
 *
 * Conventions: instants are Unix time in milliseconds, calendar dates are local "YYYY-MM-DD" in the
 * site's time zone, durations are milliseconds. Live data is never cached (Cache-Control: no-store).
 */
import { SCHEDULE_STATUSES } from "@svitlo/domain";
import { z } from "zod";

/** Contract version: bump the major for breaking changes (new paths under /api/v2). */
export const API_VERSION = "1.0.0";

const ms = z.number().describe("Unix time, ms");
const duration = z.number().describe("Duration, ms");
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
  .describe("Local calendar date, YYYY-MM-DD");
const power = z.enum(["on", "off", "unknown"]);
const scheduleStatus = z.enum(SCHEDULE_STATUSES);
const interval = z.object({ start: ms, end: ms });
const share = z.number().min(0).max(1);

export const SiteParams = z.object({
  siteId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .describe("Site id, e.g. 4u"),
});

export const RangeQuery = z.object({
  from: localDate.optional().describe("First day (default: 29 days before `to`)"),
  to: localDate.optional().describe("Last day, inclusive (default: today)"),
});

export const ErrorBody = z.object({ error: z.string(), message: z.string().optional() });

// ─── views ─────────────────────────────────────────────────────────────────────────────────

export const Site = z.object({
  id: z.string(),
  name: z.string(),
  tz: z.string(),
  yasnoGroup: z.string(),
  hasPlug: z.boolean().describe("A Zigbee plug confirms power and measures voltage"),
});

export const Hint = z
  .object({
    text: z.string().describe("Plain text"),
    html: z.string().describe("Same text with the schedule link (Telegram HTML)"),
  })
  .describe("Plan hint for the current state: when power returns / when the next outage is");

export const NextChange = z
  .object({
    kind: z
      .enum(["outage", "restore", "window-in-progress"])
      .describe(
        "outage: next planned outage starts; restore: power is off, the planned window ends; " +
          "window-in-progress: power is on although a planned window runs until `at`",
      ),
    at: ms,
    label: z.string().describe("e.g. «Відключення о 16:00», «Світло за графіком о 20:00»"),
  })
  .describe("Next planned change (by schedule, not a promise)");

export const State = z.object({
  siteId: z.string(),
  now: ms,
  power,
  since: ms.nullable().describe("Start of the current power state"),
  hint: Hint.nullable(),
  next: NextChange.nullable(),
  schedule: z
    .object({
      updatedOn: z.string().nullable().describe("Yasno's update time (ISO)"),
      fetchedAt: ms.nullable(),
    })
    .nullable(),
  voltage: z.object({ value: z.number(), at: ms.nullable() }).nullable(),
  lastEspAt: ms.nullable(),
});

export const Segment = z.object({
  start: ms,
  end: ms,
  kind: z.enum(["on", "off", "unknown"]).describe("Planned state"),
  label: z.string().describe("«08:00–12:00»; for unknown days the reason"),
});

export const TimelineDay = z.object({
  date: localDate,
  status: scheduleStatus,
  label: z.string().describe("«Сьогодні, 06.11» / «Завтра, 07.11»"),
  segments: z.array(Segment),
});

export const Widget = z.object({
  siteId: z.string(),
  name: z.string(),
  now: ms,
  power,
  since: ms.nullable(),
  title: z.string().describe("«Світло є» / «Світла немає» / «Стан невідомий»"),
  subtitle: z.string().nullable().describe("«уже 3 год. 20 хв.»"),
  hint: z.string().nullable(),
  next: NextChange.nullable(),
  timeline: z.object({
    start: ms,
    end: ms,
    days: z.array(TimelineDay).describe("Today and tomorrow, 48 hours"),
    actual: z
      .array(z.object({ start: ms, end: ms.nullable() }))
      .describe("Real outages in the timeline so far (end null = ongoing)"),
  }),
  refreshAt: ms.describe("When the widget should be re-rendered at the latest"),
});

export const DaySchedule = z.object({
  siteId: z.string(),
  date: localDate,
  source: z.enum(["live", "history", "none"]),
  status: scheduleStatus,
  updatedOn: z.string().nullable(),
  outages: z.array(interval.extend({ label: z.string() })),
});

export const Outages = z.object({
  siteId: z.string(),
  range: interval,
  outages: z.array(
    z.object({ start: ms, end: ms.nullable().describe("null = ongoing"), durationMs: duration }),
  ),
});

const summaryFields = {
  durationMs: duration,
  offMs: duration,
  onMs: duration,
  offShare: share,
  outages: z.number().int().describe("Outages that started inside the range"),
  longestOutageMs: duration,
  averageOutageMs: duration,
  longestLightOnMs: duration,
};

export const Summary = z.object({
  siteId: z.string(),
  range: interval,
  ...summaryFields,
});

export const Buckets = z.object({
  siteId: z.string(),
  range: interval,
  granularity: z.enum(["day", "week", "month"]),
  buckets: z.array(
    z.object({
      key: z.string().describe("2026-11-06 | 2026-W45 | 2026-11"),
      start: ms,
      end: ms,
      durationMs: duration,
      offMs: duration,
      offShare: share,
      outages: z.number().int(),
      longestOutageMs: duration,
    }),
  ),
});

export const Heatmap = z.object({
  siteId: z.string(),
  range: interval,
  source: z.enum(["actual", "planned"]),
  offMs: z.array(z.array(duration)).describe("[weekday 0=Mon..6][hour 0..23]"),
  totalMs: z.array(z.array(duration)),
  share: z.array(z.array(share.nullable())),
});

export const PlanVsFact = z.object({
  siteId: z.string(),
  range: interval,
  matches: z.array(
    z.object({
      plan: interval,
      actual: z.array(interval),
      startDeviationMs: z.number().nullable().describe("Actual start − planned start"),
      endDeviationMs: z.number().nullable().describe("Actual end − planned end"),
      coveredMs: duration,
    }),
  ),
  unplanned: z.array(interval),
  totals: z.object({
    plannedMs: duration,
    actualMs: duration,
    overlapMs: duration,
    offScheduleMs: duration,
    plannedButLightMs: duration,
    executedShare: share.nullable(),
    windows: z.number().int(),
    executedWindows: z.number().int(),
    averageStartDeviationMs: z.number().nullable(),
    averageEndDeviationMs: z.number().nullable(),
  }),
});

export const Voltage = z.object({
  siteId: z.string(),
  range: interval,
  granularity: z.enum(["hour", "day", "week", "month"]),
  summary: z.object({
    count: z.number().int(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    avg: z.number().nullable(),
    below: z.number().int().describe("Readings below 207 V"),
    above: z.number().int().describe("Readings above 253 V"),
    belowShare: share,
    aboveShare: share,
  }),
  buckets: z.array(
    z.object({
      key: z.string(),
      start: ms,
      end: ms,
      count: z.number().int(),
      min: z.number(),
      max: z.number(),
      avg: z.number(),
    }),
  ),
});

export const ScheduleChanges = z.object({
  siteId: z.string(),
  days: z.array(
    z.object({
      date: localDate,
      versions: z.number().int(),
      changesAfterPublish: z.number().int(),
      firstPublishedAt: ms.nullable(),
      publishLeadMs: z.number().nullable().describe("How long before the day it was published"),
      finalStatus: scheduleStatus,
      hadEmergency: z.boolean(),
    }),
  ),
  totals: z.object({
    days: z.number().int(),
    publishedDays: z.number().int(),
    changedDays: z.number().int().describe("Days changed after the first publication"),
    totalChanges: z.number().int(),
    emergencyDays: z.number().int(),
    medianPublishLeadMs: z.number().nullable(),
  }),
});

// ─── routes ────────────────────────────────────────────────────────────────────────────────

export type RouteContract = {
  method: "GET";
  /** OpenAPI style: /api/v1/sites/{siteId} */
  path: string;
  summary: string;
  description?: string;
  tag: "sites" | "analytics" | "meta";
  params?: z.ZodObject;
  query?: z.ZodObject;
  response: z.ZodType;
  /** Streams text/event-stream instead of JSON (documentation only). */
  stream?: true;
};

const GranularityQuery = RangeQuery.extend({
  granularity: z.enum(["day", "week", "month"]).default("day"),
});

export const routes = {
  sites: {
    method: "GET",
    path: "/api/v1/sites",
    summary: "Configured sites",
    tag: "sites",
    response: z.object({ sites: z.array(Site) }),
  },
  state: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/state",
    summary: "Current power state with the plan hint",
    tag: "sites",
    params: SiteParams,
    response: State,
  },
  events: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/events",
    summary: "Live updates (Server-Sent Events)",
    description:
      "text/event-stream. On connect: `state` (same body as /state). Then: `state` after every " +
      "change, `power` {state, at, detectedAt, approximate}, `false-alarm` {outageStartedAt}, " +
      "`schedule` {kind, title, body, …}, `reminder` {kind, leadMinutes, start, end, power}, " +
      "`voltage` {t, voltage}. Comment lines every 25 s keep the stream open. No replay: a " +
      "reconnecting client gets a fresh `state`.",
    tag: "sites",
    params: SiteParams,
    response: State,
    stream: true,
  },
  widget: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/widget",
    summary: "Everything a home-screen widget shows, with ready labels",
    tag: "sites",
    params: SiteParams,
    response: Widget,
  },
  schedule: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/schedule",
    summary: "Planned outages of one day (live for today/tomorrow, history otherwise)",
    tag: "sites",
    params: SiteParams,
    query: z.object({ date: localDate.optional().describe("Default: today") }),
    response: DaySchedule,
  },
  outages: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/outages",
    summary: "Real outages in a date range (false alarms excluded)",
    tag: "sites",
    params: SiteParams,
    query: RangeQuery,
    response: Outages,
  },
  summary: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/analytics/summary",
    summary: "Totals for a date range",
    tag: "analytics",
    params: SiteParams,
    query: RangeQuery,
    response: Summary,
  },
  daily: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/analytics/daily",
    summary: "Outage time per day, week or month",
    tag: "analytics",
    params: SiteParams,
    query: GranularityQuery,
    response: Buckets,
  },
  heatmap: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/analytics/heatmap",
    summary: "Share of time without power by weekday and hour",
    tag: "analytics",
    params: SiteParams,
    query: RangeQuery.extend({ source: z.enum(["actual", "planned"]).default("actual") }),
    response: Heatmap,
  },
  planVsFact: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/analytics/plan-vs-fact",
    summary: "Planned windows compared with real outages",
    tag: "analytics",
    params: SiteParams,
    query: RangeQuery,
    response: PlanVsFact,
  },
  voltage: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/analytics/voltage",
    summary: "Mains voltage from the Zigbee plug",
    description: "granularity=hour allows ranges up to 31 days.",
    tag: "analytics",
    params: SiteParams,
    query: RangeQuery.extend({
      granularity: z.enum(["hour", "day", "week", "month"]).default("day"),
    }),
    response: Voltage,
  },
  scheduleChanges: {
    method: "GET",
    path: "/api/v1/sites/{siteId}/analytics/schedule-changes",
    summary: "How often and how late Yasno changed the schedule",
    tag: "analytics",
    params: SiteParams,
    query: RangeQuery,
    response: ScheduleChanges,
  },
  openapi: {
    method: "GET",
    path: "/api/v1/openapi.json",
    summary: "This document",
    tag: "meta",
    response: z.record(z.string(), z.unknown()),
  },
} satisfies Record<string, RouteContract>;

export type Routes = typeof routes;
export type ResponseOf<K extends keyof Routes> = z.infer<Routes[K]["response"]>;

/** OpenAPI 3.1 document built from the routes above. */
export function openApiDocument(): Record<string, unknown> {
  const jsonSchema = (schema: z.ZodType, io: "input" | "output") => {
    const { $schema: _, ...rest } = z.toJSONSchema(schema, { io, target: "draft-2020-12" });
    return rest;
  };
  const parameters = (where: "path" | "query", schema: z.ZodObject | undefined) =>
    Object.entries(schema?.shape ?? {}).map(([name, field]) => {
      const fieldSchema = jsonSchema(field as z.ZodType, "input");
      const { description, ...rest } = fieldSchema as { description?: string };
      return {
        name,
        in: where,
        required: where === "path" || !(field as z.ZodType).safeParse(undefined).success,
        ...(description ? { description } : {}),
        schema: rest,
      };
    });
  const error = (description: string) => ({
    description,
    content: { "application/json": { schema: jsonSchema(ErrorBody, "output") } },
  });

  const paths: Record<string, Record<string, unknown>> = {};
  for (const [operationId, route] of Object.entries(routes) as [string, RouteContract][]) {
    const params = [...parameters("path", route.params), ...parameters("query", route.query)];
    const contentType = route.stream ? "text/event-stream" : "application/json";
    paths[route.path] = {
      [route.method.toLowerCase()]: {
        operationId,
        tags: [route.tag],
        summary: route.summary,
        ...(route.description ? { description: route.description } : {}),
        ...(params.length > 0 ? { parameters: params } : {}),
        responses: {
          "200": {
            description: route.stream ? "Event stream (first event: state)" : "OK",
            content: { [contentType]: { schema: jsonSchema(route.response, "output") } },
          },
          ...(route.query ? { "400": error("Invalid query") } : {}),
          ...(route.params ? { "404": error("Unknown site") } : {}),
          "429": error("Too many requests (see Retry-After)"),
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "svitlo4u API",
      version: API_VERSION,
      description:
        "Power state, outage schedules and analytics. Instants are Unix ms, dates are local " +
        "YYYY-MM-DD in the site's time zone, durations are ms. Responses are not cached.",
    },
    servers: [{ url: "https://svitlo4u.info" }],
    tags: [
      { name: "sites", description: "Live state and schedules" },
      { name: "analytics", description: "History" },
      { name: "meta" },
    ],
    paths,
  };
}
