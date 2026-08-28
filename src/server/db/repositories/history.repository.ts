/**
 * server/db/repositories — `HistoryRepository`.
 * The reading-history adapter: contiguous read sessions over `reading_history` and the
 * history list behind `/history`.
 * One row per contiguous session per chapter: re-entry within the window extends the
 * open row rather than opening a second. Depth is the deepest page, never the last.
 * `chapter_id` is `ON DELETE SET NULL`, so the list LEFT JOINs and never filters a retained row away.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { AppError } from '../../../shared/contracts/errors';
import type { HistoryRepository } from '../../../features/progress/history.repository';
import type { ChapterId, UserId } from '../../../shared/types';
import type { Db } from '../client';
import { chapter, manga, readingHistory } from '../schema';

/** Re-entry inside this window extends the open session. */
const SESSION_GAP_MS = 5 * 60 * 1000;

/** Columns the history list projects, with both resolution joins. */
const HISTORY_COLUMNS = {
  id: readingHistory.id,
  chapterId: readingHistory.chapterId,
  deepestPage: readingHistory.pageNumber,
  startedAt: readingHistory.startedAt,
  endedAt: readingHistory.endedAt,
  durationMs: readingHistory.durationMs,
  chapterNumber: chapter.number,
  mangaSlug: manga.slug,
  mangaTitle: manga.title,
};

interface HistoryRow {
  id: string;
  chapterId: string | null;
  deepestPage: number;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  chapterNumber: string | null;
  mangaSlug: string | null;
  mangaTitle: string | null;
}

export const HISTORY_DEFAULT_LIMIT = 24;
export const HISTORY_MAX_LIMIT = 48;

/**
 * Decodes a cursor, or throws `CATALOG_PAGE_INVALID` (422) — the same code the
 * catalog and library use for a cursor they will not repair. Repaired pagination
 * silently returns the wrong page, which is worse than a refusal.
 */
function decodeHistoryCursor(cursor: string): { k: string; i: string } {
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
  const candidate = parsed as { v?: unknown; k?: unknown; i?: unknown };
  if (candidate.v !== 1) return invalid();
  if (typeof candidate.k !== 'string' || typeof candidate.i !== 'string') return invalid();
  if (candidate.k === '' || candidate.i === '') return invalid();
  return { k: candidate.k, i: candidate.i };
}

function encodeHistoryCursor(key: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, k: key, i: id }), 'utf8').toString('base64url');
}

/**
 * Maps one row to the DTO. `chapter: null` is the retained-row case, not a
 * missing row: the history entry is still the reader's.
 */
function toHistoryEntry(row: HistoryRow): import('../../../shared/contracts').HistoryEntry {
  const chapterId = row.chapterId;
  return {
    chapter:
      chapterId === null
        ? null
        : {
          id: chapterId,
          // `number` is numeric(8,2) in the DB (a string there) and a number in
          // the DTO, so a special chapter "10.5" survives the round trip.
          number: Number(row.chapterNumber ?? 0),
          mangaSlug: row.mangaSlug ?? '',
          mangaTitle: row.mangaTitle ?? '',
        },
    deepestPage: row.deepestPage,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationMs: row.durationMs,
  };
}

/**
 * Builds the `HistoryRepository`.
 *
 * @param db the application's handle from `createDb(env)`.
 */
export function createHistoryRepository(db: Db): HistoryRepository {
  /**
   * The still-open session for this (user, chapter), if one is recent enough to
   * extend. A row older than the 5-minute window is a different session and must
   * not be reopened — hence the `started_at` bound in the WHERE rather than a
   * read-then-decide in TypeScript.
   */
    const openSessionWhere = (userId: UserId, chapterId: ChapterId): SQL =>
      sql`(${readingHistory.userId} = ${userId}
         and ${readingHistory.chapterId} = ${chapterId}
         and ${readingHistory.endedAt} is null
         and ${readingHistory.startedAt} > now()
             - (${SESSION_GAP_MS}::int * interval '1 millisecond'))`;

  return {
    async openSession(userId: UserId, input: { chapterId: ChapterId; pageNumber: number }) {
      // A pre-check would race two tabs into two sessions; the insert is the
      // decision. Two statements, one transaction.
      await db.transaction(async (tx) => {
        const extended = await tx
          .update(readingHistory)
          .set({
            // Deepest page, never lower: jumping back must not undo the record.
            pageNumber: sql`greatest(${readingHistory.pageNumber}, ${input.pageNumber})`,
            endedAt: null,
          })
          .where(openSessionWhere(userId, input.chapterId))
          .returning({ id: readingHistory.id });
        if (extended.length > 0) return;
        await tx.insert(readingHistory).values({
          userId,
          chapterId: input.chapterId,
          pageNumber: input.pageNumber,
          startedAt: new Date(),
          endedAt: null,
          durationMs: null,
        });
      });
    },

    async touchDeepest(userId: UserId, chapterId: ChapterId, pageNumber: number) {
      await db
        .update(readingHistory)
        .set({ pageNumber: sql`greatest(${readingHistory.pageNumber}, ${pageNumber})` })
        .where(openSessionWhere(userId, chapterId));
    },

    async closeSession(userId: UserId, chapterId: ChapterId) {
      // `durationMs` is derived, not supplied: the span between the server-stamped
      // start and the server-stamped close, so a client clock cannot invent it.
      await db
        .update(readingHistory)
        .set({
          endedAt: new Date(),
          durationMs: sql`greatest(0, (extract(epoch from (now() - ${readingHistory.startedAt})) * 1000)::bigint)::int`,
        })
        .where(openSessionWhere(userId, chapterId));
    },

    async list(userId: UserId, query: { cursor?: string; limit?: number }) {
      const limit = Math.min(Math.max(query.limit ?? HISTORY_DEFAULT_LIMIT, 1), HISTORY_MAX_LIMIT);
      const where: SQL[] = [eq(readingHistory.userId, userId)];
      if (query.cursor !== undefined) {
        const { k, i } = decodeHistoryCursor(query.cursor);
        // Newest first, keyed on `started_at` (NOT NULL, server-stamped) with the
        // row id as the tiebreaker, so the order is total and a cursor is stable.
        // `${i}::uuid`, not `::bigint`: `reading_history.id` is a uuid, and the
        // comparison is what the database type-checks — a wrong cast (`uuid =
        // bigint`) fails every page after the first.
        where.push(sql`(${readingHistory.startedAt}, ${readingHistory.id}) < (${k}::timestamptz, ${i}::uuid)`);
      }
      // BOTH joins are LEFT: a deleted chapter keeps its history row and renders
      // `chapter: null`. An inner join would silently drop it.
      const rows = (await db
        .select(HISTORY_COLUMNS)
        .from(readingHistory)
        .leftJoin(chapter, eq(readingHistory.chapterId, chapter.id))
        .leftJoin(manga, eq(chapter.mangaId, manga.id))
        .where(and(...where))
        .orderBy(desc(readingHistory.startedAt), desc(readingHistory.id))
        // Over-fetch by one: a full page means there may be a successor, and a
        // cursor that fetched an empty page is a cursor that lies.
        .limit(limit + 1)) as unknown as HistoryRow[];

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toHistoryEntry),
        nextCursor:
          rows.length > limit && last !== undefined
            ? encodeHistoryCursor(last.startedAt.toISOString(), String(last.id))
            : null,
      };
    },
  };
}
