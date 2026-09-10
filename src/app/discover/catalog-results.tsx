'use client';

/**
 * CatalogResults — the count, the grid, the empty state and "load more".
 *
 * A client island for one reason: `nextCursor` is opaque, so only a read that
 * presents it can fetch page 2. Page 1 (and its LCP cover) is in the server
 * response. The cursor is deliberately NOT in the URL: reload is page 1, and a
 * change of view resets it by construction. The count is a live region that is
 * always in the DOM and never invents a total — the contract exposes only a
 * cursor, so it reports what is on screen and whether more exists.
 */
import { useCallback, useState } from 'react';
import type { MangaSummary } from '../../shared/contracts';
import { Button } from '../../shared/ui/Button';
import { UiLink } from '../../shared/ui/Link';
import { catalogApiQuery, type CatalogView } from './catalog-query';
import { catalogPageSchema } from './catalog-schema';
import { MangaCard } from './manga-card';
import styles from './discover.module.css';

export type CatalogResultsProps = {
  /** Page 1, rendered by the server. */
  items: readonly MangaSummary[];
  /** The opaque token for page 2, or null when the shelf is exhausted. */
  nextCursor: string | null;
  view: CatalogView;
  limit: number;
};

export function CatalogResults({ items, nextCursor, view, limit }: CatalogResultsProps) {
  const [appended, setAppended] = useState<readonly MangaSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const loadMore = useCallback(() => {
    // The `loading` guard is the double-submit guard: without it, a reader who
    // taps the button twice appends the same page twice.
    if (cursor === null || loading) return;
    setLoading(true);
    setFailure(null);

    void (async () => {
      try {
        const response = await fetch(catalogApiQuery(view, { limit, cursor }), {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          setFailure('The next page could not be loaded. The button below tries again.');
          return;
        }
        const parsed = catalogPageSchema.safeParse(await response.json());
        if (!parsed.success) {
          setFailure('The next page could not be read. The button below tries again.');
          return;
        }
        setAppended((current) => [...current, ...parsed.data.items]);
        setCursor(parsed.data.nextCursor);
      } catch {
        setFailure('The next page could not be loaded. The button below tries again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [cursor, loading, limit, view]);

  const all: readonly MangaSummary[] = [...items, ...appended];
  const count = all.length;
  const sentence =
    count === 0
      ? 'No titles match these filters.'
      : `${count} ${count === 1 ? 'title' : 'titles'}${
          cursor === null ? '' : ' so far — more available'
        }.`;

  return (
    <div>
      {/* Always present, so every change of shelf has a live region to speak
          into (see the header). */}
      <p className={styles.count} aria-live="polite" aria-atomic="true">
        {sentence}
      </p>

      {all.length === 0 ? (
        <div className={styles.state}>
          <h3>Nothing on this shelf</h3>
          <p>
            No published title matches the filters you picked. Clearing them shows the whole
            catalog. If the library is genuinely empty, an admin has to add and publish a title
            before it can appear here.
          </p>
          <UiLink className="btn" href="/discover">
            Clear the filters
          </UiLink>
        </div>
      ) : (
        <ul className={styles.grid} aria-label="Titles" aria-busy={loading || undefined}>
          {all.map((manga, index) => (
            <MangaCard key={manga.id} manga={manga} priority={index === 0} />
          ))}
        </ul>
      )}

      {failure === null ? null : (
        <p className={styles.filterNote} role="alert">
          {failure}
        </p>
      )}

      {cursor === null ? null : (
        <div className={styles.more}>
          <Button onClick={loadMore} disabled={loading} aria-busy={loading || undefined}>
            {loading ? 'Loading more titles…' : 'Load more titles'}
          </Button>
        </div>
      )}
    </div>
  );
}

export default CatalogResults;
