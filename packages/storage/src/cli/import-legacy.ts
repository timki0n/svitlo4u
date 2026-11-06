/**
 * Import a legacy database into the svitlo4u database.
 *
 *   node packages/storage/src/cli/import-legacy.ts --db data/svitlo4u.db \
 *     --site 4u --name "ЖК 4U" --group 12.1 --legacy /tmp/svitlo.db --format svitlo [--adopt-open]
 *
 * Creates the site row if missing (region 25 / DSO 902 / Europe/Kyiv unless given).
 * Pass a copy of the legacy file, not the live one.
 */
import { parseArgs } from "node:util";
import { KYIV_TZ } from "@svitlo/domain";
import { closeDatabase, openDatabase } from "../db.ts";
import { importLegacyDatabase, type LegacyFormat } from "../legacy-import.ts";
import { createStore } from "../store.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    site: { type: "string" },
    name: { type: "string" },
    group: { type: "string" },
    region: { type: "string", default: "25" },
    dso: { type: "string", default: "902" },
    tz: { type: "string", default: KYIV_TZ },
    legacy: { type: "string" },
    format: { type: "string" },
    /** Power is off right now: continue the legacy ongoing outage (fresh database only). */
    "adopt-open": { type: "boolean", default: false },
  },
});

const required = ["db", "site", "group", "legacy", "format"] as const;
for (const key of required) {
  if (!values[key]) {
    console.error(`missing --${key}`);
    process.exit(2);
  }
}
if (values.format !== "svitlo" && values.format !== "light_bot") {
  console.error("--format must be svitlo or light_bot");
  process.exit(2);
}

const db = openDatabase(values.db as string);
try {
  const store = createStore(db);
  const siteId = values.site as string;
  if (!store.sites.get(siteId)) {
    store.sites.upsert({
      id: siteId,
      name: values.name ?? siteId,
      tz: values.tz as string,
      yasnoRegion: Number(values.region),
      yasnoDso: Number(values.dso),
      yasnoGroup: values.group as string,
    });
  }
  const report = importLegacyDatabase(store, {
    siteId,
    path: values.legacy as string,
    format: values.format as LegacyFormat,
    adoptOpen: values["adopt-open"] === true,
  });
  console.log(JSON.stringify({ site: siteId, ...report }, null, 2));
} finally {
  closeDatabase(db);
}
