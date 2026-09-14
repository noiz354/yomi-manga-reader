/**
 * server/db/repositories/manga.repository — the `MangaRepository` port against
 * PostgreSQL; with `chapter.repository.ts`, the only place the catalog's SQL lives.
 * The single visibility rule (`isMangaVisible`) is rendered from the exported
 * clause list, never restated, so a third visibility axis is added in one place.
 * Pagination is keyset: a cursor carries the (sortKey, id) of the previous page's
 * last row, and `id` is in every cursor because no sort key is unique.
 */
import { and, count, desc, eq, exists, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  MANGA_VISIBILITY_CLAUSES,
  type CatalogQuery,
  type MangaRepository,
  type MangaVisibilityClause,
} from '../../../features/manga/manga.repository';
import { AppError } from '../../../shared/contracts/errors';
import type {
  CallerContext,
  ChapterSummary,
  Creator,
  Genre,
  MangaDetail,
  MangaStatus,
  MangaSummary,
  ReadingDirection,
  Tag,
} from '../../../shared/contracts';
import type { MangaId, MangaSlug } from '../../../shared/types';
import { mediaUrlFor } from '../../../shared/storage-keys';
import type { Db } from '../client';
import {
  chapter,
  creator,
  genre,
  manga,
  mangaAlias,
  mangaCreator,
  mangaGenre,
  mangaTag,
  tag,
} from '../schema';

/** The catalog page size when the caller names none. */
export const CATALOG_DEFAULT_LIMIT = 24;

/** The hard page cap: no more than 48. */
export const CATALOG_MAX_LIMIT = 48;

/** The genre filter cap: at most 5 slugs. */
export const CATALOG_MAX_GENRES = 5;

/**
 * The slice of a Drizzle handle a helper needs. A `transaction` handle
 * satisfies it structurally, which is why the write helpers take one and work
 * inside `db.transaction(...)` without a second code path.
 */
type Executor = Pick<
  Db,
  'select' | 'selectDistinctOn' | 'insert' | 'update' | 'delete'
>;

/** A column object, so a table of sort specs can hold columns of mixed types. */
type AnyColumn = Parameters<typeof isNull>[0];

/**
 * Renders one clause of `MANGA_VISIBILITY_CLAUSES` as SQL.
 *
 * `equals === null` becomes `IS NULL`, never `= NULL` (which is never true), so
 * a soft-deleted row cannot leak into the catalog.
 */
function renderVisibilityClause(clause: MangaVisibilityClause): SQL {
  const column: AnyColumn = manga[clause.column];
  return clause.equals === null ? isNull(column) : eq(column, clause.equals);
}

/**
 * The WHERE fragment that applies `isMangaVisible`: `published = true AND
 * deleted_at IS NULL`.
 *
 * Exported because the chapter reads need the same rule — a chapter of a hidden
 * manga is unreadable — and because the gate EXPLAINs and cross-checks it
 * against the predicate.
 */
export function mangaVisibleWhere(): SQL {
  return sql`${sql.join(
    MANGA_VISIBILITY_CLAUSES.map((clause) => sql`${renderVisibilityClause(clause)}`),
    sql` and `,
  )}`;
}

/**
 * The chapter visibility filter, rendered once for the whole persistence layer.
 *
 * - a reader sees published, undeleted chapters;
 * - an admin sees drafts too but never a soft-deleted one.
 *
 * It does NOT include the manga-side rule: a chapter is readable only through
 * its title, so callers that start from a chapter id join `manga` and add
 * {@link mangaReadClauses}; this fragment is only the chapter axis. It is
 * exported because the MangaDetail aggregates below need it and
 * `chapter.repository.ts` must not state it a second time.
 */
export function chapterVisibleWhere(includeDrafts: boolean): SQL {
  return includeDrafts
    ? isNull(chapter.deletedAt)
    : and(isNull(chapter.deletedAt), eq(chapter.status, 'published')) as SQL;
}

/** True when this caller may read drafts. */
export function mayReadDrafts(caller: CallerContext): boolean {
  return caller?.role === 'admin';
}

/**
 * The WHERE clauses a read-by-id applies for a caller: never a soft-deleted row
 * (hidden from everyone, admin included), plus the full visibility rule for
 * everyone who is not an admin (a draft is admin-readable).
 */
