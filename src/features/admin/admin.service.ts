/**
 * features/admin — AdminService: curator operations orchestration.
 *
 * Every mutation emits an audit event before returning. Publishing requires at
 * least one page, and a title's slug is immutable once published. Role re-check
 * is the web guard's job, but until the routes land this service checks
 * `caller.role === 'admin'` itself so a reader fails before any read —
 * including the existence checks, so a probe cannot learn whether an id exists.
 */
import { AppError } from '../../shared/contracts/errors';
import type { Caller } from '../../shared/contracts';
import type { AuditSink } from '../../shared/contracts/ports';
import type { AdminChapterRepository, AdminMangaRepository } from './admin-ports';
import type { ChapterId, MangaId } from '../../shared/types';

export interface AdminService {
  // Manga
  /** Every title, newest first — drafts, unpublished and soft-deleted included. */
  listManga(caller: Caller): Promise<
    Array<{
      id: string;
      slug: string;
      title: string;
      status: string;
      published: boolean;
      deletedAt: string | null;
    }>
  >;
  createManga(
    caller: Caller,
    input: {
      title: string;
      slug?: string;
      synopsis?: string;
      status: 'ongoing' | 'completed' | 'hiatus';
      readingDirection: 'rtl' | 'ltr';
      genreNames: string[];
      tagNames: string[];
      creators: Array<{ name: string; role: 'author' | 'artist' | 'other' }>;
    },
  ): Promise<string>; // ⇒ MANGA_SLUG_TAKEN on conflict

  updateManga(caller: Caller, mangaId: string, patch: Record<string, unknown>): Promise<void>;
  deleteManga(caller: Caller, mangaId: string): Promise<void>; // soft
  restoreManga(caller: Caller, mangaId: string): Promise<void>;
  publishManga(caller: Caller, mangaId: string, publish: boolean): Promise<{ affected: number }>;
  setCover(caller: Caller, mangaId: string, image: Uint8Array, format: string): Promise<void>;

  // Chapters
  /** Every chapter of a title in reading order, drafts included. */
  listChapters(
    caller: Caller,
    mangaId: string,
  ): Promise<
    Array<{
      id: string;
      number: string;
      title: string | null;
      status: string;
      publishedAt: string | null;
      pageCount: number;
      readingOrder: number;
    }>
  >;
  /** Reassign a title's reading order from the full ordered id list. */
  reorderChapters(caller: Caller, mangaId: string, orderedIds: string[]): Promise<void>;
  createChapter(
    caller: Caller,
    mangaId: string,
    input: {
      number: number;
      title?: string | null;
      notes?: string;
    },
  ): Promise<string>; // ⇒ CHAPTER_DUPLICATE_NUMBER

  updateChapter(caller: Caller, chapterId: string, patch: Record<string, unknown>): Promise<void>;
  deleteChapter(caller: Caller, chapterId: string): Promise<void>; // soft
  publishChapters(
    caller: Caller,
    mangaId: string,
    chapterIds: string[],
    publish: boolean,
  ): Promise<{ affected: number; skipped: number }>;

  // Users
  listUsers(query: { cursor?: string; limit?: number; emailContains?: string }): Promise<unknown[]>;
  updateUser(
    caller: Caller,
    userId: string,
    patch: { role?: 'reader' | 'admin'; status?: 'active' | 'disabled' },
  ): Promise<void>;
  // ⇒ ADMIN_LAST_ADMIN (guard), audit 'user.update'

  // Read-only (not audited)
  stats(caller: Caller): Promise<Record<string, unknown>>;
  auditLog(query: { cursor?: string; targetKind?: string; targetId?: string }): Promise<unknown>;
}

/**
 * The factory, wired with the admin write ports and the audit sink.
 *
 * The deps are the ADMIN ports, not the read ports: admin reads are unscoped
 * and admin writes do not exist on `MangaRepository` / `ChapterRepository`, so
 * wiring the read ports here would either starve the service or bloat interfaces
 * whose fakes span the suite. `users` is NOT taken: user management is
 * unimplemented, and a factory parameter nobody reads would be a promise the
 * wiring cannot keep.
 */
