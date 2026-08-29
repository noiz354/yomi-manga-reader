/**
 * Unit tests — auth pure functions.
 * TODO: replace describe.todo with real tests.
 */
import { describe } from 'vitest';

// Argon2id parameters present in produced hashes (m=64MB/t=3/p=4 asserted
// per research registry; constant-time compare path).
describe.todo('argon2id parameters');

// Password policy — min length, composition rules, reject list of common
// passwords (user-facing messages per the validation policy).
describe.todo('password policy');
