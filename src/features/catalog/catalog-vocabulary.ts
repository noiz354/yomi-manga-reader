/**
 * The catalog VOCABULARY port (`GET /api/v1/catalog/facets`), declared in the
 * feature that owns the consumer so the DAG stays acyclic.
 *
 * Deliberately NO counts: a count per genre is an aggregate over the whole
 * `manga_genre` join on a public endpoint — a different query and index.
 * `onlyUsed` narrows the vocabulary to genres/tags linked to a visible manga.
 */
export interface CatalogVocabularyQuery {
  /**
   * Restrict to vocabulary rows linked to at least one VISIBLE manga. Default
   * `true` (a control that can only ever return 0 results is not a filter).
   */
  readonly onlyUsed?: boolean;
}

/**
 * One genre as the FILTER control needs it: the row plus the slug the request
 * vocabulary uses.
 *
 * Why the slug travels in the response when `Genre` (the shape inside
 * `MangaDetail`) does not carry it:
 *
 * - The catalog filter accepts a csv of **slugs**, and the control has to put
 *   one on the wire. A response of `{ id, name }` therefore leaves the client
 *   with a choice: send `id` (which the filter does not accept) or re-derive
 *   the slug itself.
 * - Re-deriving is what broke. The rule already exists twice — TypeScript
 *   (`normaliseGenreSlug`) and SQL (`genreSlugSql`) — and a third copy in the
 *   client is a third chance to disagree with both.
 * - The server already computes the slug (it has to, to filter). Emitting it
 *   costs one selected column and makes the round trip exact.
 *
 * So: the derivation has ONE definition, the server applies it, and the client
 * sends back what it was given.
 *
 * The detail page needs no slug — it renders `name` only — which is why
 * `MangaDetail.genres` stays `Genre[]`.
 */
export interface GenreFacet {
  readonly id: string;
  readonly name: string;
  /** The name-derived slug the catalog filter accepts (`genreSlugSql`). */
  readonly slug: string;
}

/** One tag, with the same reasoning as {@link GenreFacet}. */
export interface TagFacet {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface CatalogFacets {
  readonly genres: GenreFacet[];
  readonly tags: TagFacet[];
}

export interface CatalogVocabularyPort {
  /**
   * The whole genre and tag vocabulary in one read each (two bounded queries
   * total — the tables are controlled-vocabulary sized, and both are covered
   * by their own unique-name index).
   */
  listVocabulary(query: CatalogVocabularyQuery): Promise<CatalogFacets>;
}
