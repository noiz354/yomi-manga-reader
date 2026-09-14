/**
 * The `LibraryRepository` and `BookmarkRepository` ports against PostgreSQL.
 * `list()` is ONE statement (two LATERAL joins plus a correlated unread-count
 * subquery), so a page never fans out into N+1. `lastRead` is derived from
 * `reading_progress`, never the unwritten `library_entry.last_read_at`, and
 * ownership is structural: `userId` is a bind parameter of every statement.
 * Idempotence is the primary key's job, not a caller-side pre-check.
 */
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import type {
  BookmarkRepository,
  LibraryRepository,
} from '../../../features/library';
import { AppError } from '../../../shared/contracts/errors';
import type {
  Bookmark,
  LibraryEntry,
  LibrarySort,
  MangaStatus,
  MangaSummary,
} from '../../../shared/contracts';
import type { BookmarkId, ChapterId, MangaId, MangaSlug, UserId } from '../../../shared/types';
import { mediaUrlFor } from '../../../shared/storage-keys';
import type { Db } from '../client';
import { bookmark, chapter, libraryEntry, manga, readingProgress } from '../schema';
import { chapterVisibleWhere } from './manga.repository';

/** The page size when the caller names none. */
export const LIBRARY_DEFAULT_LIMIT = 24;

/** The hard page cap: `GET /api/v1/library` allows `limit ≤ 48`. */
export const LIBRARY_MAX_LIMIT = 48;

/**
 * Every sort a cursor can be minted for, on either repository.
 *
 * The bookmark list has exactly one order (newest first), and naming it here
 * rather than hard-coding it inside the query gives the `s` guard something to
 * reject against: a library cursor handed to `BookmarkRepository` (or the
 * reverse) is a different `s` and is refused instead of compared against a
 * column it was never minted for.
 */
type CursorSort = LibrarySort | 'newest_desc';

const CURSOR_SORTS: readonly CursorSort[] = [
  'last_read_desc',
  'added_desc',
  'title_asc',
  'newest_desc',
];

/** The cursor payload. `v` is the format version, bumped if the shape changes. */
interface PageCursor {
  readonly v: 1;
  /** The sort the cursor was minted for — a cursor is not portable across sorts. */
  readonly s: CursorSort;
  /** The sort key of the previous page's last row; `null` = the null bucket. */
  readonly k: string | null;
  /** That row's id — the total-order tiebreaker. */
  readonly i: string;
}

/** The one order `BookmarkRepository.list` uses (newest first). */
const BOOKMARK_SORT: CursorSort = 'newest_desc';

/**
 * Encodes a cursor: base64url, so it survives a query string unescaped.
 *
 * Opaque to callers and NOT a security token — it carries no authority, so a
 * forged cursor cannot widen a WHERE. {@link decodeCursor} validates the shape
 * before any value is bound, which is what makes a hostile cursor data rather
 * than SQL.
 */
