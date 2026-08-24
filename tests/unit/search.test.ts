/**
 * Unit tests — search rules.
 * TODO: replace describe.todo with real tests.
 */
import { describe } from 'vitest';

// Ranking weights — exact > prefix > contains > creator/tag; tie-breakers
// stable.
describe.todo('ranking weights');

// Query building: whitespace/length/punctuation normalization, min 2-char
// rule, no operator injection into trigram expressions.
describe.todo('query building');