export function mangaReadClauses(caller: CallerContext): SQL[] {
  return mayReadDrafts(caller)
    ? [isNull(manga.deletedAt)]
    : [isNull(manga.deletedAt), mangaVisibleWhere()];
}

type CatalogSort = NonNullable<CatalogQuery['sort']>;

/** The cursor payload. `v` is the format version, bumped if the shape changes. */
interface CatalogCursor {
  readonly v: 1;
  /** The sort the cursor was minted for — a cursor is not portable across sorts. */
  readonly s: CatalogSort;
  /** The sort key of the previous page's last row. */
  readonly k: string;
  /** That row's id — the total-order tiebreaker. */
  readonly i: string;
}

/**
 * The three sorts, each with the ORDER BY, the keyset predicate and the index
 * that go together, so a sort cannot be changed in one place and not the
 * others. `title_asc` is ascending and textual; the two time sorts descend and
 * are timestamptz — which is why each predicate carries its own cast.
 */
const SORTS: Record<
  CatalogSort,
  {
    readonly index: string;
    readonly orderBy: [SQL, SQL];
    readonly after: (key: string, id: string) => SQL;
    readonly keyOf: (row: MangaRow) => string;
  }
> = {
  updated_desc: {
    index: 'ix_manga_visible',
    orderBy: [desc(manga.updatedAt), desc(manga.id)],
    after: (key, id) => sql`(${manga.updatedAt}, ${manga.id}) < (${key}::timestamptz, ${id}::uuid)`,
    keyOf: (row) => row.updatedAt.toISOString(),
  },
  added_desc: {
    index: 'ix_manga_created_at',
    orderBy: [desc(manga.createdAt), desc(manga.id)],
    after: (key, id) => sql`(${manga.createdAt}, ${manga.id}) < (${key}::timestamptz, ${id}::uuid)`,
    keyOf: (row) => row.createdAt.toISOString(),
  },
  title_asc: {
    index: 'ix_manga_title',
    orderBy: [sql`${manga.title} asc`, sql`${manga.id} asc`],
    after: (key, id) => sql`(${manga.title}, ${manga.id}) > (${key}::text, ${id}::uuid)`,
    keyOf: (row) => row.title,
  },
};

/** The default sort: "recently updated first". */
const DEFAULT_SORT: CatalogSort = 'updated_desc';

/** The sort a query asks for; anything unrecognised falls back to the default. */
function resolveSort(sort: CatalogSort | undefined): CatalogSort {
  return sort !== undefined && Object.hasOwn(SORTS, sort) ? sort : DEFAULT_SORT;
}

/** Clamps `limit` into `[1, 48]`. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CATALOG_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), CATALOG_MAX_LIMIT);
}

/**
 * Encodes a cursor: base64url so it survives a query string unescaped.
 *
 * Opaque to callers and NOT a security token — it carries no authority.
 * {@link decodeCursor} validates the shape before any value is bound, so a
 * hostile cursor is data, never SQL.
 */