function encodeCursor(sort: CursorSort, key: string | null, id: string): string {
  const payload: PageCursor = { v: 1, s: sort, k: key, i: id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or throws `CATALOG_PAGE_INVALID` (422).
 *
 * Rejects rather than repairs anything unrecognised: a wrong version, a sort it
 * was not minted for, a non-string key, an empty field, or a `null` key for a
 * sort whose key column is NOT NULL. Repairing any of those would answer a
 * question the caller did not ask — a silently wrong page is worse than a 422.
 */
function decodeCursor(cursor: string, sort: CursorSort, nullableKey: boolean): PageCursor {
  const invalid = (): never => {
    throw new AppError('CATALOG_PAGE_INVALID');
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) return invalid();
  const candidate = parsed as Partial<PageCursor>;
  if (candidate.v !== 1 || candidate.s !== sort) return invalid();
  if (!CURSOR_SORTS.includes(candidate.s)) return invalid();
  if (typeof candidate.i !== 'string' || candidate.i === '') return invalid();
  if (candidate.k === null) {
    // Only a NULLABLE sort key may be null; for the others a null key would make
    // the keyset comparison UNKNOWN and the page would silently return nothing.
    if (nullableKey) return { v: 1, s: candidate.s, k: null, i: candidate.i };
    return invalid();
  }
  if (typeof candidate.k !== 'string' || candidate.k === '') return invalid();
  return { v: 1, s: candidate.s, k: candidate.k, i: candidate.i };
}

/** The (sort key, id) pair a keyset predicate binds. */
function cursorArgs(
  cursor: string,
  sort: CursorSort,
  nullableKey: boolean,
): [string | null, string] {
  const decoded = decodeCursor(cursor, sort, nullableKey);
  return [decoded.k, decoded.i];
}

/**
 * The same pair for a sort whose key column is NOT NULL.
 *
 * {@link decodeCursor} already refuses a `null` key for those sorts, so this
 * branch is unreachable — it exists so the keyset argument's TYPE matches the
 * predicate's `string` parameter without a non-null assertion, and so a future
 * relaxation of the decoder cannot quietly start comparing against NULL.
 */
function requiredCursorArgs(cursor: string, sort: CursorSort): [string, string] {
  const [key, id] = cursorArgs(cursor, sort, false);
  if (key === null) throw new AppError('CATALOG_PAGE_INVALID');
  return [key, id];
}

/** Clamps `limit` into `[1, 48]`. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LIBRARY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), LIBRARY_MAX_LIMIT);
}

/**
 * A postgres.js unique violation carries `23505` and, when the driver reports it,
 * the constraint name. A missing name still counts: the statement can only have
 * violated one index.
 *
 * The driver's error is looked up through the `cause` chain because Drizzle
 * wraps every failure in its own `DrizzleQueryError` and keeps the original in
 * `cause` — checking only the outermost object would classify the duplicate
 * bookmark as an unknown error and lose the typed 409.
 */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current: unknown = error, depth = 0; current !== null && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false;
    const candidate = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (candidate.code === '23505') {
      return candidate.constraint_name === undefined || candidate.constraint_name === constraint;
    }
    current = candidate.cause;
  }
  return false;
}

/** Drizzle row types stop here; only DTOs leave this module (client.ts, D1/D2). */

/** One row of the library page statement, after the two LATERAL joins. */
interface LibraryRow {
  addedAt: Date;
  /** `library_entry.last_read_at` — the SORT key only. */
  sortLastReadAt: Date | null;
  id: string;
  slug: string;
  title: string;
  status: string;
  coverAssetKey: string | null;
  published: boolean;
  deletedAt: Date | null;
  /** The LATERAL "last position" row; all three are null when there is none. */
  progressChapterNumber: string | null;
  progressPageNumber: number | null;
  progressAt: Date | null;
  /** The LATERAL "latest chapter" row; `latestNumber` is the presence marker. */
  latestNumber: string | null;
  latestTitle: string | null;
  latestPublishedAt: Date | null;
  latestCreatedAt: Date | null;
  /** The correlated badge subquery; `count(*)::int`, so never a bigint string. */
  unreadChapterCount: number;
}

/** One row of the bookmark statement, after the two LEFT JOINs. */
interface BookmarkRow {
  id: string;
  pageNumber: number | null;
  note: string;
  createdAt: Date;
  /** `bookmark.chapter_id` — null once the chapter row is gone (FK SET NULL). */
  chapterId: string | null;
  chapterNumber: string | null;
  mangaSlug: string | null;
  mangaTitle: string | null;
}

/**
 * The shelf card cover URL: a call into the single rule in
 * `shared/storage-keys.ts` (`mediaUrlFor`). JPEG variant, `null` passthrough.
 */
function coverUrlOf(coverAssetKey: string | null): string | null {
  return coverAssetKey === null ? null : mediaUrlFor(coverAssetKey, 'jpeg');
}

/**
 * `numeric(8,2)` arrives as a STRING; every DTO here says `number`
 * (`columns.ts` `exactNumeric`). Converted once, deliberately, at this boundary.
 *
 * The `Number.isFinite` guard is deliberate: a non-numeric chapter number would
 * otherwise become `NaN`, which survives serialization into the shelf UI and
 * into any comparison the client makes.
 */
