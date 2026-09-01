/**
 * Unit tests — typed environment configuration.
 *
 * Per-variable table (required/optional, parsed field, default, invalid value
 * refused naming the VARIABLE), redaction (a sentinel value never appears in
 * captured failure output — only the variable NAME may), APP_ORIGIN parsed and
 * frozen with https required in production, blank treated as unset, unknown
 * variables warn rather than fail, the returned `Env` is deeply frozen, and the
 * implemented variable set matches the documented inventory.
 *
 * No I/O: `loadEnv` takes a plain record, so the real `process.env` is untouched.
 */
import { describe, expect, it } from 'vitest';
import { buildComposition } from '../../src/server/composition';
import type { Env, EnvSource } from '../../src/shared/validation/env';
import { ConfigurationError, ENV_VARIABLE_NAMES, loadEnv } from '../../src/shared/validation/env';

/** A value that must never reach any log, error or message. */
const SENTINEL = 'SENTINEL-a1b2c3d4e5f6';

/** 64 hex characters = 256 bits. */
const SESSION_SECRET_HEX = 'f'.repeat(64);

/**
 * A minimal, valid environment: every required variable, nothing optional.
 * Optional groups (mail) are absent on purpose.
 */
const BASE: EnvSource = {
  NODE_ENV: 'test',
  APP_ORIGIN: 'https://reader.example.com',
  SESSION_SECRET: SESSION_SECRET_HEX,
  DATABASE_URL: 'postgres://yomi:pw@db:5432/yomi',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_BUCKET: 'yomi-media',
  S3_ACCESS_KEY_ID: 'yomi-access-key',
  S3_SECRET_ACCESS_KEY: 'yomi-secret-key',
  NEXT_TELEMETRY_DISABLED: '1',
};

/** BASE with one variable replaced by a sentinel (or removed when `undefined`). */
function withVar(name: string, value: string | undefined): EnvSource {
  const next: EnvSource = { ...BASE };
  if (value === undefined) {
    delete next[name];
  } else {
    next[name] = value;
  }
  return next;
}

/** Runs `loadEnv` and returns the captured failure output, redacted or not. */
function captureFailure(input: EnvSource, warnings: string[] = []): string {
  try {
    loadEnv(input, { onWarn: (message) => warnings.push(message) });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) {
      throw new Error(`expected ConfigurationError, got ${String(error)}`);
    }
    return [
      error.name,
      error.message,
      error.stack ?? '',
      JSON.stringify(error.issues),
      JSON.stringify(error),
    ].join('\n');
  }
  throw new Error('expected loadEnv to refuse the configuration');
}

/** Asserts a failure names `name` and leaks no value at all. */
function expectRefusal(input: EnvSource, name: string): string {
  const output = captureFailure(input);
  expect(output).toContain(name);
  expect(output).not.toContain(SENTINEL);
  return output;
}

interface VarCase {
  /** The variable name. */
  readonly varName: string;
  /** Whether the variable is required. */
  readonly required: boolean;
  /** A raw value the loader must accept. */
  readonly valid: string;
  /** Where the parsed value lands in `Env`. */
  readonly read: (env: Env) => unknown;
  /** `read(env)` when `valid` is set. */
  readonly parsed: unknown;
  /** `read(env)` when the variable is unset. */
  readonly defaulted: unknown;
  /** A raw value the loader must refuse (never blank — the blank case is covered elsewhere). */
  readonly invalid: string;
}

/**
 * One row per documented variable. Defaults come from the documented "Example"
 * column.
 */
