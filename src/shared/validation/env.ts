/**
 * Environment configuration contract: the Zod schema and `loadEnv()` that
 * validate configuration, fail the boot on any missing or invalid variable,
 * and deeply freeze the result.
 *
 * Redaction is structural: only variable NAMES and static problem strings
 * leave this module, never a value. A blank value means UNSET; values are never
 * trimmed. Unknown variables warn (not fail); non-HTTPS `APP_ORIGIN`/
 * `S3_ENDPOINT` fail in production; `MAIL_*` are all-or-nothing.
 */
import { z } from 'zod';

/** The raw source of configuration: `process.env` in production. */
export type EnvSource = Record<string, string | undefined>;

/** `NODE_ENV` (required — no default; the deploy sets it). */
export type NodeEnv = 'development' | 'test' | 'production';

/** One refused variable: its NAME and what is wrong with it — never its value. */
export interface EnvIssue {
  readonly variable: string;
  readonly problem: string;
}

/** Injection seam for the warning sink (default: the lint-allowed console). */
export interface LoadEnvOptions {
  /** Receives one message per batch of unknown variables. */
  readonly onWarn?: (message: string) => void;
}

/**
 * The validated, frozen environment object every module may consume.
 *
 * Field semantics (one line each, non-normative summary):
 * - nodeEnv: 'development' | 'test' | 'production'
 * - appOrigin: URL (CSRF origin check, CSP, cookies)
 * - appBasePath: reverse-proxy path, `undefined` when the app is at the root
 * - nextTelemetryDisabled: Next.js' own telemetry switch (data policy)
 * - sessionSecret: 256-bit secret (NEVER logged — redaction contract)
 * - databaseUrl: PostgreSQL DSN (server/db only consumes)
 * - storage: { endpoint, region, bucket, accessKeyId, secretAccessKey } —
 *   all secrets redacted in any log path
 * - uploadLimits: { maxTotalBytes, maxFileBytes, maxFiles } — sane-range
 *   validated
 * - otel: { endpoint?, serviceName? } — empty endpoint = telemetry off
 * - mail: { from?, host?, port?, user?, pass? } — required as a group
 * - rateLimits: per the documented ceilings (override table)
 */
export interface Env {
  readonly nodeEnv: NodeEnv;
  readonly appOrigin: URL;
  readonly appBasePath: string | undefined;
  readonly nextTelemetryDisabled: boolean;
  readonly sessionSecret: string;
  readonly databaseUrl: string;
  readonly storage: {
    readonly endpoint: URL;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly uploadLimits: {
    readonly maxTotalBytes: number;
    readonly maxFileBytes: number;
    readonly maxFiles: number;
  };
  readonly otel: {
    readonly endpoint: URL | undefined;
    readonly serviceName: string | undefined;
  };
  readonly mail: {
    readonly from: string | undefined;
    readonly host: string | undefined;
    readonly port: number | undefined;
    readonly user: string | undefined;
    readonly pass: string | undefined;
  };
  readonly rateLimits: {
    readonly loginPerMin: number;
    readonly registerPerHour: number;
    readonly resetPerHour: number;
    readonly searchPerMin: number;
    readonly uploadPerHour: number;
    readonly beaconPerMin: number | undefined;
    readonly genericPerMin: number;
  };
}

/** Unset required variable ⇒ refuse to boot. */
const REQUIRED_VARIABLES: readonly string[] = [
  'NODE_ENV',
  'APP_ORIGIN',
  'SESSION_SECRET',
  'DATABASE_URL',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'NEXT_TELEMETRY_DISABLED',
];

/** The full variable inventory, one entry per variable. */
export const ENV_VARIABLE_NAMES: readonly string[] = Object.freeze([
  ...REQUIRED_VARIABLES,
  'APP_BASE_PATH',
  'UPLOAD_MAX_TOTAL_BYTES',
  'UPLOAD_MAX_FILE_BYTES',
  'UPLOAD_MAX_FILES',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'MAIL_FROM',
  'MAIL_HOST',
  'MAIL_PORT',
  'MAIL_USER',
  'MAIL_PASS',
  'RATE_LIMIT_LOGIN_PER_MIN',
  'RATE_LIMIT_REGISTER_PER_HOUR',
  'RATE_LIMIT_RESET_PER_HOUR',
  'RATE_LIMIT_SEARCH_PER_MIN',
  'RATE_LIMIT_UPLOAD_PER_HOUR',
  'RATE_LIMIT_BEACON_PER_MIN',
  'RATE_LIMIT_GENERIC_PER_MIN',
]);

const KNOWN_VARIABLES = new Set(ENV_VARIABLE_NAMES);

/**
 * Variables the shell, the CI runner, Node and Next.js inject into every
 * process. They are not part of the Yomi contract, so warning about them on
 * every boot would drown the one warning that matters.
 */
const RUNTIME_VARIABLES: ReadonlySet<string> = new Set([
  'CI',
  'HOME',
  'HOSTNAME',
  'LANG',
  'LC_ALL',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PWD',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TZ',
  'TTY',
  'USER',
]);

/** Prefixes of runtime noise families (`npm_config_*`). */
const RUNTIME_PREFIXES: readonly string[] = ['npm_config_'];

/**
 * Thrown by `loadEnv` when the environment is unusable. Carries variable
 * NAMES and static problems only — never a value.
 */
export class ConfigurationError extends Error {
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(formatFailure(issues));
    this.name = 'ConfigurationError';
    this.issues = Object.freeze([...issues]);
  }
}

