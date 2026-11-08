/**
 * The window game online: players from the Telegram Mini App, solved windows and points per session
 * (a session is an outage: the facade starts dark at every new outage, not when the light returns),
 * the rating (session, week from Monday, all time), who is playing which window right now, and
 * avatars fetched through the Bot API and served from the core (the page allows only own images).
 *
 * The puzzles run on the phone; the core only checks the window, that it was opened a moment ago
 * by the same player, and that the player has not scored it already this session.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gamePoints, gameWeekStart, isGameWindow } from "@svitlo/domain";
import type { Store } from "@svitlo/storage";
import type { MiniAppUser } from "../api/telegram-auth.ts";
import type { Clock } from "../runtime/clock.ts";
import type { SiteConfig } from "../sites-config.ts";

/** A window counts as being played while the phone checks in at least this often. */
export const PRESENCE_MS = 30_000;
/** A puzzle solved faster than this after opening it does not count. */
export const MIN_SOLVE_MS = 3_000;
const AVATAR_TTL_MS = 3 * 86_400_000;
/** A player's name is refreshed at most this often. */
const JOIN_EVERY_MS = 10 * 60_000;
const AVATAR_MAX_BYTES = 512_000;
const RATING_ROWS = 50;

export type GameDeps = {
  sites: readonly SiteConfig[];
  store: Store;
  clock: Clock;
  /** Where avatars are saved; null keeps them off (tests, in-memory database). */
  avatarDir: string | null;
  fetch?: (url: string) => Promise<Response>;
  log: { warn: (obj: object, msg: string) => void };
};

export type GamePeriod = "session" | "week" | "all";
export type GameSession = { start: number; end: number | null };
export type GamePlayerView = { name: string; username: string | null; avatar: string | null };
export type GameState = {
  session: GameSession | null;
  me: { id: number; points: Record<GamePeriod, number> };
  windows: { floor: number; col: number; solvers: { id: number; points: number; at: number }[] }[];
  playing: { floor: number; col: number; ids: number[] }[];
  players: Record<string, GamePlayerView>;
};
export type GameRatingRow = GamePlayerView & {
  rank: number;
  id: number;
  points: number;
  windows: number;
};
export type GameRating = {
  period: GamePeriod;
  /** Start of the period (session start, Monday 00:00), null for all time. */
  since: number | null;
  /** When the weekly rating starts over. */
  resetsAt: number | null;
  rows: GameRatingRow[];
  me: GameRatingRow | null;
};
export type GameSolve =
  | { ok: true; points: number; first: boolean; already: boolean }
  | { ok: false; error: "no_session" | "start_first" | "too_fast" };

type Presence = { session: number; startedAt: number; until: number };

export class GameService {
  private readonly deps: GameDeps;
  /** site → "floor-col" → user → presence */
  private readonly presence = new Map<string, Map<string, Map<number, Presence>>>();
  private readonly avatarsInFlight = new Set<string>();
  private readonly joined = new Map<string, number>();

  constructor(deps: GameDeps) {
    this.deps = deps;
    if (deps.avatarDir) mkdirSync(deps.avatarDir, { recursive: true });
  }

  site(siteId: string): SiteConfig | null {
    return this.deps.sites.find((s) => s.id === siteId && s.telegram) ?? null;
  }

  session(siteId: string): GameSession | null {
    return this.deps.store.outages.latest(siteId, this.deps.clock.now());
  }

  /**
   * Any call of a signed-in player: remember who they are (at most every few minutes, the phone
   * polls) and fetch their photo now and then.
   */
  join(site: SiteConfig, user: MiniAppUser): void {
    const { store, clock } = this.deps;
    const now = clock.now();
    const key = `${site.id}:${user.id}`;
    if ((this.joined.get(key) ?? Number.NEGATIVE_INFINITY) > now - JOIN_EVERY_MS) return;
    this.joined.set(key, now);
    const known = store.game.player(site.id, user.id);
    store.game.upsertPlayer(site.id, { userId: user.id, ...user }, now);
    if (!known?.avatarCheckedAt || now - known.avatarCheckedAt > AVATAR_TTL_MS)
      void this.fetchAvatar(site, user.id);
  }

