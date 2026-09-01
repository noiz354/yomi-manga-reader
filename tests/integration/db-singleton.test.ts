/**
 * One pool per process. A members' request could hold THREE pools: two
 * composition roots each called `createDb` independently, and the session guard
 * opened and closed a third per call — against a 10-connection budget. Object
 * identity IS the count: two acquisitions returning the same handle means one
 * pool was opened. Identity alone is not enough, so the acceptance test counts
 * real PostgreSQL backends. Needs DATABASE_URL; skips without it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { acquireDb, closeDb, createDb, releaseDb, type Db } from '../../src/server/db/client';
import { getSessionUser } from '../../src/server/auth/guard';
import { createCatalogComposition, createLibraryComposition } from '../../src/server/composition';
import { envSource } from './catalog.db-harness';
import type { Env, EnvSource } from '../../src/shared/validation';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const env = (databaseUrl: string): Env => ({ databaseUrl }) as Env;

/**
 * The composition roots take an `EnvSource` (a raw record) rather than an `Env`,
 * because they run `loadEnv` themselves — that is the point of a composition
 * root. The full record comes from the shared harness beside `testEnv`; a partial
 * one is refused by `loadEnv`, correctly.
 */
const rawEnv = (databaseUrl: string): EnvSource => envSource(databaseUrl);

/**
 * Drains the shared pool without knowing its refcount, so one test cannot leave
 * a live pool for the next. Deliberately reaches the slot the same way the
 * production code does rather than importing a test-only reset: a reset helper
 * is a second implementation of the lifecycle, and it is the one that rots.
 */
async function drainSharedPool(): Promise<void> {
  const key = Symbol.for('yomi.db.pool');
  const g = globalThis as typeof globalThis & {
    [key]?: { promise: Promise<unknown> | null; refs: number };
  };
  const slot = g[key];
  if (slot?.promise) {
    const handle = (await slot.promise) as { close(): Promise<void> };
    slot.promise = null;
    slot.refs = 0;
    await handle.close();
  }
}

afterEach(async () => {
  await drainSharedPool();
});

/**
 * Counts real client backends on this database.
 *
 * `pg_stat_activity` is readable by any role for row COUNT purposes even when the
 * individual rows are redacted, so this needs no elevated privilege. Each pool
 * `createDb` builds costs exactly one backend, because `createDb` round-trips
 * `select 1` to prove the DSN works before returning.
 */
async function countBackends(): Promise<number> {
  const probe = await createDb(env(DATABASE_URL as string));
  try {
    const rows = await probe.execute(
      'select count(*)::int as n from pg_stat_activity ' +
        "where datname = current_database() and backend_type = 'client backend'",
    );
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? -1);
  } finally {
    await closeDb(probe);
  }
}

/**
 * Cumulative connections to this database, from `pg_stat_database.sessions`.
 *
 * Why a cumulative counter and not a backend count: a per-call pool opens AND
 * closes before the test can look, so sampling `pg_stat_activity` after the call
 * sees nothing. Reverting the guard to `createDb`/`closeDb` therefore PASSED the
 * first version of this test — the regression was real and the measurement missed
 * it. A monotonic counter does not care when you look.
 *
 * `pg_stat_database` is refreshed by the stats collector (~500ms), so
 * `settledSessions` polls past the lag instead of sleeping a guessed interval.
 */
async function readSessions(probe: Db): Promise<number> {
  // The probe MUST be a handle that already exists. Reading the counter through a
  // freshly opened connection increments the very number being read, so the
  // measurement reports its own probe — which is what the first version did, and
  // why its baseline failed even against the correct implementation.
  const rows = await probe.execute(
    'select sessions::int as n from pg_stat_database where datname = current_database()',
  );
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? -1);
}

