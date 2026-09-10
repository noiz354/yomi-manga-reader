/**
 * Catalog view state: the URL is the state.
 *
 * Every control writes to the query string and the page re-reads it on the
 * server, so a filtered shelf is shareable, refresh keeps it and Back works.
 * Parsing is TOTAL: `sort`/`status` are whitelists with unknown values DROPPED
 * (the API 422s them), `genre` accepts slug characters, de-duplicated and
 * capped at {@link MAX_GENRES}. Pure and dependency-free: imported by the page
 * and by the client islands.
 */
import type { MangaStatus } from '../../shared/contracts';

/** The catalog sorts. */
export const CATALOG_SORTS = ['title_asc', 'updated_desc', 'added_desc'] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

/** The default sort. */
export const DEFAULT_SORT: CatalogSort = 'updated_desc';

/** The manga statuses. */
export const MANGA_STATUSES = ['ongoing', 'completed', 'hiatus'] as const;

/** `genre?` is a csv of at most 5 slugs. */
export const MAX_GENRES = 5;

/** `limit?` ≤ 48, default 24. */
export const CATALOG_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 48;

/** A genre slug as it appears in the URL: lowercase, digits, dashes. */
const GENRE_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** The parsed, whitelisted view state the page renders. */
export interface CatalogView {
  /** Selected genre slugs, de-duplicated, in URL order, ≤ {@link MAX_GENRES}. */
  genres: readonly string[];
  status: MangaStatus | null;
  sort: CatalogSort;
}

/** Next's `searchParams` for a page: each key may arrive as an array. */
type RawParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function isSort(value: string): value is CatalogSort {
  return (CATALOG_SORTS as readonly string[]).includes(value);
}

function isStatus(value: string): value is MangaStatus {
  return (MANGA_STATUSES as readonly string[]).includes(value);
}

/**
 * Reads the view state out of a page's `searchParams`. Total: junk in, valid
 * state out, never a throw and never a forwarded value the API would reject.
 */
export function parseCatalogView(params: RawParams): CatalogView {
  const seen = new Set<string>();
  for (const part of single(params['genre']).split(',')) {
    const slug = part.trim().toLowerCase();
    if (slug === '' || !GENRE_SLUG.test(slug)) continue;
    if (seen.has(slug)) continue;
    if (seen.size >= MAX_GENRES) break;
    seen.add(slug);
  }

  const rawStatus = single(params['status']);
  const rawSort = single(params['sort']);

  return {
    genres: [...seen],
    status: isStatus(rawStatus) ? rawStatus : null,
    sort: isSort(rawSort) ? rawSort : DEFAULT_SORT,
  };
}

/** The query string for a view: absent parameters are absent, not empty. */
export function catalogSearchParams(view: Partial<CatalogView>): URLSearchParams {
  const search = new URLSearchParams();
  const genres = (view.genres ?? []).filter((slug) => GENRE_SLUG.test(slug)).slice(0, MAX_GENRES);
  if (genres.length > 0) search.set('genre', genres.join(','));
  if (view.status !== undefined && view.status !== null && isStatus(view.status)) {
    search.set('status', view.status);
  }
  if (view.sort !== undefined && isSort(view.sort) && view.sort !== DEFAULT_SORT) {
    search.set('sort', view.sort);
  }
  return search;
}

/**
 * The query string as it is written into an href.
 *
 * `URLSearchParams` percent-encodes the genre separator, which would put
 * `?genre=action%2Cdrama` in the address bar. Both spellings parse identically
 * (`searchParams.get('genre')` returns `action,drama` either way), but the
 * shareable form is `?genre=action,drama`, and an address a reader can read,
 * retype and paste without decoding is the whole point of putting the filter in
 * the URL. So the separator is written literally.
 */
export function catalogQueryString(view: Partial<CatalogView>): string {
  return catalogSearchParams(view).toString().replaceAll('%2C', ',');
}

/** The `/discover` href for a view — the shareable form. */
export function catalogHref(view: Partial<CatalogView>, base = '/discover'): string {
  const query = catalogQueryString(view);
  return query === '' ? base : `${base}?${query}`;
}

/** The API query for a view: the same state, plus paging. */
export function catalogApiQuery(
  view: CatalogView,
  paging: { limit: number; cursor?: string | null } = { limit: CATALOG_PAGE_SIZE },
): string {
  const search = catalogSearchParams(view);
  search.set('limit', String(Math.min(Math.max(1, paging.limit), MAX_PAGE_SIZE)));
  if (paging.cursor !== undefined && paging.cursor !== null && paging.cursor !== '') {
    search.set('cursor', paging.cursor);
  }
  // The API reads the same csv the address bar shows, so both spellings travel.
  return `/api/v1/catalog?${search.toString().replaceAll('%2C', ',')}`;
}

/** Human label for a status, used in the select and in card meta. */
export const STATUS_LABEL: Readonly<Record<MangaStatus, string>> = {
  ongoing: 'Ongoing',
  completed: 'Completed',
  hiatus: 'Hiatus',
};

export const SORT_LABEL: Readonly<Record<CatalogSort, string>> = {
  updated_desc: 'Recently updated',
  title_asc: 'Title A–Z',
  added_desc: 'Newly added',
};

/** "Chapter 10.5" — numeric(8,2) means a decimal part is legal. */
export function chapterLabel(number: number): string {
  const rounded = Math.round(number * 100) / 100;
  return Number.isInteger(rounded) ? `Chapter ${rounded}` : `Chapter ${String(rounded)}`;
}
