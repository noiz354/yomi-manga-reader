/**
 * Manga domain contracts (catalog surface).
 *
 * Rules:
 * - DTOs are the only manga shapes crossing module boundaries.
 * - `synopsis` is PLAIN TEXT (never HTML).
 * - The visibility rule `published && !deleted` lives in features/manga (single
 *   function, unit-tested) — NOT re-implemented per query site.
 */
import type { MangaId, MangaSlug } from '../types';

export type MangaStatus = 'ongoing' | 'completed' | 'hiatus';
/** Reading direction of the title. */
export type ReadingDirection = 'rtl' | 'ltr';
export type CreatorRole = 'author' | 'artist' | 'other';

export interface Genre {
  id: string;
  name: string;
}

export interface Tag {
  id: string;
  name: string;
}

export interface Creator {
  id: string;
  name: string;
  role: CreatorRole;
}

/**
 * Catalog card shape.
 * Invariants:
 * - `coverUrl` is app-relative `/media/{assetKey}.jpeg` — never a storage URL
 *   (the JPEG variant, built by `mediaUrlFor`).
 * - `latestChapter` is null for manga with no published chapters.
 */
export interface MangaSummary {
  id: MangaId;
  slug: MangaSlug;
  title: string;
  status: MangaStatus;
  coverUrl: string | null;
  latestChapter: {
    number: number;
    title: string | null;
    publishedAt: string; // ISO-8601 UTC
  } | null;
}

/**
 * Full detail shape — everything the detail page renders.
 * `continueReading` is present only for authenticated callers with progress;
 * absent for anonymous callers (not null — optional).
 */
export interface MangaDetail extends MangaSummary {
  aliases: string[];
  synopsis: string;
  readingDirection: ReadingDirection;
  chapterCount: number;
  firstChapter: { id: string; number: number } | null;
  creators: Creator[];
  genres: Genre[];
  tags: Tag[];
  createdAt: string;
  /**
   * Absent, never null: absent for an anonymous caller and absent again for a
   * caller with no position yet. The explicit `| undefined` is what "may be
   * absent" means under `exactOptionalPropertyTypes` — a Zod `.optional()`
   * produces `T | undefined`, and without it a correctly-parsed response is a
   * type error.
   */
  continueReading?:
    | {
        chapterId: string;
        chapterNumber: number;
        pageNumber: number;
      }
    | undefined;
}
