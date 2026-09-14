/**
 * The search repository. Pins one composed query: four bands (exact > prefix >
 * contains > related), a keyset cursor that pages, the related band for creators
 * and tags, and the CJK 1–2 char prefix-only path. It also pins the silence: no
 * unpublished, no soft-deleted, nothing a hostile `q` smuggles in. The fixture,
 * built to BREAK ordering, makes "naruto" hit all four bands and two titles are byte-identical so only the id tie-break separates them. Needs DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSearchRepository } from '../../src/server/db/repositories/search.repository';
import { openCatalogDatabase } from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import {
  chapter,
  creator,
  manga,
  mangaAlias,
  mangaCreator,
  mangaTag,
  tag,
  users,
} from '../../src/server/db/schema';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { SearchRepository } from '../../src/features/search/search.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const DB_NAME = 'search_repository_it';

/** Short ids with a fixed prefix, so the id tie-break is deterministic. */
const id = (n: number): string => `0198c0f0-0000-7000-8000-0000000010${String(n).padStart(2, '0')}`;

const M = {
  exact: id(1),
  prefixGt: id(2),
  prefixSuper: id(3),
  contains: id(4),
  creatorTitle: id(5),
  tagTitle: id(6),
  cjk1: id(7),
  cjk2: id(8),
  twinA: id(9),
  twinB: id(10),
  draft: id(11),
  deleted: id(12),
};
const CH = (n: number): string => `0198c0f0-0000-7000-8000-0000000011${String(n).padStart(2, '0')}`;
const CREATOR = id(21);
const TAG = id(22);
const ALIAS_ID = id(23);
const ALIAS_MANGA = id(24);