function encodeCursor(sort: CatalogSort, key: string, id: string): string {
  const payload: CatalogCursor = { v: 1, s: sort, k: key, i: id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or throws `CATALOG_PAGE_INVALID` (422).
 *
 * Rejects rather than repairs anything unrecognised — including a cursor minted
 * for another sort, because a `title_asc` key compared against `updated_at`
 * would silently return the wrong page, which is worse than a 422.
 */
function decodeCursor(cursor: string, sort: CatalogSort): CatalogCursor {
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
  const candidate = parsed as Partial<CatalogCursor>;
  if (candidate.v !== 1 || candidate.s !== sort) return invalid();
  if (typeof candidate.k !== 'string' || typeof candidate.i !== 'string') return invalid();
  if (candidate.k === '' || candidate.i === '') return invalid();
  return { v: 1, s: candidate.s, k: candidate.k, i: candidate.i };
}

/** The (sort key, id) pair a keyset predicate binds. */
function cursorArgs(cursor: string, sort: CatalogSort): [string, string] {
  const decoded = decodeCursor(cursor, sort);
  return [decoded.k, decoded.i];
}

/** The scalar columns every manga-shaped read projects. */
const MANGA_COLUMNS = {
  id: manga.id,
  slug: manga.slug,
  title: manga.title,
  status: manga.status,
  synopsis: manga.synopsis,
  readingDirection: manga.readingDirection,
  coverAssetKey: manga.coverAssetKey,
  createdAt: manga.createdAt,
  updatedAt: manga.updatedAt,
};

interface MangaRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  synopsis: string;
  readingDirection: string;
  coverAssetKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The card/detail cover URL, built by the single rule in
 * `shared/storage-keys.ts` (`mediaUrlFor`) — app-relative, never a storage
 * URL.
 *
 * The variant is JPEG, deliberately: a cover is consumed by ONE `<img>`
 * (there is no per-cover `<picture>` ladder), covers are stored WebP + JPEG
 * only, and JPEG decodes everywhere the reader runs. A row with no cover key
 * stays `null`, which the client renders as the placeholder.
 */
function coverUrlOf(coverAssetKey: string | null): string | null {
  return coverAssetKey === null ? null : mediaUrlFor(coverAssetKey, 'jpeg');
}

function asMangaStatus(value: string): MangaStatus {
  return value === 'completed' || value === 'hiatus' ? value : 'ongoing';
}

function asReadingDirection(value: string): ReadingDirection {
  return value === 'ltr' ? 'ltr' : 'rtl';
}

/** `numeric(8,2)` arrives as a string; the DTOs say `number`. */
function asNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

/** timestamptz → ISO-8601 UTC. */
function asIso(value: Date): string {
  return value.toISOString();
}

/** The `latestChapter` shape of `MangaSummary`. */
interface LatestChapter {
  number: number;
  title: string | null;
  publishedAt: string;
}

/**
 * Shapes one latest-chapter row. `null` — the zero-chapter manga case — is the
 * ABSENCE of a row in the batch, not a property of one.
 *
 * `publishedAt` is non-null in the DTO. A published chapter always has the
 * stamp (`setPublished` writes it), so the `createdAt` fallback is defensive
 * only: a row inserted by raw SQL with `status='published'` and no stamp would
 * otherwise make the DTO unserialisable.
 */
function latestOf(row: {
  number: string | number;
  title: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}): LatestChapter {
  return {
    number: asNumber(row.number),
    title: row.title,
    publishedAt: asIso(row.publishedAt ?? row.createdAt),
  };
}

/** The extra collections `MangaDetail` adds to a `MangaSummary`. */
interface DetailExtras {
  aliases: string[];
  genres: Genre[];
  tags: Tag[];
  creators: Creator[];
  chapterCount: number;
  firstChapter: { id: string; number: number } | null;
}

function emptyExtras(): DetailExtras {
  return { aliases: [], genres: [], tags: [], creators: [], chapterCount: 0, firstChapter: null };
}

function toSummary(row: MangaRow, latest: LatestChapter | null): MangaSummary {
  return {
    id: row.id as MangaId,
    slug: row.slug as MangaSlug,
    title: row.title,
    status: asMangaStatus(row.status),
    coverUrl: coverUrlOf(row.coverAssetKey),
    latestChapter: latest,
  };
}

function toDetail(row: MangaRow, latest: LatestChapter | null, extras: DetailExtras): MangaDetail {
  return {
    ...toSummary(row, latest),
    aliases: extras.aliases,
    synopsis: row.synopsis,
    readingDirection: asReadingDirection(row.readingDirection),
    chapterCount: extras.chapterCount,
    firstChapter: extras.firstChapter,
    creators: extras.creators,
    genres: extras.genres,
    tags: extras.tags,
    createdAt: asIso(row.createdAt),
    // `continueReading` is deliberately absent: it is the READER's own position
    // and belongs to ReaderProgressRepository. The contract marks it optional
    // for exactly that reason, and the service that owns both ports fills it in.
  };
}

/**
 * A postgres.js unique violation carries `23505` and, when the driver reports
 * it, the constraint name. A missing name still counts: the statement can only
 * have violated one index.
 *
 * The driver's error is looked up through the chain because Drizzle wraps
 * every failure in its own `DrizzleQueryError` and keeps the original in
 * `cause` — checking only the outermost object would classify every constraint
 * violation as an unknown error and lose the typed 409.
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

/**
 * THE genre-slug rule, as SQL.
 *
 * The public filter carries "genre slugs" (`?genre=action,drama`) while the
 * model gives a genre only a `name` and no slug column. The slug is therefore
 * DERIVED, and it must be derived the same way on both sides of the wire: the
 * service derives it in TypeScript (`normaliseGenreSlug`) and the query derives
 * it again here.
 *
 * Why the derivation lives in SQL rather than being sent as a name: the client
 * sends whatever the facets endpoint gave it, and comparing a slug against a
 * name only works for single-word genres. `Slice of Life` slugifies to
 * `slice-of-life`, and no `lower(name)` equals that — so a name comparison
 * silently matched nothing, the genre predicate was dropped, and the endpoint
 * answered with the WHOLE catalog under a filter. That is a filter that lies,
 * which is worse than one that returns nothing.
 *
 * `ix_genres_name` is a plain btree and the vocabulary is ~20 rows, so
 * evaluating this expression is a scan of a controlled set, not a table walk;
 * the catalog read itself is index-backed on the manga side.
 *
 * ONE definition, two consumers: the test harness imports this instead of
 * carrying its own copy, so the tested query and the shipped query cannot
 * diverge again.
 *
 * @param column the `genre.name` (or `tag.name`) column
 * @returns a SQL fragment evaluating to that name's slug, typed so a
 *   `.select({ slug: genreSlugSql(col) })` yields a `string` rather than
 *   `unknown`
 */
export function genreSlugSql(column: AnyColumn): SQL<string> {
  return sql`trim(both '-' from regexp_replace(lower(btrim(${column})), '[^a-z0-9]+', '-', 'g'))`;
}

/**
 * Resolves genre slugs to ids, DROPPING the ones that do not exist.
 *
 * An unknown slug is IGNORED, not an error. When EVERY slug is unknown no genre
 * filter is applied at all — which is the documented behaviour for "a filter
 * value that names nothing", and the reason the gate pins the resolved case
 * separately: a slug that SHOULD have resolved and did not is
 * indistinguishable from "no filter" here, so the per-genre cases are asserted
 * on rows.
 */
async function resolveGenreIds(db: Db, names: string[] | undefined): Promise<string[]> {
  if (names === undefined || names.length === 0) return [];
  const wanted = [...new Set(names.map((name) => name.toLowerCase()))].slice(0, CATALOG_MAX_GENRES);
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ id: genre.id })
    .from(genre)
    .where(inArray(genreSlugSql(genre.name), wanted));
  return rows.map((row) => row.id);
}

