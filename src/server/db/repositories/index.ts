/**
 * server/db/repositories — port implementations (the ONLY SQL in the app).
 * Each file implements exactly one feature port (server MAY import a feature's
 * port definition, never its logic); two repositories carry two ports each,
 * which the one-port-per-file rule permits only where the ports are the same
 * table family. Ports with no file yet live in {@link PLANNED_REPOSITORIES},
 * not in this comment: a constant can be checked, a comment cannot.
 */
import type { ChapterRepository } from '../../../features/chapters';
import type { MangaRepository } from '../../../features/manga';
import type { Db } from '../client';
import { createChapterRepository } from './chapter.repository';
import { createMangaRepository } from './manga.repository';

/** The repository bundle the composition root injects into features. */
export interface Repositories {
  /** `MangaRepository`. */
  readonly manga: MangaRepository;
  /** `ChapterRepository`. */
  readonly chapters: ChapterRepository;
}

/**
 * Wires the landed repositories over one Drizzle handle.
 *
 * `createDb(env)` is the only thing that opens a connection, so the composition
 * root builds the handle once and hands it here. Nothing in this file queries
 * the database by itself.
 *
 * @param db the application's database handle (`createDb`)
 */
export function createRepositories(db: Db): Repositories {
  return {
    manga: createMangaRepository(db),
    chapters: createChapterRepository(db),
  };
}

export {
  createMangaRepository,
  buildCatalogListQuery,
  mangaVisibleWhere,
  genreSlugSql,
} from './manga.repository';
export {
  createChapterRepository,
  buildChapterListQuery,
  buildChapterPagesQuery,
} from './chapter.repository';

/**
 * The ports still to be implemented. It is "ports without a file", not "ports":
 * `library.repository.ts` implements `BookmarkRepository` beside
 * `LibraryRepository`, and `session.repository.ts` implements a minimum of
 * `SessionRepository` rather than the port's six methods.
 */
export const PLANNED_REPOSITORIES = ['user', 'upload-job'] as const;
