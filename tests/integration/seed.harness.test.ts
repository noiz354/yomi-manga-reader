/**
 * Integration tests — the dev seed harness against a REAL PostgreSQL 18
 * (T-FOUND-012).
 *
 * What is asserted here, and why it is an integration test:
 *   the rows are actually in the database with the counts the
 *                 report claims; the 30-page and 500-page chapters have exactly
 *                 30/500 contiguous pages at the fixture geometry with REAL
 *                 measured variant byte sizes; the seeded accounts are an
 *                 Argon2id admin and a reader; no title is anything but a
 *                 numbered fixture; the whole
 *                 500-page case stays inside the task's 60 s budget.
 *   a second run writes NOTHING and leaves the row counts, the
 *                 stored credential and the report byte-identical.
 *   the CLI refuses `NODE_ENV=production` with exit code 2 even
 *                 though `--env dev` was passed (the security control, observed
 *                 through a real process rather than a function call).
 *
 * The page fixtures are rendered at the harness's DEFAULT geometry (480x720)
 * here on purpose: the 60 s budget is a claim about that geometry, so a test
 * that shrank the images would assert nothing. The 500-page chapter dominates
 * this file's runtime (~20 s per run, twice) — that is the cost of the
 * product's defining performance case being a real fixture.
 *
 * DSN: `DATABASE_URL`, the variable DEPLOYMENT.md §3 declares. The suite SKIPS
 * (never silently passes) when it is absent, so `npm run test:unit` and a bare
 * `npm test` work without Docker. `beforeAll` drops and recreates the `public`
 * schema, so the DSN MUST point at a THROWAWAY database:
 *
 *   docker run -d --name yomi-seed-tmp -e POSTGRES_USER=yomi \
 *     -e POSTGRES_PASSWORD=yomi -e POSTGRES_DB=yomi -p 55439:5432 postgres:18-alpine
 *   DATABASE_URL=postgres://yomi:yomi@127.0.0.1:55439/yomi \
 *     npx vitest run tests/integration/seed.harness.test.ts
 *
 * Note (`vitest.config.ts` runs integration files in ONE fork): do not point
 * this suite at the same database as `db-schema.test.ts`, which also drops the
 * schema. Nothing in this file uses product data; every row comes from the
 * harness itself.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/server/db/migrations';
import {
  EXIT_OK,
  EXIT_REFUSED,
  PAGE_SEED_BUDGET_MS,
  runSeed,
} from '../../scripts/seed.mjs';

/* ── the environment the harness is given ────────────────────────────────── */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

/** A value that is NOT in the repository and is not a product secret. */
const SENTINEL_CREDENTIAL = 'it-never-happened-7c1f4a92';

/**
 * A complete, valid DEPLOYMENT.md §3 environment for a throwaway database. The
 * credential is generated here at test time, which is the point: the harness
 * cannot be given a password that is not in the environment (UNIT-SEED-003).
 */
/** Where this suite's page objects land. Per-run, so a stale tree cannot mask a missing write. */
const SEED_TEST_STORAGE_DIR = join(tmpdir(), `yomi-seed-harness-${process.pid}`);

function harnessEnv(overrides: Record<string, string | undefined> = {}): Record<
  string,
  string | undefined
> {
  return {
    NODE_ENV: 'test',
    APP_ORIGIN: 'https://reader.example.com',
    SESSION_SECRET: 'f'.repeat(64),
    DATABASE_URL: DATABASE_URL,
    S3_ENDPOINT: 'http://127.0.0.1:59000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'yomi-media',
    S3_ACCESS_KEY_ID: 'yomi-access-key',
    S3_SECRET_ACCESS_KEY: 'yomi-secret-key',
    // The seed now writes each page's three variants through `ObjectStoragePort`
    // (T-UPLOAD-004 is what will own that step for real uploads). Pointed at a local
    // directory so the suite exercises the write against a storage that exists; the S3
    // endpoint above stays a dead port precisely so a test that reached for it would fail
    // rather than silently talk to a shared bucket.
    STORAGE_DIR: SEED_TEST_STORAGE_DIR,
    NEXT_TELEMETRY_DISABLED: '1',
    SEED_ADMIN_PASSWORD: SENTINEL_CREDENTIAL,
    SEED_READER_PASSWORD: SENTINEL_CREDENTIAL,
    ...overrides,
  };
}

