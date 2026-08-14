/**
 * Drizzle schema — the executable mirror of the data model: every table, foreign
 * key, CHECK constraint, uniqueness rule and index appears under the same name.
 * The table inventory is exported as {@link SCHEMA_TABLES}.
 * All values are bind parameters; `sql.unsafe`/`sql.raw`/concatenated SQL are banned.
 * Uniqueness is a named unique index, so a name is identical in the model and in
 * `pg_indexes`. Grants are not created here: the app role holds DML only and the maintenance role runs DDL.
 */
import { sql } from 'drizzle-orm';
import { isPgliteDsn } from './dialect';
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  citextColumn,
  createdAt,
  deletedAt,
  exactNumeric,
  timestamptz,
  updatedAt,
  uuidReference,
  uuidV7PrimaryKey,
} from './columns';

/**
 * Account for readers and admins.
 *
 * email is `citext` so uniqueness and comparison are case-insensitive
 * (login lookup by email must not depend on how the reader typed it).
 * role/status are text + CHECK, not enums, so adding one is a migration, not an
 * enum alteration.
 */
export const users = pgTable(
  'users',
  {
    id: uuidV7PrimaryKey(),
    email: citextColumn('email').notNull(),
    displayName: text('display_name').notNull().default(''),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('reader'),
    status: text('status').notNull().default('active'),
    lastLoginAt: timestamptz('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // login lookup by email; admin listing by role; status sweeps.
    uniqueIndex('ix_users_email').on(t.email),
    index('ix_users_role').on(t.role),
    index('ix_users_status').on(t.status),
    check('users_role', sql`${t.role} in ('reader', 'admin')`),
    check('users_status', sql`${t.status} in ('active', 'disabled')`),
  ],
);

/**
 * Server-side session. `session_token` is the value the cookie carries;
 * `ix_sessions_expires_at` serves the expiry sweep.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuidV7PrimaryKey(),
    userId: uuidReference('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionToken: text('session_token').notNull(),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: createdAt(),
    expiresAt: timestamptz('expires_at').notNull(),
    absoluteExpiresAt: timestamptz('absolute_expires_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at'),
  },
  (t) => [
    uniqueIndex('ix_sessions_token').on(t.sessionToken),
    index('ix_sessions_user_id').on(t.userId),
    index('ix_sessions_expires_at').on(t.expiresAt),
  ],
);

/**
 * A title in the collection.
 *
 * `published` + `deleted_at` are the two visibility axes; `ix_manga_visible` is
 * the catalog hot path and the trigram index serves prefix+contains search.
 */
export const manga = pgTable(
  'manga',
  {
    id: uuidV7PrimaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    synopsis: text('synopsis').notNull().default(''),
    status: text('status').notNull().default('ongoing'),
    readingDirection: text('reading_direction').notNull().default('rtl'),
    published: boolean('published').notNull().default(false),
    // Asset KEY, never a path or public URL.
    coverAssetKey: text('cover_asset_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => {
    // pg_trgm: title search covers prefix AND contains with one mechanism. The PGlite
    // fallback has no `pg_trgm`, so it gets a plain btree. One helper decides the dialect
    // for the driver, the migrator and these indexes alike.
    const titleTrgm = isPgliteDsn(process.env['DATABASE_URL'])
      ? index('ix_manga_title_trgm').on(t.title)
      : index('ix_manga_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`);

    return [
      // URL identity; slugs are immutable after publish.
      uniqueIndex('ix_manga_slug').on(t.slug),
      index('ix_manga_title').on(t.title),
      index('ix_manga_updated_at').on(t.updatedAt),
      index('ix_manga_created_at').on(t.createdAt),
      index('ix_manga_visible')
        .on(t.updatedAt)
        .where(sql`${t.deletedAt} is null and ${t.published} = true`),
      titleTrgm,
      check('manga_status', sql`${t.status} in ('ongoing', 'completed', 'hiatus')`),
      check('manga_reading_direction', sql`${t.readingDirection} in ('rtl', 'ltr')`),
    ];
  },
);

/** Alternate titles for search. */
export const mangaAlias = pgTable(
  'manga_alias',
  {
    id: uuidV7PrimaryKey(),
    mangaId: uuidReference('manga_id')
      .notNull()
      .references(() => manga.id, { onDelete: 'cascade' }),
    alias: text('alias').notNull(),
    createdAt: createdAt(),
  },
  (t) => {
    // The alias half of title+alias search. PGlite fallback → btree, same reason as the
    // title index above.
    const aliasTrgm = isPgliteDsn(process.env['DATABASE_URL'])
      ? index('ix_manga_alias_alias').on(t.alias)
      : index('ix_manga_alias_alias').using('gin', sql`${t.alias} gin_trgm_ops`);

    return [uniqueIndex('ix_manga_alias_manga_id_alias').on(t.mangaId, t.alias), aliasTrgm];
  },
);

/** Author/artist entity. Deletion is guarded. */
export const creator = pgTable(
  'creator',
  {
    id: uuidV7PrimaryKey(),
    name: text('name').notNull(),
    roleDefault: text('role_default').notNull().default('author'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ix_creators_name').on(t.name),
    check('creator_role_default', sql`${t.roleDefault} in ('author', 'artist', 'other')`),
  ],
);

/** Controlled vocabulary for catalog filtering. */
export const genre = pgTable(
  'genre',
  {
    id: uuidV7PrimaryKey(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ix_genres_name').on(t.name)],
);

/**
 * Freeform tags for search.
 *
 * "(lower-cased)" is implemented as a unique index over `lower(name)`, so
 * "Action" and "action" cannot both exist regardless of stored case.
 */
export const tag = pgTable(
  'tag',
  {
    id: uuidV7PrimaryKey(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ix_tags_name').on(sql`lower(${t.name})`)],
);

/** M:N manga↔creator with the per-link role. */
export const mangaCreator = pgTable(
  'manga_creator',
  {
    mangaId: uuidReference('manga_id')
      .notNull()
      .references(() => manga.id, { onDelete: 'cascade' }),
    creatorId: uuidReference('creator_id')
      .notNull()
      .references(() => creator.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.mangaId, t.creatorId] }),
    // reverse lookup: "manga of creator" (author page)
    index('ix_manga_creator_creator_id').on(t.creatorId),
    check('manga_creator_role', sql`${t.role} in ('author', 'artist', 'other')`),
  ],
);

/** M:N manga↔genre; reverse index is the catalog filter path. */
export const mangaGenre = pgTable(
  'manga_genre',
  {
    mangaId: uuidReference('manga_id')
      .notNull()
      .references(() => manga.id, { onDelete: 'cascade' }),
    genreId: uuidReference('genre_id')
      .notNull()
      .references(() => genre.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.mangaId, t.genreId] }),
    index('ix_manga_genre_genre_id').on(t.genreId),
  ],
);

/** M:N manga↔tag. */
export const mangaTag = pgTable(
  'manga_tag',
  {
    mangaId: uuidReference('manga_id')
      .notNull()
      .references(() => manga.id, { onDelete: 'cascade' }),
    tagId: uuidReference('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.mangaId, t.tagId] }), index('ix_manga_tag_tag_id').on(t.tagId)],
);

/**
 * A unit of reading content.
 *
 * - `number numeric(8,2)` so special chapters ("10.5") are representable; it is
 *   read back as a string, never a float.
 * - `reading_order` is the explicit sort tiebreaker and `ix_chapters_manga_order`
 *   is the chapter-list hot path.
 * - `page_count` is denormalized for the chapter list; the upload commit is the
 *   only writer.
 */
export const chapter = pgTable(
  'chapter',
  {
    id: uuidV7PrimaryKey(),
    mangaId: uuidReference('manga_id')
      .notNull()
      .references(() => manga.id, { onDelete: 'cascade' }),
    number: exactNumeric('number', 8, 2).notNull(),
    title: text('title'),
    notes: text('notes').notNull().default(''),
    status: text('status').notNull().default('draft'),
    publishedAt: timestamptz('published_at'),
    pageCount: integer('page_count').notNull().default(0),
    readingOrder: integer('reading_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    // No duplicate numbers per manga.
    uniqueIndex('ix_chapters_number').on(t.mangaId, t.number),
    uniqueIndex('ix_chapters_manga_order').on(t.mangaId, t.readingOrder),
    index('ix_chapters_visible')
      .on(t.readingOrder)
      .where(sql`${t.deletedAt} is null and ${t.status} = 'published'`),
    check('chapter_status', sql`${t.status} in ('draft', 'published')`),
  ],
);

/**
 * One page of a chapter — the reader's atom.
 *
 * No surrogate `id`: the composite PK is the real key. `asset_key` is
 * unguessable and is a KEY, never the physical path.
 * `byte_size_*` columns record the encoded byte sizes.
 */
export const chapterPage = pgTable(
  'chapter_page',
  {
    chapterId: uuidReference('chapter_id')
      .notNull()
      .references(() => chapter.id, { onDelete: 'cascade' }),
    // 1-based.
    pageNumber: integer('page_number').notNull(),
    assetKey: text('asset_key').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    byteSizeAvif: bigint('byte_size_avif', { mode: 'number' }),
    byteSizeWebp: bigint('byte_size_webp', { mode: 'number' }),
    byteSizeJpeg: bigint('byte_size_jpeg', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.chapterId, t.pageNumber] }),
    // media delivery lookup (unique asset key).
    uniqueIndex('ix_pages_asset_key').on(t.assetKey),
    check('chapter_page_page_number', sql`${t.pageNumber} >= 1`),
  ],
);

/** "In my library" membership. */
export const libraryEntry = pgTable(
  'library_entry',
  {
    userId: uuidReference('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mangaId: uuidReference('manga_id')
      .notNull()
      .references(() => manga.id, { onDelete: 'cascade' }),
    addedAt: timestamptz('added_at').notNull().defaultNow(),
    // Denormalized for the continue-reading sort.
    lastReadAt: timestamptz('last_read_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.mangaId] }),
    index('ix_library_user_lastread').on(t.userId, t.lastReadAt),
  ],
);

/**
 * Latest position per user per chapter.
 *
 * Upsert-only and idempotent: an update applies only when the SERVER-stamped
 * `updated_at` is newer (LWW), and `completed` is sticky — both are service
 * rules, the row is the contract.
 */
export const readingProgress = pgTable(
  'reading_progress',
  {
    userId: uuidReference('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chapterId: uuidReference('chapter_id')
      .notNull()
      .references(() => chapter.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    // Vertical-mode offset within the page, 0..1.
    scrollPosition: doublePrecision('scroll_position').notNull().default(0),
    completed: boolean('completed').notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.chapterId] }),
    index('ix_progress_user_updated').on(t.userId, t.updatedAt),
    check('reading_progress_page_number', sql`${t.pageNumber} >= 1`),
  ],
);

/**
 * Append-only-ish read log.
 *
 * The chapter FK is SET NULL so the read count survives a chapter purge and
 * the UI can render "unavailable chapter".
 */
export const readingHistory = pgTable(
  'reading_history',
  {
    id: uuidV7PrimaryKey(),
    userId: uuidReference('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chapterId: uuidReference('chapter_id').references(() => chapter.id, {
      onDelete: 'set null',
    }),
    pageNumber: integer('page_number').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    endedAt: timestamptz('ended_at'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
  },
  (t) => [index('ix_history_user_time').on(t.userId, t.startedAt)],
);

/** Saved position. `page_number NULL` = chapter start. */
export const bookmark = pgTable(
  'bookmark',
  {
    id: uuidV7PrimaryKey(),
    userId: uuidReference('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chapterId: uuidReference('chapter_id').references(() => chapter.id, {
      onDelete: 'set null',
    }),
    pageNumber: integer('page_number'),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    // one bookmark per page (NULLs stay distinct: many "chapter start" marks)
    uniqueIndex('ix_bookmarks_user_chapter_page').on(t.userId, t.chapterId, t.pageNumber),
    index('ix_bookmarks_user').on(t.userId, t.createdAt),
    check('bookmark_note_len', sql`char_length(${t.note}) <= 280`),
  ],
);

/**
 * Per-user reader defaults. 0..1 per user, so the PK is the user FK. The five
 * preference columns are NOT NULL with defaults: a preference row is 0..1 per
 * user, so "the row exists" already means "these answers exist".
 */
export const readerPreference = pgTable(
  'reader_preference',
  {
    userId: uuidReference('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    defaultMode: text('default_mode').notNull().default('vertical'),
    directionOverride: text('direction_override').notNull().default('none'),
    zoomDefault: exactNumeric('zoom_default', 4, 2).notNull().default('1.00'),
    autoNextChapter: boolean('auto_next_chapter').notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId] }),
    check(
      'reader_preference_default_mode',
      sql`${t.defaultMode} in ('vertical', 'single', 'double')`,
    ),
    check(
      'reader_preference_direction_override',
      sql`${t.directionOverride} in ('none', 'rtl', 'ltr')`,
    ),
  ],
);

/**
 * One ingestion attempt.
 *
 * manga/chapter/created_by are SET NULL so the audit trail of a failed job
 * survives the deletion of what it was ingesting; `state` is the job state
 * machine, with the only queue index (`ix_uploads_state`).
 */
export const uploadJob = pgTable(
  'upload_job',
  {
    id: uuidV7PrimaryKey(),
    mangaId: uuidReference('manga_id').references(() => manga.id, { onDelete: 'set null' }),
    chapterId: uuidReference('chapter_id').references(() => chapter.id, {
      onDelete: 'set null',
    }),
    createdBy: uuidReference('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    state: text('state').notNull().default('queued'),
    inputKind: text('input_kind'),
    // Temp storage prefix, purged 24 h after the job ends.
    stagingKey: text('staging_key'),
    sourceName: text('source_name').notNull(),
    fileCount: integer('file_count'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamptz('started_at'),
    finishedAt: timestamptz('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_uploads_state').on(t.state, t.createdAt),
    index('ix_uploads_chapter').on(t.chapterId, t.createdAt),
    check(
      'upload_job_state',
      sql`${t.state} in ('queued', 'validating', 'processing', 'ready', 'failed')`,
    ),
    check('upload_job_input_kind', sql`${t.inputKind} in ('zip', 'images')`),
  ],
);

/**
 * Single-use password reset.
 * Only the SHA-256 `token_hash` is stored, never the raw token.
 */
export const resetToken = pgTable(
  'reset_token',
  {
    id: uuidV7PrimaryKey(),
    userId: uuidReference('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ix_resettokens_hash').on(t.tokenHash),
    index('ix_resettokens_user').on(t.userId),
  ],
);

/**
 * Immutable admin-action log.
 *
 * `id` is the one bigserial PK (append-only, monotonically sortable); everything
 * else is text + JSONB. There is deliberately no UPDATE/DELETE path in
 * application code and none in SQL — immutability is enforced by the DB role,
 * not by this table. A deleted user leaves `actor_id NULL` and keeps
 * `actor_email` as provenance.
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuidReference('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email'),
    action: text('action').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    // Summarized snapshots — no secrets, email is the only PII.
    before: jsonb('before'),
    after: jsonb('after'),
    ip: inet('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_audit_target').on(t.targetKind, t.targetId, t.createdAt),
    index('ix_audit_actor').on(t.actorId, t.createdAt),
    index('ix_audit_created').on(t.createdAt),
  ],
);

/**
 * The table inventory, for callers that need the list without introspecting
 * the module namespace.
 */
export const SCHEMA_TABLES = [
  'users',
  'sessions',
  'manga',
  'manga_alias',
  'creator',
  'genre',
  'tag',
  'manga_creator',
  'manga_genre',
  'manga_tag',
  'chapter',
  'chapter_page',
  'library_entry',
  'reading_progress',
  'reading_history',
  'bookmark',
  'reader_preference',
  'upload_job',
  'reset_token',
  'audit_event',
] as const;

/** One name of {@link SCHEMA_TABLES}. */
export type SchemaTableName = (typeof SCHEMA_TABLES)[number];
