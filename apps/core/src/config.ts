export type CoreConfig = {
  host: string;
  port: number;
  version: string;
  logLevel: string;
  /** SQLite file. */
  dbPath: string;
  /** config/sites.yaml; without it the core runs with no sites (health still answers). */
  sitesPath: string;
  /** UDP port for ESP heartbeats. */
  udpPort: number;
  mqttUrl: string | null;
  mqttUser: string;
  mqttPassword: string | null;
  /** Public origin (https://svitlo4u.info): Telegram webhooks are registered under it. */
  publicUrl: string | null;
  /** How Telegram updates arrive: webhook (needs publicUrl), long polling, or not at all. */
  telegramUpdates: "webhook" | "polling" | "off";
};

function port(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535)
    throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const httpPort = port(env.PORT, 8080, "PORT");
  if (httpPort === 0) throw new Error(`Invalid PORT: ${env.PORT}`);
  // Empty values (compose `VAR: ${VAR:-}`) count as unset.
  const publicUrl = env.PUBLIC_URL ? env.PUBLIC_URL.replace(/\/+$/, "") : null;
  if (publicUrl && !/^https:\/\/[^/]+$/.test(publicUrl))
    throw new Error(`Invalid PUBLIC_URL (https origin expected): ${env.PUBLIC_URL}`);
  const updates = env.TELEGRAM_UPDATES || (publicUrl ? "webhook" : "polling");
  if (updates !== "webhook" && updates !== "polling" && updates !== "off")
    throw new Error(`Invalid TELEGRAM_UPDATES: ${updates}`);
  if (updates === "webhook" && !publicUrl)
    throw new Error("TELEGRAM_UPDATES=webhook needs PUBLIC_URL");
  return {
    host: env.HOST ?? "0.0.0.0",
    port: httpPort,
    version: env.APP_VERSION ?? "dev",
    logLevel: env.LOG_LEVEL ?? "info",
    dbPath: env.DB_PATH ?? "data/svitlo4u.db",
    sitesPath: env.SITES_CONFIG ?? "config/sites.yaml",
    udpPort: port(env.HEARTBEAT_UDP_PORT, 5005, "HEARTBEAT_UDP_PORT"),
    mqttUrl: env.MQTT_URL ?? null,
    mqttUser: env.MQTT_USER ?? "core",
    mqttPassword: env.MQTT_CORE_PASSWORD ?? null,
    publicUrl,
    telegramUpdates: updates,
  };
}
