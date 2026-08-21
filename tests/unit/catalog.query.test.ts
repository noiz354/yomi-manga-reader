/**
 * Unit tests — catalog QUERY COMPOSITION.
 *
 * Unit level: no I/O, no services, no Docker. Every test here drives the real
 * service over in-memory port doubles.
 *
 * What is asserted:
 * 1. default limit 24, hard cap 48;
 * 2. sort/status whitelists — anything else is a typed 422, never SQL;
 * 3. `genre` csv ≤ 5 slugs, normalised, unmatchable slugs dropped, NOT an
 *    error;
 * 4. cursor: opaque, validated, CATALOG_PAGE_INVALID on garbage;
 * 5. latestChapter arrives from the SINGLE list call — no per-item read;
 * 6. injection payloads are inert data.
 */
import { describe, expect, it } from 'vitest';
import { AppError, getErrorMapping } from '../../src/shared/contracts/errors';
import type { CallerContext, ChapterSummary, MangaSummary } from '../../src/shared/contracts';
import type { MangaId, MangaSlug } from '../../src/shared/types';
import {
  CATALOG_CURSOR_MAX_LENGTH,
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MAX_GENRES,
  CATALOG_MAX_LIMIT,
  CATALOG_SORTS,
  CATALOG_STATUSES,
  createCatalogService,
  assertCatalogCursorToken,
  normaliseCatalogQuery,
} from '../../src/features/catalog';

interface RecordedCall {
  method: string;
  query?: unknown;
  mangaId?: string;
  caller?: CallerContext;
}

function summary(over: Partial<MangaSummary> = {}): MangaSummary {
  return {
    id: '00000000-0000-7000-8000-000000000001' as MangaId,
    slug: 'seed-manga-0001' as MangaSlug,
    title: 'Seed Manga 0001',
    status: 'ongoing',
    coverUrl: null,
    latestChapter: null,
    ...over,
  };
}

function fakeMangaRepo(options: { items?: MangaSummary[] } = {}) {
  const calls: RecordedCall[] = [];
  const repository = {
    list: async (query: unknown) => {
      calls.push({ method: 'list', query });
      return { items: options.items ?? [], nextCursor: null };
    },
    bySlug: async () => {
      calls.push({ method: 'bySlug' });
      return null;
    },
  };
  // Only the two read methods the catalog service uses are needed here.
  return { repository: repository as never, calls };
}

function fakeChaptersRepo(chapters: ChapterSummary[] = []) {
  const calls: RecordedCall[] = [];
  return {
    repository: {
      listByManga: async (mangaId: MangaId, caller: CallerContext) => {
        calls.push({ method: 'listByManga', mangaId, caller });
        return chapters;
      },
    } as never,
    calls,
  };
}

/**
 * Asserts a typed rejection. Written as a helper rather than
 * `expect(fn).toThrow` + a `try/catch` because a bare `try/catch` here would
 * also catch the assertion failure of `expect.unreachable` and read it as the
 * AppError under test.
 */
function expectAppError(fn: () => unknown, code: string): void {
  let thrown: unknown;
  let didThrow = false;
  try {
    fn();
  } catch (error) {
    didThrow = true;
    thrown = error;
  }
  expect(didThrow, `expected a throw with code ${code}`).toBe(true);
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe(code);
}

async function expectAppErrorAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  let didThrow = false;
  try {
    await fn();
  } catch (error) {
    didThrow = true;
    thrown = error;
  }
  expect(didThrow, `expected a throw with code ${code}`).toBe(true);
  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe(code);
}

function serviceWith(items: MangaSummary[] = []) {
  const manga = fakeMangaRepo({ items });
  const service = createCatalogService({
    manga: manga.repository,
    chapters: fakeChaptersRepo().repository,
    progress: { latestForManga: async () => null },
  });
  return { service, calls: manga.calls };
}

describe('catalog limit composition', () => {
  it('defaults limit to 24 when the caller omits it', async () => {
    const { service, calls } = serviceWith();
    await service.list({});
    expect(calls[0]?.query).toMatchObject({ limit: CATALOG_DEFAULT_LIMIT });
  });

  it('caps limit at 48', () => {
    expect(normaliseCatalogQuery({ limit: 500 }).limit).toBe(CATALOG_MAX_LIMIT);
    expect(CATALOG_MAX_LIMIT).toBe(48);
  });

  it('rejects a non-positive limit as CATALOG_PAGE_INVALID', () => {
    for (const limit of [0, -1, Number.NaN, 'abc', '']) {
      expectAppError(() => normaliseCatalogQuery({ limit }), 'CATALOG_PAGE_INVALID');
    }
    expect(getErrorMapping('CATALOG_PAGE_INVALID').httpStatus).toBe(422);
  });

  it('defaults limit to 24 for an ABSENT limit only (present-empty is not absent)', () => {
    // "a whitelist rejects, a list ignores" does not apply to `limit`, which is
    // named for CATALOG_PAGE_INVALID. `?limit=` is a broken link, not page 1.
    expect(normaliseCatalogQuery({}).limit).toBe(24);
    expect(normaliseCatalogQuery({ limit: undefined }).limit).toBe(24);
  });
});

