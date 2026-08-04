# Yomi — Self-Hosted Manga & Comic Reader

A web app for reading legally owned, licensed, or authorized manga and comics:
a browsable catalog, a fast multi-mode reader, per-user libraries, and an
admin panel with a secure upload pipeline.

Readers browse the catalog, read chapters in vertical / single-page /
double-page modes with RTL or LTR direction, and — when signed in — track
progress, history, library entries, and bookmarks. The reader is built for
500-page chapters, slow connections, and memory-constrained devices.

## Stack

Node 24 · TypeScript (strict) · Next.js 16 (App Router) · React 19 ·
PostgreSQL 18 (Drizzle ORM) · S3-compatible object storage · sharp ·
Zod · argon2 · OpenTelemetry + pino · Vitest + Playwright · Docker

## Layout

```
src/
├── app/            # Routes: pages, API handlers, media delivery
├── features/       # Domain logic: auth, catalog, reader, library, search, admin, uploads
├── server/         # Infrastructure: db, auth, storage, media, telemetry
└── shared/         # contracts, types, validation, UI primitives
tests/              # unit/ (vitest) · integration/ (real PostgreSQL) · e2e/ (Playwright)
scripts/            # seed harness, CI gate scripts
drizzle/            # migrations
docker/             # compose files for dev
docs/journeys/      # user journey screenshots
```

`features/*` never imports `server/*`; only `server/db` touches the database
driver; only `server/storage` touches the S3 SDK. ESLint enforces this and
`npm run lint:boundaries` proves each rule catches violations.

## Run it

```bash
npm ci
docker compose -f docker/docker-compose.dev.yml up -d  # postgres + storage
npm run db:migrate
npm run seed -- --env dev        # SEED_ADMIN_PASSWORD / SEED_READER_PASSWORD from env
npm run dev                      # http://localhost:3000
```

## Verify it

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration   # needs the compose services up
npm run test:e2e           # needs the app + a seeded database
npm run build
```