/** Waits up to `ms` for the collector to publish a value above `floor`. */
async function sessionsExceed(floor: number, probe: Db, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if ((await readSessions(probe)) > floor) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

describeDb('the process-wide database handle', () => {
  it('gives two acquisitions the same handle — one pool, not two', async () => {
    const first = await acquireDb(env(DATABASE_URL as string));
    const second = await acquireDb(env(DATABASE_URL as string));

    // Identity, not a call count. A pool IS this object.
    expect(second).toBe(first);
  });

  it('survives many acquisitions without opening another pool', async () => {
    const handles = await Promise.all(
      Array.from({ length: 8 }, () => acquireDb(env(DATABASE_URL as string))),
    );
    for (const handle of handles) expect(handle).toBe(handles[0]);
  });

  it('refuses to hand a live pool to a different DSN', async () => {
    await acquireDb(env(DATABASE_URL as string));
    // Silently reusing a pool built from another DSN would read from the wrong
    // database — a failure that produces plausible data, which is worse than a
    // crash.
    await expect(acquireDb(env('postgres://nobody@127.0.0.1:1/other'))).rejects.toThrow(
      /the environment DSN changed/i,
    );
  });

  it('drains only on the last release, so an early close cannot kill a live pool', async () => {
    // Two composition roots hold the same handle and each exposes a `close`. If
    // the first close drained the pool, the second root would keep a handle to a
    // dead pool — a use-after-free that only appears at shutdown.
    const a = await acquireDb(env(DATABASE_URL as string));
    const b = await acquireDb(env(DATABASE_URL as string));
    expect(b).toBe(a);

    await releaseDb(a);
    // Still usable: one holder remains.
    const stillAlive = await acquireDb(env(DATABASE_URL as string));
    expect(stillAlive).toBe(a);

    await releaseDb(stillAlive);
    await releaseDb(b);
    // Now the slot is empty, so the next acquire builds a new pool.
    const fresh = await acquireDb(env(DATABASE_URL as string));
    expect(fresh).not.toBe(a);
  });

  it('ignores a release beyond the count it took', async () => {
    const handle = await acquireDb(env(DATABASE_URL as string));
    await acquireDb(env(DATABASE_URL as string));
    await releaseDb(handle);
    await releaseDb(handle);
    await releaseDb(handle);
    // The count stopped at zero instead of going negative, so this is a fresh pool
    // rather than a resurrection of a closed one.
    const fresh = await acquireDb(env(DATABASE_URL as string));
    expect(fresh).not.toBe(handle);
  });

  it('does not memoise a failure, so a recovered database is reachable', async () => {
    // `createDb` is fail-fast. If the rejected promise were cached, a deployment
    // with a briefly unreachable database would replay the first failure forever.
    await expect(acquireDb(env('postgres://nobody@127.0.0.1:1/nope'))).rejects.toThrow();
    // No DSN was recorded for the failed attempt, so a good DSN is accepted
    // immediately rather than being rejected as "changed".
    const handle = await acquireDb(env(DATABASE_URL as string));
    expect(handle).toBeDefined();
  });

  it('leaves createDb alone: a test-owned handle is still its own pool', async () => {
    // The shared handle is for the composition roots, whose lifetime is the
    // process. `createDb` stays uncached so a suite can own and close its own.
    const owned = await createDb(env(DATABASE_URL as string));
    const shared = await acquireDb(env(DATABASE_URL as string));
    expect(owned).not.toBe(shared);
    await closeDb(owned);
  });

  it('opens ONE connection for both composition roots, not two', async () => {
    // The acceptance the whole slice exists for, measured the only way that can
    // actually fail: by counting real PostgreSQL backends.
    //
    // Comparing `acquireDb` with itself would pass even if both composition
    // roots had been reverted to `createDb` — a green test that proved nothing,
    // because the compositions never exposed their pool. Asserting object
    // identity between handles is not enough either, since identity is a claim
    // about this module's own bookkeeping. Counting backends is a claim about
    // the database.
    const before = await countBackends();

    const library = await createLibraryComposition(rawEnv(DATABASE_URL as string));
    const catalog = await createCatalogComposition(rawEnv(DATABASE_URL as string));

    const after = await countBackends();
    // `createDb` round-trips `select 1`, so each pool that is created costs one
    // backend. Two roots sharing one pool cost one; two roots not sharing cost two.
    expect(after - before).toBe(1);

    // Both compositions are live, so the single pool is genuinely shared rather
    // than one root having released it.
    expect(library.library).toBeDefined();
    expect(catalog.catalog).toBeDefined();
  });
});

describeDb('the session guard shares the pool', () => {
  // The no-handle leg calls `loadEnv()` on the real process environment (that
  // IS the behaviour under test — a guard that needs smuggled config is a
  // guard that cannot run). Same convention as the media suites: set the
  // app-level literals only when the runner did not provide them, restore in
  // `afterAll`.
  const APP_ENV_DEFAULTS: Record<string, string> = {
    APP_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: '0'.repeat(64),
    NEXT_TELEMETRY_DISABLED: '1',
  };
  const savedEnv: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [name, value] of Object.entries(APP_ENV_DEFAULTS)) {
      if (process.env[name] === undefined) {
        savedEnv[name] = undefined;
        process.env[name] = value;
      }
    }
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('opens no connection of its own, and takes an injected handle when given one', async () => {
    // The guard opens no connection of its own: a members' request with a
    // session uses the shared pool, and the injected-handle path is the seam a
    // future SessionRepository will use.
    const request = new Request('http://localhost:3000/api/library', {
      headers: { cookie: 'session_token=definitely-not-a-real-token' },
    });

    // A shared pool is already warm, as it would be in a live process, so any
    // connection the guard opens is a connection it should not have opened.
    const warm = await acquireDb(env(DATABASE_URL as string));
    const floor = await readSessions(warm);

    expect(await getSessionUser(request, warm)).toBeNull();
    expect(await getSessionUser(request)).toBeNull();
    for (let i = 0; i < 4; i += 1) await getSessionUser(request);

    // Five guard calls, zero new connections.
    expect(await sessionsExceed(floor, warm)).toBe(false);
  });

  it('never touches the pool for a request with no token at all', async () => {
    // The common case: an anonymous visit to /discover, /search or the reader. If
    // the guard acquires before checking for a cookie, every anonymous request
    // pays for a pool it never uses.
    const probe = await acquireDb(env(DATABASE_URL as string));
    const floor = await readSessions(probe);
    for (let i = 0; i < 4; i += 1) {
      expect(await getSessionUser(new Request('http://localhost:3000/discover'))).toBeNull();
    }
    expect(await sessionsExceed(floor, probe)).toBe(false);
  });
});
