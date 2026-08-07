/**
 * Unit tests — error contract (shared/contracts/errors.ts).
 *
 * The snapshot below is written by hand — deliberately *not* imported from the
 * implementation, so a change in `errors.ts` cannot silently redefine the
 * contract. It proves the mapping table is total.
 */
import { describe, expect, it } from 'vitest';

import {
  AppError,
  ERROR_MAPPINGS,
  getErrorMapping,
  toRouteError,
  type ErrorCode,
  type ErrorMapping,
} from '../../src/shared/contracts/errors';

/** The four normative columns (V/L/A legend) plus the HTTP status. */
type ExpectedMapping = {
  readonly httpStatus: ErrorMapping['httpStatus'];
  readonly userMessage: string;
  readonly logLevel: ErrorMapping['logLevel'];
  readonly alerts: boolean;
};

/**
 * The expected mapping, row by row.
 *
 * Mapped over `ErrorCode`, so a code added to the union without a row here is
 * a **compile error in this file** as well as in `errors.ts`.
 *
 * Rows marked PENDING below are the only codes the implementation has that the
 * table does not tabulate; they are mandated elsewhere in the spec and are
 * reported as a spec-question by the CI check, not buried.
 */
const EXPECTED: { readonly [K in ErrorCode]: ExpectedMapping } = {
  AUTH_REQUIRED: {
    httpStatus: 401,
    userMessage: 'Sign in to continue.',
    logLevel: 'info',
    alerts: false,
  },
  AUTH_INVALID_CREDENTIALS: {
    httpStatus: 401,
    userMessage: 'Invalid email or password.',
    logLevel: 'warn',
    alerts: true,
  },
  AUTH_EMAIL_TAKEN: {
    httpStatus: 409,
    userMessage: 'An account with this email exists.',
    logLevel: 'info',
    alerts: false,
  },
  AUTH_DISABLED: {
    httpStatus: 403,
    userMessage: 'Account disabled. Contact the operator.',
    logLevel: 'warn',
    alerts: false,
  },
  AUTH_FORBIDDEN: {
    httpStatus: 403,
    userMessage: "You don't have permission.",
    logLevel: 'warn',
    alerts: false,
  },
  AUTH_ACCOUNT_GONE: {
    httpStatus: 404,
    userMessage: 'Account no longer exists.',
    logLevel: 'info',
    alerts: false,
  },
  CATALOG_PAGE_INVALID: {
    httpStatus: 422,
    userMessage: 'Invalid pagination.',
    logLevel: 'info',
    alerts: false,
  },
  MANGA_NOT_FOUND: {
    httpStatus: 404,
    userMessage: 'Manga not found.',
    logLevel: 'info',
    alerts: false,
  },
  MANGA_SLUG_TAKEN: {
    httpStatus: 409,
    userMessage: 'Slug already in use.',
    logLevel: 'info',
    alerts: false,
  },
  CHAPTER_NOT_FOUND: {
    httpStatus: 404,
    userMessage: 'Chapter not found.',
    logLevel: 'info',
    alerts: false,
  },
  CHAPTER_NOT_READY: {
    httpStatus: 409,
    userMessage: "This chapter isn't available yet.",
    logLevel: 'warn',
    alerts: false,
  },
  CHAPTER_DUPLICATE_NUMBER: {
    httpStatus: 409,
    userMessage: 'A chapter with this number exists.',
    logLevel: 'info',
    alerts: false,
  },
  CHAPTER_LIST_TOO_LARGE: {
    httpStatus: 409,
    userMessage: 'Chapter list too large to display.',
    logLevel: 'error',
    alerts: true,
  },
  READER_INVALID_PAGE: {
    httpStatus: 422,
    userMessage: 'Page is out of range for this chapter.',
    logLevel: 'info',
    alerts: false,
  },
  LIBRARY_BOOKMARK_EXISTS: {
    httpStatus: 409,
    userMessage: 'You already bookmarked this page.',
    logLevel: 'info',
    alerts: false,
  },
  LIBRARY_BOOKMARK_NOT_FOUND: {
    httpStatus: 404,
    userMessage: 'Bookmark not found.',
    logLevel: 'info',
    alerts: false,
  },
  VALIDATION_FIELD_INVALID: {
    httpStatus: 422,
    userMessage: 'One of the fields is not valid.',
    logLevel: 'info',
    alerts: false,
  },
  SEARCH_QUERY_INVALID: {
    httpStatus: 422,
    userMessage: 'Search query is empty or too long.',
    logLevel: 'info',
    alerts: false,
  },
  UPLOAD_BAD_CONTAINER: {
    httpStatus: 415,
    userMessage: 'Only ZIP archives are accepted.',
    logLevel: 'warn',
    alerts: false,
  },
  UPLOAD_TOO_LARGE: {
    httpStatus: 413,
    userMessage: 'Upload exceeds the size limit.',
    logLevel: 'warn',
    alerts: false,
  },
  UPLOAD_TOO_MANY_FILES: {
    httpStatus: 413,
    userMessage: 'Too many files.',
    logLevel: 'warn',
    alerts: false,
  },
  UPLOAD_BAD_MIME: {
    httpStatus: 415,
    userMessage: 'One or more files are not supported images.',
    logLevel: 'warn',
    alerts: false,
  },
  UPLOAD_PATH_TRAVERSAL: {
    httpStatus: 415,
    userMessage: 'Archive contains unsafe paths.',
    logLevel: 'error',
    alerts: true,
  },
  UPLOAD_SYMLINK: {
    httpStatus: 415,
    userMessage: 'Archive contains unsafe links.',
    logLevel: 'error',
    alerts: true,
  },
  UPLOAD_DECOMPRESSION_BOMB: {
    httpStatus: 413,
    userMessage: 'Archive expands beyond the safe limit.',
    logLevel: 'error',
    alerts: true,
  },
  UPLOAD_IMAGE_DECODE: {
    httpStatus: 422,
    userMessage: 'Some images could not be read.',
    logLevel: 'warn',
    alerts: true,
  },
  UPLOAD_DIMENSIONS_EXCEEDED: {
    httpStatus: 422,
    userMessage: 'Image dimensions exceed the limit.',
    logLevel: 'warn',
    alerts: false,
  },
  // PENDING: the status is fixed at 422 by the edge-case contract.
  UPLOAD_NO_IMAGES: {
    httpStatus: 422,
    userMessage: 'The archive contains no images.',
    logLevel: 'warn',
    alerts: false,
  },
  // PENDING: reject, no guessing.
  UPLOAD_BAD_ENTRY_NAME: {
    httpStatus: 415,
    userMessage: 'Archive contains unsupported file names.',
    logLevel: 'warn',
    alerts: false,
  },
  // PENDING: watchdog timeout.
  UPLOAD_JOB_TIMEOUT: {
    httpStatus: 500,
    userMessage: 'Upload processing timed out.',
    logLevel: 'error',
    alerts: true,
  },
  STORAGE_ERROR: {
    httpStatus: 502,
    userMessage: 'Storage is temporarily unavailable.',
    logLevel: 'error',
    alerts: true,
  },
  // VALIDATION_* family row: V is "per-field message" — the per-field text
  // travels in `details[]`, the envelope message is generic.
  VALIDATION_BAD_QUERY: {
    httpStatus: 422,
    userMessage: 'Invalid input.',
    logLevel: 'info',
    alerts: false,
  },
  VALIDATION_PASSWORD_POLICY: {
    httpStatus: 422,
    userMessage: 'Invalid input.',
    logLevel: 'info',
    alerts: false,
  },
  RATE_LIMIT_LOGIN: {
    httpStatus: 429,
    userMessage: 'Too many requests. Try again soon.',
    logLevel: 'warn',
    alerts: true,
  },
  RATE_LIMIT_REGISTER: {
    httpStatus: 429,
    userMessage: 'Too many requests. Try again soon.',
    logLevel: 'warn',
    alerts: true,
  },
  RATE_LIMIT_RESET: {
    httpStatus: 429,
    userMessage: 'Too many requests. Try again soon.',
    logLevel: 'warn',
    alerts: true,
  },
  RATE_LIMIT_SEARCH: {
    httpStatus: 429,
    userMessage: 'Too many requests. Try again soon.',
    logLevel: 'warn',
    alerts: true,
  },
  RATE_LIMIT_UPLOAD: {
    httpStatus: 429,
    userMessage: 'Too many requests. Try again soon.',
    logLevel: 'warn',
    alerts: true,
  },
  RATE_LIMIT_BEACON: {
    httpStatus: 429,
    userMessage: 'Too many requests. Try again soon.',
    logLevel: 'warn',
    alerts: true,
  },
  RATE_LIMIT_GENERIC: {
    httpStatus: 429,
    userMessage: 'Too many requests. Try again soon.',
    logLevel: 'warn',
    alerts: true,
  },
  ADMIN_LAST_ADMIN: {
    httpStatus: 409,
    userMessage: 'Another admin is required.',
    logLevel: 'warn',
    alerts: false,
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    userMessage: 'Something went wrong.',
    logLevel: 'error',
    alerts: true,
  },
};

