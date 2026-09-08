/**
 * Unit tests — structured logging foundation.
 * This file IS the redaction contract: every assertion reads the emitted JSON
 * line off the logger's stream, never the redactor's return value — a secret
 * that reaches the stream is the failure that matters. A row also asserts a
 * non-sensitive SIBLING survives, so a redactor that emptied the event cannot
 * pass. No I/O beyond the injected in-memory sink.
 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/shared/validation/env';
import type { Env, EnvSource } from '../../src/shared/validation/env';
import { safeStringify } from '../../src/server/telemetry/redaction';
import { createLogger, createRequestLogger, levelForEnv } from '../../src/server/telemetry/logger';
import type { LogDestination, LogFields, LogLevel } from '../../src/server/telemetry/logger';

// environment fixture (the secrets this file asserts never leak)

/** 64 hex characters = 256 bits. */
const SESSION_SECRET = 'a1b2c3d4e5f6'.repeat(5) + 'abcd';
const DATABASE_URL = 'postgres://yomi:pgpassw0rd@db.internal:5432/yomi';
const ACCESS_KEY_ID = 'minio-access-key-id';
const SECRET_ACCESS_KEY = 'minio-secret-key-value';
const MAIL_USER = 'yomi-mailer';
const MAIL_PASS = 'mailer-password';
const MAIL_FROM = 'yomi@example.com';

/** Every required environment variable, with both secret groups complete. */
const BASE_ENV: EnvSource = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://reader.example.com',
  SESSION_SECRET,
  DATABASE_URL,
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_BUCKET: 'yomi-media',
  S3_ACCESS_KEY_ID: ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
  NEXT_TELEMETRY_DISABLED: '1',
  MAIL_FROM,
  MAIL_HOST: 'smtp.example.com',
  MAIL_PORT: '587',
  MAIL_USER,
  MAIL_PASS,
};

/** The validated, frozen `Env` the logger consumes. */
const ENV: Env = loadEnv(BASE_ENV, { onWarn: () => {} });

/** `BASE_ENV` in one other NODE_ENV, for the per-environment level table. */
function envFor(nodeEnv: EnvSource[string]): Env {
  return loadEnv({ ...BASE_ENV, NODE_ENV: nodeEnv }, { onWarn: () => {} });
}

// capture sink (the "log capture" seam)

/** In-memory pino destination: one captured line per `write()`. */
class CaptureDestination implements LogDestination {
  readonly lines: string[] = [];

  write(chunk: string): void {
    this.lines.push(chunk);
  }

  /** The last line, parsed. Fails loudly if the output is not one JSON object. */
  last(): Record<string, unknown> {
    const raw = this.lines.at(-1);
    if (raw === undefined) {
      throw new Error('no log line was written');
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`log line is not a JSON object: ${raw}`);
    }
    return parsed as Record<string, unknown>;
  }
}

/** Emits one line through a real logger and returns both the object and text. */
function emit(
  fields: LogFields,
  message = 'emitted',
): {
  readonly line: Record<string, unknown>;
  readonly text: string;
} {
  const destination = new CaptureDestination();
  const logger = createLogger(ENV, { level: 'debug', destination });
  logger.info(fields, message);
  return { line: destination.last(), text: destination.lines.join('') };
}

/** Reads a dotted path out of an emitted line. */
function get(line: Record<string, unknown>, path: string): unknown {
  let current: unknown = line;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** One exact expectation, addressed by dotted path (`a.b.0.c`). */
interface Expectation {
  readonly path: string;
  readonly value: unknown;
}

/** One row of the redaction table: a sensitive input class and its proof. */
interface RedactionRow {
  /** Stable id `class/case` — printed with the test name. */
  readonly id: string;
  /** The sensitive input class in prose (the table's first column). */
  readonly inputClass: string;
  /** The event payload handed to the logger, including the sibling fields. */
  readonly fields: LogFields;
  /** The log message, when the sensitive text lives in the message. */
  readonly message?: string;
  /** Substrings that must NOT appear anywhere in the serialized line. */
  readonly forbidden: readonly string[];
  /** Exact expectations for the redacted output. */
  readonly expect: readonly Expectation[];
  /** Row-specific assertions (lengths, no separator, marker prefix, …). */
  readonly extra?: (line: Record<string, unknown>) => void;
}

/**
 * The non-sensitive sibling every row carries. A redactor that dropped the
 * event payload to protect one field would fail every row here.
 */
const SIBLING = { event: 'catalog.list', count: 3 } as const;

/** 203 characters — over the 80-character limit. */
const LONG_FILE_NAME = 'a'.repeat(200) + '.zip';

/** An object that refers to itself. */
function selfCircular(): Record<string, unknown> {
  const node: Record<string, unknown> = { name: 'root' };
  node['self'] = node;
  return node;
}

/** Two plain objects that refer to each other. */
function mutuallyCircular(): Record<string, unknown> {
  const a: Record<string, unknown> = { name: 'a' };
  const b: Record<string, unknown> = { name: 'b' };
  a['other'] = b;
  b['other'] = a;
  return { a, b };
}

/** A class instance whose field holds a credential (never walked). */
class SecretBearing {
  readonly dsn = DATABASE_URL;
}

/** `{ ownKeys }` throws: no property list can be produced at all. */
function hostileProxy(): unknown {
  return new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('ownKeys denied');
      },
      getOwnPropertyDescriptor() {
        throw new Error('gopd denied');
      },
      get() {
        throw new Error('get denied');
      },
    },
  );
}

