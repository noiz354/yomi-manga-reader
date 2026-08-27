/**
 * Admin write repositories: the curator's unscoped reads and writes — every read
 * sees EVERYTHING (drafts, unpublished, soft-deleted) because those are the
 * working material, not the exception. Nothing here takes a caller: the SERVICE
 * owns the admin check, these functions own the data; a repository that also
 * checked the role would let a caller pass anyone and still feel safe. Every
 * unknown id is checked before the write, so a typo is the documented error code, never a foreign-key 500.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError } from '../../../shared/contracts/errors';
import type { Db } from '../client';
import { chapter, creator, genre, manga, mangaCreator, mangaGenre, mangaTag, tag } from '../schema';
import type {
  AdminChapterInput,
  AdminChapterPatch,
  AdminChapterRepository,
  AdminChapterRow,
  AdminMangaInput,
  AdminMangaPatch,
  AdminMangaRepository,
  AdminMangaRow,
} from '../../../features/admin/admin-ports';
import type { ChapterId, MangaId } from '../../../shared/types';

type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

const MANGA_COLUMNS = {
  id: manga.id,
  slug: manga.slug,
  title: manga.title,
  synopsis: manga.synopsis,
  status: manga.status,
  readingDirection: manga.readingDirection,
  published: manga.published,
  deletedAt: manga.deletedAt,
} as const;

const CHAPTER_COLUMNS = {
  id: chapter.id,
  mangaId: chapter.mangaId,
  number: chapter.number,
  title: chapter.title,
  notes: chapter.notes,
  status: chapter.status,
  publishedAt: chapter.publishedAt,
  pageCount: chapter.pageCount,
  readingOrder: chapter.readingOrder,
  deletedAt: chapter.deletedAt,
} as const;

function toMangaRow(row: typeof manga.$inferSelect): AdminMangaRow {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    synopsis: row.synopsis,
    status: row.status as AdminMangaRow['status'],
    readingDirection: row.readingDirection as AdminMangaRow['readingDirection'],
    published: row.published,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

function toChapterRow(row: typeof chapter.$inferSelect): AdminChapterRow {
  return {
    id: row.id,
    mangaId: row.mangaId,
    number: row.number,
    title: row.title,
    notes: row.notes,
    status: row.status as AdminChapterRow['status'],
    publishedAt: row.publishedAt === null ? null : row.publishedAt.toISOString(),
    pageCount: row.pageCount,
    readingOrder: row.readingOrder,
    deletedAt: row.deletedAt === null ? null : row.deletedAt.toISOString(),
  };
}

/**
 * Derive a slug from a title: lowercase, runs of anything else become one
 * dash, leading/trailing dashes trimmed. `Café  Noir!!` → `caf-noir` (the
 * accent is dropped, not transliterated — a slug is an identifier, and
 * transliteration tables are a second source of truth for the same string).
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 190);
}

/** Upsert genres BY NAME and return their ids (`name` is the unique identity). */
async function upsertGenres(executor: Executor, names: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ''))];
  if (wanted.length === 0) return [];
  await executor
    .insert(genre)
    .values(wanted.map((name) => ({ name })))
    .onConflictDoNothing();
  const rows = await executor
    .select({ id: genre.id, name: genre.name })
    .from(genre)
    .where(inArray(genre.name, wanted));
  const byName = new Map(rows.map((row) => [row.name, row.id]));
  return wanted.flatMap((name) => {
    const id = byName.get(name);
    return id === undefined ? [] : [id];
  });
}

/**
 * Upsert tags BY FOLDED NAME and return their ids. The unique index is over
 * `lower(name)`, so "Action" and "action" are one tag — and the FIRST spelling
 * seen wins the stored form, which is fine, because the name is a label and the
 * id is the identity.
 */
async function upsertTags(executor: Executor, names: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(names.map((name) => name.trim()).filter((name) => name !== ''))];
  if (wanted.length === 0) return [];
  await executor
    .insert(tag)
    .values(wanted.map((name) => ({ name })))
    .onConflictDoNothing();
  const rows = await executor
    .select({ id: tag.id, name: tag.name })
    .from(tag)
    .where(sql`lower(${tag.name}) IN ${wanted.map((name) => name.toLowerCase())}`);
  const byFolded = new Map(rows.map((row) => [row.name.toLowerCase(), row.id]));
  return wanted.flatMap((name) => {
    const id = byFolded.get(name.toLowerCase());
    return id === undefined ? [] : [id];
  });
}

