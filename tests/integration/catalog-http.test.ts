/**
 * The HTTP half of the catalog route plus the facets endpoint, against a REAL
 * PostgreSQL 18.
 *
 * The service half is `catalog-list.test.ts`; this file is the part observable
 * only from OUTSIDE the service: the route handler's status codes, headers,
 * envelope shape, and the Zod edge validation.
 *
 * Covered:
 * - `GET /api/v1/catalog` — 200 shape, cache headers, x-request-id;
 * - `GET /api/v1/catalog` — VALIDATION_BAD_QUERY 422 for a bad sort/status and
 *   for a sixth genre;
 * - `GET /api/v1/catalog` — CATALOG_PAGE_INVALID 422 for a bad cursor/limit;
 * - an injection payload never becomes SQL — the database is still there and
 *   still intact after the request;
 * - `GET /api/v1/catalog/facets` — the public genre/tag vocabulary, no counts.
 *
 * DSN: `DATABASE_URL`; SKIPS without it. Throwaway database, own port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogListHandler } from '../../src/app/api/v1/catalog/route';
import { createCatalogFacetsHandler } from '../../src/app/api/v1/catalog/facets/route';
import type { ApiV1Deps } from '../../src/app/api/v1/_deps';
import { manga as mangaTable } from '../../src/server/db/schema';
import {
  GENRES,
  HIDDEN_ONLY_GENRE,
  createPgCatalogHarness,
  openCatalogDatabase,
  silentLogger,
} from './support/pg-catalog-ports';
import type { OpenDatabase, PgCatalogHarness } from './support/pg-catalog-ports';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('GET /api/v1/catalog — the HTTP boundary', () => {
  let open: OpenDatabase;
  let harness: PgCatalogHarness;

  const call = async (query: string): Promise<Response> => {
    const deps: ApiV1Deps = {
      catalog: harness.service,
      chapters: harness.chapters as unknown as ApiV1Deps['chapters'],
      // Not under test here: the search service rides this seam because the
      // /api/search route shares it, so every literal needs a member even when
      // the suite under test never calls it. An empty answer, not a throw —
      // a throw would turn an unrelated suite into a search test.
      search: { search: async () => ({ items: [], nextCursor: null }) },
      resolveCaller: async () => null,
      logger: silentLogger(),
    };
    return createCatalogListHandler(deps)(new Request(`http://yomi.test/api/v1/catalog${query}`));
  };

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, 'catalog_http_it');
    harness = await createPgCatalogHarness(open);
  });

  afterAll(async () => {
    await open?.close();
  });

  it('answers 200 with { items, nextCursor } and the catalog cache headers', async () => {
    const response = await call('?limit=5');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'private, max-age=60, stale-while-revalidate=60',
    );
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
    expect(body['nextCursor']).toEqual(expect.any(String));
  });

  it('returns exactly the MangaSummary fields, camelCased', async () => {
    const body = (await (await call('?limit=1')).json()) as {
      items: Array<Record<string, unknown>>;
    };
    const first = body.items[0] ?? {};
    expect(Object.keys(first).sort()).toEqual([
      'coverUrl',
      'id',
      'latestChapter',
      'slug',
      'status',
      'title',
    ]);
    const latest = first['latestChapter'] as Record<string, unknown> | null;
    expect(latest).not.toBeNull();
    expect(Object.keys(latest ?? {}).sort()).toEqual(['number', 'publishedAt', 'title']);
  });

  it('defaults to 24 per page and clamps anything above 48', async () => {
    const defaulted = (await (await call('')).json()) as { items: unknown[] };
    expect(defaulted.items).toHaveLength(24);
    const clamped = (await (await call('?limit=500')).json()) as { items: unknown[] };
    expect(clamped.items.length).toBeLessThanOrEqual(48);
  });

  it('accepts every whitelisted sort and rejects anything else with 422', async () => {
    for (const sort of ['title_asc', 'updated_desc', 'added_desc']) {
      expect((await call(`?sort=${sort}`)).status, sort).toBe(200);
    }
    for (const sort of ['popularity_desc', 'title_desc', 'id']) {
      const response = await call(`?sort=${encodeURIComponent(sort)}`);
      expect(response.status, sort).toBe(422);
      const body = (await response.json()) as { error: { code: string; details?: unknown[] } };
      expect(body.error.code).toBe('VALIDATION_BAD_QUERY');
    }
  });

  it('rejects a bad status with 422 VALIDATION_BAD_QUERY', async () => {
    const response = await call('?status=draft');
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_BAD_QUERY');
  });

  it('rejects a sixth genre with 422 VALIDATION_BAD_QUERY', async () => {
    const response = await call('?genre=a,b,c,d,e,f');
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_BAD_QUERY');
  });

  it('answers CATALOG_PAGE_INVALID for a bad cursor and for a bad limit', async () => {
    for (const query of [
      '?cursor=not-a-cursor',
      '?limit=0',
      '?limit=-3',
      '?limit=abc',
      '?limit=',
    ]) {
      const response = await call(query);
      expect(response.status, query).toBe(422);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code, query).toBe('CATALOG_PAGE_INVALID');
    }
  });

  it('carries a per-field details[] on a 422', async () => {
    const body = (await (await call('?sort=nope')).json()) as {
      error: { code: string; details?: Array<{ path?: string; message: string }> };
    };
    expect(body.error.code).toBe('VALIDATION_BAD_QUERY');
    expect(body.error.details?.[0]?.path).toBe('sort');
    expect(body.error.details?.[0]?.message).toEqual(expect.any(String));
  });

  it('survives an injection payload with the table still there', async () => {
    const payloads = [
      "' OR 1=1 --",
      "'; drop table manga; --",
      "'; delete from chapter; --",
      '1; update manga set published = false',
    ];
    for (const payload of payloads) {
      const response = await call(
        `?sort=${encodeURIComponent(payload)}&genre=${encodeURIComponent(payload)}&status=${encodeURIComponent(payload)}`,
      );
      expect([200, 422], payload).toContain(response.status);
    }
    // The decisive assertion: `manga` still exists and still has its rows.
    const rows = await harness.db.select({ id: mangaTable.id }).from(mangaTable);
    expect(rows.length).toBeGreaterThan(30);
  });

  it('a hostile genre payload that IS slug-shaped filters to nothing, it does not execute', async () => {
    const response = await call('?genre=1-union-select-null');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    // Slug-shaped but matching no `genre` row ⇒ the "ignored" rule, not a
    // syntax error and not a dropped table.
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('GET /api/v1/catalog/facets lists the public genre and tag vocabulary', async () => {
    const response = await createCatalogFacetsHandler({
      catalog: harness.service,
      chapters: harness.chapters as unknown as ApiV1Deps['chapters'],
      // Not under test here: the search service rides this seam because the
      // /api/search route shares it, so every literal needs a member even when
      // the suite under test never calls it. An empty answer, not a throw —
      // a throw would turn an unrelated suite into a search test.
      search: { search: async () => ({ items: [], nextCursor: null }) },
      resolveCaller: async () => null,
      logger: silentLogger(),
    })(new Request('http://yomi.test/api/v1/catalog/facets'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'private, max-age=60, stale-while-revalidate=60',
    );
    const body = (await response.json()) as { genres: unknown[]; tags: unknown[] };
    expect(Object.keys(body).sort()).toEqual(['genres', 'tags']);
    expect(body.genres.length).toBeGreaterThan(0);
    expect(body.tags.length).toBeGreaterThan(0);
    // No counts and no leak of internals.
    const first = body.genres[0] as { id?: unknown; name?: unknown } | undefined;
    expect(typeof first?.id).toBe('string');
    expect(typeof first?.name).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/count|total|number/i);
  });

  it('omits a genre that no VISIBLE title carries (a filter that cannot match)', async () => {
    const response = await createCatalogFacetsHandler({
      catalog: harness.service,
      chapters: harness.chapters as unknown as ApiV1Deps['chapters'],
      // Not under test here: the search service rides this seam because the
      // /api/search route shares it, so every literal needs a member even when
      // the suite under test never calls it. An empty answer, not a throw —
      // a throw would turn an unrelated suite into a search test.
      search: { search: async () => ({ items: [], nextCursor: null }) },
      resolveCaller: async () => null,
      logger: silentLogger(),
    })(new Request('http://yomi.test/api/v1/catalog/facets'));
    const body = (await response.json()) as { genres: Array<{ name: string }> };
    const names = body.genres.map((genre) => genre.name);
    expect(names).toContain(GENRES[0]);
    expect(names).not.toContain(HIDDEN_ONLY_GENRE);
  });

  it('every genre facets offers is usable as a catalog filter', async () => {
    const facets = (await (
      await createCatalogFacetsHandler({
        catalog: harness.service,
        chapters: harness.chapters as unknown as ApiV1Deps['chapters'],
        search: { search: async () => ({ items: [], nextCursor: null }) },
        resolveCaller: async () => null,
        logger: silentLogger(),
      })(new Request('http://yomi.test/api/v1/catalog/facets'))
    ).json()) as { genres: Array<{ name: string }> };
    for (const genre of facets.genres) {
      const response = await call(`?genre=${encodeURIComponent(genre.name.toLowerCase())}`);
      const body = (await response.json()) as { items: unknown[] };
      expect(
        body.items.length,
        `genre ${genre.name} is offered but filters to nothing`,
      ).toBeGreaterThan(0);
    }
  });
});
