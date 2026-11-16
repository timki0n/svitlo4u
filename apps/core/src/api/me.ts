/**
 * The Mini App's personal part, signed in by Telegram (`Authorization: tma <initData>`):
 *
 *   GET  /api/v1/me                            my building and my hubs («Мій хаб»), their chats
 *   PUT  /api/v1/me/site            {siteId}   my building: the Mini App opens on it everywhere
 *   POST /api/v1/me/hubs/:hubId/name  {name}   rename the building of my hub
 *   POST /api/v1/me/hubs/:hubId/release        let the hub go: the next scan of its sticker takes it
 *   POST /api/v1/me/chats/:chatId/feed   {threadId, on}  a chat of my building: a feed or not
 *   POST /api/v1/me/chats/:chatId/remove {threadId}      stop the notices there; the bot leaves
 *                                                        when nothing else is followed there
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
  /** The bot leaves a chat. */
  leaveChat: (siteId: string, chatId: number) => Promise<boolean>;
};

const HubParams = z.object({ hubId: z.string().regex(/^hub-[0-9a-f]{6}$/) });
const SiteBody = z.object({ siteId: z.string().regex(SITE_ID) });
const NameBody = z.object({
  name: z
    .string()
    .min(1)
    .max(NAME_MAX * 4),
});
const ChatParams = z.object({ chatId: z.coerce.number().int().negative() });
const FeedBody = z.object({ threadId: z.number().int().min(0), on: z.boolean() });
const RemoveBody = z.object({ threadId: z.number().int().min(0) });

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
        channelLink:
          hub.site && username ? `https://t.me/${username}?startchannel&admin=post_messages` : null,
      })),
    };
  };

  /** A chat (topic) of a building the user owns: its building, or an error reply. */
  const ownChat = (
    user: MiniAppUser,
    request: FastifyRequest,
    reply: FastifyReply,
    schema: typeof RemoveBody,
  ): { siteId: string; chatId: number; threadId: number } | null => {
    const params = ChatParams.safeParse(request.params);
    const body = schema.safeParse(request.body);
    if (!params.success || !body.success) {
      fail(reply, 400, "invalid_request");
      return null;
    }
    const { chatId } = params.data;
    const siteId = deps.ownership.ownedFollow(user.id, chatId, body.data.threadId);
    if (!siteId) {
      fail(reply, 403, "not_yours");
      return null;
    }
    return { siteId, chatId, threadId: body.data.threadId };
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

  app.post("/api/v1/me/chats/:chatId/feed", async (request, reply) => {
    const user = signedIn(request, reply);
    if (!user) return reply;
    const on = FeedBody.safeParse(request.body);
    const chat = ownChat(user, request, reply, RemoveBody);
    if (!chat) return reply;
    if (!on.success) return fail(reply, 400, "invalid_request");
    deps.store.telegram.setReadOnly(chat.siteId, chat.chatId, chat.threadId, on.data.on);
    return me(user);
  });

  app.post("/api/v1/me/chats/:chatId/remove", async (request, reply) => {
    const user = signedIn(request, reply);
    if (!user) return reply;
    const chat = ownChat(user, request, reply, RemoveBody);
    if (!chat) return reply;
    deps.store.telegram.unsubscribe(chat.siteId, chat.chatId, chat.threadId);
    // Nothing else is followed there: the bot leaves (Telegram then tells it it is gone).
    if (deps.store.telegram.ofChat(chat.chatId).length === 0)
      await deps.leaveChat(chat.siteId, chat.chatId);
    return me(user);
  });
}