const REDACTION_TABLE: readonly RedactionRow[] = [
  // email: first 3 chars + ***
  {
    id: 'email/value',
    inputClass: 'email as a field value',
    fields: { ...SIBLING, contact: 'reader@example.com' },
    forbidden: ['reader@example.com', 'example.com', 'reader@'],
    expect: [
      { path: 'contact', value: 'rea***' },
      { path: 'event', value: 'catalog.list' },
      { path: 'count', value: 3 },
    ],
  },
  {
    id: 'email/prose',
    inputClass: 'email inside a log message',
    fields: { ...SIBLING },
    message: 'reset link sent to reader@example.com',
    forbidden: ['reader@example.com', 'example.com'],
    expect: [{ path: 'msg', value: 'reset link sent to rea***' }],
  },
  {
    id: 'email/short-local-part',
    inputClass: 'email whose local part is shorter than 3 chars',
    fields: { ...SIBLING, contact: 'a@b.co' },
    forbidden: ['a@b.co', 'b.co'],
    expect: [{ path: 'contact', value: 'a***' }],
  },
  {
    id: 'email/env-mail-from',
    inputClass: 'Env.mail.from — PII but not a credential: email rule, not [REDACTED]',
    fields: { ...SIBLING, from: MAIL_FROM },
    forbidden: ['yomi@example.com', 'example.com'],
    expect: [{ path: 'from', value: 'yom***' }],
  },
  {
    id: 'email/at-sign-is-not-an-email',
    inputClass: 'a non-email string that merely contains "@"',
    fields: { ...SIBLING, note: 'ratio 3@4 approved' },
    forbidden: [],
    expect: [{ path: 'note', value: 'ratio 3@4 approved' }],
  },

  // secret VALUES held in the environment
  {
    id: 'secret/env-session-secret',
    inputClass: 'Env.sessionSecret as a field value',
    fields: { ...SIBLING, note: SESSION_SECRET },
    forbidden: [SESSION_SECRET, 'a1b2c3d4e5f6'],
    expect: [{ path: 'note', value: '[REDACTED]' }],
  },
  {
    id: 'secret/env-database-url',
    inputClass: 'Env.databaseUrl (a DSN carrying credentials)',
    fields: { ...SIBLING, dsn: DATABASE_URL },
    forbidden: ['pgpassw0rd', 'postgres://', 'yomi:'],
    expect: [{ path: 'dsn', value: '[REDACTED]' }],
  },
  {
    id: 'secret/env-storage-secret-key',
    inputClass: 'Env.storage.secretAccessKey',
    fields: { ...SIBLING, key: SECRET_ACCESS_KEY },
    forbidden: [SECRET_ACCESS_KEY],
    expect: [{ path: 'key', value: '[REDACTED]' }],
  },
  {
    id: 'secret/env-storage-access-key-id',
    inputClass: 'Env.storage.accessKeyId',
    fields: { ...SIBLING, key: ACCESS_KEY_ID },
    forbidden: [ACCESS_KEY_ID],
    expect: [{ path: 'key', value: '[REDACTED]' }],
  },
  {
    id: 'secret/env-mail-credentials',
    inputClass: 'Env.mail.user + Env.mail.pass',
    fields: { ...SIBLING, user: MAIL_USER, pass: MAIL_PASS },
    forbidden: [MAIL_USER, MAIL_PASS],
    expect: [
      { path: 'user', value: '[REDACTED]' },
      { path: 'pass', value: '[REDACTED]' },
    ],
  },
  {
    id: 'secret/env-value-in-prose',
    inputClass: 'a secret env value spliced into a sentence',
    fields: { ...SIBLING },
    message: `connecting to ${DATABASE_URL} failed`,
    forbidden: ['pgpassw0rd', 'db.internal'],
    expect: [{ path: 'msg', value: 'connecting to [REDACTED] failed' }],
  },
  {
    id: 'secret/non-credential-env-value',
    inputClass: 'a non-secret env value (the S3 bucket) is NOT redacted',
    fields: { ...SIBLING, bucket: 'yomi-media' },
    forbidden: [],
    expect: [{ path: 'bucket', value: 'yomi-media' }],
  },

  // secret PATTERNS in free text
  {
    id: 'secret/url-userinfo',
    inputClass: 'credentials embedded in a URL',
    fields: { ...SIBLING },
    message: 'connecting to https://admin:s3cr3t@files.example.com/bucket',
    forbidden: ['s3cr3t', 'admin:'],
    expect: [{ path: 'msg', value: 'connecting to https://[REDACTED]@files.example.com/bucket' }],
  },
  {
    id: 'secret/assignment',
    inputClass: 'secret-shaped `key=value` in a message',
    fields: { ...SIBLING },
    message: 'login failed password=hunter2 attempts=2',
    forbidden: ['hunter2'],
    expect: [{ path: 'msg', value: 'login failed password=[REDACTED] attempts=2' }],
  },
  {
    id: 'secret/bearer-token',
    inputClass: 'Authorization: Bearer <jwt>',
    fields: { ...SIBLING },
    message: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigval',
    forbidden: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'sigval'],
    expect: [{ path: 'msg', value: 'Authorization: Bearer [REDACTED]' }],
  },
  {
    id: 'secret/bare-jwt',
    inputClass: 'a bare JWT with no Bearer prefix',
    fields: { ...SIBLING },
    message: 'token eyJhbGciOi.eyJzdWIi.sigval rejected',
    forbidden: ['eyJhbGciOi', 'eyJzdWIi', 'sigval'],
    expect: [{ path: 'msg', value: 'token [REDACTED] rejected' }],
  },
  {
    id: 'secret/api-key',
    inputClass: 'a vendor API key (`sk-…`)',
    fields: { ...SIBLING },
    message: 'calling sk-abcdefghijklmnopqrstuvwx now',
    forbidden: ['sk-abcdefghijklmnopqrstuvwx'],
    expect: [{ path: 'msg', value: 'calling [REDACTED] now' }],
  },
  {
    id: 'secret/pem-block',
    inputClass: 'a PEM private key block spanning several lines',
    fields: { ...SIBLING },
    message:
      'key was -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY----- here',
    forbidden: ['MIIEow', 'BEGIN RSA PRIVATE KEY'],
    expect: [{ path: 'msg', value: 'key was [REDACTED] here' }],
  },

  // secret-shaped KEYS at any depth
  {
    id: 'secret/key-password',
    inputClass: 'a field named `password`',
    fields: { ...SIBLING, password: 'hunter2', user: 'admin' },
    forbidden: ['hunter2'],
    expect: [
      { path: 'password', value: '[REDACTED]' },
      { path: 'user', value: 'admin' },
    ],
  },
  {
    id: 'secret/key-session-secret',
    inputClass: 'a field named `sessionSecret` (camelCase is normalized)',
    fields: { ...SIBLING, sessionSecret: 'whatever' },
    forbidden: ['whatever'],
    expect: [{ path: 'sessionSecret', value: '[REDACTED]' }],
  },
  {
    id: 'secret/key-snake-case',
    inputClass: 'a field named `db_url` (snake_case is normalized)',
    fields: { ...SIBLING, db_url: DATABASE_URL },
    forbidden: ['pgpassw0rd', 'postgres://'],
    expect: [{ path: 'db_url', value: '[REDACTED]' }],
  },
  {
    id: 'secret/key-cookie',
    inputClass: 'a field named `cookie`',
    fields: { ...SIBLING, cookie: 'sid=abc123' },
    forbidden: ['sid=abc123'],
    expect: [{ path: 'cookie', value: '[REDACTED]' }],
  },
  {
    id: 'secret/nested-four-levels',
    inputClass: 'a secret four levels deep, with a sibling that must survive',
    fields: {
      ...SIBLING,
      context: {
        request: {
          meta: { token: 'tok_live_123', issuedAt: 1_700_000_000 },
          slug: 'berserk',
        },
      },
    },
    forbidden: ['tok_live_123'],
    expect: [
      { path: 'context.request.meta.token', value: '[REDACTED]' },
      { path: 'context.request.meta.issuedAt', value: 1_700_000_000 },
      { path: 'context.request.slug', value: 'berserk' },
    ],
  },
  {
    id: 'secret/nested-secret-shaped-parent',
    inputClass: 'a secret-shaped PARENT key replaces the whole subtree',
    fields: {
      ...SIBLING,
      context: { request: { credentials: { token: 'tok_live_123' }, slug: 'berserk' } },
    },
    forbidden: ['tok_live_123'],
    expect: [
      { path: 'context.request.credentials', value: '[REDACTED]' },
      { path: 'context.request.slug', value: 'berserk' },
    ],
  },
  {
    id: 'secret/array-element',
    inputClass: 'a secret inside an array',
    fields: { ...SIBLING, attempts: ['ok', 'password=letmein', 'ok'] },
    forbidden: ['letmein'],
    expect: [
      { path: 'attempts.0', value: 'ok' },
      { path: 'attempts.1', value: 'password=[REDACTED]' },
      { path: 'attempts.2', value: 'ok' },
    ],
  },
  {
    id: 'secret/error-message',
    inputClass: "an Error's message and its stack",
    fields: {
      ...SIBLING,
      error: Object.assign(new Error('upload failed for reader@example.com: password=hunter2'), {
        code: 'UPLOAD_FAILED',
      }),
    },
    forbidden: ['reader@example.com', 'hunter2'],
    expect: [
      { path: 'error.name', value: 'Error' },
      { path: 'error.code', value: 'UPLOAD_FAILED' },
      { path: 'error.message', value: 'upload failed for rea***: password=[REDACTED]' },
    ],
  },

  // paths & file names: path-stripped, cut to 80 chars
  {
    id: 'path/upload-file-name',
    inputClass: 'an upload file name under a file-ish key: stripped, then cut to 80',
    fields: { ...SIBLING, filename: `/srv/yomi/uploads/2026/${LONG_FILE_NAME}` },
    forbidden: [LONG_FILE_NAME, '/srv/yomi'],
    expect: [{ path: 'event', value: 'catalog.list' }],
    extra: (line) => {
      const value = get(line, 'filename');
      expect(typeof value).toBe('string');
      expect(value).toHaveLength(80);
      expect(String(value).endsWith('...')).toBe(true);
      expect(String(value)).not.toContain('/');
    },
  },
  {
    id: 'path/windows-file-name',
    inputClass: 'a Windows path under a file-ish key',
    fields: { ...SIBLING, filepath: 'C:\\Users\\admin\\uploads\\chapter 01.zip' },
    forbidden: ['C:\\Users', 'Users\\admin'],
    expect: [{ path: 'filepath', value: 'chapter 01.zip' }],
  },
  {
    id: 'path/absolute-path-in-prose',
    inputClass: 'an absolute path carrying a file extension inside a message',
    fields: { ...SIBLING },
    message: 'reading /home/admin/Downloads/secret-chapter.zip now',
    forbidden: ['/home/admin', 'Downloads'],
    expect: [{ path: 'msg', value: 'reading secret-chapter.zip now' }],
  },
  {
    id: 'path/route-is-not-a-path',
    inputClass: 'a route template survives (no file extension ⇒ not a path)',
    fields: { ...SIBLING, route: '/api/v1/manga/{slug}/chapters' },
    forbidden: [],
    expect: [{ path: 'route', value: '/api/v1/manga/{slug}/chapters' }],
  },
  {
    id: 'path/long-name-at-the-root',
    inputClass: 'a 203-char name that is already a bare name is still cut to 80',
    fields: { ...SIBLING, file: LONG_FILE_NAME },
    forbidden: [LONG_FILE_NAME],
    expect: [],
    extra: (line) => {
      expect(get(line, 'file')).toHaveLength(80);
    },
  },

  // non-serializable values
  {
    id: 'nonserializable/bigint',
    inputClass: 'BigInt',
    fields: { ...SIBLING, bytes: 4096n },
    forbidden: [],
    expect: [{ path: 'bytes', value: '4096' }],
  },
  {
    id: 'nonserializable/function',
    inputClass: 'a named function',
    fields: { ...SIBLING, transform: function transformPage() {} },
    forbidden: [],
    expect: [{ path: 'transform', value: '[Function:transformPage]' }],
  },
  {
    id: 'nonserializable/symbol',
    inputClass: 'Symbol',
    fields: { ...SIBLING, marker: Symbol('token') },
    forbidden: [],
    expect: [{ path: 'marker', value: '[Symbol]' }],
  },
  {
    id: 'nonserializable/nan-infinity',
    inputClass: 'NaN / Infinity — numbers JSON cannot encode',
    fields: { ...SIBLING, ratio: Number.NaN, cap: Number.POSITIVE_INFINITY },
    forbidden: [],
    expect: [
      { path: 'ratio', value: '[Number:NaN]' },
      { path: 'cap', value: '[Number:Infinity]' },
    ],
  },
  {
    id: 'nonserializable/date',
    inputClass: 'Date',
    fields: { ...SIBLING, at: new Date('2026-09-26T00:00:00.000Z') },
    forbidden: [],
    expect: [{ path: 'at', value: '2026-09-26T00:00:00.000Z' }],
  },
  {
    id: 'nonserializable/url',
    inputClass: 'a URL object carrying credentials',
    fields: { ...SIBLING, endpoint: new URL('https://admin:s3cr3t@files.example.com/b') },
    forbidden: ['s3cr3t', 'admin:'],
    expect: [{ path: 'endpoint', value: 'https://[REDACTED]@files.example.com/b' }],
  },
  {
    id: 'nonserializable/circular-self',
    inputClass: 'an object referring to itself',
    fields: { ...SIBLING, node: selfCircular() },
    forbidden: [],
    expect: [
      { path: 'node.name', value: 'root' },
      { path: 'node.self', value: '[Circular]' },
    ],
  },
  {
    id: 'nonserializable/circular-mutual',
    inputClass: 'two objects referring to each other',
    fields: { ...SIBLING, ...mutuallyCircular() },
    forbidden: [],
    expect: [
      { path: 'a.name', value: 'a' },
      { path: 'a.other.name', value: 'b' },
      { path: 'b.other.name', value: 'a' },
      { path: 'b.other.other', value: '[Circular]' },
    ],
  },
  {
    id: 'nonserializable/class-instance',
    inputClass: 'a class instance — only plain objects and arrays are walked',
    fields: { ...SIBLING, repo: new SecretBearing() },
    forbidden: ['pgpassw0rd'],
    expect: [{ path: 'repo', value: '[SecretBearing]' }],
  },
  {
    id: 'nonserializable/map-set',
    inputClass: 'Map / Set',
    fields: { ...SIBLING, m: new Map([['k', 'v']]), s: new Set([1]) },
    forbidden: [],
    expect: [
      { path: 'm', value: '[Map]' },
      { path: 's', value: '[Set]' },
    ],
  },
  {
    id: 'nonserializable/hostile-getter',
    inputClass: 'a property whose getter throws',
    fields: {
      ...SIBLING,
      trap: {
        get boom(): string {
          throw new Error('boom denied');
        },
      },
    },
    forbidden: ['denied'],
    expect: [{ path: 'trap.boom', value: '[Unreadable]' }],
  },
  {
    id: 'nonserializable/hostile-proxy',
    inputClass: 'a Proxy that throws on every trap',
    fields: { ...SIBLING, evil: hostileProxy() },
    forbidden: ['denied'],
    expect: [{ path: 'evil', value: '[Unserializable]' }],
  },
  {
    id: 'nonserializable/hostile-to-json',
    inputClass: 'an object whose toJSON() throws — toJSON is never called',
    fields: {
      ...SIBLING,
      sneaky: {
        toJSON: () => {
          throw new Error('toJSON denied');
        },
      },
    },
    forbidden: ['denied'],
    expect: [],
    extra: (line) => {
      expect(String(get(line, 'sneaky.toJSON'))).toMatch(/^\[Function/);
    },
  },
];

