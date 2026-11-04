# Production image for `apps/realtime` — the Play Realm table server.
#
# Build context is the repository ROOT, not this directory, because the app is a pnpm workspace
# member and needs the lockfile plus every `packages/*` it depends on:
#
#   docker build -f apps/realtime/Dockerfile -t grimore-realtime .
#
# Unlike `apps/api`, this service touches **no database**. It needs Redis and nothing else: pods,
# seats and game state live in Redis, and a table identifies players by the seat token it issues
# rather than by a Grimore account. So there is no migration to run on start and no DATABASE_URL to
# give it — see `realtimeEnvSchema` in packages/shared, which is the narrow set of variables it
# actually reads.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# The pnpm version is pinned by `packageManager` in the root package.json; corepack honours it.
RUN corepack enable
WORKDIR /app

FROM base AS builder
# Only the workspace metadata first, so a source-only change does not invalidate the install layer.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
# Every workspace member's manifest must exist for the lockfile to be considered in sync, even for
# the ones this image never builds.
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/rules-engine/package.json ./packages/rules-engine/
COPY packages/theme/package.json ./packages/theme/
COPY packages/auto-tagger/package.json ./packages/auto-tagger/
COPY packages/mailer/package.json ./packages/mailer/
COPY packages/recommender/package.json ./packages/recommender/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/realtime/package.json ./apps/realtime/
RUN pnpm install --frozen-lockfile --filter @grimore/realtime...

COPY packages ./packages
COPY apps/realtime ./apps/realtime
RUN pnpm --filter "./packages/*" run build \
 && pnpm --filter @grimore/realtime run build

# Drop devDependencies from the tree that will be copied into the runtime image.
RUN pnpm prune --prod

FROM base AS runner
ENV NODE_ENV=production
# Copying the resolved tree rather than re-installing: pnpm's node_modules are symlink farms into
# a content-addressed store, and a fresh install in this stage would have to re-resolve everything.
COPY --from=builder /app /app

# Fail the build loudly if the entrypoint did not get emitted, rather than at the first start.
RUN test -f apps/realtime/dist/server.js

# Runs as an unprivileged user; the base image ships `node` (uid 1000) for exactly this.
USER node

EXPOSE 3000
# /healthz pings Redis, so an unhealthy container means the table really cannot hold a game.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "--enable-source-maps", "apps/realtime/dist/server.js"]
