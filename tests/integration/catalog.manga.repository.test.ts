/**
 * Integration tests — MangaRepository against a REAL PostgreSQL 18.
 *
 * Every expectation reads rows back out of a migrated database, and the EXPLAIN
 * assertions read the planner's own output — nothing asserts against a
 * TypeScript type. Every title, synopsis, alias, creator and genre name here is
 * generated test data.
 *
 * DSN: `DATABASE_URL`. SKIPS (never silently passes) when absent:
 *   docker run -d --name yomi-cat -e POSTGRES_USER=yomi -e POSTGRES_PASSWORD=yomi \
 *     -e POSTGRES_DB=yomi -p 55440:5432 postgres:18.6-bookworm
 *   DATABASE_URL=postgres://yomi:yomi@127.0.0.1:55440/yomi \
 *     npx vitest run tests/integration/catalog.manga.repository.test.ts
 *
 * SAFETY: `beforeEach` TRUNCATEs every table — point this suite at a THROWAWAY
 * database, and never at the same database as a suite that seeds
 * (`vitest.config.ts` runs integration files in one fork).
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createChapterRepository,
  createMangaRepository,
} from '../../src/server/db/repositories/index';
import { buildCatalogListQuery } from '../../src/server/db/repositories/manga.repository';
import {
  MANGA_VISIBILITY_CLAUSES,
  isMangaVisible,
  type CatalogQuery,
  type MangaRepository,
} from '../../src/features/manga';
import { AppError } from '../../src/shared/contracts/errors';
import type { CallerContext } from '../../src/shared/contracts';
import type { MangaId, MangaSlug, UserId } from '../../src/shared/types';
import { describeDb, explain, openHarness, type Harness } from './catalog.db-harness';

const ADMIN: CallerContext = {
  userId: '01930000-0000-7000-8000-0000000000ad' as UserId,
  role: 'admin',
};
const READER: CallerContext = {
  userId: '01930000-0000-7000-8000-0000000000ad' as UserId,
  role: 'reader',
};

describeDb('MangaRepository on a real PostgreSQL 18', () => {
  let harness: Harness;
  let manga: MangaRepository;
  /** Slug written for each fixture id, so `bySlug` can be addressed. */
  const slugs = new Map<MangaId, MangaSlug>();
  let counter = 0;

  beforeAll(async () => {
    harness = await openHarness('manga');
    manga = createMangaRepository(harness.db);
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.reset();
    slugs.clear();
    counter = 0;
  });

  /** A valid `create()` input, overridden per test. */
  const draftInput = (
    over: Partial<Parameters<MangaRepository['create']>[0]> = {},
  ): Parameters<MangaRepository['create']>[0] => ({
    title: 'Generated Title',
    slug: `created-${counter++}` as MangaSlug,
    synopsis: '',
    status: 'ongoing',
    readingDirection: 'rtl',
    aliases: [],
    genreIds: [],
    tagIds: [],
    creators: [],
    ...over,
  });

  describe('the visibility rule (features/manga — the single definition)', () => {
    it('is published && not deleted, and nothing else', () => {
      expect(isMangaVisible({ published: true, deletedAt: null })).toBe(true);
      expect(isMangaVisible({ published: false, deletedAt: null })).toBe(false);
      expect(isMangaVisible({ published: true, deletedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
      expect(isMangaVisible({ published: false, deletedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
    });

    it('is stated as exactly the two axes, in one clause list', () => {
      expect(MANGA_VISIBILITY_CLAUSES).toEqual([
        { column: 'published', equals: true },
        { column: 'deletedAt', equals: null },
      ]);
    });

    it('agrees, row for row, with the SQL the repository emits', async () => {
      // The repository may not re-decide the rule in SQL, so its predicate must
      // be a RENDERING of `isMangaVisible`. This asserts that equivalence over
      // real rows instead of trusting the comment.
      for (const [published, deleted] of [
        [true, false],
        [true, true],
        [false, false],
        [false, true],
      ] as const) {
        await createManga(harness, slugs, { published, deleted });
      }
      const rows = await harness.sql<
        { id: string; published: boolean; deleted_at: Date | null }[]
      >`select id, published, deleted_at from manga order by published desc, deleted_at nulls last`;
      expect(rows).toHaveLength(4);

      const asRuleInput = (row: { published: boolean; deleted_at: Date | null }) => ({
        published: row.published,
        deletedAt: row.deleted_at === null ? null : row.deleted_at.toISOString(),
      });
      const jsVisible = rows.filter((row) => isMangaVisible(asRuleInput(row)));
      expect(jsVisible).toHaveLength(1);

      for (const row of rows) {
        const { visible } = one(
          await harness.sql<{ visible: boolean }[]>`
            select (manga.published = true and manga.deleted_at is null) as visible
            from manga where manga.id = ${row.id}
          `,
          `visibility probe for ${row.id}`,
        );
        expect(visible).toBe(isMangaVisible(asRuleInput(row)));
      }

      // …and the repository's own filter returns exactly that same set.
      const listed = new Set((await manga.list({})).items.map((item) => item.id as string));
      expect(listed).toEqual(new Set(jsVisible.map((row) => row.id as MangaId)));
    });
  });

  describe('list() — the catalog hot path', () => {
    it('returns only published, non-deleted manga', async () => {
      const visible = await createManga(harness, slugs, { published: true });
      const draft = await createManga(harness, slugs, { published: false });
      const removed = await createManga(harness, slugs, { published: true, deleted: true });

      const found = (await manga.list({})).items.map((item) => item.id);
      expect(found).toContain(visible);
      expect(found).not.toContain(draft);
      expect(found).not.toContain(removed);
    });

    it('includes a manga with zero chapters, with latestChapter null', async () => {
      const id = await createManga(harness, slugs, { published: true });
      const item = (await manga.list({})).items.find((entry) => entry.id === id);
      expect(item).toBeDefined();
      expect(item?.latestChapter).toBeNull();
      expect(item?.coverUrl).toBeNull();
    });

    it('reports the latest PUBLISHED chapter and never a draft', async () => {
      const mangaId = await createManga(harness, slugs, { published: true });
      const chapters = createChapterRepository(harness.db);
      const published = await chapters.create({ mangaId, number: 1, title: 'one', notes: '' });
      await chapters.setPublished(published, true);
      await chapters.create({ mangaId, number: 2, title: 'draft two', notes: '' });

      const item = (await manga.list({})).items.find((entry) => entry.id === mangaId);
      expect(item?.latestChapter?.title).toBe('one');
      expect(item?.latestChapter?.number).toBe(1);
    });

    it('builds an app-relative cover URL, never a storage URL', async () => {
      const id = await createManga(harness, slugs, { published: true });
      await manga.setCover(id, 'abcdef0123456789abcdef0123456789');
      const item = (await manga.list({})).items.find((entry) => entry.id === id);
      // The JPEG delivery URL for the stored base key: the extension selects
      // the variant the delivery grammar requires.
      expect(item?.coverUrl).toBe('/media/abcdef0123456789abcdef0123456789.jpeg');
    });

    it('honours the status filter', async () => {
      const ongoing = await createManga(harness, slugs, { published: true, status: 'ongoing' });
      const completed = await createManga(harness, slugs, { published: true, status: 'completed' });
      const found = (await manga.list({ status: 'completed' })).items.map((item) => item.id);
      expect(found).toEqual([completed]);
      expect(found).not.toContain(ongoing);
    });

    it('ignores an unknown genre slug instead of erroring (edge case)', async () => {
      const id = await createManga(harness, slugs, { published: true });
      const found = (await manga.list({ genres: ['no-such-genre'] })).items.map((item) => item.id);
      expect(found).toContain(id);
    });

    it('filters by genre case-insensitively, for ANY of the selected genres', async () => {
      const [action, drama] = genrePair(await insertGenres(harness, ['Action', 'Drama']));
      const tagged = await createManga(harness, slugs, { published: true, genreIds: [action] });
      const other = await createManga(harness, slugs, { published: true, genreIds: [drama] });
      const untagged = await createManga(harness, slugs, { published: true });

      const found = (await manga.list({ genres: ['action', 'DRAMA'] })).items.map((i) => i.id);
      expect(found.sort()).toEqual([tagged, other].sort());
      expect(found).not.toContain(untagged);
    });

    it('caps the page at 48 and defaults to 24', async () => {
      for (let index = 0; index < 60; index += 1) await createManga(harness, slugs, { published: true });
      expect((await manga.list({})).items).toHaveLength(24);
      expect((await manga.list({ limit: 48 })).items).toHaveLength(48);
      expect((await manga.list({ limit: 500 })).items).toHaveLength(48);
    });
  });

  describe('sorts (the EXPLAIN gate)', () => {
    it('title_asc orders by title', async () => {
      const bravo = await createManga(harness, slugs, { published: true, title: 'Bravo' });
      const alpha = await createManga(harness, slugs, { published: true, title: 'Alpha' });
      const charlie = await createManga(harness, slugs, { published: true, title: 'Charlie' });
      const found = (await manga.list({ sort: 'title_asc' })).items.map((item) => item.id);
      expect(found).toEqual([alpha, bravo, charlie]);
    });

    it('added_desc orders by createdAt, newest first', async () => {
      const first = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
      });
      const second = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-02-01T00:00:00Z',
      });
      const found = (await manga.list({ sort: 'added_desc' })).items.map((item) => item.id);
      expect(found).toEqual([second, first]);
    });

    it('updated_desc is the default and orders by updatedAt, newest first', async () => {
      const stale = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
      const fresh = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-03-01T00:00:00Z',
      });
      expect((await manga.list({})).items.map((i) => i.id)).toEqual([fresh, stale]);
      expect((await manga.list({ sort: 'updated_desc' })).items.map((i) => i.id)).toEqual([
        fresh,
        stale,
      ]);
    });

    it('every sort is a total order, so a tie on the sort key cannot reshuffle a page', async () => {
      // Three rows share one updated_at: without the `id` tiebreaker the order
      // among them is unspecified and a cursor could skip or repeat one.
      const same = '2026-05-05T05:05:05Z';
      const ids: MangaId[] = [];
      for (const name of ['a', 'b', 'c']) {
        ids.push(
          await createManga(harness, slugs, { published: true, title: `Tie ${name}`, updatedAt: same, createdAt: same }),
        );
      }
      const page1 = await manga.list({ sort: 'updated_desc', limit: 2 });
      const page2 = await manga.list({
        sort: 'updated_desc',
        limit: 2,
        cursor: page1.nextCursor as string,
      });
      const walked = [...page1.items, ...page2.items].map((item) => item.id);
      expect(new Set(walked).size).toBe(3);
      expect(walked).toEqual([...ids].sort().reverse());
    });
  });

  describe('keyset cursor stability (edge case)', () => {
    it('a row inserted BETWEEN pages neither skips nor repeats anything', async () => {
      // Six titles whose updatedAt FALLS with the name, so the catalog order
      // (`updated_desc`, newest first) is known: a, b, c, d, e, f.
      const seeded: MangaId[] = [];
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
        seeded.push(
          await createManga(harness, slugs, {
            published: true,
            title: `Keyset ${name}`,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: `2026-01-0${6 - 'abcdef'.indexOf(name)}T00:00:00Z`,
          }),
        );
      }

      const page1 = await manga.list({ sort: 'updated_desc', limit: 2 });
      expect(page1.items.map((i) => i.title)).toEqual(['Keyset a', 'Keyset b']);
      expect(page1.nextCursor).not.toBeNull();

      // A concurrent insert BETWEEN the page-1 tail and the page-2 head: its
      // updatedAt sits strictly between `b` (01-05) and `c` (01-04), so under
      // this cursor it is the very next row the traversal reaches.
      const concurrent = await createManga(harness, slugs, {
        published: true,
        title: 'Keyset g',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-04T12:00:00Z',
      });

      const page2 = await manga.list({
        sort: 'updated_desc',
        limit: 2,
        cursor: page1.nextCursor as string,
      });
      // The new row appears exactly once, in the page the cursor points at.
      expect(page2.items.map((i) => i.title)).toEqual(['Keyset g', 'Keyset c']);

      const page3 = await manga.list({
        sort: 'updated_desc',
        limit: 2,
        cursor: page2.nextCursor as string,
      });
      expect(page3.items.map((i) => i.title)).toEqual(['Keyset d', 'Keyset e']);

      const page4 = await manga.list({
        sort: 'updated_desc',
        limit: 2,
        cursor: page3.nextCursor as string,
      });
      expect(page4.items.map((i) => i.title)).toEqual(['Keyset f']);
      expect(page4.nextCursor).toBeNull();

      // Nothing is skipped and nothing is repeated: the six original titles all
      // appear, and the seventh appears once.
      const walked = [...page1.items, ...page2.items, ...page3.items, ...page4.items].map(
        (i) => i.title,
      );
      expect(new Set(walked).size).toBe(7);
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) expect(walked).toContain(`Keyset ${name}`);
      const slugsSeen = [...page1.items, ...page2.items, ...page3.items, ...page4.items].map(
        (i) => i.slug,
      );
      expect(new Set(slugsSeen).size).toBe(7);
      expect(slugsSeen).toContain(slugs.get(concurrent));
      for (const id of seeded) expect(slugsSeen).toContain(slugs.get(id));
    });

    it('a row inserted AFTER the page leaves the next page unchanged', async () => {
      const older = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
      const newer = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      });
      const page1 = await manga.list({ sort: 'updated_desc', limit: 1 });
      expect(page1.items.map((i) => i.id)).toEqual([newer]);
      await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2025-12-31T00:00:00Z',
      });
      const page2 = await manga.list({
        sort: 'updated_desc',
        limit: 1,
        cursor: page1.nextCursor as string,
      });
      expect(page2.items.map((i) => i.id)).toEqual([older]);
    });

    it('a row inserted BEFORE the page does not shift it (no offset drift)', async () => {
      const older = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
      const newer = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      });
      const page1 = await manga.list({ sort: 'updated_desc', limit: 1 });
      expect(page1.items.map((i) => i.id)).toEqual([newer]);
      // Sorts BEFORE the page-1 head — the row an OFFSET page 2 would miss.
      await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      });
      const page2 = await manga.list({
        sort: 'updated_desc',
        limit: 1,
        cursor: page1.nextCursor as string,
      });
      expect(page2.items.map((i) => i.id)).toEqual([older]);
    });

    it('returns a null cursor on the last page, never a phantom one', async () => {
      await createManga(harness, slugs, { published: true });
      const page = await manga.list({ limit: 10 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeNull();
    });

    it('an empty result is `{ items: [], nextCursor: null }` (edge case)', async () => {
      expect(await manga.list({ status: 'hiatus' })).toEqual({ items: [], nextCursor: null });
    });

    it('rejects a cursor minted for another sort, and a malformed one (CATALOG_PAGE_INVALID)', async () => {
      for (let index = 0; index < 3; index += 1) await createManga(harness, slugs, { published: true });
      const page = await manga.list({ sort: 'updated_desc', limit: 1 });
      await expect(
        manga.list({ sort: 'title_asc', limit: 1, cursor: page.nextCursor as string }),
      ).rejects.toThrowError(/^Invalid pagination\.$/);
      await expect(manga.list({ cursor: 'not-a-cursor' })).rejects.toThrowError(AppError);
    });
  });

  describe('adminList()', () => {
    it('includes drafts but NOT soft-deleted rows by default', async () => {
      const visible = await createManga(harness, slugs, { published: true });
      const draft = await createManga(harness, slugs, { published: false });
      const removed = await createManga(harness, slugs, { published: true, deleted: true });

      const found = (await manga.adminList({})).items.map((item) => item.id);
      expect(found).toContain(visible);
      expect(found).toContain(draft);
      expect(found).not.toContain(removed);
    });

    it('includes soft-deleted rows only for the includeDeleted flag', async () => {
      const removed = await createManga(harness, slugs, { published: true, deleted: true });
      const found = (await manga.adminList({ includeDeleted: true })).items.map((item) => item.id);
      expect(found).toContain(removed);
    });

    it('returns full MangaDetail rows, not summaries', async () => {
      const id = await createManga(harness, slugs, {
        published: true,
        deleted: true,
        synopsis: 'A generated synopsis.',
      });
      const fantasy = genreOne(await insertGenres(harness, ['Fantasy']));
      await harness.sql`insert into tag (name) values ('seinen') on conflict do nothing`;
      const tag = tagId(
        one(await harness.sql<{ id: string }[]>`select id from tag where name = 'seinen'`, 'the seinen tag'),
      );
      await manga.update(id, {
        aliases: ['Alt One', 'Alt Two'],
        genreIds: [fantasy],
        tagIds: [tag],
        creators: [
          { name: 'Penciller', role: 'artist' },
          { name: 'Writer', role: 'author' },
        ],
      });

      const detail = (await manga.adminList({ includeDeleted: true })).items.find((e) => e.id === id);
      expect(detail?.synopsis).toBe('A generated synopsis.');
      expect([...(detail?.aliases ?? [])].sort()).toEqual(['Alt One', 'Alt Two']);
      expect(detail?.genres).toEqual([{ id: fantasy, name: 'Fantasy' }]);
      expect(detail?.tags).toEqual([{ id: tag, name: 'seinen' }]);
      expect(detail?.creators.map((c) => [c.name, c.role])).toEqual([
        ['Penciller', 'artist'],
        ['Writer', 'author'],
      ]);
      for (const creator of detail?.creators ?? []) {
        expect(creator.id).toMatch(/^[0-9a-f-]{36}$/);
      }
      expect(detail?.chapterCount).toBe(0);
      expect(detail?.firstChapter).toBeNull();
      expect(detail?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(detail?.readingDirection).toBe('rtl');
    });
  });

  describe('bySlug()', () => {
    it('returns the detail for a visible manga to an anonymous caller', async () => {
      const id = await createManga(harness, slugs, { published: true });
      expect((await manga.bySlug(slugs.get(id) as MangaSlug, null))?.id).toBe(id);
    });

    it('is null for a draft to a non-admin (the visibility rule, applied)', async () => {
      const id = await createManga(harness, slugs, { published: false });
      const slug = slugs.get(id) as MangaSlug;
      expect(await manga.bySlug(slug, null)).toBeNull();
      expect(await manga.bySlug(slug, READER)).toBeNull();
    });

    it('is NOT null for a draft to an admin (drafts are admin-readable)', async () => {
      const id = await createManga(harness, slugs, { published: false });
      expect(await manga.bySlug(slugs.get(id) as MangaSlug, ADMIN)).not.toBeNull();
    });

    it('is null for a soft-deleted manga to EVERYONE', async () => {
      const id = await createManga(harness, slugs, { published: true, deleted: true });
      const slug = slugs.get(id) as MangaSlug;
      expect(await manga.bySlug(slug, null)).toBeNull();
      expect(await manga.bySlug(slug, ADMIN)).toBeNull();
    });

    it('is null for an unknown slug', async () => {
      expect(await manga.bySlug('nothing-here' as MangaSlug, null)).toBeNull();
    });

    it('reports chapterCount, firstChapter and latestChapter in reading order', async () => {
      const id = await createManga(harness, slugs, { published: true });
      const chapters = createChapterRepository(harness.db);
      const first = await chapters.create({ mangaId: id, number: 1, title: 'first', notes: '' });
      await chapters.create({ mangaId: id, number: 2, title: 'second', notes: '' });
      for (const chapter of await chapters.listByManga(id, ADMIN)) {
        await chapters.setPublished(chapter.id, true);
      }
      const detail = await manga.bySlug(slugs.get(id) as MangaSlug, null);
      expect(detail?.chapterCount).toBe(2);
      expect(detail?.firstChapter).toEqual({ id: String(first), number: 1 });
      expect(detail?.latestChapter?.title).toBe('second');
    });
  });

  describe('create / update / setPublished / softDelete / restore / count', () => {
    it('create() writes the row and every link, and is readable straight back', async () => {
      const action = genreOne(await insertGenres(harness, ['Action']));
      await harness.sql`insert into tag (name) values ('long-running') on conflict do nothing`;
      const tag = tagId(
        one(
          await harness.sql<{ id: string }[]>`select id from tag where name = 'long-running'`,
          'the long-running tag',
        ),
      );
      const slug = `created-${counter++}`;
      const id = await manga.create(
        draftInput({
          title: 'Generated Title',
          slug: slug as MangaSlug,
          synopsis: 'Generated synopsis.',
          readingDirection: 'ltr',
          aliases: ['Alt'],
          genreIds: [action],
          tagIds: [tag],
          creators: [{ name: 'Writer', role: 'author' }],
        }),
      );
      const detail = await manga.bySlug(slug as MangaSlug, ADMIN);
      expect(detail?.id).toBe(id);
      expect(detail?.readingDirection).toBe('ltr');
      expect(detail?.aliases).toEqual(['Alt']);
      expect(detail?.genres).toEqual([{ id: action, name: 'Action' }]);
      expect(detail?.tags).toEqual([{ id: tag, name: 'long-running' }]);
      expect(detail?.creators.map((c) => [c.name, c.role])).toEqual([['Writer', 'author']]);
      for (const creator of detail?.creators ?? []) {
        expect(creator.id).toMatch(/^[0-9a-f-]{36}$/);
      }
    });

    it('create() leaves the title a DRAFT until setPublished', async () => {
      const id = await manga.create(draftInput({ slug: `draft-${counter++}` as MangaSlug }));
      expect((await manga.list({})).items.map((i) => i.id)).not.toContain(id);
      await manga.setPublished(id, true);
      expect((await manga.list({})).items.map((i) => i.id)).toContain(id);
    });

    it('create() rejects a duplicate slug with MANGA_SLUG_TAKEN (409)', async () => {
      const input = draftInput({ slug: 'dup-slug' as MangaSlug });
      await manga.create(input);
      await expect(manga.create(input)).rejects.toThrowError(/^Slug already in use\.$/);
    });

    it('create() upserts a creator by NAME, so a second manga reuses the row', async () => {
      const creators = [{ name: 'Shared Writer', role: 'author' as const }];
      const first = await manga.create(draftInput({ slug: 'creator-a' as MangaSlug, creators }));
      const second = await manga.create(draftInput({ slug: 'creator-b' as MangaSlug, creators }));
      expect(first).not.toBe(second);
      const a = await manga.bySlug('creator-a' as MangaSlug, ADMIN);
      const b = await manga.bySlug('creator-b' as MangaSlug, ADMIN);
      expect(a?.creators[0]?.id).toBe(b?.creators[0]?.id);
    });

    it('update() applies a partial patch and replaces only the link sets it names', async () => {
      const id = await createManga(harness, slugs, { published: true });
      await manga.update(id, { title: 'Patched Title', aliases: ['Kept', 'Old'] });
      const after = await manga.bySlug(slugs.get(id) as MangaSlug, ADMIN);
      expect(after?.title).toBe('Patched Title');
      expect([...(after?.aliases ?? [])].sort()).toEqual(['Kept', 'Old']);

      await manga.update(id, { aliases: ['Only'] });
      const replaced = await manga.bySlug(slugs.get(id) as MangaSlug, ADMIN);
      expect(replaced?.aliases).toEqual(['Only']);
      // A field the patch does not name is untouched, not emptied.
      expect(replaced?.title).toBe('Patched Title');
    });

    it('update() moves the title to the front of the updated catalog (updated_at bump)', async () => {
      const older = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      });
      const newer = await createManga(harness, slugs, {
        published: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      });
      expect((await manga.list({})).items.map((i) => i.id)).toEqual([newer, older]);
      await manga.update(older, { synopsis: 'Touched.' });
      expect((await manga.list({})).items.map((i) => i.id)).toEqual([older, newer]);
    });

    it('softDelete() is idempotent — one timestamp, however often it is called', async () => {
      const id = await createManga(harness, slugs, { published: true });
      await manga.softDelete(id);
      const first = await deletedAtOf(harness, id);
      expect(first).toBeInstanceOf(Date);
      await manga.softDelete(id);
      expect(await deletedAtOf(harness, id)).toEqual(first);
      expect((await manga.list({})).items.map((i) => i.id)).not.toContain(id);
    });

    it('restore() un-hides a soft-deleted title', async () => {
      const id = await createManga(harness, slugs, { published: true, deleted: true });
      await manga.restore(id);
      expect(await deletedAtOf(harness, id)).toBeNull();
      expect((await manga.list({})).items.map((i) => i.id)).toContain(id);
    });

    it('setCover() writes and clears the cover key', async () => {
      const id = await createManga(harness, slugs, { published: true });
      const slug = slugs.get(id) as MangaSlug;
      await manga.setCover(id, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect((await manga.bySlug(slug, null))?.coverUrl).toBe(
        '/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpeg',
      );
      await manga.setCover(id, null);
      expect((await manga.bySlug(slug, null))?.coverUrl).toBeNull();
    });

    it('count() counts every row, soft-deleted included (stats)', async () => {
      expect(await manga.count()).toBe(0);
      await createManga(harness, slugs, { published: true });
      await createManga(harness, slugs, { published: false });
      await createManga(harness, slugs, { published: true, deleted: true });
      expect(await manga.count()).toBe(3);
    });
  });

  describe('parameterised only', () => {
    it('a SQL payload in a title, alias, status or genre slug is inert data', async () => {
      const payload = "'; drop table manga; --";
      const id = await manga.create(
        draftInput({
          title: payload,
          slug: 'sqli-payload' as MangaSlug,
          synopsis: payload,
          aliases: [payload],
          creators: [{ name: payload, role: 'author' }],
        }),
      );
      // `create()` leaves a DRAFT, and an unknown genre slug is IGNORED rather
      // than an error — so this list is the unfiltered catalog containing the
      // published title, not an empty page.
      await manga.setPublished(id, true);
      const listed = (await manga.list({ genres: [payload] })).items;
      expect(listed.map((i) => i.id)).toEqual([id]);
      expect(listed[0]?.title).toBe(payload);
      expect(await manga.count()).toBe(1);
      // A dropped table would have thrown by now; this proves the table is real.
      expect((await harness.sql`select count(*)::int as n from manga`)[0]?.n).toBe(1);
    });
  });

  describe('EXPLAIN gate', () => {
    it('every catalog shape uses its named index and never a seq scan at 10k rows', async () => {
      // The threshold: "no seq scan > 10k rows". The corpus is generated here
      // (not seeded) so the assertion is about the query.
      await seedVisibleCorpus(harness, 10_000);

      const cases: { name: string; index: string; query: CatalogQuery }[] = [
        { name: 'list / updated_desc', index: 'ix_manga_visible', query: { sort: 'updated_desc' } },
        { name: 'list / title_asc', index: 'ix_manga_title', query: { sort: 'title_asc' } },
        { name: 'list / added_desc', index: 'ix_manga_created_at', query: { sort: 'added_desc' } },
        {
          name: 'list / status filter',
          index: 'ix_manga_visible',
          query: { sort: 'updated_desc', status: 'completed' },
        },
      ];

      for (const testCase of cases) {
        // The statement is the one `list()` runs — no hand-written SQL here.
        const plan = await explain(harness.sql, buildCatalogListQuery(harness.db, testCase.query));
        expect(plan, `${testCase.name}\n${plan}`).not.toMatch(/Seq Scan on manga/);
        expect(plan, `${testCase.name}\n${plan}`).toContain(testCase.index);
      }
    });

    it('page 2 (the keyset cursor) is index-backed too, not a second full scan', async () => {
      await seedVisibleCorpus(harness, 10_000);
      const page1 = await manga.list({ sort: 'updated_desc', limit: 24 });
      const page2 = await manga.list({
        sort: 'updated_desc',
        limit: 24,
        cursor: page1.nextCursor as string,
      });
      expect(page2.items).toHaveLength(24);
      const plan = await explain(
        harness.sql,
        buildCatalogListQuery(harness.db, {
          sort: 'updated_desc',
          cursor: page1.nextCursor as string,
        }),
      );
      expect(plan).not.toMatch(/Seq Scan on manga/);
      expect(plan).toContain('ix_manga_visible');
    });

    it('a genre-filtered list still reads manga through ix_manga_visible', async () => {
      await seedVisibleCorpus(harness, 10_000);
      const action = genreOne(await insertGenres(harness, ['Action']));
      // Roughly a third of the catalog carries the genre, as in a real
      // collection. Tagging ALL of them would make a hash semi-join the honest
      // plan, and asserting an index there would be asserting a falsehood.
      await harness.sql`
        insert into manga_genre (manga_id, genre_id)
        select id, ${action} from manga
        where published = true and deleted_at is null
          and (right(slug, 1) in ('0', '1', '2'))
        on conflict do nothing
      `;
      await harness.sql`analyze manga_genre`;
      const plan = await explain(
        harness.sql,
        buildCatalogListQuery(harness.db, { sort: 'updated_desc', genres: ['Action'] }),
      );
      expect(plan).not.toMatch(/Seq Scan on manga/);
      expect(plan).toContain('ix_manga_visible');
      expect((await manga.list({ genres: ['action'] })).items).toHaveLength(24);
    });
  });
});

