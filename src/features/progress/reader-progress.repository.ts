/**
 * ReaderProgressRepository — stores and retrieves the user's latest reading
 * position. The feature layer depends on this abstraction rather than the
 * database directly.
 *
 * Semantics: save is an idempotent upsert; last-write-wins on the server-stamped
 * `updated_at` (client timestamps are merge input only, never trusted); and
 * `completed` is sticky here — a page write can set it true but cannot unset it.
 */
import type { ReaderProgress } from '../../shared/contracts';
import type { ChapterId, UserId } from '../../shared/types';

export interface SaveReaderProgressInput {
  chapterId: ChapterId;
  /** 1-based; validated against chapter pageCount before reaching here. */
  pageNumber: number;
  /** 0..1 (vertical offset); 0 for paged writes. */
  scrollPosition: number;
  /** Sticky (see semantics). */
  completed?: boolean;
}

export interface ReaderProgressRepository {
  /**
   * Persist the current reader position.
   *
   * TODO: define persistence behavior (upsert on (user_id, chapter_id); server
   * timestamp; sticky completed; idempotent). Also update the library
   * denormalized `last_read_at`.
   */
  saveProgress(userId: UserId, input: SaveReaderProgressInput): Promise<void>;

  /**
   * Retrieve the most recent position for a chapter.
   *
   * TODO: single indexed read (PK); null when none. Edge case: stored page >
   * current pageCount (re-ingest shrank the chapter) — the SERVICE clamps; the
   * repository returns raw.
   */
  getProgress(userId: UserId, chapterId: ChapterId): Promise<ReaderProgress | null>;

  /**
   * Merge: apply an anonymous local set on sign-in — per chapter, latest wins
   * (client timestamp as the merge input, then server-stamped). Invalid entries
   * (unknown chapter, page out of range) are dropped, counted, not fatal.
   */
  mergeProgress(
    userId: UserId,
    entries: Array<{
      chapterId: ChapterId;
      pageNumber: number;
      completed?: boolean;
      clientUpdatedAt: string;
    }>,
  ): Promise<{ applied: number; dropped: number }>;

  /** Bulk read for the library list (completed set per user, ≤ 1000 chapters). */
  getCompletedSet(userId: UserId, chapterIds: ChapterId[]): Promise<Set<ChapterId>>;

  /**
   * Clear `completed` for one chapter — the only unset path.
   *
   * It exists as its own operation and not as `saveProgress({ completed:
   * false })` because the save path is sticky-OR by contract: `SET completed =
   * reading_progress.completed OR excluded.completed`. A `false` there is
   * structurally incapable of clearing a `true`, so the read-status feature could
   * only either lie about having marked a chapter unread or be wired to a no-op.
   * The sticky-OR stays: it is what stops a stale page write from un-finishing a
   * chapter. Those are two different intents, so they are two different
   * operations.
   *
   * Scope, deliberately narrow:
   * - Clears `completed` ONLY. `pageNumber` and `scrollPosition` are left alone, so
   *   "unread" means "not finished", not "start over" — the resume rules
   *   (`features/progress/resume.service.ts`) will still point at the stored page.
   *   Rewinding the position is a different decision with a different cost (it
   *   discards where the reader was) and is not implied by unmarking a chapter.
   * - A chapter with NO progress row is a no-op, not a throw: "not started" and
   *   "explicitly marked unread" agree, and a reader has no row to clear.
   * - Another user's row is never touched: the write is keyed on `userId`, so
   *   there is nothing to get wrong.
   * - Its OWN LWW guard, on the server clock like `saveProgress`. A stale unset
   *   must not un-finish a chapter the reader completed a moment later.
   */
  unsetCompleted(userId: UserId, chapterId: ChapterId): Promise<void>;
}
