/**
 * `GET /api/v1/manga/{slug}/chapters` — the chapter list in reading order.
 *
 * Body: `{ items: ChapterSummary[] }`, no cursor, `items: []` for a manga with no
 * chapters. `includeDrafts` is honoured ONLY for an admin caller; a non-admin
 * sending it gets the published-only list, never an error and never a draft.
 * Failures: `MANGA_NOT_FOUND` 404, `CHAPTER_LIST_TOO_LARGE` 409, `VALIDATION_BAD_QUERY`
 * 422, `INTERNAL_ERROR` 500. Cache: `private, max-age=60, stale-while-revalidate=60`.
 *
 * The caller comes from `deps.resolveCaller(request)` — the verified session — and
 * from NOTHING else. `includeDrafts` is a request for MORE data, never a claim to
 * be allowed to see it.
 */
import { AppError } from '../../../../../../shared/contracts/errors';
import type { MangaSlug } from '../../../../../../shared/types';
import {
  CATALOG_CACHE_CONTROL,
  SILENT_LOGGER,
  failureResponse,
  jsonResponse,
  requestIdOf,
} from '../../../_http';
import type { ApiV1Deps } from '../../../_deps';
import { apiV1DepsForRequest } from '../../../_runtime';
import { chapterListQuerySchema, parseQuery } from '../../../_query';

/** Never prerendered: it reads the database, per slug. */
export const dynamic = 'force-dynamic';

/** The route TEMPLATE, with `{slug}` and no real id. */
const ROUTE = '/api/v1/manga/{slug}/chapters';

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
export function createChapterListHandler(
  deps: ApiV1Deps,
): (request: Request, context: RouteContext) => Promise<Response> {
  return async function GET(request: Request, context: RouteContext): Promise<Response> {
    const requestId = requestIdOf(request);
    try {
      const params = await context.params;
      const query = parseQuery(chapterListQuerySchema, {
        slug: params.slug,
        ...(new URL(request.url).searchParams.has('includeDrafts')
          ? { includeDrafts: new URL(request.url).searchParams.get('includeDrafts') ?? '' }
          : {}),
      });
      // The ONLY identity source.
      const caller = await deps.resolveCaller(request);
      const items = await deps.catalog.chapterList(query.slug as MangaSlug, caller, {
        ...(query.includeDrafts === undefined ? {} : { includeDrafts: query.includeDrafts }),
      });
      if (items === null) throw new AppError('MANGA_NOT_FOUND');
      return jsonResponse(
        { items },
        { status: 200, requestId, cacheControl: CATALOG_CACHE_CONTROL },
      );
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
  return createChapterListHandler(deps)(request, context);
}
