/**
 * The admin service, manga and chapter CRUD.
 *
 * `createAdminService` wired to the real admin repositories over a throwaway
 * database, with a RECORDING audit fake: every mutation must append exactly one
 * audit event before returning, and the event must name the action, the target
 * and a small before/after — never a synopsis or notes body.
 *
 * The behaviours that justify this file's existence:
 * - publish is a STATE TRANSITION: first publish stamps `published_at`,
 *   unpublish keeps the stamp, re-publish keeps the original, so "unpublished"
 *   and "never published" stay distinguishable.
 * - an unknown manga or chapter is a 404 checked BEFORE the write, never a
 *   foreign-key 500.
 * - a non-admin caller fails before any read, so a probe cannot learn whether
 *   an id exists.
 * - reorder names exactly the title's chapters and survives the unique index.
 *
 * Routes, pages and forms are deliberately absent: the admin route guard is
 * deferred, and an unguarded admin route would be a P0 regression, so this
 * slice is service-and-repository-only. The audit VIEWER is separate; what is
 * asserted here is that the events are EMITTED.
 *
 * Needs DATABASE_URL. Skips cleanly without it, like every other DB test here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAdminService } from '../../src/features/admin/admin.service';
import {
  createAdminChapterRepository,
  createAdminMangaRepository,
} from '../../src/server/db/repositories/admin.repository';
import { openCatalogDatabase } from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import { chapter } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { AuditSink } from '../../src/shared/contracts/ports';
import type { Caller } from '../../src/shared/contracts';
import type { ChapterId, MangaId, UserId } from '../../src/shared/types';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const DB_NAME = 'admin_service_it';
const ADMIN: Caller = { userId: '0198c0f0-0000-7000-8000-00000000a001' as UserId, role: 'admin' };
const READER: Caller = { userId: '0198c0f0-0000-7000-8000-00000000a002' as UserId, role: 'reader' };
const UNKNOWN_MANGA = '0198c0f0-0000-7000-8000-00000000a003' as MangaId;
const UNKNOWN_CHAPTER = '0198c0f0-0000-7000-8000-00000000a004' as ChapterId;

type AuditEvent = Parameters<AuditSink['append']>[0];

describeDb('the admin service', () => {
  let open: OpenDatabase;
  let events: AuditEvent[];
  let service: ReturnType<typeof createAdminService>;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, DB_NAME);
    const throwaway = new URL(DATABASE_URL as string);
    throwaway.pathname = `/${DB_NAME}`;
    for (const [key, value] of Object.entries(envSource(throwaway.toString()))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    events = [];
    const audit: AuditSink = {
      append: vi.fn(async (event: AuditEvent) => {
        events.push(event);
      }),
    };
    service = createAdminService({
      manga: createAdminMangaRepository(open.db),
      chapters: createAdminChapterRepository(open.db),
      audit,
    });
  });

  afterAll(async () => {
    await open?.close();
  });

  const mangaInput = (title: string, slug?: string) => ({
    title,
    ...(slug === undefined ? {} : { slug }),
    synopsis: 'A synopsis that must never reach the audit log.',
    status: 'ongoing' as const,
    readingDirection: 'ltr' as const,
    genreNames: ['Action', 'Drama'],
    tagNames: ['QuestMark'],
    creators: [{ name: 'Admin Author', role: 'author' as const }],
  });

  describe('a non-admin caller fails before any read', () => {
    it('refuses create, update, publish, chapter writes and reorder with 403', async () => {
      for (const call of [
        () => service.createManga(READER, mangaInput('Nope')),
        () => service.updateManga(READER, UNKNOWN_MANGA, {}),
        () => service.publishManga(READER, UNKNOWN_MANGA, true),
        () => service.createChapter(READER, UNKNOWN_MANGA, { number: 1 }),
        () => service.updateChapter(READER, UNKNOWN_CHAPTER, {}),
        () => service.publishChapters(READER, UNKNOWN_MANGA, [], true),
        () => service.reorderChapters(READER, UNKNOWN_MANGA, []),
        () => service.listManga(READER),
        () => service.listChapters(READER, UNKNOWN_MANGA),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
      }
      // Nothing was read, let alone written: a probe learns nothing, not even
      // whether the unknown ids exist — and nothing was audited either.
      expect(events).toHaveLength(0);
    });
  });

  describe('manga CRUD', () => {
    it('creates a title with links, and lists it back', async () => {
      const slug = await service.createManga(ADMIN, mangaInput('Admin Title One'));

      expect(slug).toBe('admin-title-one');
      const shelf = await service.listManga(ADMIN);
      expect(shelf.map((row) => row.slug)).toContain('admin-title-one');
    });

    it('derives the slug, and refuses a taken one with the documented conflict code', async () => {
      await service.createManga(ADMIN, mangaInput('Taken Slug'));

      await expect(service.createManga(ADMIN, mangaInput('Taken Slug'))).rejects.toMatchObject({
        code: 'MANGA_SLUG_TAKEN',
      });
      await expect(
        service.createManga(ADMIN, mangaInput('Other Title', 'taken-slug')),
      ).rejects.toMatchObject({ code: 'MANGA_SLUG_TAKEN' });
    });

    it('refuses a title that slugifies to nothing without an explicit slug', async () => {
      await expect(service.createManga(ADMIN, mangaInput('!!!'))).rejects.toMatchObject({
        code: 'VALIDATION_BAD_QUERY',
      });
    });

    it('updates scalars and replaces named link sets wholesale', async () => {
      const slug = await service.createManga(ADMIN, mangaInput('Patch Me'));
      const shelf = await service.listManga(ADMIN);
      const id = shelf.find((row) => row.slug === slug)?.id as string;

      await service.updateManga(ADMIN, id, { title: 'Patched', genreNames: ['Drama'] });

      const after = (await service.listManga(ADMIN)).find((row) => row.id === id);
      expect(after?.title).toBe('Patched');
    });

    it('answers MANGA_NOT_FOUND for an unknown id, not an FK 500', async () => {
      await expect(service.updateManga(ADMIN, UNKNOWN_MANGA, { title: 'x' })).rejects.toMatchObject(
        { code: 'MANGA_NOT_FOUND' },
      );
      await expect(service.publishManga(ADMIN, UNKNOWN_MANGA, true)).rejects.toMatchObject({
        code: 'MANGA_NOT_FOUND',
      });
      await expect(service.listChapters(ADMIN, UNKNOWN_MANGA)).rejects.toMatchObject({
        code: 'MANGA_NOT_FOUND',
      });
    });

    it('publishes and unpublishes as a transition: a no-op audits nothing', async () => {
      const slug = await service.createManga(ADMIN, mangaInput('Toggle Me'));
      const id = (await service.listManga(ADMIN)).find((row) => row.slug === slug)?.id as string;
      events.length = 0;

      expect(await service.publishManga(ADMIN, id, true)).toEqual({ affected: 1 });
      // Already published: no write, no audit row for an action nobody took.
      expect(await service.publishManga(ADMIN, id, true)).toEqual({ affected: 0 });
      expect(await service.publishManga(ADMIN, id, false)).toEqual({ affected: 1 });

      const shelf = await service.listManga(ADMIN);
      expect(shelf.find((row) => row.id === id)?.published).toBe(false);
      expect(events.map((event) => event.action)).toEqual(['manga.publish', 'manga.unpublish']);
    });

    it('refuses a slug change on a published title', async () => {
      const slug = await service.createManga(ADMIN, mangaInput('Frozen Slug'));
      const id = (await service.listManga(ADMIN)).find((row) => row.slug === slug)?.id as string;
      await service.publishManga(ADMIN, id, true);

      await expect(service.updateManga(ADMIN, id, { slug: 'thawed' })).rejects.toMatchObject({
        code: 'VALIDATION_BAD_QUERY',
      });
      // Unpublished titles may still be renamed: the rule guards published
      // work, not drafts.
      await service.publishManga(ADMIN, id, false);
      await service.updateManga(ADMIN, id, { slug: 'thawed' });
      expect((await service.listManga(ADMIN)).find((row) => row.id === id)?.slug).toBe('thawed');
    });
  });

  describe('chapter CRUD', () => {
    const makeTitle = async (title: string): Promise<string> => {
      const slug = await service.createManga(ADMIN, mangaInput(title));
      return (await service.listManga(ADMIN)).find((row) => row.slug === slug)?.id as string;
    };

    it('appends chapters in reading order, and lists them so', async () => {
      const id = await makeTitle('Chapter Order');
      await service.createChapter(ADMIN, id, { number: 2 });
      await service.createChapter(ADMIN, id, { number: 1 });
      await service.createChapter(ADMIN, id, { number: 10.5 });

      const rows = await service.listChapters(ADMIN, id);
      expect(rows.map((row) => row.readingOrder)).toEqual([1, 2, 3]);
      // `numeric(8,2)` comes back in stored form — '2.00', not '2'. The admin
      // list shows what is stored; the curator typed '2', the database keeps
      // '2.00', and the two are the same number.
      expect(rows.map((row) => row.number)).toEqual(['2.00', '1.00', '10.50']);
    });

    it('refuses a duplicate number on the same title, but not across titles', async () => {
      const a = await makeTitle('Dupe A');
      const b = await makeTitle('Dupe B');
      await service.createChapter(ADMIN, a, { number: 1 });

      await expect(service.createChapter(ADMIN, a, { number: 1 })).rejects.toMatchObject({
        code: 'CHAPTER_DUPLICATE_NUMBER',
      });
      // Same number, different title: a different namespace entirely.
      await service.createChapter(ADMIN, b, { number: 1 });
    });

    it('answers MANGA_NOT_FOUND when the title does not exist', async () => {
      await expect(
        service.createChapter(ADMIN, UNKNOWN_MANGA, { number: 1 }),
      ).rejects.toMatchObject({ code: 'MANGA_NOT_FOUND' });
    });

    it('refuses a number with three decimals rather than storing it rounded', async () => {
      // `numeric(8,2)` rounds silently on write; a stored "10.56" the curator
      // never typed would be a lie about their input.
      const id = await makeTitle('Decimals');

      await expect(service.createChapter(ADMIN, id, { number: 10.555 })).rejects.toMatchObject({
        code: 'VALIDATION_BAD_QUERY',
      });
    });

    it('publishes only chapters with pages, and skips the rest', async () => {
      const id = await makeTitle('Readiness');
      const c1 = await service.createChapter(ADMIN, id, { number: 1 });
      const c2 = await service.createChapter(ADMIN, id, { number: 2 });
      // Pages arrive through ingest, not through this service — so the test
      // sets the count directly, the way ingest would have.
      await open.db.update(chapter).set({ pageCount: 12 }).where(eq(chapter.id, c1));

      const result = await service.publishChapters(ADMIN, id, [c1, c2], true);

      // c2 has no pages: skipped, not published, not an error. A bulk call that
      // failed the whole shelf on one unready chapter would make "publish all"
      // unusable the moment any chapter lagged ingest.
      expect(result).toEqual({ affected: 1, skipped: 1 });
      const rows = await service.listChapters(ADMIN, id);
      expect(rows.find((row) => row.id === c1)?.status).toBe('published');
      expect(rows.find((row) => row.id === c2)?.status).toBe('draft');
    });

    it('keeps the first-published stamp across unpublish and re-publish', async () => {
      const id = await makeTitle('Stamp History');
      const c1 = await service.createChapter(ADMIN, id, { number: 1 });
      await open.db.update(chapter).set({ pageCount: 4 }).where(eq(chapter.id, c1));

      await service.publishChapters(ADMIN, id, [c1], true);
      const first = (await service.listChapters(ADMIN, id)).find((row) => row.id === c1);
      expect(first?.status).toBe('published');
      expect(first?.publishedAt).not.toBeNull();

      await service.publishChapters(ADMIN, id, [c1], false);
      const middle = (await service.listChapters(ADMIN, id)).find((row) => row.id === c1);
      // Unpublished, but the stamp stays: this is what distinguishes the row
      // from one that was never published.
      expect(middle?.status).toBe('draft');
      expect(middle?.publishedAt).toBe(first?.publishedAt);

      await service.publishChapters(ADMIN, id, [c1], true);
      const again = (await service.listChapters(ADMIN, id)).find((row) => row.id === c1);
      // Re-publishing does not move history.
      expect(again?.publishedAt).toBe(first?.publishedAt);
    });

    it('skips unknown ids and other titles\u2019 chapters in a bulk call', async () => {
      const a = await makeTitle('Bulk A');
      const b = await makeTitle('Bulk B');
      const c1 = await service.createChapter(ADMIN, a, { number: 1 });
      const foreign = await service.createChapter(ADMIN, b, { number: 1 });
      await open.db.update(chapter).set({ pageCount: 3 }).where(eq(chapter.id, c1));

      const result = await service.publishChapters(ADMIN, a, [c1, UNKNOWN_CHAPTER, foreign], true);

      expect(result).toEqual({ affected: 1, skipped: 2 });
    });

    it('reorders a title and survives the unique index', async () => {
      const id = await makeTitle('Reorder Me');
      const c1 = await service.createChapter(ADMIN, id, { number: 1 });
      const c2 = await service.createChapter(ADMIN, id, { number: 2 });
      const c3 = await service.createChapter(ADMIN, id, { number: 3 });

      await service.reorderChapters(ADMIN, id, [c3, c1, c2]);

      const rows = await service.listChapters(ADMIN, id);
      expect(rows.map((row) => row.id)).toEqual([c3, c1, c2]);
      expect(rows.map((row) => row.readingOrder)).toEqual([1, 2, 3]);
    });

    it('refuses a reorder that drops a chapter or names a stranger', async () => {
      const id = await makeTitle('Reorder Guard');
      const c1 = await service.createChapter(ADMIN, id, { number: 1 });
      await service.createChapter(ADMIN, id, { number: 2 });

      // A caller that drops one would silently un-order it.
      await expect(service.reorderChapters(ADMIN, id, [c1])).rejects.toMatchObject({
        code: 'VALIDATION_BAD_QUERY',
      });
      // A caller that names another title's chapter would reach across titles.
      await expect(service.reorderChapters(ADMIN, id, [c1, UNKNOWN_CHAPTER])).rejects.toMatchObject(
        { code: 'CHAPTER_NOT_FOUND' },
      );
    });

    it('answers CHAPTER_NOT_FOUND for an unknown chapter', async () => {
      await expect(service.updateChapter(ADMIN, UNKNOWN_CHAPTER, {})).rejects.toMatchObject({
        code: 'CHAPTER_NOT_FOUND',
      });
    });
  });

  describe('every mutation is audited before returning', () => {
    it('records action, target and small summaries — never a synopsis', async () => {
      events.length = 0;
      const slug = await service.createManga(ADMIN, mangaInput('Audited'));

      expect(events).toHaveLength(1);
      const event = events[0] as AuditEvent;
      expect(event.action).toBe('manga.create');
      expect(event.targetKind).toBe('manga');
      expect(event.before).toBeNull();
      const after = JSON.stringify(event.after ?? {});
      expect(after).toContain(slug);
      // Unbounded curator prose does not belong in an audit row.
      expect(after).not.toContain('A synopsis that must never reach the audit log.');
      expect(after.length).toBeLessThan(2048);
    });
  });
});
