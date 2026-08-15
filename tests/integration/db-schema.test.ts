/**
 * Integration tests — database foundation: schema reality + migration lifecycle
 * against a REAL PostgreSQL 18. Assertions read the catalog (not the TypeScript
 * types alone) of a database dropped and re-migrated in `beforeAll`.
 * Skips without `DATABASE_URL`; `beforeAll` drops `public`, so use a THROWAWAY
 * DSN, and it must not share a database with a suite that seeds before it runs.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import * as schema from '../../src/server/db/schema';
import { MIGRATION_LOCK_ID, runMigrations } from '../../src/server/db/migrations';
import {
  DB_CONNECT_TIMEOUT_SECONDS,
  DB_IDLE_TIMEOUT_SECONDS,
  DB_POOL_MAX,
  DatabaseConfigurationError,
  closeDb,
  createDb,
  createPostgresClient,
} from '../../src/server/db/client';
import type { Env } from '../../src/shared/validation';

/** The 20 tables of the schema (schema.ts table inventory). */
const EXPECTED_TABLES = [
  'audit_event',
  'bookmark',
  'chapter',
  'chapter_page',
  'creator',
  'genre',
  'library_entry',
  'manga',
  'manga_alias',
  'manga_creator',
  'manga_genre',
  'manga_tag',
  'reader_preference',
  'reading_history',
  'reading_progress',
  'reset_token',
  'sessions',
  'tag',
  'upload_job',
  'users',
] as const;

/**
 * Every named index expected, by the naming convention `ix_{table}_{columns}`.
 * Two-way equality: an extra index fails here, and so does an expected index the
 * migration did not create.
 */
const EXPECTED_INDEXES = [
  'ix_users_email',
  'ix_users_role',
  'ix_users_status',
  'ix_sessions_token',
  'ix_sessions_user_id',
  'ix_sessions_expires_at',
  'ix_manga_slug',
  'ix_manga_title',
  'ix_manga_title_trgm',
  'ix_manga_updated_at',
  'ix_manga_created_at',
  'ix_manga_visible',
  'ix_manga_alias_manga_id_alias',
  'ix_manga_alias_alias',
  'ix_creators_name',
  'ix_genres_name',
  'ix_tags_name',
  'ix_manga_creator_creator_id',
  'ix_manga_genre_genre_id',
  'ix_manga_tag_tag_id',
  'ix_chapters_manga_order',
  'ix_chapters_number',
  'ix_chapters_visible',
  'ix_pages_asset_key',
  'ix_library_user_lastread',
  'ix_progress_user_updated',
  'ix_history_user_time',
  'ix_bookmarks_user',
  'ix_bookmarks_user_chapter_page',
  'ix_uploads_state',
  'ix_uploads_chapter',
  'ix_resettokens_hash',
  'ix_resettokens_user',
  'ix_audit_target',
  'ix_audit_actor',
  'ix_audit_created',
] as const;

/** `childColumn -> parent` mapped to the expected ON DELETE action. */
const EXPECTED_FOREIGN_KEYS: readonly (readonly [string, string, string])[] = [
  ['sessions.user_id', 'users', 'CASCADE'],
  ['manga_alias.manga_id', 'manga', 'CASCADE'],
  ['manga_creator.manga_id', 'manga', 'CASCADE'],
  ['manga_creator.creator_id', 'creator', 'CASCADE'],
  ['manga_genre.manga_id', 'manga', 'CASCADE'],
  ['manga_genre.genre_id', 'genre', 'CASCADE'],
  ['manga_tag.manga_id', 'manga', 'CASCADE'],
  ['manga_tag.tag_id', 'tag', 'CASCADE'],
  ['chapter.manga_id', 'manga', 'CASCADE'],
  ['chapter_page.chapter_id', 'chapter', 'CASCADE'],
  ['library_entry.user_id', 'users', 'CASCADE'],
  ['library_entry.manga_id', 'manga', 'CASCADE'],
  ['reading_progress.user_id', 'users', 'CASCADE'],
  ['reading_progress.chapter_id', 'chapter', 'CASCADE'],
  ['reading_history.user_id', 'users', 'CASCADE'],
  ['reading_history.chapter_id', 'chapter', 'SET NULL'],
  ['bookmark.user_id', 'users', 'CASCADE'],
  ['bookmark.chapter_id', 'chapter', 'SET NULL'],
  ['reader_preference.user_id', 'users', 'CASCADE'],
  ['upload_job.manga_id', 'manga', 'SET NULL'],
  ['upload_job.chapter_id', 'chapter', 'SET NULL'],
  ['upload_job.created_by', 'users', 'SET NULL'],
  ['reset_token.user_id', 'users', 'CASCADE'],
  ['audit_event.actor_id', 'users', 'SET NULL'],
];

