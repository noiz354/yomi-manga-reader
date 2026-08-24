/**
 * The search service. Everything about the REQUEST: `q` trimmed 1..120 with the
 * 422s happening before any query runs, the limit clamp, and the cursor BOUND to
 * the query that minted it. A cursor without its query is a wrong page waiting
 * to happen, so the service wraps the repository's cursor in an envelope
 * carrying the normalised `q` and refuses a foreign one. The repository here is
 * a fake that records whether it was CALLED. No DSN required.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSearchService } from '../../src/features/search/search.service';

/** One repository row, in the port's shape. */
interface FakeRow {
  kind: 'manga' | 'creator' | 'tag';
  id: string;
  slug: string | null;
  title: string;
  matchField: 'title' | 'alias' | 'creator' | 'tag';
  band: 'exact' | 'prefix' | 'contains' | 'related';
  score: number;
}

function makeService() {
  const searchRaw = vi.fn(async (input: { q: string; limit: number; cursor: string | null }) => ({
    rows: [
      {
        kind: 'manga',
        id: 'm-1',
        slug: 'm-1',
        title: 'Naruto',
        matchField: 'title',
        band: 'exact',
        score: 400,
      },
    ] as FakeRow[],
    nextCursor: input.cursor === null ? 'inner-2' : null,
  }));
  // No cast: the mock's shape IS the port, and a cast would hide a drift
  // between the fake and the interface it claims to implement.
  const service = createSearchService({ search: { searchRaw } });
  return { service, searchRaw };
}

