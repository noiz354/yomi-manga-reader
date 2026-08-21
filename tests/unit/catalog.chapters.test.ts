/**
 * Unit tests — catalog CHAPTER LIST policy. Service-level halves that need no
 * database: the draft-visibility matrix, the 1000-cap 409, the empty list, and
 * the order-preservation hand-off. The database half (decimal `number`, the
 * `reading_order` tiebreak, the leak against real rows) lives in the chapter-list
 * integration test.
 */
import { describe, expect, it } from 'vitest';
import { AppError, getErrorMapping } from '../../src/shared/contracts/errors';
import type { CallerContext, ChapterSummary, MangaDetail } from '../../src/shared/contracts';
import type { MangaId, MangaSlug } from '../../src/shared/types';
import { CHAPTER_LIST_HARD_CAP, createCatalogService } from '../../src/features/catalog';

const SLUG = 'seed-manga-0001' as MangaSlug;
const MANGA_ID = '00000000-0000-7000-8000-0000000000aa' as MangaId;

const ANON: CallerContext = null;
const READER: CallerContext = { userId: 'user-2' as never, role: 'reader' };
const ADMIN: CallerContext = { userId: 'user-1' as never, role: 'admin' };

function chapter(number: number, published: boolean): ChapterSummary {
  return {
    id: `00000000-0000-7000-8000-${String(number * 10).padStart(12, '0')}` as never,
    number,
    title: `Chapter ${String(number)}`,
    pageCount: 20,
    // null publishedAt IS a draft.
    publishedAt: published ? '2026-09-01T00:00:00.000Z' : null,
  };
}

function serviceFor(options: { rows: ChapterSummary[]; detail?: MangaDetail | null }) {
  const mangaCalls: Array<{ method: string; arg: unknown }> = [];
  const chapterCalls: Array<{ method: string; mangaId: string; caller: CallerContext }> = [];
  const detail: MangaDetail | null =
    options.detail === undefined
      ? ({
          id: MANGA_ID,
          slug: SLUG,
          title: 'Seed Manga 0001',
          status: 'ongoing',
          coverUrl: null,
          latestChapter: null,
          aliases: [],
          synopsis: '',
          readingDirection: 'rtl',
          chapterCount: options.rows.length,
          firstChapter: null,
          creators: [],
          genres: [],
          tags: [],
          createdAt: '2026-09-01T00:00:00.000Z',
        } satisfies MangaDetail)
      : options.detail;
  const service = createCatalogService({
    manga: {
      bySlug: async (slug: MangaSlug) => {
        mangaCalls.push({ method: 'bySlug', arg: slug });
        return detail as never;
      },
      list: async () => ({ items: [], nextCursor: null }),
    } as never,
    chapters: {
      listByManga: async (mangaId: MangaId, caller: CallerContext) => {
        chapterCalls.push({ method: 'listByManga', mangaId, caller });
        return options.rows;
      },
    } as never,
    progress: { latestForManga: async () => null },
  });
  return { service, mangaCalls, chapterCalls };
}

describe('a manga with no chapters', () => {
  it('returns an empty list, not null (null is reserved for 404)', async () => {
    const { service } = serviceFor({ rows: [] });
    await expect(service.chapterList(SLUG, ANON)).resolves.toEqual([]);
  });
});

describe('unknown / hidden manga', () => {
  it('resolves null so the route can answer MANGA_NOT_FOUND 404', async () => {
    const { service } = serviceFor({ rows: [], detail: null });
    await expect(service.chapterList(SLUG, ANON)).resolves.toBeNull();
  });

  it('never reaches the chapter read when the manga does not resolve', async () => {
    const { service, chapterCalls } = serviceFor({ rows: [], detail: null });
    await service.chapterList(SLUG, ANON);
    expect(chapterCalls).toHaveLength(0);
  });
});

