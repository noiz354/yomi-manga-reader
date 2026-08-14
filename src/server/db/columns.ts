/**
 * server/db/columns — the column primitives shared by the DDL.
 *
 * Factories, not shared instances: a Drizzle column builder is bound to one table and
 * one column name, so every table needs its own instance. They keep the conventions
 * (uuid v7 PKs, timestamptz UTC, server-stamped `created_at`/`updated_at`, `citext`
 * email) stated once instead of copy-pasted.
 */
import { sql } from 'drizzle-orm';
import { customType, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * `citext` — case-insensitive text (`email citext NOT NULL`).
 *
 * Drizzle 0.45 has no first-class `citext` builder, so the type is declared as
 * a custom type whose DDL spelling is exactly `citext`. The extension itself is
 * created by the initial migration before any table that uses it.
 */
/** PGlite dev fallback cannot load the `citext` extension; map it to `text` there. */
function useCitext(): boolean {
  const url = process.env['DATABASE_URL'] ?? '';
  return !(
    url.startsWith('pglite://') ||
    url.startsWith('file:') ||
    url.startsWith('memory:') ||
    url === ':memory:' ||
    url.startsWith('/tmp/') ||
    url.startsWith('./') ||
    url.endsWith('.db')
  );
}
export const citextColumn = customType<{ data: string; driverData: string }>({
  dataType: () => (useCitext() ? 'citext' : 'text'),
});

/** The `uuidv7()` DEFAULT expression, shared by every uuid primary key. */
const UUID_V7_DEFAULT = sql`uuidv7()`;

/**
 * uuid v7 primary key — time-ordered ids. The only exception is
 * `audit_event.id` (bigserial).
 *
 * `.primaryKey()` is part of this factory, not of each call site: without it
 * the column is merely `NOT NULL`, PostgreSQL accepts a table with no primary
 * key, and every foreign key that references it fails at migration time with
 * "there is no unique constraint matching given keys".
 */
export function uuidV7PrimaryKey(name = 'id') {
  return uuid(name).notNull().default(UUID_V7_DEFAULT).primaryKey();
}

/** A nullable uuid FK column (used by the `SET NULL` auditability columns). */
export function uuidReference(name: string) {
  return uuid(name);
}

/** `timestamptz` in UTC — one timezone-free shape across the schema. */
export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' });
}

/** `created_at` — every table with a lifecycle has one. */
export function createdAt() {
  return timestamptz('created_at').notNull().defaultNow();
}

/**
 * `updated_at` — mutable rows add one.
 *
 * DEFAULT now() because there is no application-side stamping contract for it;
 * `reading_progress.updated_at` is the exception that matters and has an
 * explicit server-stamp rule (LWW).
 */
export function updatedAt() {
  return timestamptz('updated_at').notNull().defaultNow();
}

/** `deleted_at` — soft-delete marker for catalog content. */
export function deletedAt() {
  return timestamptz('deleted_at');
}

/**
 * Exact fixed-point number, e.g. `exactNumeric('number', 8, 2)` for
 * `numeric(8,2)` chapter numbers, so 10.5 is representable.
 *
 * Returns a string in TypeScript on purpose: `numeric` is arbitrary-precision
 * and converting it to a JS number at the driver boundary is exactly the drift
 * to avoid. Repositories narrow/convert deliberately.
 */
export function exactNumeric(name: string, precision: number, scale: number) {
  return numeric(name, { precision, scale });
}
