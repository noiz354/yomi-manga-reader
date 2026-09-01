/**
 * `/api/library` — the signed-in reader's shelf: the list, and the add.
 *
 * Both go through the composition seam rather than a per-request database
 * handle. The add is idempotent — double-adding is deliberately not a 409 —
 * and an unknown manga is rejected before the foreign key can turn it into a
 * bare 500.
 */
import { AppError } from '../../../shared/contracts/errors';
import type { LibrarySort } from '../../../shared/contracts';
import { readJsonBody } from '../../../shared/http/request-body';
import { apiDepsForRequest } from '../_runtime';
import type { ApiDeps } from '../_deps';
import type { MangaId, MangaSlug } from '../../../shared/types';
import {
  failureResponse,
  jsonResponse,
  requestIdOf,
  PRIVATE_CACHE_CONTROL,
} from '../v1/_http';

const ROUTE = '/api/library';
const SORTS: readonly LibrarySort[] = ['last_read_desc', 'added_desc', 'title_asc'];
const LIMIT_MAX = 48;

/**
 * Private data (library/progress/history/bookmarks) is `no-store`. Every
 * response below this line is a reader's own data, so the catalog cache header
 * `jsonResponse` defaults to would be wrong here.
 *
 * Written as a local constant rather than exported from `v1/_http` because this
 * module does not own that shared header; the right home for it is beside
 * `CATALOG_CACHE_CONTROL`.
 */
const NO_STORE = 'no-store';

/**
 * Used only on the "no composition" path, where there is by definition no real
 * logger — the same position the `/api/v1` seam documents for its own 500.
 */
const SILENT_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as ApiDeps['logger'];

/**
 * The handler, as a factory over its dependencies, so a test can call it with no
 * global state and no database (the seam's contract).
 *
 * @param deps the wired members' services
 */
export function createLibraryListHandler(deps: ApiDeps) {
  return async function GET(request: Request): Promise<Response> {
    // The shelf is members-only. The 401 is decided HERE, at the HTTP edge,
    // because that is what the status code means; the service still re-checks
    // internally, so a future non-HTTP caller cannot skip the rule by forgetting
    // this line.
    const caller = await deps.resolveCaller(request);
    if (caller === null) {
      return failureResponse(
        new AppError('AUTH_REQUIRED'),
        requestIdOf(request),
        deps.logger,
        ROUTE,
      );
    }

      try {
        const url = new URL(request.url);
        const sortParam = url.searchParams.get('sort');
        // An unrecognised sort is the default, not a 422: the query string is a
        // navigation aid, and a shared link with a stale sort should still open the
        // shelf rather than refuse.
        const sort: LibrarySort =
          sortParam !== null && SORTS.includes(sortParam as LibrarySort)
            ? (sortParam as LibrarySort)
            : 'last_read_desc';
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
        const cursor = url.searchParams.get('cursor');

        const page = await deps.library.list(caller, {
          ...(cursor === null ? {} : { cursor }),
          ...(limit === undefined || Number.isNaN(limit)
            ? {}
            : { limit: Math.min(Math.max(limit, 1), LIMIT_MAX) }),
          sort,
        });

        return jsonResponse(
          { items: page.items, nextCursor: page.nextCursor },
          // Members' data, never cached: the shelf is one reader's, and a shared
          // cache would hand it to the next.
          { status: 200, requestId: requestIdOf(request), cacheControl: PRIVATE_CACHE_CONTROL },
        );
      } catch (cause) {
        // Every service/repository throw becomes the error envelope with its own
        // status — CATALOG_PAGE_INVALID 422 on a bad cursor, AUTH_REQUIRED if the
        // session vanished between the guard and the query. Without this they
        // escaped as an unhandled 500 with no body shape and no log line.
        return failureResponse(cause, requestIdOf(request), deps.logger, ROUTE);
      }
    };
  }

  /**
   * The Next.js entry point. Resolves the composition root's registration and
   * answers 500 if the wiring has not happened — a visible, logged failure rather
   * than an empty shelf that looks like a healthy one.
   */
  export async function GET(request: Request): Promise<Response> {
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
  return createLibraryListHandler(deps)(request);
}

