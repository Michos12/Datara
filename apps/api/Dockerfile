# syntax=docker/dockerfile:1
# Build context: repository root (the API depends on workspace packages).

FROM node:26-bookworm-slim AS base
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
# Prisma's migration engine needs OpenSSL; CA certificates for TLS to managed services.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates   && rm -rf /var/lib/apt/lists/*

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
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/
# Install scripts run so Prisma downloads its engines for `prisma migrate deploy`.
RUN npm ci --workspace @ci/api --omit=dev && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
# Migrations and the runtime-role script run from this image too (`npm run db:deploy`).
COPY apps/api/scripts apps/api/scripts
# Uploads and generated files. Owned by the runtime user: a volume or disk mounted here starts
# with this ownership, so the non-root process can write to it.
RUN mkdir -p /data/storage && chown node:node /data/storage
ENV STORAGE_DIR=/data/storage
WORKDIR /repo/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