/**
 * The exhaustive `switch` in `getErrorMapping` is the runtime totality proof;
 * this is its compile-time mirror. `Unmapped` is `never` **only** while every
 * `ErrorCode` is a key of the data table — add a code without a mapping and
 * this line stops compiling.
 */
type Unmapped = Exclude<ErrorCode, keyof typeof ERROR_MAPPINGS>;
const TABLE_IS_TOTAL: [Unmapped] extends [never] ? true : false = true;

/** The three 5xx user-visible messages; none of them may describe an internal. */
const SERVER_SIDE_MESSAGES = [
  'Something went wrong.',
  'Storage is temporarily unavailable.',
  'Upload processing timed out.',
] as const;

/** Paths, URLs, vendor/system identifiers, or stack frames in a user message. */
const INTERNAL_LEAK =
  /[/\\{}]|\b(?:stack|traceback|exception|ENOENT|EACCES|SQL|postgres|minio|s3)\b/i;

/**
 * The same check for a serialized body: braces are JSON syntax there, so only
 * path separators and internal tokens remain meaningful.
 */
const INTERNAL_LEAK_IN_JSON =
  /[/\\]|\b(?:stack|traceback|exception|ENOENT|EACCES|SQL|postgres|minio)\b/i;

/**
 * `Object.keys` returns `string[]`; the cast is safe because `EXPECTED` is a
 * mapped type over `ErrorCode` — a key outside the union cannot exist there
 * (that would itself be a compile error above).
 */