describe('draft visibility', () => {
  it('hides drafts from an anonymous caller', async () => {
    const { service } = serviceFor({ rows: [chapter(1, true), chapter(2, true)] });
    const items = await service.chapterList(SLUG, ANON, { includeDrafts: true });
    expect(items).toHaveLength(2);
  });

  it('hides drafts from a reader even when includeDrafts=true (flag is admin-only)', async () => {
    // The rows the port returns for a non-admin are already published-only, so
    // the service ALSO filters on publishedAt — defence in depth: a repository
    // bug cannot leak a draft through this path.
    const { service } = serviceFor({
      rows: [chapter(1, true), chapter(2, true), chapter(3, false)],
    });
    const items = await service.chapterList(SLUG, READER, { includeDrafts: true });
    expect(items).not.toBeNull();
    expect(items?.map((item) => item.number)).toEqual([1, 2]);
    expect(items?.every((item) => item.publishedAt !== null)).toBe(true);
  });

  it('shows drafts to an admin only when the flag is set', async () => {
    const rows = [chapter(1, true), chapter(2, false), chapter(3, false)];
    const withoutFlag = await serviceFor({ rows }).service.chapterList(SLUG, ADMIN);
    expect(withoutFlag?.map((item) => item.number)).toEqual([1]);
    const withFlag = await serviceFor({ rows }).service.chapterList(SLUG, ADMIN, {
      includeDrafts: true,
    });
    expect(withFlag?.map((item) => item.number)).toEqual([1, 2, 3]);
  });

  it('ignores includeDrafts for every non-admin role, in both positions', async () => {
    for (const caller of [ANON, READER]) {
      const rows = [chapter(1, true), chapter(2, false)];
      for (const includeDrafts of [false, true]) {
        const items = await serviceFor({ rows }).service.chapterList(SLUG, caller, {
          includeDrafts,
        });
        expect(items?.map((item) => item.number)).toEqual([1]);
      }
    }
  });
});

describe('the 1000-chapter hard cap', () => {
  it('raises CHAPTER_LIST_TOO_LARGE at 1001 rows (409 + ops alert)', async () => {
    const rows = Array.from({ length: CHAPTER_LIST_HARD_CAP + 1 }, (_, offset) =>
      chapter(offset + 1, true),
    );
    const { service } = serviceFor({ rows });
    try {
      await service.chapterList(SLUG, ANON);
      expect.unreachable('1001 chapters must raise the cap error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('CHAPTER_LIST_TOO_LARGE');
      // 409, error log level, alert = yes (a data problem).
      expect(getErrorMapping(appError.code).httpStatus).toBe(409);
      expect(getErrorMapping(appError.code).logLevel).toBe('error');
      expect(getErrorMapping(appError.code).alerts).toBe(true);
    }
  });

  it('serves exactly 1000 rows without error', async () => {
    const rows = Array.from({ length: CHAPTER_LIST_HARD_CAP }, (_, offset) =>
      chapter(offset + 1, true),
    );
    const items = await serviceFor({ rows }).service.chapterList(SLUG, ANON);
    expect(items).toHaveLength(CHAPTER_LIST_HARD_CAP);
    expect(CHAPTER_LIST_HARD_CAP).toBe(1000);
  });

  it('applies the cap to the list the caller would receive, drafts included', async () => {
    // 1001 rows of which 501 are drafts: the admin list is the oversized one.
    const rows = Array.from({ length: CHAPTER_LIST_HARD_CAP + 1 }, (_, offset) =>
      chapter(offset + 1, offset % 2 === 0),
    );
    const { service } = serviceFor({ rows });
    await expect(service.chapterList(SLUG, ADMIN, { includeDrafts: true })).rejects.toMatchObject({
      code: 'CHAPTER_LIST_TOO_LARGE',
    });
    // …and the published-only view of the same manga is under the cap.
    const publishedOnly = await service.chapterList(SLUG, ANON);
    expect(publishedOnly).toHaveLength(501);
  });
});

describe('reading order is preserved verbatim', () => {
  it('returns the repository order unchanged, decimals included', async () => {
    // A repository that sorted by number would return 1, 2, 10, 10.5, 11 here.
    const rows = [
      chapter(1, true),
      chapter(2, true),
      chapter(10, true),
      chapter(10.5, true),
      chapter(11, true),
    ];
    const items = await serviceFor({ rows }).service.chapterList(SLUG, ANON);
    expect(items?.map((item) => item.number)).toEqual([1, 2, 10, 10.5, 11]);
  });

  it('reads the chapter number back from its exact-numeric string form', async () => {
    const items = await serviceFor({
      rows: [{ ...chapter(1, true), number: '10.50' as never }],
    }).service.chapterList(SLUG, ANON);
    expect(items?.[0]?.number).toBe(10.5);
  });
});
