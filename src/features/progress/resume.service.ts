/**
 * features/progress — ResumeService: continue-reading resolution.
 *
 * Responsibility: given a caller and a manga, answer ONE question — "where
 * should this reader resume?" — as `{ chapterId, chapterNumber, pageNumber,
 * scrollOffset }` or `null`. Consumers: the manga detail page and the home
 * "continue reading" list.
 *
 * `resolveResumePosition` is total and side-effect free, so every rule is
 * assertable without a database, and the SQL is confined to ONE query in
 * `server/db/repositories/progress.repository.ts`. Boundary: this module
 * imports only `shared/**` and never `server/**`.
 *
 * The snapshot already contains only VALID chapters of the manga — not
 * soft-deleted, not `draft` (an unpublished chapter is 404-shaped for a
 * reader, and a resume entry must never point at one), and with at least one
 * committed page (a 0-page chapter renders "unavailable"). Those exclusions are
 * the repository's WHERE clause, which is also what implements the
 * deleted-chapter edge case: a soft-deleted chapter keeps its
 * `reading_progress` row (the FK cascades only on a hard delete), so without
 * the filter the reader would be resumed into a chapter that no longer exists.
 *
 * Rules, in the order they are applied:
 * 1. No valid chapter, or none started → `null` (nothing to resume; the detail
 *    page renders its "start reading" affordance).
 * 2. Deepest STARTED chapter — the greatest `reading_order` that has a progress
 *    row. "Started" deliberately INCLUDES completed chapters: a finished
 *    chapter was started, and the rule is "deepest started", not "deepest
 *    unfinished". When that chapter is not completed, its stored page/scroll is
 *    the answer (clamped, see below).
 * 3. The deepest started chapter IS completed → the first chapter AFTER it that
 *    is not completed, at page 1 / offset 0 (it has never been read, so there
 *    is no position to restore).
 * 4. Nothing unread remains → `null`, and the detail page shows the "read"
 *    state.
 *
 * Ordering uses `chapter.reading_order`, never `progress.updated_at`: ordering
 * by the latter would move the continue-reading entry backwards to an earlier
 * chapter after a reader goes back.
 *
 * Why `pageCount >= 1` and the clamp live here: the repository returns raw
 * values and the SERVICE clamps. Re-ingest replaces the page set, so a stored
 * page can exceed the chapter's current page count; and `scroll_position`
 * carries no DB CHECK, so a legacy or hand-edited value can be outside 0..1.
 * Both are normalized to the reader's invariant (`ReaderState`: 1 ≤
 * currentPage ≤ totalPages, 0 ≤ scrollOffset ≤ 1) rather than pushed onto two
 * different consumers.
 *
 * SECURITY: IDOR is structurally impossible. `resolveResume` takes a
 * `CallerContext` — the frozen identity the route guard attached — and a manga
 * id. There is no user id in its signature at all, and the user id it forwards
 * is `caller.userId` and nothing else. A caller therefore cannot name a
 * different reader's progress: there is no parameter to substitute, no header
 * to spoof, and no branch that reads a subject id. A role check would be
 * theatre — an `admin` caller reads its OWN progress too, which the unit test
 * pins. The lower-level `ProgressReader.latestForManga(userId, mangaId)` keeps
 * the user id as an explicit parameter only because the catalog wiring already
 * declares that signature; it is not a second identity source, and the catalog
 * service is the one that must pass `caller?.userId`.
 *
 * Error contract: there is none, by design: "anonymous → null" and "nothing to
 * resume → null" make this function TOTAL, so it never throws.
 */
import type { CallerContext } from '../../shared/contracts';
import type { ChapterId, MangaId, UserId } from '../../shared/types';
import type { ProgressReader } from './history.repository';

/**
 * Where a reader resumes — the one shape both consumers (detail page, home
 * continue-reading list) need.
 *
 * Structurally identical to the `ProgressReader.latestForManga` return type in
 * `./history.repository`, which is left untouched so the catalog wiring keeps
 * compiling against it.
 */
export interface ResumePosition {
  readonly chapterId: ChapterId;
  readonly chapterNumber: number;
  readonly pageNumber: number;
  /** Vertical offset within the page, 0..1. */
  readonly scrollOffset: number;
}

/** A stored position — present only for a chapter the reader has started. */
export interface ResumePositionFact {
  /** 1-based; the DB CHECK requires `page_number >= 1`. */
  readonly pageNumber: number;
  /** Within-page offset, 0..1; no DB CHECK enforces it. */
  readonly scrollPosition: number;
  /** Sticky; unset only by an explicit unmark. */
  readonly completed: boolean;
}

/**
 * One VALID chapter of the manga as the resume rules see it. `position: null`
 * is "this chapter exists and was never started" — a hole the rules walk past.
 */
export interface ResumeChapterFact {
  readonly chapterId: ChapterId;
  /** Special chapters ("10.5") are representable. */
  readonly chapterNumber: number;
  /** Explicit sort key, backed by `ix_chapters_manga_order`. */
  readonly readingOrder: number;
  /** Committed page count; always ≥ 1 in a snapshot (see the file header). */
  readonly pageCount: number;
  readonly position: ResumePositionFact | null;
}

/**
 * Everything the rules need for one (caller, manga) pair, in reading order.
 *
 * Returned whole rather than per chapter on purpose: the "next unread chapter"
 * scan needs the chapters that have NO progress row, so a read that returned
 * only the reader's own rows could not answer rule 2 — and splitting it would
 * mean two round trips for one decision.
 */
export interface ResumeSnapshot {
  readonly mangaId: MangaId;
  readonly chapters: readonly ResumeChapterFact[];
}

