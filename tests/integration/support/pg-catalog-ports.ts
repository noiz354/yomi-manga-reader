/**
 * Integration-test support: a REAL PostgreSQL 18 database plus port doubles
 * backed by it. The doubles run real SQL against the real schema, so ordering,
 * numeric formatting, the visibility rule and the 1000-cap are exercised against
 * rows, not a mock. The latest-chapter read is a correlated subquery in ONE
 * statement; SqlProbe counts statements so an N+1 regression fails the test.
 * DSN: DATABASE_URL; suites SKIP when absent, and the DSN MUST be a throwaway
 * database because openCatalogDatabase drops and recreates the public schema. */
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableName,
  gt,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { runMigrations } from '../../../src/server/db/migrations';
import { genreSlugSql } from '../../../src/server/db/repositories/manga.repository';
import { AppError } from '../../../src/shared/contracts/errors';
import * as dbSchema from '../../../src/server/db/schema';
// A repository — not the service — defines the cursor payload. This double
// therefore carries its own envelope, and the service forwards the token
// untouched.
import { CATALOG_CURSOR_MAX_LENGTH } from '../../../src/features/catalog';
import { SILENT_LOGGER } from '../../../src/app/api/v1/_http';
import type { CatalogVocabularyPort } from '../../../src/features/catalog';
import type { Logger } from '../../../src/server/telemetry/logger';
import type { ChapterRepository } from '../../../src/features/chapters';
import type { MangaRepository } from '../../../src/features/manga';
import type {
  CallerContext,
  ChapterSummary,
  MangaDetail,
  MangaStatus,
  MangaSummary,
} from '../../../src/shared/contracts';
import type { ChapterId, MangaId, MangaSlug } from '../../../src/shared/types';
import { deterministicUuid } from '../../../scripts/seed.mjs';

/**
 * The application's database handle, exactly as `createDb` returns it.
 *
 * `createDb` (src/server/db/client) attaches a `close()` to the Drizzle handle,
 * and `createMangaRepository`/`createChapterRepository` are typed against THAT
 * type. A bare `drizzle(...)` is not assignable to it, so the handle is built
 * the same way `createDbCore` builds it — one shape, no casts at the injection
 * point, and the seam test can hand this straight to a real repository.
 */
export type Db = ReturnType<typeof drizzle<typeof dbSchema>> & {
  close(): Promise<void>;
};

/** One statement the driver sent, with its bound parameters. */
export interface CapturedStatement {
  readonly seq: number;
  readonly text: string;
  readonly parameters: readonly unknown[];
}

export interface SqlProbe {
  /** Everything the driver was asked to run, in order. */
  readonly statements: readonly CapturedStatement[];
  /** Forget the log, so the next assertion counts one request only. */
  reset(): void;
  /** Statements issued since the last {@link reset}. */
  since(): readonly CapturedStatement[];
}

export interface OpenDatabase {
  readonly db: Db;
  readonly probe: SqlProbe;
  close(): Promise<void>;
}

/**
 * An advisory-lock id so two suites that name the same database serialise
 * instead of racing. Any constant works; it only has to differ from the
 * migration runner's own lock (`MIGRATION_LOCK_ID`) so the two never queue
 * behind each other for no reason.
 */
// A plain number, not a bigint: 8.1e15 is exact in a double, and postgres.js's
// parameter union does not admit `bigint`.
const FIXTURE_DATABASE_LOCK_ID = 8_147_230_915_442_001;

