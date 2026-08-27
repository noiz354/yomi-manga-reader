/**
 * Integration tests — ChapterRepository against a REAL PostgreSQL 18.
 *
 * Chapter order (decimals like 10.5, tiebreak by reading_order, drafts
 * excluded for non-admin), atomic `commitPages`, the manga visibility rule on
 * chapter reads, and index-backed hot paths (asserted via EXPLAIN).
 *
 * DSN: `DATABASE_URL`. SKIPS when absent:
 *   DATABASE_URL=postgres://yomi:yomi@127.0.0.1:55440/yomi \
 *     npx vitest run tests/integration/catalog.chapter.repository.test.ts
 *
 * SAFETY: `beforeEach` TRUNCATEs every table — point this suite at a THROWAWAY
 * database (see the note in catalog.db-harness.ts about the single fork).
 *
 * No product content: every title, chapter title and note is generated test
 * data (generated test data only).
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildChapterListQuery,
  buildChapterPagesQuery,
  createChapterRepository,
  createMangaRepository,
} from '../../src/server/db/repositories/index';
import type { ChapterRepository } from '../../src/features/chapters';
import type { CallerContext } from '../../src/shared/contracts';
import { AppError } from '../../src/shared/contracts/errors';
import type { ChapterId, MangaId, UserId } from '../../src/shared/types';
import { describeDb, explain, openHarness, type Harness } from './catalog.db-harness';

const ADMIN: CallerContext = {
  userId: '01930000-0000-7000-8000-0000000000ad' as UserId,
  role: 'admin',
};
const READER: CallerContext = {
  userId: '01930000-0000-7000-8000-0000000000ad' as UserId,
  role: 'reader',
};

describeDb('INT-CHAP-001 / T-CATALOG-001 — ChapterRepository on a real PostgreSQL 18', () => {
  let harness: Harness;
  let chapters: ChapterRepository;
  let manga: ReturnType<typeof createMangaRepository>;
  let mangaId: MangaId;
  let counter = 0;

/** One synthetic page record. */
  const page = (pageNumber: number) => ({
    pageNumber,
    assetKey: `seed/v1/page/${counter.toString().padStart(6, '0')}${pageNumber}`,
    width: 480,
    height: 720,
    byteSizeAvif: 1_024,
    byteSizeWebp: 2_048,
    byteSizeJpeg: 4_096,
  });

  beforeAll(async () => {
    harness = await openHarness('chapter');
    chapters = createChapterRepository(harness.db);
    manga = createMangaRepository(harness.db);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    counter = 0;
    mangaId = await createManga(harness, { published: true, slug: 'fixture-manga' });
  });

  /* ── listByManga: order, visibility, zero chapters ─────────────────────── */

  describe('listByManga() (FR-CATALOG-007, FR-CHAPTER-002, FR-CHAPTER-004)', () => {
    it('orders by reading_order, not by insertion, and stays deterministic', async () => {
      // Created out of order on purpose: the port's documented order is
      // `reading_order`, which the repository assigns in creation order.
      const third = await chapters.create({ mangaId, number: 3, title: 'third', notes: '' });
      const first = await chapters.create({ mangaId, number: 1, title: 'first', notes: '' });
      const second = await chapters.create({ mangaId, number: 2, title: 'second', notes: '' });

      const list = await chapters.listByManga(mangaId, ADMIN);
      expect(list.map((c) => c.id)).toEqual([first, second, third]);
      expect(list.map((c) => c.number)).toEqual([1, 2, 3]);
    });

    it('accepts a decimal number such as 10.5 and reads it back exactly (DATA_MODEL §9)', async () => {
      const special = await chapters.create({ mangaId, number: 10.5, title: 'special', notes: '' });
      const found = (await chapters.listByManga(mangaId, ADMIN)).find((c) => c.id === special);
      expect(found?.number).toBe(10.5);
    });

    it('excludes drafts and soft-deleted chapters for a non-admin (FR-CHAPTER-002)', async () => {
      const published = await chapters.create({ mangaId, number: 1, title: 'pub', notes: '' });
      await chapters.setPublished(published, true);
      await chapters.create({ mangaId, number: 2, title: 'draft', notes: '' });
      const removed = await chapters.create({ mangaId, number: 3, title: 'removed', notes: '' });
      await chapters.setPublished(removed, true);
      await chapters.softDelete(removed);

      const list = await chapters.listByManga(mangaId, READER);
      expect(list.map((c) => c.id)).toEqual([published]);
    });

    it('includes drafts for an admin, but never a soft-deleted chapter', async () => {
      const published = await chapters.create({ mangaId, number: 1, title: 'pub', notes: '' });
      await chapters.setPublished(published, true);
      const draft = await chapters.create({ mangaId, number: 2, title: 'draft', notes: '' });
      const removed = await chapters.create({ mangaId, number: 3, title: 'removed', notes: '' });
      await chapters.setPublished(removed, true);
      await chapters.softDelete(removed);

      const list = await chapters.listByManga(mangaId, ADMIN);
      expect([...list.map((c) => c.id)].sort()).toEqual([published, draft].sort());
    });

    it('is empty for a manga with no chapters at all (T-CATALOG-001 edge case)', async () => {
      expect(await chapters.listByManga(mangaId, ADMIN)).toEqual([]);
      expect(await chapters.listByManga(mangaId, null)).toEqual([]);
    });

    it('is empty for a non-visible manga, even for published chapters (FR-CHAPTER-002)', async () => {
      const draftManga = await createManga(harness, { published: false, slug: 'draft-manga' });
      const chapter = await chapters.create({ mangaId: draftManga, number: 1, title: 'x', notes: '' });
      await chapters.setPublished(chapter, true);
      expect(await chapters.listByManga(draftManga, null)).toEqual([]);
      expect(await chapters.listByManga(draftManga, READER)).toEqual([]);
      // …and the admin still sees it (FR-ADMIN-001).
      expect((await chapters.listByManga(draftManga, ADMIN)).map((c) => c.id)).toEqual([chapter]);
    });

    it('is empty for a soft-deleted manga for EVERYONE (FR-ADMIN-003)', async () => {
      const removed = await createManga(harness, {
        published: true,
        deleted: false,
        slug: 'removed-manga',
      });
      const chapter = await chapters.create({ mangaId: removed, number: 1, title: 'x', notes: '' });
      await chapters.setPublished(chapter, true);
      // Delete the PARENT afterwards: `chapter.create` legitimately refuses a
      // soft-deleted manga, so the chapter has to exist first for this state to
      // be reachable at all.
      await manga.softDelete(removed);
      expect(await chapters.listByManga(removed, null)).toEqual([]);
      expect(await chapters.listByManga(removed, ADMIN)).toEqual([]);
    });

    it('carries the denormalized pageCount and the publish stamp (NFR-PERF-014)', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.commitPages({ chapterId: id, pages: [page(1), page(2), page(3)], replace: false });
      const draft = (await chapters.listByManga(mangaId, ADMIN)).find((c) => c.id === id);
      expect(draft?.pageCount).toBe(3);
      expect(draft?.publishedAt).toBeNull();
      await chapters.setPublished(id, true);
      const published = (await chapters.listByManga(mangaId, null)).find((c) => c.id === id);
      expect(published?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  /* ── byId ──────────────────────────────────────────────────────────────── */

  describe('byId()', () => {
    it('returns a published chapter of a visible manga to an anonymous caller', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.setPublished(id, true);
      expect((await chapters.byId(id, null))?.id).toBe(id);
    });

    it('is null for a draft to a non-admin, and NOT null for an admin', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      expect(await chapters.byId(id, null)).toBeNull();
      expect(await chapters.byId(id, READER)).toBeNull();
      expect((await chapters.byId(id, ADMIN))?.id).toBe(id);
    });

    it('is null for a soft-deleted chapter and for an unknown id', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.setPublished(id, true);
      await chapters.softDelete(id);
      expect(await chapters.byId(id, null)).toBeNull();
      expect(await chapters.byId(id, ADMIN)).toBeNull();
      expect(
        await chapters.byId('01930000-0000-7000-8000-00000000ffff' as ChapterId, ADMIN),
      ).toBeNull();
    });
  });

  /* ── pageList: ordered pages + published neighbours (FR-READER-016) ────── */

  describe('pageList()', () => {
    it('returns pages in ascending pageNumber with app-relative variant URLs (FR-MEDIA-002)', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.commitPages({
        chapterId: id,
        pages: [page(3), page(1), page(2)],
        replace: false,
      });
      await chapters.setPublished(id, true);

      const response = await chapters.pageList(id, null);
      expect(response?.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
      expect(response?.pages[0]?.urlAvif).toBe(response?.pages[0]?.urlWebp);
      expect(response?.pages[0]?.urlAvif).toMatch(/^\/media\/seed\/v1\/page\//);
      expect(response?.pages[0]?.width).toBe(480);
      expect(response?.chapter.pageCount).toBe(3);
      expect(response?.chapter.readingDirection).toBe('rtl');
      expect(response?.chapter.title).toBe('one');
    });

    it('resolves prev/next by reading_order, published only for a non-admin (FR-READER-016)', async () => {
      const one = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      const two = await chapters.create({ mangaId, number: 2, title: 'two', notes: '' });
      const three = await chapters.create({ mangaId, number: 3, title: 'three', notes: '' });
      const four = await chapters.create({ mangaId, number: 4, title: 'four', notes: '' });
      for (const id of [one, two, three, four]) await chapters.setPublished(id, true);
      // A draft sits between `two` and `three` and must never become a
      // neighbour for a reader.
      await chapters.create({ mangaId, number: 2.5, title: 'draft interlude', notes: '' });

      const middle = await chapters.pageList(three, null);
      expect(middle?.prevChapter?.number).toBe(2);
      expect(middle?.prevChapter?.title).toBe('two');
      expect(middle?.nextChapter?.number).toBe(4);

      expect((await chapters.pageList(one, null))?.prevChapter).toBeNull();
      expect((await chapters.pageList(four, null))?.nextChapter).toBeNull();

      // For an admin the draft IS a legal neighbour — and because
      // `reading_order` is derived from the number, 2.5 sorts AFTER 2, so the
      // nearest chapter above `three` is still `four`. (The order probe in
      // tests/integration/support/pg-catalog-ports.ts is where a deliberately
      // disagreeing `reading_order` is exercised.)
      const adminMiddle = await chapters.pageList(three, ADMIN);
      expect(adminMiddle?.nextChapter?.number).toBe(4);
      const adminSecond = await chapters.pageList(two, ADMIN);
      expect(adminSecond?.nextChapter?.number).toBe(2.5);
    });

    it('carries the manga slug/title so the reader can build the neighbour URL', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.setPublished(id, true);
      const response = await chapters.pageList(id, null);
      expect(response?.chapter.mangaSlug).toBe('fixture-manga');
      expect(response?.chapter.mangaTitle).toBe('Fixture Manga');
    });

    it('is null for a chapter the caller may not read', async () => {
      const draft = await chapters.create({ mangaId, number: 1, title: 'draft', notes: '' });
      expect(await chapters.pageList(draft, null)).toBeNull();
      expect(await chapters.pageList(draft, READER)).toBeNull();
      const removed = await chapters.create({ mangaId, number: 2, title: 'removed', notes: '' });
      await chapters.setPublished(removed, true);
      await chapters.softDelete(removed);
      expect(await chapters.pageList(removed, ADMIN)).toBeNull();
    });
  });

  /* ── pageRecords: the server-side view ─────────────────────────────────── */

  describe('pageRecords()', () => {
    it('returns the raw storage records in ascending page order with the byte record (NFR-PERF-009)', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      const records = [page(1), page(2)];
      await chapters.commitPages({ chapterId: id, pages: records, replace: false });
      const rows = await chapters.pageRecords(id);
      expect(rows.map((r) => r.pageNumber)).toEqual([1, 2]);
      expect(rows[0]?.chapterId).toBe(id);
      expect(rows[0]?.assetKey).toBe(records[0]?.assetKey);
      expect(rows[0]?.byteSizeAvif).toBe(1_024);
      // DATA_MODEL §10 has no surrogate `id`; the composite PK is rendered as a
      // string so the DTO stays total (see the implementation header).
      expect(rows[0]?.id).toBe(`${id}:1`);
    });

    it('is empty for a chapter with no pages', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      expect(await chapters.pageRecords(id)).toEqual([]);
    });
  });

  /* ── writes ────────────────────────────────────────────────────────────── */

  describe('create / update / softDelete / setPublished', () => {
    it('derives reading_order from the chapter number, so insertion order is irrelevant (FR-CHAPTER-004)', async () => {
      // Inserted DESCENDING by number on purpose: the list must still come back
      // in number order, because `reading_order` — not creation time — is the
      // order key.
      const ids: ChapterId[] = [];
      for (const number of [3, 1, 2]) {
        ids.push(await chapters.create({ mangaId, number, title: `c${number}`, notes: '' }));
      }
      const orders = await harness.sql<{ reading_order: number }[]>`
        select reading_order from chapter where manga_id = ${mangaId} order by reading_order
      `;
      // ×100 of the number: injective for numeric(8,2), so 10 and 10.5 can
      // never collide on the UNIQUE index.
      expect(orders.map((o) => o.reading_order)).toEqual([100, 200, 300]);
      const list = await chapters.listByManga(mangaId, ADMIN);
      expect(list.map((c) => c.number)).toEqual([1, 2, 3]);
      // created 3, 1, 2 → the list must come back 1, 2, 3.
      expect(list.map((c) => c.id)).toEqual([ids[1], ids[2], ids[0]]);
    });

    it('keeps a fractional chapter orderable beside its integer neighbours (10.5)', async () => {
      const ten = await chapters.create({ mangaId, number: 10, title: 'ten', notes: '' });
      const half = await chapters.create({ mangaId, number: 10.5, title: 'ten and a half', notes: '' });
      const eleven = await chapters.create({ mangaId, number: 11, title: 'eleven', notes: '' });
      const list = await chapters.listByManga(mangaId, ADMIN);
      expect(list.map((c) => c.id)).toEqual([ten, half, eleven]);
      expect(list.map((c) => c.number)).toEqual([10, 10.5, 11]);
    });

    it('create() rejects a duplicate (manga, number) with CHAPTER_DUPLICATE_NUMBER (FR-CHAPTER-001)', async () => {
      await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await expect(
        chapters.create({ mangaId, number: 1, title: 'again', notes: '' }),
      ).rejects.toThrowError(/^A chapter with this number exists\.$/);
    });

    it('update() applies number/title/notes and a rejected duplicate changes nothing', async () => {
      const one = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.create({ mangaId, number: 2, title: 'two', notes: '' });
      await chapters.update(one, { title: 'renamed', notes: 'a note' });
      expect((await chapters.byId(one, ADMIN))?.title).toBe('renamed');
      await expect(chapters.update(one, { number: 2 })).rejects.toThrowError(
        /^A chapter with this number exists\.$/,
      );
      // A refused update must not have half-applied the patch.
      expect((await chapters.byId(one, ADMIN))?.title).toBe('renamed');
    });

    it('softDelete() is idempotent and hides the chapter from everyone', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.setPublished(id, true);
      await chapters.softDelete(id);
      const first = await deletedAtOf(harness, id);
      expect(first).toBeInstanceOf(Date);
      await chapters.softDelete(id);
      expect(await deletedAtOf(harness, id)).toEqual(first);
      expect(await chapters.byId(id, ADMIN)).toBeNull();
      expect(await chapters.countByManga(mangaId)).toBe(0);
    });

    it('setPublished() stamps published_at on the way up and clears it on the way down', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.setPublished(id, true);
      expect(await publishedAtOf(harness, id)).toBeInstanceOf(Date);
      await chapters.setPublished(id, false);
      expect(await publishedAtOf(harness, id)).toBeNull();
    });
  });

  /* ── commitPages: the atomic upload commit (FR-UPLOAD-006) ─────────────── */

  describe('commitPages()', () => {
    it('writes the full 1..N set and page_count in ONE transaction', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.commitPages({ chapterId: id, pages: [page(1), page(2), page(3)], replace: false });
      expect((await chapters.pageRecords(id)).map((r) => r.pageNumber)).toEqual([1, 2, 3]);
      expect((await chapters.listByManga(mangaId, ADMIN)).find((c) => c.id === id)?.pageCount).toBe(3);
    });

    it('refuses a non-contiguous page set and writes NOTHING (DATA_MODEL §21.2)', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await expect(
        chapters.commitPages({ chapterId: id, pages: [page(1), page(3)], replace: false }),
      ).rejects.toThrowError(/^This chapter isn't available yet\.$/);
      expect(await chapters.pageRecords(id)).toEqual([]);
      expect((await chapters.listByManga(mangaId, ADMIN)).find((c) => c.id === id)?.pageCount).toBe(0);
    });

    it('refuses a page set that does not start at 1', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await expect(
        chapters.commitPages({ chapterId: id, pages: [page(2)], replace: false }),
      ).rejects.toThrowError(AppError);
    });

    it('refuses an empty page set', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await expect(
        chapters.commitPages({ chapterId: id, pages: [], replace: false }),
      ).rejects.toThrowError(AppError);
    });

    it('replaces the whole set on re-ingest and returns the OLD asset keys (FR-UPLOAD-009)', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      const first = [page(1), page(2)];
      await chapters.commitPages({ chapterId: id, pages: first, replace: false });

      const second = [page(1), page(2), page(3)];
      const outcome = await chapters.commitPages({ chapterId: id, pages: second, replace: true });
      expect([...outcome.replacedAssetKeys].sort()).toEqual(first.map((p) => p.assetKey).sort());
      const rows = await chapters.pageRecords(id);
      expect(rows.map((r) => r.pageNumber)).toEqual([1, 2, 3]);
      expect(rows.map((r) => r.assetKey)).toEqual(second.map((p) => p.assetKey));
      expect((await chapters.listByManga(mangaId, ADMIN)).find((c) => c.id === id)?.pageCount).toBe(3);
    });

    it('returns no old keys when there was nothing to replace', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      const outcome = await chapters.commitPages({
        chapterId: id,
        pages: [page(1)],
        replace: true,
      });
      expect(outcome.replacedAssetKeys).toEqual([]);
    });

    it('refuses to commit into a soft-deleted MANGA (the manga-deleted race)', async () => {
      const id = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await manga.softDelete(mangaId);
      await expect(
        chapters.commitPages({ chapterId: id, pages: [page(1)], replace: false }),
      ).rejects.toThrowError(/^Manga not found\.$/);
      expect(await chapters.pageRecords(id)).toEqual([]);
    });

    it('refuses to commit into a chapter that does not exist', async () => {
      await expect(
        chapters.commitPages({
          chapterId: '01930000-0000-7000-8000-00000000beef' as ChapterId,
          pages: [page(1)],
          replace: false,
        }),
      ).rejects.toThrowError(/^Chapter not found\.$/);
    });
  });

  /* ── counts ────────────────────────────────────────────────────────────── */

  describe('counts (FR-ADMIN-008)', () => {
    it('countByManga counts only chapters a reader may see', async () => {
      const published = await chapters.create({ mangaId, number: 1, title: 'a', notes: '' });
      await chapters.setPublished(published, true);
      await chapters.create({ mangaId, number: 2, title: 'b', notes: '' });
      expect(await chapters.countByManga(mangaId)).toBe(1);
    });

    it('countAll and countPages see every row, soft-deleted included', async () => {
      const one = await chapters.create({ mangaId, number: 1, title: 'a', notes: '' });
      const two = await chapters.create({ mangaId, number: 2, title: 'b', notes: '' });
      await chapters.commitPages({ chapterId: one, pages: [page(1), page(2)], replace: false });
      await chapters.softDelete(two);
      expect(await chapters.countAll()).toBe(2);
      expect(await chapters.countPages()).toBe(2);
    });
  });

  /* ── NFR-SEC-015 ───────────────────────────────────────────────────────── */

  describe('queries are parameterised', () => {
    it('a SQL payload in a chapter title is inert data', async () => {
      const payload = "'; drop table chapter; --";
      const id = await chapters.create({ mangaId, number: 1, title: payload, notes: payload });
      await chapters.setPublished(id, true);
      expect((await chapters.byId(id, null))?.title).toBe(payload);
      expect((await chapters.listByManga(mangaId, null))[0]?.title).toBe(payload);
      expect((await harness.sql`select count(*)::int as n from chapter`)[0]?.n).toBe(1);
    });
  });

  /* ── the EXPLAIN gate: ix_chapters_manga_order + the chapter_page PK ───── */

  describe('hot queries use indexes (EXPLAIN gate)', () => {
    it('the chapter list is index-backed, never a seq scan of chapter', async () => {
      // 20 manga × 100 chapters = 2 000 rows, so the planner must prefer the
      // (manga_id, reading_order) index over scanning the whole table.
      const ids: MangaId[] = [];
      for (let index = 0; index < 20; index += 1) {
        ids.push(
          await createManga(harness, { published: true, slug: `corpus-manga-${index}` }),
        );
      }
      for (const id of ids) {
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (let order = 1; order <= 100; order += 1) {
          values.push(id, order.toFixed(2), order);
          const p = values.length;
          tuples.push(`($${p - 2}, $${p - 1}, 'Generated chapter', '', 'published', $${p})`);
        }
        await harness.sql.unsafe(
          `insert into chapter (manga_id, number, title, notes, status, reading_order)
           values ${tuples.join(', ')}`,
          values as never[],
        );
      }
      // The bulk insert leaves the planner's statistics stale, and a stale
      // `manga_id` histogram makes PostgreSQL pick the wrong chapter index (it
      // believes one manga owns one row). A seeded database is analyzed, so the
      // gate analyzes too — otherwise it would measure the fixture, not the
      // query.
      await harness.sql`analyze chapter`;

      const listPlan = await explain(harness.sql, buildChapterListQuery(harness.db, ids[0] as MangaId, null));
      expect(listPlan).not.toMatch(/Seq Scan on chapter/);
      expect(listPlan).toContain('ix_chapters_manga_order');

      // The page list (T-READER-002; reader-behavior §15's 500-page case).
      //
      // The corpus has to be big enough that a sequential scan is genuinely the
      // WRONG plan, or the assertion below would be asserting a falsehood: with
      // a few thousand page rows in the table, reading 500 of them under
      // `random_page_cost = 4` really IS cheaper to scan and sort, and no index
      // can change that. DATA_MODEL §20's reference scale is 5 000 000 pages, so
      // this builds ~4 % of it — every one of the 2 000 chapters gets 100 pages
      // and the first chapter of each manga gets the full 500 (the deep-link
      // case). A seq scan of 208 000 rows per page request is exactly what the
      // gate forbids.
      //
      // `ix_pages_asset_key` is UNIQUE (FR-MEDIA-003: an unguessable key never
      // names two pages), so the generated key carries the chapter id.
      // One statement to learn every corpus chapter, in reading order, so the
      // fixture does not make 2 000 round trips of its own.
      const corpus = await harness.sql<{ id: string; manga_id: string; reading_order: number }[]>`
        select id, manga_id, reading_order from chapter
        where manga_id = any(${ids.map((id) => id as string)})
        order by manga_id, reading_order
      `;
      const deepChapterIds: ChapterId[] = [];
      const seen = new Set<string>();
      for (const row of corpus) {
        if (!seen.has(row.manga_id)) {
          seen.add(row.manga_id);
          deepChapterIds.push(row.id as ChapterId);
        }
      }
      expect(deepChapterIds).toHaveLength(20);

      // Two statements per manga: the deep chapter's 500 pages, then 100 pages
      // for each of its other 99 chapters.
      let pageRows = 0;
      for (const [position, mangaId] of ids.entries()) {
        const deep = deepChapterIds[position] as ChapterId;
        await harness.sql`
          insert into chapter_page (chapter_id, page_number, asset_key, width, height)
          select ${deep}, n, 'corpus/v1/page/' || ${deep}::text || '/' || n::text, 480, 720
          from generate_series(1, 500) as n
        `;
        pageRows += 500;
        await harness.sql`
          insert into chapter_page (chapter_id, page_number, asset_key, width, height)
          select c.id, n, 'corpus/v1/page/' || c.id::text || '/' || n::text, 480, 720
          from chapter c
          cross join generate_series(1, 100) as n
          where c.manga_id = ${mangaId} and c.id <> ${deep}
        `;
        pageRows += 99 * 100;
      }
      await harness.sql`analyze chapter_page`;
      expect(pageRows).toBe(20 * 500 + 1_980 * 100);

      const chapterId = deepChapterIds[0] as ChapterId;
      const deepPages = await chapters.pageList(chapterId, ADMIN);
      expect(deepPages?.pages).toHaveLength(500);

      const pagePlan = await explain(harness.sql, buildChapterPagesQuery(harness.db, chapterId));
      expect(pagePlan).not.toMatch(/Seq Scan on chapter_page/);
      // Which INDEX SCAN SHAPE PostgreSQL picks (a plain ordered range scan vs a
      // bitmap heap scan plus a sort) is its cost decision at this table size, so
      // the gate asserts the index that is named in DATA_MODEL §10 and the
      // absence of a sequential scan — not the node type, which would make the
      // gate a hostage to the planner.
      expect(pagePlan).toContain('chapter_page_chapter_id_page_number_pk');
    });
  });
});

/* ── fixture writers (generated test data only) ─────────── */

async function createManga(
  harness: Harness,
  input: { published: boolean; deleted?: boolean; slug: string },
): Promise<MangaId> {
  const rows = await harness.sql<{ id: string }[]>`
    insert into manga (slug, title, synopsis, status, reading_direction, published, deleted_at)
    values (
      ${input.slug}::text,
      'Fixture Manga',
      'Generated synopsis.',
      'ongoing',
      'rtl',
      ${input.published},
      case when ${input.deleted ?? false} then now() else null end
    )
    returning id
  `;
  const id = rows[0]?.id as MangaId | undefined;
  if (id === undefined) throw new Error('fixture insert returned no row');
  return id;
}

async function deletedAtOf(harness: Harness, id: ChapterId): Promise<Date | null> {
  const rows = await harness.sql<{ deleted_at: Date | null }[]>`
    select deleted_at from chapter where id = ${id}
  `;
  return rows[0]?.deleted_at ?? null;
}

async function publishedAtOf(harness: Harness, id: ChapterId): Promise<Date | null> {
  const rows = await harness.sql<{ published_at: Date | null }[]>`
    select published_at from chapter where id = ${id}
  `;
  return rows[0]?.published_at ?? null;
}