function toNumber(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asMangaStatus(value: string): MangaStatus {
  return value === 'completed' || value === 'hiatus' ? value : 'ongoing';
}

/** timestamptz → ISO-8601 UTC. */
function asIso(value: Date): string {
  return value.toISOString();
}

/**
 * `MangaSummary.latestChapter` for one library row.
 *
 * `null` is the ABSENCE of a LATERAL row — a manga with no published, undeleted
 * chapter — the same case `manga.repository.ts`'s zero-chapter path returns, so
 * the two agree by construction.
 *
 * `publishedAt` is non-null in the DTO. A published chapter always carries the
 * stamp (`setPublished` writes it), so the `createdAt` fallback is defensive
 * only — a row inserted by raw SQL with `status='published'` and no stamp would
 * otherwise make the DTO unserialisable.
 */
function latestChapterOf(row: LibraryRow): MangaSummary['latestChapter'] {
  if (row.latestNumber === null) return null;
  return {
    number: toNumber(row.latestNumber),
    title: row.latestTitle,
    publishedAt: asIso(row.latestPublishedAt ?? row.latestCreatedAt ?? row.addedAt),
  };
}

/**
 * `LibraryEntry.lastRead`, derived from `reading_progress`.
 *
 * `null` is the absence of a progress row for this user and this manga, which is
 * a real state: a title added and never opened. `pageNumber` is NOT NULL on a
 * progress row, so its null-ness is only a guard, and the chapter number is
 * `chapter.number` (NOT NULL for the same reason).
 */
function lastReadOf(row: LibraryRow): LibraryEntry['lastRead'] {
  if (row.progressAt === null || row.progressPageNumber === null) return null;
  return {
    chapterNumber: toNumber(row.progressChapterNumber ?? 0),
    pageNumber: row.progressPageNumber,
    at: asIso(row.progressAt),
  };
}

/**
 * The `unavailable` flag: the title went unpublished or was soft-deleted, but
 * the ENTRY is still returned.
 *
 * The library is private, so hiding a title the reader added would silently
 * destroy their shelf; reading it 404s instead. A HARD-deleted manga cascades
 * the `library_entry` row away and therefore never reaches this function — the
 * inner join is the "deleted manga excluded" leg.
 */
function isUnavailable(row: LibraryRow): boolean {
  return !row.published || row.deletedAt !== null;
}

function toLibraryEntry(row: LibraryRow): LibraryEntry {
  return {
    manga: {
      id: row.id as MangaId,
      slug: row.slug as MangaSlug,
      title: row.title,
      status: asMangaStatus(row.status),
      coverUrl: coverUrlOf(row.coverAssetKey),
      latestChapter: latestChapterOf(row),
    },
    addedAt: asIso(row.addedAt),
    lastRead: lastReadOf(row),
    unreadChapterCount: row.unreadChapterCount,
    unavailable: isUnavailable(row),
  };
}

/**
 * `Bookmark.chapter`, or `null` when the chapter row is gone.
 *
 * `bookmark.chapter_id` is `ON DELETE SET NULL`, so a purged chapter leaves the
 * bookmark RETAINED and jump-disabled. The manga columns arrive null on the
 * same path and are treated as the same state rather than as a partial chapter.
 */
function bookmarkChapterOf(row: BookmarkRow): Bookmark['chapter'] {
  if (row.chapterId === null) return null;
  if (row.chapterNumber === null || row.mangaSlug === null || row.mangaTitle === null) return null;
  return {
    id: row.chapterId,
    // `numeric(8,2)` read back as a number, never as a string.
    number: toNumber(row.chapterNumber),
    mangaSlug: row.mangaSlug,
    mangaTitle: row.mangaTitle,
  };
}

function toBookmark(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    chapter: bookmarkChapterOf(row),
    pageNumber: row.pageNumber,
    // Plain text, never markup: the CHECK `bookmark_note_len` caps it at 280
    // and this module never renders it.
    note: row.note,
    createdAt: asIso(row.createdAt),
  };
}

/** One sort's whole definition, so none of the three can change in isolation. */
interface LibrarySortSpec {
  readonly index: string;
  /** True when the key column is NULLABLE, so the cursor key may be `null`. */
  readonly nullableKey: boolean;
  readonly orderBy: [SQL, SQL];
  readonly after: (key: string | null, id: string) => SQL;
  readonly keyOf: (row: LibraryRow) => string | null;
}

/**
 * The `list()` query, with `sort` OPTIONAL.
 *
 * The port declares `sort` as required (the service resolves the default before
 * it calls), but a repository that indexed `LIBRARY_SORTS[query.sort]` on that
 * promise would throw a bare `TypeError` — 500 — for a caller that skipped the
 * service. The optional field plus {@link resolveLibrarySort} makes the default
 * total.
 */
interface LibraryQuery {
  cursor?: string;
  limit?: number;
  sort?: LibrarySort;
}

