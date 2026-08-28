/**
 * Integration tests — progress persistence (real PG).
 *
 * TODO: replace describe.todo with real tests.
 */
import { describe } from 'vitest';

// Concurrency — 2 sessions × 50 interleaved progress writes → final = latest
// server stamp; no constraint violations.
describe.todo('concurrent progress writes');

// History — session boundary (5-min idle) creates new rows; deepest page
// tracked.
describe.todo('history session boundary');
