import 'server-only';

/**
 * Library (`/library`) — the member's shelf, read live over HTTP from
 * `GET /api/library`; the UI lane owns no database and imports nothing from
 * `server/*` or `features/*`.
 *
 * The incoming `cookie` header is replayed onto the read, because an RSC
 * `fetch` does not forward browser cookies. The route sorts, so the ordering a
 * reader sees is the database's, cursor and all. No DTO carries a `userId`:
 * the owner is the resolved session, never a parameter.
 */
import type { Metadata } from 'next';
import type { LibrarySort } from '../../shared/contracts';
import { StateRegion } from '../../shared/ui/StateRegion';
import { readMembers } from '../_members/member-api';
import { libraryPageSchema } from '../_members/member-schema';
import { LibraryShelf } from './library-shelf';

export const metadata: Metadata = {
  title: 'Library',
  description: 'The titles on your shelf, with covers and when you last opened each one.',
};

/** Member data: never prerendered, never cached. */
export const dynamic = 'force-dynamic';

/**
 * How many entries this page asks for.
 *
 * 24 is the same page size the catalog grid uses, for the same reason: a screen
 * of covers is a screen, and the route's own cap is 48. The rest of a large
 * shelf arrives through the island's "load more", which presents the opaque
 * `nextCursor` the page cannot construct.
 */
const SHELF_PAGE_SIZE = 24;

const LIBRARY_SORTS = [
  'last_read_desc',
  'added_desc',
  'title_asc',
] as const satisfies readonly LibrarySort[];

const SORT_LABEL: Readonly<Record<LibrarySort, string>> = {
  last_read_desc: 'Recently read first',
  added_desc: 'Newly added first',
  title_asc: 'Title A–Z',
};

const SORT_SENTENCE: Readonly<Record<LibrarySort, string>> = {
  last_read_desc: 'most recently read first',
  added_desc: 'newest first',
  title_asc: 'in title order',
};

/** `searchParams` is a promise in Next 16, and a key may arrive as an array. */
type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/**
 * Total, like `parseCatalogView`: the query string is attacker-controlled, so an
 * unknown sort is DROPPED and the contract's default is used rather than
 * forwarded.
 */
function parseSort(params: SearchParams): LibrarySort {
  const raw = single(params['sort']);
  return (LIBRARY_SORTS as readonly string[]).includes(raw)
    ? (raw as LibrarySort)
    : 'last_read_desc';
}

/** The wire query for one page of the shelf, in the view's sort. */
function shelfQuery(sort: LibrarySort): string {
  const query = new URLSearchParams({ sort, limit: String(SHELF_PAGE_SIZE) });
  return `/api/library?${query.toString()}`;
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const view = parseSort(await searchParams);

  const shelf = await readMembers(shelfQuery(view), libraryPageSchema);

  if (!shelf.ok) {
    return <LibraryShell signedOut={shelf.failure === 'signed-out'} unavailableHref="/library" />;
  }

  if (shelf.data.items.length === 0) {
    // An empty shelf is a real answer and not a fault, so it is its own state
    // with a route out of it — the catalog. The page only ever asks for page 1,
    // so "no items" here is "no shelf", not "page 1 of an empty page 2".
    return (
      <>
        <h1>Library</h1>
        <StateRegion
          headingId="library-empty"
          headingLevel={2}
          title="Your library is empty"
          cause="Nothing is on your shelf yet. You add a title by opening it from the catalog and choosing to keep it — no account was created for you in the meantime, and nothing has been lost."
          remedy="Browse the catalog and open a title to put it on your shelf."
          actions={[
            { href: '/discover', label: 'Browse the catalog', primary: true },
            { href: '/history', label: 'See what you have read' },
          ]}
        />
      </>
    );
  }

  return (
    <>
      <h1>Library</h1>

      <section aria-labelledby="library-shelf-h">
        <h2 id="library-shelf-h">Your shelf</h2>

        {/*
          A plain GET form: the native <select> is keyboard-operable by the
          platform (arrows, type-ahead, Home/End) and the whole control works
          with scripting off, which is why the sort has no island.
        */}
        <form className="page-actions" method="get" action="/library">
          <div className="field">
            <label htmlFor="library-sort">Sort</label>
            <select id="library-sort" name="sort" defaultValue={view}>
              {LIBRARY_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {SORT_LABEL[sort]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn">
            Apply
          </button>
        </form>

        <LibraryShelf
          items={shelf.data.items}
          nextCursor={shelf.data.nextCursor}
          sort={view}
          limit={SHELF_PAGE_SIZE}
          sortSentence={SORT_SENTENCE[view]}
        />
      </section>
    </>
  );
}

/**
 * The two states a shelf that cannot be read needs. A 401 and a broken read are
 * different sentences for a reader: one is "you are not signed in" and offers
 * sign-in, the other is "try again" and offers the page itself. Both are focusable
 * and announced, and neither says anything about upstream status codes or
 * connection details.
 */
function LibraryShell({
  signedOut = false,
  unavailableHref,
}: {
  signedOut?: boolean;
  unavailableHref: string;
}) {
  return (
    <>
      <h1>Library</h1>
      {signedOut ? (
        <StateRegion
          headingId="library-signed-out"
          headingLevel={2}
          title="Your library is only yours when you are signed in"
          cause="This page shows one reader's shelf, so it needs a session before it can read anything. Nothing was lost — the shelf is waiting."
          remedy="Sign in and this page will show your titles."
          actions={[
            { href: '/auth/signin?next=/library', label: 'Sign in', primary: true },
            { href: '/discover', label: 'Browse the catalog' },
          ]}
        />
      ) : (
        <StateRegion
          headingId="library-unavailable"
          headingLevel={2}
          title="Your library is unavailable"
          cause="The shelf could not be read just now. Nothing has been removed, and your reading history and bookmarks are untouched."
          remedy="Try again in a moment. A title you were reading is still reachable by its address."
          actions={[
            { href: unavailableHref, label: 'Try again', primary: true },
            { href: '/discover', label: 'Browse the catalog' },
          ]}
        />
      )}
    </>
  );
}
