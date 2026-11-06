# svitlo4u

Power monitoring for a residential complex: real power state (ESP32 heartbeat + Zigbee plug),
Yasno outage schedules, Telegram notifications, a public API for the web app and widgets.
Successor of `svitlo_web` and `light_bot_tg`.

## Layout

```
apps/core/        Node service: adapters, services, channels, HTTP API; serves the web app
apps/web/         Web app (React + Vite): «Зараз», «Графік», «Історія»; 3D figure on three.js
packages/domain/  Pure domain logic (no I/O) + tests
packages/storage/ SQLite schema, migrations, repositories
docs/             ESP protocol, OpenAPI (generated)
deploy/           Docker Compose for the Orange Pi: core, cloudflared, mosquitto, zigbee2mqtt
```

## Development

Requires Node 26 (see `.nvmrc`) and pnpm 12 (`corepack enable` or `npm i -g pnpm@12`).

```bash
pnpm install
pnpm dev          # core with --watch, http://localhost:8080/health
pnpm check        # lint + typecheck + tests
```

TypeScript runs natively in Node (type stripping) — no build step. Use erasable syntax only
(no enums/namespaces) and import local files with the `.ts` extension.

### Web

```bash
pnpm --filter @svitlo/web dev     # http://localhost:5173, API proxied to https://svitlo4u.info
pnpm --filter @svitlo/web build   # apps/web/dist
```

Point the dev proxy at another core with `SVITLO_API` (environment or `apps/web/.env.local`, e.g.
`SVITLO_API=http://127.0.0.1:8080`). The web takes its types from the core's API contract and
computes nothing itself: totals, forecasts and outcomes come from the API. In production the core
serves `apps/web/dist` from `WEB_DIR` on the same origin: hashed assets are cached for a year,
`index.html` is revalidated and carries a strict CSP (everything from `'self'`).

`#/render/<site>/<today|tomorrow>` is the schedule card alone, 420 px wide — the picture the core
sends to Telegram. Try it against any Chromium started with `--remote-debugging-port`:

```bash
export RENDERER_CDP_URL=http://127.0.0.1:9222 RENDER_WEB_URL=http://localhost:5173
pnpm --filter @svitlo/core render 4u tomorrow tomorrow.png
```

## API

`/api/v1/*`: state, widget, schedules, outages, analytics and live updates (SSE). The contract is
`apps/core/src/api/contract.ts` (Zod); [`docs/openapi.json`](docs/openapi.json) is generated from it
(`pnpm --filter @svitlo/core openapi`) and a test fails while the two differ. Responses are
`Cache-Control: no-store`, limited to `API_RATE_PER_MINUTE` (120) per client.

## CI

- `check`: Biome, `tsc` (TypeScript 7), Vitest
- `secrets`: gitleaks over the full history — the repo is public, secrets live only in `deploy/.env` on the server
- `image`: native `linux/arm64` build (the web app is built in it too), smoke test of `/health` and `/`, push to `ghcr.io/timki0n/svitlo4u-core` on `main`
