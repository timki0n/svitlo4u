# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f apps/core/Dockerfile .

ARG NODE_IMAGE=node:26-trixie-slim

FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION=12.18.0
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --filter "@svitlo/core..." --store-dir /pnpm-store

# The web app is plain static files: build it once, on the build machine's own platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web
ARG PNPM_VERSION=12.18.0
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=pnpm-store-web,target=/pnpm-store \
    pnpm install --frozen-lockfile --filter "@svitlo/web" --store-dir /pnpm-store
COPY tsconfig.base.json ./
# the game's rules (floors, points) are shared with the core
COPY packages/domain/src/game.ts packages/domain/src/time.ts packages/domain/src/
COPY apps/web apps/web
RUN pnpm --filter @svitlo/web build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    TZ=Europe/Kyiv \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/app/data/svitlo4u.db \
    SITES_CONFIG=/app/config/sites.yaml \
    WEB_DIR=/app/apps/web/dist
WORKDIR /app
COPY --from=deps /app ./
COPY packages/domain/src packages/domain/src
COPY packages/storage/src packages/storage/src
COPY packages/storage/migrations packages/storage/migrations
COPY apps/core/src apps/core/src
COPY --from=web /app/apps/web/dist apps/web/dist
RUN mkdir -p /app/data /app/config && chown node:node /app/data

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.source="https://github.com/timki0n/svitlo4u" \
      org.opencontainers.image.description="svitlo4u: power monitoring, schedules, notifications and the web app"

USER node
EXPOSE 8080 5005/udp
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/core/src/main.ts"]