describe('redaction table', () => {
  for (const row of REDACTION_TABLE) {
    it(`redacts ${row.id} — ${row.inputClass}`, () => {
      const { line, text } = emit(row.fields, row.message);

      for (const forbidden of row.forbidden) {
        expect(text, `${row.id}: "${forbidden}" leaked`).not.toContain(forbidden);
      }
      for (const expectation of row.expect) {
        expect(get(line, expectation.path), `${row.id}: ${expectation.path}`).toEqual(
          expectation.value,
        );
      }
      // The non-sensitive sibling survives: redaction is per-value, not a wipe.
      expect(get(line, 'event'), `${row.id}: sibling event`).toBe(SIBLING.event);
      expect(get(line, 'count'), `${row.id}: sibling count`).toBe(SIBLING.count);
      row.extra?.(line);
    });
  }

  it('covers every sensitive input class (a pruned table is a weaker contract)', () => {
    expect(REDACTION_TABLE.length).toBeGreaterThanOrEqual(30);
  });
});

describe('non-serializable and circular values (edge cases)', () => {
  it('keeps the line valid JSON when the payload mixes every hostile shape', () => {
    const payload: Record<string, unknown> = {
      event: 'uploads.processJob',
      big: 1n,
      fn: () => 1,
      sym: Symbol('s'),
      map: new Map([['a', 'b']]),
      nan: Number.NaN,
      undef: undefined,
      nested: { at: new Date(0), re: /x/gi },
    };
    payload['self'] = payload;
    payload['arr'] = [payload, payload];

    const { line } = emit(payload);

    expect(line['event']).toBe('uploads.processJob');
    expect(line['big']).toBe('1');
    expect(line['nan']).toBe('[Number:NaN]');
    expect(line['undef']).toBeNull();
    expect(line['self']).toBe('[Circular]');
    expect(get(line, 'arr.0')).toBe('[Circular]');
    expect(get(line, 'arr.1')).toBe('[Circular]');
    expect(get(line, 'nested.at')).toBe('1970-01-01T00:00:00.000Z');
    expect(get(line, 'nested.re')).toBe('/x/gi');
  });

  it('never returns a value the JSON encoder would refuse', () => {
    const { line } = emit({ event: 'x', big: 1n, fn: () => 1, sym: Symbol('s') });
    expect(() => JSON.stringify(line)).not.toThrow();
  });
});