/** CHECK-constrained columns, by the constraint name in the migration. */
const EXPECTED_CHECKS = [
  'bookmark_note_len',
  'chapter_page_page_number',
  'chapter_status',
  'creator_role_default',
  'manga_creator_role',
  'manga_reading_direction',
  'manga_status',
  'reader_preference_default_mode',
  'reader_preference_direction_override',
  'reading_progress_page_number',
  'upload_job_input_kind',
  'upload_job_state',
  'users_role',
  'users_status',
] as const;

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

/** Narrows a possibly-absent row value so it can be bound as a parameter. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected a row for ${what}`);
  return value;
}

/**
 * The only Env field `createDb` reads is `databaseUrl`, so a test that owns a
 * real DSN needs no other variable invented.
 */
function fakeEnv(databaseUrl: string): Env {
  return { databaseUrl } as Env;
}

describeDb('schema reality on a fresh PostgreSQL', () => {
  let sql: Sql;
  let firstRun: Awaited<ReturnType<typeof runMigrations>>;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 4 });
    // Freshness is the point: drop everything the previous run left behind,
    // then migrate from the committed files only.
    await sql`drop schema if exists public cascade`;
    await sql`create schema public`;
    firstRun = await runMigrations({ url: DATABASE_URL as string });
    expect(firstRun.applied.length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('reports a live PostgreSQL major that satisfies ADR-002', async () => {
    const [row] = await sql<{ server_version_num: number }[]>`
      select current_setting('server_version_num')::int as server_version_num
    `;
    expect(row?.server_version_num).toBeGreaterThanOrEqual(180000);
  });

  it('enabled the extensions the model needs: pg_trgm + citext', async () => {
    const rows = await sql<{ extname: string }[]>`select extname from pg_extension`;
    const names = rows.map((r) => r.extname);
    expect(names).toContain('pg_trgm');
    expect(names).toContain('citext');
  });

  it('creates exactly the 20 tables', async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    const found = rows.map((r) => r.table_name);
    // the migrator's own journal table is infrastructure, not model
    expect(found.filter((t) => t !== '__drizzle_migrations').sort()).toEqual([...EXPECTED_TABLES]);
  });

  it('drizzle schema and the migrated catalog name the same tables', () => {
    const declared = Object.values(schema)
      .map((value) => getTableName(value as Parameters<typeof getTableName>[0]))
      .filter((name): name is string => typeof name === 'string')
      .sort();
    expect(declared).toEqual([...EXPECTED_TABLES]);
  });

  it('creates exactly the documented indexes (incl. partial + GIN trigram)', async () => {
    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where schemaname = 'public' and indexname not like '%_pkey' and indexname not like '%_pk'
      order by indexname
    `;
    expect(rows.map((r) => r.indexname)).toEqual([...EXPECTED_INDEXES].sort());
  });

  it('marks the uniqueness the model promises as UNIQUE indexes', async () => {
    const rows = await sql<{ indexname: string; is_unique: boolean; indexdef: string }[]>`
      select i.indexname, i.indexdef, ix.indisunique as is_unique
      from pg_indexes i
      join pg_class c on c.relname = i.indexname
      join pg_index ix on ix.indexrelid = c.oid
      where i.schemaname = 'public'
    `;
    const unique = new Map(rows.map((r) => [r.indexname, r.is_unique]));
    for (const name of [
      'ix_users_email',
      'ix_sessions_token',
      'ix_manga_slug',
      'ix_creators_name',
      'ix_genres_name',
      'ix_tags_name',
      'ix_manga_alias_manga_id_alias',
      'ix_chapters_number',
      'ix_chapters_manga_order',
      'ix_pages_asset_key',
      'ix_bookmarks_user_chapter_page',
      'ix_resettokens_hash',
    ]) {
      expect(unique.get(name), `${name} must be UNIQUE`).toBe(true);
    }
    for (const name of ['ix_users_role', 'ix_manga_visible', 'ix_manga_title_trgm']) {
      expect(unique.get(name), `${name} must NOT be unique`).toBe(false);
    }
    // tag names are unique case-insensitively ("lower-cased")
    const tagIndex = rows.find((r) => r.indexname === 'ix_tags_name');
    expect(tagIndex?.indexdef).toContain('lower(name)');
  });

  it('creates the partial catalog hot-path indexes with their predicates', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and indexname in ('ix_manga_visible', 'ix_chapters_visible', 'ix_manga_slug')
      order by indexname
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.get('ix_manga_visible')).toContain(
      'WHERE ((deleted_at IS NULL) AND (published = true))',
    );
    expect(byName.get('ix_manga_visible')).toContain('(updated_at)');
    expect(byName.get('ix_chapters_visible')).toContain(
      "WHERE ((deleted_at IS NULL) AND (status = 'published'::text))",
    );
    expect(byName.get('ix_chapters_visible')).toContain('(reading_order)');
    expect(byName.get('ix_manga_slug')).not.toContain('WHERE');
  });

  it('creates GIN trigram indexes for prefix+contains title/alias search', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and indexname in ('ix_manga_title_trgm', 'ix_manga_alias_alias')
      order by indexname
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.indexdef, row.indexname).toContain('USING gin');
      expect(row.indexdef, row.indexname).toContain('gin_trgm_ops');
    }
    expect(rows[0]?.indexdef).toContain('alias');
    expect(rows[1]?.indexdef).toContain('title');
  });

  it('states the primary key the model specifies, incl. the composite keys', async () => {
    const rows = await sql<{ tablename: string; indexdef: string }[]>`
      select c.relname as tablename, pg_get_indexdef(i.indexrelid) as indexdef
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      where i.indisprimary and c.relnamespace = 'public'::regnamespace
      order by tablename
    `;
    const pkey = new Map(rows.map((r) => [r.tablename, r.indexdef]));
    expect(pkey.get('users')).toContain('(id)');
    // The index row states the composite key, and no `id` column exists on the
    // page table.
    expect(pkey.get('chapter_page')).toContain('(chapter_id, page_number)');
    expect(pkey.get('library_entry')).toContain('(user_id, manga_id)');
    expect(pkey.get('reading_progress')).toContain('(user_id, chapter_id)');
    expect(pkey.get('reader_preference')).toContain('(user_id)');
    expect(pkey.get('manga_creator')).toContain('(manga_id, creator_id)');
    expect(pkey.get('audit_event')).toContain('(id)');
  });

  it('declares every foreign key with the ON DELETE action the model states', async () => {
    const rows = await sql<{ table_name: string; def: string }[]>`
      select conrelid::regclass::text as table_name, pg_get_constraintdef(oid) as def
      from pg_constraint
      where contype = 'f' and connamespace = 'public'::regnamespace
      order by table_name
    `;
    for (const [child, parent, action] of EXPECTED_FOREIGN_KEYS) {
      const [table, column] = child.split('.') as [string, string];
      const found = rows.find(
        (row) =>
          row.table_name === table &&
          row.def.includes(`FOREIGN KEY (${column})`) &&
          row.def.includes(`REFERENCES ${parent}(id)`),
      );
      expect(found, `${child} → ${parent} missing`).toBeDefined();
      expect(found?.def, `${child} must be ON DELETE ${action}`).toContain(`ON DELETE ${action}`);
    }
    expect(rows).toHaveLength(EXPECTED_FOREIGN_KEYS.length);
  });

  it('enforces the CHECK constraints the model promises (enum-ish text columns)', async () => {
    const rows = await sql<{ conname: string }[]>`
      select conname from pg_constraint
      where contype = 'c' and connamespace = 'public'::regnamespace
      order by conname
    `;
    const found = rows.map((r) => r.conname);
    for (const name of EXPECTED_CHECKS) expect(found, name).toContain(name);
    // no undocumented CHECK crept in
    expect(found.length).toBe(EXPECTED_CHECKS.length);
  });

  it('rejects an out-of-enum value instead of storing it (role CHECK)', async () => {
    await expect(
      sql`insert into users (email, password_hash, role) values ('x@y.z', 'hash', 'root')`,
    ).rejects.toThrow(/users_role/);
  });

  it('uses timestamptz for every timestamp', async () => {
    const rows = await sql<{ udt_name: string }[]>`
      select udt_name from information_schema.columns
      where table_schema = 'public' and data_type = 'timestamp with time zone'
    `;
    expect(rows.length).toBeGreaterThan(20);
    const naive = await sql<{ column_name: string; table_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and (data_type = 'timestamp without time zone'
             or (data_type = 'timestamp with time zone' and udt_name = 'timestamp'))
    `;
    expect(naive).toEqual([]);
  });

  it('stores email as case-insensitive citext with a unique index', async () => {
    const [column] = await sql<{ udt_name: string }[]>`
      select udt_name from information_schema.columns
      where table_schema = 'public' and table_name = 'users' and column_name = 'email'
    `;
    expect(column?.udt_name).toBe('citext');
    await sql`insert into users (email, password_hash) values ('Reader@Example.COM', 'h')`;
    await expect(
      sql`insert into users (email, password_hash) values ('reader@example.com', 'h')`,
    ).rejects.toThrow(/ix_users_email/);
  });

  it('generates time-ordered uuid v7 primary keys server-side', async () => {
    const [column] = await sql<{ column_default: string }[]>`
      select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'users' and column_name = 'id'
    `;
    expect(column?.column_default).toBe('uuidv7()');
    await sql`insert into users (email, password_hash) values ('v7-a@example.com', 'h')`;
    await sql`insert into users (email, password_hash) values ('v7-b@example.com', 'h')`;
    const rows = await sql<{ id: string }[]>`
      select id from users where email like 'v7-%@example.com' order by created_at, id
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    // v7 embeds a timestamp in the high bits → later insert sorts later
    expect((rows[1] as { id: string }).id > (rows[0] as { id: string }).id).toBe(true);
  });

  it('represents a fractional chapter number 10.5 in numeric(8,2)', async () => {
    const [column] = await sql<
      { data_type: string; numeric_precision: number | null; numeric_scale: number | null }[]
    >`
      select data_type, numeric_precision, numeric_scale from information_schema.columns
      where table_schema = 'public' and table_name = 'chapter' and column_name = 'number'
    `;
    expect(column?.data_type).toBe('numeric');
    expect(column?.numeric_precision).toBe(8);
    expect(column?.numeric_scale).toBe(2);

    const [manga] = await sql<{ id: string }[]>`
      insert into manga (slug, title) values ('numeric-test', 'Numeric test') returning id
    `;
    const mangaId = must(manga?.id, 'inserted manga id');
    const [row] = await sql<{ number: string }[]>`
      insert into chapter (manga_id, number, reading_order)
      values (${mangaId}::uuid, 10.5, 1) returning number
    `;
    expect(row?.number).toBe('10.50');
    // a CHECK on scale would reject; precision overflow must be rejected too
    await expect(
      sql`insert into chapter (manga_id, number, reading_order)
          values (${mangaId}::uuid, 1000000.00, 2)`,
    ).rejects.toThrow(/numeric field overflow/);
  });

  it('gives the append-only audit log a bigserial PK', async () => {
    const [column] = await sql<{ data_type: string; column_default: string | null }[]>`
      select data_type, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'audit_event' and column_name = 'id'
    `;
    expect(column?.data_type).toBe('bigint');
    expect(column?.column_default).toContain('nextval');
    await sql`insert into audit_event (action, target_kind, target_id) values ('manga.create', 'manga', 'x')`;
    await sql`insert into audit_event (action, target_kind, target_id) values ('manga.publish', 'manga', 'x')`;
    const rows = await sql<{ id: string }[]>`select id from audit_event order by id`;
    expect(BigInt((rows[1] as { id: string }).id)).toBeGreaterThan(
      BigInt((rows[0] as { id: string }).id),
    );
  });

  it('grants nothing to anyone but the owner — the app-role split', async () => {
    // The initial migration creates objects; it does NOT create roles. So today
    // the only grantee of audit_event is the role that ran the migration, and
    // the "app role holds no UPDATE/DELETE on the audit log" control cannot be,
    // and must not be, asserted here: it becomes true when the roles and their
    // grants are added.
    const rows = await sql<{ grantee: string }[]>`
      select distinct grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'audit_event'
    `;
    const [me] = await sql<{ current_user: string }[]>`select current_user`;
    expect(rows.map((r) => r.grantee)).toEqual([must(me?.current_user, 'current_user')]);
  });
});

describeDb('connection lifecycle: pool max 10, clean shutdown', () => {
  it('never opens more than 10 connections and drains them on close()', async () => {
    const url = DATABASE_URL as string;
    let client: Sql | undefined;
    let db: Awaited<ReturnType<typeof createDb>> | undefined;
    const observer = postgres(url, { max: 1 });
    // Backends of this database that are not the psql used for setup.
    const openBackends = async (): Promise<number> => {
      const [row] = await observer<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database()
          and backend_type = 'client backend'
          and application_name <> 'psql'
      `;
      return row?.n ?? -1;
    };
    try {
      expect(DB_POOL_MAX).toBe(10);
      const baseline = await openBackends();

      client = createPostgresClient(url);
      expect(client.options.max).toBe(DB_POOL_MAX);
      expect(client.options.idle_timeout).toBe(DB_IDLE_TIMEOUT_SECONDS);
      expect(client.options.connect_timeout).toBe(DB_CONNECT_TIMEOUT_SECONDS);

      // 25 concurrent queries: the pool, not the server, is what bounds this.
      await Promise.all(Array.from({ length: 25 }, () => client!`select 1`));
      const peak = (await openBackends()) - baseline;
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(DB_POOL_MAX);
      await client.end({ timeout: 5 });
      expect(await openBackends()).toBe(baseline);

      // The composed handle: schema-bound Drizzle + close() drains the pool.
      db = await createDb(fakeEnv(url));
      expect(DB_POOL_MAX).toBe(10);
      await closeDb(db);
      expect(await openBackends()).toBe(baseline);
    } finally {
      await observer.end({ timeout: 5 });
    }
  });

  it('refuses a missing or non-postgres DSN instead of guessing', () => {
    expect(() => createPostgresClient('')).toThrow(DatabaseConfigurationError);
    expect(() => createPostgresClient('   ')).toThrow(DatabaseConfigurationError);
    expect(() => createPostgresClient('mysql://root@localhost/yomi')).toThrow(
      DatabaseConfigurationError,
    );
    // the message names the VARIABLE, never the DSN
    expect(() => createPostgresClient('not a url')).toThrow(/^DATABASE_URL: /);
  });
});