/**
 * Opens a throwaway DATABASE for ONE suite, dropped and re-migrated.
 *
 * Why a database per suite, and not a shared one. Two independent reasons,
 * both measured rather than assumed:
 *
 * 1. The suites run in PARALLEL. `vitest.config.ts` sets
 *    `poolOptions.forks.singleFork`, and Vitest 4 REMOVED `poolOptions` (it
 *    warns "test.poolOptions was removed in Vitest 4 — all previous poolOptions
 *    are now top-level options"), so the setting is inert: every integration
 *    FILE gets its own fork and they overlap. Four files that each ran
 *    `drop schema public cascade` destroyed one another's fixtures, and the
 *    failures surfaced as duplicate-key errors in unrelated code.
 * 2. A per-suite SCHEMA is not enough on its own. `migrateOnBoot`/`runMigrations`
 *    keep their journal in `public.__drizzle_migrations` by name
 *    (`MIGRATION_JOURNAL_SCHEMA`), so a second suite pointed at a fresh schema
 *    reads that journal, concludes every migration is already applied, and
 *    creates no tables at all. The journal is per-DATABASE, not per-schema.
 *
 * The fix for (1) belongs in `vitest.config.ts` (a top-level `singleFork`),
 * which is outside this task's write scope, so each suite takes a database of
 * its own instead. That makes the files independently runnable AND
 * parallel-safe against one `DATABASE_URL` — automating exactly what the
 * existing suites' headers ask operators to do by hand with separate databases
 * and separate ports.
 *
 * The drop/create pair runs under an advisory lock: two files naming the same
 * database (a re-run, or a typo) serialise instead of racing, and
 * `DROP DATABASE IF EXISTS` is not otherwise concurrency-safe.
 *
 * @param databaseUrl the operator's DSN (`DATABASE_URL`)
 * @param name this suite's own database name
 */
