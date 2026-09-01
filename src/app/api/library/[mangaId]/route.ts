/**
 * `DELETE /api/library/{mangaId}` — take one title off the caller's shelf.
 *
 * The delete goes through `LibraryService.remove` to the `LibraryRepository`,
 * whose `WHERE` carries the owner, so one reader's shelf cannot be edited
 * through another's id. A 204 with an empty body covers both "removed" and "not
 * on the shelf" deliberately, so remove is idempotent and a probe cannot learn
 * whether another reader owns the title.
 */
import { AppError } from '../../../../shared/contracts/errors';
import { apiDepsForRequest } from '../../_runtime';
import type { ApiDeps } from '../../_deps';
import { SILENT_LOGGER, failureResponse, requestIdOf } from '../../v1/_http';

/** Member data: never prerendered. */
export const dynamic = 'force-dynamic';

/** The route TEMPLATE, with `{mangaId}` and no real id. */
const ROUTE = '/api/library/{mangaId}';

/**
 * Private data is `no-store`, so a 204 still says so — a cache that stored
 * "removed" would hide a later re-add behind a stale answer.
 *
 * The same constant is written locally in `api/library/route.ts`,
 * `api/bookmarks/route.ts` and `api/history/route.ts`; its home belongs beside
 * `CATALOG_CACHE_CONTROL` in `v1/_http.ts`.
 */
const NO_STORE = 'no-store';

/** Next.js 15+ hands `params` to a handler as a promise. */
interface RouteContext {
  readonly params: Promise<{ mangaId: string }>;
}

/**
 * The handler, as a factory over its dependencies, so a test can call it with no
 * global state and no database.
 *
 * Statuses:
 *   - 401 `AUTH_REQUIRED` — no session caller (members-only).
 *   - 204, empty body — removed, OR not on the shelf: the two are deliberately
 *     the same answer, so a client can treat "remove" as idempotent and a probe
 *     cannot learn whether another reader has this title.
 *   - 500 `INTERNAL_ERROR` — an unhandled failure, logged with its cause and
 *     answered with the generic body.
 *
 * @param deps the wired members' services
 * @returns the `DELETE` handler
 */
export function createLibraryRemoveHandler(deps: ApiDeps) {
  return async function DELETE(request: Request, context: RouteContext): Promise<Response> {
    const requestId = requestIdOf(request);
    const caller = await deps.resolveCaller(request);
    if (caller === null) {
      return failureResponse(new AppError('AUTH_REQUIRED'), requestId, deps.logger, ROUTE);
    }

    try {
      const { mangaId } = await context.params;
      // The target comes from the path, the OWNER from the session — never the
      // other way round.
      await deps.library.remove(caller, mangaId);
      // Built directly rather than through `jsonResponse`: 204 is defined as
      // having no body, and a JSON constructor cannot promise that.
      return new Response(null, {
        status: 204,
        headers: { 'x-request-id': requestId, 'cache-control': NO_STORE },
      });
    } catch (error) {
      return failureResponse(error, requestId, deps.logger, ROUTE);
    }
  };
}

/** The Next.js entry point; see `api/library/route.ts` for the registry rationale. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const deps = await apiDepsForRequest();
  if (deps === null) {
    return failureResponse(
      new AppError('INTERNAL_ERROR', {
        cause: new Error('no /api dependencies registered by the composition root'),
      }),
      requestIdOf(request),
      SILENT_LOGGER,
      ROUTE,
    );
  }
  return createLibraryRemoveHandler(deps)(request, context);
}
