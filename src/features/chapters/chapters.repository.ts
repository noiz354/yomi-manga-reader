/**
 * ChapterRepository port: features/chapters owns the aggregate rules;
 * server/db implements.
 *
 * - Order is `reading_order`; `(manga_id, reading_order)` is the UNIQUE
 *   hot-path index.
 * - Page lists are ascending pageNumber, one PK range scan, one query (no N+1).
 * - Drafts are admin-only; published chapters are public when the manga is.
 */
import type { CallerContext, ChapterPageRecord, ChapterPagesResponse, ChapterSummary } from '../../shared/contracts';
import type { ChapterId, MangaId } from '../../shared/types';

export interface ChapterRepository {
  /** Ordered list for a manga (visibility-aware: caller decides drafts). */
  listByManga(mangaId: MangaId, caller: CallerContext): Promise<ChapterSummary[]>;

  byId(id: ChapterId, caller: CallerContext): Promise<ChapterSummary | null>;

  /** Page list (ordered) + prev/next published neighbors. */
  pageList(id: ChapterId, caller: CallerContext): Promise<ChapterPagesResponse | null>;

  /** Raw page records (server-side: commit verification, media GC). */
  pageRecords(chapterId: ChapterId): Promise<ChapterPageRecord[]>;

  create(input: {
    mangaId: MangaId;
    number: number; // numeric(8,2)
    title: string | null;
    notes: string;
  }): Promise<ChapterId>;

  update(id: ChapterId, patch: Partial<{ number: number; title: string | null; notes: string }>): Promise<void>;

  softDelete(id: ChapterId): Promise<void>;
  setPublished(id: ChapterId, published: boolean): Promise<void>;

  /**
   * The atomic commit used by the upload pipeline: insert the full 1..N page
   * set + update chapter.page_count in ONE transaction. Re-ingest variant
   * replaces the set (old rows deleted, old asset keys returned for GC queuing).
   *
   * Edge cases: contiguity assertion; manga-deleted race (typed failure);
   * concurrent commit (advisory lock).
   */
  commitPages(input: {
    chapterId: ChapterId;
    pages: Array<{ pageNumber: number; assetKey: string; width: number; height: number; byteSizeAvif: number | null; byteSizeWebp: number | null; byteSizeJpeg: number | null }>;
    replace: boolean;
  }): Promise<{ replacedAssetKeys: string[] }>;

  countByManga(mangaId: MangaId): Promise<number>;
  countAll(): Promise<number>; // stats
  countPages(): Promise<number>; // stats
}
