/**
 * Search (`/search`).
 *
 * A server shell that reads `?q=` and renders page 1, plus the client island
 * that takes over for typing and paging. The query is IN the URL, so a search is
 * a link and Back moves through searches; the cursor is deliberately NOT in the
 * URL. `key={initialQuery}` mounts a fresh island per query, so state cannot
 * survive a change of query and page 2 of one search is never offered for
 * another.
 */
import type { Metadata } from 'next';
import { readSearchPage } from './search-data';
import { SearchBox } from './search-box';

/** `searchParams` is a promise in Next 16, and `q` may arrive as an array. */
type SearchParams = {
  q?: string | string[];
};

export const metadata: Metadata = {
  title: 'Search',
};

function readInitialQuery(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return '';
  return (raw ?? '').slice(0, 120);
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const initialQuery = readInitialQuery((await searchParams).q);
  const initial = initialQuery.trim() === '' ? null : await readSearchPage(initialQuery);

  return (
    <>
      <h1>Search</h1>
      <SearchBox
        key={initialQuery}
        initialQuery={initialQuery}
        initialItems={initial !== null && initial.ok ? initial.items : []}
        initialCursor={initial !== null && initial.ok ? initial.nextCursor : null}
        initialFailed={initial !== null && !initial.ok}
        initialFailedCode={initial !== null && !initial.ok ? initial.code : null}
      />
    </>
  );
}