describeDb('migration is idempotent per revision', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 4 });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  /** Catalog fingerprint: everything a migration is allowed to change. */
  async function fingerprint(): Promise<string> {
    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`;
    const columns = await sql`
      select table_name, column_name, udt_name, is_nullable, coalesce(column_default, '')
      from information_schema.columns where table_schema = 'public'
      order by table_name, column_name`;
    const indexes = await sql`
      select indexname, indexdef from pg_indexes where schemaname = 'public'
      order by indexname`;
    const constraints = await sql`
      select conname, pg_get_constraintdef(oid) from pg_constraint
      where connamespace = 'public'::regnamespace order by conname`;
    return createHash('sha256')
      .update(JSON.stringify([tables, columns, indexes, constraints]))
      .digest('hex');
  }

  it('applies nothing on a second run and leaves the catalog byte-identical', async () => {
    const before = await fingerprint();
    const journalBefore = await sql`select count(*)::int as n from public.__drizzle_migrations`;
    const second = await runMigrations({ url: DATABASE_URL as string });
    expect(second.applied).toEqual([]);
    const after = await fingerprint();
    const journalAfter = await sql`select count(*)::int as n from public.__drizzle_migrations`;
    expect(after).toBe(before);
    expect(journalAfter[0]?.n).toBe(journalBefore[0]?.n);
  });

  it('records one journal row per migration file, keyed by content hash', async () => {
    const rows = await sql<{ hash: string; created_at: string }[]>`
      select hash, created_at from public.__drizzle_migrations order by created_at
    `;
    // Counted from the migration folder rather than pinned to a number: a new migration is
    // supposed to make this assertion grow, and a hardcoded count is what let 0000 ship
    // with the dev-fallback schema without anything here noticing.
    // Same resolution order the migrator uses: the MIGRATIONS_DIR override, else ./drizzle.
    const migrationsDir = process.env['MIGRATIONS_DIR'] ?? join(process.cwd(), 'drizzle');
    const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));
    expect(rows).toHaveLength(migrationFiles.length);
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.hash).toHaveLength(64);
  });
});

describeDb('concurrent boots serialise on the migration advisory lock', () => {
  it('a second migrator waits for the lock, then completes after release', async () => {
    const url = DATABASE_URL as string;
    const holder = postgres(url, { max: 1 });
    let running: Promise<Awaited<ReturnType<typeof runMigrations>>> | undefined;
    try {
      const [locked] = await holder<{ ok: boolean }[]>`
        select pg_try_advisory_lock(${MIGRATION_LOCK_ID}::bigint) as ok
      `;
      expect(locked?.ok).toBe(true);

      let settled = false;
      running = runMigrations({ url }).then((result) => {
        settled = true;
        return result;
      });
      // Absorb a rejection until we are ready to await it, so an early failure
      // cannot become an unhandled rejection while we poll.
      const outcome = running.then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      // The waiter must appear in pg_locks as an ungranted advisory lock while
      // the holder keeps it: blocked, not racing, not failing.
      let waiting = 0;
      for (let attempt = 0; attempt < 50 && waiting === 0; attempt += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const [row] = await holder<{ waiting: number }[]>`
          select count(*)::int as waiting from pg_locks
          where locktype = 'advisory' and not granted
        `;
        waiting = row?.waiting ?? 0;
      }
      expect(waiting, 'a second migrator must wait on the advisory lock').toBe(1);
      expect(settled, 'it must still be blocked').toBe(false);

      await holder`select pg_advisory_unlock(${MIGRATION_LOCK_ID}::bigint)`;
      const result = await outcome;
      expect(result.ok, 'the waiter must succeed, not fail').toBe(true);
      expect(settled).toBe(true);
      if (result.ok) {
        expect(result.result.applied).toEqual([]);
        expect(result.result.lockId).toBe(MIGRATION_LOCK_ID);
      }
    } finally {
      // Never leave an orphan holding the lock for the next test.
      await holder.end({ timeout: 5 });
      await running;
    }
  });

  it('releases the lock on failure so a later boot is not wedged', async () => {
    const url = DATABASE_URL as string;
    await expect(
      runMigrations({ url, migrationsFolder: '/nonexistent/yomi/migrations' }),
    ).rejects.toThrow();
    const probe = postgres(url, { max: 1 });
    try {
      const [free] = await probe<{ ok: boolean }[]>`
        select pg_try_advisory_lock(${MIGRATION_LOCK_ID}::bigint) as ok
      `;
      expect(free?.ok).toBe(true);
      await probe`select pg_advisory_unlock(${MIGRATION_LOCK_ID}::bigint)`;
    } finally {
      await probe.end({ timeout: 5 });
    }
  });
});