export async function openCatalogDatabase(
  databaseUrl: string,
  name: string,
): Promise<OpenDatabase> {
  const maintenanceUrl = new URL(databaseUrl);
  maintenanceUrl.pathname = '/postgres';
  const dbUrl = new URL(databaseUrl);
  dbUrl.pathname = `/${name}`;

  const maintenance = postgres(maintenanceUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
  await maintenance`select pg_advisory_lock(${FIXTURE_DATABASE_LOCK_ID}::bigint)`;
  try {
    // `WITH (FORCE)` terminates connections a previous run left behind — a
    // dropped pool can still have one in flight for a moment. `CREATE/DROP
    // DATABASE` takes no parameters and cannot run inside a transaction, which
    // is why the driver is given the statement as a literal with ONE bound
    // identifier (`maintenance(name)`) rather than as a parameterised template.
    const identifier = maintenance(name);
    await maintenance`drop database if exists ${identifier} with (force)`;
    await maintenance`create database ${identifier}`;
  } finally {
    await maintenance`select pg_advisory_unlock(${FIXTURE_DATABASE_LOCK_ID}::bigint)`;
    await maintenance.end({ timeout: 5 });
  }
  const statements: CapturedStatement[] = [];
  const client = postgres(dbUrl.toString(), {
    max: 4,
    onnotice: () => undefined,
    debug: (_connection, text, parameters) => {
      // `parameters` is `any[]` in the driver's own types (the values are only
      // known to the server), so it is widened to `unknown[]` here rather than
      // left to leak as `any` into every consumer of the probe.
      const bound: unknown[] = parameters as unknown[];
      statements.push({ seq: statements.length + 1, text, parameters: bound });
    },
  });
  const db: Db = Object.assign(drizzle(client, { schema: dbSchema }), {
    close: (): Promise<void> => client.end({ timeout: 5 }),
  });
  await runMigrations({ url: dbUrl.toString() });
  // Everything before this point is session noise (pool probe + DDL). The
  // request-level assertions count only what a request issues.
  const probe: SqlProbe = {
    get statements() {
      return statements;
    },
    reset() {
      statements.length = 0;
    },
    since() {
      return statements.slice();
    },
  };
  probe.reset();
  return {
    db,
    probe,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}

/** The five genres the ordinary fixtures cycle through. */
export const GENRES = ['Action', 'Romance', 'Sci-Fi', 'Comedy', 'Drama'] as const;
/**
 * A genre that EXISTS as a row but that no VISIBLE title carries — only the
 * unpublished fixture does. It gives the suite a real "combined filters
 * yielding 0" case and a real "a genre no visible title has is
 * not offered as a filter" case for the facets endpoint. Deliberately NOT in
 * {@link GENRES}, or the ordinary fixtures would cycle onto it.
 */
export const HIDDEN_ONLY_GENRE = 'Horror';
export const TAGS: readonly string[] = ['isekai', 'shounen', 'long-running'];

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const day = (offset: number): Date => new Date(EPOCH + offset * 86_400_000);

export interface FixtureChapter {
  readonly number: string;
  readonly title: string | null;
  readonly status: 'draft' | 'published';
  readonly pageCount: number;
  /** Explicit ordering key; defaults to the integer part of `number`. */
  readonly readingOrder?: number;
}

export interface FixtureManga {
  readonly slug: string;
  readonly title: string;
  readonly status: MangaStatus;
  readonly published: boolean;
  readonly deleted: boolean;
  readonly genres: readonly string[];
  readonly tags: readonly string[];
  readonly chapters: readonly FixtureChapter[];
}

function chapter(
  number: string,
  status: 'draft' | 'published',
  readingOrder?: number,
): FixtureChapter {
  return {
    number,
    title: status === 'draft' ? `${number} (draft)` : `Chapter ${number}`,
    status,
    pageCount: 20,
    ...(readingOrder === undefined ? {} : { readingOrder }),
  };
}

/** The 1000-cap fixture size — one more than `CHAPTER_LIST_HARD_CAP`. */
export const OVER_CAP_CHAPTERS = 1001;

/**
 * The fixture corpus, deliberately shaped to break things:
 * - 30 published titles with mixed statuses/genres, and titles that sort
 *   differently from their slugs (so a `title_asc` assertion that accidentally
 *   used the slug would fail);
 * - one UNPUBLISHED and one SOFT-DELETED published title, both of which must be
 *   absent from every catalog read;
 * - one title with NO chapters (`latestChapter` must be null);
 * - one title whose `reading_order` DISAGREES with `number`, so the ordering
 *   assertion is about `reading_order` and not about numeric luck;
 * - one title with a draft and a `10.5` chapter;
 * - one title with {@link OVER_CAP_CHAPTERS} chapters.
 */
export const FIXTURE_MANGA: readonly FixtureManga[] = [
  ...Array.from({ length: 30 }, (_, offset): FixtureManga => {
    const index = offset + 1;
    const padded = String(index).padStart(4, '0');
    return {
      slug: `cat-manga-${padded}`,
      title: `Catalog Title ${String(30 - index).padStart(3, '0')} ${padded}`,
      status: (['ongoing', 'completed', 'hiatus'] as const)[offset % 3] ?? 'ongoing',
      published: true,
      deleted: false,
      genres: [
        GENRES[index % GENRES.length] ?? 'Action',
        GENRES[(index + 1) % GENRES.length] ?? 'Comedy',
      ],
      tags: [TAGS[index % TAGS.length] ?? 'isekai'],
      chapters: [
        chapter('1.00', 'published'),
        chapter('2.00', 'published'),
        chapter('3.00', 'draft'),
      ],
    };
  }),
  {
    slug: 'cat-manga-unpublished',
    title: 'Catalog Title 999 unpublished',
    status: 'ongoing',
    published: false,
    deleted: false,
    // The ONLY holder of HIDDEN_ONLY_GENRE. Since it is unpublished,
    // `genres: 'horror'` has no visible match — the "combined filters yielding
    // 0" fixture, and proof that a genre no visible title carries is not
    // offered as a filter by `facets(onlyUsed: true)`.
    genres: [HIDDEN_ONLY_GENRE],
    tags: ['isekai'],
    chapters: [chapter('1.00', 'published')],
  },
  {
    slug: 'cat-manga-soft-deleted',
    title: 'Catalog Title 998 soft deleted',
    status: 'ongoing',
    published: true,
    deleted: true,
    genres: ['Action'],
    tags: ['isekai'],
    chapters: [chapter('1.00', 'published')],
  },
  {
    slug: 'cat-manga-no-chapters',
    title: 'Catalog Title 997 no chapters',
    status: 'ongoing',
    published: true,
    deleted: false,
    genres: ['Drama'],
    tags: ['isekai'],
    chapters: [],
  },
  {
    slug: 'cat-manga-order-probe',
    title: 'Catalog Title 996 order probe',
    status: 'ongoing',
    published: true,
    deleted: false,
    genres: ['Sci-Fi'],
    tags: ['shounen'],
    // `number` says 1 < 2; `reading_order` says the opposite. Behavior 1 orders
    // by `reading_order` (the `ix_chapters_manga_order` hot-path index), so
    // chapter 2 must come first.
    chapters: [chapter('1.00', 'published', 20), chapter('2.00', 'published', 10)],
  },
  {
    slug: 'cat-manga-decimal-draft',
    title: 'Catalog Title 995 decimal draft',
    status: 'ongoing',
    published: true,
    deleted: false,
    genres: ['Romance'],
    tags: ['shounen'],
    chapters: [
      chapter('1.00', 'published'),
      chapter('10.50', 'published'),
      chapter('11.00', 'published'),
      chapter('2.00', 'draft'),
    ],
  },
  {
    slug: 'cat-manga-cap',
    title: 'Catalog Title 994 over the cap',
    status: 'ongoing',
    published: true,
    deleted: false,
    genres: ['Comedy'],
    tags: ['long-running'],
    chapters: Array.from({ length: OVER_CAP_CHAPTERS }, (_, offset) =>
      chapter(`${String(offset + 1).padStart(4, '0')}.00`, 'published'),
    ),
  },
];

/** The manga id the product seed harness would also produce for a slug. */
export const mangaIdFor = (slug: string): string => deterministicUuid('manga', slug);

/**
 * A `MangaSlug` for a fixture string. The id/slug types are BRANDED
 * (shared/types/ids.ts), so a test that writes the slug literally cannot
 * satisfy them without this — and the brand is worth keeping in the tests, since
 * it is the same thing that stops production code from passing a bare string
 * where a slug belongs.
 */
export const asSlug = (slug: string): MangaSlug => slug as MangaSlug;

/**
 * The slug each sort MUST return first, derived from the fixture definition
 * above rather than from whatever the implementation happens to do:
 * - `updatedAt` = day(400 - i)  ⇒ `updated_desc` starts at fixture index 0;
 * - `createdAt` = day(1 + i)    ⇒ `added_desc`   starts at the LAST fixture;
 * - titles are `Catalog Title {30-i} {i padded}` ⇒ `title_asc` starts at the
 *   title with the smallest `{30-i}`, i.e. manga index 30.
 *
 * Stating them here is what keeps the sort assertions from being circular.
 */
export const SORT_ANCHORS = {
  title_asc: 'cat-manga-0030',
  updated_desc: 'cat-manga-0001',
  added_desc: 'cat-manga-cap',
} as const satisfies Record<'title_asc' | 'updated_desc' | 'added_desc', string>;

/** True for a fixture that no public read may ever return. */
export const HIDDEN_SLUGS: readonly string[] = ['cat-manga-unpublished', 'cat-manga-soft-deleted'];

/** Every slug a public catalog read may return. */
export const VISIBLE_SLUGS: readonly string[] = FIXTURE_MANGA.filter(
  (entry) => entry.published && !entry.deleted,
).map((entry) => entry.slug);

/**
 * Writes the fixture corpus. All inserts go through the Drizzle query builder,
 * so every value is a bound parameter — the same discipline the product
 * repositories are held to.
 */
export async function seedCatalogFixtures(db: Db): Promise<void> {
  const genreIds = new Map(
    [...GENRES, HIDDEN_ONLY_GENRE].map((name) => [name, deterministicUuid('genre', name)]),
  );
  const tagIds = new Map(TAGS.map((name) => [name, deterministicUuid('tag', name)]));
  await db.insert(dbSchema.genre).values([...genreIds].map(([name, id]) => ({ id, name })));
  await db.insert(dbSchema.tag).values([...tagIds].map(([name, id]) => ({ id, name })));

  await db.insert(dbSchema.manga).values(
    FIXTURE_MANGA.map((entry, index) => ({
      id: mangaIdFor(entry.slug),
      slug: entry.slug,
      title: entry.title,
      synopsis: `Synthetic fixture ${entry.slug}. Not product content.`,
      status: entry.status,
      readingDirection: 'rtl',
      published: entry.published,
      coverAssetKey: null,
      // `updatedAt` DESCENDS with the fixture order and `createdAt` ASCENDS, so
      // the three whitelisted sorts have three different answers and no sort can
      // silently alias another. `SORT_ANCHORS` below states what each one must
      // return first, so the assertions are not circular.
      updatedAt: day(400 - index),
      createdAt: day(1 + index),
      deletedAt: entry.deleted ? day(500) : null,
    })),
  );

  await db.insert(dbSchema.mangaGenre).values(
    FIXTURE_MANGA.flatMap((entry) =>
      entry.genres.map((name) => ({
        mangaId: mangaIdFor(entry.slug),
        genreId: genreIds.get(name) ?? '',
      })),
    ),
  );
  await db.insert(dbSchema.mangaTag).values(
    FIXTURE_MANGA.flatMap((entry) =>
      entry.tags.map((name) => ({
        mangaId: mangaIdFor(entry.slug),
        tagId: tagIds.get(name) ?? '',
      })),
    ),
  );

  const chapterRows = FIXTURE_MANGA.flatMap((entry) =>
    entry.chapters.map((spec) => ({
      id: deterministicUuid('chapter', `${mangaIdFor(entry.slug)}#${spec.number}`),
      mangaId: mangaIdFor(entry.slug),
      number: spec.number,
      title: spec.title,
      notes: 'Synthetic fixture chapter.',
      status: spec.status,
      publishedAt: spec.status === 'published' ? day(200) : null,
      pageCount: spec.pageCount,
      readingOrder: spec.readingOrder ?? Number.parseInt(spec.number, 10),
    })),
  );
  const BATCH = 500;
  for (let start = 0; start < chapterRows.length; start += BATCH) {
    await db.insert(dbSchema.chapter).values(chapterRows.slice(start, start + BATCH));
  }
}

/**
 * A genre's slug, computed in SQL so a filter can stay ONE statement. It
 * mirrors `normaliseGenreSlug` exactly (lower-case, every run of
 * non-alphanumerics collapsed to `-`, no leading/trailing `-`).
 *
 * The PRODUCT rule, not a second copy of it: `genreSlugSql` is the single
 * definition, so a genre-filtered query cannot silently drift from the shipped
 * predicate.
 *
 * Deliberately unindexed: `genre` is a controlled vocabulary of tens of rows,
 * so the expression is evaluated over the whole table inside the statement.
 * The hot path is still `ix_manga_visible` + `ix_manga_genre_genre_id`.
 */
const genreSlug = genreSlugSql(dbSchema.genre.name);

/** The keyset the repository mints into a cursor token. */
interface Keyset {
  /** The sort column's value: a timestamp as ISO-8601, or the title text. */
  readonly primary: string;
  /** The unique tiebreaker (manga id) — what makes the boundary total. */
  readonly id: string;
}

const encodeKeyset = (keyset: Keyset): string =>
  Buffer.from(JSON.stringify({ v: 1, k: keyset.primary, i: keyset.id }), 'utf8').toString(
    'base64url',
  );

/**
 * Decodes a keyset, REJECTING anything unusable with the same code the
 * repository uses.
 *
 * A repository is the authority on its own cursor payload: a well-formed
 * base64url token that is not a cursor it can read must be a 422
 * (`CATALOG_PAGE_INVALID`), not a 500 from a `JSON.parse` and not a silently
 * ignored page. This mirrors the repository's `decodeCursor`; the double is
 * worthless if it is laxer than the thing it stands in for, because a route
 * that works only against the double is a route that 500s in production.
 */
function decodeKeyset(token: string): Keyset {
  // Explicitly typed: TypeScript only narrows through a call whose FUNCTION
  // type is annotated `() => never` (assertion-call narrowing), not through an
  // inferred one.
  const invalid: () => never = () => {
    throw new AppError('CATALOG_PAGE_INVALID');
  };
  if (token.length === 0 || token.length > CATALOG_CURSOR_MAX_LENGTH) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) invalid();
  const candidate = parsed as { v?: unknown; k?: unknown; i?: unknown };
  if (candidate.v !== 1) invalid();
  if (typeof candidate.k !== 'string' || candidate.k.length === 0) invalid();
  if (typeof candidate.i !== 'string' || candidate.i.length === 0) invalid();
  return { primary: candidate.k, id: candidate.i };
}

/**
 * A keyset value is carried through the cursor as TEXT, so it has to be turned
 * back into the JS type the column expects before it is bound: Drizzle's
 * `timestamptz` encoder calls `toISOString()` on what it is given and a string
 * is not a Date. The two descending sorts read a timestamptz column, the
 * ascending one reads text.
 */
function keysetValue(sort: PgListQuery['sort'], raw: string): string | Date {
  return sort === 'title_asc' ? raw : new Date(raw);
}

/** Reads a row's sort-column value back into the cursor's text form. */
function keysetPrimary(sort: PgListQuery['sort'], raw: unknown): string {
  return sort === 'title_asc' ? String(raw) : new Date(String(raw)).toISOString();
}

export interface PgListQuery {
  cursor?: string;
  limit: number;
  genres: string[];
  status?: MangaStatus;
  sort: 'title_asc' | 'updated_desc' | 'added_desc';
}

/**
 * The ONE statement `MangaRepository.list` issues.
 *
 * Exported so the suite can show the exact SQL and the exact bound parameters
 * as evidence, and so the statement-count assertion is about a real query plan
 * rather than about a mock's call log.
 */
export function buildCatalogListStatement(db: Db, query: PgListQuery) {
  const { limit, genres, status, sort } = query;
  const sortColumn =
    sort === 'title_asc'
      ? dbSchema.manga.title
      : sort === 'added_desc'
        ? dbSchema.manga.createdAt
        : dbSchema.manga.updatedAt;
  const order =
    sort === 'title_asc'
      ? [asc(sortColumn), asc(dbSchema.manga.id)]
      : [desc(sortColumn), asc(dbSchema.manga.id)];

  const keyset = query.cursor === undefined ? undefined : decodeKeyset(query.cursor);
  const cursorClause = (() => {
    if (keyset === undefined) return undefined;
    // (sortCol, id) < (keyset.primary, keyset.id) in the sort's direction,
    // with `id` ASCENDING as the tiebreaker in both directions: an ascending
    // tiebreaker under a descending sort is still a total order, and it is what
    // the ORDER BY above declares, so the two must agree.
    const primary = keysetValue(sort, keyset.primary);
    const afterTiebreak = and(eq(sortColumn, primary), gt(dbSchema.manga.id, keyset.id));
    return sort === 'title_asc'
      ? or(gt(sortColumn, primary), afterTiebreak)
      : or(lt(sortColumn, primary), afterTiebreak);
  })();

  // The latest PUBLISHED chapter, resolved per row inside the same statement.
  //
  // Three single-column scalar subqueries rather than one three-column one:
  // PostgreSQL rejects `(<subquery>).field` unless the subquery is a registered
  // composite, and a scalar subquery may return only one column. They are
  // structurally identical, so the planner resolves them through one subplan —
  // and either way the request is ONE round trip, which is the property
  // the rule asks for. A second statement, or one query per manga, is what
  // the rule forbids.
  //
  // The correlated reference is spelled with `sql.identifier` over names read
  // FROM THE SCHEMA rather than written out. Drizzle qualifies a bare Column
  // reference with whichever table its internal proxy last saw, and a `from
  // "chapter"` inside the same fragment changes that — at which point
  // `${manga.id}` renders as a bare `"id"`, which PostgreSQL resolves against
  // the INNER table and silently matches every chapter to the wrong manga.
  // Reading both names off the schema keeps the reference correct and keeps
  // following a column rename.
  const outerMangaId = sql`${sql.identifier(getTableName(dbSchema.manga))}.${sql.identifier(
    dbSchema.manga.id.name,
  )}`;
  const latestNumber = sql<string | null>`
    (select c.number
       from ${dbSchema.chapter} c
      where c.manga_id = ${outerMangaId}
        and c.status = 'published'
        and c.deleted_at is null
      order by c.reading_order desc, c.id desc
      limit 1)`;
  const latestTitle = sql<string | null>`
    (select c.title
       from ${dbSchema.chapter} c
      where c.manga_id = ${outerMangaId}
        and c.status = 'published'
        and c.deleted_at is null
      order by c.reading_order desc, c.id desc
      limit 1)`;
  const latestPublishedAt = sql<string | null>`
    (select c.published_at
       from ${dbSchema.chapter} c
      where c.manga_id = ${outerMangaId}
        and c.status = 'published'
        and c.deleted_at is null
      order by c.reading_order desc, c.id desc
      limit 1)`;

  // "genre slugs must exist (ignored if not — no error)": if NO requested slug
  // names a genre row, the filter is switched OFF rather than matching nothing.
  // That is what makes an unknown slug inert instead of an empty result.
  const requestedGenreExists = notExists(
    db
      .select({ one: sql`1` })
      .from(dbSchema.genre)
      .where(inArray(genreSlug, genres)),
  );
  const linksToRequestedGenre = exists(
    db
      .select({ one: sql`1` })
      .from(dbSchema.mangaGenre)
      .where(
        and(
          eq(dbSchema.mangaGenre.mangaId, dbSchema.manga.id),
          inArray(
            dbSchema.mangaGenre.genreId,
            db
              .select({ id: dbSchema.genre.id })
              .from(dbSchema.genre)
              .where(inArray(genreSlug, genres)),
          ),
        ),
      ),
  );

  const conditions = [
    eq(dbSchema.manga.published, true),
    isNull(dbSchema.manga.deletedAt),
    ...(status === undefined ? [] : [eq(dbSchema.manga.status, status)]),
    ...(genres.length === 0 ? [] : [or(requestedGenreExists, linksToRequestedGenre)]),
    ...(cursorClause === undefined ? [] : [cursorClause]),
  ];

  return db
    .select({
      id: dbSchema.manga.id,
      slug: dbSchema.manga.slug,
      title: dbSchema.manga.title,
      status: dbSchema.manga.status,
      coverAssetKey: dbSchema.manga.coverAssetKey,
      latestNumber,
      latestTitle,
      latestPublishedAt,
      sortValue: sql<string>`${sortColumn}`,
    })
    .from(dbSchema.manga)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit + 1);
}

