/**
 * GET /api/v1/manga/{slug} on real PostgreSQL 18.
 * Covers the 404-shaped cases only a real database can answer: `bySlug` is the
 * visibility gate, so "unknown", "unpublished" and "soft-deleted" must be
 * indistinguishable from outside. It also pins identity at the HTTP boundary —
 * the caller comes from `resolveCaller` and nothing else, so `?role=admin` must
 * not buy a draft title.
 * DSN: DATABASE_URL; SKIPS without it. Throwaway database, own port. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMangaDetailHandler } from '../../src/app/api/v1/manga/[slug]/route';
import { createCatalogService } from '../../src/features/catalog';
import { createMangaRepository } from '../../src/server/db/repositories/manga.repository';
import { createProgressPositionReader } from '../../src/server/db/repositories/progress.repository';
import { createResumeService } from '../../src/features/progress';
import { chapter, manga, readingProgress, users } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';
import type { ApiV1Deps } from '../../src/app/api/v1/_deps';
import type { CallerContext } from '../../src/shared/contracts';
import type { UserId } from '../../src/shared/types';
import {
  CALLERS,
  HIDDEN_SLUGS,
  VISIBLE_SLUGS,
  asSlug,
  createPgCatalogHarness,
  openCatalogDatabase,
  silentLogger,
} from './support/pg-catalog-ports';
import type { OpenDatabase, PgCatalogHarness } from './support/pg-catalog-ports';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

/** The contract's slug ceiling, restated so the test fails if the two drift. */
const SLUG_MAX = 190;