  /** Opened a window's puzzle, or still playing it (the phone checks in). */
  start(siteId: string, userId: number, floor: number, col: number): boolean {
    const session = this.session(siteId);
    if (!session || !isGameWindow(floor, col)) return false;
    const now = this.deps.clock.now();
    const windows = this.windowsOf(siteId);
    const key = `${floor}-${col}`;
    const users = windows.get(key) ?? new Map<number, Presence>();
    const known = users.get(userId);
    const startedAt =
      known && known.session === session.start && known.until > now ? known.startedAt : now;
    users.set(userId, { session: session.start, startedAt, until: now + PRESENCE_MS });
    windows.set(key, users);
    return true;
  }

  leave(siteId: string, userId: number, floor: number, col: number): void {
    this.windowsOf(siteId).get(`${floor}-${col}`)?.delete(userId);
  }

  solve(siteId: string, userId: number, floor: number, col: number): GameSolve {
    const { store, clock } = this.deps;
    const session = this.session(siteId);
    if (!session) return { ok: false, error: "no_session" };
    const now = clock.now();
    const played = this.windowsOf(siteId).get(`${floor}-${col}`)?.get(userId);
    if (!played || played.session !== session.start || played.until < now)
      return { ok: false, error: "start_first" };
    if (now - played.startedAt < MIN_SOLVE_MS) return { ok: false, error: "too_fast" };
    this.leave(siteId, userId, floor, col);
    const solves = store.game.solves(siteId, session.start);
    const here = solves.filter((s) => s.floor === floor && s.col === col);
    if (here.some((s) => s.userId === userId))
      return { ok: true, points: 0, first: false, already: true };
    const first = here.length === 0;
    const points = gamePoints(floor, first);
    store.game.addSolve({
      siteId,
      session: session.start,
      floor,
      col,
      userId,
      points,
      durationMs: now - played.startedAt,
      solvedAt: now,
    });
    return { ok: true, points, first, already: false };
  }

  state(siteId: string, userId: number): GameState {
    const { store } = this.deps;
    const session = this.session(siteId);
    const solves = session ? store.game.solves(siteId, session.start) : [];
    const windows = new Map<string, GameState["windows"][number]>();
    for (const s of solves) {
      const key = `${s.floor}-${s.col}`;
      const w = windows.get(key) ?? { floor: s.floor, col: s.col, solvers: [] };
      w.solvers.push({ id: s.userId, points: s.points, at: s.solvedAt });
      windows.set(key, w);
    }
    const playing = session ? this.playing(siteId, session.start) : [];
    const ids = new Set<number>([userId, ...solves.map((s) => s.userId)]);
    for (const p of playing) for (const id of p.ids) ids.add(id);
    return {
      session,
      me: { id: userId, points: this.pointsOf(siteId, userId, session) },
      windows: [...windows.values()],
      playing,
      players: this.views(siteId, [...ids]),
    };
  }

  rating(siteId: string, tz: string, userId: number, period: GamePeriod): GameRating {
    const { store, clock } = this.deps;
    const session = this.session(siteId);
    const weekStart = gameWeekStart(clock.now(), tz);
    const totals =
      period === "session"
        ? session
          ? store.game.totals(siteId, { session: session.start })
          : []
        : period === "week"
          ? store.game.totals(siteId, { since: weekStart })
          : store.game.totals(siteId);
    const ranked = totals.map((t, i) => ({ ...t, rank: i + 1 }));
    const shown = ranked.slice(0, RATING_ROWS);
    const mine = ranked.find((t) => t.userId === userId) ?? null;
    const views = this.views(
      siteId,
      [...shown, ...(mine ? [mine] : [])].map((t) => t.userId),
    );
    const row = (t: (typeof ranked)[number]): GameRatingRow => ({
      ...(views[t.userId] ?? { name: "Сусід", username: null, avatar: null }),
      rank: t.rank,
      id: t.userId,
      points: t.points,
      windows: t.windows,
    });
    return {
      period,
      since: period === "session" ? (session?.start ?? null) : period === "week" ? weekStart : null,
      resetsAt: period === "week" ? weekStart + 7 * 86_400_000 : null,
      rows: shown.map(row),
      me: mine ? row(mine) : null,
    };
  }

