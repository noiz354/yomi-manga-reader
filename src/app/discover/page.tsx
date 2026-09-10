/**
 * Catalog (`/discover`) — the SSR grid, the filters and the sort.
 *
 * `force-dynamic`: HTML must be fresh enough to show a title published a minute
 * ago, and the view lives in the query string so there is no single page to
 * prerender. The catalog page and the genre vocabulary are fetched in parallel
 * and may not block each other: a facets failure degrades to a filter note while
 * the grid keeps working, and a catalog failure is the page's own focusable
 * state. The `/` alias is a separate file and remains a TODO marker.
 */
import type { Metadata } from 'next';
import { readCatalogPage, readGenreFacets } from './catalog-data';
import { CATALOG_PAGE_SIZE, catalogHref, parseCatalogView } from './catalog-query';
import { CatalogControls } from './catalog-controls';
import { CatalogResults } from './catalog-results';
import { CatalogUnavailable } from './catalog-unavailable';
import styles from './discover.module.css';

export const metadata: Metadata = {
  title: 'Catalog',
  description: 'Every published title in the library, filterable and sortable.',
};

export const dynamic = 'force-dynamic';

/** `searchParams` is a promise in Next 16, and both keys may arrive as arrays. */
type SearchParams = Record<string, string | string[] | undefined>;

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const view = parseCatalogView(await searchParams);

  // Started together, awaited separately: neither read can hold the other up.
  const pagePromise = readCatalogPage(view, CATALOG_PAGE_SIZE);
  const facetsPromise = readGenreFacets();
  const [page, facets] = await Promise.all([pagePromise, facetsPromise]);

  return (
    <div className={styles.stack}>
      <div className={styles.pageHead}>
        <h1>Catalog</h1>
      </div>

      <div className={styles.split}>
        <aside className={styles.filters} aria-labelledby="catalog-filters-h">
          <h2 id="catalog-filters-h">Filters</h2>
          <CatalogControls
            view={view}
            genres={facets.ok ? facets.data : []}
            genresUnavailable={!facets.ok}
          />
        </aside>

        <section className={styles.results} aria-labelledby="catalog-results-h">
          <div className={styles.sectionHead}>
            <h2 id="catalog-results-h">All titles</h2>
            <p className={styles.pageHeadMeta}>
              {view.genres.length > 0 || view.status !== null
                ? 'Filtered shelf — the address bar holds this view.'
                : 'Newest chapters first.'}
            </p>
          </div>

          {page.ok ? (
            <CatalogResults
              // A new shelf mounts a new island, so no appended page and no
              // cursor can survive into filters it does not belong to.
              key={catalogHref(view)}
              items={page.data.items}
              nextCursor={page.data.nextCursor}
              view={view}
              limit={CATALOG_PAGE_SIZE}
            />
          ) : (
            <CatalogUnavailable labelledBy="catalog-unavailable-h" retryHref={catalogHref(view)} />
          )}
        </section>
      </div>
    </div>
  );
}
