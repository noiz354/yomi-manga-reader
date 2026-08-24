/**
 * The search page's server read. `readSearchPage` is the page's contract with
 * its own API: page 1 for a `?q=` in the first response, and failures as VALUES
 * the page can render — including WHICH failure, because a rate-limited first
 * paint must render the rate-limited state rather than "unavailable".
 * `next/headers` and `server-only` are mocked. The island (`search-box.tsx`) is
 * NOT covered — it needs a DOM this repo does not vendor. `fetch` is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let incomingCookie: string | null = null;
let incomingHost: string | null = 'yomi.test';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => ({
    get: (name: string): string | null => {
      if (name === 'host') return incomingHost;
      if (name === 'cookie') return incomingCookie;
      return null;
    },
  }),
}));

const calls: Array<{ url: string; headers: Record<string, string> }> = [];

const okBody = {
  items: [
    {
      kind: 'manga',
      id: 'm-1',
      slug: 'm-1',
      title: 'Naruto',
      matchField: 'title',
      band: 'exact',
    },
  ],
  nextCursor: 'cursor-2',
};

describe('the search page server read', () => {
  beforeEach(() => {
    calls.length = 0;
    incomingCookie = null;
    incomingHost = 'yomi.test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
        calls.push({ url: String(input), headers: init?.headers ?? {} });
        return new Response(JSON.stringify(okBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const read = async (q: string) => {
    const mod = await import('../../src/app/search/search-data');
    return mod.readSearchPage(q);
  };

  it('fetches page 1 for a query and parses the items', async () => {
    const result = await read('naruto');

    expect(result).toEqual({ ok: true, items: okBody.items, nextCursor: 'cursor-2' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/search?');
    expect(calls[0]?.url).toContain('q=naruto');
  });

  it('does not touch the network for an empty query', async () => {
    // The API would 422 it, and a 422 is not a state the page needs a round
    // trip to discover.
    for (const q of ['', '   ']) {
      expect(await read(q)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    }
    expect(calls).toHaveLength(0);
  });

  it('answers unavailable when there is no request scope', async () => {
    // `headers()` throws outside a request (a script, a build-time read). No
    // origin means no loopback, which is the correct answer, not a failure.
    incomingHost = null;

    expect(await read('naruto')).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(calls).toHaveLength(0);
  });

  it('distinguishes a 429 from any other failure', async () => {
    // The whole reason the failure carries a code: a rate-limited first paint
    // renders the rate-limited state, and every other failure renders
    // "unavailable". An error is never "no results", and a 429 is never a 500.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 429 })),
    );

    expect(await read('naruto')).toEqual({ ok: false, code: 'RATE_LIMITED' });
  });

  it('answers unavailable on a 500, a bad body, and a refused connection', async () => {
    const mod = await import('../../src/app/search/search-data');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    expect(await mod.readSearchPage('naruto')).toEqual({ ok: false, code: 'UNAVAILABLE' });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: 'not-an-array' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    expect(await mod.readSearchPage('naruto')).toEqual({ ok: false, code: 'UNAVAILABLE' });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('refused');
      }),
    );
    expect(await mod.readSearchPage('naruto')).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('replays the cookie when there is one, and sends none when there is not', async () => {
    // Uniformity with every other loopback read in this app: the search route
    // is anonymous and never looks at it, but a lane that dropped the session
    // would be a difference waiting to become a bug.
    incomingCookie = 'session_token=abc';
    await read('naruto');
    expect(calls[0]?.headers['cookie']).toBe('session_token=abc');

    calls.length = 0;
    incomingCookie = null;
    await read('naruto');
    expect('cookie' in (calls[0]?.headers ?? {})).toBe(false);
  });
});
