# syntax=docker/dockerfile:1.7
#
# Backend container — Bun + Hono.
#
# Two stages:
#   1. `deps`    — `bun install --frozen-lockfile --production` against the lockfile
#                  so the runtime image holds only prod deps (no dev deps, no test deps).
#   2. `runtime` — copy node_modules + src and run as the non-root `bun` user that
#                  the upstream image already provisions (uid 1000).
#
# Why pin `1.3.14-slim`: matches the developer's local Bun version so behavior
# (especially around the `fetch`/streams APIs the agent loop depends on) is
# identical between `bun dev` and `docker compose up`.

FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app
# Copy lockfile + manifest only so changes elsewhere don't bust the install cache.
# bun.lockb is the binary lockfile (older Bun) and bun.lock is the text lockfile
# (current). We accept either with the trailing `*` glob.
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app

# Apply OS security patches on top of the base image. The upstream slim image
# lags the Debian security stream, so a freshly-disclosed CVE in a base package
# (e.g. libcap2 CVE-2026-4878) would otherwise fail the Trivy HIGH/CRITICAL gate
# even though a fix is published. `upgrade` (not `dist-upgrade`) keeps the
# package set identical — it only pulls patched versions of what's installed.
# Runs as root before we drop to `USER bun`.
RUN apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

# The `oven/bun` image ships with a non-root `bun` user (uid/gid 1000). Reuse it
# rather than minting a new one — avoids permission churn on bind mounts and
# matches the upstream image's own assumptions.
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json bunfig.toml ./
COPY --chown=bun:bun src ./src

# Pre-create the writable directories that the app/jobs use so the non-root user
# can write to them even when the volume hasn't been pre-populated by compose.
RUN mkdir -p /app/tts_data /app/exports && chown -R bun:bun /app/tts_data /app/exports

USER bun
EXPOSE 3000
ENV NODE_ENV=production \
    PORT=3000

CMD ["bun", "run", "src/index.ts"]