const VARIABLES: readonly VarCase[] = [
  {
    varName: 'NODE_ENV',
    required: true,
    valid: 'production',
    read: (e) => e.nodeEnv,
    parsed: 'production',
    defaulted: undefined,
    invalid: 'prod',
  },
  {
    varName: 'APP_ORIGIN',
    required: true,
    valid: 'https://read.example.com',
    read: (e) => e.appOrigin.origin,
    parsed: 'https://read.example.com',
    defaulted: undefined,
    invalid: 'read.example.com',
  },
  {
    varName: 'APP_BASE_PATH',
    required: false,
    valid: '/yomi',
    read: (e) => e.appBasePath,
    parsed: '/yomi',
    defaulted: undefined,
    invalid: 'yomi',
  },
  {
    varName: 'SESSION_SECRET',
    required: true,
    valid: SESSION_SECRET_HEX,
    read: (e) => e.sessionSecret,
    parsed: SESSION_SECRET_HEX,
    defaulted: undefined,
    invalid: 'too-short',
  },
  {
    varName: 'DATABASE_URL',
    required: true,
    valid: 'postgres://yomi:pw@db:5432/yomi',
    read: (e) => e.databaseUrl,
    parsed: 'postgres://yomi:pw@db:5432/yomi',
    defaulted: undefined,
    invalid: 'mysql://yomi:pw@db:3306/yomi',
  },
  {
    varName: 'S3_ENDPOINT',
    required: true,
    valid: 'https://acct123.r2.cloudflarestorage.com',
    read: (e) => e.storage.endpoint.href,
    parsed: 'https://acct123.r2.cloudflarestorage.com/',
    defaulted: undefined,
    invalid: 'r2.cloudflarestorage.com',
  },
  {
    varName: 'S3_REGION',
    required: true,
    valid: 'auto',
    read: (e) => e.storage.region,
    parsed: 'auto',
    defaulted: undefined,
    invalid: 'https://region',
  },
  {
    varName: 'S3_BUCKET',
    required: true,
    valid: 'yomi-media',
    read: (e) => e.storage.bucket,
    parsed: 'yomi-media',
    defaulted: undefined,
    invalid: 'yomi media',
  },
  {
    varName: 'S3_ACCESS_KEY_ID',
    required: true,
    valid: 'yomi-access-key',
    read: (e) => e.storage.accessKeyId,
    parsed: 'yomi-access-key',
    defaulted: undefined,
    invalid: 'yomi access key',
  },
  {
    varName: 'S3_SECRET_ACCESS_KEY',
    required: true,
    valid: 'yomi-secret-key',
    read: (e) => e.storage.secretAccessKey,
    parsed: 'yomi-secret-key',
    defaulted: undefined,
    invalid: 'yomi secret key',
  },
  {
    varName: 'UPLOAD_MAX_TOTAL_BYTES',
    required: false,
    valid: '209715200',
    read: (e) => e.uploadLimits.maxTotalBytes,
    parsed: 209_715_200,
    defaulted: 524_288_000,
    invalid: 'many',
  },
  {
    varName: 'UPLOAD_MAX_FILE_BYTES',
    required: false,
    valid: '262144',
    read: (e) => e.uploadLimits.maxFileBytes,
    parsed: 262_144,
    defaulted: 104_857_600,
    invalid: '1.5',
  },
  {
    varName: 'UPLOAD_MAX_FILES',
    required: false,
    valid: '12',
    read: (e) => e.uploadLimits.maxFiles,
    parsed: 12,
    defaulted: 500,
    invalid: '0',
  },
  {
    varName: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    required: false,
    valid: 'http://collector:4318',
    read: (e) => e.otel.endpoint?.href,
    parsed: 'http://collector:4318/',
    defaulted: undefined,
    invalid: 'collector:4318',
  },
  {
    varName: 'OTEL_SERVICE_NAME',
    required: false,
    valid: 'yomi-app-custom',
    read: (e) => e.otel.serviceName,
    parsed: 'yomi-app-custom',
    defaulted: 'yomi-app',
    invalid: 'yomi app',
  },
  {
    varName: 'RATE_LIMIT_LOGIN_PER_MIN',
    required: false,
    valid: '7',
    read: (e) => e.rateLimits.loginPerMin,
    parsed: 7,
    defaulted: 10,
    invalid: '0',
  },
  {
    varName: 'RATE_LIMIT_REGISTER_PER_HOUR',
    required: false,
    valid: '4',
    read: (e) => e.rateLimits.registerPerHour,
    parsed: 4,
    defaulted: 5,
    invalid: '-1',
  },
  {
    varName: 'RATE_LIMIT_RESET_PER_HOUR',
    required: false,
    valid: '2',
    read: (e) => e.rateLimits.resetPerHour,
    parsed: 2,
    defaulted: 3,
    invalid: '1.5',
  },
  {
    varName: 'RATE_LIMIT_SEARCH_PER_MIN',
    required: false,
    valid: '25',
    read: (e) => e.rateLimits.searchPerMin,
    parsed: 25,
    defaulted: 30,
    invalid: 'none',
  },
  {
    varName: 'RATE_LIMIT_UPLOAD_PER_HOUR',
    required: false,
    valid: '3',
    read: (e) => e.rateLimits.uploadPerHour,
    parsed: 3,
    defaulted: 2,
    invalid: '0',
  },
  {
    varName: 'RATE_LIMIT_GENERIC_PER_MIN',
    required: false,
    valid: '250',
    read: (e) => e.rateLimits.genericPerMin,
    parsed: 250,
    defaulted: 300,
    invalid: '0',
  },
  {
    varName: 'RATE_LIMIT_BEACON_PER_MIN',
    required: false,
    valid: '60',
    read: (e) => e.rateLimits.beaconPerMin,
    parsed: 60,
    // No document states a beacon ceiling, so the loader must not invent one:
    // unset stays unset.
    defaulted: undefined,
    invalid: '0',
  },
  {
    varName: 'NEXT_TELEMETRY_DISABLED',
    required: true,
    valid: '0',
    read: (e) => e.nextTelemetryDisabled,
    parsed: false,
    defaulted: undefined,
    invalid: 'true',
  },
];

