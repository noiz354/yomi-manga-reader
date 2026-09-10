/**
 * The catalog contract schemas — the one place the API's shapes are parsed.
 *
 * Two callers need them and they run in different places: the Server Component
 * validates everything it renders, and the client island validates the one page
 * it appends after a "load more". The reads themselves are `server-only`, so
 * keeping the schemas in a pure module is what lets both share one definition of
 * the contract instead of two that drift. Nothing here imports server or feature
 * code: it is shapes only.
 */
import { z } from 'zod';
import type { ChapterId, MangaId, MangaSlug } from '../../shared/types';
import { MEDIA_URL_PATTERN } from '../../shared/storage-keys';

/**
 * The wire is a string; the domain type is branded (shared/types/ids.ts). This
 * is the ONE place that difference is reconciled, and the cast is sound by
 * construction: `BRAND` is a `declare`d symbol with no runtime representation,
 * so a branded id IS its string at runtime. Doing it here rather than at each
 * call site means a `ChapterId` can never be passed where a `MangaId` belongs
 * anywhere downstream of the boundary.
 */
const mangaId = (value: string): MangaId => value as MangaId;
const mangaSlug = (value: string): MangaSlug => value as MangaSlug;
const chapterId = (value: string): ChapterId => value as ChapterId;

/** A manga's publication status. */
export const statusSchema = z.enum(['ongoing', 'completed', 'hiatus']);

/** `reading_direction`. */
export const directionSchema = z.enum(['rtl', 'ltr']);

/**
 * `coverUrl` is app-relative `/media/{assetKey}.{variant}` — the media key is a
 * capability, so the shape is the shared `MEDIA_URL_PATTERN`, not a local regex.
 * A value that is not of that form is transformed to `null`, so the card renders
 * the placeholder instead of fetching an origin the API chose. Dropping the field
 * is the safe failure: a wrong image is a worse defect than a missing one.
 */
const coverUrlSchema = z
  .string()
  .transform((value) => (MEDIA_URL_PATTERN.test(value) ? value : null))
  .nullable();

/** `numeric(8,2)` arrives as a number, but a driver may hand over a string. */
const chapterNumber = z.coerce.number();

export const mangaSummarySchema = z.object({
  id: z.string().min(1).transform(mangaId),
  slug: z.string().min(1).transform(mangaSlug),
  title: z.string().min(1),
  status: statusSchema,
  coverUrl: coverUrlSchema,
  latestChapter: z
    .object({
      number: chapterNumber,
      title: z.string().nullable(),
      publishedAt: z.string().min(1),
    })
    .nullable(),
});

export const mangaDetailSchema = mangaSummarySchema.extend({
  aliases: z.array(z.string()),
  // Plain text, never markup. The page renders it as a text node, so this stays
  // a string all the way to the DOM.
  synopsis: z.string(),
  readingDirection: directionSchema,
  chapterCount: z.coerce.number().int().nonnegative(),
  firstChapter: z.object({ id: z.string().min(1), number: chapterNumber }).nullable(),
  creators: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      role: z.enum(['author', 'artist', 'other']),
    }),
  ),
  genres: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
  tags: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
  createdAt: z.string().min(1),
  // OPTIONAL and never null: absent for an anonymous caller (the reader's
  // position lives on the device until sign-in) and absent again when the caller
  // simply has no position yet. A missing key and a `null` are different answers
  // here, so the schema is `.optional()` and NOT `.nullable()`.
  //
  // It is currently always absent in this deployment, because the API's caller
  // resolver is the anonymous default. The field is parsed and rendered anyway so
  // that landing the session changes nothing outside this file.
  continueReading: z
    .object({
      chapterId: z.string().min(1),
      chapterNumber: chapterNumber,
      pageNumber: z.coerce.number().int().nonnegative(),
    })
    .optional(),
});

export const chapterSummarySchema = z.object({
  id: z.string().min(1).transform(chapterId),
  number: chapterNumber,
  title: z.string().nullable(),
  pageCount: z.coerce.number().int().nonnegative(),
  /** null for a draft — which is how the UI knows to label one, since `status`
   *  itself is not in the list payload. */
  publishedAt: z.string().nullable(),
});

export const catalogPageSchema = z.object({
  items: z.array(mangaSummarySchema),
  nextCursor: z.string().min(1).nullable(),
});

export const chapterListSchema = z.object({
  items: z.array(chapterSummarySchema),
});

/**
 * `GET /api/v1/catalog/facets`.
 *
 * The operation has no contract row, and Genre has an `id` plus a unique `name`
 * with no `slug` column — while the catalog filters by slug. The facets response
 * therefore carries a `slug` per genre derived server-side from that unique name,
 * and the UI treats the slug as opaque: it never derives, normalises or guesses
 * one, so a contract change is confined to this schema. `items` is accepted as a
 * synonym for `genres` so a differently-spelled handler degrades to a working
 * filter instead of a silently empty one.
 */
export const facetsSchema = z.union([
  z.object({
    genres: z.array(z.object({ slug: z.string().min(1), name: z.string().min(1) })),
  }),
  z.object({
    items: z.array(z.object({ slug: z.string().min(1), name: z.string().min(1) })),
  }),
]);

/** One genre as the filter needs it. */
export interface GenreFacet {
  readonly slug: string;
  readonly name: string;
}

/** The facets payload, whichever spelling arrived. */
export function facetsFrom(parsed: z.infer<typeof facetsSchema>): GenreFacet[] {
  return 'genres' in parsed ? parsed.genres : parsed.items;
}
