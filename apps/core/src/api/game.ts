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
 */
import { createReadStream, existsSync } from "node:fs";
import { isGameWindow } from "@svitlo/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Clock } from "../runtime/clock.ts";
import type { GameService } from "../services/game.ts";
import type { SiteConfig } from "../sites-config.ts";
import { type MiniAppUser, verifyInitData } from "./telegram-auth.ts";

const SiteParams = z.object({ siteId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) });
const WindowParams = SiteParams.extend({ window: z.string().regex(/^\d{1,2}-\d{1,2}$/) });
const RatingQuery = z.object({ period: z.enum(["session", "week", "all"]).default("session") });
const AvatarParams = SiteParams.extend({ file: z.string().max(80) });
const AvatarQuery = z.object({ s: z.string().max(64) });

type Player = { site: SiteConfig; user: MiniAppUser };

export function registerGame(app: FastifyInstance, game: GameService, clock: Clock): void {
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
    return game.state(p.site.id, p.user.id);
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
