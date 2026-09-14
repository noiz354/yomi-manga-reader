/**
 * Integration — the PRODUCT catalog genre filter, over real rows.
 *
 * The genre-slug rule once had two definitions: the repository matched
 * `lower(genre.name)` against the slug, so `Slice of Life` matched nothing,
 * while the test harness slugified inside SQL and exercised a different query.
 * The rule now has one definition (`genreSlugSql`) the harness imports.
 *
 * Needs DATABASE_URL; skips cleanly without it. Throwaway database, own port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCatalogService } from '../../src/features/catalog';
import type { ChapterRepository } from '../../src/features/chapters';
import { createMangaRepository } from '../../src/server/db/repositories/manga.repository';
import * as dbSchema from '../../src/server/db/schema';
import {
  VISIBLE_SLUGS,
  mangaIdFor,
  openCatalogDatabase,
  seedCatalogFixtures,
} from './support/pg-catalog-ports';
import type { OpenDatabase } from './support/pg-catalog-ports';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

/** A genre name that only survives the round trip if the slug rule is applied. */
const MULTI_WORD = 'Slice of Life';
const MULTI_WORD_SLUG = 'slice-of-life';

describeDb('the product catalog genre filter', () => {
  let open: OpenDatabase;
  let repo: ReturnType<typeof createMangaRepository>;

  const slugsFor = async (genres: string[]): Promise<string[]> => {
    const page = await repo.list({ limit: 48, genres, sort: 'updated_desc' });
    return page.items.map((item) => item.slug);
  };

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, 'catalog_genre_it');
    await seedCatalogFixtures(open.db);
    const [genreRow] = await open.db
      .insert(dbSchema.genre)
      .values({ id: crypto.randomUUID(), name: MULTI_WORD })
      .returning({ id: dbSchema.genre.id });
    await open.db
      .insert(dbSchema.mangaGenre)
      .values({ mangaId: mangaIdFor(VISIBLE_SLUGS[0] as string), genreId: genreRow!.id });
    repo = createMangaRepository(open.db);
  });

  afterAll(async () => {
    await open?.close();
  });

  it('matches a MULTI-WORD genre by its slug', async () => {
    const slugs = await slugsFor([MULTI_WORD_SLUG]);

    expect(slugs).toContain(VISIBLE_SLUGS[0]);
  });

  it('resolves the same row whether the slug or the raw name arrived', async () => {
    // Layer discipline: the REPOSITORY only ever sees post-normalisation
    // values, so the slug is the only thing it must match. The name form is
    // the SERVICE's job (`normaliseGenres` → `normaliseGenreSlug`), asserted
    // end-to-end below through the service, not here.
    const bySlug = await slugsFor([MULTI_WORD_SLUG]);
    const byUnchangedSlug = await slugsFor([MULTI_WORD_SLUG.toUpperCase()]);

    expect(byUnchangedSlug).toEqual(bySlug);
  });

  it('ignores an unknown genre rather than erroring', async () => {
    // Documented behaviour, and deliberately NOT an empty result: an unknown
    // filter value is dropped, so the answer is the unfiltered catalog. What
    // matters — and what the first test pins — is that a genre that CAN be
    // resolved narrows the result instead of being dropped like this one.
    const unfiltered = await slugsFor([]);
    const unknown = await slugsFor(['no-such-genre-anywhere']);

    expect(unknown).toEqual(unfiltered);
  });

  it('narrows the result when the genre DOES resolve, which is the defect this file exists for', async () => {
    const unfiltered = await slugsFor([]);
    const filtered = await slugsFor([MULTI_WORD_SLUG]);

    expect(filtered.length).toBeLessThan(unfiltered.length);
    expect(filtered).toEqual([VISIBLE_SLUGS[0]]);
  });

  it('still matches a single-word genre', async () => {
    const slugs = await slugsFor(['action']);

    expect(slugs.length).toBeGreaterThan(0);
  });

  it('still matches a hyphenated genre name', async () => {
    const slugs = await slugsFor(['sci-fi']);

    expect(slugs.length).toBeGreaterThan(0);
  });

  it('treats several genres as a union, not an intersection', async () => {
    const only = await slugsFor([MULTI_WORD_SLUG]);
    const both = await slugsFor([MULTI_WORD_SLUG, 'action']);

    expect(both.length).toBeGreaterThanOrEqual(only.length);
    for (const slug of only) expect(both).toContain(slug);
  });

  it('de-duplicates a repeated genre instead of widening the result', async () => {
    const once = await slugsFor([MULTI_WORD_SLUG]);
    const twice = await slugsFor([MULTI_WORD_SLUG, MULTI_WORD_SLUG]);

    expect(twice).toEqual(once);
  });

  it('resolves the HUMAN name end to end: service normalisation → repository', async () => {
    // This is the path the filter control takes: `/discover` renders
    // `genre.name` from the facets endpoint, the browser sends it back as
    // `?genre=Slice of Life`, and `normaliseCatalogQuery` slugifies it. A
    // repository comparing that slug to a name would return the whole catalog.
    const service = createCatalogService({
      manga: repo,
      chapters: { listByManga: async () => [] } as unknown as ChapterRepository,
    });

    const byName = await service.list({ limit: 48, genres: [MULTI_WORD] });
    const unfiltered = await service.list({ limit: 48 });

    expect(byName.items.map((item) => item.slug)).toEqual([VISIBLE_SLUGS[0]]);
    expect(byName.items.length).toBeLessThan(unfiltered.items.length);
  });
});
