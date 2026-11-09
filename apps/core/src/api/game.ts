/**
 * The window game API. Only for the Telegram Mini App: every call carries its signed initData as
 * `Authorization: tma <initData>`. Not part of the public API (no OpenAPI): it serves the app only.
 *
 *   GET  /api/v1/sites/:siteId/game                       facade: session, lit windows, who plays
 *   POST /api/v1/sites/:siteId/game/windows/:w/start      opened a window (again every ~10 s)
 *   POST /api/v1/sites/:siteId/game/windows/:w/leave      left it
 *   POST /api/v1/sites/:siteId/game/windows/:w/solve      solved it → points
 *   GET  /api/v1/sites/:siteId/game/rating?period=…       session | week | all
 *   GET  /api/v1/sites/:siteId/game/avatars/:file?s=…     a player's photo (signed link)
 *
 * «Вечорниці» (the doors of the ground floor, see services/evenings.ts):
 *   GET  /api/v1/sites/:siteId/game/evenings/:door?since=…          the table (waits for a change)
 *   POST /api/v1/sites/:siteId/game/evenings/:door/parts/:part/start opened a part's puzzle
 *   POST /api/v1/sites/:siteId/game/evenings/:door/parts/:part/solve solved it → the part opens
 *   POST /api/v1/sites/:siteId/game/evenings/:door/join   { stake }  sit down (or queue)
 *   POST /api/v1/sites/:siteId/game/evenings/:door/leave             stand up
 *   POST /api/v1/sites/:siteId/game/evenings/:door/move   { type… }  a move of the game
 */
import { createReadStream, existsSync } from "node:fs";
import { isGameWindow } from "@svitlo/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Clock } from "../runtime/clock.ts";
import { EveningError, type EveningService } from "../services/evenings.ts";
import type { GameService } from "../services/game.ts";
import type { SiteConfig } from "../sites-config.ts";
import { type MiniAppUser, verifyInitData } from "./telegram-auth.ts";

const SiteParams = z.object({ siteId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });
const WindowParams = SiteParams.extend({ window: z.string().regex(/^\d{1,2}-\d{1,2}$/) });
const RatingQuery = z.object({ period: z.enum(["session", "week", "all"]).default("session") });
const AvatarParams = SiteParams.extend({ file: z.string().max(80) });
const AvatarQuery = z.object({ s: z.string().max(64) });
const DoorParams = SiteParams.extend({ door: z.coerce.number().int().min(1).max(9) });
const PartParams = DoorParams.extend({ part: z.coerce.number().int().min(1).max(9) });
const SinceQuery = z.object({ since: z.coerce.number().int().default(-1) });
const JoinBody = z.object({ stake: z.number().int().positive() });
const EmoteBody = z.object({ emoji: z.string().min(1).max(16) });
const MoveBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shuffle") }),
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("ring"), cell: z.number().int().min(0) }),
  z.object({ type: z.literal("fold") }),
  z.object({ type: z.literal("check") }),
  z.object({ type: z.literal("call") }),
  z.object({ type: z.literal("raise"), to: z.number().int().positive() }),
  z.object({ type: z.literal("throw"), card: z.string().length(2) }),
  z.object({
    type: z.literal("beat"),
    card: z.string().length(2),
    target: z.number().int().min(0).max(11),
  }),
  z.object({ type: z.literal("take") }),
  z.object({ type: z.literal("done") }),
  z.object({
    type: z.literal("play"),
    card: z.string().length(2),
    color: z.enum(["r", "y", "g", "b"]).optional(),
    target: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("draw") }),
  z.object({ type: z.literal("pass") }),
  z.object({ type: z.literal("nope") }),
  z.object({ type: z.literal("tuck"), at: z.number().int().min(-1).max(200) }),
]);

type Player = { site: SiteConfig; user: MiniAppUser };

