import Fastify, { type FastifyInstance } from "fastify";
import type { CoreConfig } from "./config.ts";

export function buildServer(config: CoreConfig): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
  });
  const startedAt = Date.now();

  app.get("/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      status: "ok",
      version: config.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
  });

  return app;
}
