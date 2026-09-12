import 'server-only';

/**
 * History (`/history`) — the reading sessions, newest first, read live.
 * The UI lane owns no database, so the page reads `/api/history` over HTTP; the
 * session cookie is replayed because a React Server Component's `fetch` does
 * not forward it, or the page would show its signed-out state to a signed-in
 * reader. `nextCursor` is opaque, so older sessions need the island's button. A
 * session whose chapter is gone keeps its row as "Unavailable chapter".
 */
import type { Metadata } from 'next';
import { StateRegion } from '../../shared/ui/StateRegion';
import { readMembers } from '../_members/member-api';
import { historyPageSchema } from '../_members/member-schema';
import { HistoryList } from './history-list';

export const metadata: Metadata = {
  title: 'History',
  description: 'The chapters you have read, most recent first.',
};

/** Member data: never prerendered, never cached. */
export const dynamic = 'force-dynamic';

/**
 * How many sessions this page asks for.
 *
 * The route's own page cap is 48, and a history row is a short line, so one
 * screen of rows is 24 and the rest arrives through the island's "load older
 * sessions".
 */
const HISTORY_PAGE_SIZE = 24;

export default async function HistoryPage() {
  const result = await readMembers(
    `/api/history?limit=${String(HISTORY_PAGE_SIZE)}`,
    historyPageSchema,
  );

  if (!result.ok) {
    return (
      <>
        <h1>History</h1>
        {result.failure === 'signed-out' ? (
          <StateRegion
            headingId="history-signed-out"
            headingLevel={2}
            title="Your reading history is only yours when you are signed in"
            cause="This page shows one reader's reading sessions, so it needs a session before it can read anything. Nothing was lost — the sessions are being recorded, and they are waiting."
            remedy="Sign in and this page will show what you have read."
            actions={[
              { href: '/auth/signin?next=/history', label: 'Sign in', primary: true },
              { href: '/library', label: 'Open your library' },
            ]}
          />
        ) : (
          <StateRegion
            headingId="history-unavailable"
            headingLevel={2}
            title="Your reading history is unavailable"
            cause="The list could not be read just now. Nothing has been removed, and the sessions you have read are untouched."
            remedy="Try again in a moment. Opening a chapter again will keep recording where you are."
            actions={[
              { href: '/history', label: 'Try again', primary: true },
              { href: '/library', label: 'Open your library' },
            ]}
          />
        )}
      </>
    );
  }

  if (result.data.items.length === 0) {
    // No reading yet is a real answer, not a fault, so it is its own state with
    // a route out of it. The page only ever asks for page one, so "no items"
    // means "no sessions", not "an empty first page".
    return (
      <>
        <h1>History</h1>
        <StateRegion
          headingId="history-empty"
          headingLevel={2}
          title="You have not read anything yet"
          cause="Reading history is one row per stretch of reading: open a chapter, read some of it, and the session is recorded here with the page you reached. You have not opened a chapter, so there is nothing to show — and nothing is missing from your account."
          remedy="Open a title from the catalog and read a chapter. It will appear here as soon as you do."
          actions={[
            { href: '/discover', label: 'Browse the catalog', primary: true },
            { href: '/library', label: 'Open your library' },
          ]}
        />
      </>
    );
  }

  return (
    <>
      <h1>History</h1>

      <section aria-labelledby="history-list-h">
        <h2 id="history-list-h">What you have read</h2>
        <HistoryList
          items={result.data.items}
          nextCursor={result.data.nextCursor}
          limit={HISTORY_PAGE_SIZE}
        />
      </section>
    </>
  );
}