/**
 * The three library sorts.
 *
 * `last_read_desc` is the only one with a decision to make: `NULLS LAST` is
 * written out because Postgres defaults `DESC` to `NULLS FIRST`, and the keyset
 * predicate has TWO branches because a row comparison against a NULL component
 * is UNKNOWN rather than false. The other
 * two sort on NOT NULL columns, so their predicates are the catalog's single row
 * comparison unchanged.
 *
 * `manga_id` is the tiebreaker in all three, exactly as the catalog does, because
 * none of the three keys is unique; the direction follows the primary sort
 * (descending for the two time sorts, ascending for the title sort) so the
 * traversal is one consistent order.
 */
const LIBRARY_SORTS: Record<LibrarySort, LibrarySortSpec> = {
  last_read_desc: {
    index: 'ix_library_user_lastread',
    nullableKey: true,
    orderBy: [sql`${libraryEntry.lastReadAt} desc nulls last`, desc(libraryEntry.mangaId)],
    // The NULL bucket is a real, NON-EMPTY part of this order, so the predicate
    // has to name it explicitly — it is the part a plain row comparison cannot
    // express, because `(NULL, id) < (k, i)` evaluates to UNKNOWN and silently
    // matches nothing.
    //
    //   anchor has a key : the successors are the non-null keys that compare
    //                      LESS, PLUS every null-key row (they all sort after
    //                      every non-null row, so the whole bucket is next).
    //   anchor is null   : the anchor is already inside the bucket, so the
    //                      successors are the rest of it, by `manga_id DESC`.
    //
    // Getting only the first branch is the bug this two-branch form exists to
    // prevent: a reader whose page ended on a read title would get an EMPTY next
    // page and never see the titles they added but never opened.
    after: (key, id) =>
      key === null
        ? sql`${libraryEntry.lastReadAt} is null and ${libraryEntry.mangaId} < ${id}::uuid`
        : sql`((${libraryEntry.lastReadAt}, ${libraryEntry.mangaId}) < (${key}::timestamptz, ${id}::uuid)
             or ${libraryEntry.lastReadAt} is null)`,
    keyOf: (row) => row.sortLastReadAt?.toISOString() ?? null,
  },
  added_desc: {
    // No `(user_id, added_at)` index exists.
    index: 'library_entry PK (user_id, manga_id) prefix + sort',
    nullableKey: false,
    orderBy: [desc(libraryEntry.addedAt), desc(libraryEntry.mangaId)],
    after: (key, id) =>
      sql`(${libraryEntry.addedAt}, ${libraryEntry.mangaId}) < (${key}::timestamptz, ${id}::uuid)`,
    keyOf: (row) => row.addedAt.toISOString(),
  },
  title_asc: {
    // `ix_manga_title` is on `manga(title)` and cannot drive a shelf scoped to
    // one user.
    index: 'library_entry PK (user_id, manga_id) prefix + sort',
    nullableKey: false,
    orderBy: [sql`${manga.title} asc`, sql`${libraryEntry.mangaId} asc`],
    after: (key, id) =>
      sql`(${manga.title}, ${libraryEntry.mangaId}) > (${key}::text, ${id}::uuid)`,
    keyOf: (row) => row.title,
  },
};

/** The default sort: "last read first". */
const DEFAULT_LIBRARY_SORT: LibrarySort = 'last_read_desc';

/**
 * The sort a query asks for; an unknown value falls back to the default rather
 * than reaching the ORDER BY as a name. The fallback is the SERVICE's job
 * (catalog.service.ts rejects a bad sort with `CATALOG_PAGE_INVALID`); this is
 * the second line of defence for a caller that skipped it.
 */
function resolveLibrarySort(sort: LibrarySort | undefined): LibrarySort {
  return sort !== undefined && Object.hasOwn(LIBRARY_SORTS, sort) ? sort : DEFAULT_LIBRARY_SORT;
}

/**
 * The unread badge, as ONE correlated scalar subquery.
 *
 * Every interpolated fragment is a COLUMN reference or the output of
 * {@link chapterVisibleWhere}, so the statement is fully parameterised and no
 * runtime value is ever concatenated into SQL text.
 *
 * Why a scalar subquery and not a join: a join over `chapter` would multiply one
 * library row by its chapter count, which breaks both the LIMIT semantics of
 * keyset pagination and the 1:1 row ↔ `LibraryEntry` mapping. Why `not exists`
 * rather than a second count: completion is per (user, chapter), so "published
 * chapters minus completed ones" is a per-row predicate, not a subtraction of
 * two aggregates — and a subtraction could go negative if a completion referred
 * to a chapter that has since been deleted, which would then render as a
 * negative badge.
 */
