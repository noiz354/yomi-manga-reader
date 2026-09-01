/**
 * The unversioned `/api` runtime adapter — the one module that joins the
 * composition root to the `/api` dependency seam.
 *
 * `_deps.ts` must not import infrastructure (it exists precisely so a route never
 * constructs infrastructure), and `server/composition.ts` must not know about an
 * app-layer seam. This file is the joint: it is an `app/api` module, so it may
 * import the composition root, and it hands the result to the seam as data.
 */
import { createLibraryComposition } from '../../server/composition';
import { resolveCallerContext } from '../../server/auth/guard';
import { apiDepsWith, type ApiDeps } from './_deps';
import type { CallerContext } from '../../shared/contracts';

/**
 * The caller resolver for the members' surface.
 *
 * `/api/library`, `/api/bookmarks` and `/api/history` are member-only, so a
 * resolver that answered `null` would turn every one of them into a 401 and the
 * pages into empty states.
 *
 * It delegates to `resolveCallerContext`, which reads the session cookie and
 * narrows the verified row. Keeping this in one place matters: the same narrowing
 * duplicated in the `/api/v1` seam drifted to `Promise<null>` and silently cost
 * every signed-in reader their "continue reading" position.
 *
 * The guard acquires the process-wide pool only when a token is present, so an
 * anonymous request never touches it from this path.
 */
export function resolveCaller(request: Request): Promise<CallerContext> {
  return resolveCallerContext(request);
}

/**
 * Builds the real `/api` dependencies, once per process.
 *
 * Memoisation (and the no-cache-on-failure rule) belongs to {@link apiDepsWith};
 * this only supplies the factory.
 */
async function buildApiDeps(): Promise<ApiDeps> {
  const { library, history, readerProgress, manga, chapters, preferences, logger } =
    await createLibraryComposition();
  return { library, history, readerProgress, manga, chapters, preferences, resolveCaller, logger };
}

/**
 * The dependencies a request runs on.
 *
 * @returns the wired deps, or the composition's rejection — which a route logs
 *   with its real cause rather than answering "not wired"
 * @throws {ConfigurationError | DatabaseConfigurationError} when boot fails
 */
export function apiDepsForRequest(): Promise<ApiDeps | null> {
  return apiDepsWith(buildApiDeps);
}
