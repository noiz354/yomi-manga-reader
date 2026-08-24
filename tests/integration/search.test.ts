/**
 * Integration test — search.
 *
 * Coverage: trigram search — seed corpus (titles/aliases), ranked results
 * (title > alias), kind/match hints, cursor paging stable under concurrent
 * inserts (no dupes/losses), empty-catalog state (SEARCH_EMPTY), 2-char minimum
 * enforced.
 *
 * TODO: replace with real tests (real PG + pg_trgm).
 */
import { describe } from 'vitest';

describe.todo('trigram search');