/**
 * Renders the boot failure. The ONLY inputs are the variable name and a
 * static problem string; no code path in this module can hand it a value.
 */
function formatFailure(issues: readonly EnvIssue[]): string {
  const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.problem}`);
  return [
    `Yomi refused to start: ${issues.length} environment variable(s) are missing or invalid.`,
    ...lines,
    'No variable value is included in this report, by design.',
  ].join('\n');
}

/** Static problem text for a required variable that is unset or blank. */
const REQUIRED_PROBLEM = 'is required and must not be empty';

/**
 * Builds a field that parses an absolute URL of the given schemes into a
 * `URL`. `accept` narrows it further; every message is a literal, so a
 * refused value can never reach the message.
 */
function urlField(problems: {
  readonly malformed: string;
  readonly rejected: string;
  readonly protocols: readonly string[];
  readonly accept?: (url: URL) => boolean;
}) {
  return z.string().transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      // Node's own ERR_INVALID_URL carries the value on `.input` — it is
      // dropped here and never propagated.
      ctx.addIssue({ code: 'custom', message: problems.malformed });
      return z.NEVER;
    }
    if (!problems.protocols.includes(url.protocol) || problems.accept?.(url) === false) {
      ctx.addIssue({ code: 'custom', message: problems.rejected });
      return z.NEVER;
    }
    return url;
  });
}

/** A URL with no embedded credentials (a secret in a URL is a leak vector). */
const noCredentials = (url: URL): boolean => url.username === '' && url.password === '';

/** `APP_ORIGIN` is a bare origin: no path, no query, no fragment, no userinfo. */
const isBareOrigin = (url: URL): boolean =>
  noCredentials(url) && url.pathname === '/' && url.search === '' && url.hash === '';

const httpUrl = urlField({
  malformed: 'must be an absolute http(s) URL',
  rejected: 'must be an absolute http(s) URL without embedded credentials',
  protocols: ['http:', 'https:'],
  accept: noCredentials,
});

/**
 * The DSN stays a raw string (`Env.databaseUrl`): `server/db` owns it and its
 * credentials are expected inside it, so only the shape is checked here.
 */
const postgresDsn = z.string().refine((value) => {
  // PGlite dev fallback: allow pglite://, file:, memory:, /tmp/... for local dev without PG 18
  if (
    value.startsWith('pglite://') ||
    value.startsWith('file:') ||
    value.startsWith('memory:') ||
    value === ':memory:' ||
    value.startsWith('/tmp/') ||
    value.startsWith('./') ||
    value.endsWith('.db')
  ) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.host !== '' &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}, 'must be an absolute postgres:// or postgresql:// DSN — or pglite:// / file: / /tmp/ for dev');

/** The environment contract, one field per variable, in inventory order. */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),

  // origin, cookies, CSRF, CSP
  APP_ORIGIN: urlField({
    malformed: 'must be an absolute http(s) URL',
    rejected: 'must be a bare origin: scheme + host only, no path, query, fragment or credentials',
    protocols: ['http:', 'https:'],
    accept: isBareOrigin,
  }),
  APP_BASE_PATH: z
    .string()
    .regex(/^\/[^\s?#]*$/, 'must start with "/" and contain no whitespace, "?" or "#"')
    .optional(),

  // secrets: never defaulted, never logged
  SESSION_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]+$/, 'must be hexadecimal (256-bit hex)')
    .min(64, 'must be at least 64 hex characters (256 bits)'),
  DATABASE_URL: postgresDsn,

  // object storage: S3 / R2 in prod, MinIO in dev
  S3_ENDPOINT: httpUrl,
  S3_REGION: z.string().regex(/^[A-Za-z0-9-]+$/, 'must be a region id (R2 uses "auto")'),
  S3_BUCKET: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
      'must be a valid bucket name (lowercase, 3–63 chars)',
    ),
  S3_ACCESS_KEY_ID: z.string().regex(/^\S+$/, 'must not contain whitespace'),
  S3_SECRET_ACCESS_KEY: z.string().regex(/^\S+$/, 'must not contain whitespace'),

  // upload limits
  UPLOAD_MAX_TOTAL_BYTES: z.coerce.number().int().min(1).default(524_288_000),
  UPLOAD_MAX_FILE_BYTES: z.coerce.number().int().min(1).default(104_857_600),
  UPLOAD_MAX_FILES: z.coerce.number().int().min(1).default(500),

  // telemetry: unset endpoint = off (dev default)
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl.optional(),
  OTEL_SERVICE_NAME: z.string().regex(/^\S+$/, 'must not contain whitespace').default('yomi-app'),

  // mail
  MAIL_FROM: z.string().min(1, 'must not be empty').optional(),
  MAIL_HOST: z.string().regex(/^\S+$/, 'must not contain whitespace').optional(),
  MAIL_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  MAIL_USER: z.string().regex(/^\S+$/, 'must not contain whitespace').optional(),
  MAIL_PASS: z.string().min(1, 'must not be empty').optional(),

  // rate limits: the documented ceilings are the default
  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_REGISTER_PER_HOUR: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_RESET_PER_HOUR: z.coerce.number().int().min(1).default(3),
  RATE_LIMIT_SEARCH_PER_MIN: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_UPLOAD_PER_HOUR: z.coerce.number().int().min(1).default(2),
  RATE_LIMIT_BEACON_PER_MIN: z.coerce.number().int().min(1).optional(),
  RATE_LIMIT_GENERIC_PER_MIN: z.coerce.number().int().min(1).default(300),

  // data policy: Next.js' own telemetry stays off
  NEXT_TELEMETRY_DISABLED: z.enum(['1', '0']).transform((value) => value === '1'),
});

/** Parsed shape of {@link envSchema}. */
type ParsedEnv = z.infer<typeof envSchema>;

/**
 * The five `MAIL_*` variables as one all-or-nothing group. The readers keep
 * the policy check honest without a stringly-typed index into the schema.
 */
const MAIL_MEMBERS = {
  MAIL_FROM: (env: ParsedEnv) => env.MAIL_FROM,
  MAIL_HOST: (env: ParsedEnv) => env.MAIL_HOST,
  MAIL_PORT: (env: ParsedEnv) => env.MAIL_PORT,
  MAIL_USER: (env: ParsedEnv) => env.MAIL_USER,
  MAIL_PASS: (env: ParsedEnv) => env.MAIL_PASS,
} satisfies Record<string, (env: ParsedEnv) => unknown>;

/**
 * Validates `input` and returns the frozen `Env`.
 *
 * Order of operations (each step is observable in the failure output):
 * 1. blank (`''` / whitespace-only) values are dropped — blank means unset;
 * 2. the Zod schema refuses missing/invalid variables, naming each one;
 * 3. cross-variable policy runs (https in production, mail group, limits);
 * 4. unknown variables are warned about, never fatal;
 * 5. the result is deeply frozen (the parsed `URL`s included).
 *
 * Never throws anything but {@link ConfigurationError}, and never puts a
 * value into that error, a warning, or a log line.
 */
export function loadEnv(input: EnvSource = defaultSource(), options: LoadEnvOptions = {}): Env {
  const present = dropBlanks(input);
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    // Copy out names and static messages only; the ZodError is dropped here.
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => ({
        variable: issue.path.map(String).join('.') || '<environment>',
        problem: isUnset(issue.path, input) ? REQUIRED_PROBLEM : issue.message,
      })),
    );
  }

  const policyIssues = checkPolicy(parsed.data);
  if (policyIssues.length > 0) {
    throw new ConfigurationError(policyIssues);
  }

  const unknown = findUnknownVariables(Object.keys(input));
  if (unknown.length > 0) {
    (options.onWarn ?? warnToConsole)(
      `Yomi: unknown environment variable(s) ignored: ${unknown.join(', ')}` +
        '.',
    );
  }

  return freezeEnv(parsed.data);
}

/**
 * The real process environment, read through a narrowing cast.
 *
 * Why the cast: this `tsconfig.json` does not pull `@types/node` into the
 * program (typescript 6.0.3, no `types` field), so neither the `process`
 * global nor `node:process` resolves. Editing the toolchain config is out of
 * scope, so the single Node-global reference of the env contract lives here —
 * one place, cast, documented. When the toolchain adds `"types": ["node"]` (or
 * a generated `next-env.d.ts` pulls it in), this becomes `process.env` verbatim.
 */
function defaultSource(): EnvSource {
  return (globalThis as { process?: { env?: EnvSource } }).process?.env ?? {};
}

/**
 * Drops blank values. `FOO=''` and `FOO='   '` are UNSET (the environment ships
 * both spellings for "off"/"empty"); every other value is passed through
 * untouched, so a secret is never silently rewritten.
 */
function dropBlanks(input: EnvSource): Record<string, string> {
  const present: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim() !== '') {
      present[key] = value;
    }
  }
  return present;
}

/** True when the issue is about a variable that was unset (or blank). */
function isUnset(path: readonly PropertyKey[], input: EnvSource): boolean {
  const name = String(path[0] ?? '');
  const raw = input[name];
  return raw === undefined || raw.trim() === '';
}

/**
 * Cross-variable rules that a per-field schema cannot express. Returns issues
 * for every variable involved, so an operator sees all of them at once.
 */
function checkPolicy(env: ParsedEnv): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const production = env.NODE_ENV === 'production';

  if (production && env.APP_ORIGIN.protocol !== 'https:') {
    issues.push({
      variable: 'APP_ORIGIN',
      problem: 'must use https when NODE_ENV=production',
    });
  }
  if (production && env.S3_ENDPOINT.protocol !== 'https:') {
    issues.push({
      variable: 'S3_ENDPOINT',
      problem:
        'must use https when NODE_ENV=production: the S3 key travels on this connection',
    });
  }
  if (env.UPLOAD_MAX_FILE_BYTES > env.UPLOAD_MAX_TOTAL_BYTES) {
    issues.push({
      variable: 'UPLOAD_MAX_FILE_BYTES',
      problem: 'must not exceed UPLOAD_MAX_TOTAL_BYTES',
    });
  }

  const mailSet = Object.entries(MAIL_MEMBERS)
    .filter(([, read]) => read(env) !== undefined)
    .map(([name]) => name);
  if (mailSet.length > 0 && mailSet.length < Object.keys(MAIL_MEMBERS).length) {
    for (const name of Object.keys(MAIL_MEMBERS)) {
      issues.push(
        mailSet.includes(name)
          ? {
              variable: name,
              problem: 'is ignored: the MAIL_* group must be set completely',
            }
          : {
              variable: name,
              problem: 'is required when any other MAIL_* variable is set',
            },
      );
    }
  }

  return issues;
}

/** Unknown variables, minus the shell/CI/Node/Next runtime noise. */
function findUnknownVariables(keys: readonly string[]): string[] {
  return keys
    .filter(
      (key) =>
        !KNOWN_VARIABLES.has(key) &&
        !RUNTIME_VARIABLES.has(key) &&
        !RUNTIME_PREFIXES.some((prefix) => key.startsWith(prefix)),
    )
    .sort();
}

/**
 * Default warning sink. `console.error` is the only console the product lint
 * config allows; the sink is injectable (`LoadEnvOptions.onWarn`) so a logging
 * facade can replace it.
 */
function warnToConsole(message: string): void {
  console.error(message);
}

/**
 * Deep-freezes the parsed configuration.
 *
 * `Object.freeze(new URL(...))` alone is cosmetic: URL's components are
 * prototype accessors backed by internal slots, so `url.href = …` still
 * mutates the object (verified on Node 24). Every mutable component is
 * therefore shadowed by an own non-writable data property BEFORE the freeze,
 * which makes `appOrigin` genuinely immutable.
 */
function freezeEnv(env: ParsedEnv): Env {
  const frozen: Env = {
    nodeEnv: env.NODE_ENV,
    appOrigin: freezeUrl(env.APP_ORIGIN),
    appBasePath: env.APP_BASE_PATH,
    nextTelemetryDisabled: env.NEXT_TELEMETRY_DISABLED,
    sessionSecret: env.SESSION_SECRET,
    databaseUrl: env.DATABASE_URL,
    storage: Object.freeze({
      endpoint: freezeUrl(env.S3_ENDPOINT),
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    }),
    uploadLimits: Object.freeze({
      maxTotalBytes: env.UPLOAD_MAX_TOTAL_BYTES,
      maxFileBytes: env.UPLOAD_MAX_FILE_BYTES,
      maxFiles: env.UPLOAD_MAX_FILES,
    }),
    otel: Object.freeze({
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? freezeUrl(env.OTEL_EXPORTER_OTLP_ENDPOINT)
        : undefined,
      serviceName: env.OTEL_SERVICE_NAME,
    }),
    mail: Object.freeze({
      from: env.MAIL_FROM,
      host: env.MAIL_HOST,
      port: env.MAIL_PORT,
      user: env.MAIL_USER,
      pass: env.MAIL_PASS,
    }),
    rateLimits: Object.freeze({
      loginPerMin: env.RATE_LIMIT_LOGIN_PER_MIN,
      registerPerHour: env.RATE_LIMIT_REGISTER_PER_HOUR,
      resetPerHour: env.RATE_LIMIT_RESET_PER_HOUR,
      searchPerMin: env.RATE_LIMIT_SEARCH_PER_MIN,
      uploadPerHour: env.RATE_LIMIT_UPLOAD_PER_HOUR,
      beaconPerMin: env.RATE_LIMIT_BEACON_PER_MIN,
      genericPerMin: env.RATE_LIMIT_GENERIC_PER_MIN,
    }),
  };
  return Object.freeze(frozen);
}

/** URL components that are settable through `URL.prototype` accessors. */
const URL_COMPONENTS: readonly string[] = [
  'href',
  'protocol',
  'username',
  'password',
  'host',
  'hostname',
  'port',
  'pathname',
  'search',
  'hash',
];

/** Shadows every mutable `URL` accessor, then freezes the object. */
function freezeUrl(url: URL): URL {
  for (const component of URL_COMPONENTS) {
    Object.defineProperty(url, component, {
      value: Reflect.get(url, component),
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  return Object.freeze(url);
}
