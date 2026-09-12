'use client';

/**
 * BookmarksList — the saved pages, the "load more", and the remove action.
 * A client island because the opaque `nextCursor` is only reachable by a read
 * that presents it, and the remove sits behind a confirmation.
 *
 * A mark whose chapter was deleted is RETAINED and named in words, and a removal
 * must drop its id from appended pages too: the server's re-read page 1 cannot.
 * After a removal, focus moves to the nearest surviving remove control.
 */
import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { Bookmark } from '../../shared/contracts';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { UiLink } from '../../shared/ui/Link';
import { bookmarkPageSchema } from '../_members/member-schema';

/**
 * What a remove can honestly report.
 *
 * Three states, not two: `idle` is what the form starts in, and it is a
 * distinct state from `failed` because a reader who opens the confirmation has
 * not tried anything yet and must not be told something went wrong.
 */
export type RemoveState = { status: 'idle' } | { status: 'removed' } | { status: 'failed' };

/** The page's Server Action, handed to the island as a prop. */
export type RemoveBookmarkAction = (state: RemoveState, formData: FormData) => Promise<RemoveState>;

export type BookmarksListProps = {
  /** Page 1, rendered by the server. */
  items: readonly Bookmark[];
  /** The opaque token for page 2, or null when the list is exhausted. */
  nextCursor: string | null;
  /** The page size the server asked for, so the append asks for the same one. */
  limit: number;
  /** The page's Server Action for the remove. */
  removeAction: RemoveBookmarkAction;
};

/*
 * The tokens remain the only place a colour, a size or a duration is written.
 * Inline here because a stylesheet is not in scope; every value is a
 * `var(--token)` and none is a literal.
 */
const LIST: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };

const ROW: CSSProperties = {
  display: 'grid',
  gap: 'var(--sp-1)',
  minWidth: 0,
  paddingBlock: 'var(--sp-4)',
  borderTop: '1px solid var(--line-hairline)',
};

const ROW_HEAD: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: 'var(--sp-2) var(--sp-3)',
  minWidth: 0,
};

const ROW_TITLE: CSSProperties = {
  fontSize: 'var(--fs-base)',
  fontWeight: 600,
  lineHeight: 'var(--lh-snug)',
  color: 'var(--link-ink)',
  overflowWrap: 'anywhere',
};

const ROW_POSITION: CSSProperties = {
  fontSize: 'var(--fs-base)',
  fontWeight: 600,
  lineHeight: 'var(--lh-snug)',
  color: 'var(--ink-primary)',
  overflowWrap: 'anywhere',
};

/**
 * The unavailable state, in words plus a shape, never colour alone. A reader who
 * cannot separate the two colours still reads "Unavailable chapter" and knows
 * the row is inert and why.
 */
const ROW_UNAVAILABLE: CSSProperties = {
  fontSize: 'var(--fs-sm)',
  fontWeight: 600,
  letterSpacing: 'var(--tracking-caps)',
  textTransform: 'uppercase',
  color: 'var(--ink-muted)',
  // The shape carries the state too, so it survives a monochrome rendering or a
  // stylesheet that never loads.
  border: '1px dashed var(--line-control)',
  borderRadius: 'var(--r-pill)',
  padding: 'var(--sp-1) var(--sp-3)',
};

const ROW_NOTE: CSSProperties = {
  fontSize: 'var(--fs-base)',
  lineHeight: 'var(--lh-normal)',
  color: 'var(--ink-secondary)',
  overflowWrap: 'anywhere',
  margin: 0,
};

const ROW_META: CSSProperties = {
  fontSize: 'var(--fs-sm)',
  color: 'var(--ink-muted)',
  margin: 0,
};

const ROW_ACTIONS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--sp-3)',
};

const MORE: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  paddingBlock: 'var(--sp-5)',
};

/**
 * `YYYY-MM-DD` for a `<time>` element — the convention `manga/[slug]` and the
 * sibling personal pages use, and fixed-width because a bookmark list is scanned
 * in a column.
 */
function formatDate(iso: string): string {
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? '' : new Date(value).toISOString().slice(0, 10);
}