/** MAIL_* is optional, but all-or-nothing at boot. */
const MAIL_GROUP: readonly (readonly [string, string, (e: Env) => unknown])[] = [
  ['MAIL_FROM', 'yomi@example.com', (e) => e.mail.from],
  ['MAIL_HOST', 'smtp.example.com', (e) => e.mail.host],
  ['MAIL_PORT', '587', (e) => e.mail.port],
  ['MAIL_USER', 'yomi', (e) => e.mail.user],
  ['MAIL_PASS', 'mail-secret', (e) => e.mail.pass],
];

describe('per-variable table', () => {
  it.each(VARIABLES.map((c) => [c.varName, c] as const))(
    '%s — accepts a valid value into its Env field',
    (_name, c) => {
      expect(c.read(loadEnv(withVar(c.varName, c.valid)))).toEqual(c.parsed);
    },
  );

  it.each(VARIABLES.filter((c) => !c.required).map((c) => [c.varName, c] as const))(
    '%s — unset takes the documented default (optional)',
    (_name, c) => {
      const env = loadEnv(withVar(c.varName, undefined));
      expect(c.read(env)).toEqual(c.defaulted);
    },
  );

  it.each(VARIABLES.filter((c) => c.required).map((c) => [c.varName, c] as const))(
    '%s — unset is refused and the variable is named',
    (_name, c) => {
      expect(() => loadEnv(withVar(c.varName, undefined))).toThrow(ConfigurationError);
      expectRefusal(withVar(c.varName, undefined), c.varName);
    },
  );

  it.each(VARIABLES.map((c) => [c.varName, c] as const))(
    '%s — an invalid value is refused and the variable is named',
    (_name, c) => {
      expect(() => loadEnv(withVar(c.varName, c.invalid))).toThrow(ConfigurationError);
      expectRefusal(withVar(c.varName, c.invalid), c.varName);
    },
  );

  it.each(MAIL_GROUP)('%s — the complete MAIL_* group loads', (name, value, read) => {
    const input = withVar(name, value);
    for (const [groupName, groupValue] of MAIL_GROUP) {
      input[groupName] = groupValue;
    }
    expect(read(loadEnv(input))).toBe(name === 'MAIL_PORT' ? 587 : value);
  });

  it.each(MAIL_GROUP)('%s — a partial MAIL_* group is refused (named)', (name, value) => {
    const output = expectRefusal(withVar(name, value), name);
    expect(output).toContain('MAIL_');
  });

  it.each([
    ['MAIL_HOST', 'smtp example.com'],
    ['MAIL_PORT', 'not-a-port'],
    ['MAIL_PORT', '70000'],
    ['MAIL_FROM', '   '],
  ] as const)('%s — a malformed %s value is refused', (name, value) => {
    // The group is complete first, so the refusal can only come from `name`.
    const input = withVar(name, MAIL_GROUP.find(([n]) => n === name)?.[1] ?? '');
    for (const [groupName, groupValue] of MAIL_GROUP) {
      input[groupName] = groupValue;
    }
    if (value.trim() === '') {
      delete input[name];
    } else {
      input[name] = value;
    }
    expectRefusal(input, name);
  });
});