let fixtureSeq = 0;

interface FixtureInput {
  published?: boolean;
  deleted?: boolean;
  title?: string;
  synopsis?: string;
  status?: 'ongoing' | 'completed' | 'hiatus';
  createdAt?: string;
  updatedAt?: string;
  genreIds?: string[];
}

/**
 * Inserts one manga row DIRECTLY, so the rest of the suite starts from a known
 * row state without routing through the repository under test — a `create`
 * bug must not be able to hide behind every other assertion.
 */
async function createManga(
  harness: Harness,
  slugs: Map<MangaId, MangaSlug>,
  input: FixtureInput,
): Promise<MangaId> {
  const n = String(++fixtureSeq).padStart(6, '0');
  const slug = `fixture-${n}` as MangaSlug;
  const rows = await harness.sql<{ id: string }[]>`
    insert into manga (slug, title, synopsis, status, reading_direction, published, created_at, updated_at, deleted_at)
    values (
      ${slug},
      ${input.title ?? `Fixture Title ${n}`},
      ${input.synopsis ?? 'Generated synopsis.'},
      ${input.status ?? 'ongoing'},
      'rtl',
      ${input.published ?? false},
      coalesce(${input.createdAt ?? null}::timestamptz, now()),
      coalesce(${input.updatedAt ?? null}::timestamptz, now()),
      case when ${input.deleted ?? false} then now() else null end
    )
    returning id
  `;
  const id = rows[0]?.id as MangaId | undefined;
  if (id === undefined) throw new Error('fixture insert returned no row');
  slugs.set(id, slug);
  for (const genreId of input.genreIds ?? []) {
    await harness.sql`insert into manga_genre (manga_id, genre_id) values (${id}, ${genreId})`;
  }
  return id;
}

