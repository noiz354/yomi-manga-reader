/**
 * The composition root — the ONLY place all layers meet. env → infrastructure
 * (db, storage, media, telemetry, session store) → ports → services. Route
 * handlers and RSC pages consume these services and never construct
 * infrastructure. Adding a port without registering it here is a broken
 * skeleton (typecheck enforces via the service constructors); `loadEnv()` is
 * called exactly once per process, here; only singletons live here.
 */
import { createCatalogService, type CatalogService } from '../features/catalog';
import { createLibraryService, type LibraryService } from '../features/library';
import { createSearchService, type SearchService } from '../features/search/search.service';
import {
  createResumeService,
  type HistoryRepository,
  type ReaderProgressRepository,
} from '../features/progress';
import { loadEnv } from '../shared/validation';
import type { Env, EnvSource } from '../shared/validation';
import { acquireDb, releaseDb, type Db } from './db/client';
import {
  createProgressPositionReader,
  createReaderProgressRepository,
} from './db/repositories/progress.repository';
import { createGenreTagVocabularyPort } from './db/repositories/vocabulary.repository';
import { createSearchRepository } from './db/repositories/search.repository';
import { createHistoryRepository } from './db/repositories/history.repository';
import {
  createBookmarkRepository,
  createLibraryRepository,
} from './db/repositories/library.repository';
import { createReaderPreferenceRepository } from './db/repositories/preference.repository';
import { createPreferenceService, type PreferenceService } from '../features/reader-preferences';
import { createRepositories } from './db/repositories';
import type { ChapterRepository } from '../features/chapters';
import type { MangaRepository } from '../features/manga';
import { createLogger, type Logger } from './telemetry/logger';

/** What the boot plan holds before any connection is opened. */
export interface Composition {
  /** The validated, redacted environment. */
  readonly env: Env;
  /** The process logger. */
  readonly logger: Logger;
}

/**
 * The catalog half of the composition: the one service that has landed, plus
 * the handle needed to drain its pool on shutdown.
 */
export interface CatalogComposition {
  /** The catalog service. */
  readonly catalog: CatalogService;
  /**
   * The chapter read port, for the chapter-pages route.
   *
   * `pageList` also carries the prev/next published neighbours, so routing
   * through it hands the reader chapter navigation for free.
   */
  readonly chapters: ChapterRepository;
  /**
   * The search service.
   *
   * It lives in the CATALOG composition because that is the public-data root:
   * search reads published titles, aliases, creators and tags — the same rows the
   * catalog reads, through the same pool, with no session anywhere near it. The
   * `/api/search` route takes it from the `/api/v1` seam for exactly that reason
   * (see that route's header for why it shares the seam rather than growing a
   * third registry).
   */
  readonly search: SearchService;
  /** The process logger, so a route reports through the real one. */
  readonly logger: Logger;
  /** Drains the database pool. */
  close(): Promise<void>;
}

/**
 * Boot step 1: validate the environment and hand back the plan.
 *
 * Synchronous and side-effect-free apart from the log level, because the point
 * of the split is that a bad deploy fails HERE — before a connection is opened
 * and before a request exists — with a redacted message. `createDb` then fails
 * fast on an unreachable database, so neither failure can present itself as a
 * reader's 500.
 *
 * @param source the environment source; the real process env when omitted
 * @returns the validated boot plan
 * @throws {ConfigurationError} when the environment is incomplete or malformed
 */
export function buildComposition(source?: EnvSource): Composition {
  const env: Env = loadEnv(source);
  return { env, logger: createLogger(env) };
}

/**
 * Boot step 2 for the catalog: open the database and wire the landed ports.
 *
 * Memoised per process by the caller (`apiV1DepsWith`), not here, so this stays
 * a plain async factory that a test can call directly.
 *
 * Nothing is faked here: every port the catalog service takes is registered
 * from a real implementation. When one is missing, `facets()` and
 * `resolveResume()` report the gap instead of inventing an answer — which is why
 * this list is short only while the landed repositories are short.
 *
 * @param source the environment source; the real process env when omitted
 * @returns the wired catalog service and the pool handle
 * @throws {DatabaseConfigurationError} when the DSN is unusable or unreachable
 */
