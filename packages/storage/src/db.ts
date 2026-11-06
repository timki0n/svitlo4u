import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Open (and migrate) the database. One process owns it; WAL keeps readers (backups, ad-hoc
 * queries) from blocking the writer. ":memory:" works for tests.
 */
export function openDatabase(path: string, options: { readonly?: boolean } = {}): Db {
  const readonly = options.readonly ?? false;
  const sqlite = new Database(path, { readonly, fileMustExist: readonly });
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  if (!readonly) {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
  }
  const db = drizzle(sqlite, { schema });
  if (!readonly) migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

export function closeDatabase(db: Db): void {
  db.$client.close();
}

/** Consistent, compact copy of the live database (safe while the core keeps writing). */
export function backupTo(db: Db, targetPath: string): void {
  db.$client.prepare("VACUUM INTO ?").run(targetPath);
}

/** Opens a backup read-only and checks it: integrity plus row counts of the main tables. */
export function verifyBackup(path: string): {
  ok: boolean;
  integrity: string;
  counts: Record<string, number>;
} {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(sqlite.pragma("integrity_check", { simple: true }));
    const counts: Record<string, number> = {};
    for (const table of [
      "sites",
      "outages",
      "schedule_snapshots",
      "voltage_samples",
      "power_events",
    ]) {
      const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      counts[table] = row.n;
    }
    return { ok: integrity === "ok", integrity, counts };
  } finally {
    sqlite.close();
  }
}
