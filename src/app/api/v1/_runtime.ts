/**
 * The `/api/v1` runtime adapter — the one module that joins the composition
 * root to the `/api/v1` dependency seam.
 *
 * Why it exists: `_deps.ts` must not import infrastructure, and
 * `server/composition.ts` must not know about an app-layer seam. This file is
 * the joint: an `app/api` module may import the composition root, and hands the
 * result to the seam as data.
 */
import { createCatalogComposition } from '../../../server/composition';
import { resolveCallerContext } from '../../../server/auth/guard';
import { apiV1DepsWith, type ApiV1Deps } from './_deps';
import type { CallerContext } from '../../../shared/contracts';

/**
 * The caller resolver for `/api/v1`.
 *
 * Delegates to `resolveCallerContext` rather than re-reading the session, so
 * `/api` and `/api/v1` cannot drift into granting different authority from the
 * same cookie. It reads the session cookie and nothing else: there is no path
 * here by which a header, a query parameter or a body field names the acting
 * user.
 */
export function resolveCaller(request: Request): Promise<CallerContext> {
  return resolveCallerContext(request);
}

/**
 * Builds the real `/api/v1` dependencies, once per process.
 *
 * Memoisation (and the no-cache-on-failure rule) belongs to
 * {@link apiV1DepsWith}; this only supplies the factory.
 */
async function buildApiV1Deps(): Promise<ApiV1Deps> {
  const { catalog, chapters, search, logger } = await createCatalogComposition();
  return { catalog, chapters, search, resolveCaller, logger };
}

/**
 * The dependencies a request runs on.
 *
 * @returns the wired deps, or the composition's rejection — which a route logs
 *   with its real cause rather than answering "not wired"
 * @throws {ConfigurationError | DatabaseConfigurationError} when boot fails
 */
export function apiV1DepsForRequest(): Promise<ApiV1Deps | null> {
  return apiV1DepsWith(buildApiV1Deps);
}
