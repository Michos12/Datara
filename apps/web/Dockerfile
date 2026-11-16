# syntax=docker/dockerfile:1
# Build context: repository root.

FROM node:24-bookworm-slim AS deps
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

# ── Production: static files behind nginx ──
FROM nginx:1.27-alpine AS prod
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
