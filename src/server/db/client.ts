/**
 * server/db/client — the connection lifecycle, and the only place the PG driver
 * is constructed. `DATABASE_URL` is the only source of connection parameters and
 * is never rewritten from user input. The app role is DML-only, so DDL lives in
 * `migrations.ts` behind a separate DSN. Raw SQL is banned here and in every
 * repository: values interpolated into a tagged template become bind
 * parameters, so parameterization is a property of the API, not reviewer care.
 */

import postgres from 'postgres';
import { drizzle as drizzlePg, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import type { Notice, Sql } from 'postgres';
import type { Env } from '../../shared/validation';
import * as schema from './schema';
import { isPgliteDsn } from './dialect';

/** True when DATABASE_URL selects the embedded PGlite engine (dev fallback when no PG 18 is available). */

/**
 * Pool ceiling per process.
 *
 * The arithmetic is deliberate: 5 app replicas × 10 = 50, which exhausts the
 * server budget with NO headroom for the maintenance role that runs
 * migrations, the `pgbouncer` option, or operator sessions. Raise
 * `max_connections` in the compose file alongside this constant, or lower this
 * one — never both silently.
 */
export const DB_POOL_MAX = 10;

/** Fail fast on an unreachable/unresolvable database instead of hanging boot. */
export const DB_CONNECT_TIMEOUT_SECONDS = 10;

/** Release idle connections; a 10-connection pool is long-lived per replica. */
export const DB_IDLE_TIMEOUT_SECONDS = 30;

/** Options for {@link createPostgresClient}, all defaulted for the app pool. */
export interface PostgresClientOptions {
  /** Pool ceiling (defaults to {@link DB_POOL_MAX}). */
  readonly max?: number;
  /** TCP/TLS connect timeout in seconds. */
  readonly connectTimeoutSeconds?: number;
  /** Release idle connections after this many seconds. */
  readonly idleTimeoutSeconds?: number;
  /** Receives PostgreSQL NOTICE messages; the default drops them. */
  readonly onNotice?: (notice: Notice) => void;
}

/**
 * A boot/configuration failure that is NOT an API error.
 *
 * The API's error table has no `CONFIG_*`/`DB_*` code, so this module throws
 * its own error type rather than inventing a code; a database outage during
 * boot has no code in the table.
 */
export class DatabaseConfigurationError extends Error {
  /** The VARIABLE or setting name — never the DSN and never a value. */
  readonly subject: string;

  constructor(subject: string, problem: string, options?: ErrorOptions) {
    super(`${subject}: ${problem}`, options);
    this.name = 'DatabaseConfigurationError';
    this.subject = subject;
  }
}

/**
 * Builds the raw driver client. No connection is opened until the first query,
 * so importing this module (in a build, a CLI, a test) is free of side effects.
 *
 * @throws {DatabaseConfigurationError} when the DSN is missing or unparseable.
 */
export function createPostgresClient(
  databaseUrl: string,
  options: PostgresClientOptions = {},
): Sql {
  if (databaseUrl.trim() === '') {
    throw new DatabaseConfigurationError(
      'DATABASE_URL',
      'is required; the database DSN is env-injected only',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    // The value itself must never reach the message.
    throw new DatabaseConfigurationError('DATABASE_URL', 'is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new DatabaseConfigurationError(
      'DATABASE_URL',
      'must be a postgres:// or postgresql:// URL',
    );
  }
  return postgres(databaseUrl, {
    max: options.max ?? DB_POOL_MAX,
    connect_timeout: options.connectTimeoutSeconds ?? DB_CONNECT_TIMEOUT_SECONDS,
    idle_timeout: options.idleTimeoutSeconds ?? DB_IDLE_TIMEOUT_SECONDS,
    // NOTICE is server chatter (CREATE EXTENSION, etc.). Routing it to a
    // caller-supplied sink keeps it out of stdout; the default is silence so
    // the driver's own logging can never leak a DSN.
    onnotice: options.onNotice ?? (() => undefined),
  });
}

/**
 * The Drizzle handle repositories are written against.
 *
 * Typed as the postgres driver rather than as a union of the two supported drivers
 * (PGlite is the dev fallback). Both drivers build identical queries and differ only in
 * the branded query-result kind they carry, but a union instantiates the same query
 * builders with two different result kinds, so every chained method becomes ambiguous
 * and a call such as `.returning({ ... })` is rejected with "Expected 0 arguments, but
 * got 1" at twenty sites. The driver is still chosen at runtime in `createDbCore`; only
 * the static type is unified.
 */
export type Db = PostgresJsDatabase<typeof schema> & { close(): Promise<void> };

/** Internal: builds the driver client and its Drizzle wrapper together. */
function createDbCore(env: Env, options: PostgresClientOptions = {}) {
  // PGlite dev fallback: DATABASE_URL like `pglite://...`, `file:...`, `/tmp/...` or `./data.db`
  if (isPgliteDsn(env.databaseUrl)) {
    // Map `pglite://` + path or plain file path to PGlite dataDir
    let dataDir: string | undefined;
    const url = env.databaseUrl.trim();
    if (url.startsWith('pglite://')) {
      dataDir = url.slice('pglite://'.length) || undefined;
      if (dataDir === '' || dataDir === 'memory') dataDir = undefined; // in-memory
    } else if (url.startsWith('file:')) {
      dataDir = url.slice('file:'.length);
    } else if (url.startsWith('memory:') || url === ':memory:') {
      dataDir = undefined;
    } else {
      dataDir = url; // e.g. /tmp/yomi-pglite, ./data/pglite
    }
    const pglite = new PGlite(dataDir);
    // Typed, not `any`: annotating the instance as `any` here made the whole
    // `createDbCore` return type collapse to `any` (one union member being `any`
    // absorbs the other), which silently untyped every `db.query.*` callback in the
    // codebase — the callbacks stopped reporting a `db` type and every parameter
    // became an implicit `any` under `strict`.
    const database = drizzlePglite(pglite, { schema });
    const db = Object.assign(database, {
      close(): Promise<void> {
        return pglite.close();
      },
      // expose underlying for migrations
      __pglite: pglite,
    });
    return { db: db as unknown as Db, client: pglite as unknown as Sql };
  }
  const client = createPostgresClient(env.databaseUrl, options);
  const database = drizzlePg(client, { schema });
  const db = Object.assign(database, {
    /**
     * Drains the pool. Called on SIGTERM and at the end of a request-scoped job:
     * the image may be replaced at any moment, so in-flight work must not depend
     * on a connection that will never be returned.
     */
    close(): Promise<void> {
      return client.end({ timeout: DB_CONNECT_TIMEOUT_SECONDS });
    },
  });
  return { db, client };
}

/**
 * The application's database handle: connection, pool (max 10) and schema.
 *
 * Async because boot must FAIL FAST: the handle is only handed out after the
 * server has answered a trivial round-trip, so a wrong DSN, a stopped database
 * or a revoked role is a boot failure rather than the first reader's 500.
 * `/readyz` stays the liveness/readiness split.
 *
 * @throws {DatabaseConfigurationError} for a missing/invalid DSN or an
 *   unreachable server; the driver's own error stays reachable as `cause` for
 *   the logger and never reaches the message.
 */
export async function createDb(env: Env, options: PostgresClientOptions = {}): Promise<Db> {
  const { db, client } = createDbCore(env, options);
  const isPglite = isPgliteDsn(env.databaseUrl);
  try {
    if (isPglite) {
      // PGlite round-trip. `execute` is declared on the PGlite driver, not on the shared
      // `Db` type, so the handle is narrowed to the shape this call actually needs.
      await (db as unknown as { execute(query: string): Promise<unknown> }).execute('select 1');
    } else {
      await client`select 1`;
    }
  } catch (cause) {
    await db.close();
    throw new DatabaseConfigurationError(
      'DATABASE_URL',
      'could not reach the database (check the DSN, the server, and pg_hba)',
      { cause },
    );
  }
  return db;
}

/** Closes a handle produced by {@link createDb}; safe to call twice. */
export async function closeDb(db: Db): Promise<void> {
  await db.close();
}

/* process-wide handle */

/**
 * One pool per process, shared by every composition root, with a reference count.
 *
 * The problem it solves: a single members' request could hold three pools. Two
 * composition roots each called `createDb` independently, and
 * `server/auth/guard.ts` opened and closed a third per call. The app is
 * budgeted 10 connections, so three pools for one request is a third of the
 * budget spent before any work happens.
 *
 * Why the cache lives on `globalThis` and not in a module variable: Next's dev
 * server re-evaluates modules on hot reload, and a module-level cache is thrown
 * away with the old module — while the pool it held is not, because the driver
 * holds sockets. A dev-only pool leak is still a leak. `Symbol.for` rather than
 * `Symbol` so the key is registry-wide and cannot collide with another copy of
 * this module in the same realm.
 *
 * Why reference counting rather than a plain singleton: both composition roots
 * hold the same handle, and each exposes a `close`. If the first `close` drained
 * the pool, the second root would keep a handle to a dead pool — a use-after-free
 * that only appears under shutdown. The last release drains; earlier ones do
 * nothing.
 *
 * Why a rejected promise is not cached: `createDb` is fail-fast, and a
 * deployment with a briefly unreachable database should recover on the next
 * request rather than replaying the first failure forever. This mirrors the same
 * rule in `app/api/_deps.ts`.
 */
const DB_SINGLETON_KEY = Symbol.for('yomi.db.pool');

interface DbSingleton {
  /** The in-flight or settled handle; `null` when there is no live pool. */
  promise: Promise<Db> | null;
  /** The DSN the live pool was built from, so a changed env is caught. */
  dsn: string;
  /** How many holders still believe they own the handle. */
  refs: number;
}

type GlobalWithDb = typeof globalThis & { [DB_SINGLETON_KEY]?: DbSingleton };

function singleton(): DbSingleton {
  const g = globalThis as GlobalWithDb;
  g[DB_SINGLETON_KEY] ??= { promise: null, dsn: '', refs: 0 };
  return g[DB_SINGLETON_KEY];
}

/**
 * Acquire the process-wide handle, creating it on first use.
 *
 * Each call takes a reference; balance it with {@link releaseDb}. Callers that
 * want a handle they own outright — a per-request throwaway pool, or a test's
 * isolated database — should keep calling {@link createDb} and closing it with
 * {@link closeDb}. This is for the composition roots, whose lifetime is the
 * process.
 *
 * @param env the validated environment
 * @param options driver overrides, honoured only when the pool is first created
 * @returns the shared handle
 * @throws {DatabaseConfigurationError} when the DSN is unusable or unreachable,
 *   or when it differs from the DSN the live pool was built from
 */
export async function acquireDb(env: Env, options: PostgresClientOptions = {}): Promise<Db> {
  const slot = singleton();
  if (slot.promise !== null && slot.dsn !== env.databaseUrl) {
    throw new DatabaseConfigurationError(
      'DATABASE_URL',
      'the environment DSN changed while a shared pool was already open; the live pool ' +
        'was built from a different DSN and cannot be reused',
    );
  }
  slot.refs += 1;
  if (slot.promise === null) {
    slot.dsn = env.databaseUrl;
    slot.promise = createDb(env, options).catch((cause: unknown) => {
      // Do not memoise a failure: `createDb` is fail-fast, and the next request
      // should be free to try again.
      slot.promise = null;
      slot.refs -= 1;
      throw cause;
    });
  }
  return slot.promise;
}

/**
 * Release one reference taken by {@link acquireDb}; drains the pool when the last
 * holder lets go. Safe to call more times than acquired — it stops at zero.
 */
export async function releaseDb(db: Db): Promise<void> {
  const slot = singleton();
  if (slot.promise === null) return;
  slot.refs -= 1;
  if (slot.refs > 0) return;
  slot.promise = null;
  slot.dsn = '';
  await closeDb(db);
}
