/**
 * Hubs at the bench (docs/hub-protocol.md → Provisioning):
 *
 *   node apps/core/src/cli/hub.ts new [--bot <username>]    a new hub: id, secret, the sticker's link
 *   node apps/core/src/cli/hub.ts link <hub id> [--bot …]   the sticker's link of a hub (to reprint)
 *   node apps/core/src/cli/hub.ts list                      every hub: building, owner
 *
 * On the server: `docker compose exec -T core node apps/core/src/cli/hub.ts new`. `new` prints
 * JSON with the secret (for `provision <id> <secret>` in the hub's console): pipe it into the
 * bench script (firmware/hub/tools/factory.py), do not paste it anywhere. The running core picks
 * the hub up from the database when it first reports; its owner claims it by the sticker.
 */
import { existsSync } from "node:fs";
import { closeDatabase, createStore, openDatabase } from "@svitlo/storage";
import { loadConfig } from "../config.ts";
import { SystemClock } from "../runtime/clock.ts";
import { claimPayload, HubOwnership, NO_STATUS } from "../services/ownership.ts";
import { loadSitesConfig } from "../sites-config.ts";

const [command, ...args] = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? null) : null;
};
const bot = option("--bot") ?? process.env.TELEGRAM_BOT_USERNAME ?? null;
const linkOf = (payload: string) => (bot ? `https://t.me/${bot}?start=${payload}` : null);

const config = loadConfig();
const sites = existsSync(config.sitesPath) ? loadSitesConfig(config.sitesPath) : [];
const db = openDatabase(config.dbPath);
try {
  const store = createStore(db);
  const ownership = new HubOwnership({
    store,
    clock: new SystemClock(),
    sites: () => sites,
    configHubs: sites.flatMap((s) => (s.hub ? [s.hub] : [])),
    addSite: () => {},
    hubReady: () => {},
    status: () => NO_STATUS,
    light: () => ({ power: "unknown", since: null }),
  });
  if (command === "new") {
    const hub = ownership.newHub();
    console.log(JSON.stringify({ ...hub, link: linkOf(hub.payload) }));
  } else if (command === "link" && args[0]) {
    const secret = ownership.secretOf(args[0]);
    if (!secret) throw new Error(`unknown hub ${args[0]}`);
    const payload = claimPayload(args[0], secret);
    console.log(JSON.stringify({ id: args[0], payload, link: linkOf(payload) }));
  } else if (command === "list") {
    const rows = [
      ...sites.flatMap((s) => (s.hub ? [store.hubs.get(s.hub.id)] : [])),
      ...store.hubs.listWithSecret(),
    ];
    for (const row of rows) {
      if (!row) continue;
      console.log(
        `${row.id}\t${row.siteId ?? "-"}\towner ${row.ownerUserId ?? "-"}\tfirmware ${row.firmware}`,
      );
    }
  } else {
    console.error("usage: hub.ts new [--bot <username>] | link <hub id> [--bot …] | list");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  closeDatabase(db);
}