/** Upsert creators BY NAME and return `{ id, role }` links. */
async function upsertCreators(
  executor: Executor,
  creators: readonly { name: string; role: 'author' | 'artist' | 'other' }[],
): Promise<Array<{ id: string; role: string }>> {
  const wanted: Array<{ name: string; role: 'author' | 'artist' | 'other' }> = [
    ...new Map(creators.map((c) => [c.name.trim(), c] as const)).values(),
  ].filter((c) => c.name !== '');
  if (wanted.length === 0) return [];
  await executor
    .insert(creator)
    .values(wanted.map((c) => ({ name: c.name.trim(), roleDefault: c.role })))
    .onConflictDoNothing();
  const rows = await executor
    .select({ id: creator.id, name: creator.name })
    .from(creator)
    .where(
      inArray(
        creator.name,
        wanted.map((c) => c.name.trim()),
      ),
    );
  const byName = new Map(rows.map((row) => [row.name, row.id]));
  return wanted.flatMap((c) => {
    const id = byName.get(c.name.trim());
    return id === undefined ? [] : [{ id, role: c.role }];
  });
}

/**
 * Replace the link sets a patch NAMES, and leave every unnamed set untouched.
 * Delete-then-insert rather than a diff: a named set replaces wholesale and
 * cannot leave a stale link, and an unnamed one is never read, let alone
 * written.
 */
async function relink(
  executor: Executor,
  id: MangaId,
  input: {
    genreNames?: string[];
    tagNames?: string[];
    creators?: Array<{ name: string; role: 'author' | 'artist' | 'other' }>;
  },
): Promise<void> {
  if (input.genreNames !== undefined) {
    await executor.delete(mangaGenre).where(eq(mangaGenre.mangaId, id));
    const ids = await upsertGenres(executor, input.genreNames);
    if (ids.length > 0) {
      await executor
        .insert(mangaGenre)
        .values(ids.map((genreId) => ({ mangaId: id, genreId })))
        .onConflictDoNothing();
    }
  }
  if (input.tagNames !== undefined) {
    await executor.delete(mangaTag).where(eq(mangaTag.mangaId, id));
    const ids = await upsertTags(executor, input.tagNames);
    if (ids.length > 0) {
      await executor
        .insert(mangaTag)
        .values(ids.map((tagId) => ({ mangaId: id, tagId })))
        .onConflictDoNothing();
    }
  }
  if (input.creators !== undefined) {
    await executor.delete(mangaCreator).where(eq(mangaCreator.mangaId, id));
    const resolved = await upsertCreators(executor, input.creators);
    if (resolved.length > 0) {
      await executor
        .insert(mangaCreator)
        .values(resolved.map((link) => ({ mangaId: id, creatorId: link.id, role: link.role })))
        .onConflictDoNothing();
    }
  }
}

