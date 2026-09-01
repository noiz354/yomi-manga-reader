/**
 * `GET /api/search` — ranked title/alias/creator/tag search.
 *
 * It reads the `/api/v1` seam even though it is not a `/api/v1` path: the
 * alternative is a third registry plus a second catalog composition for the
 * same public rows. Search is public data, so it answers 200 with no session —
 * no `resolveCaller`, no 401 — and the repository filters visibility per branch.
 *
 * The rate limit is an in-process sliding window (30/min/IP). That is enough
 * for the one-process, one-box self-hosted reader and is NOT enough for a
 * multi-instance deployment; an in-memory limiter that pretended to be global
 * would be worse than one that says it is local.
 *
 * The client IP is the first `x-forwarded-for` entry, falling back to the
 * direct remote address, falling back to "unknown" — and "unknown" shares ONE
 * bucket, so a deployment that strips the header degrades to a global 30/min
 * rather than to no limit at all.
 *
 * Empty or overlong `q`, and a bad or foreign cursor, are 422s from the service
 * (the service owns the request; this route owns the transport). A 429 carries
 * `Retry-After: 60`.
 */
import { AppError } from '../../../shared/contracts/errors';
import type { SearchService } from '../../../features/search/search.service';
import type { Logger } from '../../../server/telemetry/logger';
import { apiV1DepsForRequest } from '../v1/_runtime';
import { SILENT_LOGGER, failureResponse, jsonResponse, requestIdOf } from '../v1/_http';

/** Never prerendered; anonymous search is still member data in the caching sense. */
export const dynamic = 'force-dynamic';

/** The route template. */
const ROUTE = '/api/search';

/** Search answers are private and uncacheable. */
const NO_STORE = 'no-store';

/** 30 requests per minute per IP. */
const SEARCH_WINDOW_MS = 60_000;
const SEARCH_MAX_HITS = 30;

/**
 * In-process sliding window, keyed by client IP (see the file header for what
 * this does and does not promise).
 *
 * Pruned on access: a timestamp older than the window is dropped when its IP is
 * seen again, and an IP with no timestamps left is dropped entirely, so the Map
 * cannot grow without bound on a scanner that walks the IPv6 space.
 */
const windows = new Map<string, number[]>();

function clientIpOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded !== '') {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first !== '') return first;
  }
  // Next 16 exposes the remote address here; anything else is "unknown", and
  // unknown shares one bucket (see the header).
  const direct = (request as unknown as { ip?: unknown }).ip ?? request.headers.get('x-real-ip');
  return typeof direct === 'string' && direct !== '' ? direct : 'unknown';
}

/**
 * Record a hit and answer whether the caller is over the limit.
 *
 * @returns `true` when this request must be refused with 429.
 */
export function checkSearchRateLimit(ip: string, now: number = Date.now()): boolean {
  const cutoff = now - SEARCH_WINDOW_MS;
  const kept = (windows.get(ip) ?? []).filter((stamp) => stamp > cutoff);
  kept.push(now);
  if (kept.length > SEARCH_MAX_HITS) {
    windows.set(ip, kept);
    return true;
  }
  if (kept.length === 0) windows.delete(ip);
  else windows.set(ip, kept);
  return false;
}

/** Test-only: empty the limiter so suites do not leak buckets into each other. */
export function resetSearchRateLimit(): void {
  windows.clear();
}

/** The handler, as a factory over its dependencies (see the sibling routes). */
export function createSearchHandler(deps: { search: SearchService; logger: Logger }) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = requestIdOf(request);

    if (checkSearchRateLimit(clientIpOf(request))) {
      // `failureResponse` has no Retry-After option, so the header is set on the
      // mapped response rather than inventing a fifth argument for one route. A
      // 429 without it is a client that cannot tell when to retry, and a client
      // that cannot tell when to retry retries immediately.
      const refused = failureResponse(
        new AppError('RATE_LIMIT_SEARCH'),
        requestId,
        deps.logger,
        ROUTE,
      );
      refused.headers.set('retry-after', '60');
      return refused;
    }

    try {
      const url = new URL(request.url);
      const q = url.searchParams.get('q') ?? '';
      const cursorParam = url.searchParams.get('cursor');
      const limitParam = url.searchParams.get('limit');

      // `limit` is parsed leniently and clamped by the service: `?limit=abc` is
      // not a number, and "not a number" is not an attack — it is the default
      // with extra steps. Only an explicit, parseable number is passed through.
      const parsedLimit = limitParam === null ? undefined : Number(limitParam);
      const limit =
        parsedLimit === undefined || !Number.isFinite(parsedLimit) ? undefined : parsedLimit;

      const result = await deps.search.search({
        q,
        ...(cursorParam === null ? {} : { cursor: cursorParam }),
        ...(limit === undefined ? {} : { limit }),
      });

      return jsonResponse(
        { items: result.items, nextCursor: result.nextCursor },
        { status: 200, requestId, cacheControl: NO_STORE },
      );
    } catch (cause) {
      return failureResponse(
        cause instanceof AppError ? cause : new AppError('INTERNAL_ERROR', { cause }),
        requestId,
        deps.logger,
        ROUTE,
      );
    }
  };
}

/** The Next.js entry point; see `v1/catalog/route.ts` for the registry rationale. */
export async function GET(request: Request): Promise<Response> {
  const deps = await apiV1DepsForRequest();
  if (deps === null) {
    return failureResponse(
      new AppError('INTERNAL_ERROR', {
        cause: new Error('no /api/v1 dependencies registered by the composition root'),
      }),
      requestIdOf(request),
      SILENT_LOGGER,
      ROUTE,
    );
  }
  return createSearchHandler(deps)(request);
}
