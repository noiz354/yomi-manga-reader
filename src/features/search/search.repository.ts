/**
 * SearchRepository port (features/search owns the rules; server/db
 * implements the trigram query).
 *
 * Implementation constraints (the EXPLAIN gate will check these):
 * - GIN trigram indexes on manga.title + manga_alias.alias (pg_trgm)
 *   — no seq scan at 10k rows.
 * - One composed query (per-field weighted UNION) — no N+1 fan-out.
 * - Visibility filter (published ∧ ¬deleted) IN the query.
 * - p95 ≤ 400 ms at 10k titles.
 */
export interface SearchRepository {
  /**
   * Raw ranked rows (before SearchService shaping): field, weight-band,
   * target id/slug/title. `q` is parameterized — the trigram operators
   * (% / similarity) and the prefix path (LIKE 'q%') are the ONLY
   * query shapes (no dynamic SQL).
   */
  searchRaw(input: {
    q: string;
    limit: number;
    cursor: string | null;
  }): Promise<{
    rows: Array<{
      kind: 'manga' | 'creator' | 'tag';
      id: string;
      slug: string | null;
      title: string;
      matchField: 'title' | 'alias' | 'creator' | 'tag';
      /** Integer score band. */
      band: 'exact' | 'prefix' | 'contains' | 'related';
      score: number;
    }>;
    nextCursor: string | null;
  }>;
}