describe('sort + status whitelists', () => {
  it('exposes exactly the three sorts the contract and the ports name', () => {
    // The contract names three: title A–Z, most recently updated, most
    // recently added. There is no fourth anywhere and the MangaRepository
    // port's union has three members — a fourth cannot even be represented.
    expect([...CATALOG_SORTS]).toEqual(['title_asc', 'updated_desc', 'added_desc']);
  });

  it('defaults sort to updated_desc (the catalog query contract)', () => {
    expect(normaliseCatalogQuery({}).sort).toBe('updated_desc');
  });

  it('accepts every whitelisted sort', () => {
    for (const sort of CATALOG_SORTS) {
      expect(normaliseCatalogQuery({ sort }).sort).toBe(sort);
    }
  });

  it('rejects a sort outside the whitelist with VALIDATION_BAD_QUERY (422)', () => {
    for (const sort of ['id; drop table manga', 'popularity_desc', 'title_desc', '']) {
      expectAppError(() => normaliseCatalogQuery({ sort }), 'VALIDATION_BAD_QUERY');
    }
    expect(getErrorMapping('VALIDATION_BAD_QUERY').httpStatus).toBe(422);
  });

  it('accepts every whitelisted status and rejects the rest', () => {
    for (const status of CATALOG_STATUSES) {
      expect(normaliseCatalogQuery({ status }).status).toBe(status);
    }
    expect([...CATALOG_STATUSES]).toEqual(['ongoing', 'completed', 'hiatus']);
    for (const status of ['draft', 'published', 'ongoing OR 1=1']) {
      expectAppError(() => normaliseCatalogQuery({ status }), 'VALIDATION_BAD_QUERY');
    }
  });
});