export async function createCatalogComposition(source?: EnvSource): Promise<CatalogComposition> {
  const { env, logger } = buildComposition(source);
  const db: Db = await acquireDb(env);
  const { manga, chapters } = createRepositories(db);
  return {
    catalog: createCatalogService({
      manga,
      chapters,
      // The resume RULES live in the feature and the Drizzle READ here, and
      // `ResumeService` extends `ProgressReader`, so this is the injection its
      // own header asked the composition root for.
      progress: createResumeService({ reads: createProgressPositionReader(db) }),
      // The facets read, so `/discover`'s genre filter has a vocabulary.
      vocabulary: createGenreTagVocabularyPort(db),
    }),
    chapters,
    // The public search service, on the public-data composition.
    search: createSearchService({ search: createSearchRepository(db) }),
    logger,
    close: () => releaseDb(db),
  };
}

/**
 * The members' half of the composition: the library, its bookmarks, and reading
 * history — the personal surface behind `/library`, `/bookmarks` and `/history`.
 *
 * Separate from {@link createCatalogComposition} rather than folded into it because
 * the two answer to different visibility rules: the catalog is public, these three
 * are session-scoped surfaces. A single bundle would make "which service can an
 * anonymous request reach?" a question about a shared object rather than about a
 * named one.
 *
 * @param source the raw environment; defaults to `process.env`
 * @returns the library service, the history repository, and the pool drain
 *
 * @throws {DatabaseConfigurationError} when the DSN is unusable or unreachable
 */
export async function createLibraryComposition(source?: EnvSource): Promise<LibraryComposition> {
  const { env, logger } = buildComposition(source);
  const db: Db = await acquireDb(env);
  const { manga, chapters } = createRepositories(db);
  // Built once and shared with the returned bundle below, so the library service
  // and the progress route cannot disagree about who owns `reading_progress`.
  // Two instances would still be correct — the invariants live in the SQL, not in
  // the object — but "one writer" ought to be one object as well.
  const readerProgress = createReaderProgressRepository(db);
  return {
    library: createLibraryService({
      library: createLibraryRepository(db),
      bookmarks: createBookmarkRepository(db),
      // The same resume reader the catalog injects: one implementation, two
      // consumers, so "continue reading" cannot disagree with the library badge.
      progress: createResumeService({ reads: createProgressPositionReader(db) }),
      chapters,
      // The only dependency that spans two ports — `setReadStatus` writes through
      // the progress repository, which is also the single writer of
      // `library_entry.last_read_at`. The SAME instance is returned below for the
      // progress route, so the library and the reader can never disagree about
      // who owns `reading_progress`.
      readerProgress,
    }),
    history: createHistoryRepository(db),
    // Exposed so the progress route stops writing `reading_progress` itself:
    // this is the one implementation that gets LWW, idempotence, sticky-OR, the
    // denormalized touch and the transaction right.
    readerProgress: createReaderProgressRepository(db),
    // Exposed so a route can answer "is this title/chapter there?" with a 404
    // instead of letting the foreign key speak.
    manga,
    chapters,
    preferences: createPreferenceService({ preferences: createReaderPreferenceRepository(db) }),
    logger,
    close: () => releaseDb(db),
  };
}

/** The members' services plus the shutdown seam. */
export interface LibraryComposition {
  /** Library, bookmarks and read status. */
  readonly library: LibraryService;
  /** Reading history sessions and the history list. */
  readonly history: HistoryRepository;
  /** The single writer of `reading_progress` and `library_entry.last_read_at`. */
  readonly readerProgress: ReaderProgressRepository;
  /**
   * The catalog read ports, for existence checks a route must answer itself:
   * an unknown manga is 404 `MANGA_NOT_FOUND`, a page past the chapter's end is
   * 422 `READER_INVALID_PAGE`. Read-only here; writes still belong to services.
   */
  readonly manga: MangaRepository;
  readonly chapters: ChapterRepository;
  /** Reader preferences, self-scoped to the caller. */
  readonly preferences: PreferenceService;
  /** The process logger, so a route reports through the real one. */
  readonly logger: Logger;
  /** Drains the database pool. */
  close(): Promise<void>;
}
