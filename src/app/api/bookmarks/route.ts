/**
 * `/api/bookmarks` — the pages this reader kept: the list, and the create.
 *
 * Both go through the seam: `LibraryService` owns the note bound and
 * `BookmarkRepository.create` translates the unique violation to
 * `LIBRARY_BOOKMARK_EXISTS` itself, by error code rather than by message. No
 * DTO here carries a `userId`, and an over-long note is refused rather than
 * silently truncated.
 */
import { AppError } from '../../../shared/contracts/errors';
import { readJsonBody } from '../../../shared/http/request-body';
import { apiDepsForRequest } from '../_runtime';
import type { ApiDeps } from '../_deps';
import type { ChapterId } from '../../../shared/types';
import { SILENT_LOGGER, failureResponse, jsonResponse, requestIdOf } from '../v1/_http';

const ROUTE = '/api/bookmarks';

/** Member data: never prerendered. */
export const dynamic = 'force-dynamic';

/**
 * Private data is `no-store`; see the same constant in
 * `api/library/route.ts` for why it is written per file rather than imported.
 */
const NO_STORE = 'no-store';

/**
 * Request bodies are untrusted, so a field is only treated as a string when it
 * really is one — `String(value)` would accept an object and stringify it into
 * `"[object Object]"`, which then reads as a valid id. The same one-liner is
 * module-private in `api/library/route.ts`.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A body-level 422, with the field named so a client can point at it. */
function badBody(path: string, message: string): AppError {
  return new AppError('VALIDATION_BAD_QUERY', { details: [{ path, message }] });
}

/**
 * The list handler, as a factory over its dependencies.
 *
 * Statuses:
 *   - 401 `AUTH_REQUIRED` — no session caller (members-only).
 *   - 200 `{ items: Bookmark[], nextCursor }` — `items` may be empty, which is a
 *     real answer, not a fault. A bookmark whose chapter is gone is RETAINED and
 *     carries `chapter: null`, so the client disables the jump rather than
 *     dropping the row.
 *   - 422 `CATALOG_PAGE_INVALID` — a cursor this list cannot read. The repository
 *     rejects rather than repairs it, because a cursor minted for another sort
 *     would silently return the wrong page.
 *   - 500 `INTERNAL_ERROR` — an unhandled failure, logged with its cause and
 *     answered with the generic body.
 *
 * @param deps the wired members' services
 * @returns the `GET` handler
 */
export function createBookmarkListHandler(deps: ApiDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = requestIdOf(request);
    const caller = await deps.resolveCaller(request);
    if (caller === null) {
      return failureResponse(new AppError('AUTH_REQUIRED'), requestId, deps.logger, ROUTE);
    }

    try {
      const url = new URL(request.url);
      const cursor = url.searchParams.get('cursor');
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10);
      const page = await deps.library.listBookmarks(caller, {
        ...(cursor === null ? {} : { cursor }),
        // A limit is passed through only when it PARSED: a repository that
        // indexed `query.limit` would throw a bare TypeError — a 500 — for a
        // caller that handed it `NaN`. The clamp itself is the repository's
        // (48, the same page cap as the shelf), so this edge does not keep a
        // second copy of the rule.
        ...(limit === undefined || Number.isNaN(limit) ? {} : { limit }),
      });

      return jsonResponse(
        { items: page.items, nextCursor: page.nextCursor },
        { status: 200, requestId, cacheControl: NO_STORE },
      );
    } catch (error) {
      return failureResponse(error, requestId, deps.logger, ROUTE);
    }
  };
}

/** The Next.js entry point; see `api/library/route.ts` for the registry rationale. */
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
  return createBookmarkListHandler(deps)(request);
}

/** The untrusted body, typed by the fields this handler reads. */
type CreateBookmarkBody = { chapterId?: unknown; pageNumber?: unknown; note?: unknown };