/** Media URL for a cover: app-relative, never a storage URL. */
const coverUrl = (assetKey: string | null): string | null =>
  assetKey === null ? null : `/media/${assetKey}`;

/**
 * `MangaRepository` read half, faithful to the port's contract.
 *
 * `list` mints `nextCursor` from the LAST row's keyset when it fetched one row
 * more than asked (the standard over-fetch trick), and null otherwise.
 */
export function createPgMangaRepository(db: Db): Pick<MangaRepository, 'list' | 'bySlug'> {
  return {
    async list(query) {
      const statement = buildCatalogListStatement(db, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit ?? 24,
        genres: query.genres ?? [],
        ...(query.status === undefined ? {} : { status: query.status }),
        sort: query.sort ?? 'updated_desc',
      });
      const rows = await statement;
      const hasMore = rows.length > (query.limit ?? 24);
      const page = hasMore ? rows.slice(0, query.limit ?? 24) : rows;
      const last = page.at(-1);
      return {
        items: page.map((row): MangaSummary => {
          // A raw `sql` projection bypasses Drizzle's column mapping, so the
          // timestamptz arrives as the driver's own text form (the repository
          // owns row → DTO conversion).
          const publishedAt = row.latestPublishedAt;
          return {
            id: row.id as MangaId,
            slug: row.slug as MangaSlug,
            title: row.title,
            status: row.status as MangaStatus,
            coverUrl: coverUrl(row.coverAssetKey),
            latestChapter:
              row.latestNumber === null || publishedAt === null
                ? null
                : {
                    // numeric(8,2) reads back as a STRING by design; the
                    // service narrows it, this port hands over the raw form.
                    number: row.latestNumber as unknown as number,
                    title: row.latestTitle,
                    publishedAt: new Date(publishedAt).toISOString(),
                  },
          };
        }),
        nextCursor:
          hasMore && last !== undefined
            ? encodeKeyset({
                primary: keysetPrimary(query.sort ?? 'updated_desc', last.sortValue),
                id: String(last.id),
              })
            : null,
      };
    },

    /**
     * The visibility rule (features/manga owns it; the port applies it):
     * `published ∧ ¬deleted`, with an admin caller allowed to see hidden rows.
     * Only the fields the catalog service consumes are filled — the full
     * `MangaDetail` shape is another suite's business.
     */
    async bySlug(slug, caller) {
      const admin = caller?.role === 'admin';
      const [row] = await db
        .select({
          id: dbSchema.manga.id,
          slug: dbSchema.manga.slug,
          title: dbSchema.manga.title,
          status: dbSchema.manga.status,
          published: dbSchema.manga.published,
          deletedAt: dbSchema.manga.deletedAt,
          coverAssetKey: dbSchema.manga.coverAssetKey,
          createdAt: dbSchema.manga.createdAt,
        })
        .from(dbSchema.manga)
        .where(eq(dbSchema.manga.slug, slug))
        .limit(1);
      if (row === undefined) return null;
      if (!admin && (!row.published || row.deletedAt !== null)) return null;
      return {
        id: row.id as MangaId,
        slug: row.slug as MangaSlug,
        title: row.title,
        status: row.status as MangaStatus,
        coverUrl: coverUrl(row.coverAssetKey),
        latestChapter: null,
        aliases: [],
        synopsis: '',
        readingDirection: 'rtl',
        chapterCount: 0,
        firstChapter: null,
        creators: [],
        genres: [],
        tags: [],
        createdAt: row.createdAt.toISOString(),
      } satisfies MangaDetail;
    },
  };
}

