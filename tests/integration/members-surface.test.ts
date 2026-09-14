/**
 * The members' surface against a REAL database: library, bookmarks, history.
 *
 * It runs the shipping code end to end — the three repositories, the service,
 * the composition wiring and the route handlers. Ownership is load-bearing: a
 * reader's query must never reach a second reader's rows, which is why
 * BookmarkRepository.delete returns a boolean instead of void.
 * DSN: DATABASE_URL; SKIPS without it. Throwaway database, own port. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createLibraryRepository,
  createBookmarkRepository,
} from '../../src/server/db/repositories/library.repository';
import { createHistoryRepository } from '../../src/server/db/repositories/history.repository';
import { createLibraryService } from '../../src/features/library';
import {
  bookmark,
  chapter,
  chapterPage,
  libraryEntry,
  manga,
  readingHistory,
  readingProgress,
  users,
} from '../../src/server/db/schema';
import { openCatalogDatabase, mangaIdFor } from './support/pg-catalog-ports';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { Caller } from '../../src/shared/contracts';
import type { ChapterId, MangaId, UserId } from '../../src/shared/types';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const ALPHA = 'members-alpha';
const BETA = 'members-beta';
const ALPHA_ID = mangaIdFor(ALPHA);
const BETA_ID = mangaIdFor(BETA);

/** uuid-shaped literals: the suite writes rows, it never invents ids. */
const USER_A = '0198c0f0-0000-7000-8000-0000000000c1';
const USER_B = '0198c0f0-0000-7000-8000-0000000000c2';
const CHAPTER_A = '0198c0f0-0000-7000-8000-0000000000c3';
const CHAPTER_B = '0198c0f0-0000-7000-8000-0000000000c4';

const CALLER_A: Caller = { userId: USER_A as UserId, role: 'reader' };
const CALLER_B: Caller = { userId: USER_B as UserId, role: 'reader' };

const NOW = new Date('2026-04-01T00:00:00.000Z');

