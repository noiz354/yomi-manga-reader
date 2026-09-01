/**
 * The members' contract schemas — the one place the three personal lists are
 * parsed, exactly as `shared/contracts/library.ts` declares them.
 *
 * Shapes only, so a page, a server read and a client island share ONE
 * definition instead of three that drift. It is a module rather than a page
 * because the paginating islands must validate appended pages as strictly as
 * the server did.
 *
 * Enforced rules: `coverUrl` must be app-relative `/media/{assetKey}.{variant}`
 * or it becomes `null` rather than fetching an origin the API chose;
 * `chapter: null` is a REAL state, a retained row with the jump disabled;
 * `pageNumber: null` means the chapter's first page, not "unknown";
 * `unavailable: true` means unpublished or soft-deleted and the entry is kept.
 */
import { z } from 'zod';
import type { ChapterId, MangaId, MangaSlug } from '../../shared/types';
import { MEDIA_URL_PATTERN } from '../../shared/storage-keys';

/**
 * The wire carries a string; the domain type is branded (shared/types/ids.ts).
 * The cast is sound by construction — a `BRAND` is a `declare`d symbol with no
 * runtime representation, so a branded id IS its string at runtime — and doing it
 * here rather than at each call site means a `ChapterId` can never be passed
 * where a `MangaId` belongs anywhere downstream of the wire.
 */
const mangaId = (value: string): MangaId => value as MangaId;
const mangaSlug = (value: string): MangaSlug => value as MangaSlug;
const chapterId = (value: string): ChapterId => value as ChapterId;

/** Every timestamp in this lane is ISO-8601 UTC. */
const isoDate = z.string().min(1);

/**
 * `chapter.number` is `numeric(8,2)`, so a special chapter "10.5" is legal and
 * must survive the round trip. Coerced rather than asserted, because a driver
 * may hand over the string form.
 */
const chapterNumber = z.coerce.number();

/** A whole-number field that is a COUNT or a PAGE, never a measurement. */
const wholeNumber = z.coerce.number().int();

/** See the header: an off-shape URL degrades to the placeholder, never to a fetch. */
const coverUrlSchema = z
  .string()
  .transform((value) => (MEDIA_URL_PATTERN.test(value) ? value : null))
  .nullable();

/**
 * `MangaSummary` as the shelf carries it (shared/contracts/manga.ts). A
 * library entry's manga block is complete even when the title is unavailable —
 * that is what makes "still on your shelf, cannot be opened" renderable.
 */
const mangaSummary = z.object({
  id: z.string().min(1).transform(mangaId),
  slug: z.string().min(1).transform(mangaSlug),
  title: z.string().min(1),
  status: z.enum(['ongoing', 'completed', 'hiatus']),
  coverUrl: coverUrlSchema,
  latestChapter: z
    .object({
      number: chapterNumber,
      title: z.string().nullable(),
      publishedAt: isoDate,
    })
    .nullable(),
});

/** One page of anything: items, plus the opaque token for the next one. */
function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().min(1).nullable() });
}

/** `LibraryEntry`. */
export const libraryEntrySchema = z.object({
  manga: mangaSummary,
  addedAt: isoDate,
  /**
   * `null` is the ABSENCE of a progress row: a title added and never opened, a
   * real state the page names rather than a gap it papers over.
   */
  lastRead: z
    .object({
      chapterNumber,
      pageNumber: wholeNumber,
      at: isoDate,
    })
    .nullable(),
  /** Published − completed, computed in one statement (no N+1). */
  unreadChapterCount: wholeNumber.nonnegative(),
  /** Unpublished or soft-deleted, entry retained, reading 404s. */
  unavailable: z.boolean(),
});

export const libraryPageSchema = page(libraryEntrySchema);

/**
 * The chapter a mark points at. `null` is the deleted-chapter case, so it is the
 * whole of the `bookmark.chapter_id ON DELETE SET NULL` rule: the row is kept,
 * the jump is not offered, and the page says why in words.
 */
const chapterRef = z.object({
  id: z.string().min(1).transform(chapterId),
  number: chapterNumber,
  mangaSlug: z.string().min(1).transform(mangaSlug),
  mangaTitle: z.string(),
});

/** `Bookmark`. */
export const bookmarkSchema = z.object({
  id: z.string().min(1),
  chapter: chapterRef.nullable(),
  /**
   * Deliberately `int()` and NOT `positive()`: the model gives
   * `bookmark.page_number` no `>= 1` CHECK. A bound invented HERE would
   * reject a whole list because of one row the spec permits, and the reader
   * would see "your bookmarks are unavailable" instead of their bookmarks.
   */
  pageNumber: z.number().int().nullable(),
  /** Plain text, ≤ 280 characters. Rendered as a text node. */
  note: z.string(),
  createdAt: isoDate,
});

export const bookmarkPageSchema = page(bookmarkSchema);

/** `HistoryEntry`. */
export const historyEntrySchema = z.object({
  chapter: chapterRef.nullable(),
  deepestPage: wholeNumber,
  startedAt: isoDate,
  /** `null` is an OPEN session (tab never closed cleanly), not a missing field. */
  endedAt: isoDate.nullable(),
  durationMs: z.number().nullable(),
});

export const historyPageSchema = page(historyEntrySchema);
