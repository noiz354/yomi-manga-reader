// @ts-check
/**
 * Boundary-lint self-test.
 *
 * A rule that has never been observed to fail is not a proven rule. This script
 * writes one file per dependency rule, each containing exactly one forbidden
 * import, runs ESLint over it, and asserts that ESLint rejects it with the
 * rule's own message. It then asserts the reverse: that a legal import passes.
 *
 * Usage: `npm run lint:boundaries`
 * Exit 0 = every rule is proven to catch its violation. Exit 1 = a rule is
 * silently passing, which is a CI failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();


/**
 * Run ESLint on one fixture file; return the combined output + exit code.
 * @param {string} file
 * @returns {{ code: number, out: string }}
 */
function lint(file) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
        // The fixture glob is in the config's `ignores` so a crashed run cannot
        // leave litter that breaks `npm run lint`. The self-test must lint the
        // fixtures anyway, hence --no-ignore.
        '--no-ignore',
        '--no-warn-ignored',
        file,
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, out: stdout };
  } catch (error) {
    const e = /** @type {{ status?: number, stdout?: string, stderr?: string }} */ (error);
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * Each case: a file that MUST be rejected, and the rule id its message cites.
 * `file` is written to disk verbatim; the import is deliberately illegal.
 */
const MUST_FAIL = [
  {
    rule: 'D1',
    file: 'src/features/catalog//boundary-selftest-d1.ts',
    expectMessage: 'features/* must not import server/*',
    body: "import { db } from '../../server/db';\nexport const x = db;\n",
  },
  {
    rule: 'D2',
    file: 'src/features/catalog//boundary-selftest-d2.ts',
    expectMessage: 'only server/db/** may import drizzle-orm',
    body: "import { pgTable } from 'drizzle-orm/pg-core';\nexport const t = pgTable;\n",
  },
  {
    rule: 'D3',
    file: 'src/server/db//boundary-selftest-d3.ts',
    expectMessage: 'only server/storage/** may import the S3 SDK',
    body: "import { S3Client } from '@aws-sdk/client-s3';\nexport const c = S3Client;\n",
  },
  {
    rule: 'D4',
    file: 'src/server/db//boundary-selftest-d4.ts',
    expectMessage: 'only server/telemetry/** may import OTel SDK modules',
    body: "import { MeterProvider } from '@opentelemetry/sdk-metrics';\nexport const m = MeterProvider;\n",
  },
  {
    rule: 'D5',
    file: 'src/shared/types//boundary-selftest-d5.ts',
    expectMessage: 'shared/* is a leaf',
    body: "import { x } from '../../features/catalog';\nexport const y = x;\n",
  },
  {
    rule: 'D6',
    file: 'src/app//boundary-selftest-d6.ts',
    expectMessage: 'app/** must not import infra SDKs',
    body: "import { sql } from 'drizzle-orm';\nexport const q = sql;\n",
  },
  {
    rule: 'D8',
    file: 'src/shared/ui//boundary-selftest-d8.tsx',
    expectMessage: 'shared/ui must not import from features/*',
    body: "import { CatalogService } from '../../features/catalog';\nexport const C = CatalogService;\n",
  },
];

/** The control: a legal import that must NOT be flagged. */
const MUST_PASS = {
  file: 'src/features/catalog//boundary-selftest-legal.ts',
  body: "import type { MangaSlug } from '../../shared/types';\nexport const s: MangaSlug | null = null;\n",
};

let failures = 0;
const cleanup = [];

// Every illegal import must be rejected, citing its own rule.
for (const { rule, file, expectMessage, body } of MUST_FAIL) {
  const abs = join(ROOT, file);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body, 'utf8');
  cleanup.push(abs);

  const { code, out } = lint(abs);
  const rejected = code !== 0;
  const cited = out.includes(expectMessage);

  if (rejected && cited) {
    console.log(`  ok    ${rule} rejected, message cites the rule`);
  } else {
    failures += 1;
    if (!rejected) {
      console.error(`  FAIL  ${rule} was NOT rejected — the rule is not enforced`);
    } else {
      console.error(`  FAIL  ${rule} rejected but the message did not cite "${expectMessage}"`);
      console.error(out.split('\n').slice(0, 8).join('\n'));
    }
  }
}

// The control must pass, or the rules are over-broad.
{
  const abs = join(ROOT, MUST_PASS.file);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, MUST_PASS.body, 'utf8');
  cleanup.push(abs);

  const { code, out } = lint(abs);
  if (code === 0) {
    console.log('  ok    control legal import accepted (rules are not over-broad)');
  } else {
    failures += 1;
    console.error('  FAIL  a legal import was rejected — a rule is over-broad');
    console.error(out.split('\n').slice(0, 12).join('\n'));
  }
}

for (const file of cleanup) rmSync(file, { force: true });

if (failures > 0) {
  console.error(`\nboundary self-test FAILED: ${failures} rule(s) not proven`);
  process.exit(1);
}
console.log(`\nboundary self-test passed: ${MUST_FAIL.length} rules proven + 1 control`);
