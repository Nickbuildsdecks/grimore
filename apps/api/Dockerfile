# Production image for `apps/api`.
#
# Build context is the repository ROOT, not this directory, because the app is a pnpm workspace
# member and needs the lockfile plus every `packages/*` it depends on:
#
#   docker build -f apps/api/Dockerfile -t grimore-api .
#
# The legacy `Dockerfile` at the root is a different image entirely (it runs `server.js`); the two
# are independent and can run side by side, which is the point of the strangler migration.
#
# NOTE: starting this container runs `runMigrations` against whatever DATABASE_URL it is given.
# Against production that is a one-way door on real data, so the compose service is behind a
# profile and does not start with a plain `docker compose up -d`. See claude/v2-deploy-notes.md.

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
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/realtime/package.json ./apps/realtime/
RUN pnpm install --frozen-lockfile --filter @grimore/api...

COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter "./packages/*" run build \
 && pnpm --filter @grimore/api run build

# Drop devDependencies from the tree that will be copied into the runtime image.
RUN pnpm prune --prod

FROM base AS runner
ENV NODE_ENV=production
# Copying the resolved tree rather than re-installing: pnpm's node_modules are symlink farms into
# a content-addressed store, and a fresh install in this stage would have to re-resolve everything.
COPY --from=builder /app /app

# `packages/db` resolves its migrations relative to its own dist directory, so the .sql files have
# to be present at runtime and not only at build time. Fail the build loudly if they are missing
# rather than at 3am on the first container start.
RUN test -f packages/db/migrations/0001_baseline.sql \
 && test -f apps/api/dist/server.js

# Runs as an unprivileged user; the base image ships `node` (uid 1000) for exactly this.
USER node

EXPOSE 3000
# The healthcheck mirrors the legacy service's: cheap, no database access, always JSON.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "--enable-source-maps", "apps/api/dist/server.js"]
