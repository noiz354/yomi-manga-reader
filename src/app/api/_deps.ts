/**
 * The unversioned `/api` dependency seam — the members' surface.
 *
 * A second seam rather than moving these routes under `/api/v1`: the implemented
 * handlers are un-versioned and already published, so moving them would break
 * published URLs. The composition BUILDER is passed in by the caller of
 * {@link apiDepsWith}, never imported here — a seam that imports the database it
 * exists to hide is not a seam. The acting user is ALWAYS whatever the resolver
 * returns from the verified session, never the query string or the body.
 */
import type { CallerContext } from '../../shared/contracts';
import type { LibraryService } from '../../features/library';
import type { HistoryRepository, ReaderProgressRepository } from '../../features/progress';
import type { Logger } from '../../server/telemetry/logger';
import type { MangaRepository } from '../../features/manga';
import type { ChapterRepository } from '../../features/chapters';
import type { PreferenceService } from '../../features/reader-preferences';

/** Everything an `/api` members' route handler is allowed to reach for. */
export interface ApiDeps {
  /** Library, bookmarks, read status (features/library's public surface). */
  readonly library: LibraryService;
  /** Reading history sessions and the list (features/progress's public surface). */
  readonly history: HistoryRepository;
  /**
   * The single writer of `reading_progress` and `library_entry.last_read_at`.
   *
   * On this seam so no route writes those tables directly: a direct write
   * plain-overwrites `completed`, and the reader client sends only
   * `{ pageNumber }`.
   */
  readonly readerProgress: ReaderProgressRepository;
  /**
   * Catalog READ ports, so a route can answer "does this title/chapter exist?"
   * with the contract's 404 rather than letting a foreign-key violation surface as
   * a bare 500. Read-only on this seam: writes belong to the services above.
   */
  readonly manga: MangaRepository;
  readonly chapters: ChapterRepository;
  /**
   * Reader preferences (features/reader-preferences's public surface).
   *
   * On the members' seam because it is self-scoped: it touches the caller's
   * OWN row and nothing else, and it is never admin-gated — so it is safe to
   * ship while the route guard is deferred. A reader's preferences are not
   * anyone else's business, and there is no admin view of them by design.
   */
  readonly preferences: PreferenceService;
  /**
   * Resolves the CALLER from the verified session cookie, or null for anonymous.
   *
   * Every service method turns null into `AUTH_REQUIRED` (401) on its own, so a
   * route can pass the context straight through rather than pre-checking.
   */
  readonly resolveCaller: (request: Request) => Promise<CallerContext>;
  /** The logging facade. Never `console` directly. */
  readonly logger: Logger;
}

let registered: ApiDeps | null = null;

/** The lazy composition's in-flight or settled result; `null` until first use. */
let bootstrapped: Promise<ApiDeps> | null = null;

/**
 * Registers the wired dependencies.
 *
 * A test seam AND the fast path: when something has registered deps, no
 * composition is built. A registered bundle always wins over building one.
 *
 * @param deps the services, the caller resolver and the logger
 */
export function registerApiDeps(deps: ApiDeps): void {
  registered = deps;
}

/**
 * The registered dependencies, or `null` when nothing has been registered yet.
 *
 * Synchronous on purpose: a caller that only inspects state (a test asserting
 * "not wired") must not have to await anything.
 */
export function apiDeps(): ApiDeps | null {
  return registered;
}

/**
 * The dependencies for a request, building the composition on first use.
 *
 * A FAILED build is deliberately not cached: `createDb` is fail-fast by design, so
 * the failure is usually a database that was not up yet, and caching it would turn
 * one boot race into a permanent 500 for the life of the process.
 *
 * @param build the composition builder, called at most once per process
 * @returns the dependencies, or the builder's rejection
 * @throws whatever `build` throws, after `build` has been attempted
 */
export async function apiDepsWith(build: () => Promise<ApiDeps>): Promise<ApiDeps | null> {
  if (registered !== null) return registered;
  bootstrapped ??= build().then(
    (deps) => {
      registered = deps;
      return deps;
    },
    (cause: unknown) => {
      bootstrapped = null;
      throw cause;
    },
  );
  return bootstrapped;
}