  /** The saved photo behind a signed avatar link. */
  avatarFile(siteId: string, file: string, sig: string): string | null {
    const dir = this.deps.avatarDir;
    const site = this.site(siteId);
    const m = /^([a-z0-9-]+)-(\d+)\.jpg$/.exec(file);
    if (!dir || !site || !m || m[1] !== siteId) return null;
    const expected = Buffer.from(this.avatarSig(site, Number(m[2])));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return join(dir, file);
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────

  private windowsOf(siteId: string): Map<string, Map<number, Presence>> {
    let windows = this.presence.get(siteId);
    if (!windows) {
      windows = new Map();
      this.presence.set(siteId, windows);
    }
    return windows;
  }

  private playing(siteId: string, session: number): GameState["playing"] {
    const now = this.deps.clock.now();
    const out: GameState["playing"] = [];
    for (const [key, users] of this.windowsOf(siteId)) {
      for (const [id, p] of users) if (p.until < now || p.session !== session) users.delete(id);
      if (users.size === 0) continue;
      const [floor, col] = key.split("-").map(Number) as [number, number];
      out.push({ floor, col, ids: [...users.keys()] });
    }
    return out;
  }

  private pointsOf(
    siteId: string,
    userId: number,
    session: GameSession | null,
  ): Record<GamePeriod, number> {
    const { store, clock } = this.deps;
    const tz = this.site(siteId)?.tz ?? "Europe/Kyiv";
    const of = (rows: { userId: number; points: number }[]) =>
      rows.find((r) => r.userId === userId)?.points ?? 0;
    return {
      session: session ? of(store.game.totals(siteId, { session: session.start })) : 0,
      week: of(store.game.totals(siteId, { since: gameWeekStart(clock.now(), tz) })),
      all: of(store.game.totals(siteId)),
    };
  }

  private views(siteId: string, ids: readonly number[]): Record<string, GamePlayerView> {
    const site = this.site(siteId);
    const out: Record<string, GamePlayerView> = {};
    for (const p of this.deps.store.game.players(siteId, [...new Set(ids)])) {
      out[p.userId] = {
        name: [p.firstName, p.lastName].filter(Boolean).join(" "),
        username: p.username,
        avatar:
          p.avatar && site
            ? `/api/v1/sites/${siteId}/game/avatars/${p.avatar}?s=${this.avatarSig(site, p.userId)}`
            : null,
      };
    }
    return out;
  }

  private avatarSig(site: SiteConfig, userId: number): string {
    const secret = createHash("sha256")
      .update(`svitlo4u-game-avatar:${site.telegram?.botToken ?? ""}`)
      .digest();
    return createHmac("sha256", secret).update(`${site.id}:${userId}`).digest("hex").slice(0, 20);
  }

  private async fetchAvatar(site: SiteConfig, userId: number): Promise<void> {
    const { avatarDir, store, clock, log } = this.deps;
    const token = site.telegram?.botToken;
    const flight = `${site.id}:${userId}`;
    if (!avatarDir || !token || this.avatarsInFlight.has(flight)) return;
    this.avatarsInFlight.add(flight);
    const get = this.deps.fetch ?? ((url: string) => fetch(url));
    const api = (method: string, query: string) =>
      `https://api.telegram.org/bot${token}/${method}?${query}`;
    try {
      const photos = (await (
        await get(api("getUserProfilePhotos", `user_id=${userId}&limit=1`))
      ).json()) as {
        ok?: boolean;
        result?: { photos?: { file_id: string; width: number }[][] };
      };
      const sizes = photos.ok ? photos.result?.photos?.[0] : undefined;
      const size = sizes?.find((s) => s.width >= 160) ?? sizes?.at(-1);
      if (!size) {
        store.game.setAvatar(site.id, userId, null, clock.now());
        return;
      }
      const file = (await (
        await get(api("getFile", `file_id=${encodeURIComponent(size.file_id)}`))
      ).json()) as {
        result?: { file_path?: string };
      };
      const path = file.result?.file_path;
      const response = path ? await get(`https://api.telegram.org/file/bot${token}/${path}`) : null;
      const bytes = response?.ok ? Buffer.from(await response.arrayBuffer()) : null;
      if (!bytes || bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) {
        store.game.setAvatar(site.id, userId, null, clock.now());
        return;
      }
      const name = `${site.id}-${userId}.jpg`;
      await writeFile(join(avatarDir, name), bytes);
      store.game.setAvatar(site.id, userId, name, clock.now());
    } catch (err) {
      // Only the message: a URL in the error would carry the bot token.
      log.warn(
        { site: site.id, err: err instanceof Error ? err.name : "error" },
        "game avatar not fetched",
      );
    } finally {
      this.avatarsInFlight.delete(flight);
    }
  }
}
