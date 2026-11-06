export type CoreConfig = {
  host: string;
  port: number;
  version: string;
  logLevel: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port,
    version: env.APP_VERSION ?? "dev",
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
