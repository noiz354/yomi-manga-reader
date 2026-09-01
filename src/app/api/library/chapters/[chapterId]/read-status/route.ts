/**
 * `POST /api/library/chapters/{chapterId}/read-status` — mark read or unread.
 *
 * The acting user is the session's, never the body's: the body carries only
 * `read`, an intent, not a person. Membership is enforced per route, so a null
 * `resolveCaller` is a 401. The 204 has no body deliberately: a command has no
 * reply, and a body would invite clients to read state the response lies about.
 */
import { AppError } from '../../../../../../shared/contracts/errors';
import { readJsonBody } from '../../../../../../shared/http/request-body';
import { apiDepsForRequest } from '../../../../_runtime';
import type { ApiDeps } from '../../../../_deps';
import { SILENT_LOGGER, failureResponse, requestIdOf } from '../../../../v1/_http';

/** Member data: never prerendered. */
export const dynamic = 'force-dynamic';

/** The route TEMPLATE, with `{chapterId}` and no real id. */
const ROUTE = '/api/library/chapters/{chapterId}/read-status';

/** Private data is `no-store`, so a 204 still says so. */
const NO_STORE = 'no-store';

/** Next.js 15+ hands `params` to a handler as a promise. */
interface RouteContext {
  readonly params: Promise<{ chapterId: string }>;
}

interface ReadStatusBody {
  read?: unknown;
}

/**
 * `read` must be a real boolean, and a missing one is NOT `false`.
 *
 * Two failure shapes are refused rather than repaired, for the same reason the
 * reader's `?page=` is: a value this endpoint cannot act on is a client bug worth
 * answering, and a body of `{}` means "the caller sent nothing", which is not the
 * same statement as "mark it unread". `Boolean('false')` is `true`, and
 * `Boolean(0)` is `false`, so coercing would let `"read": 0` silently mark a
 * chapter read.
 */
function parseRead(body: ReadStatusBody): boolean {
  if (typeof body.read !== 'boolean') {
    throw new AppError('VALIDATION_BAD_QUERY', {
      details: [{ path: 'read', message: 'Expected true or false.' }],
    });
  }
  return body.read;
}

/** The handler, as a factory over its dependencies (see the sibling routes). */
export function createSetReadStatusHandler(deps: ApiDeps) {
  return async function POST(request: Request, context: RouteContext): Promise<Response> {
    const requestId = requestIdOf(request);
    // The ONLY identity source.
    const caller = await deps.resolveCaller(request);
    if (caller === null) {
      return failureResponse(new AppError('AUTH_REQUIRED'), requestId, deps.logger, ROUTE);
    }

    try {
      const body = await readJsonBody<ReadStatusBody>(request).catch(() => undefined);
      if (body === undefined) {
        throw new AppError('VALIDATION_BAD_QUERY', {
          details: [{ path: 'body', message: 'Expected a JSON object.' }],
        });
      }
      const read = parseRead(body);

      // The target from the path, the OWNER from the session — never the other way
      // round. The service checks chapter visibility first, so an unpublished or
      // soft-deleted chapter is a 404 rather than a probe.
      const { chapterId } = await context.params;
      await deps.library.setReadStatus(caller, chapterId, read);

      // Built directly rather than through `jsonResponse`: 204 is defined as
      // having no body, and a JSON constructor cannot promise that. Same idiom
      // and same reason as `library/[mangaId]/route.ts`.
      return new Response(null, {
        status: 204,
        headers: { 'x-request-id': requestId, 'cache-control': NO_STORE },
      });
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

/** The Next.js entry point; see `library/[mangaId]/route.ts` for the registry rationale. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
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
  return createSetReadStatusHandler(deps)(request, context);
}
