// @ts-check
/**
 * ESLint flat config — Yomi.
 *
 * Rules D1–D9 are machine-enforced here; a violation is a CI failure, not a
 * style note. `npm run lint:boundaries` proves each rule by feeding it a
 * deliberate violation and asserting ESLint rejects it with that rule's own
 * message.
 *
 * In ESLint flat config, `rules` from several matching config objects are
 * merged key-by-key, and for the SAME rule key the LAST matching object wins —
 * the patterns are not concatenated. So the boundary rules cannot be split
 * across several overlapping `files` blocks: a later block would silently drop
 * an earlier block's patterns. Therefore every directory group below carries
 * ONE `no-restricted-imports` entry containing its complete pattern list,
 * assembled by the helpers, and the groups are mutually exclusive by
 * construction so no group can overwrite another.
 */
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** Packages restricted to a single server/ subdirectory (D2, D3, D4). */
const INFRA = {
  db: ['drizzle-orm', 'drizzle-orm/*', 'postgres', 'postgres/*'],
  storage: ['@aws-sdk/*'],
  telemetry: [
    '@opentelemetry/sdk-*',
    '@opentelemetry/exporter-*',
    '@opentelemetry/resources',
    '@opentelemetry/semantic-conventions',
  ],
};

const RULE_TEXT = {
  D1: 'D1: features/* must not import server/*. Depend on shared/contracts ports and inject at the composition root.',
  D2: 'D2: only server/db/** may import drizzle-orm or the postgres driver.',
  D3: 'D3: only server/storage/** may import the S3 SDK. Reach storage through ObjectStoragePort.',
  D4: 'D4: only server/telemetry/** may import OTel SDK modules. Elsewhere use @opentelemetry/api or the shared logger facade.',
  D5: 'D5: shared/* is a leaf — it must not import features/*, server/*, or app/*.',
  D6: 'D6: app/** must not import infra SDKs. Use the composition root exports.',
  D7: 'D7: server components must not import reader client-state modules (ADR-001).',
  D8: 'D8: shared/ui must not import from features/* — ui is leaf-ish; the dependency points the other way.',
  D9: "D9: import a feature through its public surface (its index / shared contracts), never another feature's internals.",
};

const ALL_INFRA = [...INFRA.db, ...INFRA.storage, ...INFRA.telemetry];

/** Forbidden import patterns for the infra packages a directory may not touch. */
function infraBlocked(allow, exclude) {
  const allowed = new Set([...allow, ...(exclude ?? [])]);
  return ALL_INFRA.filter((p) => !allowed.has(p)).map((group) => ({
    group: [group],
    message: `${RULE_TEXT.D2} (${group})`,
  }));
}