describe('the safe stringifier cannot throw', () => {
  it('returns a string for a circular structure with a non-serializable payload', () => {
    const hostile: Record<string, unknown> = {
      big: 1n,
      fn: () => 1,
      sym: Symbol('s'),
      map: new Map([['a', 'b']]),
      nan: Number.NaN,
      undef: undefined,
    };
    hostile['self'] = hostile;
    hostile['arr'] = [hostile];

    let output = '';
    expect(() => {
      output = safeStringify(hostile);
    }).not.toThrow();
    expect(typeof output).toBe('string');
    expect(JSON.parse(output)).toMatchObject({ big: '1', self: '[Circular]' });
  });

  it('returns a fallback string for a value no walk can read', () => {
    expect(() => safeStringify(hostileProxy())).not.toThrow();
    expect(typeof safeStringify(hostileProxy())).toBe('string');
  });

  it('redacts while stringifying (it is not a bypass of the redaction contract)', () => {
    expect(safeStringify({ contact: 'reader@example.com' })).not.toContain('example.com');
  });
});

describe('JSON line shape and per-environment level', () => {
  it('emits one JSON object per line with the documented base fields', () => {
    const destination = new CaptureDestination();
    const logger = createLogger(ENV, { level: 'debug', destination });
    logger.warn({ route: '/api/v1/manga/{slug}/chapters', status: 200, durationMs: 12 }, 'served');

    expect(destination.lines).toHaveLength(1);
    const text = destination.lines[0] ?? '';
    expect(text.startsWith('{')).toBe(true);
    expect(text.trimEnd().endsWith('}')).toBe(true);
    expect(text.trimEnd().includes('\n')).toBe(false);

    const line = destination.last();
    expect(Object.keys(line).sort()).toEqual([
      'durationMs',
      'level',
      'msg',
      'route',
      'status',
      'time',
    ]);
    expect(line['msg']).toBe('served');
    expect(typeof line['level']).toBe('number');
    expect(typeof line['time']).toBe('number');
  });

  it('maps each environment to its documented level', () => {
    const table: readonly { nodeEnv: 'development' | 'test' | 'production'; level: LogLevel }[] = [
      { nodeEnv: 'production', level: 'info' },
      { nodeEnv: 'development', level: 'debug' },
      { nodeEnv: 'test', level: 'silent' },
    ];
    for (const { nodeEnv, level } of table) {
      expect(levelForEnv(nodeEnv)).toBe(level);
      const logger = createLogger(envFor(nodeEnv));
      expect(logger.level).toBe(level);
    }
  });

  it('drops a line below the configured level', () => {
    const destination = new CaptureDestination();
    const logger = createLogger(ENV, { level: 'info', destination });
    logger.debug({ event: 'storage.get' }, 'below the threshold');
    logger.info({ event: 'storage.get' }, 'at the threshold');
    expect(destination.lines).toHaveLength(1);
    expect(destination.last()['msg']).toBe('at the threshold');
  });
});

