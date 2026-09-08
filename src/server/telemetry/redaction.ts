/**
 * server/telemetry — redaction + non-throwing serialization for every log line.
 * Redaction is applied to VALUES, so a non-sensitive sibling of a redacted field
 * is still logged; a field whose NAME is secret-shaped is never even read, and
 * `toJSON` is never invoked. Every marker is a fixed, greppable string
 * (`UNSERIALIZABLE` fails closed). A logger that throws takes the request down
 * with it, so "cannot throw" is a product requirement here, not a nicety.
 */

/** Replacement for a value that is a credential, or matches a secret pattern. */
const REDACTED = '[REDACTED]';

/** Replacement for a reference back to an ancestor already being walked. */
const CIRCULAR = '[Circular]';

/** Replacement for an own property that could not be read (throwing getter). */
const UNREADABLE = '[Unreadable]';

/** Fail-closed replacement for a value the walker could not traverse at all. */
const UNSERIALIZABLE = '[Unserializable]';

/** Nesting ceiling: deeper values become `[MaxDepth]` instead of recursing. */
const MAX_DEPTH = 8;

/** Ceiling on array length and on the number of keys walked per object. */
const MAX_ITEMS = 100;

/** Upload file names are truncated to 80 chars. */
const MAX_FILE_NAME_LENGTH = 80;

/**
 * A secret env value shorter than this is not used for literal substring
 * replacement: a 1–7 character "secret" would corrupt unrelated text
 * everywhere. Such a value is still covered by the key-name rules
 * (`password`, `secret`, `token`, …), and every validated credential is far
 * longer than this in practice.
 */
const MIN_SECRET_LITERAL_LENGTH = 8;

/** The only JSON shapes this module ever returns. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Exact matches after normalization (key lowercased, non-alphanumerics dropped):
 * `SESSION_SECRET` → `sessionsecret`, `db_url` → `dburl`.
 */
const SENSITIVE_KEY_EXACT: ReadonlySet<string> = new Set([
  'auth',
  'bearer',
  'cookie',
  'credential',
  'dburl',
  'databaseurl',
  'dsn',
  'jwt',
  'pass',
  'passphrase',
  'privatekey',
  'secret',
  'session',
  'sessionid',
  'signature',
]);

/**
 * Distinctive markers matched as a SUBSTRING of the normalized key, so
 * `passwordHash`, `x-api-key` and `clientSecret` are all caught. Deliberately
 * excludes short ambiguous words (`auth`, `pass`, `session`): those are exact
 * matches above, because `sessionCount` is not a secret.
 */
const SENSITIVE_KEY_MARKERS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'signature',
  'privatekey',
  'dburl',
];

/** Keys whose string value is a file name or a path → strip, then truncate. */
const FILE_KEY_EXACT: ReadonlySet<string> = new Set([
  'file',
  'dir',
  'directory',
  'folder',
  'key',
  'bucket',
  'objectkey',
  'sourcefile',
]);

const FILE_KEY_MARKERS: readonly string[] = ['filename', 'filepath', 'path', 'directory'];

/** Normalizes a key for the classification rules: `S3_Secret_Key` → `s3secretkey`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when the value under `key` must be replaced wholesale. */
function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEY_EXACT.has(normalized) || SENSITIVE_KEY_MARKERS.some((m) => normalized.includes(m))
  );
}

/** True when the value under `key` is a file name / path. */
function isFileKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return FILE_KEY_EXACT.has(normalized) || FILE_KEY_MARKERS.some((m) => normalized.includes(m));
}

/** An email address anywhere in free text. */
const EMAIL = /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** `Bearer <token>` in an Authorization-ish string. */
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi;

/** `password=…`, `clientSecret: …`, `api_key = …` — the key is kept, the value is not. */
const SECRET_ASSIGNMENT =
  /((?:password|passwd|pwd|secret|token|apikey|api[_-]?key|authorization|auth|cookie|credentials?|signature|private[_-]?key)[a-z0-9_-]*)(\s*[:=]\s*)(?!Bearer\b)("[^"]*"|'[^']*'|[^\s,;)}]+)/gi;

