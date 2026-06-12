# editorzero production image (ADR 0012 server artifact / ADR 0027 topology).
#
# One container = the whole single-box product: the Hono trunk serving the
# JSON API + the built SPA bundle (EDITORZERO_SPA_DIST) over SQLite on a
# volume. `getApiApp` self-migrates at boot; `/infra/health` is the probe;
# SIGTERM drains gracefully (apps/server/src/index.ts).
#
# Build shape: the runnable artifact is the esbuild server bundle
# (apps/server/scripts/bundle.mjs — `module: Preserve` dists are
# extensionless and unrunnable under plain node, so the bundle IS the
# production entrypoint, same artifact the e2e lane boots). The bundle
# externalizes only `better-sqlite3` (native); its lockfile-faithful
# closure comes from `pnpm deploy --prod --legacy`, not a loose install.

FROM node:22-bookworm-slim AS build
# Toolchain for better-sqlite3's native build when no prebuilt binary
# matches the platform; build stage only — the runtime stage stays slim.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
# Pin pnpm to the workspace's packageManager version (package.json).
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate
WORKDIR /repo
COPY . .
# The root `prepare` script installs git hooks — meaningless (and failing:
# no git, no repo) inside the image; strip it from the image's copy so
# `pnpm install` and `pnpm deploy` run their normal lifecycles, including
# the allowlisted native builds (better-sqlite3). Scripts are not part of
# the frozen-lockfile check.
RUN npm pkg delete scripts.prepare \
  && pnpm install --frozen-lockfile
# tsc -b dists (the bundle resolves @editorzero/* through them), the SPA
# bundle, the server bundle, then the pruned prod closure for the native
# external.
RUN pnpm build \
  && pnpm -C apps/app build \
  && pnpm -C apps/server bundle \
  && pnpm --filter @editorzero/server deploy --prod --legacy /prod/server

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    EDITORZERO_SPA_DIST=/app/web
WORKDIR /app
COPY --from=build /prod/server/node_modules ./node_modules
COPY --from=build /repo/apps/server/bundle/server.mjs ./server.mjs
COPY --from=build /repo/apps/app/dist ./web
USER node
EXPOSE 3000
# Liveness via the trunk's own probe; node ships no curl/wget on slim.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/infra/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.mjs"]