/**
 * The genre semi-join: "this manga has ANY of the selected genres".
 *
 * A correlated `EXISTS`, not a JOIN: a manga carrying three of the selected
 * genres must still occupy ONE page row, and a JOIN would duplicate it and
 * break the LIMIT semantics of keyset pagination.
 */
function genreSemiJoin(db: Db, genreIds: string[]): SQL | undefined {
  if (genreIds.length === 0) return undefined;
  return exists(
    db
      .select({ one: sql`1` })
      .from(mangaGenre)
      .where(and(eq(mangaGenre.mangaId, manga.id), inArray(mangaGenre.genreId, genreIds))),
  );
}

/**
 * The PUBLIC catalog page statement.
 *
 * Index: `ix_manga_visible` for `updated_desc` (the default), `ix_manga_title`
 * for `title_asc`, `ix_manga_created_at` for `added_desc`. The LIMIT is
 * `limit + 1`: one row of lookahead is how the repository learns there is a
 * next page without a second COUNT.
 *
 * Synchronous, and given the ALREADY-resolved genre ids, so `list()` and the
 * EXPLAIN gate build the identical statement with no second copy of the SQL.
 */
function catalogListSelect(db: Db, query: CatalogQuery, genreIds: string[]) {
  const sort = resolveSort(query.sort);
  const clauses = [
    mangaVisibleWhere(),
    query.status === undefined ? undefined : eq(manga.status, query.status),
    genreSemiJoin(db, genreIds),
    query.cursor === undefined ? undefined : SORTS[sort].after(...cursorArgs(query.cursor, sort)),
  ].filter((clause): clause is SQL => clause !== undefined);
  return db
    .select({ ...MANGA_COLUMNS })
    .from(manga)
    .where(and(...clauses))
    .orderBy(...SORTS[sort].orderBy)
    .limit(resolveLimit(query.limit) + 1);
}

/**
 * The EXPLAIN-gate surface: the statement `list()` runs, resolved to
 * `{ sql, params }` without executing it.
 *
 * It returns a PLAIN `{ toSQL() }` object rather than the Drizzle builder on
 * purpose: the builder is a thenable, so `await`ing it would execute it and
 * hand back rows, and the gate would end up EXPLAINing nothing. `list()` calls
 * {@link catalogListSelect} — the same function — so the two cannot drift.
 */
