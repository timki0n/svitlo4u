import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { CoreConfig } from "./config.ts";

/** Hashed build output never changes under its name; everything else is revalidated. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** The web app talks only to this origin; the support link is a plain navigation. */
const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function buildServer(config: CoreConfig): FastifyInstance {
  const app = Fastify({
    logger: { level: config.logLevel },
  });
  const startedAt = Date.now();

  // Docker polls this every 15 s: keep it out of the request log.
  app.get("/health", { logLevel: "warn" }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return {
      status: "ok",
      version: config.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    };
  });

  if (config.webDir && existsSync(join(config.webDir, "index.html"))) {
    app.register(fastifyStatic, {
      root: config.webDir,
      cacheControl: false,
      setHeaders(res, path) {
        res.header("x-content-type-options", "nosniff");
        if (/[\\/]assets[\\/]/.test(path)) {
          res.header("cache-control", IMMUTABLE);
          return;
        }
        res.header("cache-control", "no-cache");
        if (path.endsWith(".html")) {
          res.header("content-security-policy", CSP);
          res.header("referrer-policy", "strict-origin-when-cross-origin");
        }
      },
    });
  }

  return app;
}
