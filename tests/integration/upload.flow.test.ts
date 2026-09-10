/**
 * Integration tests — upload pipeline (real PG; storage port may use an
 * in-memory fake implementing ObjectStoragePort — no fake business logic).
 * TODO: replace describe.todo with real tests.
 */
import { describe } from 'vitest';

// The upload suite: (a) valid 30-page ZIP → ready, variants in MinIO, metadata
// correct, chapter publishable; (b) every attack fixture (Zip Slip, symlink,
// bomb 500 MB, 501 files, 110 MB file, spoofed MIME, 9999×9999 px) → failed
// with typed code, zero side effects; (c) job state transitions logged;
// (d) re-ingest replaces asset set, old keys GC-queued.
describe.todo('upload suite (valid + attack legs)');

// Multipart — 3 parts → assembled → pipeline runs.
describe.todo('multipart assembly');
