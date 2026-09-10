'use client';

/**
 * CatalogControls — the genre, status and sort controls.
 *
 * URL-driven, and the URL is the only state: every control writes to the query
 * string and the server re-reads it, so there is no second source of truth to
 * drift from the address bar. Chips are real `<button aria-pressed>`s and selects
 * are native, so platform keyboard handling applies, and Escape clears every genre
 * only while focus is inside the genre group.
 * The controls need JavaScript; the grid and its links do not.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { MangaStatus } from '../../shared/contracts';
import { Button } from '../../shared/ui/Button';
import {
  catalogHref,
  MANGA_STATUSES,
  MAX_GENRES,
  SORT_LABEL,
  STATUS_LABEL,
  type CatalogSort,
  type CatalogView,
} from './catalog-query';
import type { GenreFacet } from './catalog-schema';
import styles from './discover.module.css';

export type CatalogControlsProps = {
  view: CatalogView;
  /** The genre vocabulary; empty when the facets call failed. */
  genres: readonly GenreFacet[];
  /** True when the vocabulary could not be read, so the filter says so. */
  genresUnavailable: boolean;
};

const SORT_ORDER: readonly CatalogSort[] = ['updated_desc', 'title_asc', 'added_desc'];

export function CatalogControls({
  view,
  genres,
  genresUnavailable,
}: CatalogControlsProps) {
  const router = useRouter();
  // The cap message is state because it is a consequence of an ACTION, not of
  // the URL: the URL never contains a refused selection.
  const [capNotice, setCapNotice] = useState<string | null>(null);

  const go = useCallback(
    (next: CatalogView) => {
      // scroll: false — a filter change is not a new page. Jumping the reader
      // back to the top because they unticked "Drama" is the kind of small
      // rudeness that makes a filter feel hostile.
      router.push(catalogHref(next), { scroll: false });
    },
    [router],
  );

  const toggleGenre = useCallback(
    (slug: string) => {
      setCapNotice(null);
      const selected = view.genres.includes(slug);
      if (!selected && view.genres.length >= MAX_GENRES) {
        setCapNotice(
          `Choose up to ${MAX_GENRES} genres. Clear one first to add another.`,
        );
        return;
      }
      go({
        ...view,
        genres: selected
          ? view.genres.filter((value) => value !== slug)
          : [...view.genres, slug],
      });
    },
    [go, view],
  );

  const clearGenres = useCallback(() => {
    if (view.genres.length === 0) return;
    setCapNotice(null);
    go({ ...view, genres: [] });
  }, [go, view]);

  const clearAll = useCallback(() => {
    setCapNotice(null);
    go({ genres: [], status: null, sort: 'updated_desc' });
  }, [go]);

  const hasFilters = view.genres.length > 0 || view.status !== null;
  const genreSummary = `Togglable genre filters. Choose up to ${MAX_GENRES}. Escape clears every genre.`;

  return (
    <div className={styles.filtersBody}>
      <div className={styles.field}>
        <p className={styles.filterNote} id="catalog-genre-hint">
          {genreSummary}
        </p>
        {/*
          The group is the scroll container when there are many genres, so the
          key handler lives on it: Escape works from any chip and from nowhere
          else on the page.
        */}
        {genresUnavailable ? (
          <p className={styles.filterNote} role="status">
            The genre list could not be loaded, so filtering by genre is unavailable. Status and
            sort still work.
          </p>
        ) : (
          <div
            className={styles.genres}
            role="group"
            aria-label="Genres"
            aria-describedby="catalog-genre-hint"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                clearGenres();
              }
            }}
          >
            {genres.map((genre) => (
              <button
                key={genre.slug}
                type="button"
                className={styles.chip}
                aria-pressed={view.genres.includes(genre.slug)}
                onClick={() => toggleGenre(genre.slug)}
              >
                {genre.name}
              </button>
            ))}
          </div>
        )}
        {capNotice === null ? null : (
          <p className={styles.filterNote} role="status">
            {capNotice}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <label htmlFor="catalog-status">Status</label>
        <select
          id="catalog-status"
          name="status"
          value={view.status ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            go({
              ...view,
              status: next === '' ? null : (next as MangaStatus),
            });
          }}
        >
          <option value="">Any status</option>
          {MANGA_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label htmlFor="catalog-sort">Sort</label>
        <select
          id="catalog-sort"
          name="sort"
          value={view.sort}
          onChange={(event) => {
            go({ ...view, sort: event.target.value as CatalogSort });
          }}
        >
          {SORT_ORDER.map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABEL[sort]}
            </option>
          ))}
        </select>
      </div>

      {hasFilters ? (
        <div className={styles.filterActions}>
          <Button onClick={clearAll}>Clear filters</Button>
        </div>
      ) : null}
    </div>
  );
}

export default CatalogControls;
