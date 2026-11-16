# syntax=docker/dockerfile:1
# Build context: repository root (the API depends on workspace packages).

FROM node:24-bookworm-slim AS base
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false

# ── Dependencies (including dev) + generated Prisma client ──
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/
RUN npm ci --workspace @ci/api --include-workspace-root

# ── Development: hot reload via `docker compose up --watch` ──
FROM deps AS dev
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
WORKDIR /repo/apps/api
ENV NODE_ENV=development
EXPOSE 4000
CMD ["npx", "tsx", "watch", "src/server.ts"]

# ── Build ──
FROM dev AS build
RUN npx tsup

# ── Production runtime: production deps only, non-root ──
FROM base AS prod
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --workspace @ci/api --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/prisma apps/api/prisma
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
