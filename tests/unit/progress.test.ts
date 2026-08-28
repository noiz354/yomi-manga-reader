/**
 * Unit tests — progress semantics.
 *
 * TODO: replace describe.todo with real tests.
 */
import { describe } from 'vitest';

// idempotency — identical update twice → 1 row, no changed.
describe.todo('update idempotency');

// LWW — older server timestamp never overwrites newer.
describe.todo('last-write-wins ordering');

// merge on sign-in — local vs server, per-chapter latest wins.
describe.todo('sign-in merge');