/** A JWT shape (three base64url segments, first one starting `eyJ`). */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

/** A vendor API key with the `sk-` prefix. */
const API_KEY = /\bsk-[A-Za-z0-9_-]{12,}/g;

/** A PEM private key block (single or multi line). */
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/** Credentials embedded in a URL: `scheme://user:pass@host`. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/**
 * An ABSOLUTE filesystem path that ends in a file name with an extension.
 *
 * Two deliberate restrictions:
 * - the lookbehind rejects a start preceded by `:`, a word character or another
 *   separator, so the `//host/` part of `https://host/cover.jpg` is never a
 *   path — a media URL stays readable and an API route template (no extension)
 *   is never touched;
 * - an extension is required, which is what separates a path from a route.
 */
const ABSOLUTE_PATH =
  /(?<![:\w/\\])(?:[A-Za-z]:)?[\\/](?=[^\s"'<>|]*[\\/])[^\s"'<>|]*\.[A-Za-z0-9]{1,8}/g;

/**
 * Reduces the candidate secret values to the literal strings that are safe to
 * search for: long enough not to collide with ordinary text, longest first so
 * an overlapping shorter value cannot partially replace a longer one.
 *
 * @param values candidate env values (`undefined` entries are dropped).
 * @returns the sorted, de-duplicated literals to redact.
 */
export function secretLiterals(values: readonly (string | undefined)[]): readonly string[] {
  const usable = values.filter(
    (value): value is string =>
      typeof value === 'string' && value.length >= MIN_SECRET_LITERAL_LENGTH,
  );
  return Object.freeze([...new Set(usable)].sort((a, b) => b.length - a.length));
}

/**
 * Applies every text rule to one string, in a fixed order.
 *
 * Order matters: env-secret LITERALS run first, so a credential that itself
 * looks like an email or a DSN is removed before any structural rule can
 * partially mask it and leave its shape readable.
 *
 * @param text the string to sanitize.
 * @param secrets literal secret values from the environment.
 * @returns the same string with every sensitive part replaced.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let output = text;
  for (const secret of secrets) {
    if (output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
    }
  }
  output = output
    .replace(PEM_BLOCK, REDACTED)
    .replace(BEARER, `$1${REDACTED}`)
    .replace(SECRET_ASSIGNMENT, `$1$2${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(API_KEY, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(EMAIL, maskEmail);
  return output.replace(ABSOLUTE_PATH, stripAndTruncate);
}

/**
 * Emails → first 3 chars + `***`.
 *
 * Only the LOCAL part is sampled. Taking three characters of the whole address
 * would keep `b` of `b.co` for a one-character local part, and keeping the
 * domain at all is not asked for: the operator needs to correlate lines, not to
 * re-identify the reader.
 *
 * @param match the full email address matched by {@link EMAIL}.
 * @returns the masked local part.
 */
function maskEmail(match: string): string {
  const at = match.indexOf('@');
  const localPart = at < 0 ? match : match.slice(0, at);
  return `${localPart.slice(0, 3)}***`;
}

/**
 * Path-stripped, truncated to 80 chars. Keeps the last segment only; the
 * 80-char budget includes the `...` marker.
 *
 * @param path a path or file name.
 * @returns the bare file name, cut to 80 characters.
 */
function stripAndTruncate(path: string): string {
  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = lastSeparator >= 0 ? path.slice(lastSeparator + 1) : path;
  return name.length > MAX_FILE_NAME_LENGTH
    ? `${name.slice(0, MAX_FILE_NAME_LENGTH - 3)}...`
    : name;
}

/**
 * Converts any value into JSON-safe data: redacted, cycle-free, bounded, and
 * impossible to fail on.
 *
 * @param value the value handed to the logger.
 * @param secrets literal secret values from the environment.
 * @returns a value `JSON.stringify` can always encode.
 */
export function sanitizeForLog(value: unknown, secrets: readonly string[] = []): JsonValue {
  return walk(value, undefined, 0, new Set<object>(), secrets);
}

/**
 * One recursion step. Every branch is total: the outermost `try` is the
 * fail-closed guarantee, the per-property `try` keeps one hostile property from
 * discarding the whole event.
 *
 * @param value the value at this position.
 * @param key the field name this value sits under (undefined at the root and
 *   for array elements, so file-name rules never fire on an array).
 * @param depth the current nesting depth.
 * @param seen the ancestors currently being walked (a DAG node is not a cycle).
 * @param secrets literal secret values from the environment.
 * @returns the JSON-safe form of `value`.
 */
function walk(
  value: unknown,
  key: string | undefined,
  depth: number,
  seen: Set<object>,
  secrets: readonly string[],
): JsonValue {
  try {
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case 'string':
        return redactText(
          key !== undefined && isFileKey(key) ? stripAndTruncate(value) : value,
          secrets,
        );
      case 'number':
        return Number.isFinite(value) ? value : `[Number:${String(value)}]`;
      case 'boolean':
        return value;
      case 'undefined':
        // JSON has no `undefined`; an explicit null keeps the field visible.
        return null;
      case 'bigint':
        return value.toString();
      case 'symbol':
        // The description is dropped on purpose: it is caller-controlled text.
        return '[Symbol]';
      case 'function': {
        const name: string = value.name;
        return name === '' ? '[Function]' : `[Function:${name}]`;
      }
      default:
        return walkObject(value, key, depth, seen, secrets);
    }
  } catch {
    // Fail closed: a value we cannot even classify is never serialized.
    return UNSERIALIZABLE;
  }
}

/**
 * The object half of {@link walk}. Known types are converted explicitly; only
 * plain objects and arrays are traversed.
 *
 * @param value a non-null object.
 * @param key the field name this object sits under.
 * @param depth the current nesting depth.
 * @param seen the ancestors currently being walked.
 * @param secrets literal secret values from the environment.
 * @returns the JSON-safe form of `value`.
 */
function walkObject(
  value: object,
  key: string | undefined,
  depth: number,
  seen: Set<object>,
  secrets: readonly string[],
): JsonValue {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? '[Date:Invalid]'
      : redactText(value.toISOString(), secrets);
  }
  if (value instanceof Error) {
    return walkError(value, depth, seen, secrets);
  }
  if (value instanceof URL) {
    // `href` goes through the URL-userinfo rule, so a credential-carrying URL
    // is reduced to `https://[REDACTED]@host/…` before it is written.
    return redactText(value.href, secrets);
  }
  if (value instanceof RegExp) {
    return redactText(value.toString(), secrets);
  }
  if (value instanceof Map) {
    return '[Map]';
  }
  if (value instanceof Set) {
    return '[Set]';
  }
  if (value instanceof WeakMap) {
    return '[WeakMap]';
  }
  if (value instanceof WeakSet) {
    return '[WeakSet]';
  }
  if (value instanceof Promise) {
    return '[Promise]';
  }
  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]';
  }
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return `[${typeName(value)}]`;
  }
  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);
  try {
    return Array.isArray(value)
      ? walkArray(value, depth, seen, secrets)
      : walkRecord(value as Record<string, unknown>, depth, seen, secrets);
  } finally {
    // Only ancestors count as a cycle: a value referenced twice on different
    // branches is data, not a loop, and is serialized in both places.
    seen.delete(value);
  }
}

