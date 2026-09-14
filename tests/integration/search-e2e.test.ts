/**
 * Search end to end through the shipping layers.
 *
 * Repository, service and route suites each test one layer with a fake for the
 * next, so no test calls a real layer through another: a cursor envelope the
 * repository cannot decode, a `SearchHit` the route cannot serialise, or a
 * composition wiring the wrong repository would pass all three and fail in
 * production. This wires the REAL service over the REAL repository over a
 * throwaway database, drives the REAL route handler, and asserts the wire shape.
 *
 * What is NOT covered: the browser, the debounce, the page. This stops at the
 * HTTP response. Needs DATABASE_URL; skips cleanly without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSearchService } from '../../src/features/search/search.service';
import { createSearchRepository } from '../../src/server/db/repositories/search.repository';
import { createSearchHandler, resetSearchRateLimit } from '../../src/app/api/search/route';
import { openCatalogDatabase } from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import { chapter, manga } from '../../src/server/db/schema';
import { silentLogger } from './support/pg-catalog-ports';
import type { OpenDatabase } from './support/pg-catalog-ports';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const DB_NAME = 'search_e2e_it';
const M1 = '0198c0f0-0000-7000-8000-000000002001';
const M2 = '0198c0f0-0000-7000-8000-000000002002';
const M3 = '0198c0f0-0000-7000-8000-000000002003';

describeDb('the layers agree with each other', () => {
  let open: OpenDatabase;
  let service: ReturnType<typeof createSearchService>;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, DB_NAME);
    service = createSearchService({ search: createSearchRepository(open.db) });
    const throwaway = new URL(DATABASE_URL as string);
    throwaway.pathname = `/${DB_NAME}`;
    for (const [key, value] of Object.entries(envSource(throwaway.toString()))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }

    await open.db.insert(manga).values([
      {
        id: M1,
        slug: 'e2e-naruto',
        title: 'Naruto',
        published: true,
        status: 'ongoing',
        readingDirection: 'ltr',
      },
      {
        id: M2,
        slug: 'e2e-naruto-ship',
        title: 'Naruto Shippuden',
        published: true,
        status: 'ongoing',
        readingDirection: 'ltr',
      },
      {
        id: M3,
        slug: 'e2e-boruto',
        title: 'Boruto: Naruto Next',
        published: true,
        status: 'ongoing',
        readingDirection: 'ltr',
      },
    ]);
    await open.db.insert(chapter).values(
      [M1, M2, M3].map((mangaId, index) => ({
        id: `0198c0f0-0000-7000-8000-0000000021${String(index + 1).padStart(2, '0')}`,
        mangaId,
        number: '1',
        status: 'published' as const,
        publishedAt: new Date('2026-04-01T00:00:00.000Z'),
        pageCount: 12,
        readingOrder: 1,
      })),
    );
  });

  afterAll(async () => {
    await open?.close();
  });

  it('the service returns repository rows in band order, through no mocks', async () => {
    const { items, nextCursor } = await service.search({ q: 'naruto' });

    expect(items.map((item) => item.band)).toEqual(['exact', 'prefix', 'contains']);
    expect(items.map((item) => item.title)).toEqual([
      'Naruto',
      'Naruto Shippuden',
      'Boruto: Naruto Next',
    ]);
    expect(nextCursor).toBeNull();
  });

  it('a service cursor pages the repository, through no mocks', async () => {
    const first = await service.search({ q: 'naruto', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    // The envelope the service minted is opaque to everyone but the service —
    // and the service accepts its own minting back.
    const second = await service.search({
      q: 'naruto',
      limit: 2,
      cursor: first.nextCursor as string,
    });

    expect(second.items.map((item) => item.title)).toEqual(['Boruto: Naruto Next']);
    expect(second.nextCursor).toBeNull();
  });

  it('the route serves the service answer as JSON, anonymously', async () => {
    resetSearchRateLimit();
    const response = await createSearchHandler({ search: service, logger: silentLogger() })(
      new Request('http://yomi.test/api/search?q=naruto'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as {
      items: Array<{ kind: string; title: string; band: string }>;
      nextCursor: string | null;
    };
    expect(body.items[0]).toEqual({
      kind: 'manga',
      id: M1,
      slug: 'e2e-naruto',
      title: 'Naruto',
      matchField: 'title',
      band: 'exact',
    });
  });

  it('the route refuses an empty q with the service code, not a generic 500', async () => {
    resetSearchRateLimit();
    const response = await createSearchHandler({ search: service, logger: silentLogger() })(
      new Request('http://yomi.test/api/search?q=%20'),
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('SEARCH_QUERY_INVALID');
  });
});
