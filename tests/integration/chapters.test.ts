/**
 * Integration tests — chapter repository (real PG).
 *
 * TODO: replace describe.todo with real tests.
 */
import { describe } from 'vitest';

// Chapter order — number with decimals (10.5), tiebreak by reading_order,
// drafts excluded for non-admin.
describe.todo('chapter ordering');

// commitPages atomicity: partial commit rejected all-or-nothing (page insert +
// metadata in one transaction); re-commit (re-ingest) replaces the page set;
// deleted-chapter guard.
describe.todo('commitPages atomicity');