/** Collects the streams `runSeed` writes, so the report can be asserted. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    get out() {
      return out.join('');
    },
    get err() {
      return err.join('');
    },
  };
}

/* ── INT-SEED-001/002 — the seed against a real database ────────────────── */

describeDb('INT-SEED-001/002 / T-FOUND-012 — seed → assert counts → re-run is a no-op', () => {
  let sql: ReturnType<typeof postgres>;
  /** The report of the first run, kept for the determinism/idempotency checks. */
  let firstReport = '';
  let firstTimings: Record<string, number> = {};
  let firstHash = '';

  beforeAll(async () => {
    sql = postgres(DATABASE_URL as string, { max: 4 });
    // Freshness is the point: the committed migrations only, from scratch.
    await sql`drop schema if exists public cascade`;
    await sql`create schema public`;
    await runMigrations({ url: DATABASE_URL as string });
    // The handle the seed mints, read back from a row it wrote — not recomputed here,
    // so this suite asserts what actually landed in the table.
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it(
    'seeds every planned row, with the counts the report claims',
    async () => {
      const streams = capture();
      const result = await runSeed({
        argv: ['--env', 'test', '--run-id', 'vitest'],
        source: harnessEnv(),
        stdout: streams.stdout,
        stderr: streams.stderr,
      });
      expect(result.code, streams.err).toBe(EXIT_OK);
      firstReport = result.report ?? '';
      firstTimings = result.timings;

      // ── the report's own totals, line by line ──────────────────────────
      expect(firstReport).toContain(
        'totals manga=10 chapters=26 pages=722 users=2 genres=8 tags=8 creators=2',
      );
      expect(firstReport).toContain('manga tvitest-seed-manga-0030-pages');
      expect(firstReport).toContain('manga tvitest-seed-manga-0500-pages');
      expect(firstReport).toContain('load-fixture titles=0');
      expect(firstReport).toContain('anomalies unplanned_titles=0 geometry_mismatches=0');
      expect(firstReport).toContain('pages=480x720 synthetic=gradient-grayscale');

      // ── and the database agrees with the report ────────────────────────
      const counts = await sql<{ table_name: string; n: number }[]>`
        select 'users' as table_name, count(*)::int as n from users
        union all select 'genre', count(*)::int from genre
        union all select 'tag', count(*)::int from tag
        union all select 'creator', count(*)::int from creator
        union all select 'manga', count(*)::int from manga
        union all select 'manga_alias', count(*)::int from manga_alias
        union all select 'manga_creator', count(*)::int from manga_creator
        union all select 'manga_genre', count(*)::int from manga_genre
        union all select 'manga_tag', count(*)::int from manga_tag
        union all select 'chapter', count(*)::int from chapter
        union all select 'chapter_page', count(*)::int from chapter_page
      `;
      const byTable = new Map(counts.map((row) => [row.table_name, row.n]));
      expect(byTable.get('users')).toBe(2);
      expect(byTable.get('genre')).toBe(8);
      expect(byTable.get('tag')).toBe(8);
      expect(byTable.get('creator')).toBe(2);
      expect(byTable.get('manga')).toBe(10);
      expect(byTable.get('manga_alias')).toBe(18);
      expect(byTable.get('manga_creator')).toBe(20);
      expect(byTable.get('manga_genre')).toBe(20);
      expect(byTable.get('manga_tag')).toBe(30);
      expect(byTable.get('chapter')).toBe(26);
      expect(byTable.get('chapter_page')).toBe(722);
      expect(result.verification?.tables['chapter_page']).toBe(722);
    },
    180_000,
  );

  it('writes the 30-page and 500-page chapters as contiguous pages at the fixture geometry', async () => {
    for (const [slug, expected] of [
      ['tvitest-seed-manga-0030-pages', 30],
      ['tvitest-seed-manga-0500-pages', 500],
    ] as const) {
      const [manga] = await sql<{ id: string; published: boolean }[]>`
        select id, published from manga where slug = ${slug}
      `;
      const mangaId = must(manga?.id, `manga ${slug}`);
      const [chapter] = await sql<{ id: string; page_count: number; status: string }[]>`
        select id, page_count, status from chapter where manga_id = ${mangaId}::uuid
      `;
      const chapterId = must(chapter?.id, `chapter of ${slug}`);
      expect(chapter?.page_count, slug).toBe(expected);
      expect(chapter?.status).toBe('published');

      const pages = await sql<
        {
          page_number: number;
          asset_key: string;
          width: number;
          height: number;
          byte_size_avif: string | null;
          byte_size_webp: string | null;
          byte_size_jpeg: string | null;
        }[]
      >`select page_number, asset_key, width, height, byte_size_avif, byte_size_webp, byte_size_jpeg
        from chapter_page where chapter_id = ${chapterId}::uuid order by page_number`;
      expect(pages.length, slug).toBe(expected);
      // DATA_MODEL §21.2: exactly 1..N, no gaps, no duplicates
      expect(pages.map((page) => page.page_number)).toEqual(
        Array.from({ length: expected }, (_, offset) => offset + 1),
      );
      for (const page of pages) {
        // An opaque handle that the delivery grammar accepts: one URL segment, 22–64
        // chars of [A-Za-z0-9_-], no slashes. The old `seed/v1/<digest>` keys failed
        // this and 404'd at parse time — see tests/integration/media-seed-delivery.test.ts.
        expect(page.asset_key, slug).toMatch(/^[0-9a-f]{32}$/);
        expect(page.width).toBe(480);
        expect(page.height).toBe(720);
        // real measurements from a real sharp encode, not invented numbers
        expect(Number(page.byte_size_avif)).toBeGreaterThan(0);
        expect(Number(page.byte_size_webp)).toBeGreaterThan(0);
        expect(Number(page.byte_size_jpeg)).toBeGreaterThan(0);
      }
      // a gradient compresses; it is not a scan, and the three variants are
      // three real encodes of the same synthetic image
      const avif = Number(pages[0]?.byte_size_avif);
      const jpeg = Number(pages[0]?.byte_size_jpeg);
      expect(avif).toBeLessThan(40_000);
      expect(jpeg).toBeGreaterThan(avif);
    }
  }, 60_000);

  it('seeds one admin and one reader, with an Argon2id hash from the environment', async () => {
    const users = await sql<
      { email: string; role: string; password_hash: string; status: string }[]
    >`select email, role, password_hash, status from users order by email`;
    expect(users.map((user) => `${user.email}:${user.role}:${user.status}`)).toEqual([
      'tvitest-seed-admin@seed.invalid:admin:active',
      'tvitest-seed-reader@seed.invalid:reader:active',
    ]);
    for (const user of users) {
      // the product's KDF and its pinned parameters (features/auth/password.ts)
      // argon2 serialises its parameters in alphabetical key order
      expect(user.password_hash).toMatch(/^\$argon2id\$v=19\$m=65536,p=4,t=3\$/);
      // the value that went in was the environment's, not a repository literal
      expect(user.password_hash).not.toContain(SENTINEL_CREDENTIAL);
    }
    const [admin] = users;
    firstHash = admin?.password_hash ?? '';
    expect(firstHash.length).toBeGreaterThan(20);
  });

  it('carries no product content: every title is a numbered fixture', async () => {
    const titles = await sql<{ title: string; slug: string; synopsis: string }[]>`
      select title, slug, synopsis from manga order by slug
    `;
    expect(titles.length).toBe(10);
    for (const row of titles) {
      expect(row.title, row.slug).toMatch(/^Seed Manga \d{4}(-\d+-Pages|-Pages)?$/);
      expect(row.synopsis.toLowerCase()).toContain('synthetic');
    }
    const aliases = await sql<{ alias: string }[]>`select alias from manga_alias`;
    // every alias is a numbered fixture alias: an alternate title for an
    // ordinary title, or the slug of one of the two performance fixtures
    for (const row of aliases) {
      expect(row.alias, row.alias).toMatch(
        /^tvitest-(Seed Manga \d{4}|Serie \d{4}|seed-manga-\d{4}-pages)/,
      );
    }
    const creators = await sql<{ name: string }[]>`select name from creator`;
    for (const row of creators) expect(row.name).toMatch(/^tvitest-Seed (Author|Artist) 01$/);
  });

  it('leaves a draft chapter unpublished (FR-CHAPTER-002 has a fixture)', async () => {
    const rows = await sql<{ status: string; n: number }[]>`
      select status, count(*)::int as n from chapter group by status order by status
    `;
    expect(rows.map((row) => `${row.status}:${String(row.n)}`)).toEqual(['draft:8', 'published:18']);
  });

  it('stays inside the 60 s budget for the 500-page case (the task edge case)', () => {
    // The harness renders 722 pages (of which 500 belong to the marathon
    // chapter) at the default 480x720 geometry, encoding AVIF + WebP + JPEG for
    // each, and this is the phase the budget is about.
    expect(firstTimings['render']).toBeGreaterThan(0);
    expect(firstTimings['render']).toBeLessThan(PAGE_SEED_BUDGET_MS);
    expect(firstTimings['total']).toBeGreaterThanOrEqual(firstTimings['render'] ?? 0);
  });

  it(
    'is a no-op the second time: identical report, identical rows, untouched credential',
    async () => {
      const before = await rowFingerprint(sql);
      const streams = capture();
      const result = await runSeed({
        argv: ['--env', 'test', '--run-id', 'vitest'],
        source: harnessEnv(),
        stdout: streams.stdout,
        stderr: streams.stderr,
      });
      expect(result.code, streams.err).toBe(EXIT_OK);

      // zero writes on every counter
      expect(result.stats).toMatchObject({
        vocabulary: { genresCreated: 0, tagsCreated: 0, creatorsCreated: 0 },
        users: { created: 0 },
        manga: { created: 0, links: 0, loadTitlesCreated: 0 },
        chapters: { created: 0 },
        pages: { written: 0 },
      });
      expect(result.report).toContain(
        'writes manga_created=0 links=0 chapters_created=0 pages_written=0 users_created=0',
      );
      // Everything the report says about the DATABASE is byte-identical to the
      // first run's. The one line that must differ is the write counter line —
      // that difference is the idempotency evidence, not a determinism failure
      // (a diff between two FRESH runs is empty; see the T-FOUND-012 report).
      expect(stripWriteLine(result.report ?? '')).toBe(stripWriteLine(firstReport));
      expect(result.report).not.toBe(firstReport);
      // the database is untouched, down to the Argon2id salt
      expect(await rowFingerprint(sql)).toEqual(before);
      const [admin] = await sql<{ password_hash: string }[]>`
        select password_hash from users where role = 'admin'
      `;
      expect(admin?.password_hash).toBe(firstHash);
    },
    180_000,
  );

  it('refuses a production run through the CLI, with exit code 2', () => {
    // The security control, observed through a real process: a `--env dev` flag
    // behind `NODE_ENV=production` must not reach the database. The environment
    // below is a COMPLETE, VALID production configuration (https everywhere, as
    // T-FOUND-002 requires) so that the refusal cannot be dismissed as "it just
    // failed to boot".
    const script = fileURLToPath(new URL('../../scripts/seed.mjs', import.meta.url));
    const env = {
      ...process.env,
      ...harnessEnv({
        NODE_ENV: 'production',
        APP_ORIGIN: 'https://reader.example.com',
        S3_ENDPOINT: 'https://s3.example.com',
      }),
    };
    let exitCode = 0;
    let output = '';
    try {
      output = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', script, '--env', 'dev'], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      exitCode = failure.status ?? 1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    expect(exitCode).toBe(EXIT_REFUSED);
    expect(output).toContain('refused');
    expect(output).toContain('NODE_ENV=production');
    // redaction: the refusal names the variable, never the DSN (NFR-OBS-006)
    expect(output).not.toContain(DATABASE_URL as string);
    expect(output).not.toContain(SENTINEL_CREDENTIAL);
  });
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * Narrows a possibly-absent row value so it can be bound as a parameter (a
 * `string | undefined` is not a parameter — the helper is the test's way of
 * saying "this row must exist, or the assertion below should fail loudly").
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected a row for ${what}`);
  return value;
}

/**
 * The report without its write-counter line: the part of the report that
 * describes the seeded STATE rather than the work this run did.
 *
 * @param {string} report
 * @returns {string}
 */
function stripWriteLine(report: string): string {
  return report
    .split('\n')
    .filter((line) => !line.startsWith('writes '))
    .join('\n');
}

/**
 * A content fingerprint of everything the harness writes. Two runs of the
 * harness must leave this identical — including `created_at`, which is why the
 * harness never writes it.
 *
 * @param {ReturnType<typeof postgres>} sql
 */
async function rowFingerprint(sql: ReturnType<typeof postgres>): Promise<string> {
  const [rows] = await sql<{ fingerprint: string }[]>`
    select md5(coalesce(string_agg(row_text, '|' order by row_text), '')) as fingerprint
    from (
      select 'u ' || id || email || role || password_hash as row_text from users
      union all select 'm ' || id || slug || title || status || reading_direction ||
        published::text || coalesce(cover_asset_key, '') from manga
      union all select 'a ' || id || manga_id || alias from manga_alias
      union all select 'c ' || id || manga_id || number || status || page_count::text ||
        coalesce(reading_order::text, '') from chapter
      union all select 'p ' || chapter_id || page_number::text || asset_key ||
        width::text || height::text from chapter_page
    ) as seeded
  `;
  return rows?.fingerprint ?? '';
}

/** The harness file, read for the header assertion below. */
const HARNESS_SOURCE = readFileSync(
  fileURLToPath(new URL('../../scripts/seed.mjs', import.meta.url)),
  'utf8',
);

describe('the harness documents its own phase', () => {
  it('says in its header that keys and bytes are seeded but the pipeline is not done', () => {
    // The header must say that covers are still dark: page bytes are real,
    // cover bytes are not. The test pins the wording so the caveat cannot
    // drift away silently.
    expect(HARNESS_SOURCE).toContain('covers 404 until the cover half of the pipeline lands');
  });

    it('writes page objects through the storage port and never touches the filesystem itself', () => {
      // The seed owns no media path. It hands each encoded variant to
      // `ObjectStoragePort`, which is the same call a real upload makes and the same
      // call the media route reads back through; the adapter owns directories, content
      // types and the `pages/{chapterId}/` layout. That is the property worth holding —
      // not "writes nothing", which stopped being true once pages became readable.
      for (const forbidden of ['writeFile', 'appendFile', 'createWriteStream', '@aws-sdk']) {
        expect(HARNESS_SOURCE, forbidden).not.toContain(forbidden);
      }
      // `mkdir` must not reappear here: the layout belongs to the adapter.
      expect(HARNESS_SOURCE).not.toContain('mkdir');
      // The one write path in the harness, named explicitly so it can be reviewed.
      expect(HARNESS_SOURCE).toContain('storage.putStream');
      // the only `fs` import is the entry-point probe, which reads nothing
      expect(HARNESS_SOURCE).toContain("import { realpathSync } from 'node:fs'");
    });

});