/**
 * Arrays keep their order and length semantics; a hole reads as `null` and a
 * long array is cut with an explicit marker rather than silently.
 *
 * @param value the array to walk.
 * @param depth the current nesting depth.
 * @param seen the ancestors currently being walked.
 * @param secrets literal secret values from the environment.
 * @returns the JSON-safe form of the array.
 */
function walkArray(
  value: readonly unknown[],
  depth: number,
  seen: Set<object>,
  secrets: readonly string[],
): JsonValue {
  const output: JsonValue[] = [];
  const kept = Math.min(value.length, MAX_ITEMS);
  for (let index = 0; index < kept; index += 1) {
    output.push(walk(readProperty(value, index), undefined, depth + 1, seen, secrets));
  }
  if (value.length > kept) {
    output.push(`[Truncated:${value.length - kept} more]`);
  }
  return output;
}

/**
 * Plain objects keep their keys. A secret-shaped key is replaced WITHOUT being
 * read, so nothing under it can throw or leak.
 *
 * @param value the record to walk.
 * @param depth the current nesting depth.
 * @param seen the ancestors currently being walked.
 * @param secrets literal secret values from the environment.
 * @returns the JSON-safe form of the record.
 */
function walkRecord(
  value: Record<string, unknown>,
  depth: number,
  seen: Set<object>,
  secrets: readonly string[],
): JsonValue {
  const output: { [key: string]: JsonValue } = {};
  const keys = Object.keys(value);
  const kept = Math.min(keys.length, MAX_ITEMS);
  for (let index = 0; index < kept; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      continue;
    }
    output[key] = isSensitiveKey(key)
      ? REDACTED
      : walk(readProperty(value, key), key, depth + 1, seen, secrets);
  }
  if (keys.length > kept) {
    output['[truncated]'] = `[Truncated:${keys.length - kept} more keys]`;
  }
  return output;
}

