/**
 * GET /api/v1/chapters/{chapterId}/pages — the page list the reader renders.
 *
 * Public read: no session required. A chapter is readable only when its PARENT
 * manga is published and undeleted, so visibility is resolved through the parent
 * row rather than assumed from the chapter existing — the same rule `/media`
 * enforces per image, and why the S3 bucket can stay private.
 *
 * The route goes through the seam's `ChapterRepository`. `pageList` returns the
 * page list AND the prev/next published neighbours, so chapter navigation is
 * already in this response rather than a second round trip.
 *
 * Cache: `private, max-age=60`, not `no-store`. The list is not per-user, but it
 * is not public either — a soft-deleted manga must stop being served promptly,
 * and a long cache would outlive that.
 */
import { AppError } from '../../../../../../shared/contracts/errors';
import type { ChapterId } from '../../../../../../shared/types';
import { apiV1DepsForRequest } from '../../../_runtime';
import type { ApiV1Deps } from '../../../_deps';
import { failureResponse, jsonResponse, requestIdOf } from '../../../_http';

const ROUTE = 'api.v1.chapters.pages';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ chapterId: string }>;
}

/**
 * Used only for the "no deps registered" path, which is a wiring bug rather than a
 * client error: there is no logger to log with until the deps exist.
 */
const SILENT_LOGGER = {
  error() {},
  warn() {},
  info() {},
  debug() {},
} as unknown as ApiV1Deps['logger'];

/** The chapter-pages list is not per-user, so 60s of private caching is safe. */
const CACHE_CONTROL = 'private, max-age=60';

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdOf(_request);
  const deps = await apiV1DepsForRequest();
  if (deps === null) {
    return failureResponse(
      new AppError('INTERNAL_ERROR', {
        cause: new Error('no /api/v1 dependencies registered by the composition root'),
      }),
      requestId,
      SILENT_LOGGER,
      ROUTE,
    );
  }

  try {
    const { chapterId } = await context.params;
    // The port applies the visibility rules — including the parent-manga check and
    // the draft-status check — so this handler owns none of them. That is the
    // point of moving the reads off a direct database handle.
    const result = await deps.chapters.pageList(chapterId as ChapterId, null);
    if (result === null) {
      // A missing chapter, a chapter of an unpublished manga, and an unpublished
      // chapter are all the same answer. Separating them would confirm the
      // existence of a draft to an anonymous caller.
      throw new AppError('CHAPTER_NOT_FOUND');
    }

    return jsonResponse(result, { status: 200, requestId, cacheControl: CACHE_CONTROL });
  } catch (cause) {
    return failureResponse(
      cause instanceof AppError ? cause : new AppError('INTERNAL_ERROR', { cause }),
      requestId,
      deps.logger,
      ROUTE,
    );
  }
}