describe('request child loggers (base fields)', () => {
  it('binds requestId on every line of the child', () => {
    const destination = new CaptureDestination();
    const root = createLogger(ENV, { level: 'debug', destination });
    const request = createRequestLogger(root, { requestId: '5f1c1a2b3c4d5e6f7a8b9c0d1e2f3a4b' });

    request.info({ event: 'request.start' }, 'start');
    request.error({ event: 'request.fail' }, 'fail');
    const child = request.child({ jobId: 'job_7' });
    child.info({ event: 'job.transition' }, 'transition');

    expect(destination.lines).toHaveLength(3);
    for (const line of destination.lines) {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toMatchObject({ requestId: '5f1c1a2b3c4d5e6f7a8b9c0d1e2f3a4b' });
    }
    expect(JSON.parse(destination.lines[2] ?? '')).toMatchObject({ jobId: 'job_7' });
  });

  it('leaves the traceId slot empty until trace emission lands', () => {
    const destination = new CaptureDestination();
    const root = createLogger(ENV, { level: 'debug', destination });
    createRequestLogger(root, { requestId: 'abc123' }).info({ event: 'x' }, 'no trace yet');
    expect(Object.keys(destination.last())).not.toContain('traceId');

    createRequestLogger(root, {
      requestId: 'abc123',
      traceId: '0af7651916cd43dd8448eb211c80319c',
    }).info({ event: 'x' }, 'traced');
    expect(destination.last()['traceId']).toBe('0af7651916cd43dd8448eb211c80319c');
  });

  it('refuses a request id that could forge a log line (header injection)', () => {
    const destination = new CaptureDestination();
    const root = createLogger(ENV, { level: 'debug', destination });
    const request = createRequestLogger(root, {
      requestId: 'ok-id\n{"level":30,"msg":"forged"',
    });
    request.info({ event: 'x' }, 'injected');
    const text = destination.lines[0] ?? '';
    expect(text).not.toContain('forged');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(String(destination.last()['requestId'])).toMatch(/^\[invalid-request-id\]$/);
  });

  it('redacts the request context too (a binding is a value like any other)', () => {
    const destination = new CaptureDestination();
    const root = createLogger(ENV, { level: 'debug', destination });
    createRequestLogger(root, { requestId: 'abc123', userId: 'reader@example.com' }).info(
      { event: 'x' },
      'bound',
    );
    expect(destination.lines[0] ?? '').not.toContain('example.com');
    expect(destination.last()['userId']).toBe('rea***');
  });

  it('does not let a call site forge a bound correlation field', () => {
    const destination = new CaptureDestination();
    const root = createLogger(ENV, { level: 'debug', destination });
    const request = createRequestLogger(root, { requestId: 'real-id' });
    request.info({ event: 'x', requestId: 'spoofed-id' }, 'override attempt');
    expect(destination.last()['requestId']).toBe('real-id');
  });
});

describe('the logger itself cannot throw (edge cases)', () => {
  it('returns normally when the destination throws', () => {
    const failing: LogDestination = {
      write() {
        throw new Error('disk full');
      },
    };
    const logger = createLogger(ENV, { level: 'debug', destination: failing });

    const original = process.stderr.write.bind(process.stderr);
    let stderr = '';
    process.stderr.write = (chunk: string): boolean => {
      stderr += chunk;
      return true;
    };
    try {
      expect(() => logger.info({ event: 'x' }, 'must not throw')).not.toThrow();
    } finally {
      process.stderr.write = original;
    }
    expect(stderr).toContain('yomi');
    expect(stderr).not.toContain('disk full');
  });

  it('emits a line for a hostile payload without throwing', () => {
    expect(() =>
      emit({
        evil: hostileProxy(),
        trap: {
          get a(): string {
            throw new Error('x');
          },
        },
      }),
    ).not.toThrow();
  });
});