/**
 * Error logs carry an `error` object with code + typed `errorName`; a raw stack
 * trace never reaches user-facing responses (internal logs may include a
 * PII-redacted stack).
 *
 * `name` carries the typed error name, `message`/`stack` are redacted, and own
 * ENUMERABLE properties (an `AppError`'s `code`, `details`, `issues`) are kept.
 * Non-enumerable own properties — `cause` above all — are not walked: a cause
 * is an arbitrary object graph that may hold a request body.
 *
 * @param error the error to describe.
 * @param depth the current nesting depth.
 * @param seen the ancestors currently being walked.
 * @param secrets literal secret values from the environment.
 * @returns the JSON-safe error object.
 */
function walkError(
  error: Error,
  depth: number,
  seen: Set<object>,
  secrets: readonly string[],
): JsonValue {
  const output: { [key: string]: JsonValue } = {
    name: redactText(error.name, secrets),
    message: redactText(error.message, secrets),
  };
  if (typeof error.stack === 'string') {
    output['stack'] = redactText(error.stack, secrets);
  }
  for (const key of Object.keys(error)) {
    if (key === 'name' || key === 'message' || key === 'stack') {
      continue;
    }
    output[key] = isSensitiveKey(key)
      ? REDACTED
      : walk(readProperty(error, key), key, depth + 1, seen, secrets);
  }
  return output;
}

/**
 * Reads one own property, converting a throwing getter into a marker. Array
 * holes and absent properties read as `undefined` → `null` by the caller.
 *
 * @param target the object or array to read.
 * @param key the property key (a string name, or an array index).
 * @returns the value, or `undefined` when the read threw or is absent.
 */
function readProperty(target: object, key: string | number): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return UNREADABLE;
  }
}

/** True for `{}` / `Object.create(null)` only — never for a class instance. */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * The class name behind a non-plain object, read from the prototype's own
 * `constructor` descriptor so an instance getter is never invoked.
 *
 * @param value the object to name.
 * @returns the constructor name, or `Object` when it has none.
 */
function typeName(value: object): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null || typeof prototype !== 'object') {
    return 'Object';
  }
  const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
    prototype,
    'constructor',
  );
  // `PropertyDescriptor.value` is `any` by declaration: narrow it before use.
  const constructor: unknown = descriptor?.value;
  if (
    typeof constructor === 'function' &&
    typeof constructor.name === 'string' &&
    constructor.name !== ''
  ) {
    return constructor.name;
  }
  return 'Object';
}

/**
 * `JSON.stringify` that cannot fail. Sanitizing first is what makes it total:
 * the input to `JSON.stringify` is always plain JSON data, so the only way it
 * could throw is a value the sanitizer missed.
 *
 * @param value the value to render.
 * @param secrets literal secret values from the environment.
 * @returns one JSON document, or a fixed fallback string.
 */
export function safeStringify(value: unknown, secrets: readonly string[] = []): string {
  try {
    return JSON.stringify(sanitizeForLog(value, secrets)) ?? `"${UNSERIALIZABLE}"`;
  } catch {
    return `"${UNSERIALIZABLE}"`;
  }
}
