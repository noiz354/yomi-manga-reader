/**
 * Admin write ports — the operations the curator needs that no read port may
 * grow (features/admin owns them; server/db implements them).
 *
 * Why separate ports and not methods on `MangaRepository` / `ChapterRepository`:
 * those are READ ports with dozens of fakes across the suite, every one of which
 * would break the day an admin write landed on the interface. More importantly,
 * admin reads are UNSCOPED — drafts, unpublished and soft-deleted rows are the
 * working material, not the exception — while every read-port method scopes
 * visibility by caller. One interface cannot honestly promise both "you see
 * only what you may" and "you see everything".
 */
import type { ChapterId, MangaId, UserId } from '../../shared/types';

/** A manga row as the curator sees it: everything, including the hidden. */
export interface AdminMangaRow {
  id: string;
  slug: string;
  title: string;
  synopsis: string;
  status: 'ongoing' | 'completed' | 'hiatus';
  readingDirection: 'rtl' | 'ltr';
  published: boolean;
  deletedAt: string | null;
}

/** A chapter row as the curator sees it. */
export interface AdminChapterRow {
  id: string;
  mangaId: string;
  /** Chapter numbers are `numeric(8,2)` on the wire as strings. */
  number: string;
  title: string | null;
  notes: string;
  status: 'draft' | 'published';
  publishedAt: string | null;
  pageCount: number;
  readingOrder: number;
  deletedAt: string | null;
}

export interface AdminMangaInput {
  title: string;
  slug?: string;
  synopsis?: string;
  status: 'ongoing' | 'completed' | 'hiatus';
  readingDirection: 'rtl' | 'ltr';
  genreNames: string[];
  tagNames: string[];
  creators: Array<{ name: string; role: 'author' | 'artist' | 'other' }>;
}

export interface AdminMangaPatch {
  title?: string;
  slug?: string;
  synopsis?: string;
  status?: 'ongoing' | 'completed' | 'hiatus';
  readingDirection?: 'rtl' | 'ltr';
  genreNames?: string[];
  tagNames?: string[];
  creators?: Array<{ name: string; role: 'author' | 'artist' | 'other' }>;
}

export interface AdminMangaRepository {
  /** Every title, newest first — drafts, unpublished and soft-deleted included. */
  listAll(): Promise<AdminMangaRow[]>;
  getById(id: MangaId): Promise<AdminMangaRow | null>;
  getBySlug(slug: string): Promise<AdminMangaRow | null>;
  /**
   * Insert the manga and its links in one transaction.
   *
   * @throws {AppError} `MANGA_SLUG_TAKEN` when the slug is in use — checked
   *   first, so a conflict is a typed error and never a unique-violation 500.
   */
  create(input: AdminMangaInput): Promise<{ id: MangaId }>;
  /**
   * Patch scalar fields and, when named, replace link sets wholesale.
   *
   * @throws {AppError} `MANGA_NOT_FOUND` for an unknown id — checked first, so
   *   a typo is a 404 rather than an FK error further down.
   */
  update(id: MangaId, patch: AdminMangaPatch): Promise<void>;
  /** Flip the `published` flag. A transition, not a blind write (see service). */
  setPublished(id: MangaId, published: boolean): Promise<void>;
}

export interface AdminChapterInput {
  /** Chapter number as the curator typed it (`numeric(8,2)` — "10.5" is real). */
  number: string;
  title?: string | null;
  notes?: string;
}

export interface AdminChapterPatch {
  number?: string;
  title?: string | null;
  notes?: string;
}

export interface AdminChapterRepository {
  /** Every chapter of the title in `reading_order` — drafts included. */
  listByManga(mangaId: MangaId): Promise<AdminChapterRow[]>;
  getById(id: ChapterId): Promise<AdminChapterRow | null>;
  /**
   * Append a chapter at the end of the reading order.
   *
   * @throws {AppError} `MANGA_NOT_FOUND` for an unknown manga — checked first,
   *   so the FK never fires. `CHAPTER_DUPLICATE_NUMBER` when the number is
   *   taken on this title.
   */
  create(mangaId: MangaId, input: AdminChapterInput): Promise<{ id: ChapterId }>;
  /**
   * Patch number/title/notes.
   *
   * @throws {AppError} `CHAPTER_NOT_FOUND` for an unknown id; a number taken by
   *   a SIBLING chapter is `CHAPTER_DUPLICATE_NUMBER` (keeping the chapter's
   *   own number is fine).
   */
  update(id: ChapterId, patch: AdminChapterPatch): Promise<void>;
  /**
   * Set status and stamp together: publishing a never-published chapter stamps
   * `published_at` with the server clock; unpublishing keeps the stamp and
   * returns status to `draft`, so "unpublished" and "never published" stay
   * distinguishable; re-publishing never overwrites the first stamp.
   */
  setPublishState(
    id: ChapterId,
    status: 'draft' | 'published',
    publishedAt: string | null,
  ): Promise<void>;
  /**
   * Reassign `reading_order` for a title from the full ordered id list.
   *
   * The list must name EXACTLY the title's chapters — no more, no fewer — so a
   * caller cannot silently drop a chapter out of the order. Applied in one
   * transaction in two phases (negative placeholders, then final values),
   * because the `(manga_id, reading_order)` unique index is checked per row and
   * a direct swap would collide with itself halfway through.
   *
   * @throws {AppError} `CHAPTER_NOT_FOUND` when an id is unknown or belongs to
   *   another title; `VALIDATION_BAD_QUERY` when the set does not match.
   */
  reorder(mangaId: MangaId, orderedIds: ChapterId[]): Promise<void>;
}

/** The actor an admin operation is audited against. */
export interface AdminActor {
  userId: UserId;
}