/**
 * The untrusted body, typed by the fields this handler reads rather than asserted
 * to `any`; every value is still untrusted until a check below says otherwise.
 */
type AddToLibraryBody = { mangaId?: unknown; slug?: unknown };

/**
 * Request bodies are untrusted, so a field is only treated as a string when it
 * really is one. `String(value)` would accept anything and stringify an object
 * into `"[object Object]"`, which then reads as a valid id. The same one-liner
 * lives in `api/bookmarks/route.ts`; it is module-private in both places because
 * neither module owns `shared/http/`.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `POST /api/library` — add one manga to the caller's shelf.
 *
 * Body: `{ mangaId }` (uuid), or `{ slug }` which is resolved through the
 * catalog. Output `200 { ok: true, mangaId }`.
 *
 * Statuses:
 *   - 401 `AUTH_REQUIRED` — no session caller (members-only).
 *   - 422 `VALIDATION_BAD_QUERY` — no JSON object, or no usable `mangaId`.
 *   - 200 — added, or ALREADY on the shelf (the add is an idempotent no-op, so
 *     a double-add is deliberately NOT a 409).
 *   - 404 `MANGA_NOT_FOUND` — the id resolves to nothing the caller may see.
 *
 * @param deps the wired members' services
 * @returns the `POST` handler
 */
export function createLibraryAddHandler(deps: ApiDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = requestIdOf(request);
    // The 401 is decided HERE, at the HTTP edge, because that is what the status
    // means; the service re-checks internally, so a non-HTTP caller cannot skip
    // the rule by forgetting this line.
    const caller = await deps.resolveCaller(request);
    if (caller === null) {
      return failureResponse(new AppError('AUTH_REQUIRED'), requestId, deps.logger, ROUTE);
    }

    try {
      const body = await readJsonBody<AddToLibraryBody>(request).catch(() => undefined);
      if (body === undefined) {
        throw new AppError('VALIDATION_BAD_QUERY', {
          details: [{ path: 'body', message: 'Expected a JSON object.' }],
        });
      }

        // `manga/bySlug` is the catalog's URL-identity read and applies the same
        // visibility clauses, so a draft slug resolves to "not found" rather than
        // to a hidden id.
        const rawMangaId = asString(body.mangaId).trim();
        const rawSlug = asString(body.slug).trim();
        const mangaId =
          rawMangaId !== ''
            ? rawMangaId
            : rawSlug !== ''
              ? ((await deps.manga.bySlug(rawSlug as MangaSlug, caller))?.id ?? '')
              : '';
        if (mangaId === '') {
          throw new AppError('VALIDATION_BAD_QUERY', {
            details: [{ path: 'mangaId', message: 'mangaId or slug is required.' }],
          });
        }

      // Existence is checked HERE so an unknown id is the contract's 404 rather
      // than the foreign key's 23503, which is not an error code and surfaced as a
      // bare 500. `byId` carries the same visibility clauses as `bySlug`, so a
      // draft or deleted title is "not found" and not "forbidden" — a 403 would
      // leak which ids exist.
      if ((await deps.manga.byId(mangaId as MangaId, caller)) === null) {
        throw new AppError('MANGA_NOT_FOUND');
      }

      // The ONLY identity source is `caller`; the body supplies the target, never
      // the owner.
      await deps.library.add(caller, mangaId);

      return jsonResponse({ ok: true, mangaId }, { status: 200, requestId, cacheControl: NO_STORE });
    } catch (error) {
      return failureResponse(error, requestId, deps.logger, ROUTE);
    }
  };
}

/** The Next.js entry point for the add; see `GET` for the registry rationale. */
export async function POST(request: Request): Promise<Response> {
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
  return createLibraryAddHandler(deps)(request);
}
