/**
 * Unit tests — reader pure functions.
 *
 * TODO: replace describe.todo with real tests (pure functions — no mocks,
 * no I/O).
 */
import { describe } from 'vitest';

// ReaderState reducer — every transition (mode, direction, zoom, page)
// preserves invariants (page in [1..M], window valid, direction flip keeps
// logical page).
describe.todo('reducer invariants');

// Page index — negative, zero, > M, NaN, non-integer inputs → clamped/rejected
// (no negative page indexes).
describe.todo('page index validation');

// calculateReaderWindow — first/last/middle page, chapter smaller than window,
// 500-page chapter, mode sizes, hard cap 12.
describe.todo('window calculation');

// Window recompute idempotency + rapid-navigation sequences (1k random walks
// fuzz).
describe.todo('window fuzz');