const ALL_CODES = Object.keys(EXPECTED) as ErrorCode[];

describe('error mapping totality', () => {
  it('TABLE_IS_TOTAL holds: no ErrorCode is outside the data table', () => {
    expect(TABLE_IS_TOTAL).toBe(true);
  });

  it('every code resolves to its mapping row via getErrorMapping', () => {
    for (const code of ALL_CODES) {
      const expected = EXPECTED[code];
      expect(getErrorMapping(code)).toEqual({ code, ...expected });
    }
  });

  it('the data table has no code the contract does not define', () => {
    expect(Object.keys(ERROR_MAPPINGS).sort()).toEqual([...ALL_CODES].sort());
  });

  it('the data table is frozen (the mapping is data, not a mutable cache)', () => {
    // `Object.isFrozen(undefined)` is `true`, so assert the shape first —
    // otherwise this test would pass on a missing table.
    expect(ERROR_MAPPINGS).toBeTypeOf('object');
    expect(Object.keys(ERROR_MAPPINGS).length).toBe(ALL_CODES.length);
    expect(Object.isFrozen(ERROR_MAPPINGS)).toBe(true);
  });

  it('every entry carries its own key, a status, a level and an alert flag', () => {
    for (const code of ALL_CODES) {
      const mapping = getErrorMapping(code);
      expect(mapping.code).toBe(code);
      expect(Number.isInteger(mapping.httpStatus)).toBe(true);
      expect(mapping.userMessage.length).toBeGreaterThan(0);
      expect(['info', 'warn', 'error']).toContain(mapping.logLevel);
      expect(typeof mapping.alerts).toBe('boolean');
    }
  });
});

