/**
 * One backup right now, with the same settings as the nightly run — to check the R2 setup:
 *   docker compose exec core node apps/core/src/cli/backup.ts
 */
import { KYIV_TZ } from "@svitlo/domain";
import { closeDatabase, openDatabase } from "@svitlo/storage";
import { loadConfig } from "../config.ts";
import { SystemClock } from "../runtime/clock.ts";
import { BackupService, loadBackupConfig } from "../services/backup.ts";

const config = loadConfig();
const backupConfig = loadBackupConfig(process.env, KYIV_TZ);
if (!backupConfig) {
  console.error("backups are not configured: set BACKUP_S3_* in deploy/.env");
  process.exit(2);
}
const db = openDatabase(config.dbPath);
try {
  const service = new BackupService({ db, config: backupConfig, clock: new SystemClock() });
  const result = await service.runNow();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  closeDatabase(db);
}
