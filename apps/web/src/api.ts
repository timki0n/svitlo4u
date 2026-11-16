/**
 * The public API v1 of the core. Types come straight from the core's Zod contract (type-only import,
 * nothing of the core ends up in the bundle), so the web cannot drift from what the API returns.
 */
import type { ResponseOf } from "../../core/src/api/contract.ts";
import type { MeView } from "../../core/src/api/me-view.ts";
import { tgInitData } from "./telegram.ts";

export type Site = ResponseOf<"site">;
export type Me = MeView;
export type OwnedHub = Me["hubs"][number];
export type OwnedChat = OwnedHub["chats"][number];
export type State = ResponseOf<"state">;
export type Widget = ResponseOf<"widget">;
export type TimelineDay = Widget["timeline"]["days"][number];
export type Outage = Widget["timeline"]["actual"][number];
export type DaySchedule = ResponseOf<"schedule">;
export type Summary = ResponseOf<"summary">;
export type Daily = ResponseOf<"daily">;
export type Heatmap = ResponseOf<"heatmap">;
export type PlanVsFact = ResponseOf<"planVsFact">;
export type VoltageStats = ResponseOf<"voltage">;
export type ScheduleChanges = ResponseOf<"scheduleChanges">;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`${status} ${path}`);
    this.status = status;
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new ApiError(response.status, path);
  return (await response.json()) as T;
}

/** The Mini App's own calls: signed by Telegram's launch data. */
async function signed<T>(method: string, path: string, body?: unknown): Promise<T> {
  const initData = tgInitData();
  if (!initData) throw new ApiError(401, path);
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      authorization: `tma ${initData}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new ApiError(response.status, path);
  return (await response.json()) as T;
}

const site = (id: string) => `/api/v1/sites/${encodeURIComponent(id)}`;
const range = (from: string, to: string) => `from=${from}&to=${to}`;

export const api = {
  sites: (signal?: AbortSignal) => get<ResponseOf<"sites">>("/api/v1/sites", signal),
  site: (id: string, signal?: AbortSignal) => get<Site>(site(id), signal),
  state: (id: string, signal?: AbortSignal) => get<State>(`${site(id)}/state`, signal),
  widget: (id: string, signal?: AbortSignal) => get<Widget>(`${site(id)}/widget`, signal),
  schedule: (id: string, date: string, signal?: AbortSignal) =>
    get<DaySchedule>(`${site(id)}/schedule?date=${date}`, signal),
  summary: (id: string, from: string, to: string, signal?: AbortSignal) =>
    get<Summary>(`${site(id)}/analytics/summary?${range(from, to)}`, signal),
  daily: (id: string, from: string, to: string, signal?: AbortSignal) =>
    get<Daily>(`${site(id)}/analytics/daily?${range(from, to)}`, signal),
  heatmap: (id: string, from: string, to: string, signal?: AbortSignal) =>
    get<Heatmap>(`${site(id)}/analytics/heatmap?${range(from, to)}`, signal),
  planVsFact: (id: string, from: string, to: string, signal?: AbortSignal) =>
    get<PlanVsFact>(`${site(id)}/analytics/plan-vs-fact?${range(from, to)}`, signal),
  voltage: (id: string, from: string, to: string, signal?: AbortSignal) =>
    get<VoltageStats>(`${site(id)}/analytics/voltage?${range(from, to)}`, signal),
  scheduleChanges: (id: string, from: string, to: string, signal?: AbortSignal) =>
    get<ScheduleChanges>(`${site(id)}/analytics/schedule-changes?${range(from, to)}`, signal),
  eventsUrl: (id: string) => `${site(id)}/events`,
  // the Mini App: my building, «Мій хаб»
  me: () => signed<Me>("GET", "/api/v1/me"),
  setMySite: (siteId: string) => signed<Me>("PUT", "/api/v1/me/site", { siteId }),
  renameHub: (hubId: string, name: string) =>
    signed<Me>("POST", `/api/v1/me/hubs/${hubId}/name`, { name }),
  releaseHub: (hubId: string) => signed<Me>("POST", `/api/v1/me/hubs/${hubId}/release`),
  setChatFeed: (chatId: number, threadId: number, on: boolean) =>
    signed<Me>("POST", `/api/v1/me/chats/${chatId}/feed`, { threadId, on }),
  removeChat: (chatId: number, threadId: number) =>
    signed<Me>("POST", `/api/v1/me/chats/${chatId}/remove`, { threadId }),
};
