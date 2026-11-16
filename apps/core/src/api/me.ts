/**
 * The Mini App's personal part, signed in by Telegram (`Authorization: tma <initData>`):
 *
 *   GET  /api/v1/me                            my building and my hubs («Мій хаб»)
 *   PUT  /api/v1/me/site            {siteId}   my building: the Mini App opens on it everywhere
 *   POST /api/v1/me/hubs/:hubId/name  {name}   rename the building of my hub
 *   POST /api/v1/me/hubs/:hubId/release        let the hub go: the next scan of its sticker takes it
 */
import type { Store } from "@svitlo/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Clock } from "../runtime/clock.ts";
import { cleanName, type HubOwnership, NAME_MAX } from "../services/ownership.ts";
import { SITE_ID, type SiteConfig } from "../sites-config.ts";
import type { MeView } from "./me-view.ts";
import { type MiniAppUser, verifyInitData } from "./telegram-auth.ts";

export type MeDeps = {
  sites: () => readonly SiteConfig[];
  store: Store;
  clock: Clock;
  ownership: HubOwnership;
  /** The bot's @username for t.me links (null until it has connected). */
  botUsername: () => string | null;
};

const HubParams = z.object({ hubId: z.string().regex(/^hub-[0-9a-f]{6}$/) });
const SiteBody = z.object({ siteId: z.string().regex(SITE_ID) });
const NameBody = z.object({
  name: z
    .string()
    .min(1)
    .max(NAME_MAX * 4),
});

export function registerMe(app: FastifyInstance, deps: MeDeps): void {
  const fail = (reply: FastifyReply, status: number, error: string) =>
    reply.code(status).send({ error });

  /** The signed-in Telegram user (any bot of the configured buildings may have signed it). */
  const signedIn = (request: FastifyRequest, reply: FastifyReply): MiniAppUser | null => {
    reply.header("cache-control", "no-store");
    const header = request.headers.authorization ?? "";
    const initData = header.startsWith("tma ") ? header.slice(4) : "";
    const tokens = new Set(deps.sites().flatMap((s) => (s.telegram ? [s.telegram.botToken] : [])));
    for (const token of initData ? tokens : []) {
      const user = verifyInitData(initData, token, deps.clock.now());
      if (user) return user;
    }
    fail(reply, 401, "unauthorized");
    return null;
  };

  const me = (user: MiniAppUser): MeView => {
    const username = deps.botUsername();
    const sites = deps.sites();
    const mine = deps.store.telegramUsers.site(user.id);
    return {
      user: { id: user.id, firstName: user.firstName },
      siteId: mine && sites.some((s) => s.id === mine) ? mine : null,
      hubs: deps.ownership.hubsOf(user.id).map((hub) => ({
        ...hub,
        groupLink:
          hub.site && username ? `https://t.me/${username}?startgroup=${hub.site.id}` : null,
      })),
    };
  };

  app.get("/api/v1/me", async (request, reply) => {
    const user = signedIn(request, reply);
    return user ? me(user) : reply;
  });

  app.put("/api/v1/me/site", async (request, reply) => {
    const user = signedIn(request, reply);
    if (!user) return reply;
    const body = SiteBody.safeParse(request.body);
    if (!body.success || !deps.sites().some((s) => s.id === body.data.siteId))
      return fail(reply, 404, "unknown_site");
    deps.store.telegramUsers.setSite(user.id, body.data.siteId, deps.clock.now());
    return me(user);
  });

  app.post("/api/v1/me/hubs/:hubId/name", async (request, reply) => {
    const user = signedIn(request, reply);
    if (!user) return reply;
    const params = HubParams.safeParse(request.params);
    const body = NameBody.safeParse(request.body);
    const name = body.success ? cleanName(body.data.name) : null;
    if (!params.success || !name) return fail(reply, 400, "invalid_name");
    if (!deps.ownership.rename(user.id, params.data.hubId, name))
      return fail(reply, 403, "not_yours");
    return me(user);
  });

  app.post("/api/v1/me/hubs/:hubId/release", async (request, reply) => {
    const user = signedIn(request, reply);
    if (!user) return reply;
    const params = HubParams.safeParse(request.params);
    if (!params.success || !deps.ownership.release(user.id, params.data.hubId))
      return fail(reply, 403, "not_yours");
    return me(user);
  });
}
