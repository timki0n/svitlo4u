import { startCore } from "./app.ts";
import { loadConfig } from "./config.ts";

const core = await startCore(loadConfig());

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  core.app.log.info({ signal }, "shutting down");
  await core.stop();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