/**
 * The create handler, as a factory over its dependencies.
 *
 * Input: `{ chapterId, pageNumber?, note? }` — `pageNumber` absent or null both
 * mean the chapter's first page, and `note` is plain text of at most 280
 * characters.
 * Output: `201 { bookmark }`.
 *
 * Statuses:
 *   - 401 `AUTH_REQUIRED` — no session caller (members-only).
 *   - 422 `VALIDATION_BAD_QUERY` — no JSON object, no `chapterId`, or a
 *     `pageNumber` that is neither null nor an integer ≥ 1.
 *   - 422 `VALIDATION_FIELD_INVALID` — a note over 280 characters. The SERVICE
 *     raises this, not this route: the bound is a contract, and the service
 *     refuses an over-long note rather than storing a silently shortened one.
 *   - 409 `LIBRARY_BOOKMARK_EXISTS` — this page is already marked, raised by the
 *     repository from the unique-index violation.
 *   - 500 `INTERNAL_ERROR` — an unhandled failure.
 *
 * The chapter must exist and the page must fall inside it: both are checked
 * here because nothing downstream can, and without them an unknown `chapterId`
 * would surface as a foreign-key 500 and an out-of-range page could be stored.
 *
 * @param deps the wired members' services
 * @returns the `POST` handler
 */
export function createBookmarkCreateHandler(deps: ApiDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = requestIdOf(request);
    const caller = await deps.resolveCaller(request);
    if (caller === null) {
      return failureResponse(new AppError('AUTH_REQUIRED'), requestId, deps.logger, ROUTE);
    }

    try {
      const body = await readJsonBody<CreateBookmarkBody>(request).catch(() => undefined);
      if (body === undefined) throw badBody('body', 'Expected a JSON object.');

      const chapterId = asString(body.chapterId).trim();
      if (chapterId === '') throw badBody('chapterId', 'chapterId is required.');

      // `undefined` and `null` are the same request — "the chapter's first page"
      // — and the column is nullable, so both become null here. Anything else
      // must be a real page: `Number('abc')` is `NaN` and `Number(true)` is 1,
      // so the type is checked before the value.
      const rawPage = body.pageNumber;
      let pageNumber: number | null = null;
      if (rawPage !== undefined && rawPage !== null) {
        const parsed = typeof rawPage === 'number' ? rawPage : Number(rawPage);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw badBody('pageNumber', 'pageNumber must be an integer of at least 1, or null.');
        }
        pageNumber = parsed;
      }

      // The service owns the 280 bound; the note is passed through as written so
      // an over-long one is REFUSED rather than quietly shortened.
      const note = asString(body.note);

      // Two checks this route owns, because nothing downstream can: the chapter has
      // to exist, and the page has to be inside it. Both were answers the direct-
      // database version gave from the row it was already reading; losing them turned
      // an unknown `chapterId` into a foreign-key 500 and let a page number far past
      // the end of a chapter be stored, which is a bookmark no reader can open.
      const chapter = await deps.chapters.byId(chapterId as ChapterId, caller);
      if (chapter === null) {
        throw new AppError('CHAPTER_NOT_FOUND');
      }
      if (pageNumber !== null && pageNumber > chapter.pageCount) {
        throw new AppError('READER_INVALID_PAGE', {
          details: [
            {
              path: 'pageNumber',
              message: `This chapter has ${chapter.pageCount} page(s).`,
            },
          ],
        });
      }

      const bookmark = await deps.library.createBookmark(caller, {
        chapterId,
        pageNumber,
        ...(note === '' ? {} : { note }),
      });

      return jsonResponse({ bookmark }, { status: 201, requestId, cacheControl: NO_STORE });
    } catch (error) {
      return failureResponse(error, requestId, deps.logger, ROUTE);
    }
  };
}

/** The Next.js entry point for the create; see `GET` for the registry rationale. */
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
  return createBookmarkCreateHandler(deps)(request);
}