/**
 * Where the mark sits in its chapter. `null` is the chapter's first page, which
 * is a real position and says so. A number below 1 is not one the data model
 * forbids, so it is named rather than dressed up as page 0.
 */
function positionLabel(pageNumber: number | null): string {
  if (pageNumber === null) return 'Chapter start';
  return pageNumber >= 1 ? `Page ${pageNumber}` : 'Page not recorded';
}

/** The resolved chapter a mark points at (`Bookmark['chapter']`, non-null). */
type ResolvedChapter = NonNullable<Bookmark['chapter']>;

/**
 * The reader route, at the page the reader chose.
 *
 * `/manga/{slug}/chapter/{number}` and the chapter segment is the number as the
 * route parses it — `Number(segment)`, so no rounding helper is needed here; the
 * DTO's number is `numeric(8,2)` and round-trips through `String`. `?page=` is
 * the contract for a bookmark jump, and the deep link wins over a saved position
 * for exactly this case.
 */
function jumpHref(chapter: ResolvedChapter, pageNumber: number | null): string {
  const page = pageNumber === null ? '' : `?page=${pageNumber}`;
  return `/manga/${encodeURIComponent(chapter.mangaSlug)}/chapter/${String(chapter.number)}${page}`;
}

/** The link's name says where it goes, so two rows never share a name. */
function jumpLabel(chapter: ResolvedChapter, pageNumber: number | null): string {
  return pageNumber === null || pageNumber < 1
    ? `Open Ch. ${chapter.number}`
    : `Jump to Ch. ${chapter.number}, page ${pageNumber}`;
}

/** The state a form starts in: nothing has been asked of the server yet. */
const INITIAL_REMOVE_STATE: RemoveState = { status: 'idle' };

/**
 * One row's remove control: a real form, a confirmation when scripting is on,
 * and focus returned to the button that opened it.
 */
function RemoveBookmark({
  id,
  label,
  what,
  action,
  onRemoved,
}: {
  id: string;
  /**
   * The button's accessible name, which has to say WHICH mark because a list of
   * rows all reading "Remove" is a list of identical controls to anyone
   * navigating by link or button. It begins with the visible word, so a
   * voice-input reader can still say "click Remove" (WCAG 2.1 SC 2.5.3).
   */
  label: string;
  /** What is being removed, named in the dialog so the action is never "this". */
  what: string;
  action: RemoveBookmarkAction;
  /** Told once the server has confirmed, so the list can drop the row itself. */
  onRemoved: (id: string) => void;
}) {
  // `useActionState` (React 19) is the form-action hook: it runs the page's
  // Server Action, reports whether it is in flight, and hands back the state the
  // action returned — which is how the dialog knows the server has answered.
  const [state, formAction, pending] = useActionState(action, INITIAL_REMOVE_STATE);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const formId = `remove-bookmark-${id}`;

  // The list has to hear about the removal from HERE, not from its own props: a
  // mark on an APPENDED page is absent from the server's page 1, so the next
  // server render says nothing about it and the row would sit on screen as if it
  // were still saved. A row on page 1 needs no telling — the server has already
  // dropped it by the time this component goes away.
  useEffect(() => {
    if (state.status === 'removed') onRemoved(id);
  }, [id, onRemoved, state.status]);

  // The dialog must not close until the server has answered, and it must be gone
  // once it has: a reader who sees it vanish before the mark does is watching a
  // promise the product has not kept yet.
  const shown = open && state.status !== 'removed';

  const close = useCallback(() => {
    setOpen(false);
    // SC 2.4.3: the control that opened the dialog gets focus back. Guarded
    // because a successful remove unmounts this row, and focusing a detached
    // node does nothing at all.
    if (trigger.current?.isConnected === true) trigger.current.focus();
  }, []);

  return (
    <form id={formId} action={formAction}>
      <input type="hidden" name="bookmarkId" value={id} />
      <Button
        type="submit"
        data-remove-bookmark={id}
        aria-haspopup="dialog"
        aria-label={label}
        onClick={(event) => {
          trigger.current = event.currentTarget;
          // With scripting, the click opens the confirmation instead of
          // submitting; without it there is no handler to run and the form
          // submits, so the mark can always be removed.
          event.preventDefault();
          setOpen(true);
        }}
      >
        Remove
      </Button>

      <Dialog
        open={shown}
        onClose={close}
        title="Remove this bookmark"
        idPrefix={`remove-bookmark-dialog-${id}`}
        actions={
          <>
            <Button onClick={close} disabled={pending}>
              Keep it
            </Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {pending ? 'Removing…' : 'Remove bookmark'}
            </Button>
          </>
        }
      >
        <p>{what}</p>
        <p className="note">
          The note you wrote goes with it. This cannot be undone from here, but you can mark the
          page again from the reader.
        </p>
        {state.status === 'failed' && pending === false ? (
          <p role="alert">
            The bookmark could not be removed just now, so it is still saved. Nothing was lost — try
            again.
          </p>
        ) : null}
      </Dialog>
    </form>
  );
}

