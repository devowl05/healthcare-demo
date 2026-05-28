# syntax=docker/dockerfile:1.7
#
# Frontend container — Vite-built static bundle, served by nginx.
#
# Two stages:
#   1. `build`   — `bun run build` (= `tsc --noEmit && vite build`) into /app/dist.
#                  Dev deps are needed here, so we don't pass `--production`.
#   2. `runtime` — nginx alpine serving /usr/share/nginx/html with our SPA-aware
#                  config that also reverse-proxies /api/ to the backend service.
#
# Bun version pinned to match the developer's local install (1.3.14).

FROM oven/bun:1.3.14-slim AS build
WORKDIR /app
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN bun run build

FROM nginx:1.27-alpine AS runtime

# nginx alpine ships with a `nginx` user (uid 101) by default, but the master
# process still needs root to bind :80 and read /etc/nginx. We leave the
# upstream entrypoint to drop privileges to `nginx` for worker processes.
# (Running the master as non-root requires a different image and rewiring
# /var/cache/nginx, /run/nginx, etc. — out of scope for this tier.)

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