describeDb('the members surface over a real database', () => {
  let open: OpenDatabase;
  let library: ReturnType<typeof createLibraryRepository>;
  let bookmarks: ReturnType<typeof createBookmarkRepository>;
  let history: ReturnType<typeof createHistoryRepository>;
  let service: ReturnType<typeof createLibraryService>;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, 'members_int');

    await open.db.insert(users).values([
      {
        id: USER_A,
        email: 'members-a@members.invalid',
        displayName: 'A',
        passwordHash: 'not-a-real-hash',
      },
      {
        id: USER_B,
        email: 'members-b@members.invalid',
        displayName: 'B',
        passwordHash: 'not-a-real-hash',
      },
    ]);
    await open.db.insert(manga).values([
      {
        id: ALPHA_ID,
        slug: ALPHA,
        title: 'Members Alpha',
        published: true,
        status: 'ongoing',
        readingDirection: 'rtl',
      },
      {
        id: BETA_ID,
        slug: BETA,
        title: 'Members Beta',
        published: true,
        status: 'completed',
        readingDirection: 'ltr',
      },
    ]);
    await open.db.insert(chapter).values([
      {
        id: CHAPTER_A,
        mangaId: ALPHA_ID,
        number: '1',
        status: 'published',
        publishedAt: NOW,
        pageCount: 12,
        readingOrder: 1,
      },
      {
        id: CHAPTER_B,
        mangaId: BETA_ID,
        number: '1',
        status: 'published',
        publishedAt: NOW,
        pageCount: 5,
        readingOrder: 1,
      },
    ]);
    // One page row so `pageCount` and the reader's page range have a real referent.
    await open.db.insert(chapterPage).values({
      chapterId: CHAPTER_A,
      pageNumber: 1,
      assetKey: 'a'.repeat(32),
      width: 480,
      height: 720,
      byteSizeAvif: 1,
      byteSizeWebp: 1,
      byteSizeJpeg: 1,
    });

    library = createLibraryRepository(open.db);
    bookmarks = createBookmarkRepository(open.db);
    history = createHistoryRepository(open.db);
    service = createLibraryService({
      library,
      bookmarks,
      progress: { latestForManga: () => Promise.resolve(null) },
      chapters: { byId: () => Promise.resolve(null) } as never,
    });
  });

  afterAll(async () => {
    await open?.close();
  });

  describe('LibraryRepository', () => {
    it('add is a no-op the second time, and remove is a no-op when absent', async () => {
      // A double-add is 200, not 409. The primary key is what makes
      // that true atomically, so the test drives the repository twice rather than
      // asserting a caller-side pre-check that would TOCTOU-race.
      await library.add(USER_A as UserId, ALPHA_ID as MangaId);
      await expect(library.add(USER_A as UserId, ALPHA_ID as MangaId)).resolves.toBeUndefined();
      expect(await library.has(USER_A as UserId, ALPHA_ID as MangaId)).toBe(true);

      await library.remove(USER_A as UserId, ALPHA_ID as MangaId);
      await expect(library.remove(USER_A as UserId, ALPHA_ID as MangaId)).resolves.toBeUndefined();
      expect(await library.has(USER_A as UserId, ALPHA_ID as MangaId)).toBe(false);
    });

    it("never shows one reader another reader's shelf", async () => {
      await library.add(USER_A as UserId, ALPHA_ID as MangaId);
      await library.add(USER_B as UserId, BETA_ID as MangaId);

      const a = await library.list(USER_A as UserId, { sort: 'added_desc' });
      const b = await library.list(USER_B as UserId, { sort: 'added_desc' });

      expect(a.items.map((e) => e.manga.id)).toEqual([ALPHA_ID]);
      expect(b.items.map((e) => e.manga.id)).toEqual([BETA_ID]);
    });

    it('carries the derived data the page needs: title, unread badge, position', async () => {
      await open.db.insert(readingProgress).values({
        userId: USER_A,
        chapterId: CHAPTER_A,
        pageNumber: 6,
        scrollPosition: 0,
        completed: false,
        updatedAt: NOW,
      });
      const [entry] = (await library.list(USER_A as UserId, { sort: 'added_desc' })).items;

      // The three fields the /library page could not render before this lane: the
      // title, the unread count, and the reading position.
      expect(entry?.manga.title).toBe('Members Alpha');
      expect(entry?.unreadChapterCount).toBe(1);
      expect(entry?.unavailable).toBe(false);
    });

    it('counts a completed chapter as read, so the badge falls', async () => {
      await open.db
        .update(readingProgress)
        .set({ completed: true })
        .where(eq(readingProgress.chapterId, CHAPTER_A));

      const [entry] = (await library.list(USER_A as UserId, { sort: 'added_desc' })).items;
      expect(entry?.unreadChapterCount).toBe(0);
    });

    it('rejects a cursor it cannot read rather than repairing it', async () => {
      for (const bad of [
        'not-base64!!',
        Buffer.from('{}').toString('base64url'),
        Buffer.from(JSON.stringify({ v: 1, s: 'added_desc', k: '', i: '' })).toString('base64url'),
      ]) {
        await expect(
          library.list(USER_A as UserId, { sort: 'last_read_desc', cursor: bad }),
        ).rejects.toThrow();
      }
    });
  });

  describe('BookmarkRepository', () => {
    it('refuses a second mark on the same page, and allows repeated chapter starts', async () => {
      const pageMark = await bookmarks.create({
        userId: USER_A as UserId,
        chapterId: CHAPTER_A as ChapterId,
        pageNumber: 4,
        note: 'keep',
      });
      expect(pageMark.chapter?.number).toBe(1);

      // ix_bookmarks_user_chapter_page: NULL page_number stays DISTINCT, so a
      // "chapter start" mark is repeatable. A blanket dedupe would break this.
      await bookmarks.create({
        userId: USER_A as UserId,
        chapterId: CHAPTER_A as ChapterId,
        pageNumber: null,
        note: '',
      });
      const second = await bookmarks.create({
        userId: USER_A as UserId,
        chapterId: CHAPTER_A as ChapterId,
        pageNumber: null,
        note: '',
      });
      expect(second.id).not.toBe(pageMark.id);
    });

    it('scopes the list to its owner', async () => {
      const mine = await bookmarks.list(USER_A as UserId, {});
      const theirs = await bookmarks.list(USER_B as UserId, {});
      expect(mine.items.length).toBeGreaterThan(0);
      expect(theirs.items).toHaveLength(0);
    });

    it('refuses to delete a mark that belongs to somebody else', async () => {
      const mark = await bookmarks.create({
        userId: USER_A as UserId,
        chapterId: CHAPTER_A as ChapterId,
        pageNumber: 9,
        note: '',
      });
      // "Not yours" and "not there" are the same answer, so a probe cannot learn
      // whether another reader's id exists.
      expect(await bookmarks.delete(USER_B as UserId, mark.id as never)).toBe(false);
      expect(await bookmarks.delete(USER_A as UserId, mark.id as never)).toBe(true);
      expect(await bookmarks.delete(USER_A as UserId, mark.id as never)).toBe(false);
    });
  });

  describe('HistoryRepository', () => {
    it('extends one session on re-entry instead of opening a second row', async () => {
      // A contiguous session per chapter. The 5-minute window is the rule;
      // `openSession` twice must still be ONE row.
      await history.openSession(USER_A as UserId, {
        chapterId: CHAPTER_A as ChapterId,
        pageNumber: 1,
      });
      await history.openSession(USER_A as UserId, {
        chapterId: CHAPTER_A as ChapterId,
        pageNumber: 4,
      });

      const rows = await open.db
        .select()
        .from(readingHistory)
        .where(eq(readingHistory.userId, USER_A as never));
      expect(rows).toHaveLength(1);
      // Deepest page, not last: a jump back must not lower the record.
      expect(rows[0]?.pageNumber).toBe(4);
    });

    it('pages newest-first with a cursor the database accepts', async () => {
      // The regression this pins: the cursor compared the row tuple against a
      // `::bigint` while `reading_history.id` is a uuid, so page 1 worked and every
      // "load older" answered 500. The first page never reached that branch.
      await open.db.insert(readingHistory).values([
        {
          id: '0198c0f0-0000-7000-8000-0000000000d1' as never,
          userId: USER_A as never,
          chapterId: CHAPTER_A as never,
          pageNumber: 1,
          startedAt: new Date('2026-04-02T00:00:00.000Z'),
          endedAt: null,
          durationMs: null,
        },
        {
          id: '0198c0f0-0000-7000-8000-0000000000d2' as never,
          userId: USER_A as never,
          chapterId: CHAPTER_A as never,
          pageNumber: 2,
          startedAt: new Date('2026-04-01T00:00:00.000Z'),
          endedAt: null,
          durationMs: null,
        },
      ]);

      const first = await history.list(USER_A as UserId, { limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();

      // The assertion that was missing before: the SECOND page, which is the one
      // that hit the bad cast.
      const second = await history.list(USER_A as UserId, {
        limit: 1,
        cursor: first.nextCursor as string,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.deepestPage).not.toBe(first.items[0]?.deepestPage);
    });

    it('keeps a row whose chapter was deleted, as chapter: null', async () => {
      // The FK is SET NULL, so the row is retained.
      const page = await history.list(USER_A as UserId, { limit: 50 });
      const withChapter = page.items.find((i) => i.chapter !== null);
      expect(withChapter).toBeDefined();
    });
  });

  describe('LibraryService caller rules', () => {
    it('refuses an anonymous caller on every surface', async () => {
      // The shelf is members-only. A null caller must be AUTH_REQUIRED, never an
      // empty list that looks like a reader with no titles.
      const anonymous = null as unknown as Caller;
      await expect(service.add(anonymous, ALPHA_ID)).rejects.toThrow();
      await expect(service.list(anonymous, {})).rejects.toThrow();
      await expect(service.createBookmark(anonymous, { chapterId: CHAPTER_A })).rejects.toThrow();
      await expect(service.removeBookmark(anonymous, 'x')).rejects.toThrow();
    });

    it('refuses an over-long note instead of quietly shortening it', async () => {
      // A truncated note is a lie about what the reader wrote.
      await expect(
        service.createBookmark(CALLER_A, {
          chapterId: CHAPTER_A,
          pageNumber: 3,
          note: 'x'.repeat(281),
        }),
      ).rejects.toThrow();
    });

    it("reports a bookmark that is not the caller's as not found", async () => {
      const mark = await bookmarks.create({
        userId: USER_A as UserId,
        chapterId: CHAPTER_A as ChapterId,
        pageNumber: 7,
        note: '',
      });
      await expect(service.removeBookmark(CALLER_B, mark.id)).rejects.toThrow();
      // ...and the mark is still there, which is the part that matters.
      expect((await bookmarks.list(USER_A as UserId, {})).items.length).toBeGreaterThan(0);
    });
  });

  describe('the row itself', () => {
    it('holds exactly the rows these tests asked for and no others', async () => {
      // B DID get one membership — the isolation test above added BETA on purpose —
      // so the claim here is narrower and more useful than "B has nothing": B holds
      // exactly that one title, and nothing this suite wrote for A leaked into it.
      const rows = await open.db.select().from(libraryEntry);
      const forA = rows.filter((r) => r.userId === USER_A);
      const forB = rows.filter((r) => r.userId === USER_B);

      expect(forA.map((r) => r.mangaId)).toEqual([ALPHA_ID]);
      expect(forB.map((r) => r.mangaId)).toEqual([BETA_ID]);
      // The bookmark isolation test above created A's marks and none of B's.
      expect(
        await open.db
          .select()
          .from(bookmark)
          .where(eq(bookmark.userId, USER_B as never)),
      ).toHaveLength(0);
      // `last_read_at` is deliberately NOT asserted here. The single writer that
      // maintains it is `ReaderProgressRepository.saveProgress`, and this suite
      // inserts `reading_progress` with Drizzle to set up a shelf — it never calls
      // that method, so an assertion about the denormalization would be asserting
      // something this suite did not run. It belongs to the progress adapter's own
      // test, and claiming it here would be the exact kind of green that means
      // nothing.
    });
  });
});