export async function buildCatalogListQuery(
  db: Db,
  query: CatalogQuery,
): Promise<{ toSQL(): { sql: string; params: unknown[] } }> {
  const genreIds = await resolveGenreIds(db, query.genres);
  const statement = catalogListSelect(db, query, genreIds);
  return { toSQL: () => statement.toSQL() };
}

/** The ADMIN page statement: same shape, but drafts (and optionally deletes) are in scope. */
async function buildAdminListQuery(db: Db, query: CatalogQuery & { includeDeleted?: boolean }) {
  const sort = resolveSort(query.sort);
  const genreIds = await resolveGenreIds(db, query.genres);
  const clauses = [
    query.includeDeleted === true ? undefined : isNull(manga.deletedAt),
    query.status === undefined ? undefined : eq(manga.status, query.status),
    genreSemiJoin(db, genreIds),
    query.cursor === undefined ? undefined : SORTS[sort].after(...cursorArgs(query.cursor, sort)),
  ].filter((clause): clause is SQL => clause !== undefined);
  return db
    .select({ ...MANGA_COLUMNS })
    .from(manga)
    .where(and(...clauses))
    .orderBy(...SORTS[sort].orderBy)
    .limit(resolveLimit(query.limit) + 1);
}

/** One latest chapter per manga, in ONE statement (`DISTINCT ON`), never per row. */
async function latestChapters(
  executor: Executor,
  mangaIds: string[],
  includeDrafts: boolean,
): Promise<Map<string, LatestChapter>> {
  const latest = new Map<string, LatestChapter>();
  if (mangaIds.length === 0) return latest;
  const rows = await executor
    .selectDistinctOn([chapter.mangaId])
    .from(chapter)
    .where(and(inArray(chapter.mangaId, mangaIds), chapterVisibleWhere(includeDrafts)))
    .orderBy(chapter.mangaId, desc(chapter.readingOrder));
  for (const row of rows) {
    // DISTINCT ON keeps exactly one row per manga_id (the highest
    // reading_order, thanks to the secondary sort), so there is nothing to
    // de-duplicate here.
    latest.set(row.mangaId, latestOf(row));
  }
  return latest;
}

/**
 * Loads the MangaDetail collections for a page of manga in a FIXED six
 * statements (alias, genre, tag, creator, chapter count, first chapter).
 *
 * The manga side of each join is served by the leading column of
 * `ix_manga_alias_manga_id_alias` / `ix_manga_genre_genre_id` /
 * `ix_manga_tag_tag_id` / `ix_manga_creator_creator_id`; the two chapter
 * aggregates by `ix_chapters_manga_order`.
 */
