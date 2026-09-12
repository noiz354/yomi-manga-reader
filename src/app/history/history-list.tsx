'use client';

/**
 * HistoryList — what the reader has read, newest first, with "load more".
 *
 * A client island for one reason: `nextCursor` is opaque, so only a read that
 * presents it can fetch the next page. `entry.endedAt === null` is an OPEN
 * session and is named, not hidden. Times are shown in the reader's zone after
 * hydration; `<time dateTime>` always carries the stored UTC instant, and a
 * reader without scripting keeps the labelled UTC stamp.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { HistoryEntry } from '../../shared/contracts';
import { Button } from '../../shared/ui/Button';
import { UiLink } from '../../shared/ui/Link';
import { historyPageSchema } from '../_members/member-schema';

export type HistoryListProps = {
  /** Page 1, rendered by the server. */
  items: readonly HistoryEntry[];
  /** The opaque token for page 2, or null when the history is exhausted. */
  nextCursor: string | null;
  /** The page size the server asked for, so the append asks for the same one. */
  limit: number;
};

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
};

/** The unavailable state, in words plus a shape that survives monochrome. */
const ROW_UNAVAILABLE: CSSProperties = {
  fontSize: 'var(--fs-sm)',
  fontWeight: 600,
  letterSpacing: 'var(--tracking-caps)',
  textTransform: 'uppercase',
  color: 'var(--ink-muted)',
  border: '1px dashed var(--line-control)',
  borderRadius: 'var(--r-pill)',
  padding: 'var(--sp-1) var(--sp-3)',
};

const ROW_META: CSSProperties = {
  fontSize: 'var(--fs-sm)',
  lineHeight: 'var(--lh-normal)',
  color: 'var(--ink-muted)',
  margin: 0,
  overflowWrap: 'anywhere',
};

const MORE: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  paddingBlock: 'var(--sp-5)',
};

/** The stored instant, rendered unambiguously. Unparseable input renders as nothing. */
function utcStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

/**
 * The moment a session started, in the reader's own clock.
 *
 * The first render — on the server and through hydration — is the stored UTC
 * stamp, so the two agree and there is nothing to reconcile; the effect then
 * swaps in the reader's locale and zone. `dateTime` always carries the stored
 * instant, so the machine-readable value is the same before and after.
 */
function When({ iso }: { iso: string }) {
  const [label, setLabel] = useState(() => utcStamp(iso));
  useEffect(() => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return;
    setLabel(date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  }, [iso]);
  return <time dateTime={iso}>{label}</time>;
}

/** How long the stretch ran, in the fewest words that are still true. */
function durationLabel(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function HistoryList({ items, nextCursor, limit }: HistoryListProps) {
  const [appended, setAppended] = useState<readonly HistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const loadMore = useCallback(() => {
    if (cursor === null || loading) return;
    setLoading(true);
    setFailure(null);

    void (async () => {
      try {
        const query = new URLSearchParams({ limit: String(limit), cursor });
        const response = await fetch(`/api/history?${query.toString()}`, {
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          setFailure('Older sessions could not be loaded. The button below tries again.');
          return;
        }
        const parsed = historyPageSchema.safeParse(await response.json());
        if (!parsed.success) {
          setFailure('Older sessions could not be read. The button below tries again.');
          return;
        }
        setAppended((current) => [...current, ...parsed.data.items]);
        setCursor(parsed.data.nextCursor);
      } catch {
        setFailure('Older sessions could not be loaded. The button below tries again.');
      } finally {
        setLoading(false);
      }
    })();
  }, [cursor, limit, loading]);

  const all: readonly HistoryEntry[] = [...items, ...appended];

  /*
   * The server's page 1 replaces whatever this island had accumulated.
   *
   * An appended page is only true of the page 1 it was fetched against, and a
   * server render — a Back, a refresh, a revalidation — hands this island a new
   * one. Adjusting the state DURING the render (React's documented pattern for
   * "a prop changed") is what keeps the stale rows out of the DOM, instead of
   * removing them a commit later.
   */
  const serverPage = items
    .map((entry) => `${entry.chapter?.id ?? 'gone'}:${entry.startedAt}`)
    .join('|');
  const [renderedPage, setRenderedPage] = useState(serverPage);
  if (serverPage !== renderedPage) {
    setRenderedPage(serverPage);
    setAppended([]);
    setCursor(nextCursor);
  }

  const count = all.length;
  const missing = all.filter((entry) => entry.chapter === null).length;

  return (
    <div>
      {/* Always present, so an appended page has a live region to speak into. */}
      <p className="note" aria-live="polite" aria-atomic="true">
        {count === 0
          ? 'No reading sessions.'
          : `${count} ${count === 1 ? 'reading session' : 'reading sessions'}${
              cursor === null ? ', most recent first.' : ' so far, most recent first.'
            }`}
      </p>

      <ul
        className="list"
        aria-label="Reading sessions"
        aria-busy={loading || undefined}
        style={LIST}
      >
        {all.map((entry, index) => {
          const chapter = entry.chapter;
          // An unparseable stamp renders no row time at all rather than
          // "Invalid Date", which is not a thing that ever happened to anyone.
          const when = new Date(entry.startedAt).getTime();
          // `endedAt: null` is an OPEN session (the tab never closed cleanly),
          // which is a state with a name — not a missing duration.
          const ran =
            entry.endedAt === null
              ? 'Still open'
              : entry.durationMs === null
                ? ''
                : durationLabel(entry.durationMs);
          return (
            // `HistoryEntry` carries no id (shared/contracts/library.ts), so the
            // key is what identifies a stretch — the chapter it belongs to, when
            // it started, how far it got — plus the row's position, which cannot
            // move: every appended page lands after the rows already on screen.
            <li
              key={`${chapter?.id ?? 'gone'}:${entry.startedAt}:${entry.deepestPage}:${index}`}
              style={ROW}
            >
              <div style={ROW_HEAD}>
                {chapter === null ? (
                  <>
                    <span style={ROW_UNAVAILABLE}>Unavailable chapter</span>
                    <span style={ROW_META}>
                      The chapter you read has since been deleted. The session is kept.
                    </span>
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
                      Ch. {chapter.number} · reached page {entry.deepestPage}
                    </span>
                  </>
                )}
              </div>

              {Number.isNaN(when) ? null : (
                <p style={ROW_META}>
                  <When iso={entry.startedAt} />
                </p>
              )}

              {ran === '' ? null : <p style={ROW_META}>{ran}</p>}
            </li>
          );
        })}
      </ul>

      {missing > 0 ? (
        <p className="note">
          {missing === 1
            ? 'One session points at a chapter that has since been deleted. The session is kept, and'
            : `${missing} sessions point at chapters that have since been deleted. The sessions are kept, and`}{' '}
          nothing else about it has been lost.
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
            {loading ? 'Loading older sessions…' : 'Load older sessions'}
          </Button>
        </div>
      )}
    </div>
  );
}

export default HistoryList;
