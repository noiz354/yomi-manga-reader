-- Initial migration.
--
-- Hand-maintained preamble; everything below the generated marker comes from
-- `npx drizzle-kit generate` against src/server/db/schema.ts and must be kept
-- when a future revision is generated (drizzle appends, it never rewrites).
-- Statements must stay additive (expand): no DROP/RENAME/narrowed type until
-- the previous app image is retired. No data backfill larger than a single
-- transaction. Concurrent boots serialise on an advisory lock in the runner
-- (src/server/db/migrations.ts); this file does not lock itself.

-- Refuse to run where uuidv7() does not exist. Every uuid primary key is
-- `DEFAULT uuidv7()`, and uuidv7() is a PostgreSQL 18 built-in. The 17
-- fallback would need a different id generator, so a wrong server must fail
-- loudly here instead of silently producing v4 ids.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 180000 THEN
    RAISE EXCEPTION 'Yomi requires PostgreSQL 18 for uuidv7() (ADR-002); this server is %', current_setting('server_version');
  END IF;
END
$$;
--> statement-breakpoint
-- citext: `email citext NOT NULL`. The type must exist before the table that
-- declares the column, so this is not something the generated DDL can carry.
-- `IF NOT EXISTS` keeps a re-run a no-op.
-- PGlite: citext extension managed by column type (text fallback)
-- CREATE EXTENSION IF NOT EXISTS "citext";
--> statement-breakpoint
-- pg_trgm: trigram GIN indexes on manga.title and manga_alias.alias. The
-- operator choice (gin_trgm_ops, similarity threshold) is verified with
-- EXPLAIN; the index itself belongs to this first migration.
-- PGlite: pg_trgm extension not available, GIN indexes use btree fallback
-- CREATE EXTENSION IF NOT EXISTS "pg_trgm";
--> statement-breakpoint
-- NOT created here, on purpose: role privileges. The app role is DML-only and
-- must not hold UPDATE/DELETE on audit_event; migrations run as a separate
-- maintenance DSN. The GRANT/REVOKE statements are added in a later revision,
-- once the roles exist.
--
-- generated below this line by drizzle-kit — do not hand-edit
CREATE TABLE "audit_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookmark" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"chapter_id" uuid,
	"page_number" integer,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmark_note_len" CHECK (char_length("bookmark"."note") <= 280)
);
--> statement-breakpoint
CREATE TABLE "chapter" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"manga_id" uuid NOT NULL,
	"number" numeric(8, 2) NOT NULL,
	"title" text,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"page_count" integer DEFAULT 0 NOT NULL,
	"reading_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chapter_status" CHECK ("chapter"."status" in ('draft', 'published'))
);
--> statement-breakpoint
CREATE TABLE "chapter_page" (
	"chapter_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"asset_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"byte_size_avif" bigint,
	"byte_size_webp" bigint,
	"byte_size_jpeg" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chapter_page_chapter_id_page_number_pk" PRIMARY KEY("chapter_id","page_number"),
	CONSTRAINT "chapter_page_page_number" CHECK ("chapter_page"."page_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "creator" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"role_default" text DEFAULT 'author' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_role_default" CHECK ("creator"."role_default" in ('author', 'artist', 'other'))
);
--> statement-breakpoint
CREATE TABLE "genre" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_entry" (
	"user_id" uuid NOT NULL,
	"manga_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone,
	CONSTRAINT "library_entry_user_id_manga_id_pk" PRIMARY KEY("user_id","manga_id")
);
--> statement-breakpoint
CREATE TABLE "manga" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"synopsis" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'ongoing' NOT NULL,
	"reading_direction" text DEFAULT 'rtl' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"cover_asset_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "manga_status" CHECK ("manga"."status" in ('ongoing', 'completed', 'hiatus')),
	CONSTRAINT "manga_reading_direction" CHECK ("manga"."reading_direction" in ('rtl', 'ltr'))
);
--> statement-breakpoint
CREATE TABLE "manga_alias" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"manga_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manga_creator" (
	"manga_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manga_creator_manga_id_creator_id_pk" PRIMARY KEY("manga_id","creator_id"),
	CONSTRAINT "manga_creator_role" CHECK ("manga_creator"."role" in ('author', 'artist', 'other'))
);
--> statement-breakpoint
CREATE TABLE "manga_genre" (
	"manga_id" uuid NOT NULL,
	"genre_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manga_genre_manga_id_genre_id_pk" PRIMARY KEY("manga_id","genre_id")
);
--> statement-breakpoint
CREATE TABLE "manga_tag" (
	"manga_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manga_tag_manga_id_tag_id_pk" PRIMARY KEY("manga_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "reader_preference" (
	"user_id" uuid NOT NULL,
	"default_mode" text DEFAULT 'vertical' NOT NULL,
	"direction_override" text DEFAULT 'none' NOT NULL,
	"zoom_default" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"auto_next_chapter" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_preference_user_id_pk" PRIMARY KEY("user_id"),
	CONSTRAINT "reader_preference_default_mode" CHECK ("reader_preference"."default_mode" in ('vertical', 'single', 'double')),
	CONSTRAINT "reader_preference_direction_override" CHECK ("reader_preference"."direction_override" in ('none', 'rtl', 'ltr'))
);
--> statement-breakpoint
CREATE TABLE "reading_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"chapter_id" uuid,
	"page_number" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reading_progress" (
	"user_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"scroll_position" double precision DEFAULT 0 NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_progress_user_id_chapter_id_pk" PRIMARY KEY("user_id","chapter_id"),
	CONSTRAINT "reading_progress_page_number" CHECK ("reading_progress"."page_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "reset_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_token" text NOT NULL,
	"user_agent" text,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_job" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"manga_id" uuid,
	"chapter_id" uuid,
	"created_by" uuid,
	"state" text DEFAULT 'queued' NOT NULL,
	"input_kind" text,
	"staging_key" text,
	"source_name" text NOT NULL,
	"file_count" integer,
	"byte_size" bigint,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_job_state" CHECK ("upload_job"."state" in ('queued', 'validating', 'processing', 'ready', 'failed')),
	CONSTRAINT "upload_job_input_kind" CHECK ("upload_job"."input_kind" in ('zip', 'images'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'reader' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role" CHECK ("users"."role" in ('reader', 'admin')),
	CONSTRAINT "users_status" CHECK ("users"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark" ADD CONSTRAINT "bookmark_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmark" ADD CONSTRAINT "bookmark_chapter_id_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter" ADD CONSTRAINT "chapter_manga_id_manga_id_fk" FOREIGN KEY ("manga_id") REFERENCES "public"."manga"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chapter_page" ADD CONSTRAINT "chapter_page_chapter_id_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entry" ADD CONSTRAINT "library_entry_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entry" ADD CONSTRAINT "library_entry_manga_id_manga_id_fk" FOREIGN KEY ("manga_id") REFERENCES "public"."manga"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manga_alias" ADD CONSTRAINT "manga_alias_manga_id_manga_id_fk" FOREIGN KEY ("manga_id") REFERENCES "public"."manga"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manga_creator" ADD CONSTRAINT "manga_creator_manga_id_manga_id_fk" FOREIGN KEY ("manga_id") REFERENCES "public"."manga"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manga_creator" ADD CONSTRAINT "manga_creator_creator_id_creator_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creator"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manga_genre" ADD CONSTRAINT "manga_genre_manga_id_manga_id_fk" FOREIGN KEY ("manga_id") REFERENCES "public"."manga"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manga_genre" ADD CONSTRAINT "manga_genre_genre_id_genre_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genre"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manga_tag" ADD CONSTRAINT "manga_tag_manga_id_manga_id_fk" FOREIGN KEY ("manga_id") REFERENCES "public"."manga"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manga_tag" ADD CONSTRAINT "manga_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_preference" ADD CONSTRAINT "reader_preference_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_history" ADD CONSTRAINT "reading_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_history" ADD CONSTRAINT "reading_history_chapter_id_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_chapter_id_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapter"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reset_token" ADD CONSTRAINT "reset_token_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_job" ADD CONSTRAINT "upload_job_manga_id_manga_id_fk" FOREIGN KEY ("manga_id") REFERENCES "public"."manga"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_job" ADD CONSTRAINT "upload_job_chapter_id_chapter_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapter"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_job" ADD CONSTRAINT "upload_job_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_audit_target" ON "audit_event" USING btree ("target_kind","target_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_audit_actor" ON "audit_event" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_audit_created" ON "audit_event" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_bookmarks_user_chapter_page" ON "bookmark" USING btree ("user_id","chapter_id","page_number");--> statement-breakpoint
CREATE INDEX "ix_bookmarks_user" ON "bookmark" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_chapters_number" ON "chapter" USING btree ("manga_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_chapters_manga_order" ON "chapter" USING btree ("manga_id","reading_order");--> statement-breakpoint
CREATE INDEX "ix_chapters_visible" ON "chapter" USING btree ("reading_order") WHERE "chapter"."deleted_at" is null and "chapter"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "ix_pages_asset_key" ON "chapter_page" USING btree ("asset_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_creators_name" ON "creator" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_genres_name" ON "genre" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ix_library_user_lastread" ON "library_entry" USING btree ("user_id","last_read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_manga_slug" ON "manga" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ix_manga_title" ON "manga" USING btree ("title");--> statement-breakpoint
CREATE INDEX "ix_manga_updated_at" ON "manga" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "ix_manga_created_at" ON "manga" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_manga_visible" ON "manga" USING btree ("updated_at") WHERE "manga"."deleted_at" is null and "manga"."published" = true;--> statement-breakpoint
CREATE INDEX "ix_manga_title_trgm" ON "manga" ("title");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_manga_alias_manga_id_alias" ON "manga_alias" USING btree ("manga_id","alias");--> statement-breakpoint
CREATE INDEX "ix_manga_alias_alias" ON "manga_alias" ("alias");--> statement-breakpoint
CREATE INDEX "ix_manga_creator_creator_id" ON "manga_creator" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "ix_manga_genre_genre_id" ON "manga_genre" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "ix_manga_tag_tag_id" ON "manga_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "ix_history_user_time" ON "reading_history" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "ix_progress_user_updated" ON "reading_progress" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_resettokens_hash" ON "reset_token" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_resettokens_user" ON "reset_token" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_sessions_token" ON "sessions" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "ix_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_expires_at" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_tags_name" ON "tag" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "ix_uploads_state" ON "upload_job" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "ix_uploads_chapter" ON "upload_job" USING btree ("chapter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ix_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "ix_users_role" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "ix_users_status" ON "users" USING btree ("status");