describe('redaction', () => {
  it('never echoes a sentinel secret when a different variable is invalid', () => {
    const poisoned: EnvSource = {};
    for (const name of ENV_VARIABLE_NAMES) {
      poisoned[name] = `${SENTINEL}-${name}`;
    }
    // One non-secret variable is invalid ⇒ the failure output must name only
    // that variable while 27 sentinel values sit in the input.
    poisoned['UPLOAD_MAX_FILES'] = 'not-a-number';

    const output = captureFailure(poisoned);
    expect(output).toContain('UPLOAD_MAX_FILES');
    expect(output).not.toContain(SENTINEL);
  });

  it.each(VARIABLES.map((c) => [c.varName, `${SENTINEL}-${c.varName}`] as const))(
    '%s — a sentinel value is never echoed when the value is refused',
    (name, value) => {
      const input = withVar(name, value);
      // Values that are structurally valid (e.g. a hex sentinel) are made
      // invalid by removing another required variable, so the refused value is
      // still present in the input the message was built from.
      const trigger = name === 'NEXT_TELEMETRY_DISABLED' ? 'NODE_ENV' : 'NEXT_TELEMETRY_DISABLED';
      delete input[trigger];

      const output = captureFailure(input);
      expect(output).toContain(trigger);
      expect(output).not.toContain(SENTINEL);
    },
  );

  it('the serialized error carries names and problems only', () => {
    const input = withVar('SESSION_SECRET', `${SENTINEL}-secret`);
    delete input['S3_BUCKET'];

    let issues: unknown = null;
    try {
      loadEnv(input);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        issues = error.issues;
      }
    }
    expect(issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ variable: 'S3_BUCKET' })]),
    );
    expect(JSON.stringify(issues)).not.toContain(SENTINEL);
  });

  it('warns about an unknown variable by name only', () => {
    const warnings: string[] = [];
    loadEnv({ ...BASE, UNKNOWN_YOMI_KNOB: SENTINEL }, { onWarn: (m) => warnings.push(m) });
    expect(warnings.join('\n')).toContain('UNKNOWN_YOMI_KNOB');
    expect(warnings.join('\n')).not.toContain(SENTINEL);
  });
});

describe('APP_ORIGIN parsed, frozen, https in production', () => {
  it('is a parsed URL', () => {
    const env = loadEnv(withVar('APP_ORIGIN', 'https://read.example.com:8443/'));
    expect(env.appOrigin).toBeInstanceOf(URL);
    expect(env.appOrigin.host).toBe('read.example.com:8443');
  });

  it('is frozen — a later mutation attempt cannot change it', () => {
    const env = loadEnv(BASE);
    expect(Object.isFrozen(env.appOrigin)).toBe(true);
    expect(() => {
      env.appOrigin.href = 'https://evil.example/';
    }).toThrow(TypeError);
    expect(env.appOrigin.origin).toBe('https://reader.example.com');
  });

  it('allows a non-HTTPS origin in development', () => {
    const env = loadEnv({
      ...withVar('NODE_ENV', 'development'),
      APP_ORIGIN: 'http://localhost:3000',
    });
    expect(env.appOrigin.origin).toBe('http://localhost:3000');
  });

  it('refuses a non-HTTPS origin in production and names the variable', () => {
    const output = expectRefusal(
      { ...withVar('NODE_ENV', 'production'), APP_ORIGIN: 'http://read.example.com' },
      'APP_ORIGIN',
    );
    expect(output.toLowerCase()).toContain('https');
  });

  it('refuses a non-HTTPS storage endpoint in production (the S3 key travels on it)', () => {
    expectRefusal(
      { ...withVar('NODE_ENV', 'production'), S3_ENDPOINT: 'http://minio:9000' },
      'S3_ENDPOINT',
    );
  });

  it('refuses an origin that is not a bare origin', () => {
    expectRefusal(withVar('APP_ORIGIN', 'https://read.example.com/app?x=1'), 'APP_ORIGIN');
    expectRefusal(withVar('APP_ORIGIN', 'https://user:pw@read.example.com'), 'APP_ORIGIN');
  });
});

describe('empty string behaves as unset', () => {
  it.each(VARIABLES.map((c) => [c.varName, c] as const))(
    '%s — empty and whitespace-only are treated as unset',
    (_name, c) => {
      for (const blank of ['', '   ']) {
        const input = withVar(c.varName, blank);
        if (c.required) {
          expectRefusal(input, c.varName);
        } else {
          expect(c.read(loadEnv(input))).toEqual(c.defaulted);
        }
      }
    },
  );

  it('an empty APP_BASE_PATH is not a path', () => {
    expect(loadEnv(withVar('APP_BASE_PATH', '')).appBasePath).toBeUndefined();
  });

  it('an empty OTEL endpoint means telemetry off, not a failure', () => {
    const env = loadEnv(withVar('OTEL_EXPORTER_OTLP_ENDPOINT', ''));
    expect(env.otel.endpoint).toBeUndefined();
  });
});

