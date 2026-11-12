/**
 * The game's calls to the core. Every call carries the Mini App's signed launch data; the types come
 * from the core itself (type-only import, nothing of the core in the bundle).
 */
import type {
  EveningDoor,
  EveningEmote,
  EveningGame,
  EveningMove,
  EveningPhrase,
  EveningReaction,
  EveningsOverview,
  EveningTableView,
} from "../../../core/src/services/evenings.ts";
import type {
  GameState as CoreState,
  GameBuilding,
  GameBuildings,
  GamePeriod,
  GameRating,
  GameRatingRow,
  GameSolve,
} from "../../../core/src/services/game.ts";
import { tgInitData } from "../telegram.ts";

/** The facade's state, with the doors of «Вечорниці». */
export type GameState = CoreState & { evenings: EveningsOverview };
export type {
  EveningDoor,
  EveningEmote,
  EveningGame,
  EveningMove,
  EveningPhrase,
  EveningReaction,
  EveningsOverview,
  EveningTableView,
  GameBuilding,
  GameBuildings,
  GamePeriod,
  GameRating,
  GameRatingRow,
};
export type SolveResult = Extract<GameSolve, { ok: true }>;

export class GameApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(
  method: "GET" | "POST",
  url: string,
  options: { signal?: AbortSignal; keepalive?: boolean; body?: object } = {},
): Promise<T> {
  const initData = tgInitData();
  if (!initData) throw new GameApiError(401, "unauthorized");
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `tma ${initData}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.keepalive ? { keepalive: true } : {}),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new GameApiError(response.status, body.error ?? "error");
  return body as T;
}

export function gameApi(siteId: string) {
  const base = `/api/v1/sites/${encodeURIComponent(siteId)}/game`;
  const win = (floor: number, col: number, action: string) =>
    `${base}/windows/${floor}-${col}/${action}`;
  const door = (n: number, action = "") => `${base}/evenings/${n}${action ? `/${action}` : ""}`;
  return {
    state: (signal?: AbortSignal) =>
      call<GameState>("GET", base, { ...(signal ? { signal } : {}) }),
    start: (floor: number, col: number) => call<{ ok: true }>("POST", win(floor, col, "start")),
    leave: (floor: number, col: number) =>
      call<{ ok: true }>("POST", win(floor, col, "leave"), { keepalive: true }),
    solve: (floor: number, col: number) => call<SolveResult>("POST", win(floor, col, "solve")),
    rating: (period: GamePeriod, signal?: AbortSignal) =>
      call<GameRating>("GET", `${base}/rating?period=${period}`, {
        ...(signal ? { signal } : {}),
      }),
    buildings: (signal?: AbortSignal) =>
      call<GameBuildings>("GET", `${base}/buildings`, { ...(signal ? { signal } : {}) }),

    // «Вечорниці»
    /** The door's table; waits for a change past `since` (the version last seen). */
    table: (n: number, since: number, signal?: AbortSignal) =>
      call<EveningTableView>("GET", `${door(n)}?since=${since}`, {
        ...(signal ? { signal } : {}),
      }),
    partStart: (n: number, part: number) =>
      call<{ ok: true }>("POST", door(n, `parts/${part}/start`)),
    partSolve: (n: number, part: number) =>
      call<{ ok: true; points: number }>("POST", door(n, `parts/${part}/solve`)),
    join: (n: number, stake: number) =>
      call<{ ok: true }>("POST", door(n, "join"), { body: { stake } }),
    stand: (n: number) => call<{ ok: true }>("POST", door(n, "leave")),
    move: (n: number, move: EveningMove) =>
      call<{ ok: true }>("POST", door(n, "move"), { body: move }),
    /** A reaction over my face at the table (an emoji, or a phrase of one watching), everywhere. */
    emote: (n: number, emoji: EveningReaction) =>
      call<{ ok: true }>("POST", door(n, "emote"), { body: { emoji } }),
  };
}
