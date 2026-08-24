/**
 * features/search — SearchService: query parsing, cursor binding, assembly.
 *
 * Validates the query (trimmed, 1–120 chars), binds the cursor to that query,
 * calls the repository, and shapes SearchHit rows. Ranking lives in the
 * repository; this layer owns everything about the REQUEST.
 *
 * The query string is DATA, never SQL (parameterized through SearchRepository).
 */
import { AppError } from '../../shared/contracts/errors';
import type { SearchHit } from '../../shared/contracts/search';
import type { SearchRepository } from './search.repository';

export interface SearchService {
  search(input: { q: string; cursor?: string; limit?: number }): Promise<{
    items: SearchHit[];
    nextCursor: string | null;
  }>;
}

/** Service defaults: the contract's page size and ceiling. */
export const SEARCH_DEFAULT_LIMIT = 24;
export const SEARCH_MAX_LIMIT = 48;
export const SEARCH_MAX_QUERY_LENGTH = 120;

/** The outer envelope. `q` is the TRIMMED query the inner cursor was minted for. */
interface BoundCursor {
  v: 1;
  q: string;
  inner: string;
}

function encodeBoundCursor(q: string, inner: string): string {
  const payload: BoundCursor = { v: 1, q, inner };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode the outer envelope and check it belongs to THIS query.
 *
 * @throws {AppError} `CATALOG_PAGE_INVALID` when the envelope itself is broken;
 *   `SEARCH_QUERY_INVALID` when it is intact but was minted for another query.
 */
function decodeBoundCursor(cursor: string, q: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('CATALOG_PAGE_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AppError('CATALOG_PAGE_INVALID');
  }
  const candidate = parsed as Partial<BoundCursor>;
  if (candidate.v !== 1 || typeof candidate.q !== 'string' || typeof candidate.inner !== 'string') {
    throw new AppError('CATALOG_PAGE_INVALID');
  }
  if (candidate.q === '' || candidate.inner === '') {
    throw new AppError('CATALOG_PAGE_INVALID');
  }
  // The pair is wrong even though both halves are well-formed. Restarting from
  // page 1 would be a repair, and a cursor is refused, not repaired — a client
  // paging with a stale cursor has a bug that should be visible rather than
  // papered over with almost-right results.
  if (candidate.q !== q) {
    throw new AppError('SEARCH_QUERY_INVALID', {
      details: [{ path: 'cursor', message: 'This cursor was minted for a different query.' }],
    });
  }
  return candidate.inner;
}

export function createSearchService(deps: { search: SearchRepository }): SearchService {
  return {
    async search(input: { q: string; cursor?: string; limit?: number }) {
      const q = (input.q ?? '').trim();
      // Before any query runs: the repository answers "nothing" to an empty `q`
      // as its own last line of defence, but "nothing, 200" is the wrong answer
      // here — an empty search is a client bug worth a 422, and an overlong one
      // is either a bug or a probe.
      if (q === '' || q.length > SEARCH_MAX_QUERY_LENGTH) {
        throw new AppError('SEARCH_QUERY_INVALID', {
          details: [
            {
              path: 'q',
              message: `Expected 1–${SEARCH_MAX_QUERY_LENGTH} characters after trimming.`,
            },
          ],
        });
      }

      const rawLimit = input.limit ?? SEARCH_DEFAULT_LIMIT;
      const limit = Math.min(Math.max(Math.floor(rawLimit), 1), SEARCH_MAX_LIMIT);

      const inner = input.cursor === undefined ? null : decodeBoundCursor(input.cursor, q);
      const { rows, nextCursor } = await deps.search.searchRaw({ q, limit, cursor: inner });

      return {
        items: rows.map((row): SearchHit => ({
          kind: row.kind,
          id: row.id,
          slug: row.slug,
          title: row.title,
          matchField: row.matchField,
          band: row.band,
        })),
        // The outgoing cursor is bound before it leaves: whatever the repository
        // minted becomes unusable for any other query on the way back in.
        nextCursor: nextCursor === null ? null : encodeBoundCursor(q, nextCursor),
      };
    },
  };
}