describeDb('GET /api/v1/manga/{slug}', () => {
  let open: OpenDatabase;
  let harness: PgCatalogHarness;

  const call = async (slug: string, query = ''): Promise<Response> => {
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
    const path = `/api/v1/manga/${encodeURIComponent(slug)}${query}`;
    return createMangaDetailHandler(deps)(new Request(`http://yomi.test${path}`), {
      params: Promise.resolve({ slug }),
    });
  };

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, 'catalog_detail_it');
    harness = await createPgCatalogHarness(open);
  });

  afterAll(async () => {
    await open?.close();
  });

  it('answers 200 for a published manga, with the contract cache headers', async () => {
    const response = await call(VISIBLE_SLUGS[0] as string);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'private, max-age=60, stale-while-revalidate=60',
    );
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-request-id')).toEqual(expect.any(String));
  });

  it('returns the MangaDetail field set, camelCased', async () => {
    const body = (await (await call(VISIBLE_SLUGS[0] as string)).json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      [
        'aliases',
        'chapterCount',
        'coverUrl',
        'createdAt',
        'creators',
        'firstChapter',
        'genres',
        'id',
        'latestChapter',
        'readingDirection',
        'slug',
        'status',
        'synopsis',
        'tags',
        'title',
      ].sort(),
    );
    expect(body['aliases']).toEqual(expect.any(Array));
    expect(body['synopsis']).toEqual(expect.any(String));
    expect(body['readingDirection']).toMatch(/^(ltr|rtl|vertical)$/);
    expect(typeof body['chapterCount']).toBe('number');
  });

  it('arrives with numbers as JSON numbers, not numeric(8,2) strings', async () => {
    const body = (await (await call(VISIBLE_SLUGS[0] as string)).json()) as {
      firstChapter: { number: unknown } | null;
      latestChapter: { number: unknown } | null;
      chapterCount: unknown;
    };

    expect(typeof body.chapterCount).toBe('number');
    if (body.firstChapter !== null) expect(typeof body.firstChapter.number).toBe('number');
    if (body.latestChapter !== null) expect(typeof body.latestChapter.number).toBe('number');
  });

  it('echoes back the slug that was asked for', async () => {
    const slug = VISIBLE_SLUGS[0] as string;
    const body = (await (await call(slug)).json()) as { slug: string };

    expect(body.slug).toBe(slug);
  });

  it('answers MANGA_NOT_FOUND 404 for an unpublished or soft-deleted slug', async () => {
    expect(HIDDEN_SLUGS.length).toBeGreaterThan(1);

    for (const slug of HIDDEN_SLUGS) {
      const response = await call(slug);
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('MANGA_NOT_FOUND');
    }
  });

  it('answers the SAME 404 for a slug that was never in the database', async () => {
    const response = await call('no-such-manga-anywhere');
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    // Identical to the hidden-title answer: existence is not observable.
    expect(body.error.code).toBe('MANGA_NOT_FOUND');
  });

  it('leaks nothing about a hidden title beyond the 404 code', async () => {
    const body = (await (await call(HIDDEN_SLUGS[0] as string)).json()) as {
      error: Record<string, unknown>;
    };

    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
  });

  it('rejects an over-long slug with 422, not 404 and not 500', async () => {
    const response = await call('s'.repeat(SLUG_MAX + 1));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_BAD_QUERY');
  });

  it('accepts a slug of exactly the ceiling length (200-or-404, never 422)', async () => {
    const response = await call('s'.repeat(SLUG_MAX));

    expect(response.status).not.toBe(422);
  });

  it('accepts a non-latin slug as a lookup miss rather than a validation error', async () => {
    const response = await call('，一开始就');

    expect(response.status).toBe(404);
  });

  it('ignores a role claimed in the query string', async () => {
    // `?role=admin` is not an identity source. The anonymous caller must get the
    // published-only answer, so this must NOT reach a draft title.
    const anonymous = await call(HIDDEN_SLUGS[0] as string, '?role=admin');
    expect(anonymous.status).toBe(404);
  });

  it('reads the caller from the session resolver, not from the URL', async () => {
    const slug = VISIBLE_SLUGS[0] as string;
    const deps: ApiV1Deps = {
      catalog: harness.service,
      chapters: harness.chapters as unknown as ApiV1Deps['chapters'],
      // Not under test here: the search service rides this seam because the
      // /api/search route shares it, so every literal needs a member even when
      // the suite under test never calls it. An empty answer, not a throw —
      // a throw would turn an unrelated suite into a search test.
      search: { search: async () => ({ items: [], nextCursor: null }) },
      resolveCaller: async () => CALLERS.reader,
      logger: silentLogger(),
    };
    const response = await createMangaDetailHandler(deps)(
      new Request(`http://yomi.test/api/v1/manga/${asSlug(slug) as string}?role=admin`),
      { params: Promise.resolve({ slug }) },
    );

    expect(response.status).toBe(200);
  });

  it('is idempotent — the same request twice gives the same answer', async () => {
    const slug = VISIBLE_SLUGS[0] as string;
    const [first, second] = [await call(slug), await call(slug)];

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });

  it('answers from ONE database statement, not one per field', async () => {
    open.probe.reset();
    const response = await call(VISIBLE_SLUGS[0] as string);

    expect(response.status).toBe(200);
    // The harness probe counts statements the repository issues; a detail page
    // that fanned out per genre/tag/creator would show up here.
    expect(open.probe.statements.length).toBeLessThanOrEqual(2);
  });

  describe('continueReading', () => {
    // Real UUIDs: `reading_progress.user_id` is a uuid column, so a
    // human-readable id would be refused by the database before the rules ran.
    const READER: CallerContext = {
      userId: '00000000-0000-4000-8000-00000000c0de' as UserId,
      role: 'reader',
    };
    const STRANGER: CallerContext = {
      userId: '00000000-0000-4000-8000-00000000f00d' as UserId,
      role: 'reader',
    };
    let slug: string;
    let chapterId: string;
    let service: ReturnType<typeof createCatalogService>;

    beforeAll(async () => {
      slug = VISIBLE_SLUGS[0] as string;
      const [row] = await harness.db
        .select({ id: chapter.id })
        .from(chapter)
        .innerJoin(manga, eq(manga.id, chapter.mangaId))
        .where(eq(manga.slug, asSlug(slug)))
        .limit(1);
      chapterId = row?.id ?? '';
      // `reading_progress.user_id` references `users`, so the two callers are
      // real rows rather than invented ids — the FK is part of what is under
      // test here, and a hand-written id would fail before the rules ran.
      await harness.db.insert(users).values([
        { id: READER.userId, email: 'cr-reader@catalog.test', passwordHash: 'x' },
        { id: STRANGER.userId, email: 'cr-stranger@catalog.test', passwordHash: 'x' },
      ]);
      // Written ONCE: the primary key is `(user_id, chapter_id)`, so a per-test
      // insert is a duplicate-key error rather than a second fixture.
      await harness.db.insert(readingProgress).values({
        userId: READER.userId,
        chapterId: chapterId as never,
        pageNumber: 5,
        scrollPosition: 0,
        completed: false,
        updatedAt: new Date(),
      });
      service = createCatalogService({
        manga: createMangaRepository(harness.db),
        chapters: { listByManga: async () => [] } as unknown as never,
        progress: createResumeService({ reads: createProgressPositionReader(harness.db) }),
      });
    });

    it('is absent for an anonymous caller even when progress exists', async () => {
      const detail = await service.detail(asSlug(slug), null);

      expect(detail).not.toHaveProperty('continueReading');
    });

    it('carries the position for a caller that has one', async () => {
      const detail = await service.detail(asSlug(slug), READER);

      expect(detail?.continueReading).toBeDefined();
      expect(detail?.continueReading?.pageNumber).toBe(5);
    });

    it('is absent — never null — for a caller with no progress row', async () => {
      const detail = await service.detail(asSlug(slug), STRANGER);

      expect(detail).not.toHaveProperty('continueReading');
      expect(detail?.continueReading).toBeUndefined();
    });
  });
});
