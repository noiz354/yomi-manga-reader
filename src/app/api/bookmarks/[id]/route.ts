/**
 * `DELETE /api/bookmarks/{id}` — drop one mark.
 *
 * "Not yours" and "no such id" are one 404, so the endpoint cannot be used to
 * probe whether another reader's mark exists.
 */
import { AppError } from '../../../../shared/contracts/errors';
import { apiDepsForRequest } from '../../_runtime';
import type { ApiDeps } from '../../_deps';
import { SILENT_LOGGER, failureResponse, requestIdOf } from '../../v1/_http';

/** Member data: never prerendered. */
export const dynamic = 'force-dynamic';

/** The route TEMPLATE, with `{id}` and no real id. */
const ROUTE = '/api/bookmarks/{id}';

/**
 * Private data is `no-store`, so the 204 still says so — a cached "removed"
 * would hide a later re-mark. Written locally for the same reason as in
 * `api/library/route.ts`: `v1/_http.ts` is not this module's file.
 */
const NO_STORE = 'no-store';

/** Next.js 15+ hands `params` to a handler as a promise. */
interface RouteContext {
  readonly params: Promise<{ id: string }>;
}

/**
 * The handler, as a factory over its dependencies, so a test can call it with no
 * global state and no database.
 *
 * Statuses:
 *   - 401 `AUTH_REQUIRED` — no session caller (members-only).
 *   - 204, empty body — the mark is gone.
 *   - 404 `LIBRARY_BOOKMARK_NOT_FOUND` — raised for BOTH "this id is not yours"
 *     and "no such id", on purpose: the repository's `WHERE` carries the owner,
 *     so the two are one zero-row result and one answer. A distinct message would
 *     turn this 404 into an oracle for whether some other reader's bookmark id
 *     exists.
 *   - 500 `INTERNAL_ERROR` — an unhandled failure, logged with its cause and
 *     answered with the generic body.
 *
 * @param deps the wired members' services
 * @returns the `DELETE` handler
 */
export function createBookmarkRemoveHandler(deps: ApiDeps) {
  return async function DELETE(request: Request, context: RouteContext): Promise<Response> {
    const requestId = requestIdOf(request);
    const caller = await deps.resolveCaller(request);
    if (caller === null) {
      return failureResponse(new AppError('AUTH_REQUIRED'), requestId, deps.logger, ROUTE);
    }

    try {
      const { id } = await context.params;
      // The target comes from the path, the OWNER from the session. The service
      // is what makes "not yours" a 404.
      await deps.library.removeBookmark(caller, id);
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
  return createBookmarkRemoveHandler(deps)(request, context);
}