const restricted = (patterns) => ['error', { patterns }];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '**/boundary-selftest-*', // transient fixtures from lint:boundaries
      '_docs/**', // static design artifacts, not product source
    ],
  },

  // typescript-eslint's recommendedTypeChecked already carries ESLint's base
  // recommended rules, so no separate @eslint/js import is needed.
  ...tseslint.configs.recommendedTypeChecked,
  prettier,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The skeleton types dependency injection inline
      // (`deps: { manga: import('../manga').MangaRepository }`) so a feature can
      // reference another module's types without a runtime import — that is how
      // the contract avoids circular imports at module scope. typescript-eslint
      // v8 flipped `disallowTypeAnnotations` to default true, which would
      // outlaw that established convention, so it is restored to false here
      // rather than mass-rewriting the skeleton.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { disallowTypeAnnotations: false, fixStyle: 'inline-type-imports' },
      ],
      // A skeleton's parameter names are the documented contract, and an
      // unimplemented body legitimately ignores them. Renaming them to `_x`
      // would diverge the contract the next task implements against, so only
      // unused *variables* are reported.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // A skeleton stub is `async` and throws `not implemented: ...` — it
      // declares the Promise-returning contract without awaiting. Requiring
      // an await would forbid that shape.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      'no-console': ['error', { allow: ['error'] }],
    },
  },

  // features/*: D1 (no server/*), D9 (no cross-feature internals), D7 (no
  // reader client state from a server component), plus every infra package.
  {
    files: ['src/features/**/*.ts', 'src/features/**/*.tsx'],
    rules: {
      'no-restricted-imports': restricted([
        { group: ['**/server/*', '@/server/*'], message: RULE_TEXT.D1 },
        { group: ['@/features/*/!(index)'], message: RULE_TEXT.D9 },
        {
          group: ['@/features/reader/reader-state', '@/features/reader/reader-window'],
          message: RULE_TEXT.D7,
        },
        ...infraBlocked([]),
      ]),
    },
  },

  // server/db/**: the only place drizzle + the driver may appear (D2).
  {
    files: ['src/server/db/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted([
        { group: INFRA.storage, message: RULE_TEXT.D3 },
        { group: INFRA.telemetry, message: RULE_TEXT.D4 },
      ]),
    },
  },

  // server/storage/**: the only place the S3 SDK may appear (D3).
  {
    files: ['src/server/storage/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted([
        { group: INFRA.db, message: RULE_TEXT.D2 },
        { group: INFRA.telemetry, message: RULE_TEXT.D4 },
      ]),
    },
  },

  // server/telemetry/**: the only place the OTel SDK may appear (D4).
  {
    files: ['src/server/telemetry/**/*.ts'],
    rules: {
      'no-restricted-imports': restricted([
        { group: INFRA.db, message: RULE_TEXT.D2 },
        { group: INFRA.storage, message: RULE_TEXT.D3 },
      ]),
    },
  },

  // Any other server/*: no infra package at all.
  {
    files: ['src/server/**/*.ts'],
    ignores: ['src/server/db/**', 'src/server/storage/**', 'src/server/telemetry/**'],
    rules: {
      'no-restricted-imports': restricted([...infraBlocked([])]),
    },
  },

  // shared/ui/**: D5 (leaf) + D8 (no features).
  {
    files: ['src/shared/ui/**/*.ts', 'src/shared/ui/**/*.tsx'],
    rules: {
      'no-restricted-imports': restricted([
        { group: ['**/features/*', '@/features/*'], message: RULE_TEXT.D8 },
        { group: ['**/server/*', '@/server/*'], message: RULE_TEXT.D5 },
        { group: ['@/app/*'], message: RULE_TEXT.D5 },
        ...infraBlocked([]),
      ]),
    },
  },

  // shared/** (everything else): D5 leaf.
  {
    files: ['src/shared/**/*.ts', 'src/shared/**/*.tsx'],
    ignores: ['src/shared/ui/**'],
    rules: {
      'no-restricted-imports': restricted([
        { group: ['**/features/*', '@/features/*'], message: RULE_TEXT.D5 },
        { group: ['**/server/*', '@/server/*'], message: RULE_TEXT.D5 },
        { group: ['@/app/*'], message: RULE_TEXT.D5 },
        ...infraBlocked([]),
      ]),
    },
  },

  // app/**: D6 (no infra SDKs directly).
  {
    files: ['src/app/**/*.ts', 'src/app/**/*.tsx'],
    rules: {
      'no-restricted-imports': restricted([
        { group: INFRA.db, message: RULE_TEXT.D6 },
        { group: INFRA.storage, message: RULE_TEXT.D6 },
        {
          group: ['@/features/reader/reader-state', '@/features/reader/reader-window'],
          message: RULE_TEXT.D7,
        },
      ]),
    },
  },

  // Config files sit outside `include` (src/tests/scripts), so the type-aware
  // rules cannot resolve them. They are linted with the syntactic rules only —
  // a build config does not benefit from type-aware linting.
  {
    files: [
      'eslint.config.mjs',
      'vitest.config.ts',
      'playwright.config.ts',
      'drizzle.config.ts',
      'next-env.d.ts',
    ],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { 'no-console': 'off' },
  },

  // Tooling scripts are plain Node CLIs, not product code: they report to
  // stdout by design, and their JSDoc types are not resolvable. Product code
  // under src/ is unaffected — it logs through the pino facade, never console.
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { 'no-console': 'off' },
  },

  // Tests are the outside world: D10 allows them to import anything.
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      'no-restricted-imports': 'off',
      'no-console': 'off',
    },
  },
);
