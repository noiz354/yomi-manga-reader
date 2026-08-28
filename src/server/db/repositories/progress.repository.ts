/**
 * Both ports over `reading_progress`: the `ResumePositionReader` (continue-reading
 * snapshot) and the `ReaderProgressRepository` (save / get / merge / getCompletedSet /
 * unsetCompleted).
 * Load-bearing: soft-deleted, unpublished and page-less chapters are excluded from the
 * read; LWW is a WHERE on the ON CONFLICT clause; `completed` is sticky in the SET;
 * `library_entry.last_read_at` is maintained in the same transaction.
 */
import { and, asc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { chapter, libraryEntry, readingProgress } from '../schema';
import type { Db } from '../client';
import type { ReaderProgressRepository, SaveReaderProgressInput } from '../../../features/progress';
import type {
  ResumeChapterFact,
  ResumePositionReader,
  ResumeSnapshot,
} from '../../../features/progress/resume.service';
import type { ReaderProgress } from '../../../shared/contracts';
import type { ChapterId, MangaId, UserId } from '../../../shared/types';

/** One row of the join: a chapter of the manga + the caller's row for it. */
interface ResumeRow {
  chapterId: string;
  chapterNumber: string;
  readingOrder: number;
  pageCount: number;
  pageNumber: number | null;
  scrollPosition: number | null;
  completed: boolean | null;
}

/**
 * `numeric(8,2)` → `number`: the column reads back as a string and is converted
 * deliberately, once, here.
 *
 * The column is `NOT NULL` and constrained to a numeric type, so this cannot
 * fail in practice; the guard exists so a corrupted row degrades to a sortable
 * `0` instead of poisoning a position with `NaN` (a NaN chapter number would
 * survive into the UI and into the home list's sort).
 */
function toChapterNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Row → feature fact (Drizzle row types stay in this file). */
function toChapterFact(row: ResumeRow): ResumeChapterFact {
  return {
    chapterId: row.chapterId as ChapterId,
    chapterNumber: toChapterNumber(row.chapterNumber),
    readingOrder: row.readingOrder,
    pageCount: row.pageCount,
    // `completed` is NOT NULL on a real row, so a present page number is what
    // decides whether there IS a position (never `completed` alone).
    position:
      row.pageNumber === null
        ? null
        : {
            pageNumber: row.pageNumber,
            scrollPosition: row.scrollPosition ?? 0,
            completed: row.completed ?? false,
          },
  };
}

/**
 * Builds the `ResumePositionReader` over a live Drizzle handle.
 *
 * @param db the application pool from `createDb` (DML only).
 *   Composed at the root; never constructed at import time.
 *
 * Returns `null` (never throws) when the manga has no readable chapter — a
 * hidden, deleted or wholly unpublished manga, which is 404-shaped null in the
 * catalog, not an error.
 */
export function createProgressPositionReader(db: Db): ResumePositionReader {
  return {
    async readResumeSnapshot(userId: UserId, mangaId: MangaId): Promise<ResumeSnapshot | null> {
      const rows = await db
        .select({
          chapterId: chapter.id,
          chapterNumber: chapter.number,
          readingOrder: chapter.readingOrder,
          pageCount: chapter.pageCount,
          pageNumber: readingProgress.pageNumber,
          scrollPosition: readingProgress.scrollPosition,
          completed: readingProgress.completed,
        })
        .from(chapter)
        .leftJoin(
          readingProgress,
          and(
            eq(readingProgress.chapterId, chapter.id),
            // The caller's own rows only. `userId` came from the session
            // `Caller`; there is no other user in this query.
            eq(readingProgress.userId, userId),
          ),
        )
        .where(
          and(
            eq(chapter.mangaId, mangaId),
            isNull(chapter.deletedAt),
            eq(chapter.status, 'published'),
            gte(chapter.pageCount, 1),
          ),
        )
        // Reading order: the explicit sort tiebreaker.
        .orderBy(asc(chapter.readingOrder));

      if (rows.length === 0) return null;
      return { mangaId, chapters: rows.map((row) => toChapterFact(row)) };
    },
  };
}

/** The slice of a Drizzle handle the write helpers need; a `transaction` satisfies it. */
type Executor = Pick<Db, 'select' | 'insert' | 'update'>;

/**
 * The server's own clock, written as the COLUMN DEFAULT's expression
 * (`updatedAt()` is `DEFAULT now()`), so a value this module stamps and a value
 * the schema defaults are the same kind of timestamp.
 *
 * `now()` is the TRANSACTION timestamp in PostgreSQL, not the wall clock per
 * statement. That is the mechanism behind two rules this file relies on: every
 * progress row written inside one `mergeProgress` transaction carries the SAME
 * stamp (so grouping the denormalisation per manga is exact), and the progress
 * row's stamp and the `last_read_at` copied from it are the same value by
 * construction rather than by a second `now()` that could tick between them.
 */
const STAMP = sql`now()`;

/** One `reading_progress` row, as this module projects and writes it. */
interface ProgressRow {
  chapterId: string;
  pageNumber: number;
  scrollPosition: number;
  completed: boolean;
  updatedAt: Date;
}

/** The `chapter` facts the merge needs for ONE id: does it exist, how long is it. */
interface ChapterShape {
  pageCount: number;
  mangaId: MangaId;
}

/** What one merge entry contributes, after shape validation and per-chapter dedup. */
interface MergeCandidate {
  chapterId: ChapterId;
  pageNumber: number;
  completed: boolean;
  /** Normalised ISO-8601, bound as a `timestamptz` comparison operand. */
  clientStamp: string;
  /** Epoch ms of the same instant — the ordering key for "latest wins". */
  at: number;
}

/** Row → DTO: Drizzle row types stop in this file. */
function toReaderProgress(row: ProgressRow): ReaderProgress {
  return {
    chapterId: row.chapterId as ChapterId,
    pageNumber: row.pageNumber,
    scrollPosition: row.scrollPosition,
    completed: row.completed,
    // timestamptz → ISO-8601 UTC.
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The columns every `reading_progress` read in this file projects. */
const PROGRESS_COLUMNS = {
  chapterId: readingProgress.chapterId,
  pageNumber: readingProgress.pageNumber,
  scrollPosition: readingProgress.scrollPosition,
  completed: readingProgress.completed,
  updatedAt: readingProgress.updatedAt,
} as const;

/**
 * The LWW predicate: apply only when the stored stamp is not newer than the
 * basis.
 *
 * `clientStamp === null` is the SAVE path, where the basis is the server clock —
 * a client value must never decide this (the port's rule is "client timestamps
 * are never trusted (merge input only)"). The MERGE path passes the entry's own
 * stamp instead, because the merge is latest-wins on the device that read the
 * chapter.
 *
 * The `::timestamptz` cast is on the bound parameter, so the client string is
 * compared as a timestamp and never as text (an unparseable one is rejected in
 * TypeScript before it reaches here). This mirrors `library.repository.ts`'s
 * cursor predicates.
 */
function lwwGuard(clientStamp: string | null): SQL {
  return clientStamp === null
    ? lte(readingProgress.updatedAt, STAMP)
    : lte(readingProgress.updatedAt, sql`${clientStamp}::timestamptz`);
}

/**
 * ONE statement for both write paths: the idempotent `reading_progress` upsert.
 *
 * @param clientStamp the LWW basis operand, or `null` for the server clock
 *   (see {@link lwwGuard}).
 *
 * @returns the row's NEW `updated_at`, or `null` when the guard rejected the
 *   write. A rejected write is not an error and not a rowcount the caller has to
 *   count: `RETURNING` on an `ON CONFLICT DO UPDATE` whose `WHERE` matched no
 *   row returns nothing, which is the whole of "applied vs not" for both paths.
 */
async function upsertProgress(
  tx: Executor,
  row: {
    userId: UserId;
    chapterId: ChapterId;
    pageNumber: number;
    scrollPosition: number;
    completed: boolean;
  },
  clientStamp: string | null,
): Promise<Date | null> {
  // "Identical repeat changes nothing (rowcount 0)": without this clause a
  // repeat would differ only in `now()`, so it would look like a change, bump
  // the stamp, and shove the title up the shelf. `is distinct from` rather than
  // `<>` so the comparison is NULL-safe, and the completion term is written as
  // "the value the SET would store" (`completed OR excluded.completed`, i.e. the
  // sticky rule above) — which is the only completion transition a write can
  // cause, false → true.
  const wouldChange = sql`(
      ${readingProgress.pageNumber} is distinct from ${row.pageNumber}
      or ${readingProgress.scrollPosition} is distinct from ${row.scrollPosition}
      or ${readingProgress.completed}
         is distinct from (${readingProgress.completed} or ${row.completed})
    )`;
  // `and` is typed `SQL | undefined` because an ALL-empty argument list is
  // meaningless; both of these are always present, so the assertion is a fact
  // the type cannot see — the same `as SQL` that `manga.repository.ts`'s
  // `chapterVisibleWhere` uses for the same reason. `exactOptionalPropertyTypes`
  // forbids handing `onConflictDoUpdate` the `undefined` arm.
  const guard = and(lwwGuard(clientStamp), wouldChange) as SQL;

  const applied = await tx
    .insert(readingProgress)
    .values({
      userId: row.userId,
      chapterId: row.chapterId,
      pageNumber: row.pageNumber,
      scrollPosition: row.scrollPosition,
      completed: row.completed,
      // Server-stamped even on the INSERT path, where a client value would
      // otherwise be the only thing in the row.
      updatedAt: STAMP,
    })
    .onConflictDoUpdate({
      // The `reading_progress` PRIMARY KEY (user_id, chapter_id) — the conflict
      // target IS the lookup key, so no pre-read is needed.
      target: [readingProgress.userId, readingProgress.chapterId],
      set: {
        pageNumber: row.pageNumber,
        scrollPosition: row.scrollPosition,
        // Sticky: the existing value OR'd with the incoming one, so a page write
        // can only ever move it false → true. `excluded` is PostgreSQL's
        // pseudo-table for the proposed row; it is an IDENTIFIER in a fixed
        // template, never a runtime value, so no injection is possible.
        completed: sql`${readingProgress.completed} or excluded.completed`,
        updatedAt: STAMP,
      },
      where: guard,
    })
    .returning({ updatedAt: readingProgress.updatedAt });
  return applied[0]?.updatedAt ?? null;
}

/**
 * Sets `library_entry.last_read_at` for ONE manga — the denormalisation the
 * library's default sort orders by.
 *
 * An `UPDATE`, never an upsert: a reader with no entry for this manga gets no
 * row. The column denormalises an EXISTING membership, and reading a chapter is
 * not consent to join a shelf — `LibraryRepository.add` is that operation and
 * this file never calls it.
 */
async function touchLibraryLastRead(
  tx: Executor,
  userId: UserId,
  mangaId: MangaId,
  at: Date,
): Promise<void> {
  await tx
    .update(libraryEntry)
    .set({ lastReadAt: at })
    .where(
      and(
        // The caller's own shelf; another reader's entry is not reachable
        // through this predicate.
        eq(libraryEntry.userId, userId),
        eq(libraryEntry.mangaId, mangaId),
      ),
    );
}

/**
 * The same denormalisation for the single-row save path, resolving the chapter's
 * manga INSIDE the `WHERE` so it stays one statement.
 *
 * A correlated scalar subquery rather than a second `SELECT`: the chapter's
 * manga is the key of the row being updated, and if the chapter does not exist
 * the subquery is NULL, `manga_id = NULL` is never true, and zero entries are
 * touched — the "unknown chapter ⇒ touch nothing" case falls out instead of
 * needing a branch. The interpolated id is a bind parameter
 * (`${chapterId}::uuid`), so nothing is concatenated.
 */
async function touchLibraryLastReadForChapter(
  tx: Executor,
  userId: UserId,
  chapterId: ChapterId,
  at: Date,
): Promise<void> {
  await tx
    .update(libraryEntry)
    .set({ lastReadAt: at })
    .where(
      and(
        eq(libraryEntry.userId, userId),
        eq(
          libraryEntry.mangaId,
          sql`(select ${chapter.mangaId} from ${chapter} where ${chapter.id} = ${chapterId}::uuid)`,
        ),
      ),
    );
}

/**
 * Keeps the latest `clientUpdatedAt` per chapter and rejects entries whose shape
 * cannot be a position.
 *
 * "Per chapter, latest wins" is applied HERE, over the payload, so a device
 * that flushed the same chapter twice contributes one row rather than two
 * writes whose commit order would then decide the outcome. Whichever entry
 * loses is counted as `dropped` — including the one that was already in the map
 * and is being replaced — because the summary promises `applied + dropped ===
 * entries.length`, and an entry that is silently overwritten would break it.
 * On an exact stamp tie the FIRST arrival is kept, so a payload of identical
 * stamps has one defined outcome rather than one that depends on the order the
 * device happened to flush them in.
 *
 * A non-integer page is dropped rather than truncated: `page_number` is an
 * integer column with a CHECK, and a fractional page is malformed data, not a
 * position — truncating it would invent a page the reader never saw.
 */
function toMergeCandidates(entries: Parameters<ReaderProgressRepository['mergeProgress']>[1]): {
  candidates: MergeCandidate[];
  dropped: number;
} {
  const latest = new Map<string, MergeCandidate>();
  let dropped = 0;
  for (const entry of entries) {
    const at = Date.parse(entry.clientUpdatedAt);
    if (!Number.isFinite(at) || !Number.isInteger(entry.pageNumber)) {
      dropped += 1;
      continue;
    }
    const previous = latest.get(entry.chapterId);
    if (previous !== undefined) {
      // Two entries for one chapter: the EARLIER-stamped one is the one that is
      // dropped, whichever side of the comparison it happens to be on, so the
      // outcome never depends on the order the device flushed them in.
      if (previous.at >= at) {
        dropped += 1;
        continue;
      }
      dropped += 1;
    }
    latest.set(entry.chapterId, {
      chapterId: entry.chapterId,
      pageNumber: entry.pageNumber,
      completed: entry.completed === true,
      clientStamp: new Date(at).toISOString(),
      at,
    });
  }
  return { candidates: [...latest.values()], dropped };
}

/**
 * Builds the Drizzle `ReaderProgressRepository` — save, restore and merge.
 *
 * Both write methods also maintain `library_entry.last_read_at` in the SAME
 * transaction as the progress row — this is the writer the library page's
 * default sort depends on.
 *
 * @param db the application pool from `createDb` (DML only).
 *   Composed at the root; never constructed at import time.
 */
export function createReaderProgressRepository(db: Db): ReaderProgressRepository {
  return {
    /**
     * Persist the current reader position.
     *
     * The page is NOT re-validated against `chapter.page_count` here: the port
     * states it is "validated against chapter pageCount before reaching here"
     * and the service owns that check, because it is the party that already
     * read the chapter (the clamp lives there too). The schema's
     * `reading_progress_page_number` CHECK (`>= 1`) is the last line of defence
     * and it fires, rather than silently storing a bad position.
     */
    async saveProgress(userId: UserId, input: SaveReaderProgressInput): Promise<void> {
      // TWO tables, so ONE transaction. A committed progress row with a stale
      // `last_read_at` would be the half-write the single-writer chain exists to
      // prevent.
      await db.transaction(async (tx) => {
        const appliedAt = await upsertProgress(
          tx,
          {
            userId,
            chapterId: input.chapterId,
            pageNumber: input.pageNumber,
            scrollPosition: input.scrollPosition,
            completed: input.completed === true,
          },
          // The server clock is the ONLY LWW basis here.
          null,
        );
        // Rejected by the guard ⇒ `updated_at` did not move ⇒ neither must the
        // shelf, or an identical repeat would reshuffle `last_read_desc`.
        if (appliedAt === null) return;
        await touchLibraryLastReadForChapter(tx, userId, input.chapterId, appliedAt);
      });
    },

    /**
     * Retrieve the most recent position for a chapter.
     *
     * ONE indexed read of the `reading_progress` PRIMARY KEY — never a count, a
     * join or a fallback — and `null` when the caller has no row, which the port
     * distinguishes from an error (a chapter never opened is a normal state).
     *
     * RAW is returned on purpose: a position past the chapter's current
     * `page_count` (a re-ingest shrank it) is the SERVICE's clamp to make, and a
     * repository that quietly fixed it would report a page the reader was never
     * on.
     */
    async getProgress(userId: UserId, chapterId: ChapterId): Promise<ReaderProgress | null> {
      const rows = await db
        .select({ ...PROGRESS_COLUMNS })
        .from(readingProgress)
        .where(
          and(
            // The caller's own rows only; `userId` came from the session
            // `Caller`, never from a request.
            eq(readingProgress.userId, userId),
            eq(readingProgress.chapterId, chapterId),
          ),
        )
        .limit(1);
      const row = rows[0] as ProgressRow | undefined;
      return row === undefined ? null : toReaderProgress(row);
    },

    /**
     * Apply an anonymous local set on sign-in.
     *
     * Validation is one read for the whole payload and the writes are one
     * statement per surviving chapter inside a single transaction, so the
     * `last_read_at` denormalisation cannot survive a failed merge and no
     * chapter's write can be visible without its own. `applied`/`dropped` always
     * sum to the payload length.
     */
    async mergeProgress(
      userId: UserId,
      entries: Parameters<ReaderProgressRepository['mergeProgress']>[1],
    ): Promise<{ applied: number; dropped: number }> {
      const { candidates, dropped: malformed } = toMergeCandidates(entries);

      // One read resolves every survivor: `id` (does the chapter exist at all),
      // `page_count` (is the page in range) and `manga_id` (whose shelf to
      // touch). A per-candidate lookup would be the N+1 query the perf rule
      // forbids, against a 200-entry payload.
      const shapes = new Map<string, ChapterShape>();
      if (candidates.length > 0) {
        const rows = await db
          .select({ id: chapter.id, pageCount: chapter.pageCount, mangaId: chapter.mangaId })
          .from(chapter)
          .where(
            inArray(
              chapter.id,
              candidates.map((candidate) => candidate.chapterId),
            ),
          );
        for (const row of rows) {
          shapes.set(row.id, { pageCount: row.pageCount, mangaId: row.mangaId as MangaId });
        }
      }

      return db.transaction(async (tx) => {
        let applied = 0;
        let dropped = malformed;
        // One `last_read_at` UPDATE per DISTINCT manga, not per chapter: every
        // row written in this transaction shares one `now()`, so a single value
        // per manga is exact (and `SET`ting it repeatedly would be pure noise).
        const lastReadByManga = new Map<MangaId, Date>();

        for (const candidate of candidates) {
          const shape = shapes.get(candidate.chapterId);
          // Unknown chapter, or a page the chapter does not have. A draft has
          // `page_count = 0`, so every page is out of range for it — which is
          // also why no visibility filter is applied here.
          if (
            shape === undefined ||
            candidate.pageNumber < 1 ||
            candidate.pageNumber > shape.pageCount
          ) {
            dropped += 1;
            continue;
          }
          const appliedAt = await upsertProgress(
            tx,
            {
              userId,
              chapterId: candidate.chapterId,
              pageNumber: candidate.pageNumber,
            // The merge entry carries no scroll offset (the sync is a page); a
            // paged session's offset is 0 by definition.
              scrollPosition: 0,
              completed: candidate.completed,
            },
            // The one place a client value decides an LWW; the value that LANDS
            // is still `now()`.
            candidate.clientStamp,
          );
          if (appliedAt === null) {
            // Valid, but the server already holds a newer position for this
            // chapter — the port's "latest wins" resolving against the account
            // rather than against this device.
            dropped += 1;
            continue;
          }
          applied += 1;
          lastReadByManga.set(shape.mangaId, appliedAt);
        }

        for (const [mangaId, at] of lastReadByManga) {
          await touchLibraryLastRead(tx, userId, mangaId, at);
        }

        return { applied, dropped };
      });
    },

    /**
     * The chapters of `chapterIds` this reader has completed (the library list's
     * read/unread state).
     *
     * ONE query for the whole set, never a lookup per chapter: the library page
     * asks about every chapter it renders. Scoped by `user_id` and by the sticky
     * `completed` flag, so a chapter with a position that was never completed is
     * correctly absent — completion is a decision only the progress write makes,
     * never a reach-the-last-page guess.
     */
    async getCompletedSet(userId: UserId, chapterIds: ChapterId[]): Promise<Set<ChapterId>> {
      // `in ()` is a syntax error in PostgreSQL, and an empty IN list has no
      // meaning anyway: a caller with no chapters cannot have completed any.
      if (chapterIds.length === 0) return new Set<ChapterId>();
      const rows = await db
        .select({ chapterId: readingProgress.chapterId })
        .from(readingProgress)
        .where(
          and(
            eq(readingProgress.userId, userId),
            eq(readingProgress.completed, true),
            // The port bounds this at 1000 chapters; the predicate is a range
            // scan on the PK's second column either way.
            inArray(readingProgress.chapterId, chapterIds),
          ),
        );
      return new Set(rows.map((row) => row.chapterId as ChapterId));
    },

    /**
     * Clear `completed` for one chapter — the only unset path.
     *
     * A SEPARATE `UPDATE`, not a `saveProgress` with a `false`:
     * `SET completed = reading_progress.completed OR excluded.completed` is
     * sticky by contract, so a save could never clear the flag. Threading the
     * intent through that path would mean either weakening the sticky-OR for
     * every page write, or writing a `false` that does nothing.
     *
     * `WHERE ... AND completed = true` is the no-op rule, and it is what makes
     * this idempotent in the same way `saveProgress` is: an unset on a chapter
     * that is not completed changes no column, so `updated_at` does not move. That
     * matters because the same statement is also the LWW basis — see below.
     *
     * Its own LWW guard, on the server clock, for the same reason the save has
     * one: a reader who finishes a chapter and then has a stale unset replayed at
     * them must not watch it become unfinished. The guard is a `WHERE` on the same
     * statement, not a read-then-write, so two racing unsets cannot both "win" and
     * a racing unset/complete pair resolves by stamp rather than by arrival.
     *
     * No transaction is opened. This is ONE table and ONE statement, so there is
     * no second write that could half-commit — the reason `saveProgress` needs a
     * transaction is that it also moves `library_entry.last_read_at`, and this
     * deliberately does not (see the port: it clears the flag only, and does not
     * rewind the position).
     */
    async unsetCompleted(userId: UserId, chapterId: ChapterId): Promise<void> {
      await db
        .update(readingProgress)
        .set({ completed: false, updatedAt: STAMP })
        .where(
          and(
            eq(readingProgress.userId, userId),
            eq(readingProgress.chapterId, chapterId),
            // The no-op rule. Without it every repeated unset would move
            // `updated_at` and be indistinguishable from a real change.
            eq(readingProgress.completed, true),
            // LWW: apply only when the stored stamp is not newer than the server
            // clock, the same basis the save uses.
            lwwGuard(null),
          ),
        );
    },
  };
}
