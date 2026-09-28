# syntax=docker/dockerfile:1.7
# Yomi — application image.
#
# Single multi-stage Dockerfile (dev == prod topology); base pinned to
# node:24.21.0-alpine (matching .nvmrc), for which the lockfile carries musl
# prebuilds for sharp, argon2 and @next/swc. NODE_IMAGE overrides the base; no
# credentials or NODE_ENV are baked in. Native modules rely on prebuilds
# (npm >= 11.19 `npm ci` skips install scripts unless `.npmrc` allowScripts
# lists them), and with no root `.dockerignore`, every source path is copied
# explicitly so the host's node_modules never leaks in and breaks them.

# Global ARG so the base image is a one-flag experiment (see the header).
ARG NODE_IMAGE=node:24.21.0-alpine

# stage 1/3: base
# Structural defaults only. NO credentials and NO NODE_ENV are baked in:
# configuration is env-injected at runtime, and a baked NODE_ENV would silently
# skip devDependencies during `npm ci` in a later production stage.
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    MIGRATIONS_DIR=/app/drizzle
WORKDIR /app

# stage 2/3: deps
# The lockfile build. `npm ci` is the only install that honours
# package-lock.json, and `--ignore-scripts` is deliberately NOT passed: npm
# skips install scripts by its own allow-list policy (the repo has no `.npmrc`
# allowScripts entry), and forcing them on is out of scope for this file.
FROM base AS deps
# `/app` is created by WORKDIR as root; `npm ci` runs unprivileged, so hand the
# working directory over first. Doing it here (as root, one line) rather than
# chowning node_modules afterwards keeps the ownership correct without a
# recursive chown over ~700 packages in a later layer.
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
# Cache mount: keeps the ~700-package download out of every rebuild. The cache is
# keyed per registry, not per lockfile, which is safe because `npm ci` verifies
# integrity from the lockfile on every run. `uid`/`gid` are required: a cache
# mount is created root-owned, and without them the unprivileged `node` user
# cannot write its own npm cache and `npm ci` fails with EACCES.
RUN --mount=type=cache,id=yomi-npm,target=/home/node/.npm,uid=1000,gid=1000,sharing=locked \
    npm ci

# stage 3/3: dev
# The dev image: deps + the source the dev server compiles, running as the
# unprivileged `node` user (uid/gid 1000). Non-root here is not decoration —
# uid 1000 is also the default Linux workstation uid, so the bind mount in
# docker-compose.dev.yml does not produce root-owned `.next/` on the host. A
# host with a different uid overrides it with compose's `user:` key.
FROM deps AS dev

# The dev server's own inputs. `drizzle/` and `drizzle.config.ts` are shipped
# because the `migrate` service runs `drizzle-kit migrate` from this image and
# because src/server/db/migrations.ts resolves its journal from
# MIGRATIONS_DIR (set in `base`), independent of where the module sits.
COPY --chown=node:node package.json package-lock.json tsconfig.json next-env.d.ts ./
COPY --chown=node:node drizzle.config.ts ./
COPY --chown=node:node src ./src
COPY --chown=node:node drizzle ./drizzle
# docker/ ships so the image is self-sufficient: the smoke test is installed into
# PATH below, and the bucket-init script is what the `minio-init` service runs.
COPY --chown=node:node docker ./docker

# The anonymous volumes the compose file mounts over /app/node_modules and
# /app/.next are created by the daemon, and a fresh volume INHERITS the
# ownership of the image's directory at that path. Docker creates a missing
# mountpoint as root, which would leave the unprivileged `node` user unable to
# write (measured: `EACCES: permission denied, mkdir '/app/.next/dev'`, and the
# container restart-looped). Declaring both directories here, owned by node,
# makes the volumes come up writable. `.next` is created empty on purpose: an
# image must not ship build output, only the directory that owns it.
RUN mkdir -p /app/.next && chown -R node:node /app /app/.next

# The native-module smoke (verify sharp + argon2 native builds on the exact
# base image). Installed as a real file in /usr/local/bin, NOT as a symlink into
# /app, so `docker run --entrypoint yomi-native-smoke` still works when /app is
# replaced by a bind mount. Temporarily root: /usr/local/bin is root-owned, and
# the stage is otherwise unprivileged.
USER root
RUN cp /app/docker/smoke-native-modules.sh /usr/local/bin/yomi-native-smoke \
    && chmod 0755 /usr/local/bin/yomi-native-smoke \
    && chown node:node /usr/local/bin/yomi-native-smoke

EXPOSE 3000

# `/healthz` is the liveness contract: it must answer 200 while the database is
# down, so the probe deliberately probes the PROCESS, not a dependency.
# `start-period` is generous because the first `next dev` compile is not
# instant. The probe uses Node's own `fetch` rather than busybox `wget`: it
# needs no extra package, and it cannot break if a base image swap drops a
# busybox applet.
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=12 \
    CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

# `exec` so SIGTERM from `docker stop` reaches Next directly instead of a shell
# wrapper; `--hostname 0.0.0.0` is explicit because the dev server's default bind
# address differs between Next versions and a container needs all interfaces;
# ${PORT:-3000} keeps the port overridable from compose.
CMD ["sh", "-c", "exec node_modules/.bin/next dev --hostname 0.0.0.0 --port ${PORT:-3000}"]