export function createAdminMangaRepository(db: Db): AdminMangaRepository {
  return {
    async listAll(): Promise<AdminMangaRow[]> {
      const rows = await db.select(MANGA_COLUMNS).from(manga).orderBy(desc(manga.createdAt));
      return rows.map((row) => toMangaRow(row as unknown as typeof manga.$inferSelect));
    },

    async getById(id: MangaId): Promise<AdminMangaRow | null> {
      const rows = await db.select(MANGA_COLUMNS).from(manga).where(eq(manga.id, id)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toMangaRow(row as unknown as typeof manga.$inferSelect);
    },

    async getBySlug(slug: string): Promise<AdminMangaRow | null> {
      const rows = await db.select(MANGA_COLUMNS).from(manga).where(eq(manga.slug, slug)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toMangaRow(row as unknown as typeof manga.$inferSelect);
    },

    async create(input: AdminMangaInput): Promise<{ id: MangaId }> {
      const slug = (input.slug ?? slugify(input.title)).trim();
      if (slug === '') {
        throw new AppError('VALIDATION_BAD_QUERY', {
          details: [
            { path: 'slug', message: 'A title that slugifies to nothing needs an explicit slug.' },
          ],
        });
      }
      // Checked first: a conflict is MANGA_SLUG_TAKEN, never a unique-violation
      // 500 from the insert below.
      const taken = await db
        .select({ id: manga.id })
        .from(manga)
        .where(eq(manga.slug, slug))
        .limit(1);
      if (taken.length > 0) {
        throw new AppError('MANGA_SLUG_TAKEN');
      }
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(manga)
          .values({
            slug,
            title: input.title,
            synopsis: input.synopsis ?? '',
            status: input.status,
            readingDirection: input.readingDirection,
          })
          .returning({ id: manga.id });
        const id = inserted[0]?.id as MangaId;
        await relink(tx, id, {
          genreNames: input.genreNames,
          tagNames: input.tagNames,
          creators: input.creators,
        });
        return { id };
      });
    },

    async update(id: MangaId, patch: AdminMangaPatch): Promise<void> {
      const existing = await db.select(MANGA_COLUMNS).from(manga).where(eq(manga.id, id)).limit(1);
      if (existing.length === 0) throw new AppError('MANGA_NOT_FOUND');
      // A slug change to a TAKEN slug is MANGA_SLUG_TAKEN; the published-guard
      // (slug immutable after first publish) is the SERVICE's, which sees the
      // row and the patch together.
      if (patch.slug !== undefined && patch.slug !== existing[0]?.slug) {
        const taken = await db
          .select({ id: manga.id })
          .from(manga)
          .where(eq(manga.slug, patch.slug))
          .limit(1);
        if (taken.length > 0) throw new AppError('MANGA_SLUG_TAKEN');
      }
      await db.transaction(async (tx) => {
        const { genreNames, tagNames, creators, ...scalars } = patch;
        const scalarEntries = Object.entries(scalars).filter(([, value]) => value !== undefined);
        if (scalarEntries.length > 0) {
          await tx.update(manga).set(Object.fromEntries(scalarEntries)).where(eq(manga.id, id));
        }
        // Rebuilt without the undefined keys: under `exactOptionalPropertyTypes`
        // a present-but-undefined property is not the same as an absent one,
        // and `relink` reads absence as "leave untouched".
        await relink(tx, id, {
          ...(genreNames === undefined ? {} : { genreNames }),
          ...(tagNames === undefined ? {} : { tagNames }),
          ...(creators === undefined ? {} : { creators }),
        });
      });
    },

    async setPublished(id: MangaId, published: boolean): Promise<void> {
      const existing = await db
        .select({ id: manga.id })
        .from(manga)
        .where(eq(manga.id, id))
        .limit(1);
      if (existing.length === 0) throw new AppError('MANGA_NOT_FOUND');
      await db.update(manga).set({ published }).where(eq(manga.id, id));
    },
  };
}