/** Inserts (or reuses) genre rows and returns their ids in the order asked for. */
/** The first of an id list, or a loud failure. */
function genreOne(ids: string[]): string {
  const [first] = ids;
  if (first === undefined) throw new Error(`expected a genre id, got ${ids.length}`);
  return first;
}

/** A two-element id list, or a loud failure. */
function genrePair(ids: string[]): [string, string] {
  const [first, second] = ids;
  if (first === undefined || second === undefined) {
    throw new Error(`expected two genre ids, got ${ids.length}`);
  }
  return [first, second];
}

/** The id of a single selected row, or a loud failure. */
function tagId(row: { id: string }): string {
  return row.id;
}

/** One row or a loud failure — a fixture that silently returns `[]` hides bugs. */
function one<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected exactly one row for ${what}, got ${rows.length}`);
  return row;
}

async function insertGenres(harness: Harness, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const rows = await harness.sql<{ id: string }[]>`
      insert into genre (name) values (${name})
      on conflict (name) do update set name = excluded.name
      returning id
    `;
    ids.push(one(rows, `genre ${name}`).id);
  }
  return ids;
}

async function deletedAtOf(harness: Harness, id: MangaId): Promise<Date | null> {
  const rows = await harness.sql<{ deleted_at: Date | null }[]>`
    select deleted_at from manga where id = ${id}
  `;
  return rows[0]?.deleted_at ?? null;
}

/**
 * `COUNT` published, non-deleted manga rows for the EXPLAIN gate. Generated
 * titles with distinct `updated_at`/`created_at`, so every sort is a total
 * order at scale and the planner has a reason to prefer an index over a scan
 * plus sort.
 */
async function seedVisibleCorpus(harness: Harness, total: number): Promise<void> {
  const batch = 1_000;
  for (let start = 0; start < total; start += batch) {
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let offset = start; offset < Math.min(start + batch, total); offset += 1) {
      const n = String(offset).padStart(6, '0');
      // A distinct minute per row: every sort key is unique at this scale, so
      // the `id` tiebreaker never has to break a tie the planner can see.
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offset * 60_000).toISOString();
      // slug, title, status, published, created_at, updated_at — six params per row.
      // A third of the corpus is `completed`, so the status-filter plan is
      // measured against a realistic distribution rather than an empty column.
      values.push(`corpus-${n}`, `Corpus Title ${n}`, offset % 3 === 0 ? 'completed' : 'ongoing', true, at, at);
      const p = values.length;
      tuples.push(
        `($${p - 5}, $${p - 4}, 'Generated synopsis.', $${p - 3}, 'rtl', $${p - 2}, $${p - 1}, $${p})`,
      );
    }
    await harness.sql.unsafe(
      `insert into manga (slug, title, synopsis, status, reading_direction, published, created_at, updated_at)
       values ${tuples.join(', ')}`,
      values as never[],
    );
  }
  // The bulk insert leaves the planner's statistics stale. A seeded database is
  // analyzed, so the gate analyzes too — otherwise it would measure the fixture
  // rather than the query.
  await harness.sql`analyze manga`;
}
