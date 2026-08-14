// @ts-check
/**
 * drizzle-kit configuration — the migration generator.
 *
 * Commands (package.json `db:*` scripts):
 *   npx drizzle-kit generate   — diff schema.ts against drizzle/meta and write
 *                                a new `drizzle/NNNN_*.sql` revision. NEVER
 *                                run against production: it only writes files.
 *   npx drizzle-kit migrate    — apply pending revisions. In the app this is
 *                                NOT the path: boot calls `migrateOnBoot()` in
 *                                src/server/db/migrations.ts, which takes the
 *                                advisory lock and a DDL-capable DSN. This
 *                                command is for local/dev/CI stepping.
 *   npx drizzle-kit studio     — manual QA.
 *
 * - `dbCredentials.url` is read from the environment and never defaulted to a
 *   committed value: secrets are env-injected. `generate` does not need a live
 *   server, so a placeholder keeps the command usable offline; `migrate`/`push`
 *   will simply fail to connect.
 * - The journal lives in `public` (not drizzle's default `drizzle` schema) so
 *   the application schema stays exactly the intended tables.
 * - `casing` is deliberately unset: every column name is written explicitly in
 *   schema.ts so the generated SQL is readable line-by-line in review, with no
 *   hidden name transformation between the model and the migration.
 */
import { defineConfig } from 'drizzle-kit';

/** Operator-provided DSN. Never hardcoded, never logged. */
const url = process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'public',
  },
  dbCredentials: { url },
  // Print every statement so the generated revision can be reviewed before it
  // is committed.
  verbose: true,
  // `push` would mutate a database without a migration file; the model is
  // migrated only through reviewed files ("no runtime schema push").
  strict: true,
});