function unreadChapterCountSql(): SQL<number> {
  return sql<number>`(
    select count(*)::int
    from ${chapter}
    where ${chapter.mangaId} = ${libraryEntry.mangaId}
      and ${chapterVisibleWhere(false)}
      and not exists (
        select 1
        from ${readingProgress}
        where ${readingProgress.userId} = ${libraryEntry.userId}
          and ${readingProgress.chapterId} = ${chapter.id}
          and ${readingProgress.completed} = true
      )
  )`;
}

/**
 * The caller's most recent position in this manga, as a one-row LATERAL.
 *
 * Ordered by `reading_progress.updated_at` because that is the SERVER stamp, so
 * "most recent" cannot be a client value; `chapter_id` is the tiebreaker because
 * two rows can share a stamp.
 *
 * `readingProgress` is joined to `chapter` because the DTO names a chapter
 * NUMBER, not an id, and `chapter.manga_id` is what correlates the subquery to
 * this library row. The chapter-side visibility rule is deliberately absent.
 */
function lastReadLateral(db: Db, userId: UserId) {
  return db
    .select({
      chapterNumber: chapter.number,
      pageNumber: readingProgress.pageNumber,
      at: readingProgress.updatedAt,
    })
    .from(readingProgress)
    .innerJoin(chapter, eq(chapter.id, readingProgress.chapterId))
    .where(
      and(
        // The caller's own rows only. `userId` came from the session caller;
        // there is no other user in this statement.
        eq(readingProgress.userId, userId),
        eq(chapter.mangaId, libraryEntry.mangaId),
      ),
    )
    .orderBy(desc(readingProgress.updatedAt), desc(readingProgress.chapterId))
    .limit(1);
}

/**
 * The latest published chapter of this manga, as a one-row LATERAL.
 *
 * This is the SAME statement shape `manga.repository.ts` runs for its page-wide
 * `latestChapters` batch — `DISTINCT ON (manga_id)` ordered by
 * `manga_id, reading_order DESC` — the only difference being the correlation on
 * `chapter.manga_id = library_entry.manga_id` that makes it LATERAL instead of a
 * second round trip. Re-deriving the rule (published, undeleted, highest reading
 * order) is therefore not possible here: the visibility clause is IMPORTED.
 */
function latestChapterLateral(db: Db) {
  return db
    .selectDistinctOn([chapter.mangaId], {
      number: chapter.number,
      title: chapter.title,
      publishedAt: chapter.publishedAt,
      createdAt: chapter.createdAt,
    })
    .from(chapter)
    .where(and(eq(chapter.mangaId, libraryEntry.mangaId), chapterVisibleWhere(false)))
    .orderBy(chapter.mangaId, desc(chapter.readingOrder))
    .limit(1);
}

/**
 * Builds the Drizzle `LibraryRepository`.
 *
 * @param db the application's handle from `createDb(env)` — the only place a
 *   connection is ever needed (dependency rule D2).
 */
