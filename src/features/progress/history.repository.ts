/**
 * HistoryReader/HistoryRepository — reading history (append sessions).
 *
 * Session semantics: one row per CONTIGUOUS session per chapter, closed on
 * completion, 5-min tab-hidden, or unload; re-entry within 5 min EXTENDS the row
 * (deepest page updated, ended_at pushed). Anonymous readers get no history.
 * A deleted chapter leaves its rows (FK SET NULL) rendered as "Unavailable
 * chapter". Timestamps are server-stamped.
 */
import type { HistoryEntry } from '../../shared/contracts';
import type { ChapterId, UserId } from '../../shared/types';

export interface ProgressReader {
  /** Resume data for catalog/detail. */
  latestForManga(userId: UserId, mangaId: string): Promise<{
    chapterId: ChapterId;
    chapterNumber: number;
    pageNumber: number;
    scrollOffset: number;
  } | null>;
}

export interface HistoryRepository {
  /** Start-or-extend the current session (idempotent per 5-min window). */
  openSession(userId: UserId, input: {
    chapterId: ChapterId;
    pageNumber: number;
  }): Promise<void>;

  /** Update deepest page (called on page changes; cheap upsert). */
  touchDeepest(userId: UserId, chapterId: ChapterId, pageNumber: number): Promise<void>;

  /** Close the session (completion / hidden / unload). */
  closeSession(userId: UserId, chapterId: ChapterId): Promise<void>;

  /** History list (newest first, cursor). */
  list(userId: UserId, query: { cursor?: string; limit?: number }): Promise<{
    items: HistoryEntry[];
    nextCursor: string | null;
  }>;
}
