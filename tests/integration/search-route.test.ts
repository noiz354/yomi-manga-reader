/**
 * `GET /api/search` — the transport around the service: anonymous requests get
 * 200 (not 401), answers are `no-store`, bad input is 4xx, and the 30/min/IP
 * limit answers 429 with a usable `Retry-After`.
 *
 * The service here is a fake, shaped by what the route must NOT do with it. The
 * limiter is reset between tests because buckets are module state and a suite
 * that leaked them would be order-dependent. No DSN required.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSearchHandler, resetSearchRateLimit } from '../../src/app/api/search/route';
import { silentLogger } from './support/pg-catalog-ports';

function makeDeps() {
  // The fake returns exactly the service shape — no `received` echo, because the
  // pass-through is asserted on the mock's calls, and an echo field would be a
  // second channel saying the same thing.
  const search = vi.fn(async (_input: { q: string; cursor?: string; limit?: number }) => ({
    items: [
      {
        kind: 'manga' as const,
        id: 'm-1',
        slug: 'm-1',
        title: 'Naruto',
        matchField: 'title' as const,
        band: 'exact' as const,
      },
    ],
    nextCursor: null,
  }));
  // The real silent logger, not an inline fake: the route's factory takes a
  // `Logger`, and an inline object with the wrong arity would satisfy the type
  // checker today and lie about the call shape tomorrow.
  const deps = { search: { search }, logger: silentLogger() };
  return { deps, search };
}

const get = (
  deps: ReturnType<typeof makeDeps>['deps'],
  query = '',
  headers: Record<string, string> = {},
): Promise<Response> =>
  createSearchHandler(deps)(new Request(`http://yomi.test/api/search${query}`, { headers }));

describe('the search route', () => {
  afterEach(() => {
    resetSearchRateLimit();
  });

  describe('anonymous search works', () => {
    it('answers 200 with items and a null cursor, and no session anywhere', async () => {
      // No cookie, no header, no 401. Search reads published titles, creator
      // names and tag names — none of it is anyone's private data — so a
      // session is not merely optional, it is not read at all.
      const { deps, search } = makeDeps();
      const response = await get(deps, '?q=naruto');

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: Array<{ title?: string }>;
        nextCursor: string | null;
      };
      expect(body.items.map((item) => item.title)).toEqual(['Naruto']);
      expect(body.nextCursor).toBeNull();
      expect(search).toHaveBeenCalledWith({ q: 'naruto' });
    });

    it('passes cursor and limit through untouched', async () => {
      // The route parses the URL; the service validates and binds. A route that
      // clamped the limit itself would be a second source of truth for the
      // contract's ≤ 48.
      const { deps, search } = makeDeps();
      await get(deps, '?q=naruto&cursor=abc123&limit=10');

      expect(search).toHaveBeenCalledWith({ q: 'naruto', cursor: 'abc123', limit: 10 });
    });

    it('reads a non-numeric limit as "no limit given"', async () => {
      // `?limit=abc` is not a number, and "not a number" is not an attack — it
      // is the default with extra steps. A 422 here would punish a typo.
      const { deps, search } = makeDeps();
      const response = await get(deps, '?q=naruto&limit=abc');

      expect(response.status).toBe(200);
      expect(search).toHaveBeenCalledWith({ q: 'naruto' });
    });

    it('answers no-store, because a cached search is a stale search', async () => {
      const { deps } = makeDeps();
      const response = await get(deps, '?q=naruto');

      expect(response.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('bad input is 4xx, from the service', () => {
    it('an empty q is 422, not an empty 200', async () => {
      // The service owns this refusal. The route's job is to let it through
      // rather than translating it into something vaguer.
      const { deps } = makeDeps();
      const { createSearchService } = await import('../../src/features/search/search.service');
      // No casts: the stub satisfies the port and the service IS the service.
      // The point stands — an inline `as never` here would hide exactly the
      // wiring mismatch this test exists to catch.
      const real = createSearchService({
        search: { searchRaw: async () => ({ rows: [], nextCursor: null }) },
      });
      const response = await createSearchHandler({
        search: real,
        logger: deps.logger,
      })(new Request('http://yomi.test/api/search?q=%20%20'));

      expect(response.status).toBe(422);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('SEARCH_QUERY_INVALID');
    });

    it('propagates a bad-cursor 422 with its code intact', async () => {
      const { deps } = makeDeps();
      const { createSearchService } = await import('../../src/features/search/search.service');
      const real = createSearchService({
        search: { searchRaw: async () => ({ rows: [], nextCursor: null }) },
      });
      const response = await createSearchHandler({ search: real, logger: deps.logger })(
        new Request('http://yomi.test/api/search?q=naruto&cursor=nope'),
      );

      expect(response.status).toBe(422);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('CATALOG_PAGE_INVALID');
    });
  });

  describe('the rate limit', () => {
    it('allows 30 requests a minute and refuses the 31st', async () => {
      const { deps } = makeDeps();
      const ip = { 'x-forwarded-for': '203.0.113.7' };

      let last: Response | null = null;
      for (let n = 0; n < 30; n += 1) {
        last = await get(deps, '?q=naruto', ip);
        expect(last.status, `request ${n + 1}`).toBe(200);
      }
      const refused = await get(deps, '?q=naruto', ip);

      expect(refused.status).toBe(429);
      expect(last?.status).toBe(200);
    });

    it('says when to retry, and names the code', async () => {
      const { deps } = makeDeps();
      const ip = { 'x-forwarded-for': '203.0.113.8' };
      for (let n = 0; n < 30; n += 1) await get(deps, '?q=naruto', ip);
      const refused = await get(deps, '?q=naruto', ip);

      // A 429 without Retry-After is a client that retries immediately, which
      // is the opposite of what a rate limit wants.
      expect(refused.headers.get('retry-after')).toBe('60');
      const body = (await refused.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('RATE_LIMIT_SEARCH');
    });

    it('limits per IP, not globally', async () => {
      // A global bucket would let one scanner spend everyone's budget. Thirty
      // from one address must not cost a different address a single request.
      const { deps } = makeDeps();
      for (let n = 0; n < 30; n += 1) {
        await get(deps, '?q=naruto', { 'x-forwarded-for': '203.0.113.9' });
      }
      const other = await get(deps, '?q=naruto', { 'x-forwarded-for': '203.0.113.10' });

      expect(other.status).toBe(200);
    });

    it('treats a request with no identifiable IP as one shared bucket', async () => {
      // The unsafe direction would be treating every unknown as a fresh IP —
      // no limit at all for a client that strips the header. One shared bucket
      // degrades to a global 30/min, which is strict but never absent.
      const { deps } = makeDeps();
      for (let n = 0; n < 30; n += 1) {
        await get(deps, '?q=naruto');
      }
      expect((await get(deps, '?q=naruto')).status).toBe(429);
    });

    it('counts every request, including refused ones', async () => {
      // The check runs BEFORE validation, because its job is bounding load, not
      // judging input — validation is cheap but not free, and a flood of invalid
      // requests is still a flood. A first version of this test asserted the
      // opposite ("a 422 must not consume budget"), which would have required the
      // route to duplicate the service's 1..120 rule just to decide whether to
      // count — a second source of truth for the contract's length limit. A
      // client debugging a 422 has 30 tries a minute, which is plenty; and the
      // minute is the whole of the penalty.
      const { deps } = makeDeps();
      const ip = { 'x-forwarded-for': '203.0.113.11' };
      for (let n = 0; n < 29; n += 1) await get(deps, '?q=naruto', ip);
      await get(deps, '?q=%20%20', ip);
      // 29 searches + 1 refused empty one = 30 requests. The next one, valid or
      // not, is over the line.
      expect((await get(deps, '?q=naruto', ip)).status).toBe(429);
    });
  });
});
