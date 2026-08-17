/**
 * Chapter & page contracts (the reader's data surface).
 *
 * Invariants:
 * - `pageNumber` is 1-based and contiguous 1..N at "ready" state — the reader
 *   and progress APIs depend on this.
 * - Page lists are returned in ascending pageNumber; the READER applies
 *   direction (RTL reads the same list reversed).
 * - `assetKey` values are unguessable and layout-free; variant URLs are
 *   app-relative `/media/{assetKey}.{variant}` paths, one per variant (no
 *   server-side negotiation).
 */
import type { AssetKey, ChapterId, MangaSlug } from '../types';

export type ChapterStatus = 'draft' | 'published';

/** Chapter list row. */
export interface ChapterSummary {
  id: ChapterId;
  number: number; // numeric(8,2): 10.5 is legal
  title: string | null;
  pageCount: number; // denormalized
  publishedAt: string | null; // null for drafts
}

/**
 * One page as delivered to the reader.
 * The three variant URLs are the `<picture>` ladder:
 * AVIF primary → WebP fallback → JPEG final fallback.
 *
 * NOTE: `assetKey` itself is server-internal (used by the media route);
 * client DTOs expose the variant URLs only — the raw key never needs to
 * reach the browser beyond the URL path.
 */
export interface PageAsset {
  pageNumber: number; // 1-based
  urlAvif: string; // /media/{key}
  urlWebp: string;
  urlJpeg: string;
  width: number;
  height: number;
}

/**
 * Page list response: one call, no per-page APIs.
 * `prevChapter`/`nextChapter` support neighbor navigation
 * (neighbor slugs + titles, published-only for non-admins).
 */
export interface ChapterPagesResponse {
  chapter: {
    id: ChapterId;
    mangaSlug: MangaSlug;
    mangaTitle: string;
    number: number;
    title: string | null;
    readingDirection: 'rtl' | 'ltr';
    pageCount: number;
  };
  pages: PageAsset[];
  prevChapter: { slug: MangaSlug; number: number; title: string | null } | null;
  nextChapter: { slug: MangaSlug; number: number; title: string | null } | null;
}

/**
 * Storage-backed page record (server-side view).
 * `assetKey` invariants: 128-bit random, never filename-derived,
 * never logged.
 */
export interface ChapterPageRecord {
  id: string;
  chapterId: ChapterId;
  pageNumber: number;
  assetKey: AssetKey;
  width: number;
  height: number;
  byteSizeAvif: number | null;
  byteSizeWebp: number | null;
  byteSizeJpeg: number | null;
}