/**
 * `ChapterRepository.listByManga`, faithful to the port's contract:
 * ordered by `reading_order` (the `ix_chapters_manga_order` hot-path index),
 * drafts admin-only.
 */
export function createPgChapterRepository(db: Db): Pick<ChapterRepository, 'listByManga'> {
  return {
    async listByManga(mangaId, caller) {
      const admin = caller?.role === 'admin';
      const rows = await db
        .select({
          id: dbSchema.chapter.id,
          number: dbSchema.chapter.number,
          title: dbSchema.chapter.title,
          pageCount: dbSchema.chapter.pageCount,
          publishedAt: dbSchema.chapter.publishedAt,
        })
        .from(dbSchema.chapter)
        .where(
          and(
            eq(dbSchema.chapter.mangaId, mangaId),
            isNull(dbSchema.chapter.deletedAt),
            ...(admin ? [] : [eq(dbSchema.chapter.status, 'published')]),
          ),
        )
        .orderBy(asc(dbSchema.chapter.readingOrder), asc(dbSchema.chapter.id));
      return rows.map((row): ChapterSummary => ({
        id: row.id as ChapterId,
        // exact numeric: a STRING here, narrowed by the service.
        number: row.number as unknown as number,
        title: row.title,
        pageCount: row.pageCount,
        publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
      }));
    },
  };
}