export function BookmarksList({ items, nextCursor, limit, removeAction }: BookmarksListProps) {
  const [appended, setAppended] = useState<readonly Bookmark[]>([]);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const previous = useRef<readonly string[]>([]);

  const loadMore = useCallback(() => {
    if (cursor === null || loading) return;
    setLoading(true);
    setFailure(null);

    void (async () => {
      try {
        const query = new URLSearchParams({ limit: String(limit), cursor });
        const response = await fetch(`/api/bookmarks?${query.toString()}`, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          setFailure('The next page could not be loaded. The button below tries again.');
          return;
        }
        const parsed = bookmarkPageSchema.safeParse(await response.json());
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
  }, [cursor, limit, loading]);

  const all: readonly Bookmark[] = [...items, ...appended];

  /*
   * The server's page 1 replaces whatever this island had accumulated.
   *
   * An appended page is only true of the page 1 it was fetched against. A server
   * render — a remove, a Back, a refresh — hands this island a new page 1, and
   * the appended rows then describe a list that no longer exists. Adjusting the
   * state DURING the render (React's documented pattern for "a prop changed") is
   * what keeps the stale rows out of the DOM entirely, rather than removing them
   * one commit later.
   *
   * It is not enough on its own, and the reason is worth stating: a mark on an
   * APPENDED page is not in the server's page 1, so removing it leaves page 1
   * byte-identical and nothing here would notice. `forget` is that half — the
   * row leaves the list the moment its own control reports the server's answer.
   */
  const serverPage = items.map((bookmark) => bookmark.id).join('|');
  const [renderedPage, setRenderedPage] = useState(serverPage);
  if (serverPage !== renderedPage) {
    setRenderedPage(serverPage);
    setAppended([]);
    setCursor(nextCursor);
  }

  const forget = useCallback((id: string) => {
    setAppended((current) => current.filter((bookmark) => bookmark.id !== id));
  }, []);

  const count = all.length;
  const missing = all.filter((bookmark) => bookmark.chapter === null).length;

  // See the header: a row that leaves the list takes its own focus with it, so
  // focus moves to the nearest surviving remove control.
  //
  // The test is "a row that WAS here is not here now", never "the list got
  // shorter": on a full page a removal replaces the last row with the next one
  // off-page, so the count is unchanged and a length comparison would miss the
  // reader's own action entirely. An appended page never removes a row, so this
  // cannot fire on "load more".
  useEffect(() => {
    const ids = all.map((bookmark) => bookmark.id);
    const before = previous.current;
    previous.current = ids;
    if (before.length === 0) return;
    const at = before.findIndex((id) => !ids.includes(id));
    if (at === -1) return;
    // Candidates are checked against the DOM rather than against `ids`, because
    // the page-1 replacement above can have dropped rows that were on screen a
    // moment ago, and focusing a control that is about to be removed is the same
    // fault as not focusing anything.
    const onScreen = (id: string): boolean =>
      document.querySelector(`[data-remove-bookmark="${CSS.escape(id)}"]`) !== null;
    // Forward first — the row below is where a reader scanning a list expects to
    // carry on — and back only when there is nothing below.
    const next =
      before.slice(at + 1).find(onScreen) ?? [...before.slice(0, at)].reverse().find(onScreen);
    if (next === undefined) return;
    document
      .querySelector<HTMLButtonElement>(`[data-remove-bookmark="${CSS.escape(next)}"]`)
      ?.focus();
  }, [all]);

  return (
    <div>
      {/* Always present, so an appended page has a live region to speak into. */}
      <p className="note" aria-live="polite" aria-atomic="true">
        {count} {count === 1 ? 'bookmark' : 'bookmarks'}
        {cursor === null ? '.' : ' so far — more below.'}
      </p>

      <ul className="list" aria-label="Saved pages" aria-busy={loading || undefined} style={LIST}>
        {all.map((bookmark) => {
          const chapter = bookmark.chapter;
          const saved = formatDate(bookmark.createdAt);
          const what =
            chapter === null
              ? 'This bookmark points at a chapter that has since been deleted. The mark is kept, and removing it takes the note with it.'
              : `This is the mark you saved on Ch. ${chapter.number} of ${chapter.mangaTitle}${
                  bookmark.pageNumber === null
                    ? ', at its first page'
                    : `, page ${bookmark.pageNumber}`
                }.`;
          // The row's own name for the remove, so a list of identical "Remove"
          // buttons is still a list of distinguishable controls. The page is part
          // of it because a chapter and a page ARE the mark's identity — the
          // unique index is (user, chapter, page) — so naming both makes each
          // control's name unique in the list.
          const where =
            bookmark.pageNumber === null
              ? 'at its first page'
              : bookmark.pageNumber >= 1
                ? `page ${bookmark.pageNumber}`
                : 'an unrecorded page';
          const label =
            chapter === null
              ? `Remove the bookmark on the deleted chapter, ${where}`
              : `Remove the bookmark on Ch. ${chapter.number} of ${chapter.mangaTitle}, ${where}`;
          return (
            <li key={bookmark.id} style={ROW}>
              <div style={ROW_HEAD}>
                {chapter === null ? (
                  <>
                    <span style={ROW_UNAVAILABLE}>Unavailable chapter</span>
                    <span style={ROW_META}>The chapter this marked has been deleted.</span>
                  </>
                ) : (
                  <>
                    <UiLink
                      href={`/manga/${encodeURIComponent(chapter.mangaSlug)}`}
                      prefetch={false}
                      style={ROW_TITLE}
                    >
                      {chapter.mangaTitle}
                    </UiLink>
                    <span style={ROW_POSITION}>
                      Ch. {chapter.number} · {positionLabel(bookmark.pageNumber)}
                    </span>
                  </>
                )}
              </div>

              {bookmark.note.trim() === '' ? (
                <p className="note" style={ROW_NOTE}>
                  No note
                </p>
              ) : (
                // A text node, never markup: the note is plain text.
                <p style={ROW_NOTE}>{bookmark.note}</p>
              )}

              <div style={ROW_ACTIONS}>
                {chapter === null ? null : (
                  <UiLink
                    className="btn"
                    href={jumpHref(chapter, bookmark.pageNumber)}
                    prefetch={false}
                  >
                    {jumpLabel(chapter, bookmark.pageNumber)}
                  </UiLink>
                )}
                {/* The remove stays on an unavailable row: a deleted chapter is a
                    reason the jump is missing, not a reason the mark is stuck. */}
                <RemoveBookmark
                  id={bookmark.id}
                  label={label}
                  what={what}
                  action={removeAction}
                  onRemoved={forget}
                />
              </div>

              {saved === '' ? null : (
                <p style={ROW_META}>
                  <time dateTime={bookmark.createdAt}>Saved {saved}</time>
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {missing > 0 ? (
        <p className="note">
          {missing === 1
            ? 'One bookmark points at a chapter that has since been deleted. The mark is kept, and'
            : `${missing} bookmarks point at chapters that have since been deleted. The marks are kept, and`}{' '}
          the page it named cannot be opened. You can still remove any of them.
        </p>
      ) : null}

      {failure === null ? null : (
        <p className="note" role="alert">
          {failure}
        </p>
      )}

      {cursor === null ? null : (
        <div style={MORE}>
          <Button onClick={loadMore} disabled={loading} aria-busy={loading || undefined}>
            {loading ? 'Loading more bookmarks…' : 'Load more bookmarks'}
          </Button>
        </div>
      )}
    </div>
  );
}

export default BookmarksList;