describe('unknown variables warn, result is frozen', () => {
  it('loads successfully with unknown extra variables', () => {
    const warnings: string[] = [];
    const env = loadEnv(
      { ...BASE, SOMETHING_ELSE: 'x', PATH: '/usr/bin' },
      {
        onWarn: (m) => warnings.push(m),
      },
    );
    expect(env.nodeEnv).toBe('test');
    expect(warnings.join('\n')).toContain('SOMETHING_ELSE');
  });

  it('does not warn about platform/runtime variables the app does not own', () => {
    const warnings: string[] = [];
    loadEnv(
      { ...BASE, PATH: '/usr/bin', HOME: '/root', CI: 'true' },
      {
        onWarn: (m) => warnings.push(m),
      },
    );
    expect(warnings).toEqual([]);
  });

  it('returns a deeply frozen Env', () => {
    const env = loadEnv(BASE);
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.storage)).toBe(true);
    expect(Object.isFrozen(env.uploadLimits)).toBe(true);
    expect(Object.isFrozen(env.otel)).toBe(true);
    expect(Object.isFrozen(env.mail)).toBe(true);
    expect(Object.isFrozen(env.rateLimits)).toBe(true);
    expect(() => {
      // @ts-expect-error — the type forbids it; the test proves the runtime does too.
      env.storage.bucket = 'other';
    }).toThrow(TypeError);
  });
});

/**
 * The documented variables, transcribed row by row. The `RATE_LIMIT_*`
 * expansion of the table's "etc." covers the seven `RATE_LIMIT_*` families.
 */
const DEPLOYMENT_SECTION_3_VARIABLES: readonly string[] = [
  'NODE_ENV',
  'APP_ORIGIN',
  'APP_BASE_PATH',
  'SESSION_SECRET',
  'DATABASE_URL',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
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
  'RATE_LIMIT_GENERIC_PER_MIN',
  'RATE_LIMIT_BEACON_PER_MIN',
  'NEXT_TELEMETRY_DISABLED',
];

describe('inventory matches the deployment table', () => {
  it('implements exactly the documented variables — none invented, none omitted', () => {
    expect([...ENV_VARIABLE_NAMES].sort()).toEqual([...DEPLOYMENT_SECTION_3_VARIABLES].sort());
  });

  it('every documented variable is covered by the per-variable table', () => {
    const covered = new Set([
      ...VARIABLES.map((c) => c.varName),
      ...MAIL_GROUP.map(([name]) => name),
    ]);
    expect([...covered].sort()).toEqual([...DEPLOYMENT_SECTION_3_VARIABLES].sort());
  });
});

describe('the composition root loads the env once, at boot', () => {
  it('validates the environment and returns the boot plan — no skeleton throw', () => {
    // The env must be validated FIRST and synchronously: `buildComposition`
    // opens no connection, so a bad deploy fails here rather than at the first
    // reader's 500.
    const plan = buildComposition(BASE);
    expect(plan.env.databaseUrl).toBe(BASE['DATABASE_URL']);
    expect(plan.env.storage.bucket).toBe(BASE['S3_BUCKET']);
    expect(plan.logger).toBeDefined();
  });

  it('refuses to boot — redacted — when the environment is incomplete', () => {
    const incomplete: EnvSource = { ...BASE, SESSION_SECRET: `${SENTINEL}-secret` };
    delete incomplete['S3_BUCKET'];

    let output = '';
    try {
      buildComposition(incomplete);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        output = [error.message, error.stack ?? '', JSON.stringify(error.issues)].join('\n');
      }
    }
    expect(output).toContain('S3_BUCKET');
    expect(output).not.toContain(SENTINEL);
  });

  it('reads the REAL process environment when no source is passed', () => {
    // `@types/node` is not in the program, so the ambient environment is
    // reached through the same narrowing cast the loader itself uses.
    const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
    if (!proc) {
      throw new Error('this test needs a Node process');
    }
    const saved = { ...proc.env };
    try {
      for (const key of Object.keys(proc.env)) {
        delete proc.env[key];
      }
      Object.assign(proc.env, BASE, { AMBIENT_KNOB: SENTINEL });

      const warnings: string[] = [];
      const env = loadEnv(undefined, { onWarn: (m) => warnings.push(m) });
      expect(env.appOrigin.origin).toBe('https://reader.example.com');
      expect(warnings.join('\n')).toContain('AMBIENT_KNOB');
      expect(warnings.join('\n')).not.toContain(SENTINEL);

      // A poisoned secret in the real environment must not reach the output.
      proc.env['SESSION_SECRET'] = SENTINEL;
      const output = captureFailure({ ...proc.env });
      expect(output).toContain('SESSION_SECRET');
      expect(output).not.toContain(SENTINEL);
    } finally {
      for (const key of Object.keys(proc.env)) {
        delete proc.env[key];
      }
      Object.assign(proc.env, saved);
    }
  });
});
