/**
 * The catalog pages' data access — a typed query layer owned by the UI lane.
 *
 * It parses the contract once with Zod and returns a discriminated failure the
 * page renders, so an unreachable API becomes a labelled message, not a 500.
 * The origin is reconstructed from the request headers, and the read is
 * `no-store` because v1 has no server-side application cache.
 */
// TODO: the shared logger facade owns the server-side record of a failed read;
// nothing under `src/app/**` may log yet, and printing upstream detail to the
// browser is forbidden.
import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';
import type { ChapterSummary, MangaDetail, MangaSummary } from '../../shared/contracts';
import {
  catalogPageSchema,
  chapterListSchema,
  facetsFrom,
  facetsSchema,
  mangaDetailSchema,
  type GenreFacet,
} from './catalog-schema';
import { catalogApiQuery, CATALOG_PAGE_SIZE, type CatalogView } from './catalog-query';

/** How long a server-side read may take before the page renders its own state. */
const READ_TIMEOUT_MS = 5_000;

/** Why a read did not produce data — the page maps each to a distinct state. */
export type ReadFailure =
  /** The resource does not exist, or must not be seen. */
  | 'not-found'
  /** Upstream refused, timed out, or answered something unusable. */
  | 'unavailable';

export type ReadResult<T> = { ok: true; data: T } | { ok: false; failure: ReadFailure };

/** This app's own public origin, from the incoming request. */
async function apiOrigin(): Promise<string | null> {
  try {
    const requestHeaders = await headers();
    const host = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host');
    if (host === null || host === '') return null;
    // Only a loopback host is assumed to be plain http. Everything else is
    // https: guessing "http" for a public host would be the unsafe direction.
    const isLoopback = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host);
    const proto = requestHeaders.get('x-forwarded-proto') ?? (isLoopback ? 'http' : 'https');
    return `${proto}://${host}`;
  } catch {
    return null;
  }
}

/**
 * The caller's own `cookie` header, for replay onto the loopback read.
 *
 * A React Server Component's `fetch` does NOT forward the browser's cookies, so
 * every read in this file reached `/api/v1` as an ANONYMOUS request no matter who
 * was browsing. For the public catalog that was harmless and invisible. For
 * `GET /api/v1/manga/{slug}` it was not: `CatalogService.detail` omits
 * `continueReading` for a null caller, so "Continue Ch. 2 · p. 15" never
 * appeared for a reader who was signed in and mid-chapter.
 *
 * Only the session cookie is replayed, not the whole header bag: a loopback call
 * does not need `accept-language`, `user-agent` or a tracing header, and copying
 * them all would forward request metadata to a route for no reason.
 *
 * @returns the header pair, or an empty object when there is no request scope
 */
async function cookieReplay(): Promise<Record<string, string>> {
  try {
    const cookie = (await headers()).get('cookie');
    // An empty string is not the same as absent: a `cookie: ''` header would be
    // sent and the guard would look for a session named "".
    return cookie === null || cookie === '' ? {} : { cookie };
  } catch {
    // `headers()` throws outside a request scope (a script, a build-time read).
    // No caller, so no cookie — which is the correct answer, not a failure.
    return {};
  }
}

async function readJson(
  origin: string,
  path: string,
  /**
   * Whether a 404 is the answer or the fault.
   *
   * For a RESOURCE (`/manga/{slug}`) a 404 is a real answer: the title is
   * unknown, unpublished or soft-deleted, and the page must render the 404 page.
   * For a COLLECTION (`/api/v1/catalog`, `/facets`) or a sub-resource of a
   * title already known to exist, a 404 means the route is not deployed — an
   * unavailable API, not a missing title. Reading it as "not found" would send
   * a perfectly good catalog to the 404 page and hide a deployment fault behind
   * a plausible-looking state.
   */
  notFoundIsAnswer: boolean,
): Promise<ReadResult<unknown>> {
  try {
    const response = await fetch(new URL(path, origin), {
      // v1 has no server-side application cache. The API's own
      // `private, max-age=60` header is the browser's, not this read's.
      cache: 'no-store',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      headers: { accept: 'application/json', ...(await cookieReplay()) },
    });
    if (response.status === 404 && notFoundIsAnswer) {
      return { ok: false, failure: 'not-found' };
    }
    if (!response.ok) return { ok: false, failure: 'unavailable' };
    return { ok: true, data: await response.json() };
  } catch {
    // A refused connection, a timeout, or a body that is not JSON: one state to
    // a reader, and one state to the page.
    return { ok: false, failure: 'unavailable' };
  }
}

/** One page of the catalog, in the view's filters and sort. */
export const readCatalogPage = cache(
  async (
    view: CatalogView,
    limit: number = CATALOG_PAGE_SIZE,
  ): Promise<ReadResult<CatalogPage>> => {
    const origin = await apiOrigin();
    if (origin === null) return { ok: false, failure: 'unavailable' };
    const result = await readJson(origin, catalogApiQuery(view, { limit }), false);
    if (!result.ok) return result;
    const parsed = catalogPageSchema.safeParse(result.data);
    if (!parsed.success) return { ok: false, failure: 'unavailable' };
    return {
      ok: true,
      data: { items: parsed.data.items, nextCursor: parsed.data.nextCursor },
    };
  },
);

/** The genre vocabulary for the filter. Its failure is the filter's own state. */
export const readGenreFacets = cache(async (): Promise<ReadResult<GenreFacet[]>> => {
  const origin = await apiOrigin();
  if (origin === null) return { ok: false, failure: 'unavailable' };
  const result = await readJson(origin, '/api/v1/catalog/facets', false);
  if (!result.ok) return result;
  const parsed = facetsSchema.safeParse(result.data);
  if (!parsed.success) return { ok: false, failure: 'unavailable' };
  return { ok: true, data: facetsFrom(parsed.data) };
});

/** One manga, or `not-found` for unpublished / soft-deleted. */
export const readMangaDetail = cache(async (slug: string): Promise<ReadResult<MangaDetail>> => {
  const origin = await apiOrigin();
  if (origin === null) return { ok: false, failure: 'unavailable' };
  const result = await readJson(origin, `/api/v1/manga/${encodeURIComponent(slug)}`, true);
  if (!result.ok) return result;
  const parsed = mangaDetailSchema.safeParse(result.data);
  if (!parsed.success) return { ok: false, failure: 'unavailable' };
  return { ok: true, data: parsed.data };
});

/** The chapter list in reading order (no cursor, ≤ 1000). */
export const readChapterList = cache(
  async (slug: string): Promise<ReadResult<readonly ChapterSummary[]>> => {
    const origin = await apiOrigin();
    if (origin === null) return { ok: false, failure: 'unavailable' };
    const result = await readJson(
      origin,
      `/api/v1/manga/${encodeURIComponent(slug)}/chapters`,
      false,
    );
    if (!result.ok) return result;
    const parsed = chapterListSchema.safeParse(result.data);
    if (!parsed.success) return { ok: false, failure: 'unavailable' };
    return { ok: true, data: parsed.data.items };
  },
);

/** What a catalog page renders: one page of summaries, plus the next cursor. */
export interface CatalogPage {
  readonly items: readonly MangaSummary[];
  readonly nextCursor: string | null;
}

export type { GenreFacet };
