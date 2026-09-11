/**
 * The search page's loopback read.
 *
 * Page 1 of a `?q=` is fetched by the SERVER so a shared link renders results
 * in the first response; the page exercises the contract through HTTP rather
 * than a private back door into the service.
 *
 * The cookie is replayed for consistency with every other loopback read in this
 * app, even though `/api/search` is anonymous and never looks at it: uniformity
 * costs one header, and a helper that forwarded the session on three lanes and
 * dropped it on the fourth would be a difference waiting to become a bug.
 *
 * A failure is a VALUE (`{ ok: false }`), never a throw — the page renders five
 * states and "the API is down" is one of them, not an exception.
 */
import { headers } from 'next/headers';
import { searchResponseSchema, type SearchHitView } from './search-schema';

export type SearchRead =
  | { ok: true; items: readonly SearchHitView[]; nextCursor: string | null }
  // `code` tells the island WHICH failure the server hit, so a rate-limited
  // first paint renders the rate-limited state rather than a generic
  // "unavailable": an error is never "no results", and a 429 is never a 500.
  | { ok: false; code: 'RATE_LIMITED' | 'UNAVAILABLE' };

/** This app's own public origin, from the incoming request. */
async function apiOrigin(): Promise<string | null> {
  try {
    const requestHeaders = await headers();
    const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
    if (host === null || host === '') return null;
    const isLoopback = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host);
    const proto = requestHeaders.get('x-forwarded-proto') ?? (isLoopback ? 'http' : 'https');
    return `${proto}://${host}`;
  } catch {
    return null;
  }
}

/** The caller's own `cookie` header, for replay onto the loopback read. */
async function cookieReplay(): Promise<Record<string, string>> {
  try {
    const cookie = (await headers()).get('cookie');
    return cookie === null || cookie === '' ? {} : { cookie };
  } catch {
    return {};
  }
}

/**
 * Page 1 of a search, read by the server for the initial render.
 *
 * An empty `q` is not a request — it answers `{ ok: false }` without touching
 * the network, because the API would 422 it and a 422 is not a state the page
 * needs a round trip to discover.
 */
export async function readSearchPage(q: string): Promise<SearchRead> {
  if (q.trim() === '') return { ok: false, code: 'UNAVAILABLE' };
  const origin = await apiOrigin();
  if (origin === null) return { ok: false, code: 'UNAVAILABLE' };
  try {
    const response = await fetch(new URL(`/api/search?${new URLSearchParams({ q })}`, origin), {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json', ...(await cookieReplay()) },
    });
    if (response.status === 429) return { ok: false, code: 'RATE_LIMITED' };
    if (!response.ok) return { ok: false, code: 'UNAVAILABLE' };
    const parsed = searchResponseSchema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, code: 'UNAVAILABLE' };
    return { ok: true, items: parsed.data.items, nextCursor: parsed.data.nextCursor };
  } catch {
    return { ok: false, code: 'UNAVAILABLE' };
  }
}
