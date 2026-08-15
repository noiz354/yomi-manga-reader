/**
 * server/db — database access (Drizzle + `postgres` driver).
 *
 * This file is the module's public surface; everything else (`client.ts`,
 * `columns.ts`, `schema.ts`, `migrations.ts`, `repositories/`) stays behind it.
 * Only this module may import drizzle-orm / the driver, Drizzle row types never
 * leak across the boundary, and DDL never runs through this module's pool.
 */

export { DB_POOL_MAX, closeDb, createDb, DatabaseConfigurationError } from './client';
export type { Db, PostgresClientOptions } from './client';
export {
  MIGRATION_JOURNAL_SCHEMA,
  MIGRATION_JOURNAL_TABLE,
  MIGRATION_LOCK_ID,
  migrateOnBoot,
  runMigrations,
} from './migrations';
export type { AppliedMigration, MigrationOptions, MigrationResult } from './migrations';
export {
  SCHEMA_TABLES,
  auditEvent,
  bookmark,
  chapter,
  chapterPage,
  creator,
  genre,
  libraryEntry,
  manga,
  mangaAlias,
  mangaCreator,
  mangaGenre,
  mangaTag,
  readerPreference,
  readingHistory,
  readingProgress,
  resetToken,
  sessions,
  tag,
  uploadJob,
  users,
} from './schema';
export type { SchemaTableName } from './schema';
