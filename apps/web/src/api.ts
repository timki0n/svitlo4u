/**
 * The public API v1 of the core. Types come straight from the core's Zod contract (type-only import,
 * nothing of the core ends up in the bundle), so the web cannot drift from what the API returns.
 */
import type { ResponseOf } from "../../core/src/api/contract.ts";
import type { MeView } from "../../core/src/api/me-view.ts";
import { tgInitData } from "./telegram.ts";

export type Site = ResponseOf<"site">;
export type Me = MeView;
export type MyBuilding = Me["buildings"][number];
export type OwnedChat = MyBuilding["chats"][number];
export type State = ResponseOf<"state">;
export type Widget = ResponseOf<"widget">;
export type TimelineDay = Widget["timeline"]["days"][number];
export type Outage = Widget["timeline"]["actual"][number];
export type DaySchedule = ResponseOf<"schedule">;
export type PastDay = ResponseOf<"day">;
export type Summary = ResponseOf<"summary">;
export type Daily = ResponseOf<"daily">;
export type Heatmap = ResponseOf<"heatmap">;
export type PlanVsFact = ResponseOf<"planVsFact">;
export type VoltageStats = ResponseOf<"voltage">;
export type ScheduleChanges = ResponseOf<"scheduleChanges">;
export type Weather = ResponseOf<"weather">;

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

/** A form sent from the site or the Mini App (there signed: the person is known). */
async function post<T>(path: string, body: unknown): Promise<T> {
  const initData = tgInitData();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(initData ? { authorization: `tma ${initData}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(response.status, path);
  return (await response.json()) as T;
}

/** A street or a house in YASNO's address search. */
export type AddressItem = { id: number; name: string };
/** What is at an address: its queue, and Світло4U's building there (public ones only). */
export type AddressLookup = { group: string | null; site: { id: string; name: string } | null };
export type AddressPick = { street: number; house: number; streetName: string; houseName: string };

const site = (id: string) => `/api/v1/sites/${encodeURIComponent(id)}`;
const q = (text: string) => encodeURIComponent(text.trim());
const range = (from: string, to: string) => `from=${from}&to=${to}`;

export const api = {
  sites: (signal?: AbortSignal) => get<ResponseOf<"sites">>("/api/v1/sites", signal),
  weather: (signal?: AbortSignal) => get<Weather>("/api/v1/weather", signal),
  site: (id: string, signal?: AbortSignal) => get<Site>(site(id), signal),
  state: (id: string, signal?: AbortSignal) => get<State>(`${site(id)}/state`, signal),
  widget: (id: string, signal?: AbortSignal) => get<Widget>(`${site(id)}/widget`, signal),
  day: (id: string, date: string, signal?: AbortSignal) =>
    get<PastDay>(`${site(id)}/day?date=${date}`, signal),
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
  // the Mini App: my building, «Мої будинки»
  me: () => signed<Me>("GET", "/api/v1/me"),
  setMySite: (siteId: string) => signed<Me>("PUT", "/api/v1/me/site", { siteId }),
  renameHub: (hubId: string, name: string) =>
    signed<Me>("POST", `/api/v1/me/hubs/${hubId}/name`, { name }),
  releaseHub: (hubId: string) => signed<Me>("POST", `/api/v1/me/hubs/${hubId}/release`),
  setChatFeed: (chatId: number, threadId: number, on: boolean) =>
    signed<Me>("POST", `/api/v1/me/chats/${chatId}/feed`, { threadId, on }),
  removeChat: (chatId: number, threadId: number) =>
    signed<Me>("POST", `/api/v1/me/chats/${chatId}/remove`, { threadId }),
  addFavorite: (siteId: string) => signed<Me>("POST", "/api/v1/me/favorites", { siteId }),
  removeFavorite: (siteId: string) =>
    signed<Me>("DELETE", `/api/v1/me/favorites/${encodeURIComponent(siteId)}`),
  // «Знайти мій будинок»: any address in YASNO's search
  streets: (text: string, signal?: AbortSignal) =>
    get<{ streets: AddressItem[] }>(`/api/v1/addresses/streets?q=${q(text)}`, signal),
  houses: (street: number, text: string, signal?: AbortSignal) =>
    get<{ houses: AddressItem[] }>(
      `/api/v1/addresses/houses?street=${street}&q=${q(text)}`,
      signal,
    ),
  lookup: (street: number, house: number, signal?: AbortSignal) =>
    get<AddressLookup>(`/api/v1/addresses/lookup?street=${street}&house=${house}`, signal),
  sendRequest: (
    address: AddressPick,
    has: { canAdmin: boolean; sparePhone: boolean; routerOk: boolean; wantsVoltage: boolean },
    contact: string,
  ) =>
    post<{ ok: true }>("/api/v1/requests", {
      ...address,
      ...has,
      ...(contact.trim() ? { contact: contact.trim() } : {}),
    }),
  attachAddress: (siteId: string, address: AddressPick) =>
    signed<{ ok: true }>("POST", "/api/v1/admin/addresses", { siteId, ...address }),
};
