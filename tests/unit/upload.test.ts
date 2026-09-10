/**
 * Unit tests — upload validation core.
 *
 * TODO: replace describe.todo with real tests.
 */
import { describe } from 'vitest';

// prepareChapterUpload validation table — 501 files, 110 MB file, 501 MB total,
// bad magic bytes, 0-byte file, disallowed extension → each typed code.
describe.todo('prepare validation table');

// Path normalization — `..` entries, absolute, backslash, symlink flag →
// rejected codes (Zip Slip class).
describe.todo('path normalization');
