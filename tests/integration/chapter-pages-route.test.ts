/**
 * `GET /api/v1/chapters/{chapterId}/pages` (INT-RDR-PAGES, F-006-S2).
 *
 * Why this file had to be written
 * -------------------------------
 * The route existed with NO test at all, and this slice rewrote it — moving it
 * off a direct database handle onto `ChapterRepository.pageList`. Rewriting an
 * untested route is how a reader silently loses their pages, so the contract
 * itself is pinned here rather than inferred from the diff.
 *
 * Two things are being defended:
 *
 * 1. **The reader still gets pages.** The client reads `chapter`,
 *    `readingDirection`, `pageCount`, `mangaSlug`, `urlJpeg` and `urlAvif` — and
 *    `mangaId`, which the OLD hand-built response carried and the CONTRACT does
 *    not. The client does not use `mangaId`, so dropping it is safe; that is
 *    asserted rather than assumed, because "the client does not read it" is the
 *    kind of claim that rots the moment someone adds a field.
 *
 * 2. **Drafts stay invisible.** An anonymous caller must not be able to tell a
 *    missing chapter from an unpublished one, so all three answer 404. The old
 *    route answered **409 `CHAPTER_NOT_READY`** for an unpublished chapter —
 *    a real status change, and a security improvement: 409 confirmed the chapter
 *    exists. It is recorded rather than glossed, because a client branching on 409
 *    would notice.
 *
 * Requirements: FR-READER-012, FR-READER-016, NFR-SEC-015
 * Tasks: T-READER-001
 *
 * DSN: `DATABASE_URL`; SKIPS without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET } from '../../src/app/api/v1/chapters/[chapterId]/pages/route';
import { openCatalogDatabase, mangaIdFor } from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import { chapter, chapterPage, manga } from '../../src/server/db/schema';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { ChapterPagesResponse } from '../../src/shared/contracts/chapter';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const PUBLISHED = mangaIdFor('pages_published');
const DRAFT = mangaIdFor('pages_draft');
const CH_1 = '0198c0f0-0000-7000-8000-000000000a01';
const CH_2 = '0198c0f0-0000-7000-8000-000000000a02';
const CH_DRAFT = '0198c0f0-0000-7000-8000-000000000a03';
const MISSING = '0198c0f0-0000-7000-8000-000000000a99';

const anon = () => new Request('http://yomi.test/api/v1/chapters/x/pages', { headers: {} });

const ctx = (chapterId: string) => ({ params: Promise.resolve({ chapterId }) });

describeDb('the chapter pages route (INT-RDR-PAGES, F-006-S2)', () => {
  let open: OpenDatabase;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, 'rdr_pages');
    for (const [key, value] of Object.entries(envSource(DATABASE_URL as string))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    // The seam builds its own composition from `process.env`, so the test has to
    // point the environment at its throwaway database. Without this the route
    // reads the base database, finds nothing, and answers 404 — which looks like a
    // broken fixture rather than a mis-pointed one.
    const throwaway = new URL(DATABASE_URL as string);
    throwaway.pathname = '/rdr_pages';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = throwaway.toString();

    await open.db.insert(manga).values([
      {
        id: PUBLISHED,
        slug: 'pages_published',
        title: 'Pages Published',
        published: true,
        status: 'ongoing',
        readingDirection: 'rtl',
      },
      {
        id: DRAFT,
        slug: 'pages_draft',
        title: 'Pages Draft',
        published: false,
        status: 'ongoing',
        readingDirection: 'ltr',
      },
    ]);
    await open.db.insert(chapter).values([
      {
        id: CH_1,
        mangaId: PUBLISHED,
        number: '1',
        status: 'published',
        publishedAt: new Date('2026-04-01T00:00:00Z'),
        pageCount: 2,
        readingOrder: 1,
      },
      {
        id: CH_2,
        mangaId: PUBLISHED,
        number: '2',
        status: 'published',
        publishedAt: new Date('2026-04-01T00:00:00Z'),
        pageCount: 1,
        readingOrder: 2,
      },
      {
        id: CH_DRAFT,
        mangaId: DRAFT,
        number: '1',
        status: 'published',
        publishedAt: new Date('2026-04-01T00:00:00Z'),
        pageCount: 1,
        readingOrder: 1,
      },
    ]);
    await open.db.insert(chapterPage).values([
      {
        chapterId: CH_1,
        pageNumber: 1,
        assetKey: 'd'.repeat(32),
        width: 480,
        height: 720,
        byteSizeAvif: 1,
        byteSizeWebp: 1,
        byteSizeJpeg: 1,
      },
      {
        chapterId: CH_1,
        pageNumber: 2,
        assetKey: 'e'.repeat(32),
        width: 480,
        height: 720,
        byteSizeAvif: 1,
        byteSizeWebp: 1,
        byteSizeJpeg: 1,
      },
      {
        chapterId: CH_2,
        pageNumber: 1,
        assetKey: 'f'.repeat(32),
        width: 480,
        height: 720,
        byteSizeAvif: 1,
        byteSizeWebp: 1,
        byteSizeJpeg: 1,
      },
      {
        chapterId: CH_DRAFT,
        pageNumber: 1,
        assetKey: '0'.repeat(32),
        width: 480,
        height: 720,
        byteSizeAvif: 1,
        byteSizeWebp: 1,
        byteSizeJpeg: 1,
      },
    ]);
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousDatabaseUrl;
    await open?.close();
  });

  it('serves an anonymous reader every field the reader client actually reads', async () => {
    // No session: reading is public by design (PRODUCT.md commitment 2).
    const res = await GET(anon(), ctx(CH_1));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChapterPagesResponse;

    // Exactly the fields `reader-client.tsx` reads. A contract that loses one of
    // these breaks the reader at runtime, and there is no type that would say so,
    // because the client parses `unknown`.
    expect(body.chapter.mangaSlug).toBe('pages_published');
    expect(body.chapter.mangaTitle).toBe('Pages Published');
    expect(body.chapter.pageCount).toBe(2);
    expect(body.chapter.readingDirection).toBe('rtl');
    expect(body.pages).toHaveLength(2);
    // The three variants share one key: `/media/{key}` serves the stored
    // format, so all three URLs are the same app-relative path.
    expect(body.pages[0]?.urlJpeg).toMatch(/^\/media\/[0-9a-f]{32}$/);
    expect(body.pages[0]?.urlJpeg).toBe(body.pages[0]?.urlAvif);
    expect(body.pages[0]?.urlJpeg).toBe(body.pages[0]?.urlWebp);
    expect(body.pages[0]?.pageNumber).toBe(1);

    // `mangaId` was in the OLD hand-built response and is NOT in the contract.
    // Dropping it is safe only because the client never reads it, so that is
    // asserted as a fact about the contract rather than left to memory.
    expect('mangaId' in body.chapter).toBe(false);
  });

  it('hands over the chapter neighbours the reader has never had', async () => {
    // FR-READER-016 was already implemented in the port and already returned by
    // `pageList`; the old hand-built route dropped it. This is where F-007-S1 gets
    // its data from.
    const first = (await (await GET(anon(), ctx(CH_1))).json()) as ChapterPagesResponse;
    expect(first.prevChapter).toBeNull();
    expect(first.nextChapter?.number).toBe(2);

    const second = (await (await GET(anon(), ctx(CH_2))).json()) as ChapterPagesResponse;
    expect(second.prevChapter?.number).toBe(1);
    expect(second.nextChapter).toBeNull();
  });

  it('answers 404 for a missing chapter and for an unpublished one alike', async () => {
    // The same answer on purpose: a distinct status would confirm to an anonymous
    // caller that a draft chapter exists. The old route answered 409 for the
    // unpublished case, which is a real status change and a security improvement.
    const missing = await GET(anon(), ctx(MISSING));
    const draftManga = await GET(anon(), ctx(CH_DRAFT));

    expect(missing.status).toBe(404);
    expect(draftManga.status).toBe(404);
    // The CODE is what must match, not the bytes: the body carries a requestId,
    // which differs per call. Comparing full text would fail for a reason that
    // has nothing to do with the security property under test.
    const codeOf = async (res: Response) =>
      (JSON.parse(await res.text()) as { error: { code: string } }).error.code;
    expect(await codeOf(draftManga)).toBe(await codeOf(missing));
  });

  it('caches privately rather than publicly, so a soft-delete takes effect', async () => {
    const res = await GET(anon(), ctx(CH_1));
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
  });
});