export function registerGame(
  app: FastifyInstance,
  game: GameService,
  clock: Clock,
  evenings: EveningService,
): void {
  const fail = (reply: FastifyReply, status: number, error: string) =>
    reply.code(status).send({ error });

  /** The site and the signed-in player, or an error reply. */
  const player = (request: FastifyRequest, reply: FastifyReply): Player | null => {
    const params = SiteParams.safeParse(request.params);
    const site = params.success ? game.site(params.data.siteId) : null;
    if (!site?.telegram) {
      fail(reply, 404, "not_found");
      return null;
    }
    const header = request.headers.authorization ?? "";
    const initData = header.startsWith("tma ") ? header.slice(4) : "";
    const user = initData ? verifyInitData(initData, site.telegram.botToken, clock.now()) : null;
    if (!user) {
      fail(reply, 401, "unauthorized");
      return null;
    }
    game.join(site, user);
    return { site, user };
  };

  const windowOf = (request: FastifyRequest): { floor: number; col: number } | null => {
    const parsed = WindowParams.safeParse(request.params);
    if (!parsed.success) return null;
    const [floor, col] = parsed.data.window.split("-").map(Number) as [number, number];
    return isGameWindow(floor, col) ? { floor, col } : null;
  };

  app.get("/api/v1/sites/:siteId/game", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const state = game.state(p.site.id, p.user.id);
    const doors = evenings.overview(p.site.id);
    // who opened the doors and who sits at their tables: names and photos too
    const ids = doors.doors.flatMap((d) => [
      ...d.parts.filter((id): id is number => id !== null),
      ...d.players,
    ]);
    return {
      ...state,
      players: { ...game.views(p.site.id, ids), ...state.players },
      evenings: doors,
    };
  });

  // ── «Вечорниці» ─────────────────────────────────────────────────────────────────────────────

  /** Run a call of «Вечорниці»; its refusals answer 409 with their code. */
  const evening = async <T>(reply: FastifyReply, run: () => T | Promise<T>) => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof EveningError) return fail(reply, 409, e.message);
      throw e;
    }
  };

  app.get("/api/v1/sites/:siteId/game/evenings/:door", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const params = DoorParams.safeParse(request.params);
    const query = SinceQuery.safeParse(request.query);
    if (!params.success || !query.success) return fail(reply, 400, "bad_door");
    return evening(reply, () =>
      evenings.view(p.site.id, p.user.id, params.data.door, query.data.since),
    );
  });

  for (const action of ["start", "solve"] as const)
    app.post(
      `/api/v1/sites/:siteId/game/evenings/:door/parts/:part/${action}`,
      async (request, reply) => {
        const p = player(request, reply);
        if (!p) return reply;
        const params = PartParams.safeParse(request.params);
        if (!params.success) return fail(reply, 400, "bad_door");
        const { door, part } = params.data;
        return evening(reply, () => {
          if (action === "solve")
            return { ok: true, ...evenings.partSolve(p.site.id, p.user.id, door, part) };
          evenings.partStart(p.site.id, p.user.id, door, part);
          return { ok: true };
        });
      },
    );

  app.post("/api/v1/sites/:siteId/game/evenings/:door/join", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const params = DoorParams.safeParse(request.params);
    const body = JoinBody.safeParse(request.body);
    if (!params.success || !body.success) return fail(reply, 400, "bad_stake");
    return evening(reply, () => {
      evenings.join(p.site.id, p.user.id, params.data.door, body.data.stake);
      return { ok: true };
    });
  });

  app.post("/api/v1/sites/:siteId/game/evenings/:door/leave", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const params = DoorParams.safeParse(request.params);
    if (!params.success) return fail(reply, 400, "bad_door");
    return evening(reply, () => {
      evenings.leave(p.site.id, p.user.id, params.data.door);
      return { ok: true };
    });
  });

  app.post("/api/v1/sites/:siteId/game/evenings/:door/move", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const params = DoorParams.safeParse(request.params);
    const body = MoveBody.safeParse(request.body);
    if (!params.success || !body.success) return fail(reply, 400, "bad_move");
    return evening(reply, () => {
      evenings.act(p.site.id, p.user.id, params.data.door, body.data);
      return { ok: true };
    });
  });

  app.post("/api/v1/sites/:siteId/game/evenings/:door/emote", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const params = DoorParams.safeParse(request.params);
    const body = EmoteBody.safeParse(request.body);
    if (!params.success || !body.success) return fail(reply, 400, "bad_emote");
    return evening(reply, () => {
      evenings.emote(p.site.id, p.user.id, params.data.door, body.data.emoji);
      return { ok: true };
    });
  });

  app.post("/api/v1/sites/:siteId/game/windows/:window/start", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const w = windowOf(request);
    if (!w) return fail(reply, 400, "bad_window");
    if (!game.start(p.site.id, p.user.id, w.floor, w.col)) return fail(reply, 409, "no_session");
    return { ok: true };
  });

  app.post("/api/v1/sites/:siteId/game/windows/:window/leave", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const w = windowOf(request);
    if (!w) return fail(reply, 400, "bad_window");
    game.leave(p.site.id, p.user.id, w.floor, w.col);
    return { ok: true };
  });

  app.post("/api/v1/sites/:siteId/game/windows/:window/solve", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const w = windowOf(request);
    if (!w) return fail(reply, 400, "bad_window");
    const result = game.solve(p.site.id, p.user.id, w.floor, w.col);
    if (!result.ok) return fail(reply, 409, result.error);
    return result;
  });

  app.get("/api/v1/sites/:siteId/game/rating", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    const query = RatingQuery.safeParse(request.query);
    if (!query.success) return fail(reply, 400, "bad_period");
    return game.rating(p.site.id, p.site.tz, p.user.id, query.data.period);
  });

  app.get("/api/v1/sites/:siteId/game/buildings", async (request, reply) => {
    const p = player(request, reply);
    if (!p) return reply;
    return game.buildings(p.site.id);
  });

  app.get("/api/v1/sites/:siteId/game/avatars/:file", async (request, reply) => {
    const params = AvatarParams.safeParse(request.params);
    const query = AvatarQuery.safeParse(request.query);
    const path =
      params.success && query.success
        ? game.avatarFile(params.data.siteId, params.data.file, query.data.s)
        : null;
    if (!path || !existsSync(path)) return fail(reply, 404, "not_found");
    return reply.type("image/jpeg").send(createReadStream(path));
  });
}
