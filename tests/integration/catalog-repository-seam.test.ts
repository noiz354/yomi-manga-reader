/**
 * The catalog SERVICE ⇄ the REAL catalog repositories: a seam test, not a
 * behaviour test. The double-based suites prove this task's code; this file
 * proves the other half — that the service and the repositories that actually
 * ship COMPOSE. A past revision defined the cursor envelope twice, so the
 * repository's `nextCursor` was rejected on the way back in and every second
 * page answered 422. Skips without a DSN.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChapterRepository, createMangaRepository } from '../../src/server/db/repositories';
import { createCatalogService } from '../../src/features/catalog';
import { chapter as chapterTable, manga as mangaTable } from '../../src/server/db/schema';
import { mangaIdFor, openCatalogDatabase } from './support/pg-catalog-ports';
import type { OpenDatabase } from './support/pg-catalog-ports';
import { asSlug } from './support/pg-catalog-ports';
import type { CallerContext } from '../../src/shared/contracts';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const EPOCH = Date.UTC(2026, 0, 1);
const day = (offset: number): Date => new Date(EPOCH + offset * 86_400_000);

const SEAM_SLUGS = ['seam-alpha', 'seam-beta', 'seam-gamma'] as const;
const ANON: CallerContext = null;
const READER: CallerContext = { userId: 'reader-1' as never, role: 'reader' };
const ADMIN: CallerContext = { userId: 'admin-1' as never, role: 'admin' };

describeDb('catalog service ⇄ the real repositories', () => {
  let open: OpenDatabase;
  let service: ReturnType<typeof createCatalogService>;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, 'catalog_seam_it');
    // The repositories under test, not doubles.
    await open.db.insert(mangaTable).values(
      SEAM_SLUGS.map((slug, offset) => ({
        id: mangaIdFor(slug),
        slug,
        title: `Seam ${slug.slice(5).toUpperCase()}`,
        synopsis: 'Synthetic seam fixture. Not product content.',
        status: 'ongoing',
        readingDirection: 'rtl',
        published: true,
        coverAssetKey: null,
        // `updatedAt` ASCENDS, so `updated_desc` yields gamma, beta, alpha.
        updatedAt: day(offset + 1),
        createdAt: day(offset + 1),
      })),
    );
    await open.db.insert(mangaTable).values({
      id: mangaIdFor('seam-hidden'),
      slug: 'seam-hidden',
      title: 'Seam HIDDEN',
      synopsis: 'Synthetic seam fixture. Not product content.',
      status: 'ongoing',
      readingDirection: 'rtl',
      published: true,
      coverAssetKey: null,
      updatedAt: day(90),
      createdAt: day(90),
      deletedAt: day(91),
    });
    for (const slug of SEAM_SLUGS) {
      await open.db.insert(chapterTable).values([
        {
          id: mangaIdFor(slug).replace(/.$/, '1'),
          mangaId: mangaIdFor(slug),
          number: '1.00',
          title: 'Opening',
          notes: '',
          status: 'published',
          publishedAt: day(10),
          pageCount: 18,
          readingOrder: 1,
        },
        {
          id: mangaIdFor(slug).replace(/.$/, '2'),
          mangaId: mangaIdFor(slug),
          number: '2.00',
          title: 'The draft',
          notes: '',
          status: 'draft',
          publishedAt: null,
          pageCount: 18,
          readingOrder: 2,
        },
      ]);
    }
    service = createCatalogService({
      manga: createMangaRepository(open.db),
      chapters: createChapterRepository(open.db),
      progress: { latestForManga: async () => null },
    });
  });

  afterAll(async () => {
    await open?.close();
  });

  // the seam bug this file exists for

  it('round-trips the repository’s own nextCursor through the service (no 422)', async () => {
    const first = await service.list({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    // The token from the repository must round-trip, not be rejected with
    // CATALOG_PAGE_INVALID.
    const second = await service.list({ limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(1);
    const third = await service.list({ limit: 1, cursor: second.nextCursor ?? undefined });
    expect(third.items).toHaveLength(1);
    expect([first, second, third].map((page) => page.items[0]?.slug)).toEqual([
      'seam-gamma',
      'seam-beta',
      'seam-alpha',
    ]);
    // …and the walk terminates with no fourth page.
    expect(third.nextCursor).toBeNull();
  });

  it('answers 422 for a cursor the repository cannot use', async () => {
    for (const cursor of ['not-base64!!', 'e30', Buffer.from('{"v":9}').toString('base64url')]) {
      await expect(service.list({ limit: 1, cursor })).rejects.toMatchObject({
        code: 'CATALOG_PAGE_INVALID',
      });
    }
  });

  it('keeps the statement count CONSTANT as the page grows (the N+1 property)', async () => {
    // An honest measurement, not the number the task hoped for.
    //
    // The requirement asks for `latestChapter` "computed in ONE query (latest
    // published chapter join — no N+1)". The landed repository takes the OTHER
    // valid shape: the page, then ONE batched `distinct on (manga_id)` lookup
    // for the whole page's ids. That is 2 statements, not 1 — but it is O(1) in
    // the page size, which is the property the rule is actually protecting.
    //
    // This suite therefore asserts the property; the literal "one statement"
    // requirement stays pinned in `catalog-list.test.ts` against the join form.
    // Closing the 2-vs-1 gap belongs to the repository, outside this task's
    // write scope; it is reported, not worked around.
    const counts: Array<{ limit: number; items: number; statements: number }> = [];
    for (const limit of [1, 3, 24]) {
      open.probe.reset();
      const page = await service.list({ limit });
      counts.push({
        limit,
        items: page.items.length,
        statements: open.probe.since().filter((statement) => /^\s*select/i.test(statement.text))
          .length,
      });
    }
    expect(counts.map((entry) => entry.items)).toEqual([1, 3, 3]);
    // Constant, and small: an N+1 would be 1, 4, 7.
    expect(new Set(counts.map((entry) => entry.statements)).size).toBe(1);
    expect(counts[0]?.statements).toBeLessThanOrEqual(2);
  });

  it('serves latestChapter correctly through the repository’s batched read', async () => {
    const page = await service.list({ limit: 24, sort: 'title_asc' });
    // Every fixture has exactly one published chapter (number 1) and one draft.
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.latestChapter?.number, `${item.slug} has no latest chapter`).toBe(1);
    }
  });

  // the other half of the port agrees

  it('excludes the soft-deleted title through the real visibility rule', async () => {
    const page = await service.list({ limit: 24 });
    expect(page.items.map((item) => item.slug)).not.toContain('seam-hidden');
  });

  it('agrees with the repository about drafts, through the real chapter read', async () => {
    const slug = asSlug('seam-alpha');
    const anon = await service.chapterList(slug, ANON);
    expect(anon?.map((item) => item.number)).toEqual([1]);
    const reader = await service.chapterList(slug, READER, { includeDrafts: true });
    expect(reader?.map((item) => item.number)).toEqual([1]);
    const adminNoFlag = await service.chapterList(slug, ADMIN);
    expect(adminNoFlag?.map((item) => item.number)).toEqual([1]);
    const adminFlag = await service.chapterList(slug, ADMIN, { includeDrafts: true });
    expect(adminFlag?.map((item) => item.number)).toEqual([1, 2]);
  });

  it('narrows the repository’s exact-numeric chapter number to a JS number', async () => {
    const items = await service.chapterList(asSlug('seam-alpha'), ADMIN, { includeDrafts: true });
    expect(items?.map((item) => typeof item.number)).toEqual(['number', 'number']);
    expect(items?.map((item) => item.number)).toEqual([1, 2]);
  });

  it('404-shapes a hidden manga consistently on both sides of the port', async () => {
    await expect(service.chapterList(asSlug('seam-hidden'), ANON)).resolves.toBeNull();
  });
});
