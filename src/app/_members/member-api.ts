/**
 * The members' HTTP reads — one origin, one cookie replay, one failure shape.
 *
 * A React Server Component's `fetch` does NOT forward the browser's cookies, so
 * the incoming `cookie` header is replayed here; without it a signed-in reader
 * would see the signed-out state. The UI lane owns no database, so these pages
 * exercise the app's own `/api` routes rather than a private back door.
 */
import 'server-only';

import { headers } from 'next/headers';
import type { z } from 'zod';

/** How long a server-side read may take before the page renders its own state. */
const READ_TIMEOUT_MS = 5_000;

/** Why a read did not produce data — each maps to a distinct state on the page. */
export type MembersFailure =
  /** The route answered 401: there is no session on this request. */
  | 'signed-out'
  /** Refused, timed out, answered something unparseable, or a cursor it cannot read. */
  | 'unavailable';

export type MembersResult<T> = { ok: true; data: T } | { ok: false; failure: MembersFailure };

/**
 * This app's own public origin, from the incoming request.
 *
 * @returns the origin, or null when the request carries no usable host
 */
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

/** The caller's own cookies, replayed so a member route can recognise them. */
async function sessionCookie(): Promise<string | null> {
  try {
    return (await headers()).get('cookie');
  } catch {
    return null;
  }
}

/**
 * One read of one of this app's member routes, parsed or refused.
 *
 * The identity rule is enforced by what is NOT sent: no `userId` appears in the
 * path, the query or any header, because the owner is the session the route
 * resolves from the cookie.
 *
 * @param path the route and its query, e.g. `/api/library?sort=added_desc`
 * @param schema the contract's parser (`_members/member-schema.ts`)
 * @returns the parsed payload, or a failure the page renders
 */
export async function readMembers<S extends z.ZodType>(
  path: string,
  schema: S,
): Promise<MembersResult<z.output<S>>> {
  try {
    const [origin, cookie] = await Promise.all([apiOrigin(), sessionCookie()]);
    if (origin === null) return { ok: false, failure: 'unavailable' };
    const response = await fetch(new URL(path, origin), {
      // v1 has no server-side application cache, and this is one reader's data
      // in any case.
      cache: 'no-store',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      headers: { accept: 'application/json', ...(cookie === null ? {} : { cookie }) },
    });
    if (response.status === 401) return { ok: false, failure: 'signed-out' };
    // 422 `CATALOG_PAGE_INVALID` (an unreadable cursor) lands here too, which is
    // right: a reader holding a stale cursor gets the page's own "try again",
    // not a 422 rendered as a list.
    if (!response.ok) return { ok: false, failure: 'unavailable' };
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, failure: 'unavailable' };
    return { ok: true, data: parsed.data };
  } catch {
    // A refused connection, a timeout, or a body that is not JSON: one state to
    // a reader, one state to the page.
    return { ok: false, failure: 'unavailable' };
  }
}

/** What a remove can honestly be. Never a boolean: a 404 is its own sentence. */
export type RemoveOutcome =
  /** 204 — the mark is gone. */
  | 'removed'
  /** 404 `LIBRARY_BOOKMARK_NOT_FOUND` — already gone, or never this reader's. */
  | 'not-found'
  /** Anything else, including a refused connection: the mark is still there. */
  | 'failed';

/**
 * `DELETE /api/bookmarks/{id}` through the same seam a page's read uses.
 *
 * The owner is the session cookie and nothing else: the id in the path is the
 * TARGET, and the route answers 404 for "not yours" and "not there" alike so a
 * probe cannot learn whether another reader's mark exists.
 *
 * @param id the bookmark id, untrusted, so it is length-capped and encoded
 */
export async function removeBookmarkThroughApi(id: string): Promise<RemoveOutcome> {
  try {
    const [origin, cookie] = await Promise.all([apiOrigin(), sessionCookie()]);
    if (origin === null) return 'failed';
    // A path segment is length-capped. An id longer than a uuid is not a
    // bookmark, and an unbounded segment is an unbounded URL.
    if (id.length === 0 || id.length > 64) return 'failed';
    const response = await fetch(new URL(`/api/bookmarks/${encodeURIComponent(id)}`, origin), {
      cache: 'no-store',
      method: 'DELETE',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      headers: { ...(cookie === null ? {} : { cookie }) },
    });
    if (response.status === 204) return 'removed';
    if (response.status === 404) return 'not-found';
    return 'failed';
  } catch {
    return 'failed';
  }
}
