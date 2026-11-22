# syntax=docker/dockerfile:1
# Build context: repository root.

FROM node:26-bookworm-slim AS deps
WORKDIR /repo
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
RUN npm ci --workspace @ci/web --include-workspace-root

# ── Development: Vite dev server ──
FROM deps AS dev
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
WORKDIR /repo/apps/web
EXPOSE 5173
CMD ["npx", "vite", "--host", "0.0.0.0"]

# ── Build static assets ──
FROM dev AS build
RUN npm run build

# ── Production (default target): static files behind unprivileged nginx, which also proxies
# /api to the private API service (API_UPSTREAM, substituted into the template at start-up) ──
FROM nginxinc/nginx-unprivileged:1.27-alpine AS prod
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
ENV API_UPSTREAM=api:4000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