export function createLibraryRepository(db: Db): LibraryRepository {
  /**
   * The ONE page statement: a PK-keyset-scoped slice of the caller's shelf with
   * every derived field already in the projection.
   *
   * The inner join on `manga` is the "deleted manga excluded" leg (a hard delete
   * cascades `library_entry` away, and an inner join makes a missing title a
   * non-row rather than a card of nulls). A soft-deleted or unpublished title
   * still joins, because the entry is RETAINED and carries `unavailable: true`.
   *
   * The LIMIT is `limit + 1`: one row of lookahead is how this function learns
   * there is a next page without a second COUNT.
   */
  function libraryListSelect(userId: UserId, query: LibraryQuery) {
    const sort = resolveLibrarySort(query.sort);
    const clauses = [
      eq(libraryEntry.userId, userId),
      query.cursor === undefined
        ? undefined
        : LIBRARY_SORTS[sort].after(
            ...cursorArgs(query.cursor, sort, LIBRARY_SORTS[sort].nullableKey),
          ),
    ].filter((clause): clause is SQL => clause !== undefined);
    // Built once, referenced three times each: the projection, the LATERAL join,
    // and nothing else. Drizzle needs the `.as()` to hand `leftJoinLateral` a
    // Subquery; the alias is a SQL identifier, not a value.
    const lastRead = lastReadLateral(db, userId).as('last_read');
    const latest = latestChapterLateral(db).as('latest_chapter');
    return db
      .select({
        addedAt: libraryEntry.addedAt,
        // Projected for the cursor key alone — the payload never reads it.
        sortLastReadAt: libraryEntry.lastReadAt,
        id: manga.id,
        slug: manga.slug,
        title: manga.title,
        status: manga.status,
        coverAssetKey: manga.coverAssetKey,
        published: manga.published,
        deletedAt: manga.deletedAt,
        progressChapterNumber: lastRead.chapterNumber,
        progressPageNumber: lastRead.pageNumber,
        progressAt: lastRead.at,
        latestNumber: latest.number,
        latestTitle: latest.title,
        latestPublishedAt: latest.publishedAt,
        latestCreatedAt: latest.createdAt,
        unreadChapterCount: unreadChapterCountSql(),
      })
      .from(libraryEntry)
      .innerJoin(manga, eq(manga.id, libraryEntry.mangaId))
      .leftJoinLateral(lastRead, sql`true`)
      .leftJoinLateral(latest, sql`true`)
      .where(and(...clauses))
      .orderBy(...LIBRARY_SORTS[sort].orderBy)
      .limit(resolveLimit(query.limit) + 1);
  }

  return {
    async add(userId: UserId, mangaId: MangaId): Promise<void> {
      // A double-add is a no-op, not a 409. `ON CONFLICT` on the PK makes that
      // true atomically.
      await db
        .insert(libraryEntry)
        .values({ userId, mangaId })
        .onConflictDoNothing({ target: [libraryEntry.userId, libraryEntry.mangaId] });
    },

    async remove(userId: UserId, mangaId: MangaId): Promise<void> {
      // A no-op when absent (the route answers 204 either way). The owner is in
      // the WHERE, so one reader's shelf can never be edited through another's
      // id.
      await db
        .delete(libraryEntry)
        .where(and(eq(libraryEntry.userId, userId), eq(libraryEntry.mangaId, mangaId)));
    },

    async has(userId: UserId, mangaId: MangaId): Promise<boolean> {
      // A single PK seek. Not an existence COUNT, so PostgreSQL stops at the
      // first row it finds.
      const rows = await db
        .select({ userId: libraryEntry.userId })
        .from(libraryEntry)
        .where(and(eq(libraryEntry.userId, userId), eq(libraryEntry.mangaId, mangaId)))
        .limit(1);
      return rows.length > 0;
    },

    async list(
      userId: UserId,
      query: { cursor?: string; limit?: number; sort: LibrarySort },
    ): Promise<{ items: LibraryEntry[]; nextCursor: string | null }> {
      const sort = resolveLibrarySort(query.sort);
      const limit = resolveLimit(query.limit);
      const rows = (await libraryListSelect(userId, query)) as LibraryRow[];
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toLibraryEntry),
        // A page that is NOT over-full has no successor, so `nextCursor` is null
        // rather than a cursor that would fetch an empty page.
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor(sort, LIBRARY_SORTS[sort].keyOf(last), last.id)
            : null,
      };
    },

    async countAll(): Promise<number> {
      // A stat over the table as it is, so it counts every row; the admin LIST
      // is where a filtered view lives.
      const [row] = await db.select({ total: count() }).from(libraryEntry);
      return Number(row?.total ?? 0);
    },
  };
}

/** The columns a bookmark-shaped read projects, with the two resolution joins. */
const BOOKMARK_COLUMNS = {
  id: bookmark.id,
  pageNumber: bookmark.pageNumber,
  note: bookmark.note,
  createdAt: bookmark.createdAt,
  chapterId: chapter.id,
  chapterNumber: chapter.number,
  mangaSlug: manga.slug,
  mangaTitle: manga.title,
};

/** `created_at` is NOT NULL, so this key is never null and the predicate is one row comparison. */
function bookmarkAfter(key: string, id: string): SQL {
  return sql`(${bookmark.createdAt}, ${bookmark.id}) < (${key}::timestamptz, ${id}::uuid)`;
}

/**
 * Builds the Drizzle `BookmarkRepository`.
 *
 * @param db the application's handle from `createDb(env)` (dependency rule D2).
 */
