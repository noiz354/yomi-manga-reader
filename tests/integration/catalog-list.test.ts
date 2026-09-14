/**
 * Integration tests — the public catalog list against a REAL PostgreSQL.
 *
 * Driven through the real `CatalogService` over port implementations backed by
 * the real schema. Nothing is mocked: every ordering, filter and count below is
 * a fact about rows that exist in PostgreSQL.
 *
 * `beforeAll` recreates the `public` schema, so this must be a THROWAWAY
 * database on its own port; the suite SKIPS when `DATABASE_URL` is absent.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogService } from '../../src/features/catalog';
import { manga as mangaTable } from '../../src/server/db/schema';
import type { MangaRepository } from '../../src/features/manga';
import {
  FIXTURE_MANGA,
  SORT_ANCHORS,
  VISIBLE_SLUGS,
  buildCatalogListStatement,
  createPgCatalogHarness,
  mangaIdFor,
  openCatalogDatabase,
} from './support/pg-catalog-ports';
import type { OpenDatabase, PgCatalogHarness } from './support/pg-catalog-ports';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('the public catalog list on real PG', () => {
  let open: OpenDatabase;
  let harness: PgCatalogHarness;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, 'catalog_list_it');
    harness = await createPgCatalogHarness(open);
  });

  afterAll(async () => {
    await open?.close();
  });

  it('lists only published, non-deleted titles', async () => {
    const page = await harness.service.list({ limit: 48 });
    const slugs = page.items.map((item) => item.slug);
    expect(slugs).not.toContain('cat-manga-unpublished');
    expect(slugs).not.toContain('cat-manga-soft-deleted');
    expect(page.items).toHaveLength(Math.min(48, VISIBLE_SLUGS.length));
    // A join fan-out would show up here as a repeated slug.
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('reports latestChapter: null for a title with no published chapter', async () => {
    const page = await harness.service.list({ limit: 48, sort: 'title_asc' });
    const empty = page.items.find((item) => item.slug === 'cat-manga-no-chapters');
    expect(empty).toBeDefined();
    expect(empty?.latestChapter).toBeNull();
  });

  it('reports the latest published chapter and never a draft', async () => {
    const page = await harness.service.list({ limit: 48, sort: 'title_asc' });
    const target = page.items.find((item) => item.slug === 'cat-manga-0001');
    // Fixture chapters: 1 and 2 published, 3 a draft. The draft must not win.
    expect(target?.latestChapter?.number).toBe(2);
    expect(target?.latestChapter?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('narrows the exact-numeric chapter number to a JS number (ADR-003 R2)', async () => {
    const page = await harness.service.list({ limit: 48, sort: 'title_asc' });
    const target = page.items.find((item) => item.slug === 'cat-manga-decimal-draft');
    // Its published chapters are 1, 10.5, 11 — the last by reading_order is 11.
    expect(target?.latestChapter?.number).toBe(11);
    expect(typeof target?.latestChapter?.number).toBe('number');
  });

  it('sorts by title A–Z, and starts at the fixture whose title is lowest', async () => {
    const page = await harness.service.list({ limit: 10, sort: 'title_asc' });
    const titles = page.items.map((item) => item.title);
    expect(titles).toEqual([...titles].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(page.items[0]?.slug).toBe(SORT_ANCHORS.title_asc);
  });

  it('sorts by most recently updated, and defaults to it', async () => {
    const explicit = await harness.service.list({ limit: 10, sort: 'updated_desc' });
    const byDefault = await harness.service.list({ limit: 10 });
    expect(byDefault.items.map((item) => item.slug)).toEqual(
      explicit.items.map((item) => item.slug),
    );
    expect(explicit.items[0]?.slug).toBe(SORT_ANCHORS.updated_desc);
  });

  it('sorts by most recently added', async () => {
    const page = await harness.service.list({ limit: 10, sort: 'added_desc' });
    expect(page.items[0]?.slug).toBe(SORT_ANCHORS.added_desc);
  });

  it('gives the three sorts three different answers (none aliases another)', async () => {
    const orders = await Promise.all(
      (['title_asc', 'updated_desc', 'added_desc'] as const).map(async (sort) =>
        (await harness.service.list({ limit: 20, sort })).items.map((item) => item.slug),
      ),
    );
    const [byTitle, byUpdated, byAdded] = orders as unknown as [string[], string[], string[]];
    expect(byTitle).not.toEqual(byUpdated);
    expect(byUpdated).not.toEqual(byAdded);
    expect(byTitle).not.toEqual(byAdded);
  });

  it('filters by status (ongoing / completed / hiatus)', async () => {
    for (const status of ['ongoing', 'completed', 'hiatus'] as const) {
      const page = await harness.service.list({ limit: 48, status });
      expect(page.items.length, `status=${status} returned nothing`).toBeGreaterThan(0);
      expect(page.items.every((item) => item.status === status)).toBe(true);
    }
  });

  it('filters by genre slug', async () => {
    const page = await harness.service.list({ limit: 48, genres: 'drama' });
    expect(page.items.length).toBeGreaterThan(0);
    const dramaSlugs = new Set(
      FIXTURE_MANGA.filter((entry) => entry.genres.includes('Drama')).map((entry) => entry.slug),
    );
    for (const item of page.items) {
      expect(dramaSlugs.has(item.slug), `${item.slug} is not a Drama title`).toBe(true);
    }
  });

  it('unions multiple genre slugs rather than intersecting them', async () => {
    // Nothing states AND/OR. ANY-of is chosen: genre chips are a faceted nav,
    // and requiring a title to carry ALL five selected genres is not a browsing
    // affordance.
    const drama = await harness.service.list({ limit: 48, genres: 'drama' });
    const romance = await harness.service.list({ limit: 48, genres: 'romance' });
    const both = await harness.service.list({ limit: 48, genres: 'drama,romance' });
    // Compared as SETS: the union is the point, the interleaving is not.
    expect(new Set(both.items.map((item) => item.slug))).toEqual(
      new Set([...drama.items, ...romance.items].map((item) => item.slug)),
    );
  });

  it('combines both filters', async () => {
    const page = await harness.service.list({
      limit: 48,
      status: 'ongoing',
      genres: 'action,romance',
    });
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.status).toBe('ongoing');
      const fixture = FIXTURE_MANGA.find((entry) => entry.slug === item.slug);
      expect(
        fixture?.genres.some((genre) => genre === 'Action' || genre === 'Romance'),
        `${item.slug} matches neither genre`,
      ).toBe(true);
    }
  });

  it('ignores a wholly unknown genre slug instead of failing (task edge case)', async () => {
    const unfiltered = await harness.service.list({ limit: 48 });
    const unknown = await harness.service.list({ limit: 48, genres: 'no-such-genre' });
    // Not a 422, not an empty page: exactly the unfiltered page.
    expect(unknown.items.map((item) => item.slug)).toEqual(
      unfiltered.items.map((item) => item.slug),
    );
    expect(unknown.nextCursor).toBe(unfiltered.nextCursor);
  });

  it('ignores an unknown slug sitting next to a real one', async () => {
    const onlyAction = await harness.service.list({ limit: 48, genres: 'action' });
    const withNoise = await harness.service.list({ limit: 48, genres: 'no-such-genre,action' });
    expect(withNoise.items.map((item) => item.slug)).toEqual(
      onlyAction.items.map((item) => item.slug),
    );
  });

  it('switches the filter off entirely when NO requested slug exists', async () => {
    // The precise reading of "ignored if not": an all-unknown csv must not
    // degrade into "matches nothing", which is what a naive `IN ()` would do.
    const unknownOnly = await harness.service.list({ limit: 48, genres: 'ghost-one,ghost-two' });
    const unfiltered = await harness.service.list({ limit: 48 });
    expect(unknownOnly.items).toHaveLength(unfiltered.items.length);
  });

  it('returns an empty page and a null cursor when combined filters yield 0', async () => {
    // `Horror` is carried only by the UNPUBLISHED fixture, so no visible title
    // can match it — a real "combined filters yielding 0", not a synthetic
    // empty table.
    const page = await harness.service.list({ limit: 48, status: 'completed', genres: 'horror' });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('walks every visible title exactly once across the pages', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await harness.service.list({
        limit: 7,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.items.map((item) => item.slug));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages, 'pagination did not terminate').toBeLessThan(50);
    } while (cursor !== undefined);
    expect(seen).toHaveLength(VISIBLE_SLUGS.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...VISIBLE_SLUGS].sort());
  });

  it('paginates identically under every sort', async () => {
    for (const sort of ['title_asc', 'updated_desc', 'added_desc'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let guard = 0;
      do {
        const page = await harness.service.list({
          limit: 9,
          sort,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((item) => item.slug));
        cursor = page.nextCursor ?? undefined;
        guard += 1;
        expect(guard, `${sort} pagination did not terminate`).toBeLessThan(50);
      } while (cursor !== undefined);
      expect(new Set(seen).size, `${sort} duplicated or lost a row`).toBe(VISIBLE_SLUGS.length);
    }
  });

  it('is unmoved by a row inserted mid-walk (keyset, not offset)', async () => {
    const first = await harness.service.list({ limit: 5, sort: 'title_asc' });
    const before = new Set(VISIBLE_SLUGS);
    // A title that sorts BEFORE every seeded title. A keyset walk from the
    // existing cursor can never see it, so the walk's coverage is unchanged —
    // an OFFSET walk would have shifted by one and dropped a row.
    await harness.db.insert(mangaTable).values({
      id: mangaIdFor('cat-manga-aaa-concurrent'),
      slug: 'cat-manga-aaa-concurrent',
      title: 'AAA Concurrent Insert',
      synopsis: 'Synthetic concurrent-insert fixture. Not product content.',
      status: 'ongoing',
      readingDirection: 'rtl',
      published: true,
      coverAssetKey: null,
    });

    const seen = [...first.items.map((item) => item.slug)];
    let cursor = first.nextCursor ?? undefined;
    let guard = 0;
    while (cursor !== undefined && guard < 50) {
      const page = await harness.service.list({ limit: 5, sort: 'title_asc', cursor });
      seen.push(...page.items.map((item) => item.slug));
      cursor = page.nextCursor ?? undefined;
      guard += 1;
    }
    expect(new Set(seen).size, 'the walk repeated a row').toBe(seen.length);
    expect(seen).not.toContain('cat-manga-aaa-concurrent');
    expect([...seen].sort()).toEqual([...before].sort());

    // A FRESH first page does see it — the row is not invisible, the walk is
    // simply anchored where it was.
    const fresh = await harness.service.list({ limit: 5, sort: 'title_asc' });
    expect(fresh.items[0]?.slug).toBe('cat-manga-aaa-concurrent');
  });

  it('computes latestChapter with exactly ONE statement for a 24-row page', async () => {
    harness.probe.reset();
    const page = await harness.service.list({ limit: 24 });
    const statements = harness.probe.since();
    expect(page.items).toHaveLength(24);
    expect(statements).toHaveLength(1);
    // …and that one statement carries the latest-chapter read inline.
    expect(statements[0]?.text).toMatch(/from "chapter"/);
    expect(statements[0]?.text).toMatch(/order by c\.reading_order desc/);
  });

  it('still issues exactly ONE statement for a 1-row page and for a 0-row page', async () => {
    harness.probe.reset();
    await harness.service.list({ limit: 1 });
    expect(harness.probe.since()).toHaveLength(1);
    harness.probe.reset();
    await harness.service.list({ limit: 48, status: 'completed', genres: 'horror' });
    expect(harness.probe.since()).toHaveLength(1);
  });

  it('issues exactly ONE statement with a filter, a status and a cursor', async () => {
    const first = await harness.service.list({
      limit: 5,
      genres: 'action,drama',
      status: 'ongoing',
    });
    harness.probe.reset();
    await harness.service.list({
      limit: 5,
      genres: 'action,drama',
      status: 'ongoing',
      cursor: first.nextCursor ?? undefined,
    });
    const statements = harness.probe.since();
    expect(statements).toHaveLength(1);
    // The genre slugs and the status travel as BOUND VALUES, never as text.
    // The driver's `debug` hook reports parameters already
    // encoded for the wire, so a boolean arrives as `t` — the assertion is
    // about the strings, which is where an injection payload would show up.
    expect(statements[0]?.parameters).toEqual(
      expect.arrayContaining(['ongoing', 'action', 'drama']),
    );
    expect(statements[0]?.text).not.toMatch(/'action'|'drama'|'ongoing'/);
  });

  it('emits a single statement — no statement separator anywhere in it', () => {
    const built = buildCatalogListStatement(harness.db, {
      limit: 24,
      genres: ['action'],
      status: 'ongoing',
      sort: 'updated_desc',
    }).toSQL();
    expect(built.sql).not.toMatch(/;\s*\S/);
    expect(built.sql).toMatch(/^select /);
    // Every value is a placeholder; the count of placeholders equals the
    // parameter count, so nothing was inlined.
    expect((built.sql.match(/\$\d+/g) ?? []).length).toBe(built.params.length);
  });

  it('the probe WOULD see an N+1 (control: a deliberately per-manga read)', async () => {
    // Without this control "one statement" could just mean the probe is blind.
    const ids = await harness.db
      .select({ id: mangaTable.id })
      .from(mangaTable)
      .where(eq(mangaTable.published, true))
      .limit(5);
    expect(ids).toHaveLength(5);
    harness.probe.reset();
    for (const row of ids) {
      // The N+1 shape, deliberately: one round trip per manga.

      await harness.db
        .select({ id: mangaTable.id })
        .from(mangaTable)
        .where(eq(mangaTable.id, row.id));
    }
    expect(harness.probe.since()).toHaveLength(ids.length);
  });

  it('calls MangaRepository.list once and bySlug zero times for a list request', async () => {
    const calls: string[] = [];
    const counting = {
      ...harness.manga,
      list: async (query: Parameters<MangaRepository['list']>[0]) => {
        calls.push('list');
        return harness.manga.list(query);
      },
      bySlug: async (slug: never, caller: never) => {
        calls.push('bySlug');
        return harness.manga.bySlug(slug, caller);
      },
    } as MangaRepository;
    const service = createCatalogService({
      manga: counting,
      chapters: harness.chapters as never,
      progress: { latestForManga: async () => null },
    });
    const page = await service.list({ limit: 24 });
    expect(page.items).toHaveLength(24);
    expect(calls).toEqual(['list']);
  });
});
