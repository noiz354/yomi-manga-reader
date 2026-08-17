/** Search DTOs. */

export interface SearchHit {
  /** What matched (client renders a hint: "title" vs "tag"…). */
  kind: 'manga' | 'creator' | 'tag';
  id: string;
  /** For manga hits: the detail-page slug (creator/tag: null — v1 has no creator/tag browse pages). */
  slug: string | null;
  title: string;
  matchField: 'title' | 'alias' | 'creator' | 'tag';
  /** Deterministic ranking band. */
  band: 'exact' | 'prefix' | 'contains' | 'related';
}