export function createBookmarkRepository(db: Db): BookmarkRepository {
  /**
   * The bookmark page statement: newest first, chapter resolved.
   *
   * BOTH joins are LEFT: `bookmark.chapter_id` is `ON DELETE SET NULL` and the
   * chapter's own manga row is soft-deleted rather than removed, so an inner
   * join would silently DROP retained bookmarks instead of rendering them
   * `chapter: null`. The visibility rule is deliberately NOT applied: a bookmark
   * on a title the reader can no longer open is still theirs, and the DTO's
   * `chapter: null` is how the UI disables the jump.
   */
  function bookmarkListSelect(userId: UserId, query: { cursor?: string; limit?: number }) {
    const clauses = [
      eq(bookmark.userId, userId),
      query.cursor === undefined
        ? undefined
        : bookmarkAfter(...requiredCursorArgs(query.cursor, BOOKMARK_SORT)),
    ].filter((clause): clause is SQL => clause !== undefined);
    return db
      .select({ ...BOOKMARK_COLUMNS })
      .from(bookmark)
      .leftJoin(chapter, eq(chapter.id, bookmark.chapterId))
      .leftJoin(manga, eq(manga.id, chapter.mangaId))
      .where(and(...clauses))
      .orderBy(desc(bookmark.createdAt), desc(bookmark.id))
      .limit(resolveLimit(query.limit) + 1);
  }

  return {
    async create(input: {
      userId: UserId;
      chapterId: ChapterId;
      pageNumber: number | null;
      note: string;
    }): Promise<Bookmark> {
      try {
        // ONE transaction, because the create is an INSERT plus a RESOLVE: the
        // inserted row carries no chapter number, slug or title, and PostgreSQL
        // cannot return another table's columns from `RETURNING`. Inside a
        // transaction the resolve sees the same snapshot as the insert, so a
        // chapter deleted by a concurrent hard delete cannot make the second
        // statement miss the row it just wrote.
        return await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(bookmark)
            .values({
              userId: input.userId,
              chapterId: input.chapterId,
              // `null` = "chapter start", a valid, repeatable mark: NULLs stay
              // distinct in `ix_bookmarks_user_chapter_page`, so only a NAMED
              // page can collide.
              pageNumber: input.pageNumber,
              // The CHECK `bookmark_note_len` enforces ≤ 280 at the database;
              // this module never renders or escapes it.
              note: input.note,
            })
            .returning({ id: bookmark.id });
          if (inserted === undefined) {
            // Unreachable: a successful INSERT ... RETURNING always yields the
            // row. Thrown rather than returning a half-built DTO, because a
            // Bookmark with no `id` is not a Bookmark.
            throw new AppError('INTERNAL_ERROR');
          }
          const [row] = await tx
            .select({ ...BOOKMARK_COLUMNS })
            .from(bookmark)
            .leftJoin(chapter, eq(chapter.id, bookmark.chapterId))
            .leftJoin(manga, eq(manga.id, chapter.mangaId))
            .where(eq(bookmark.id, inserted.id));
          if (row === undefined) throw new AppError('INTERNAL_ERROR');
          return toBookmark(row);
        });
      } catch (error) {
        // `ix_bookmarks_user_chapter_page` is the duplicate detector, and the
        // translation is the port's documented 409. The driver error stays as
        // `cause`.
        if (isUniqueViolation(error, 'ix_bookmarks_user_chapter_page')) {
          throw new AppError('LIBRARY_BOOKMARK_EXISTS');
        }
        throw error;
      }
    },

    async list(
      userId: UserId,
      query: { cursor?: string; limit?: number },
    ): Promise<{ items: Bookmark[]; nextCursor: string | null }> {
      const limit = resolveLimit(query.limit);
      const rows = (await bookmarkListSelect(userId, query)) as BookmarkRow[];
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toBookmark),
        // `created_at` is NOT NULL, so the key of a real last row is never null.
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeCursor(BOOKMARK_SORT, last.createdAt.toISOString(), last.id)
            : null,
      };
    },

    async delete(userId: UserId, id: BookmarkId): Promise<boolean> {
      // The owner is part of the WHERE, so another user's bookmark can NEVER be
      // deleted through this method: "not yours" and "not there" are the same
      // zero-row result, which is exactly the `false ⇒ 404` the port documents.
      // `RETURNING` is what makes the answer a boolean — an unfiltered delete
      // cannot report ownership after the fact.
      const rows = await db
        .delete(bookmark)
        .where(and(eq(bookmark.id, id), eq(bookmark.userId, userId)))
        .returning({ id: bookmark.id });
      return rows.length > 0;
    },
  };
}