/**
 * `ResumePositionReader` — the ONE read this service needs. Implemented in
 * `server/db/repositories/progress.repository.ts`.
 *
 * Contract (the repository MUST honour it; the rules below rely on it):
 * - chapters are VALID only: `deleted_at IS NULL`, `status = 'published'`,
 *   `page_count >= 1`;
 * - `position` is the caller's own row for that chapter, or `null`;
 * - a `null` return means "this manga has no readable chapter" — a hidden or
 *   deleted manga, which is 404-shaped null everywhere in the catalog, never
 *   an error.
 * - the ORDER BY is an optimization, not a contract: the resolver sorts.
 */
export interface ResumePositionReader {
  readResumeSnapshot(userId: UserId, mangaId: MangaId): Promise<ResumeSnapshot | null>;
}

/** 1-based first page; a chapter that was never started starts here. */
const FIRST_PAGE = 1;

/** Clamps a stored page into `[1, pageCount]`. */
function clampPage(stored: number, pageCount: number): number {
  const upper = Math.max(FIRST_PAGE, Math.trunc(pageCount));
  if (!Number.isFinite(stored)) return FIRST_PAGE;
  return Math.min(Math.max(Math.trunc(stored), FIRST_PAGE), upper);
}

/** Clamps a stored offset into the reader's `0..1` invariant. */
function clampOffset(stored: number): number {
  if (!Number.isFinite(stored)) return 0;
  return Math.min(Math.max(stored, 0), 1);
}

/** The resume answer for a chapter the reader HAS a position in. */
function positionAt(chapter: ResumeChapterFact, position: ResumePositionFact): ResumePosition {
  return {
    chapterId: chapter.chapterId,
    chapterNumber: chapter.chapterNumber,
    pageNumber: clampPage(position.pageNumber, chapter.pageCount),
    scrollOffset: clampOffset(position.scrollPosition),
  };
}

/** A chapter paired with its (non-null) position — the "started" shape. */
interface StartedChapter {
  chapter: ResumeChapterFact;
  position: ResumePositionFact;
}

/** Type guard for "this chapter was started" (a progress row exists). */
function isStarted(entry: {
  chapter: ResumeChapterFact;
  position: ResumePositionFact | null;
}): entry is StartedChapter {
  return entry.position !== null;
}

/**
 * The whole decision, as a pure function (rules 1–4, see the file header).
 *
 * `null` in, `null` out: a missing snapshot, an empty chapter list, nothing
 * started and nothing unread are all "there is no resume position", and the
 * detail page renders its start/read affordance for each.
 */
export function resolveResumePosition(snapshot: ResumeSnapshot | null): ResumePosition | null {
  if (snapshot === null || snapshot.chapters.length === 0) return null;

  // Defensive sort: the ORDER BY is the repository's optimization, "deepest" is
  // defined by `reading_order`, and the port does not promise an order.
  const ordered = [...snapshot.chapters].sort((a, b) => a.readingOrder - b.readingOrder);

  // Rule 1: the deepest chapter that was STARTED — completed counts as started.
  const started = ordered
    .map((chapter) => ({ chapter, position: chapter.position }))
    .filter(isStarted);
  const deepest = started[started.length - 1];
  // Rule 1: nothing was ever started → nothing to resume.
  if (deepest === undefined) return null;

  // The deepest position is still open: that IS the resume point.
  if (!deepest.position.completed) return positionAt(deepest.chapter, deepest.position);

  // Rules 2/3: it is completed → the next chapter that is not completed, at its
  // start. It has no stored position, so page 1 / offset 0 is the whole answer.
  // `reading_order` is unique per manga (`ix_chapters_manga_order`), so this walk
  // resumes exactly where the deepest chapter left off, holes included.
  for (const chapter of ordered) {
    if (chapter.readingOrder <= deepest.chapter.readingOrder) continue;
    if (chapter.position?.completed === true) continue;
    return {
      chapterId: chapter.chapterId,
      chapterNumber: chapter.chapterNumber,
      pageNumber: FIRST_PAGE,
      scrollOffset: 0,
    };
  }

  // Rule 4: everything readable is finished → null (the detail page's "read" state).
  return null;
}

/**
 * The caller-facing surface. It EXTENDS the pre-existing `ProgressReader`
 * port, so the object this factory returns can be handed straight to
 * `CatalogService`'s `progress` dependency (`catalog.service.ts`) without a
 * second adapter — and so that the catalog's `resolveResume(mangaId, caller)`
 * has an anonymous-safe entry point to delegate to.
 */
export interface ResumeService extends ProgressReader {
  /**
   * `caller: null` (anonymous) → `null`, and NOT an error: the reader's
   * position lives on the device until sign-in, so the server has nothing to
   * say.
   */
  resolveResume(mangaId: MangaId, caller: CallerContext): Promise<ResumePosition | null>;
}

/**
 * Wires the resume rules to a progress read.
 *
 * The composition root passes the Drizzle implementation; the factory is
 * exported so that root can inject it without importing the repository.
 */
export function createResumeService(deps: { reads: ResumePositionReader }): ResumeService {
  async function resolve(userId: UserId, mangaId: MangaId): Promise<ResumePosition | null> {
    return resolveResumePosition(await deps.reads.readResumeSnapshot(userId, mangaId));
  }
  return {
    /**
     * The session caller is the ONLY identity source; an anonymous request
     * never reaches the database at all.
     */
    async resolveResume(mangaId, caller) {
      if (caller === null) return null;
      return resolve(caller.userId, mangaId);
    },
    /**
     * `ProgressReader` port. `mangaId` is typed `string` by that port;
     * narrowing it to the brand here is what keeps the read below typed
     * without changing the published port.
     */
    async latestForManga(userId, mangaId) {
      return resolve(userId, mangaId as MangaId);
    },
  };
}
