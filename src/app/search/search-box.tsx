'use client';

/**
 * SearchBox — the query box, the states, and the results list.
 *
 * A client island for typing and load-more; page 1 for a `?q=` is
 * server-rendered, so a shared link shows results in the first response and a
 * no-JS reader still gets page 1. A new query mounts a fresh island, so no
 * stale page can survive a query change.
 *
 * Five states — idle, loading, results, no-results, error — and an error is
 * never "no results". The count is a live region present in the DOM on every
 * state so it actually announces. The URL holds `q` alone: the cursor is not
 * shareable and stays out of it, and `router.push` is what keeps Back stepping
 * through searches rather than letters.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '../../shared/ui/Button';
import { UiLink } from '../../shared/ui/Link';
import { searchResponseSchema, type SearchHitView } from './search-schema';
import styles from './search.module.css';

/** The debounce between the last keystroke and the search. */
const DEBOUNCE_MS = 300;

type Status =
  | { name: 'idle' }
  | { name: 'loading' }
  | { name: 'results' }
  | { name: 'empty' }
  | { name: 'error'; code: string; retryable: boolean };

export type SearchBoxProps = {
  /** The `?q=` the page was opened with — the island's starting text. */
  initialQuery: string;
  /** Page 1 for that query, or null when there is none to show yet. */
  initialItems: readonly SearchHitView[];
  /** The opaque token for page 2, or null. */
  initialCursor: string | null;
  /** Whether the server's initial read failed (the API was down, not empty). */
  initialFailed: boolean;
  /** WHICH failure, so a rate-limited first paint names itself. */
  initialFailedCode: 'RATE_LIMITED' | 'UNAVAILABLE' | null;
};

const KIND_LABEL: Record<SearchHitView['kind'], string> = {
  manga: 'Manga',
  creator: 'Creator',
  tag: 'Tag',
};

const MATCH_LABEL: Record<SearchHitView['matchField'], string> = {
  title: 'matched on title',
  alias: 'matched on alias',
  creator: 'matched on creator',
  tag: 'matched on tag',
};

const BAND_LABEL: Record<SearchHitView['band'], string> = {
  exact: 'exact match',
  prefix: 'prefix match',
  contains: 'contains match',
  related: 'related match',
};

function statusText(status: Status, query: string, count: number, hasMore: boolean): string {
  switch (status.name) {
    case 'idle':
      return 'Type above to search titles, creators and tags.';
    case 'loading':
      return `Searching for '${query}'…`;
    case 'results':
      return `${count} result${count === 1 ? '' : 's'} for '${query}'${hasMore ? ', more available' : ''}.`;
    case 'empty':
      return `No results for '${query}'.`;
    case 'error':
      return status.code === 'RATE_LIMIT_SEARCH'
        ? 'Rate limited. Wait a minute, then try again.'
        : 'Search is unavailable right now. Try again.';
  }
}

