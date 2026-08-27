/**
 * Shared harness for the catalog integration suites. Every assertion must run
 * against a REAL, MIGRATED PostgreSQL 18; asserting against Drizzle types
 * proves nothing. One throwaway database per suite: integration FILES run in
 * parallel, so two suites that both TRUNCATE would delete each other's
 * fixtures. A database (not a schema) is used because the migration journal is
 * pinned to `public`. DSN: DATABASE_URL; suites SKIP without it, and it must
 * point at a THROWAWAY server, never a database anyone keeps data in. */

import postgres from 'postgres';
import { describe } from 'vitest';
import { runMigrations } from '../../src/server/db/migrations';
import { createDb, type Db } from '../../src/server/db/client';
import { SCHEMA_TABLES } from '../../src/server/db/schema';
import type { Env, EnvSource } from '../../src/shared/validation';

/** The DSN for the run, or `undefined` when there is no database. */
export const DATABASE_URL = process.env['DATABASE_URL'];

/** `describe` when a DSN is present, `describe.skip` when it is not. */
export const describeDb = DATABASE_URL ? describe : describe.skip;

type RawSql = ReturnType<typeof postgres>;

/** A raw driver handle for catalog assertions the Drizzle builder cannot express. */
export interface Harness {
  /** The application's Drizzle handle (the only handle repositories receive). */
  readonly db: Db;
  /** A raw `postgres` handle, for EXPLAIN and catalog introspection. */
  readonly sql: RawSql;
  /** Empties every table so one test's rows cannot reach the next test. */
  reset(): Promise<void>;
  /** Releases both handles and drops the throwaway database. */
  close(): Promise<void>;
}

/**
 * The only Env field `createDb` reads is `databaseUrl`, so a test that owns a
 * real DSN needs no other variable invented.
 */
export function testEnv(databaseUrl: string): Env {
  return { databaseUrl } as Env;
}

/**
 * A COMPLETE `EnvSource` for `createCatalogComposition` / `createLibraryComposition`.
 *
 * `testEnv` above is enough for `createDb`, which reads one field. A composition
 * root is different: it calls `loadEnv` itself, and `loadEnv` refuses to start
 * unless all nine variables are present. That refusal is correct and worth
 * keeping — it is why a misconfigured deployment fails at boot rather than at
 * the first query — but a test that wants a composition root must satisfy it.
 *
 * It lives here, beside `testEnv`, because the alternative is a third copy of this
 * literal (media-delivery and seed.harness each have one already) and they drift.
 * The values are throwaway and never leave the test process.
 */
export function envSource(databaseUrl: string): EnvSource {
  return {
    NODE_ENV: 'test',
    APP_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: '0'.repeat(64),
    DATABASE_URL: databaseUrl,
    NEXT_TELEMETRY_DISABLED: '1',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_REGION: 'auto',
    S3_BUCKET: 'yomi-media-test',
    S3_ACCESS_KEY_ID: 'test-access-key',
    S3_SECRET_ACCESS_KEY: 'test-secret-key-000000000000',
  };
}

function dsnFor(databaseName: string): string {
  const url = new URL(DATABASE_URL as string);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * Creates a throwaway database, migrates it through the SHIPPED runner, and
 * returns both handles.
 *
 * The migration is applied by `runMigrations`, never by a
 * hand-written DDL copy, so a suite can never pass against a schema the app
 * would not boot on.
 *
 * @param namespace a short, unique suite name (letters, digits, underscores)
 */
export async function openHarness(namespace: string): Promise<Harness> {
  const base = DATABASE_URL;
  if (base === undefined) throw new Error('DATABASE_URL is unset; the suite must not run.');
  const name = `t_catalog_${namespace.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  const admin = postgres(base, { max: 1, onnotice: () => undefined });
  // `with (force)` closes any leftover connection from a crashed previous run.
  await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.unsafe(`create database ${name}`);
  const url = dsnFor(name);
  await runMigrations({ url });

  const sql = postgres(url, { max: 4, onnotice: () => undefined });
  const db = await createDb(testEnv(url));
  return {
    db,
    sql,
    reset: async () => {
      // One fixed statement; the table list comes from the schema inventory, so
      // no test value ever reaches the SQL text.
      const tables = SCHEMA_TABLES.map((table) => `"${table}"`).join(', ');
      await sql.unsafe(`truncate table ${tables} restart identity cascade`);
    },
    close: async () => {
      await db.close();
      await sql.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}

/** Anything that can hand over a Drizzle `{ sql, params }` pair. */
interface Sqlable {
  toSQL(): { sql: string; params: unknown[] };
}

function hasToSQL(value: unknown): value is Sqlable {
  return typeof (value as { toSQL?: unknown } | null)?.toSQL === 'function';
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/**
 * Runs an `EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` against a query the repository
 * itself produced, so the plan that is asserted is the plan that ships.
 *
 * Accepts the Drizzle statement builder, a `{ toSQL() }` wrapper, or a promise
 * of either (the catalog query builder is `async`, because resolving genre names
 * to ids is a round trip). It REFUSES a resolved row array, because EXPLAIN-ing
 * rows rather than a statement is exactly the mistake that would make this gate
 * assert nothing.
 *
 * `toSQL()` is the Drizzle-emitted `{ sql, params }` pair; every value in
 * `params` stays a bind parameter, so this helper binds them the same way the
 * repository does. The only string added here is the fixed
 * `explain (...)` prefix.
 */
export async function explain(sql: RawSql, query: unknown): Promise<string> {
  let statement: unknown = query;
  if (!hasToSQL(statement) && isThenable(statement)) statement = await statement;
  if (!hasToSQL(statement)) {
    throw new Error('explain() needs the Drizzle statement builder, not resolved rows');
  }
  const { sql: text, params } = statement.toSQL();
  const rows = await sql.unsafe(`explain (analyze, buffers, verbose) ${text}`, params as never[]);
  return rows.map((row) => Object.values(row).join(' ')).join('\n');
}
