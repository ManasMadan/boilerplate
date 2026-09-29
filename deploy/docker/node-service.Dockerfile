# syntax=docker/dockerfile:1
#
# One image per Node service: api, worker, notifications, webhooks.
#
#   docker buildx bake api            (docker-bake.hcl at the repo root)
#
# The build prunes the monorepo to the service and its workspace packages, installs
# and bundles them, then ships only the bundle (dist/main.mjs, with our @repo/* code
# inlined) and the service's production npm dependencies on a distroless Node base: no
# shell, no package manager, running as an unprivileged user.

ARG BUN_VERSION=1.3.6
ARG TURBO_VERSION=2.11.5

FROM oven/bun:${BUN_VERSION}-slim AS prune
ARG TURBO_VERSION
ARG SERVICE
WORKDIR /repo
COPY . .
RUN bunx turbo@${TURBO_VERSION} prune @repo/${SERVICE} --docker --out-dir /pruned

FROM oven/bun:${BUN_VERSION}-slim AS build
ARG TURBO_VERSION
ARG SERVICE
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo
# Dependencies first (package manifests and the lockfile only), so code changes reuse
# the install layer.
COPY --from=prune /pruned/json/ .
RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY --from=prune /pruned/full/ .
COPY deploy/docker/check-peers.mjs /usr/local/lib/check-peers.mjs
# The Prisma client is the one generated file not committed (see docs/codegen.md);
# everything else the build needs is already in the tree, so only this service builds.
RUN bun run --cwd packages/db gen \
 && bunx turbo@${TURBO_VERSION} run build --filter=@repo/${SERVICE} --only
# The runtime gets production dependencies only. Workspace links are dropped: our own
# packages are compiled into the bundle. No lifecycle scripts: the only one is the
# repo's own git-hook setup, and native modules ship prebuilt per platform.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && bun install --frozen-lockfile --production --ignore-scripts --filter @repo/${SERVICE} \
 && rm -rf node_modules/@repo \
 && bun /usr/local/lib/check-peers.mjs . \
 && mkdir -p /out/apps/${SERVICE} \
 && cp -r node_modules /out/node_modules \
 && cp -r apps/${SERVICE}/dist /out/apps/${SERVICE}/dist \
 && if [ -d apps/${SERVICE}/node_modules ]; then cp -r apps/${SERVICE}/node_modules /out/apps/${SERVICE}/; fi

FROM gcr.io/distroless/nodejs24-debian13:nonroot
ARG SERVICE
ARG RELEASE=dev
ENV NODE_ENV=production \
    RELEASE=${RELEASE}
# Files stay owned by root and read-only to the process; it writes nowhere but /tmp.
COPY --from=build /out /app
WORKDIR /app/apps/${SERVICE}
USER 10001:10001
CMD ["--enable-source-maps", "dist/main.mjs"]
