# syntax=docker/dockerfile:1
# Build context: repository root.  docker build -f apps/core/Dockerfile .

ARG NODE_IMAGE=node:26-trixie-slim

FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION=12.18.0
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --prod --filter "@svitlo/core..." --store-dir /pnpm-store

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    TZ=Europe/Kyiv \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=deps /app ./
COPY packages/domain/src packages/domain/src
COPY apps/core/src apps/core/src

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.source="https://github.com/timki0n/svitlo4u" \
      org.opencontainers.image.description="svitlo4u core: power monitoring, schedules, notifications"

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/core/src/main.ts"]
