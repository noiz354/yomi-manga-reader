/**
 * The `CatalogVocabularyPort` implementation, the read behind
 * `GET /api/v1/catalog/facets`.
 * `onlyUsed` asks whether a vocabulary row is reachable from a public catalog
 * result, and the answer is the shared visibility rule — imported, never
 * restated. One bounded select per table, no counts, and the `IN (subquery)`
 * semi-join is one statement per table rather than one per genre.
 */
import { asc, eq, inArray } from 'drizzle-orm';

import type {
  CatalogFacets,
  CatalogVocabularyPort,
  GenreFacet,
  TagFacet,
} from '../../../features/catalog';
import type { Db } from '../client';
import { genre, manga, mangaGenre, mangaTag, tag } from '../schema';
import { genreSlugSql, mangaVisibleWhere } from './manga.repository';

/** The distinct genre ids carried by at least one VISIBLE manga. */
function usedGenreIds(db: Db) {
  return db
    .select({ id: mangaGenre.genreId })
    .from(mangaGenre)
    .innerJoin(manga, eq(manga.id, mangaGenre.mangaId))
    .where(mangaVisibleWhere());
}

/** The distinct tag ids carried by at least one VISIBLE manga. */
function usedTagIds(db: Db) {
  return db
    .select({ id: mangaTag.tagId })
    .from(mangaTag)
    .innerJoin(manga, eq(manga.id, mangaTag.mangaId))
    .where(mangaVisibleWhere());
}

/**
 * Builds the vocabulary port over a live Drizzle handle.
 *
 * @param db the application pool from `createDb` (composed at the root; never
 *   constructed at import time)
 * @returns the port
 */
export function createGenreTagVocabularyPort(db: Db): CatalogVocabularyPort {
  return {
    /**
     * `onlyUsed` defaults to `true` here as well as on the port, so a caller
     * that omits the flag gets the narrowing rather than the whole table — the
     * safe direction for a public endpoint.
     */
    async listVocabulary(query): Promise<CatalogFacets> {
      const onlyUsed = query.onlyUsed ?? true;
      const [genreRows, tagRows] = await Promise.all([
        db
          .select({ id: genre.id, name: genre.name, slug: genreSlugSql(genre.name) })
          .from(genre)
          .where(onlyUsed ? inArray(genre.id, usedGenreIds(db)) : undefined)
          .orderBy(asc(genre.name)),
        db
          .select({ id: tag.id, name: tag.name, slug: genreSlugSql(tag.name) })
          .from(tag)
          .where(onlyUsed ? inArray(tag.id, usedTagIds(db)) : undefined)
          .orderBy(asc(tag.name)),
      ]);
      return {
        genres: genreRows.map((row): GenreFacet => ({ id: row.id, name: row.name, slug: row.slug })),
        tags: tagRows.map((row): TagFacet => ({ id: row.id, name: row.name, slug: row.slug })),
      };
    },
  };
}
