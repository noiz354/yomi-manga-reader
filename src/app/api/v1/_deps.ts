/**
 * The `/api/v1` dependency seam.
 *
 * Route handlers are written as FACTORIES that take their dependencies, and the
 * Next.js entry point resolves them from this module-level registry. That keeps
 * a handler testable with no global state, lets it work the moment composition
 * registers deps, and fails honestly — a 500 with a log line saying the wiring
 * is missing — before that.
 *
 * This module holds no infrastructure and imports none: it knows a
 * `CatalogService`, a caller resolver and a `Logger`, nothing else, and the
 * composition BUILDER is passed in by the caller of `apiV1DepsWith` rather than
 * imported here. The caller resolver returns `null` for an anonymous request,
 * and the acting user is ALWAYS whatever the resolver returns from the verified
 * session — never anything from the query string.
 */
import type { CallerContext } from '../../../shared/contracts';
import type { CatalogService } from '../../../features/catalog';
import type { ChapterRepository } from '../../../features/chapters';
import type { SearchService } from '../../../features/search/search.service';
import type { Logger } from '../../../server/telemetry/logger';

/** Everything an `/api/v1` route handler is allowed to reach for. */
export interface ApiV1Deps {
  /** The catalog service (features/catalog's public surface). */
  readonly catalog: CatalogService;
  /**
   * The chapter read port. On this seam because the chapter-pages route must
   * not build its own `Db` or read `queries/reader-state.ts` directly.
   */
  readonly chapters: ChapterRepository;
  /**
   * The search service.
   *
   * It is read by `/api/search`, which is NOT a `/api/v1` path — but it takes
   * its deps from this seam anyway, because the alternative is a third registry
   * and a second catalog composition for the same public rows. The seam is
   * already the "public data, one composition, lazy once per process" joint;
   * search is public data. The `/api` members' seam would be the wrong home: its
   * bundle is built for session-scoped reads, and search must work with no
   * session at all.
   */
  readonly search: SearchService;
  /**
   * Resolves the CALLER from the verified session, or null for anonymous.
   * Until the real implementation lands the registry carries this as an
   * explicit null-returning default rather than a guess.
   */
  readonly resolveCaller: (request: Request) => Promise<CallerContext>;
  /** The logging facade. Never `console`. */
  readonly logger: Logger;
}

let registered: ApiV1Deps | null = null;

/** The lazy composition's in-flight or settled result; `null` until first use. */
let bootstrapped: Promise<ApiV1Deps> | null = null;

/**
 * Registers the wired dependencies.
 *
 * A test seam AND the fast path: when something has registered deps, no
 * composition is built. `apiV1DepsWith` checks this first, so a registered
 * bundle always wins over building one.
 *
 * @param deps the services, the caller resolver and the logger
 */
export function registerApiV1Deps(deps: ApiV1Deps): void {
  registered = deps;
}

/**
 * The registered dependencies, or `null` when nothing has been registered yet.
 *
 * Synchronous on purpose: a caller that only inspects state (a test asserting
 * "not wired") must not have to await anything. A ROUTE wants
 * {@link apiV1DepsWith}, not this.
 */
export function apiV1Deps(): ApiV1Deps | null {
  return registered;
}

/**
 * The dependencies for a request, building the composition on first use.
 *
 * `buildApiV1Deps()` opens a database connection, so it is async; a Next.js
 * `instrumentation.ts` boot hook is a SEPARATE module graph from the route
 * handler's, so a value registered there is not the value this module reads
 * (verified by running the app, not assumed: the registry stayed empty and every
 * route answered 500). Building here — inside the module the route actually
 * reads — is what makes the wiring real. The cost is that the first request pays
 * for the connection, which is why the promise is shared process-wide.
 *
 * A FAILED build is deliberately not cached: `createDb` is fail-fast by design,
 * so the failure is usually a database that was not up yet, and caching it
 * would turn one boot race into a permanent 500 for the life of the process.
 * The next request tries again and the error reaches the route, which logs it
 * with its real cause.
 *
 * @param build the composition builder, called at most once per process
 * @returns the dependencies, or the builder's rejection
 * @throws whatever `build` throws, after `build` has been attempted
 */
export async function apiV1DepsWith(build: () => Promise<ApiV1Deps>): Promise<ApiV1Deps | null> {
  if (registered !== null) return registered;
  bootstrapped ??= build().then(
    (deps) => {
      registered = deps;
      return deps;
    },
    (cause: unknown) => {
      // Not memoised: see above. A dropped handle is what lets the retry run.
      bootstrapped = null;
      throw cause;
    },
  );
  return bootstrapped;
}
