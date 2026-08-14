-- Restore the real-Postgres model that 0000 froze out of the migration.
--
-- 0000 was generated against a PGlite-style DSN, so its dev-fallback branch was
-- baked into the permanent initial migration: users.email stayed text, the two
-- trigram indexes stayed btree, and both CREATE EXTENSION lines were commented
-- out. 0000 is not edited, because an environment that already applied it would
-- never see the change. This migration is additive and dialect-aware: real
-- PostgreSQL gets citext, pg_trgm and the GIN trigram indexes; the PGlite
-- fallback keeps the btree/text behaviour, with a NOTICE.

--> statement-breakpoint
-- Extensions first: the type and the operator class below are both supplied by them.
-- A backend without extension support (PGlite) raises here, and the exception handler
-- keeps the migration reversible-on-failure rather than wedging every later boot.
DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS "citext"';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'citext unavailable on this backend; users.email stays text (PGlite dev fallback)';
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS "pg_trgm"';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable on this backend; trigram indexes stay btree (PGlite dev fallback)';
END
$$;
--> statement-breakpoint
-- `email citext NOT NULL`. Widening text -> citext is a table rewrite, so it
-- only happens when citext actually exists. Case-insensitive uniqueness then
-- comes from the type itself rather than from a lower(email) index.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'citext') THEN
    EXECUTE 'ALTER TABLE "users" ALTER COLUMN "email" TYPE citext';
  END IF;
END
$$;
--> statement-breakpoint
-- GIN trigram indexes on manga.title and manga_alias.alias. 0000 created btree
-- indexes under the same names, so the replacement is a drop + create rather than
-- an additional index — two indexes on one column would make every write pay for
-- both.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'DROP INDEX IF EXISTS "ix_manga_title_trgm"';
    EXECUTE 'DROP INDEX IF EXISTS "ix_manga_alias_alias"';
    EXECUTE 'CREATE INDEX "ix_manga_title_trgm" ON "manga" USING gin ("title" gin_trgm_ops)';
    EXECUTE 'CREATE INDEX "ix_manga_alias_alias" ON "manga_alias" USING gin ("alias" gin_trgm_ops)';
  END IF;
END
$$;