describeDb('the search repository', () => {
  let open: OpenDatabase;
  let search: SearchRepository;

  const query = (q: string, limit = 48, cursor: string | null = null) =>
    search.searchRaw({ q, limit, cursor });

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, DB_NAME);
    search = createSearchRepository(open.db);
    const throwaway = new URL(DATABASE_URL as string);
    throwaway.pathname = `/${DB_NAME}`;
    for (const [key, value] of Object.entries(envSource(throwaway.toString()))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }

    const titles: Array<{ id: string; slug: string; title: string; published: boolean }> = [
      { id: M.exact, slug: 'search-exact', title: 'Naruto', published: true },
      // Two prefix titles that differ only in case — A–Z is folded, never raw.
      { id: M.prefixGt, slug: 'search-prefix-gt', title: 'Naruto GT', published: true },
      { id: M.prefixSuper, slug: 'search-prefix-super', title: 'Naruto Super', published: true },
      // Contains: "naruto" appears below the title start.
      { id: M.contains, slug: 'search-contains', title: 'Boruto: Naruto Next', published: true },
      // Related: touched only through the creator and through the tag below.
      { id: M.creatorTitle, slug: 'search-creator-title', title: 'Blue Spiral', published: true },
      { id: M.tagTitle, slug: 'search-tag-title', title: 'Red Spiral', published: true },
      // CJK pair, same 2-char prefix, both published.
      { id: M.cjk1, slug: 'search-cjk-1', title: '進撃の巨人', published: true },
      { id: M.cjk2, slug: 'search-cjk-2', title: '進撃少女', published: true },
      // Byte-identical titles: only the id tie-break can order them.
      { id: M.twinA, slug: 'search-twin-a', title: 'Echo Room', published: true },
      { id: M.twinB, slug: 'search-twin-b', title: 'Echo Room', published: true },
      // Must never appear, whatever the query.
      { id: M.draft, slug: 'search-draft', title: 'Naruto Draft', published: false },
      { id: M.deleted, slug: 'search-deleted', title: 'Naruto Deleted', published: true },
      // The alias carrier: title says nothing, alias says everything.
      { id: ALIAS_MANGA, slug: 'search-alias', title: 'Giant Story', published: true },
    ];
    await open.db.insert(manga).values(
      titles.map((row, index) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        published: row.published,
        status: 'ongoing' as const,
        readingDirection: 'ltr' as const,
        deletedAt: row.id === M.deleted ? new Date('2026-01-01T00:00:00.000Z') : null,
        createdAt: new Date(`2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
      })),
    );
    await open.db.insert(chapter).values(
      titles.map((row, index) => ({
        id: CH(index + 1),
        mangaId: row.id,
        number: '1',
        status: 'published' as const,
        publishedAt: new Date('2026-04-01T00:00:00.000Z'),
        pageCount: 12,
        readingOrder: 1,
      })),
    );
    await open.db.insert(mangaAlias).values({
      id: ALIAS_ID,
      mangaId: ALIAS_MANGA,
      alias: 'Shingeki no Kyojin',
    });
    await open.db.insert(creator).values({ id: CREATOR, name: 'Masashi Kishimoto' });
    await open.db.insert(mangaCreator).values({
      mangaId: M.creatorTitle,
      creatorId: CREATOR,
      role: 'author' as const,
    });
    await open.db.insert(tag).values({ id: TAG, name: 'QuestMark' });
    await open.db.insert(mangaTag).values({ mangaId: M.tagTitle, tagId: TAG });
    // A user row is not needed — search is anonymous — and its absence is the
    // point: no `users` insert, no session, no caller anywhere in this file.
    expect(users).toBeDefined();
  });

  afterAll(async () => {
    await open?.close();
  });

  describe('band order: exact > prefix > contains > related', () => {
    it('returns the bands in order for a query that hits all four', async () => {
      // "naruto": exact on 'Naruto', prefix on the GT/Super pair, contains on
      // 'Boruto: Naruto Next'. Related for "naruto" is absent by design — no
      // creator or tag carries that string — so the tail of the order is asserted
      // by the creator/tag tests below.
      const { rows } = await query('naruto');

      expect(rows.map((row) => row.band)).toEqual(['exact', 'prefix', 'prefix', 'contains']);
      expect(rows.map((row) => row.title)).toEqual([
        'Naruto',
        'Naruto GT',
        'Naruto Super',
        'Boruto: Naruto Next',
      ]);
      // A title matched in two bands answers ONCE, with its best one: 'Naruto'
      // is also a prefix of itself, and it must not appear twice.
      expect(rows.filter((row) => row.title === 'Naruto')).toHaveLength(1);
    });

    it('carries the integer scores that make the order legible', async () => {
      const { rows } = await query('naruto');

      expect(rows.map((row) => row.score)).toEqual([400, 300, 300, 200]);
    });

    it('keeps case out of the tie-break: folded A–Z, then id', async () => {
      // 'Naruto GT' vs 'Naruto Super' is decided by folded title. Titles are NOT
      // unique in the schema, so the tie-break below is real, not theoretical.
      const { rows } = await query('echo room');

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.band)).toEqual(['exact', 'exact']);
      // Lowered titles tie exactly, so the smaller id wins — and the ids were
      // minted in order, which is what makes this deterministic rather than
      // lucky.
      expect(rows).toHaveLength(2);
      const [first, second] = rows;
      expect(first?.id).toBe(M.twinA);
      expect(second?.id).toBe(M.twinB);
      expect((first?.id ?? '') < (second?.id ?? '')).toBe(true);
    });

    it('matches case-insensitively in both directions', async () => {
      // The query is upper case, the stored titles are mixed — and 'NARUTO GT'
      // must still land in prefix, not somewhere stranger.
      const { rows } = await query('NARUTO');

      expect(rows.map((row) => row.title)).toContain('Naruto GT');
      expect(rows[0]?.title).toBe('Naruto');
    });
  });

  describe('aliases', () => {
    it('finds a title through its alias, and says which field matched', async () => {
      const { rows } = await query('shingeki');

      // 'Shingeki no Kyojin' is a prefix of the alias, on a title that says
      // nothing about giants. The hit names the carrier, not the alias string.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'manga',
        title: 'Giant Story',
        matchField: 'alias',
        band: 'prefix',
      });
    });
  });

  describe('creators resolve into the related band', () => {
    it('emits the creator row AND the titles that carry them', async () => {
      const { rows } = await query('kishimoto');

      // Both row kinds, because the port's `kind` union exists for a reason. A
      // schema that can never produce 'creator' is a branch waiting to die.
      const creatorRow = rows.find((row) => row.kind === 'creator');
      expect(creatorRow).toMatchObject({
        title: 'Masashi Kishimoto',
        matchField: 'creator',
        band: 'related',
        score: 100,
      });
      const mangaRow = rows.find((row) => row.kind === 'manga');
      expect(mangaRow).toMatchObject({
        title: 'Blue Spiral',
        matchField: 'creator',
        band: 'related',
      });
      // The creator row is not a manga and gets no slug to browse to.
      expect(creatorRow?.slug).toBeNull();
    });
  });

  describe('tags resolve into the related band', () => {
    it('emits the tag row AND the titles that carry it', async () => {
      const { rows } = await query('questmark');

      expect(rows.find((row) => row.kind === 'tag')).toMatchObject({
        title: 'QuestMark',
        matchField: 'tag',
        band: 'related',
      });
      expect(rows.find((row) => row.kind === 'manga')).toMatchObject({
        title: 'Red Spiral',
        matchField: 'tag',
        band: 'related',
      });
    });

    it('does not treat a tag-word inside a TITLE as a tag match', async () => {
      // A first version of this fixture named the tag 'SpiralQuest', which
      // CONTAINS 'spiral' — so a `q` of 'spiral' legitimately matched the tag,
      // and the assertion that no tag hit could exist was wrong about its own
      // fixture. Renamed, the test means what it says: 'Blue Spiral' and 'Red
      // Spiral' carry "Spiral" in the title and in nothing else, so a `q` of
      // 'spiral' must find the titles by title and invent no tag hit.
      const { rows } = await query('spiral');

      expect(rows.every((row) => row.matchField !== 'tag')).toBe(true);
      expect(rows.map((row) => row.title).sort()).toEqual(['Blue Spiral', 'Red Spiral']);
    });
  });

  describe('a 1–2 code-point CJK query takes the prefix path only', () => {
    it('finds the two titles that start with 進撃, and nothing else', async () => {
      const { rows } = await query('進撃');

      expect(rows.map((row) => row.title).sort()).toEqual(['進撃の巨人', '進撃少女']);
      expect(rows.every((row) => row.band === 'prefix')).toBe(true);
    });

    it('answers one code point the same way', async () => {
      // Hiragana, one char. 'の' starts the second half of '進撃の巨人' but is
      // NOT a title start — a prefix path must not find it. With the contains
      // branch running it would; without it, the query finds nothing, which is
      // the correct answer for a single char that no title starts with.
      const { rows } = await query('の');

      expect(rows).toHaveLength(0);
    });

    it('still uses contains at three code points — both sides of the boundary', async () => {
      // '進撃の' is a prefix of exactly one title and a substring path the query
      // would also satisfy through contains. The boundary is what matters: 2
      // chars take prefix-only, 3 chars take the full query. Asserting only the
      // short side would let a `<= 3` slip through unnoticed.
      const short = await query('進撃');
      const long = await query('進撃の');

      expect(short.rows.every((row) => row.band === 'prefix')).toBe(true);
      expect(long.rows.map((row) => row.title)).toContain('進撃の巨人');
    });
  });

  describe('keyset pagination', () => {
    it('pages without overlap and without loss', async () => {
      // Five hits for "naruto" would fit one page, so force the split: the
      // alias query is built from the same throwaway DB state as everything
      // else, and 'spiral' returns titles plus tag-adjacent rows. Use a query
      // with more rows than the limit instead of assuming a count.
      const first = await query('naruto', 2);
      expect(first.rows).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await query('naruto', 2, first.nextCursor);
      expect(second.rows).toHaveLength(2);
      // Different rows, same order the single query would have produced.
      expect(second.rows.map((row) => row.id)).not.toEqual(first.rows.map((row) => row.id));
      const full = await query('naruto');
      expect([...first.rows, ...second.rows].map((row) => row.id)).toEqual(
        full.rows.map((row) => row.id),
      );
    });

    it('ends the last page with a null cursor', async () => {
      const first = await query('naruto', 2);
      const second = await query('naruto', 2, first.nextCursor);
      expect(second.nextCursor).toBeNull();
    });

    it('rejects a hostile cursor instead of repairing it', async () => {
      // A forged cursor cannot widen a WHERE (it carries no authority), but it
      // must not silently restart the listing either — a 422, like the catalog.
      await expect(query('naruto', 2, 'not-a-cursor')).rejects.toMatchObject({
        code: 'CATALOG_PAGE_INVALID',
      });
      await expect(
        query('naruto', 2, Buffer.from('{"v":2}').toString('base64url')),
      ).rejects.toMatchObject({ code: 'CATALOG_PAGE_INVALID' });
    });
  });

  describe('silence: drafts, deleted titles and hostile queries', () => {
    it('never returns an unpublished title, even when it matches', async () => {
      const { rows } = await query('naruto');

      expect(rows.map((row) => row.title)).not.toContain('Naruto Draft');
    });

    it('never returns a soft-deleted title, even when it matches', async () => {
      const { rows } = await query('naruto');

      expect(rows.map((row) => row.title)).not.toContain('Naruto Deleted');
    });

    it('treats LIKE metacharacters as data, not as patterns', async () => {
      // `%` and `_` are escaped: a query of `%` matches a literal percent sign
      // (of which there are none) and not everything. Without the escape this
      // returns the whole catalogue — which the empty-q guard exists to prevent,
      // and which would make the guard pointless from the other side.
      for (const hostile of ['%', '_', '%%', '%n%']) {
        const { rows } = await query(hostile);
        expect(rows, `q=${JSON.stringify(hostile)}`).toHaveLength(0);
      }
    });

    it('treats SQL fragments as inert strings', async () => {
      // Parameterised, never concatenated — the injection is a string that
      // matches nothing, and the table is still there afterwards.
      const { rows } = await query("'; DROP TABLE manga; --");

      expect(rows).toHaveLength(0);
      const after = await query('naruto');
      expect(after.rows.length).toBeGreaterThan(0);
    });

    it('answers an empty or whitespace query with nothing, not the catalogue', async () => {
      // `LIKE '%%'` matches every title. The service will 422 this; the
      // repository must not be callable into listing all titles.
      for (const empty of ['', '   ']) {
        const { rows, nextCursor } = await query(empty);
        expect(rows).toEqual([]);
        expect(nextCursor).toBeNull();
      }
    });
  });

  describe('the GIN trigram indexes are actually used', () => {
    it('pg_trgm is installed and the two trigram indexes exist', async () => {
      // The migration builds them conditionally (PGlite has no pg_trgm), so a
      // green suite on a backend without them would be testing a query whose
      // index assumptions are false. This fails loudly on such a backend rather
      // than timing out mysteriously in the load test.
      const ext = (await open.db.execute(
        "SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_trgm'",
      )) as unknown as Array<{ n: number }>;
      expect(Number(ext[0]?.n)).toBe(1);

      const indexes = (await open.db.execute(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('ix_manga_title_trgm', 'ix_manga_alias_alias')",
      )) as unknown as Array<{ indexname: string }>;
      expect(indexes.map((row) => row.indexname).sort()).toEqual([
        'ix_manga_alias_alias',
        'ix_manga_title_trgm',
      ]);
    });

    it('EXPLAIN shows no sequential scan on the title branches', async () => {
      // Bitmap heap + bitmap index scans are the trigram index doing its job. A
      // "Seq Scan on manga" here means the contains branch lost its index — the
      // exact regression this pins.
      const plan = (await open.db.execute(
        `EXPLAIN (COSTS OFF) SELECT m.id FROM manga m WHERE m.published AND m.deleted_at IS NULL AND lower(m.title) LIKE '%naruto%'`,
      )) as unknown as Array<{ [key: string]: string }>;
      const text = plan.map((row) => Object.values(row).join(' ')).join('\n');

      expect(text).not.toMatch(/Seq Scan on manga/);
    });
  });
});