async function loadExtras(
  executor: Executor,
  mangaIds: string[],
  includeDrafts: boolean,
): Promise<Map<string, DetailExtras>> {
  const extras = new Map<string, DetailExtras>(mangaIds.map((id) => [id, emptyExtras()]));
  if (mangaIds.length === 0) return extras;
  const entryFor = (id: string): DetailExtras | undefined => extras.get(id);

  const [aliasRows, genreRows, tagRows, creatorRows, countRows, firstRows] = await Promise.all([
    executor
      .select({ mangaId: mangaAlias.mangaId, alias: mangaAlias.alias })
      .from(mangaAlias)
      .where(inArray(mangaAlias.mangaId, mangaIds))
      .orderBy(mangaAlias.alias),
    executor
      .select({ mangaId: mangaGenre.mangaId, id: genre.id, name: genre.name })
      .from(mangaGenre)
      .innerJoin(genre, eq(genre.id, mangaGenre.genreId))
      .where(inArray(mangaGenre.mangaId, mangaIds))
      .orderBy(genre.name),
    executor
      .select({ mangaId: mangaTag.mangaId, id: tag.id, name: tag.name })
      .from(mangaTag)
      .innerJoin(tag, eq(tag.id, mangaTag.tagId))
      .where(inArray(mangaTag.mangaId, mangaIds))
      .orderBy(tag.name),
    executor
      .select({
        mangaId: mangaCreator.mangaId,
        id: creator.id,
        name: creator.name,
        role: mangaCreator.role,
      })
      .from(mangaCreator)
      .innerJoin(creator, eq(creator.id, mangaCreator.creatorId))
      .where(inArray(mangaCreator.mangaId, mangaIds))
      .orderBy(creator.name),
    executor
      .select({ mangaId: chapter.mangaId, total: count() })
      .from(chapter)
      .where(and(inArray(chapter.mangaId, mangaIds), chapterVisibleWhere(includeDrafts)))
      .groupBy(chapter.mangaId),
    executor
      .selectDistinctOn([chapter.mangaId])
      .from(chapter)
      .where(and(inArray(chapter.mangaId, mangaIds), chapterVisibleWhere(includeDrafts)))
      .orderBy(chapter.mangaId, chapter.readingOrder),
  ]);

  for (const row of aliasRows) entryFor(row.mangaId)?.aliases.push(row.alias);
  for (const row of genreRows) entryFor(row.mangaId)?.genres.push({ id: row.id, name: row.name });
  for (const row of tagRows) entryFor(row.mangaId)?.tags.push({ id: row.id, name: row.name });
  for (const row of creatorRows) {
    entryFor(row.mangaId)?.creators.push({
      id: row.id,
      name: row.name,
      role: row.role === 'artist' || row.role === 'author' ? row.role : 'other',
    });
  }
  for (const row of countRows) {
    const entry = entryFor(row.mangaId);
    if (entry !== undefined) entry.chapterCount = Number(row.total);
  }
  for (const row of firstRows) {
    const entry = entryFor(row.mangaId);
    // DISTINCT ON plus `order by reading_order ASC` already yields the FIRST
    // chapter; the guard keeps the map idempotent if the sort ever changes.
    if (entry !== undefined && entry.firstChapter === null) {
      entry.firstChapter = { id: row.id, number: asNumber(row.number) };
    }
  }
  return extras;
}

/**
 * Upserts creators BY NAME and returns `{ id, role }` links (the creator's
 * `name` is its unique identity, and the port's create/update input names a
 * creator rather than carrying a creator id).
 */
async function upsertCreators(
  executor: Executor,
  creators: readonly { name: string; role: 'author' | 'artist' | 'other' }[],
): Promise<{ id: string; role: string }[]> {
  if (creators.length === 0) return [];
  const wanted = [...new Map(creators.map((c) => [c.name, c])).values()];
  await executor
    .insert(creator)
    .values(wanted.map((c) => ({ name: c.name, roleDefault: c.role })))
    .onConflictDoNothing();
  const rows = await executor
    .select({ id: creator.id, name: creator.name })
    .from(creator)
    .where(inArray(creator.name, wanted.map((c) => c.name)));
  const byName = new Map(rows.map((row) => [row.name, row.id]));
  return wanted.flatMap((c) => {
    const id = byName.get(c.name);
    return id === undefined ? [] : [{ id, role: c.role }];
  });
}

/**
 * Replaces the whole link set for the collections the caller NAMES.
 *
 * Delete-then-insert rather than a diff, so a patch that names a collection
 * replaces it wholesale and cannot leave a stale link behind — and a patch that
 * names none leaves every link untouched.
 */
async function relink(
  executor: Executor,
  id: MangaId,
  input: {
    aliases?: string[];
    genreIds?: string[];
    tagIds?: string[];
    creators?: readonly { name: string; role: 'author' | 'artist' | 'other' }[];
  },
): Promise<void> {
  if (input.aliases !== undefined) {
    await executor.delete(mangaAlias).where(eq(mangaAlias.mangaId, id));
    const values = [...new Set(input.aliases.filter((alias) => alias !== ''))];
    if (values.length > 0) {
      await executor.insert(mangaAlias).values(values.map((alias) => ({ mangaId: id, alias })));
    }
  }
  if (input.genreIds !== undefined) {
    await executor.delete(mangaGenre).where(eq(mangaGenre.mangaId, id));
    if (input.genreIds.length > 0) {
      await executor
        .insert(mangaGenre)
        .values(input.genreIds.map((genreId) => ({ mangaId: id, genreId })))
        .onConflictDoNothing();
    }
  }
  if (input.tagIds !== undefined) {
    await executor.delete(mangaTag).where(eq(mangaTag.mangaId, id));
    if (input.tagIds.length > 0) {
      await executor
        .insert(mangaTag)
        .values(input.tagIds.map((tagId) => ({ mangaId: id, tagId })))
        .onConflictDoNothing();
    }
  }
  if (input.creators !== undefined) {
    await executor.delete(mangaCreator).where(eq(mangaCreator.mangaId, id));
    const resolved = await upsertCreators(executor, input.creators);
    if (resolved.length > 0) {
      await executor
        .insert(mangaCreator)
        .values(resolved.map((link) => ({ mangaId: id, creatorId: link.id, role: link.role })))
        .onConflictDoNothing();
    }
  }
}

