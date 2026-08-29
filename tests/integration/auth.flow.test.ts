/**
 * Integration tests — auth flows (real PG, real argon2, per-test transaction
 * rolled back).
 *
 * TODO: replace describe.todo with real tests.
 */
import { describe } from 'vitest';

// register → login (cookie set, flags correct) → protected call OK → logout →
// call 401; second login rotates token.
describe.todo('register/login/logout round-trip');

// rate limits — 11th login/min/IP → 429 RATE_LIMIT_LOGIN; per-account limit.
describe.todo('login rate limiting');
