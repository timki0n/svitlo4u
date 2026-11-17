/**
 * «Знайти мій будинок»: find any Kyiv address (YASNO's search), see whether Світло4U is there, and if
 * not, leave a request — the first people who want a hub.
 *
 *   GET  /api/v1/addresses/streets?q=…                 streets ({id, name}), YASNO's spelling
 *   GET  /api/v1/addresses/houses?street=…&q=…         houses of a street
 *   GET  /api/v1/addresses/lookup?street=…&house=…     its queue, and the public building there
 *   POST /api/v1/requests {street, house, streetName, houseName, canAdmin, sparePhone, routerOk,
 *        wantsVoltage, contact?}
 *        a request; the Mini App's user is known, on the site a contact is needed. canAdmin: the
 *        person can run Світло4U in the building; only then the rest count — an old phone that can
 *        stay on charge (the quick start), a router that works without light, the voltage wanted
 *   POST /api/v1/admin/addresses {siteId, street, house, streetName, houseName}
 *        the admin gives a public building an address (the search then finds it there); owners
 *        do not: a building's address is not theirs to claim
 */
import type { Store } from "@svitlo/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { YasnoAddresses } from "../adapters/yasno-addresses.ts";
import type { Bus } from "../runtime/bus.ts";
import type { Clock } from "../runtime/clock.ts";
import { cleanName } from "../services/ownership.ts";
import { isAdminUser, SITE_ID, type SiteConfig } from "../sites-config.ts";
import { clientKey } from "./rate-limit.ts";
import { type MiniAppUser, verifyInitData } from "./telegram-auth.ts";

export type AddressDeps = {
  addresses: YasnoAddresses;
  sites: () => readonly SiteConfig[];
  store: Store;
  clock: Clock;
  bus: Bus;
};

const Id = z.coerce.number().int().positive().max(1e9);
const StreetsQuery = z.object({ q: z.string().max(60) });
const HousesQuery = z.object({ street: Id, q: z.string().max(20).default("") });
const LookupQuery = z.object({ street: Id, house: Id });
const RequestBody = z.object({
  street: Id,
  house: Id,
  streetName: z.string().min(1).max(120),
  houseName: z.string().min(1).max(40),
  canAdmin: z.boolean().default(false),
  sparePhone: z.boolean().default(false),
  routerOk: z.boolean().default(false),
  wantsVoltage: z.boolean().default(false),
  contact: z.string().max(100).optional(),
});
const AttachBody = RequestBody.pick({
  street: true,
  house: true,
  streetName: true,
  houseName: true,
}).extend({
  siteId: z.string().regex(SITE_ID),
});

/** Requests per client in a window: a form, not a feed. */
const REQUESTS_PER_WINDOW = 5;
const REQUEST_WINDOW_MS = 10 * 60_000;

export function registerAddresses(app: FastifyInstance, deps: AddressDeps): void {
  const fail = (reply: FastifyReply, status: number, error: string) =>
    reply.code(status).send({ error });
  const recent = new Map<string, number[]>();

  /** The Mini App's Telegram user, or null (a plain browser). */
  const telegramUser = (request: FastifyRequest): MiniAppUser | null => {
    const header = request.headers.authorization ?? "";
    const initData = header.startsWith("tma ") ? header.slice(4) : "";
    if (!initData) return null;
    const tokens = new Set(deps.sites().flatMap((s) => (s.telegram ? [s.telegram.botToken] : [])));
    for (const token of tokens) {
      const user = verifyInitData(initData, token, deps.clock.now());
      if (user) return user;
    }
    return null;
  };

  const addressText = (street: string, house: string) =>
    `${cleanName(street) ?? ""}, ${cleanName(house) ?? ""}`;

  app.get("/api/v1/addresses/streets", async (request, reply) => {
    const query = StreetsQuery.safeParse(request.query);
    if (!query.success) return fail(reply, 400, "invalid_query");
    try {
      return { streets: (await deps.addresses.streets(query.data.q)).slice(0, 20) };
    } catch {
      return fail(reply, 502, "yasno_unavailable");
    }
  });

  app.get("/api/v1/addresses/houses", async (request, reply) => {
    const query = HousesQuery.safeParse(request.query);
    if (!query.success) return fail(reply, 400, "invalid_query");
    try {
      return {
        houses: (await deps.addresses.houses(query.data.street, query.data.q)).slice(0, 60),
      };
    } catch {
      return fail(reply, 502, "yasno_unavailable");
    }
  });

  app.get("/api/v1/addresses/lookup", async (request, reply) => {
    const query = LookupQuery.safeParse(request.query);
    if (!query.success) return fail(reply, 400, "invalid_query");
    const { street, house } = query.data;
    const siteId = deps.store.siteAddresses.siteAt(street, house);
    // Only public buildings: a private house is found by its link, never by its address.
    const site = deps.sites().find((s) => s.id === siteId && s.access === "public") ?? null;
    return {
      group: await deps.addresses.group(street, house),
      site: site ? { id: site.id, name: site.name } : null,
    };
  });

  app.post("/api/v1/requests", async (request, reply) => {
    const body = RequestBody.safeParse(request.body);
    if (!body.success) return fail(reply, 400, "invalid_request");
    const user = telegramUser(request);
    const contact = body.data.contact?.trim() ?? "";
    if (!user && contact.length < 3) return fail(reply, 400, "contact_needed");
    const now = deps.clock.now();
    const key = clientKey(request);
    const times = (recent.get(key) ?? []).filter((t) => now - t < REQUEST_WINDOW_MS);
    if (times.length >= REQUESTS_PER_WINDOW) return fail(reply, 429, "rate_limited");
    recent.set(key, [...times, now]);

    const { street, house, streetName, houseName, canAdmin } = body.data;
    // The setup questions open under «можу адмініструвати»: without it they say nothing.
    const has = {
      canAdmin,
      sparePhone: canAdmin && body.data.sparePhone,
      routerOk: canAdmin && body.data.routerOk,
      wantsVoltage: canAdmin && body.data.wantsVoltage,
    };
    const group = await deps.addresses.group(street, house);
    const address = addressText(streetName, houseName);
    const id = deps.store.requests.add({
      streetId: street,
      houseId: house,
      address,
      yasnoGroup: group,
      ...has,
      contact: contact ? (cleanName(contact) ?? null) : null,
      userId: user?.id ?? null,
      username: user?.username ?? null,
      createdAt: now,
    });
    deps.bus.emit("request.new", {
      id,
      address,
      group,
      ...has,
      contact: user ? (user.username ? `@${user.username}` : `tg ${user.id}`) : contact,
    });
    return { ok: true };
  });

  app.post("/api/v1/admin/addresses", async (request, reply) => {
    const user = telegramUser(request);
    if (!user) return fail(reply, 401, "unauthorized");
    if (!isAdminUser(deps.sites(), user.id)) return fail(reply, 403, "admins_only");
    const body = AttachBody.safeParse(request.body);
    if (!body.success) return fail(reply, 400, "invalid_request");
    const { siteId, street, house, streetName, houseName } = body.data;
    const site = deps.sites().find((s) => s.id === siteId);
    if (site?.access !== "public") return fail(reply, 404, "unknown_site");
    deps.store.siteAddresses.attach(
      siteId,
      { streetId: street, houseId: house, text: addressText(streetName, houseName) },
      deps.clock.now(),
    );
    return { ok: true };
  });
}
