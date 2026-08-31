/**
 * Library & bookmark repository ports (features/library owns the rules;
 * server/db implements them).
 *
 * Invariants:
 * - LibraryEntry PK is (user_id, manga_id) — add is an upsert no-op;
 *   remove is idempotent-204 (documented client simplification).
 * - `last_read_at` denormalization is written by the PROGRESS service
 *   (single-writer chain); this repository only reads it for sorting.
 * - Bookmarks unique per (user, chapter, page) — 409 on duplicate.
 * - Deleted chapters: FK SET NULL, rows retained (rendered unavailable).
 */
import type { Bookmark, LibraryEntry } from '../../shared/contracts';
import type { BookmarkId, ChapterId, MangaId, UserId } from '../../shared/types';
import type { LibrarySort } from '../../shared/contracts';

export interface LibraryRepository {
  /** Upsert (idempotent no-op when present). */
  add(userId: UserId, mangaId: MangaId): Promise<void>;
  /** Delete (no-op when absent). */
  remove(userId: UserId, mangaId: MangaId): Promise<void>;
  has(userId: UserId, mangaId: MangaId): Promise<boolean>;
  list(userId: UserId, query: { cursor?: string; limit?: number; sort: LibrarySort }): Promise<{
    items: LibraryEntry[];
    nextCursor: string | null;
  }>;
  /** Stats. */
  countAll(): Promise<number>;
}

export interface BookmarkRepository {
  create(input: {
    userId: UserId;
    chapterId: ChapterId;
    pageNumber: number | null;
    note: string;
  }): Promise<Bookmark>; // ⇒ LIBRARY_BOOKMARK_EXISTS on duplicate page
  list(userId: UserId, query: { cursor?: string; limit?: number }): Promise<{
    items: Bookmark[];
    nextCursor: string | null;
  }>;
  delete(userId: UserId, id: BookmarkId): Promise<boolean>; // false ⇒ 404
}