export function createAdminService(deps: {
  manga: AdminMangaRepository;
  chapters: AdminChapterRepository;
  audit: AuditSink;
}): AdminService {
  const { manga, chapters, audit } = deps;

  /**
   * The only role check in the service layer, and the only layer until the
   * routes land. Every method below calls it first, so a reader caller fails
   * before any read — including the existence checks — which means a probe
   * cannot learn whether a manga id exists either.
   */
  function requireAdmin(caller: Caller): void {
    if (caller.role !== 'admin') throw new AppError('AUTH_FORBIDDEN');
  }

  /** An audit summary small enough to stay bounded by construction. */
  function mangaSummary(row: {
    slug: string;
    title: string;
    status: string;
    readingDirection: string;
    published: boolean;
  }): Record<string, unknown> {
    // No synopsis: unbounded curator prose does not belong in an audit row.
    return {
      slug: row.slug,
      title: row.title,
      status: row.status,
      readingDirection: row.readingDirection,
      published: row.published,
    };
  }

  function chapterSummary(row: {
    number: string;
    title: string | null;
    status: string;
    pageCount: number;
    readingOrder: number;
  }): Record<string, unknown> {
    // No notes body: unbounded curator prose does not belong in an audit row.
    return {
      number: row.number,
      title: row.title,
      status: row.status,
      pageCount: row.pageCount,
      readingOrder: row.readingOrder,
    };
  }

  /**
   * A chapter number as the curator typed it, validated before storage.
   * `numeric(8,2)` rounds silently on write, so three decimals must be refused
   * here rather than stored rounded — "10.555" is a typo worth answering, and a
   * stored "10.56" the curator never typed would be a lie about their input.
   */
  function chapterNumber(input: number): string {
    if (!Number.isFinite(input) || input < 0) {
      throw new AppError('VALIDATION_BAD_QUERY', {
        details: [{ path: 'number', message: 'Must be a finite number at or above 0.' }],
      });
    }
    const rounded = Math.round(input * 100) / 100;
    if (Math.abs(input - rounded) > Number.EPSILON) {
      throw new AppError('VALIDATION_BAD_QUERY', {
        details: [{ path: 'number', message: 'At most 2 decimal places (numeric(8,2)).' }],
      });
    }
    return String(rounded);
  }

  return {
    async listManga(caller) {
      requireAdmin(caller);
      // Reads are not audited: a shelf lookup is not an action, and an audit row
      // per list would drown the mutations the log exists to record.
      const rows = await manga.listAll();
      return rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        status: row.status,
        published: row.published,
        deletedAt: row.deletedAt,
      }));
    },

    async listChapters(caller, mangaId) {
      requireAdmin(caller);
      const id = mangaId as MangaId;
      const existing = await manga.getById(id);
      if (existing === null) throw new AppError('MANGA_NOT_FOUND');
      const rows = await chapters.listByManga(id);
      return rows.map((row) => ({
        id: row.id,
        number: row.number,
        title: row.title,
        status: row.status,
        publishedAt: row.publishedAt,
        pageCount: row.pageCount,
        readingOrder: row.readingOrder,
      }));
    },

    async reorderChapters(caller, mangaId, orderedIds) {
      requireAdmin(caller);
      const id = mangaId as MangaId;
      const existing = await manga.getById(id);
      if (existing === null) throw new AppError('MANGA_NOT_FOUND');
      const before = (await chapters.listByManga(id)).map((row) => row.id);
      await chapters.reorder(
        id,
        orderedIds.map((raw) => raw as ChapterId),
      );
      await audit.append({
        actorId: caller.userId,
        actorEmail: null,
        action: 'chapter.reorder',
        targetKind: 'manga',
        targetId: id,
        before: { order: before },
        after: { order: orderedIds },
      });
    },

    async createManga(caller, input) {
      requireAdmin(caller);
      const title = input.title.trim();
      if (title === '') {
        throw new AppError('VALIDATION_BAD_QUERY', {
          details: [{ path: 'title', message: 'Must not be blank.' }],
        });
      }
      const { id } = await manga.create({ ...input, title });
      const created = await manga.getById(id);
      // Created milliseconds ago by this call, so absence here is an internal
      // inconsistency, not a 404: the row was just written.
      if (created === null) throw new AppError('INTERNAL_ERROR');
      await audit.append({
        actorId: caller.userId,
        actorEmail: null,
        action: 'manga.create',
        targetKind: 'manga',
        targetId: id,
        before: null,
        after: mangaSummary(created),
      });
      return created.slug;
    },

    async updateManga(caller, mangaId, patch) {
      requireAdmin(caller);
      const id = mangaId as MangaId;
      const existing = await manga.getById(id);
      if (existing === null) throw new AppError('MANGA_NOT_FOUND');
      // The slug is immutable once published. Checked here rather than in the
      // repository because only the service sees the row AND the patch
      // together — the repository cannot tell "no slug in the patch" from
      // "slug unchanged".
      const nextSlug = (patch as { slug?: unknown }).slug;
      if (typeof nextSlug === 'string' && nextSlug !== existing.slug) {
        if (existing.published) {
          throw new AppError('VALIDATION_BAD_QUERY', {
            details: [
              { path: 'slug', message: 'Slug is immutable after first publish.' },
            ],
          });
        }
      }
      const before = mangaSummary(existing);
      await manga.update(id, patch);
      const after = await manga.getById(id);
      await audit.append({
        actorId: caller.userId,
        actorEmail: null,
        action: 'manga.update',
        targetKind: 'manga',
        targetId: id,
        before,
        after: after === null ? null : mangaSummary(after),
      });
    },

    async deleteManga() {
      throw new Error(
        'Not implemented: soft-delete + restore is its own state machine',
      );
    },

    async restoreManga() {
      throw new Error(
        'Not implemented: soft-delete + restore is its own state machine',
      );
    },

    async publishManga(caller, mangaId, publish) {
      requireAdmin(caller);
      const id = mangaId as MangaId;
      const existing = await manga.getById(id);
      if (existing === null) throw new AppError('MANGA_NOT_FOUND');
      // A transition, not a blind write: publishing an already-published title
      // (or unpublishing an unpublished one) changes nothing and audits nothing.
      // An audit row for a no-op would claim an action nobody took.
      if (existing.published === publish) return { affected: 0 };
      await manga.setPublished(id, publish);
      await audit.append({
        actorId: caller.userId,
        actorEmail: null,
        action: publish ? 'manga.publish' : 'manga.unpublish',
        targetKind: 'manga',
        targetId: id,
        before: { published: existing.published },
        after: { published: publish },
      });
      return { affected: 1 };
    },

    async setCover() {
      throw new Error(
        'Not implemented: cover ingest rides the upload pipeline',
      );
    },

    async createChapter(caller, mangaId, input) {
      requireAdmin(caller);
      const id = mangaId as MangaId;
      const number = chapterNumber(input.number);
      const created = await chapters.create(id, {
        number,
        title: input.title ?? null,
        notes: input.notes ?? '',
      });
      await audit.append({
        actorId: caller.userId,
        actorEmail: null,
        action: 'chapter.create',
        targetKind: 'chapter',
        targetId: created.id,
        before: null,
        after: { mangaId: id, number },
      });
      return created.id;
    },

    async updateChapter(caller, chapterId, patch) {
      requireAdmin(caller);
      const id = chapterId as ChapterId;
      const existing = await chapters.getById(id);
      if (existing === null) throw new AppError('CHAPTER_NOT_FOUND');
      const before = chapterSummary(existing);
      const raw = patch as { number?: unknown; title?: unknown; notes?: unknown };
      await chapters.update(id, {
        ...(raw.number === undefined ? {} : { number: chapterNumber(raw.number as number) }),
        ...(raw.title === undefined ? {} : { title: raw.title as string | null }),
        ...(raw.notes === undefined ? {} : { notes: raw.notes as string }),
      });
      const after = await chapters.getById(id);
      await audit.append({
        actorId: caller.userId,
        actorEmail: null,
        action: 'chapter.update',
        targetKind: 'chapter',
        targetId: id,
        before,
        after: after === null ? null : chapterSummary(after),
      });
    },

    async deleteChapter() {
      throw new Error(
        'Not implemented: soft-delete + restore is its own state machine',
      );
    },

    async publishChapters(caller, mangaId, chapterIds, publish) {
      requireAdmin(caller);
      const now = new Date().toISOString();
      let affected = 0;
      let skipped = 0;
      // Sequential, not parallel: the audit rows must read in call order, and a
      // bulk publish of a shelf is tens of chapters, not thousands — the loop
      // is the honest shape, and a fan-out would buy nothing but interleaved
      // audit.
      for (const rawId of chapterIds) {
        const id = rawId as ChapterId;
        const existing = await chapters.getById(id);
        // Unknown, or another title's: skipped, not thrown. A bulk call that
        // names one bad id should not fail the whole shelf — and "skipped"
        // tells the caller exactly which ones did nothing, without saying why
        // in a way a probe could use.
        if (existing === null || existing.mangaId !== (mangaId as MangaId)) {
          skipped += 1;
          continue;
        }
        if (publish) {
          // Already published: nothing to do, and nothing to audit.
          if (existing.status === 'published') continue;
          // Enforced here and nowhere else: a chapter with no pages cannot be
          // published. The page count is ingest's to fill, and publishing is the
          // gate that says it did.
          if (existing.pageCount < 1) {
            skipped += 1;
            continue;
          }
          // First publish stamps; a re-publish after an unpublish keeps the
          // original stamp — "unpublished" and "never published" stay
          // distinguishable, and the first-published moment is history, not a
          // field that moves.
          await chapters.setPublishState(id, 'published', existing.publishedAt ?? now);
          await audit.append({
            actorId: caller.userId,
            actorEmail: null,
            action: 'chapter.publish',
            targetKind: 'chapter',
            targetId: id,
            before: chapterSummary(existing),
            after: { ...chapterSummary(existing), status: 'published' },
          });
          affected += 1;
        } else {
          // Already a draft: nothing to do, and nothing to audit. Unpublishing
          // keeps `published_at` — that stamp is what distinguishes this row
          // from one that was never published.
          if (existing.status === 'draft') continue;
          await chapters.setPublishState(id, 'draft', existing.publishedAt);
          await audit.append({
            actorId: caller.userId,
            actorEmail: null,
            action: 'chapter.unpublish',
            targetKind: 'chapter',
            targetId: id,
            before: chapterSummary(existing),
            after: { ...chapterSummary(existing), status: 'draft' },
          });
          affected += 1;
        }
      }
      return { affected, skipped };
    },

    async listUsers() {
      throw new Error('Not implemented: user management is out of scope');
    },

    async updateUser() {
      throw new Error('Not implemented: user management is out of scope');
    },

    async stats() {
      throw new Error('Not implemented: stats assembly is out of scope');
    },

    async auditLog() {
      throw new Error('Not implemented: the audit viewer is post-MVP');
    },
  };
}