/**
 * `CatalogVocabularyPort.listVocabulary` — re-exported from the PRODUCT
 * repository, not re-implemented here.
 *
 * Re-exporting rather than re-implementing keeps the facets endpoint honest:
 * a local copy would be green in integration while production had no
 * implementation at all, so pointing at the real factory is what makes the
 * facets assertions a statement about shipped code.
 */
import { createGenreTagVocabularyPort } from '../../../src/server/db/repositories/vocabulary.repository';

export { createGenreTagVocabularyPort as createPgVocabularyPort };

/** Everything a suite needs to drive the real service over real rows. */
export interface PgCatalogHarness {
  readonly db: Db;
  readonly probe: SqlProbe;
  readonly service: ReturnType<typeof import('../../../src/features/catalog').createCatalogService>;
  readonly manga: Pick<MangaRepository, 'list' | 'bySlug'>;
  readonly chapters: Pick<ChapterRepository, 'listByManga'>;
  readonly vocabulary: CatalogVocabularyPort;
}

export async function createPgCatalogHarness(open: OpenDatabase): Promise<PgCatalogHarness> {
  await seedCatalogFixtures(open.db);
  const manga = createPgMangaRepository(open.db);
  const chapters = createPgChapterRepository(open.db);
  const vocabulary = createGenreTagVocabularyPort(open.db);
  const { createCatalogService } = await import('../../../src/features/catalog');
  return {
    db: open.db,
    probe: open.probe,
    manga,
    chapters,
    vocabulary,
    service: createCatalogService({
      manga: manga as MangaRepository,
      chapters: chapters as ChapterRepository,
      progress: { latestForManga: async () => null },
      vocabulary,
    }),
  };
}

/** Re-exported so a suite can build a caller without importing two modules. */
export const CALLERS = {
  anon: null,
  reader: { userId: 'reader-1' as never, role: 'reader' },
  admin: { userId: 'admin-1' as never, role: 'admin' },
} satisfies Record<string, CallerContext>;

/**
 * A `Logger` that discards everything.
 *
 * The suites assert RESPONSE behaviour, and the real pino facade needs a
 * complete `Env` (its redactor reads `storage.accessKeyId`, among others) —
 * standing up a full environment would couple these tests to
 * an unrelated module's variable inventory. The route handlers take the
 * `Logger` as a dependency precisely so it can be replaced; what is being
 * tested here is the status code, the envelope and the headers, none of which
 * the sink touches. `tests/unit/logger.test.ts` covers the facade.
 */
export const silentLogger = (): Logger => SILENT_LOGGER;
