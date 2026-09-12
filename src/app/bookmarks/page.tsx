import 'server-only';

/**
 * Bookmarks (`/bookmarks`) — the pages a reader kept, read live.
 *
 * `chapter: null` is a real state: `bookmark.chapter_id` is `ON DELETE SET NULL`,
 * so a null chapter IS a deleted chapter — the row is kept but the jump is not
 * offered. The read goes over HTTP because the UI lane owns no database. The
 * remove is a Server Action: a real `<form>` submit that works with scripting
 * off, and the session cookie is the only owner.
 */
import type { Metadata } from 'next';
import { revalidatePath } from 'next/cache';
import { StateRegion } from '../../shared/ui/StateRegion';
import { readMembers, removeBookmarkThroughApi } from '../_members/member-api';
import { bookmarkPageSchema } from '../_members/member-schema';
import { BookmarksList, type RemoveState } from './bookmarks-list';

export const metadata: Metadata = {
  title: 'Bookmarks',
  description: 'The pages you kept, with the note you wrote beside each one.',
};

/** Member data: never prerendered, never cached. */
export const dynamic = 'force-dynamic';

/**
 * How many marks this page asks for.
 *
 * The route's own page cap is 48 and a saved-page list is read in columns, so
 * one screen of rows is 24 and the rest arrives through the island's "load
 * more", which presents the opaque `nextCursor` this page cannot construct.
 */
const BOOKMARK_PAGE_SIZE = 24;

/**
 * The remove.
 *
 * A form body is untrusted, so the id is taken as a string only when it really
 * is one — `String(value)` would stringify an object into `"[object Object]"`,
 * which then reads as an id. The bound is `removeBookmarkThroughApi`'s, so this
 * action does not keep a second copy of the rule.
 *
 * The result is deliberately coarse: 204 and 404 both mean "this mark is no
 * longer on the list", because the route answers 404 for "not yours" and "not
 * there" alike and a reader removing their own mark cannot tell those apart —
 * nor should they be able to. `failed` is the one state that means the mark is
 * still saved, and the dialog stays open and says so.
 *
 * @param _previous the form's prior state, required by `useActionState` and unused
 * @param formData the submitted form
 */
async function removeBookmark(_previous: RemoveState, formData: FormData): Promise<RemoveState> {
  'use server';

  const raw = formData.get('bookmarkId');
  const id = typeof raw === 'string' ? raw : '';
  const outcome = await removeBookmarkThroughApi(id);
  if (outcome === 'failed') return { status: 'failed' };
  // The list this page renders is a read of `/api/bookmarks`; re-running it
  // after the write is what makes the removed row disappear on return, without
  // a client-side guess about what the list now holds.
  revalidatePath('/bookmarks');
  return { status: 'removed' };
}

export default async function BookmarksPage() {
  const result = await readMembers(
    `/api/bookmarks?limit=${String(BOOKMARK_PAGE_SIZE)}`,
    bookmarkPageSchema,
  );

  if (!result.ok) {
    return (
      <>
        <h1>Bookmarks</h1>
        {result.failure === 'signed-out' ? (
          <StateRegion
            headingId="bookmarks-signed-out"
            headingLevel={2}
            title="Your bookmarks are only yours when you are signed in"
            cause="This page shows one reader's saved pages, so it needs a session before it can read anything. Nothing was lost — the bookmarks are waiting."
            remedy="Sign in and this page will show them."
            actions={[
              { href: '/auth/signin?next=/bookmarks', label: 'Sign in', primary: true },
              { href: '/discover', label: 'Browse the catalog' },
            ]}
          />
        ) : (
          <StateRegion
            headingId="bookmarks-unavailable"
            headingLevel={2}
            title="Your bookmarks are unavailable"
            cause="The list could not be read just now. Nothing has been removed, and the marks you made are still on the page you made them from."
            remedy="Try again in a moment."
            actions={[
              { href: '/bookmarks', label: 'Try again', primary: true },
              { href: '/discover', label: 'Browse the catalog' },
            ]}
          />
        )}
      </>
    );
  }

  if (result.data.items.length === 0) {
    // An empty list is a real answer, not a fault, so it gets its own state and
    // a route out of it. The page only ever asks for page one, so "no items"
    // here means "no marks", not "an empty first page".
    return (
      <>
        <h1>Bookmarks</h1>
        <StateRegion
          headingId="bookmarks-empty"
          headingLevel={2}
          title="You have not marked any pages yet"
          cause="A bookmark is a page you kept: the spot you wanted to come back to, optionally with a note beside it. You have not made one, so there is nothing here — and nothing is missing from your account."
          remedy="Open a chapter in the reader and mark the page you want to keep. It will appear here."
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
      <h1>Bookmarks</h1>

      <section aria-labelledby="bookmarks-list-h">
        <h2 id="bookmarks-list-h">Saved pages</h2>
        <BookmarksList
          items={result.data.items}
          nextCursor={result.data.nextCursor}
          limit={BOOKMARK_PAGE_SIZE}
          removeAction={removeBookmark}
        />
      </section>
    </>
  );
}