export function createAdminChapterRepository(db: Db): AdminChapterRepository {
  return {
    async listByManga(mangaId: MangaId): Promise<AdminChapterRow[]> {
      const rows = await db
        .select(CHAPTER_COLUMNS)
        .from(chapter)
        .where(eq(chapter.mangaId, mangaId))
        .orderBy(asc(chapter.readingOrder));
      return rows.map((row) => toChapterRow(row as unknown as typeof chapter.$inferSelect));
    },

    async getById(id: ChapterId): Promise<AdminChapterRow | null> {
      const rows = await db
        .select(CHAPTER_COLUMNS)
        .from(chapter)
        .where(eq(chapter.id, id))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toChapterRow(row as unknown as typeof chapter.$inferSelect);
    },

    async create(mangaId: MangaId, input: AdminChapterInput): Promise<{ id: ChapterId }> {
      // The manga check first: without it an unknown manga is an FK 500, and a
      // typo'd id is exactly the case that must be a 404.
      const parent = await db
        .select({ id: manga.id })
        .from(manga)
        .where(eq(manga.id, mangaId))
        .limit(1);
      if (parent.length === 0) throw new AppError('MANGA_NOT_FOUND');
      const dupe = await db
        .select({ id: chapter.id })
        .from(chapter)
        .where(and(eq(chapter.mangaId, mangaId), eq(chapter.number, input.number)))
        .limit(1);
      if (dupe.length > 0) throw new AppError('CHAPTER_DUPLICATE_NUMBER');
      // Appended at the end: `max(reading_order) + 1`, or 1 for the first
      // chapter. `COALESCE` because `max` of nothing is null, not zero.
      const top = await db
        .select({ order: sql<number>`coalesce(max(${chapter.readingOrder}), 0)` })
        .from(chapter)
        .where(eq(chapter.mangaId, mangaId));
      const order = Number(top[0]?.order ?? 0) + 1;
      const inserted = await db
        .insert(chapter)
        .values({
          mangaId,
          number: input.number,
          title: input.title ?? null,
          notes: input.notes ?? '',
          readingOrder: order,
        })
        .returning({ id: chapter.id });
      return { id: inserted[0]?.id as ChapterId };
    },

    async update(id: ChapterId, patch: AdminChapterPatch): Promise<void> {
      const existing = await db
        .select({ id: chapter.id, mangaId: chapter.mangaId, number: chapter.number })
        .from(chapter)
        .where(eq(chapter.id, id))
        .limit(1);
      const row = existing[0];
      if (row === undefined) throw new AppError('CHAPTER_NOT_FOUND');
      // A sibling's number is taken; the chapter's OWN number is fine — without
      // the self-exclusion every update that names the current number would be
      // a false conflict.
      if (patch.number !== undefined && patch.number !== row.number) {
        const dupe = await db
          .select({ id: chapter.id })
          .from(chapter)
          .where(and(eq(chapter.mangaId, row.mangaId), eq(chapter.number, patch.number)))
          .limit(1);
        if (dupe.length > 0) throw new AppError('CHAPTER_DUPLICATE_NUMBER');
      }
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length === 0) return;
      await db.update(chapter).set(Object.fromEntries(entries)).where(eq(chapter.id, id));
    },

    async setPublishState(
      id: ChapterId,
      status: 'draft' | 'published',
      publishedAt: string | null,
    ): Promise<void> {
      const existing = await db
        .select({ id: chapter.id })
        .from(chapter)
        .where(eq(chapter.id, id))
        .limit(1);
      if (existing.length === 0) throw new AppError('CHAPTER_NOT_FOUND');
      await db
        .update(chapter)
        .set({
          status,
          publishedAt: publishedAt === null ? null : new Date(publishedAt),
        })
        .where(eq(chapter.id, id));
    },

    async reorder(mangaId: MangaId, orderedIds: ChapterId[]): Promise<void> {
      // Existence first, in ONE query: an id that is unknown ANYWHERE is
      // CHAPTER_NOT_FOUND, full stop. Only then the set check, so "no such
      // chapter" and "not this title's chapter" are different answers — the
      // first is about existence, the second about the set, and conflating them
      // would make a typo indistinguishable from a cross-title reach.
      if (orderedIds.length > 0) {
        const wanted = await db
          .select({ id: chapter.id })
          .from(chapter)
          .where(inArray(chapter.id, orderedIds));
        if (wanted.length !== new Set(orderedIds).size) {
          throw new AppError('CHAPTER_NOT_FOUND');
        }
      }
      const current = await db
        .select({ id: chapter.id })
        .from(chapter)
        .where(eq(chapter.mangaId, mangaId));
      const currentSet = new Set(current.map((row) => row.id));
      const wantedSet = new Set(orderedIds);
      // Exactly the title's chapters: a caller that drops one would silently
      // un-order it, and a caller that names a stranger's chapter would reach
      // across titles. Both are refused, not repaired.
      const sameSize = wantedSet.size === currentSet.size && orderedIds.length === currentSet.size;
      const sameMembers = [...wantedSet].every((id) => currentSet.has(id));
      if (!sameSize || !sameMembers) {
        throw new AppError('VALIDATION_BAD_QUERY', {
          details: [
            {
              path: 'orderedIds',
              message: 'Must name exactly this title\u2019s chapters, once each.',
            },
          ],
        });
      }
      await db.transaction(async (tx) => {
        // Two phases, because `(manga_id, reading_order)` is unique and checked
        // per row: a direct swap collides with itself halfway through. Negatives
        // are distinct from every real order, so phase one cannot conflict, and
        // phase two writes the final values onto rows that hold distinct
        // placeholders.
        for (let index = 0; index < orderedIds.length; index += 1) {
          const id = orderedIds[index] as ChapterId;
          await tx
            .update(chapter)
            .set({ readingOrder: -(index + 1) })
            .where(eq(chapter.id, id));
        }
        for (let index = 0; index < orderedIds.length; index += 1) {
          const id = orderedIds[index] as ChapterId;
          await tx
            .update(chapter)
            .set({ readingOrder: index + 1 })
            .where(eq(chapter.id, id));
        }
      });
    },
  };
}
