# svitlo4u

Power monitoring for a residential complex: real power state (ESP32 heartbeat + Zigbee plug),
Yasno outage schedules, Telegram notifications, a public API for the web app and widgets.
Successor of `svitlo_web` and `light_bot_tg`.

## Layout

```
apps/core/        Node service: adapters, services, channels, HTTP API
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

## API

`/api/v1/*`: state, widget, schedules, outages, analytics and live updates (SSE). The contract is
`apps/core/src/api/contract.ts` (Zod); [`docs/openapi.json`](docs/openapi.json) is generated from it
(`pnpm --filter @svitlo/core openapi`) and a test fails while the two differ. Responses are
`Cache-Control: no-store`, limited to `API_RATE_PER_MINUTE` (120) per client.

## CI

- `check`: Biome, `tsc` (TypeScript 7), Vitest
- `secrets`: gitleaks over the full history — the repo is public, secrets live only in `deploy/.env` on the server
- `image`: native `linux/arm64` build, smoke test of `/health`, push to `ghcr.io/timki0n/svitlo4u-core` on `main`
