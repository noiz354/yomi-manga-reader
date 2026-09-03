/**
 * Integration tests — media delivery + schema (real PG; storage may use a
 * port-level fake).
 *
 * TODO: replace describe.todo with real tests.
 */
import { describe } from 'vitest';

// Variant content-type per STORED format, immutable headers (public,
// max-age=31536000), ETag, nosniff; 404 on unknown/draft key (no existence
// leak); storage failure → 502 STORAGE_ERROR with no vendor text.
describe.todo('delivery contract');

// Schema assertions: tables/FKs/CHECKs/partial indexes match the data model
// (introspection diff), pg_trgm present, app role has no DDL, audit table
// append-only for the app role.
describe.todo('schema assertions');
