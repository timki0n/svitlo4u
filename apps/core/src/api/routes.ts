/**
 * Binds the API contract (contract.ts) to handlers. Input is validated with the contract's Zod
 * schemas; in strict mode (tests) every response is validated too, so the published OpenAPI
 * document is proven against real responses.
 */
import {
  addDays,
  type Interval,
  localDate,
  localMidnight,
  outageBuckets,
  outageIntervals,
  outageSummary,
  plannedWindows,
  planVsFact,
  scheduleChangeStats,
  union,
  voltageRollup,
  voltageSummary,
  weeklyHeatmap,
} from "@svitlo/domain";
import type { Store } from "@svitlo/storage";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Clock } from "../runtime/clock.ts";
import type { SiteStateStore } from "../services/state.ts";
import type { SiteConfig } from "../sites-config.ts";
import {
  openApiDocument,
  type RangeQuery,
  type ResponseOf,
  type RouteContract,
  type Routes,
  routes,
} from "./contract.ts";
import { dayScheduleView, stateView, widgetView } from "./views.ts";

export type ApiDeps = {
  sites: readonly SiteConfig[];
  state: SiteStateStore;
  store: Store;
  clock: Clock;
  /** Validate every response against its schema (tests). */
  strict?: boolean;
};

const DAY = 86_400_000;
export const MAX_RANGE_DAYS = 400;
export const MAX_HOURLY_RANGE_DAYS = 31;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

type Input<R> = {
  params: R extends { params: infer P extends z.ZodType } ? z.infer<P> : Record<string, never>;
  query: R extends { query: infer Q extends z.ZodType } ? z.infer<Q> : Record<string, never>;
};

type Range = { from: string; to: string; range: Interval; days: number };

/** Inclusive local dates → [first midnight, midnight after the last day). */
export function dateRange(
  query: z.infer<typeof RangeQuery>,
  tz: string,
  now: number,
  maxDays = MAX_RANGE_DAYS,
): Range {
  const to = query.to ?? localDate(now, tz);
  const from = query.from ?? addDays(to, -29);
  if (from > to) throw new ApiError(400, "invalid_range", "`from` is after `to`");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  if (days > maxDays)
    throw new ApiError(400, "invalid_range", `The range is limited to ${maxDays} days`);
  return {
    from,
    to,
    days,
    range: { start: localMidnight(from, tz), end: localMidnight(addDays(to, 1), tz) },
  };
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { state, store, clock } = deps;
  const sites = new Map(deps.sites.map((s) => [s.id, s]));
  const openapi = openApiDocument();

  function bind<K extends keyof Routes>(
    key: K,
    handler: (input: Input<Routes[K]>, now: number) => ResponseOf<K>,
  ): void {
    const route = routes[key] as RouteContract;
    const url = route.path.replace(/\{(\w+)\}/g, ":$1");
    app.get(url, async (request, reply) => {
      try {
        const params = route.params ? route.params.safeParse(request.params) : null;
        if (params && !params.success) throw new ApiError(404, "unknown_site");
        const siteId = (params?.data as { siteId?: string } | undefined)?.siteId;
        if (siteId !== undefined && !sites.has(siteId)) throw new ApiError(404, "unknown_site");
        const query = route.query ? route.query.safeParse(request.query) : null;
        if (query && !query.success)
          throw new ApiError(400, "invalid_query", z.prettifyError(query.error));
        const input = { params: params?.data ?? {}, query: query?.data ?? {} } as Input<Routes[K]>;
        const result = handler(input, clock.now());
        if (deps.strict) route.response.parse(result);
        return result;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return reply.code(error.status).send({
          error: error.code,
          ...(error.message !== error.code ? { message: error.message } : {}),
        });
      }
    });
  }

  const site = (siteId: string) => sites.get(siteId) as SiteConfig;
  const records = (siteId: string, range: Interval) => store.outages.list(siteId, range);

  bind("sites", () => ({
    sites: deps.sites.map((s) => ({
      id: s.id,
      name: s.name,
      tz: s.tz,
      yasnoGroup: s.yasno.group,
      hasPlug: s.plug !== null,
    })),
  }));

  bind("state", ({ params }, now) => stateView(state, params.siteId, now));

  bind("widget", ({ params }, now) => widgetView(state, store, params.siteId, now));

  bind("schedule", ({ params, query }, now) => {
    const date = query.date ?? localDate(now, site(params.siteId).tz);
    return dayScheduleView(state, store, params.siteId, date, now);
  });

  bind("outages", ({ params, query }, now) => {
    const { range } = dateRange(query, site(params.siteId).tz, now);
    return {
      siteId: params.siteId,
      range,
      outages: records(params.siteId, range)
        .filter((o) => !o.falseAlarm)
        .map((o) => ({ start: o.start, end: o.end, durationMs: (o.end ?? now) - o.start })),
    };
  });

  bind("summary", ({ params, query }, now) => {
    const { range } = dateRange(query, site(params.siteId).tz, now);
    return {
      siteId: params.siteId,
      range,
      ...outageSummary(records(params.siteId, range), { range, now }),
    };
  });

  bind("daily", ({ params, query }, now) => {
    const { tz } = site(params.siteId);
    const { range } = dateRange(query, tz, now);
    return {
      siteId: params.siteId,
      range,
      granularity: query.granularity,
      buckets: outageBuckets(records(params.siteId, range), {
        range,
        tz,
        now,
        granularity: query.granularity,
      }),
    };
  });

  /** Planned windows of the range, from the final version of every stored day. */
  const planned = (siteId: string, r: Range) => {
    const days = store.schedules
      .finalDays(siteId, addDays(r.from, -1), r.to)
      .map(({ date, day }) => ({ date, day }));
    return plannedWindows(days, site(siteId).tz);
  };

  bind("heatmap", ({ params, query }, now) => {
    const { tz } = site(params.siteId);
    const r = dateRange(query, tz, now);
    const past = { start: r.range.start, end: Math.max(r.range.start, Math.min(r.range.end, now)) };
    const intervals =
      query.source === "actual"
        ? union(outageIntervals(records(params.siteId, r.range), now))
        : planned(params.siteId, r);
    return {
      siteId: params.siteId,
      range: past,
      source: query.source,
      ...weeklyHeatmap(intervals, { range: past, tz }),
    };
  });

  bind("planVsFact", ({ params, query }, now) => {
    const r = dateRange(query, site(params.siteId).tz, now);
    return {
      siteId: params.siteId,
      range: r.range,
      ...planVsFact(planned(params.siteId, r), records(params.siteId, r.range), {
        range: r.range,
        now,
      }),
    };
  });

  bind("voltage", ({ params, query }, now) => {
    const { tz } = site(params.siteId);
    const max = query.granularity === "hour" ? MAX_HOURLY_RANGE_DAYS : MAX_RANGE_DAYS;
    const { range } = dateRange(query, tz, now, max);
    const samples = store.voltage.list(params.siteId, range);
    return {
      siteId: params.siteId,
      range,
      granularity: query.granularity,
      summary: voltageSummary(samples),
      buckets: voltageRollup(samples, { range, tz, granularity: query.granularity }),
    };
  });

  bind("scheduleChanges", ({ params, query }, now) => {
    const { tz } = site(params.siteId);
    const r = dateRange(query, tz, now);
    return {
      siteId: params.siteId,
      ...scheduleChangeStats(store.schedules.versions(params.siteId, r.from, r.to), { tz }),
    };
  });

  bind("openapi", () => openapi);
}