/** The `sql\`now()\`` stamp, so a write bumps `updated_at` like the DEFAULT would. */
const TOUCHED_AT = sql`now()`;

/**
 * Builds the Drizzle `MangaRepository`.
 *
 * @param db the application's handle from `createDb(env)` — the only place a
 *   connection is ever needed.
 */
export function createMangaRepository(db: Db): MangaRepository {
  /** The (items, nextCursor) shape both paged methods return. */
  function pageOf<T>(
    rows: MangaRow[],
    sort: CatalogSort,
    limit: number,
    shape: (row: MangaRow) => T,
  ): { items: T[]; nextCursor: string | null } {
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(shape),
      // A page that is NOT over-full has no successor, so `nextCursor` is null
      // rather than a cursor that would fetch an empty page.
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(sort, SORTS[sort].keyOf(last), last.id)
          : null,
    };
  }

  async function detailsFor(
    rows: MangaRow[],
    includeDrafts: boolean,
  ): Promise<Map<string, DetailExtras>> {
    return loadExtras(db, rows.map((row) => row.id), includeDrafts);
  }

  return {
    async list(query: CatalogQuery): Promise<{ items: MangaSummary[]; nextCursor: string | null }> {
      const sort = resolveSort(query.sort);
      const limit = resolveLimit(query.limit);
      const genreIds = await resolveGenreIds(db, query.genres);
      const rows = (await catalogListSelect(db, query, genreIds)) as MangaRow[];
      const page = rows.slice(0, limit);
      const latest = await latestChapters(
        db,
        page.map((row) => row.id),
        false,
      );
      return pageOf(rows, sort, limit, (row) => toSummary(row, latest.get(row.id) ?? null));
    },

    async adminList(
      query: CatalogQuery & { includeDeleted?: boolean },
    ): Promise<{ items: MangaDetail[]; nextCursor: string | null }> {
      const sort = resolveSort(query.sort);
      const limit = resolveLimit(query.limit);
      const rows = (await buildAdminListQuery(db, query)) as MangaRow[];
      const page = rows.slice(0, limit);
      const ids = page.map((row) => row.id);
      // An admin sees drafts, so the chapter side does too.
      const [latest, extras] = await Promise.all([latestChapters(db, ids, true), detailsFor(page, true)]);
      return pageOf(rows, sort, limit, (row) =>
        toDetail(row, latest.get(row.id) ?? null, extras.get(row.id) ?? emptyExtras()),
      );
    },

    /**
     * One title by row id — `POST /api/library` must 404 an unknown `mangaId`
     * rather than let the foreign key raise a bare 500. The same visibility
     * clauses as `bySlug`, so a draft or deleted title reads as "not found"
     * rather than "forbidden" — a 403 would tell a reader which ids exist.
     */
    async byId(id: MangaId, caller: CallerContext): Promise<MangaSummary | null> {
      const [row] = (await db
        .select({ ...MANGA_COLUMNS })
        .from(manga)
        .where(and(eq(manga.id, id), ...mangaReadClauses(caller)))) as MangaRow[];
      if (row === undefined) return null;
      const latest = await latestChapters(db, [row.id], mayReadDrafts(caller));
      return toSummary(row, latest.get(row.id) ?? null);
    },

    async bySlug(slug: MangaSlug, caller: CallerContext): Promise<MangaDetail | null> {
      // `ix_manga_slug` (unique): the URL identity is a single-row seek, and
      // the visibility clauses ride along so a hidden row is simply not found.
      const [row] = (await db
        .select({ ...MANGA_COLUMNS })
        .from(manga)
        .where(and(eq(manga.slug, slug), ...mangaReadClauses(caller)))) as MangaRow[];
      // 404-shaped, never 403: a draft and a deleted title are indistinguishable
      // from a slug that never existed.
      if (row === undefined) return null;
      const [latest, extras] = await Promise.all([
        latestChapters(db, [row.id], mayReadDrafts(caller)),
        detailsFor([row], mayReadDrafts(caller)),
      ]);
      return toDetail(row, latest.get(row.id) ?? null, extras.get(row.id) ?? emptyExtras());
    },

    async create(input: {
      title: string;
      slug: MangaSlug;
      synopsis: string;
      status: MangaStatus;
      readingDirection: ReadingDirection;
      aliases: string[];
      genreIds: string[];
      tagIds: string[];
      creators: Array<{ name: string; role: 'author' | 'artist' | 'other' }>;
    }): Promise<MangaId> {
      try {
        // ONE transaction: a title with no genre/tag/creator/alias is not a
        // state the app can produce, and a half-created title is worse than a
        // failed create.
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(manga)
            .values({
              slug: input.slug,
              title: input.title,
              synopsis: input.synopsis,
              status: input.status,
              readingDirection: input.readingDirection,
              // A new title is a DRAFT; `setPublished` is the only way in. The
              // port has no `published` field, which is the same statement.
              published: false,
            })
            .returning({ id: manga.id });
          const id = row?.id as MangaId | undefined;
          if (id === undefined) throw new AppError('MANGA_NOT_FOUND');
          await relink(tx, id, input);
          return id;
        });
      } catch (error) {
        if (isUniqueViolation(error, 'ix_manga_slug')) throw new AppError('MANGA_SLUG_TAKEN');
        throw error;
      }
    },

    async update(
      id: MangaId,
      patch: Partial<{
        title: string;
        synopsis: string;
        status: MangaStatus;
        readingDirection: ReadingDirection;
        aliases: string[];
        genreIds: string[];
        tagIds: string[];
        creators: Array<{ name: string; role: 'author' | 'artist' | 'other' }>;
      }>,
    ): Promise<void> {
      // `slug` is deliberately NOT patchable: it is the URL identity and is
      // immutable after first publish. The port's patch type already omits it;
      // this is where that is enforced.
      const scalars: Partial<{
        title: string;
        synopsis: string;
        status: MangaStatus;
        readingDirection: ReadingDirection;
      }> = {};
      if (patch.title !== undefined) scalars.title = patch.title;
      if (patch.synopsis !== undefined) scalars.synopsis = patch.synopsis;
      if (patch.status !== undefined) scalars.status = patch.status;
      if (patch.readingDirection !== undefined) scalars.readingDirection = patch.readingDirection;
      await db.transaction(async (tx) => {
        if (Object.keys(scalars).length > 0) {
          // `updated_at` is bumped explicitly because the column has a DEFAULT
          // but no trigger, and `updated_desc` is a catalog sort: an edit must
          // float the title.
          await tx
            .update(manga)
            .set({ ...scalars, updatedAt: TOUCHED_AT })
            .where(eq(manga.id, id));
        }
        await relink(tx, id, patch);
      });
    },

    async setCover(id: MangaId, coverAssetKey: string | null): Promise<void> {
      await db.update(manga).set({ coverAssetKey, updatedAt: TOUCHED_AT }).where(eq(manga.id, id));
    },

    async softDelete(id: MangaId): Promise<void> {
      // Idempotent by construction: the `deleted_at IS NULL` guard means a
      // second call updates zero rows, so the stamp can never be re-taken and
      // `restore` is the only way back.
      await db
        .update(manga)
        .set({ deletedAt: TOUCHED_AT, updatedAt: TOUCHED_AT })
        .where(and(eq(manga.id, id), isNull(manga.deletedAt)));
    },

    async restore(id: MangaId): Promise<void> {
      await db
        .update(manga)
        .set({ deletedAt: null, updatedAt: TOUCHED_AT })
        .where(and(eq(manga.id, id), sql`${manga.deletedAt} is not null`));
    },

    async setPublished(id: MangaId, published: boolean): Promise<void> {
      await db.update(manga).set({ published, updatedAt: TOUCHED_AT }).where(eq(manga.id, id));
    },

    async count(): Promise<number> {
      // The stats tile counts the collection as it is, so this counts every
      // row, soft-deleted included; the admin LIST is where a filtered view
      // lives. The data model does not say which population the tile means.
      const [row] = await db.select({ total: count() }).from(manga);
      return Number(row?.total ?? 0);
    },
  };
}

/** The chapter summary shape, re-exported for `chapter.repository.ts`. */
export type { ChapterSummary };