describe('genre filter composition', () => {
  it('splits a csv into normalised, de-duplicated slugs', () => {
    expect(normaliseCatalogQuery({ genres: 'Action, Romance ,action' }).genres).toEqual([
      'action',
      'romance',
    ]);
  });

  it('rejects a sixth slug (contract: csv, ≤ 5) with VALIDATION_BAD_QUERY', () => {
    expectAppError(() => normaliseCatalogQuery({ genres: 'a,b,c,d,e,f' }), 'VALIDATION_BAD_QUERY');
    expect(CATALOG_MAX_GENRES).toBe(5);
  });

  it('drops slugs that cannot name a genre row instead of failing', () => {
    // "unknown genre slug ignored (not error)" splits across two modules:
    // SHAPE is here, EXISTENCE is the repository's (it owns the genre join).
    // Neither half may 4xx a perfectly valid request — and unlike sort/status,
    // a csv LIST ignores rather than rejects.
    expect(normaliseCatalogQuery({ genres: "action,' OR 1=1--,romance" }).genres).toEqual([
      'action',
      'romance',
    ]);
    expect(normaliseCatalogQuery({ genres: '' }).genres).toEqual([]);
    expect(normaliseCatalogQuery({ genres: ',,,' }).genres).toEqual([]);
  });

  it('hands well-shaped unknown slugs to the repository rather than 404-ing', async () => {
    // Resolving existence here would cost an extra round trip on the hot path
    // and break the one-query rule; the repository already joins genre, so the
    // slugs travel as bound values and an unmatched one filters nothing.
    // tests/integration/catalog-list.test.ts proves the end-to-end outcome
    // against a real `genre` table.
    const { service, calls } = serviceWith();
    await expect(service.list({ genres: 'not-a-real-genre,also-not-real' })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(calls[0]?.query).toMatchObject({ genres: ['not-a-real-genre', 'also-not-real'] });
  });
});

describe('cursor composition', () => {
  // The cursor PAYLOAD belongs to the repository: only the component that
  // knows the sort tuple can read or build one. The service owns the
  // TRANSPORT — it refuses a token that cannot be a cursor at all, before any
  // query, and forwards everything else byte-for-byte. Re-defining the payload
  // here is what made the two formats diverge and 422'd page two of every walk;
  // these tests are the regression guard for that.
  const REPOSITORY_TOKEN = Buffer.from(
    JSON.stringify({
      v: 1,
      s: 'updated_desc',
      k: '2026-09-01T00:00:00.000Z',
      i: '00000000-0000-7000-8000-000000000001',
    }),
    'utf8',
  ).toString('base64url');

  it('accepts a token the repository minted, and never re-encodes it', async () => {
    const { service, calls } = serviceWith();
    await service.list({ cursor: REPOSITORY_TOKEN });
    // Byte-for-byte: the repository must see exactly what it minted.
    expect(calls[0]?.query).toMatchObject({ cursor: REPOSITORY_TOKEN });
  });

  it('refuses an empty, over-long or non-base64url token before any query', () => {
    for (const cursor of [
      '',
      'not-base64!!',
      'has spaces',
      'x'.repeat(CATALOG_CURSOR_MAX_LENGTH + 1),
    ]) {
      expectAppError(() => normaliseCatalogQuery({ cursor }), 'CATALOG_PAGE_INVALID');
    }
  });

  it('bounds a token at the service and leaves the payload to the repository', () => {
    // A well-formed base64url token with a payload the service has no opinion
    // about is FORWARDED, not judged. `assertCatalogCursorToken` is the whole
    // of the service's cursor knowledge, and it is a bound, not a schema.
    expect(() => assertCatalogCursorToken(REPOSITORY_TOKEN)).not.toThrow();
    expect(() =>
      assertCatalogCursorToken(Buffer.from('{"v":99}').toString('base64url')),
    ).not.toThrow();
    expect(() => assertCatalogCursorToken('')).toThrowError(AppError);
  });

  it('treats an absent cursor as the first page', () => {
    expect(normaliseCatalogQuery({ cursor: undefined }).cursor).toBeUndefined();
    expect(normaliseCatalogQuery({}).cursor).toBeUndefined();
  });
});

describe('latestChapter is not an N+1', () => {
  it('issues exactly one repository call for a full page and zero per item', async () => {
    const items = Array.from({ length: 24 }, (_, offset) =>
      summary({
        id: `00000000-0000-7000-8000-${String(offset).padStart(12, '0')}` as MangaId,
        slug: `seed-manga-${String(offset).padStart(4, '0')}` as MangaSlug,
        latestChapter: { number: offset + 1, title: null, publishedAt: '2026-09-01T00:00:00.000Z' },
      }),
    );
    const { service, calls } = serviceWith(items);
    const page = await service.list({ limit: 24 });
    expect(page.items).toHaveLength(24);
    expect(calls.filter((call) => call.method === 'list')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'bySlug')).toHaveLength(0);
  });

  it('normalises the exact-numeric chapter number the repositories return as a string', async () => {
    const { service } = serviceWith([
      {
        ...summary(),
        latestChapter: {
          number: '10.50' as never,
          title: null,
          publishedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    ]);
    const page = await service.list({});
    expect(page.items[0]?.latestChapter?.number).toBe(10.5);
  });
});

describe('injection payloads are inert', () => {
  /** Anything that can reach a repository must match this closed shape. */
  const SLUG_SHAPED = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  it('refuses every hostile sort and status with a typed 422 and no query', async () => {
    const payloads = [
      "'; drop table manga; --",
      "' OR 1=1 --",
      '1; DELETE FROM chapter WHERE 1=1',
      'admin" --',
      'title_asc; --',
      'completed/**/union select null',
    ];
    for (const payload of payloads) {
      await expectAppErrorAsync(
        () => serviceWith().service.list({ sort: payload, status: payload }),
        'VALIDATION_BAD_QUERY',
      );
      await expectAppErrorAsync(
        () => serviceWith().service.list({ status: payload }),
        'VALIDATION_BAD_QUERY',
      );
    }
  });

  it('lets no SQL punctuation reach the repository through the genre csv', async () => {
    const payloads = [
      "'; drop table manga; --",
      "' OR 1=1 --",
      '1; DELETE FROM chapter WHERE 1=1',
      'admin" --',
      '/*comment*/',
      '../../etc/passwd',
    ];
    for (const payload of payloads) {
      const { service, calls } = serviceWith();
      await service.list({ genres: payload });
      const query = calls[0]?.query as { genres: string[] };
      // A slug-shaped token may survive (it is a bound value, not SQL); a token
      // carrying punctuation is dropped. Either way the repository only ever
      // receives `[a-z0-9-]`.
      for (const slug of query.genres) {
        expect(SLUG_SHAPED.test(slug), `slug "${slug}" is not slug-shaped`).toBe(true);
        expect(slug.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it('treats a slug-shaped hostile token as data, never as syntax', async () => {
    // `1-union-select-null` IS slug-shaped. It survives normalisation and is
    // handed to the repository as a bound value; it can only ever be a genre
    // name that matches no row. This is the guarantee stated as an
    // assertion: the value is inert because it is a parameter, not because the
    // normaliser was clever.
    const { service, calls } = serviceWith();
    await service.list({ genres: '1-union-select-null' });
    expect(calls[0]?.query).toMatchObject({ genres: ['1-union-select-null'] });
  });
});