describe('the search service', () => {
  describe('the query', () => {
    it('trims and passes the query through', async () => {
      const { service, searchRaw } = makeService();

      await service.search({ q: '  naruto  ' });

      expect(searchRaw).toHaveBeenCalledWith({ q: 'naruto', limit: 24, cursor: null });
    });

    it('refuses an empty query before any query runs', async () => {
      const { service, searchRaw } = makeService();

      await expect(service.search({ q: '   ' })).rejects.toMatchObject({
        code: 'SEARCH_QUERY_INVALID',
      });
      expect(searchRaw).not.toHaveBeenCalled();
    });

    it('refuses an overlong query before any query runs', async () => {
      // 121 chars. The repository would burn a trigram scan on it; the service
      // is where "nobody typed this deliberately" becomes a 422.
      const { service, searchRaw } = makeService();

      await expect(service.search({ q: 'x'.repeat(121) })).rejects.toMatchObject({
        code: 'SEARCH_QUERY_INVALID',
      });
      expect(searchRaw).not.toHaveBeenCalled();
    });

    it('accepts exactly 120 chars', async () => {
      // The boundary, both sides: 120 passes, 121 does not. A fence-post error
      // here would silently drop the longest legitimate queries.
      const { service, searchRaw } = makeService();

      await service.search({ q: 'x'.repeat(120) });

      expect(searchRaw).toHaveBeenCalledTimes(1);
    });

    it('names the offending field', async () => {
      const { service } = makeService();

      const failure = await service.search({ q: '' }).catch((cause: unknown) => cause);
      const details = (failure as { details?: Array<{ path?: string }> }).details;

      expect(details?.map((d) => d.path)).toContain('q');
    });
  });

  describe('the limit', () => {
    it('defaults to 24', async () => {
      const { service, searchRaw } = makeService();

      await service.search({ q: 'naruto' });

      expect(searchRaw).toHaveBeenCalledWith({ q: 'naruto', limit: 24, cursor: null });
    });

    it('clamps above 48 instead of refusing', async () => {
      // A limit is a preference. A 422 for `limit=100` would punish a client for
      // asking politely for too much; the contract promises ≤ 48, so 48 is what
      // they get.
      const { service, searchRaw } = makeService();

      await service.search({ q: 'naruto', limit: 100 });

      expect(searchRaw).toHaveBeenCalledWith({ q: 'naruto', limit: 48, cursor: null });
    });

    it('floors below 1 instead of querying for zero rows', async () => {
      const { service, searchRaw } = makeService();

      await service.search({ q: 'naruto', limit: 0 });

      expect(searchRaw).toHaveBeenCalledWith({ q: 'naruto', limit: 1, cursor: null });
    });
  });

  describe('the cursor is bound to the query', () => {
    /** Mint a real outgoing cursor, then use it the way a client would. */
    const roundTrip = async (q: string): Promise<string | null> => {
      const { service } = makeService();
      const first = await service.search({ q });
      return first.nextCursor;
    };

    it('hands the repository the INNER cursor, not the envelope', async () => {
      const { service, searchRaw } = makeService();
      const outgoing = (await roundTrip('naruto')) as string;

      await service.search({ q: 'naruto', cursor: outgoing });

      expect(searchRaw).toHaveBeenLastCalledWith({ q: 'naruto', limit: 24, cursor: 'inner-2' });
    });

    it('binds the outgoing cursor to the normalised query', async () => {
      const { service } = makeService();
      const outgoing = (await service.search({ q: '  NARUTO  ' })).nextCursor as string;
      const payload = JSON.parse(Buffer.from(outgoing, 'base64url').toString('utf8')) as {
        q?: unknown;
      };

      // The envelope carries the TRIMMED query, so '  NARUTO  ' and 'NARUTO' are
      // the same search — and 'naruto  ' with trailing spaces is not a different
      // one either. Without the trim, whitespace would fork the cursor space.
      expect(payload.q).toBe('NARUTO');
    });

    it('refuses a cursor minted for a different query', async () => {
      const { service, searchRaw } = makeService();
      const foreign = (await roundTrip('naruto')) as string;

      await expect(service.search({ q: 'one piece', cursor: foreign })).rejects.toMatchObject({
        code: 'SEARCH_QUERY_INVALID',
      });
      // Not repaired into page 1, either: no query ran at all.
      expect(searchRaw).not.toHaveBeenCalled();
    });

    it('refuses a tampered cursor', async () => {
      const { service, searchRaw } = makeService();
      const outgoing = (await roundTrip('naruto')) as string;
      const tampered = outgoing.slice(0, -2) + (outgoing.endsWith('AA') ? 'BB' : 'AA');

      await expect(service.search({ q: 'naruto', cursor: tampered })).rejects.toMatchObject({
        code: 'CATALOG_PAGE_INVALID',
      });
      expect(searchRaw).not.toHaveBeenCalled();
    });

    it('refuses a truncated cursor', async () => {
      const { service, searchRaw } = makeService();

      await expect(service.search({ q: 'naruto', cursor: 'e30' })).rejects.toMatchObject({
        code: 'CATALOG_PAGE_INVALID',
      });
      expect(searchRaw).not.toHaveBeenCalled();
    });

    it('refuses a well-formed envelope for the wrong shape', async () => {
      // Valid base64url, valid JSON, wrong everything — the shape check, not the
      // parse, is what stands between this and the repository.
      const { service, searchRaw } = makeService();
      const wrong = Buffer.from(JSON.stringify({ v: 2, q: 'naruto', inner: 'x' })).toString(
        'base64url',
      );

      await expect(service.search({ q: 'naruto', cursor: wrong })).rejects.toMatchObject({
        code: 'CATALOG_PAGE_INVALID',
      });
      expect(searchRaw).not.toHaveBeenCalled();
    });
  });

  describe('assembly', () => {
    it('shapes repository rows into SearchHit without the score', async () => {
      // `score` is the repository's internal weight. The wire carries the band,
      // which is the whole of the ordering contract — a second number would be
      // a second ranking for clients to disagree about.
      const { service } = makeService();

      const { items } = await service.search({ q: 'naruto' });

      expect(items).toEqual([
        {
          kind: 'manga',
          id: 'm-1',
          slug: 'm-1',
          title: 'Naruto',
          matchField: 'title',
          band: 'exact',
        },
      ]);
      expect(items[0]).not.toHaveProperty('score');
    });
  });
});
