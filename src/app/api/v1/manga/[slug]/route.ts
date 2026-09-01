/**
 * `GET /api/v1/manga/{slug}` — one manga, in full.
 *
 * The detail page fetches exactly this path, so without the route it falls
 * through to its "unavailable" branch. The caller comes from the verified
 * session and from nothing else: no `?role=`, no `?userId`, no path segment.
 * An unknown, unpublished or soft-deleted slug answers 404 `MANGA_NOT_FOUND`,
 * deliberately indistinguishable. Rate limiting is not here: the generic
 * per-IP budget owns it, and a per-route limiter would read as enforced while
 * it is not.
 */
import { AppError } from '../../../../../shared/contracts/errors';
import type { MangaSlug } from '../../../../../shared/types';
import {
  CATALOG_CACHE_CONTROL,
  SILENT_LOGGER,
  failureResponse,
  jsonResponse,
  requestIdOf,
} from '../../_http';
import type { ApiV1Deps } from '../../_deps';
import { apiV1DepsForRequest } from '../../_runtime';
import { mangaDetailQuerySchema, parseQuery } from '../../_query';

/** Never prerendered: it reads the database, per slug. */
export const dynamic = 'force-dynamic';

/** The route TEMPLATE, with `{slug}` and no real id. */
const ROUTE = '/api/v1/manga/{slug}';

/** Next.js 15+ hands `params` to a handler as a promise. */
interface RouteContext {
  readonly params: Promise<{ slug: string }>;
}

/**
 * Builds the request handler over its dependencies.
 *
 * @param deps the catalog service, the caller resolver and the logger
 * @returns the `GET` handler
 */
export function createMangaDetailHandler(
  deps: ApiV1Deps,
): (request: Request, context: RouteContext) => Promise<Response> {
  return async function GET(request: Request, context: RouteContext): Promise<Response> {
    const requestId = requestIdOf(request);
    try {
      const { slug } = parseQuery(mangaDetailQuerySchema, await context.params);
      // The ONLY identity source.
      const caller = await deps.resolveCaller(request);
      const detail = await deps.catalog.detail(slug as MangaSlug, caller);
      // `null` means unknown, unpublished or soft-deleted — one answer, on
      // purpose. The page turns it into the real 404 page.
      if (detail === null) throw new AppError('MANGA_NOT_FOUND');
      return jsonResponse(detail, { status: 200, requestId, cacheControl: CATALOG_CACHE_CONTROL });
    } catch (error) {
      return failureResponse(error, requestId, deps.logger, ROUTE);
    }
  };
}

/** The Next.js entry point; see `catalog/route.ts` for the registry rationale. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
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
  return createMangaDetailHandler(deps)(request, context);
}
