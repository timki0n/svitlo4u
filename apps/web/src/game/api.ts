/**
 * The game's calls to the core. Every call carries the Mini App's signed launch data; the types come
 * from the core itself (type-only import, nothing of the core in the bundle).
 */
import type {
  GameBuilding,
  GameBuildings,
  GamePeriod,
  GameRating,
  GameRatingRow,
  GameSolve,
  GameState,
} from "../../../core/src/services/game.ts";
import { tgInitData } from "../telegram.ts";

export type { GameBuilding, GameBuildings, GamePeriod, GameRating, GameRatingRow, GameState };
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
  options: { signal?: AbortSignal; keepalive?: boolean } = {},
): Promise<T> {
  const initData = tgInitData();
  if (!initData) throw new GameApiError(401, "unauthorized");
  const response = await fetch(url, {
    method,
    headers: { authorization: `tma ${initData}`, accept: "application/json" },
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
  };
}