export function SearchBox({
  initialQuery,
  initialItems,
  initialCursor,
  initialFailed,
  initialFailedCode,
}: SearchBoxProps) {
  const router = useRouter();
  const [text, setText] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim());
  const [items, setItems] = useState<readonly SearchHitView[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [status, setStatus] = useState<Status>(() => {
    if (initialQuery.trim() === '') return { name: 'idle' };
    if (initialFailed)
      return {
        name: 'error',
        code: initialFailedCode === 'RATE_LIMITED' ? 'RATE_LIMIT_SEARCH' : 'UNAVAILABLE',
        retryable: true,
      };
    return initialItems.length === 0 ? { name: 'empty' } : { name: 'results' };
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(0);
  // The server already rendered page 1 for `initialQuery` (or idle for empty),
  // so the effect's FIRST run must not schedule a duplicate search 300 ms after
  // mount. Without this guard every shared link fires twice: once from the
  // server, once from the island waking up.
  const mounted = useRef(false);

  const run = useCallback(async (q: string, appendCursor: string | null, append: boolean) => {
    const runId = (latest.current += 1);
    if (!append) setStatus({ name: 'loading' });
    else setLoadingMore(true);
    try {
      const params = new URLSearchParams({ q });
      if (appendCursor !== null) params.set('cursor', appendCursor);
      const response = await fetch(`/api/search?${params}`, {
        headers: { accept: 'application/json' },
      });
      if (runId !== latest.current) return;
      if (!response.ok) {
        const code = (
          (await response.json().catch(() => null)) as { error?: { code?: string } } | null
        )?.error?.code;
        setStatus({ name: 'error', code: code ?? 'UNAVAILABLE', retryable: true });
        return;
      }
      const parsed = searchResponseSchema.safeParse(await response.json());
      if (runId !== latest.current) return;
      if (!parsed.success) {
        setStatus({ name: 'error', code: 'UNAVAILABLE', retryable: true });
        return;
      }
      if (append) {
        setItems((current) => [...current, ...parsed.data.items]);
        setCursor(parsed.data.nextCursor);
        setStatus({ name: 'results' });
      } else if (parsed.data.items.length === 0) {
        setItems([]);
        setCursor(null);
        setStatus({ name: 'empty' });
      } else {
        setItems(parsed.data.items);
        setCursor(parsed.data.nextCursor);
        setStatus({ name: 'results' });
      }
    } catch {
      if (runId !== latest.current) return;
      setStatus({ name: 'error', code: 'UNAVAILABLE', retryable: true });
    } finally {
      if (runId === latest.current) setLoadingMore(false);
    }
  }, []);

  // Debounced search on typing. The timer is the whole of the debounce: no
  // library, no effect chain — and it is cleared on unmount so a late fire
  // cannot setState on a gone island.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (timer.current !== null) clearTimeout(timer.current);
    const value = text;
    if (value.trim() === '') {
      setQuery('');
      setItems([]);
      setCursor(null);
      setStatus({ name: 'idle' });
      router.replace('/search', { scroll: false });
      return;
    }
    timer.current = setTimeout(() => {
      const q = value.trim();
      setQuery(q);
      setItems([]);
      setCursor(null);
      router.push(`/search?${new URLSearchParams({ q })}`, { scroll: false });
      void run(q, null, false);
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [text, router, run]);

  const submitNow = useCallback(() => {
    // Enter forces an immediate search: the debounce is for keystrokes, not
    // for an explicit "go". Clearing the timer first, or the debounced fire
    // would run the same query twice.
    if (timer.current !== null) clearTimeout(timer.current);
    const q = text.trim();
    if (q === '') return;
    setQuery(q);
    setItems([]);
    setCursor(null);
    router.push(`/search?${new URLSearchParams({ q })}`, { scroll: false });
    void run(q, null, false);
  }, [text, router, run]);

  const retry = useCallback(() => {
    if (query === '') return;
    void run(query, null, false);
  }, [query, run]);

  const loadMore = useCallback(() => {
    if (cursor === null || loadingMore) return;
    void run(query, cursor, true);
  }, [cursor, loadingMore, query, run]);

  const hasMore = cursor !== null;
  const announcement = statusText(status, query, items.length, hasMore);

  return (
    <div className={styles.stack}>
      <form
        role="search"
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submitNow();
        }}
      >
        <label className={styles.label} htmlFor="site-search">
          Search manga, creators and tags
        </label>
        <div className={styles.row}>
          <input
            id="site-search"
            name="q"
            type="search"
            autoComplete="off"
            spellCheck={false}
            className={styles.input}
            placeholder="Titles, aliases, creators, tags…"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={text.trim() === '' || status.name === 'loading'}
          >
            Search
          </Button>
        </div>
      </form>

      <p className={styles.count} role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {status.name === 'error' ? (
        <div className={styles.state}>
          <p className={styles.stateText}>
            {status.code === 'RATE_LIMIT_SEARCH'
              ? 'Too many searches. Wait a minute, then try again.'
              : 'Search is unavailable right now.'}
          </p>
          {status.retryable ? (
            <Button onClick={retry} disabled={query === ''}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {status.name === 'empty' ? (
        <div className={styles.state}>
          <p className={styles.stateText}>
            Nothing matches <q className={styles.query}>{query}</q>. Check the spelling, or try a
            shorter query.
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <ol className={styles.results} aria-label={`Results for '${query}'`}>
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className={styles.item}>
              <span className={styles.badges}>
                <span className={styles.badge}>{KIND_LABEL[item.kind]}</span>
                <span className={styles.hint}>{BAND_LABEL[item.band]}</span>
              </span>
              {item.kind === 'manga' && item.slug !== null ? (
                // The class sits on the span, not the link: the CSS-module type
                // marks every class as possibly undefined, which plain elements
                // accept and `UiLink`'s narrower `string` does not. Nothing about
                // the link changes — it is still the keyboardable row.
                <span className={styles.title}>
                  <UiLink href={`/manga/${item.slug}`}>{item.title}</UiLink>
                </span>
              ) : (
                <span className={styles.title}>{item.title}</span>
              )}
              <span className={styles.hint}>{MATCH_LABEL[item.matchField]}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {status.name === 'results' && hasMore ? (
        <Button onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading more…' : 'Show more results'}
        </Button>
      ) : null}
    </div>
  );
}
