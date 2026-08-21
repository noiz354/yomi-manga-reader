/**
 * The catalog cursor BOUND.
 *
 * Pagination (list endpoints) is cursor-based: the query takes an opaque
 * `cursor`. Two properties follow, and they belong to two different
 * components — the whole point of this file being small.
 *
 * The payload belongs to the repository. A keyset is `(sortKey, id)`, and only
 * the component that knows the sort tuple can build or read one.
 * `MangaRepository.list` mints `nextCursor` and consumes `?cursor=`, so IT
 * defines the payload — today `{ v, s, k, i }`, base64url, with its own shape
 * validation that raises `CATALOG_PAGE_INVALID`. The service therefore does
 * NOT mint, parse or second-guess a payload. Two owners of one format is a
 * defect waiting to happen, and the repository is the correct one.
 *
 * The transport belongs to the service. What the service does own is
 * everything a client can put in `?cursor=` that is not a cursor at all:
 * empty, unbounded, or not even base64url. `CATALOG_PAGE_INVALID` (422) is
 * triggered by a bad cursor/limit, and this is where the cheap half of that is
 * caught — before a database round trip, at the edge, with no query issued.
 *
 * The token is base64url, not encrypted: a client that decodes it learns the
 * sort tuple and can hand-craft a position. That is acceptable and stated: a
 * cursor is not a capability, every row it can reach is publicly visible, and
 * a payload the repository cannot use is a 422. Integrity (a MAC or a
 * session-bound token) would need a rule no document specifies, so none is
 * invented here.
 */
import { AppError } from '../../shared/contracts/errors';

/**
 * Upper bound on a whole cursor token. The repository's payload is a JSON
 * object of a version, a sort, a key and a uuid, so 512 leaves ample room while
 * still refusing to parse a megabyte of client input.
 */
export const CATALOG_CURSOR_MAX_LENGTH = 512;

/** base64url and nothing else, no padding. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Rejects a `?cursor=` that cannot be a cursor at all.
 *
 * This is a TRANSPORT check, not a payload check. A token that passes here is
 * forwarded to the repository byte-for-byte, and the repository decides whether
 * it can use it (raising the same `CATALOG_PAGE_INVALID` when it cannot).
 *
 * @param token the raw `?cursor=` value
 * @throws {AppError} `CATALOG_PAGE_INVALID` for an empty, over-long or
 *   non-base64url token — before any query is issued
 */
export function assertCatalogCursorToken(token: string): void {
  if (token.length === 0 || token.length > CATALOG_CURSOR_MAX_LENGTH || !BASE64URL.test(token)) {
    throw new AppError('CATALOG_PAGE_INVALID');
  }
}
