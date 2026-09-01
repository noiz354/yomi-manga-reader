/**
 * `GET /api/v1/catalog` — the paginated, filterable, sortable public catalog.
 *
 * Public: no session is read. Failures: `VALIDATION_BAD_QUERY` 422 (bad
 * sort/status/sixth genre), `CATALOG_PAGE_INVALID` 422 (bad cursor/limit),
 * `INTERNAL_ERROR` 500. Rate limiting is deliberately NOT per-route: a per-route
 * limiter is invisible to the generic budget and reads as enforced while it is
 * not. The exported `GET` resolves the composition root's registration and the
 * handler body is the whole request, so tests drive the real code.
 */
import { AppError } from '../../../../shared/contracts/errors';
import {
  CATALOG_CACHE_CONTROL,
  SILENT_LOGGER,
  failureResponse,
  jsonResponse,
  requestIdOf,
} from '../_http';
import type { ApiV1Deps } from '../_deps';
import { apiV1DepsForRequest } from '../_runtime';
import { catalogQuerySchema, parseQuery, stringBag } from '../_query';

/**
 * Never cached and never prerendered: the answer depends on the query string,
 * the database, and the moment. A prerendered artifact would serve one
 * catalog to every query and is the opposite of a live read.
 */
export const dynamic = 'force-dynamic';

/** The route TEMPLATE, never a route with an id in it. */
const ROUTE = '/api/v1/catalog';

/**
 * Builds the request handler over its dependencies.
 *
 * @param deps the catalog service, the caller resolver and the logger
 * @returns the `GET` handler
 */
export function createCatalogListHandler(deps: ApiV1Deps): (request: Request) => Promise<Response> {
  return async function GET(request: Request): Promise<Response> {
    const requestId = requestIdOf(request);
    try {
      const query = parseQuery(catalogQuerySchema, stringBag(new URL(request.url)));
      const page = await deps.catalog.list(query);
      return jsonResponse(page, { status: 200, requestId, cacheControl: CATALOG_CACHE_CONTROL });
    } catch (error) {
      return failureResponse(error, requestId, deps.logger, ROUTE);
    }
  };
}

/**
 * The Next.js entry point. Resolves the composition root's registration and
 * answers 500 if the wiring has not happened yet — which is a visible, logged
 * failure rather than an empty catalog that looks like a healthy one.
 */
export async function GET(request: Request): Promise<Response> {
  const deps = await apiV1DepsForRequest();
  if (deps === null) {
    // The composition root that owns the real logger has not run, so this
    // failure has no logger to report to (see SILENT_LOGGER). It says so in its
    // own 500 body instead.
    return failureResponse(
      new AppError('INTERNAL_ERROR', {
        cause: new Error('no /api/v1 dependencies registered by the composition root'),
      }),
      requestIdOf(request),
      SILENT_LOGGER,
      ROUTE,
    );
  }
  return createCatalogListHandler(deps)(request);
}