describe('5xx bodies never carry internals', () => {
  it('every 5xx maps to a generic user-visible message and logs at error', () => {
    const serverSide = ALL_CODES.filter((code) => EXPECTED[code].httpStatus >= 500);
    expect(serverSide).toContain('INTERNAL_ERROR');
    expect(serverSide).toContain('STORAGE_ERROR');
    for (const code of serverSide) {
      const mapping = getErrorMapping(code);
      expect(SERVER_SIDE_MESSAGES).toContain(mapping.userMessage as never);
      expect(mapping.logLevel).toBe('error');
    }
  });

  it('no user-visible message contains a path, URL, or internal identifier', () => {
    for (const code of ALL_CODES) {
      expect(getErrorMapping(code).userMessage).not.toMatch(INTERNAL_LEAK);
    }
  });

  it('the mapped 5xx envelope leaks nothing even when the thrower attached a cause', () => {
    const cause = new Error('connect ECONNREFUSED 10.0.0.7:5432');
    cause.stack = 'Error: connect ECONNREFUSED\n    at db (src/server/db/client.ts:42:11)';
    const { body } = toRouteError(new AppError('INTERNAL_ERROR', { cause }), 'req-1');

    const serialized = JSON.stringify(body);
    expect(body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong.',
      requestId: 'req-1',
    });
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('10.0.0.7');
    expect(serialized).not.toContain('client.ts');
    expect(serialized).not.toMatch(INTERNAL_LEAK_IN_JSON);
  });
});

describe('AppError (typed thrower)', () => {
  it('is a real Error whose message is the mapped user-visible literal', () => {
    const error = new AppError('MANGA_NOT_FOUND');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('MANGA_NOT_FOUND');
    expect(error.message).toBe('Manga not found.');
    expect(error.details).toBeUndefined();
  });

  it('carries the internal cause for logs without putting it in the message', () => {
    const cause = new Error('select * from manga where id = $1 failed');
    const error = new AppError('INTERNAL_ERROR', { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('Something went wrong.');
  });

  it('VALIDATION_* carries per-field detail without an internal message', () => {
    const error = new AppError('VALIDATION_PASSWORD_POLICY', {
      details: [{ path: 'password', message: 'Use at least 12 characters.' }],
    });
    const { body } = toRouteError(error, 'req-2');

    expect(body.error.message).toBe('Invalid input.');
    expect(body.error.details).toEqual([
      { path: 'password', message: 'Use at least 12 characters.' },
    ]);
    for (const detail of body.error.details ?? []) {
      expect(detail.message).not.toMatch(INTERNAL_LEAK);
    }
    expect(JSON.stringify(body)).not.toMatch(INTERNAL_LEAK_IN_JSON);
  });

  it('accepts a detail without a field path (whole-payload validation)', () => {
    const error = new AppError('VALIDATION_BAD_QUERY', {
      details: [{ message: 'The query is empty.' }],
    });
    expect(error.details).toEqual([{ message: 'The query is empty.' }]);
  });
});

describe('toRouteError (the route-handler helper)', () => {
  it('exposes the status, level and alert flag a handler needs', () => {
    expect(toRouteError(new AppError('AUTH_INVALID_CREDENTIALS'), 'req-3')).toEqual({
      httpStatus: 401,
      logLevel: 'warn',
      alerts: true,
      body: {
        error: {
          code: 'AUTH_INVALID_CREDENTIALS',
          message: 'Invalid email or password.',
          requestId: 'req-3',
        },
      },
    });
  });

  it('always carries a requestId, even for a 4xx with no detail', () => {
    const { body } = toRouteError(new AppError('MANGA_NOT_FOUND'), 'req-4');
    expect(body.error.requestId).toBe('req-4');
    expect(body.error.details).toBeUndefined();
  });

  it('returns the same values as getErrorMapping for every code', () => {
    for (const code of ALL_CODES) {
      const mapping = getErrorMapping(code);
      const { httpStatus, logLevel, alerts } = toRouteError(new AppError(code), 'req-5');
      expect({ httpStatus, logLevel, alerts }).toEqual({
        httpStatus: mapping.httpStatus,
        logLevel: mapping.logLevel,
        alerts: mapping.alerts,
      });
    }
  });
});
