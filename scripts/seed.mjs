#!/usr/bin/env node
// @ts-check
/**
 * scripts/seed.mjs — the dev/test seed harness.
 * Plain JS with `// @ts-check` (runs as `tsx scripts/seed.mjs`): parseable as
 * JavaScript, type-checked against the Drizzle schema.
 * Two fresh runs produce a byte-identical report: ids are pure functions of each
 * natural key, and no clock, hostname or random value is written.
 * The writer is insert-only (`ON CONFLICT DO NOTHING` + SELECTs; no UPDATE/DELETE/
 * DDL), so re-running is safe. Production is refused from both `--env` and
 * `NODE_ENV`; credentials come only from the environment and every fixture is synthetic.
 *
 * Phase two: keys are delivery-valid AND bytes are written; the upload pipeline
 * and its GC have not run. A seeded catalog is not proof that upload ingest works.
 *
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/server/db/client';
import * as dbSchema from '../src/server/db/schema';
import { createObjectStorageAsync } from '../src/server/storage/object-storage';
import { createLogger } from '../src/server/telemetry/logger';
import { loadEnv } from '../src/shared/validation';

/** The application's Drizzle handle, from the only module allowed to build it. */
/** @typedef {import('../src/server/db/client').Db} Db */
/** The validated environment. */
/** @typedef {import('../src/shared/validation').Env} Env */
/** The two modes `--env` accepts, and the NODE_ENV each implies. */
/** @typedef {'dev'|'test'} SeedMode */
/** Why a run was refused: a stable code the tests assert, not prose. */
/** @typedef {'mode-required'|'mode-invalid'|'production-mode'|'production-node-env'|'password-missing'|'schema-missing'} SeedRefusalReason */
/** The rows the repository contract accepts for one user. */
/** @typedef {{ email: string, displayName: string, passwordHash: string, role: 'admin'|'reader' }} SeedUserInput */
/** One creator as planned. */
/** @typedef {{ name: string, role: 'author'|'artist' }} SeedCreatorSpec */
/** One rendered page, as written to `chapter_page`. */
/** @typedef {{ pageNumber: number, assetKey: string, width: number, height: number, byteSizeAvif: number, byteSizeWebp: number, byteSizeJpeg: number }} SeedPageRecord */
/** What a page renderer reports: the geometry and the variant sizes. */
/**
 * The three encoded variants travel with the metadata so the caller can put them in object
 * storage. They are OPTIONAL: a renderer that is only filling in byte-size columns has no
 * reason to encode an image, and the seed's own test doubles work that way. `materialisePages`
 * refuses to upload rather than writing an empty object when a `putPage` is wired to a
 * renderer that produced none.
 * @typedef {{
 *   width: number, height: number,
 *   byteSizeAvif: number, byteSizeWebp: number, byteSizeJpeg: number,
 *   digest: string,
 *   avif?: Buffer, webp?: Buffer, jpeg?: Buffer,
 * }} RenderedPage
 */
/** Injection seam for the renderer (the unit test passes a double). */
/** @typedef {(spec: { width: number, height: number, pageNumber: number, chapterNumber: string, slug: string }) => RenderedPage | Promise<RenderedPage>} PageRenderer */
/** One chapter as planned. `pages` is filled in by `materialisePages`. */
/** @typedef {{ number: string, title: string | null, notes: string, published: boolean, pageCount: number, pages: SeedPageRecord[] }} SeedChapterSpec */
/** One title as planned. */
/** @typedef {{ index: number, title: string, slug: string, synopsis: string, status: 'ongoing'|'completed'|'hiatus', readingDirection: 'rtl'|'ltr', aliases: readonly string[], genreNames: readonly string[], tagNames: readonly string[], creators: readonly SeedCreatorSpec[], coverAssetKey: string, chapters: readonly SeedChapterSpec[] }} SeedMangaSpec */
/** The whole seed, computed without touching the database. */
/** @typedef {{ mode: SeedMode, runId: string, keyPrefix: string, pageSize: { width: number, height: number }, chunkSize: number, users: readonly { email: string, displayName: string, role: 'admin'|'reader' }[], vocabulary: { genres: readonly string[], tags: readonly string[], creators: readonly SeedCreatorSpec[] }, manga: readonly SeedMangaSpec[], loadFixture: { count: number, from: number, titles: readonly string[] }, totalPages: number }} SeedPlan */
/** The two accounts' passwords, exactly as the environment supplied them. */
/** @typedef {{ admin: string, reader: string }} SeedPasswords */
/** Every counter the writer keeps, so "the second run wrote nothing" is provable. */
/** @typedef {{ vocabulary: { genresCreated: number, tagsCreated: number, creatorsCreated: number }, users: { created: number }, manga: { created: number, links: number, loadTitlesCreated: number }, chapters: { created: number }, pages: { written: number }, ids: { reserved: number } }} SeedWriteStats */
/** The rows `manga.create` accepts: the port's fields plus the two seed additions. */
/** @typedef {{ title: string, slug: string, synopsis: string, status: string, readingDirection: string, published: boolean, coverAssetKey: string, aliases: readonly string[], genreIds: readonly string[], tagIds: readonly string[], creators: readonly { creatorId: string, role: string }[] }} SeedMangaInput */
/** Mirrors `UserRepository.create` with the two seed additions. */
/** @typedef {{ create: (input: SeedUserInput) => Promise<string> }} SeedUserRepository */
/** Mirrors `MangaRepository.create` plus the vocabulary lookups. */
/** @typedef {{ ensureGenres: (names: readonly string[]) => Promise<Map<string, string>>, ensureTags: (names: readonly string[]) => Promise<Map<string, string>>, ensureCreators: (specs: readonly SeedCreatorSpec[]) => Promise<Map<string, string>>, create: (input: SeedMangaInput) => Promise<string>, createLoadTitles: (titles: readonly { title: string, slug: string, genreId: string, tagId: string, alias: string }[]) => Promise<number> }} SeedMangaRepository */
/** The chapter port's `create` + `commitPages`, FUSED into one transaction. */
/** @typedef {{ commitChapter: (input: { mangaId: string, number: string, title: string, notes: string, published: boolean, pages: readonly SeedPageRecord[], replace: boolean }) => Promise<{ chapterId: string, created: boolean, pagesWritten: number }> }} SeedChapterRepository */
/**
 * The subset of the feature ports the seed writes through. The unit test
 * implements it in memory; `createSeedRepositories` implements it with Drizzle.
 * Every method is INSERT-shaped, which is the deliberate consequence of the
 * insert-only writer: without a `where` the harness can express "create if absent"
 * and nothing else — precisely the surface a fixture loader should have.
 * @typedef {{ users: SeedUserRepository, manga: SeedMangaRepository, chapters: SeedChapterRepository, stats: () => SeedWriteStats }} SeedRepositories
 */
/** The parsed command line. `mode` is undefined until `--env` is given. */
/** @typedef {{ mode?: SeedMode | undefined, runId?: string | undefined, mangaCount: number, loadTitles: number, pageWidth: number, pageHeight: number, chunkSize: number, timings: boolean, help: boolean }} SeedArgs */
/** Options for `buildSeedPlan`. */
/** @typedef {{ mode: SeedMode, runId?: string | undefined, mangaCount?: number | undefined, loadTitles?: number | undefined, pageSize?: { width: number, height: number } | undefined, chunkSize?: number | undefined }} SeedPlanOptions */
/** What the read-back pass proves. */
/** @typedef {{ tables: Readonly<Record<string, number>>, mangaVerified: number, chaptersVerified: number, pagesVerified: number, unplannedTitles: readonly string[], geometryMismatches: readonly string[] }} SeedVerification */
/** Everything the report is rendered from. */
/** @typedef {{ mode: SeedMode, runId: string, keyPrefix: string, pageSize: { width: number, height: number }, chunkSize: number, users: readonly { email: string, role: string }[], manga: readonly { slug: string, title: string, status: string, direction: string, chapters: number, pages: number, genres: number, tags: number, creators: number, aliases: number }[], loadFixture: { count: number, first: string, last: string }, totals: { manga: number, chapters: number, pages: number, users: number, genres: number, tags: number, creators: number }, writes: SeedWriteStats, verification: SeedVerification, timings?: Record<string, number> }} SeedReport */
/** Options for `runSeed`. */
/** @typedef {{ argv: readonly string[], source: Record<string, string|undefined>, stdout?: (text: string) => void, stderr?: (text: string) => void }} RunSeedOptions */
/** What one run produced. */
/** @typedef {{ code: number, report?: string, stats?: SeedWriteStats, verification?: SeedVerification, refusal?: SeedRefusal, timings: Record<string, number> }} SeedRunResult */
/** Options for `writeSeedPlan`. */
/** @typedef {{ passwordHashes: SeedPasswords, batchSize?: number }} WriteSeedPlanOptions */
/** One `chapter_page` row, exactly as the table declares it. */
/** @typedef {{ chapterId: string, pageNumber: number, assetKey: string, width: number, height: number, byteSizeAvif: number, byteSizeWebp: number, byteSizeJpeg: number }} SeedPageRow */

/** The run finished; the report is on stdout. */
export const EXIT_OK = 0;
/** Something failed that is not a refusal (a bug, or an unreachable database). */
export const EXIT_FAILED = 1;
/** A guard, the configuration, or the credential source said no. Never writes. */
export const EXIT_REFUSED = 2;
/** The database is reachable but the schema has not been migrated. */
export const EXIT_NO_SCHEMA = 4;

/** Stamped into deterministic hashes and CLI messages. */
export const SEED_SIGNATURE = 'yomi-v1';

/** The `manga.status` CHECK values, cycled across fixtures. */
/** @type {ReadonlyArray<'ongoing'|'completed'|'hiatus'>} */
const MANGA_STATUSES = ['ongoing', 'completed', 'hiatus'];

/** Genres: the controlled catalog vocabulary. */
/** @type {ReadonlyArray<string>} */
const GENRE_VOCABULARY = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Fantasy',
  'Horror',
  'Mystery',
  'Romance',
];

/** Freeform search tags. */
/** @type {ReadonlyArray<string>} */
const TAG_VOCABULARY = [
  'long-running',
  'one-shot',
  'slow-burn',
  'ensemble-cast',
  'color',
  'black-and-white',
  'webtoon',
  'four-panel',
];

/**
 * The fixture accounts. `seed.invalid` is reserved by RFC 2606, so a seeded
 * address can never be delivered to or resolved as a real mailbox. The
 * credential is NEVER here — it comes from the environment
 * (`readSeedPasswords`).
 * @type {readonly { email: string, displayName: string, role: 'admin'|'reader' }[]}
 */
const USER_SPECS = [
  { email: 'seed-admin@seed.invalid', displayName: 'Seed Admin', role: 'admin' },
  { email: 'seed-reader@seed.invalid', displayName: 'Seed Reader', role: 'reader' },
];

/** The 500-page case: the product's defining performance case. */
/** @type {Readonly<{ title: string, slug: string, pageCount: number }>} */
const MARATHON_MANGA = { title: 'Seed Manga 0500-Pages', slug: 'seed-manga-0500-pages', pageCount: 500 };
/** The 30-page case. */
/** @type {Readonly<{ title: string, slug: string, pageCount: number }>} */
const THIRTY_PAGE_MANGA = { title: 'Seed Manga 0030-Pages', slug: 'seed-manga-0030-pages', pageCount: 30 };

/** How many ordinary titles the default run creates (plus the two special ones). */
export const DEFAULT_MANGA_COUNT = 8;
/** Pages per ordinary chapter. Small: the harness is not a content library. */
const ORDINARY_CHAPTER_PAGES = 8;
/** The default synthetic page geometry (portrait, grayscale, 0.35 MP). */
/** @type {Readonly<{ width: number, height: number }>} */
export const DEFAULT_PAGE_SIZE = { width: 480, height: 720 };
/** Pages rendered per chunk: bounds peak memory and makes progress visible. */
export const DEFAULT_CHUNK_SIZE = 64;
/** Edge-case budget for the 500-page chapter, in milliseconds. */
export const PAGE_SEED_BUDGET_MS = 60_000;
/**
 * The first number the optional 10k-title load fixture uses.
 * A five-digit block of its own, so a load title can never collide with an
 * ordinary one and a sorted catalog still reads as one sequence.
 */
const LOAD_FIXTURE_FIRST = 10_001;

/**
 * The 8 hex characters every seeded uuid starts with: the ASCII of "YOMI". It
 * is a namespace, so a seeded id is traceable to this product and cannot collide
 * with an id the application mints by chance.
 */
const SEED_UUID_PREFIX = '594f4d49';
/** The publication stamp a seeded row carries: a constant, so a re-create is identical. */
const PUBLISHED_AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * A refusal: the harness decided NOT to run. Carries a reason code and a
 * message that names the flag or VARIABLE only — never a value.
 */
export class SeedRefusal extends Error {
  /**
   * @param {SeedRefusalReason} reason stable machine-readable code
   * @param {string} message what was refused, and what would be accepted
   */
  constructor(reason, message) {
    super(message);
    this.name = 'SeedRefusal';
    /** @type {SeedRefusalReason} */
    this.reason = reason;
  }
}

/**
 * Thrown when the database is reachable but the schema is not migrated. A
 * distinct type (and a distinct exit code) because the remedy differs: run the
 * migrations, not fix a flag.
 */
export class MissingSchemaError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'MissingSchemaError';
  }
}

/** The NODE_ENV each mode implies. @type {Readonly<Record<SeedMode, string>>} */
const MODE_NODE_ENV = { dev: 'development', test: 'test' };

/** The `--help` text; the single source of the usage. */
export const USAGE = `yomi seed harness — deterministic dev/test fixtures.

  npm run seed -- --env dev
  npm run seed -- --env test --run-id ci-7 --load-titles 10000

  --env dev|test      REQUIRED. The mode the seed is FOR. 'production' is refused.
  --run-id <id>       Key prefix in test mode (default 'local'). None in dev.
  --manga <n>         Ordinary titles to create (default ${DEFAULT_MANGA_COUNT}).
  --load-titles <n>   10k-title search load fixture (default 0 = off).
  --page-size WxH     Synthetic page geometry (default ${DEFAULT_PAGE_SIZE.width}x${DEFAULT_PAGE_SIZE.height}).
  --chunk-size <n>    Pages rendered per chunk (default ${DEFAULT_CHUNK_SIZE}).
  --timings           Add the timing section to the report (breaks the fixed diff).
  --help              This text.

Account credentials come from the environment: SEED_ADMIN_PASSWORD and
SEED_READER_PASSWORD (one shared SEED_PASSWORD is accepted for both). There is
no default and no literal in this repository.
`;

/**
 * Splits `--flag=value` into its parts, tolerating a `=`-less next argument.
 * @param {string} token
 * @returns {[string, string|undefined]}
 */
function splitFlag(token) {
  const equals = token.indexOf('=');
  if (token.startsWith('--') && equals > 0) {
    return [token.slice(0, equals), token.slice(equals + 1)];
  }
  return [token, undefined];
}

/**
 * @param {string} flag
 * @param {string} value
 * @returns {number}
 */
function positiveInteger(flag, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new SeedRefusal('mode-invalid', `${flag} needs a positive integer (got "${value}").`);
  }
  return parsed;
}

/**
 * @param {string} flag
 * @param {string} value
 * @returns {number}
 */
function nonNegativeInteger(flag, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new SeedRefusal('mode-invalid', `${flag} needs a non-negative integer (got "${value}").`);
  }
  return parsed;
}

/**
 * @param {string} value `WxH`
 * @returns {[number, number]}
 */
function parsePageSize(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new SeedRefusal('mode-invalid', `--page-size needs WxH (got "${value}").`);
  }
  return [Number(match[1]), Number(match[2])];
}

/**
 * The default page geometry as `SeedArgs` fields.
 * @returns {{ pageWidth: number, pageHeight: number }}
 */
function pageSizeArgs() {
  return { pageWidth: DEFAULT_PAGE_SIZE.width, pageHeight: DEFAULT_PAGE_SIZE.height };
}

/**
 * Parses the command line. Refuses an unusable value rather than guessing one
 * (`--env=qa` is a mistake, not a request for the nearest valid mode).
 *
 * @param {readonly string[]} argv arguments after the script name
 * @returns {SeedArgs}
 * @throws {SeedRefusal} on an unknown flag or an unusable value
 */
export function parseSeedArgs(argv) {
  /** @type {SeedArgs} */
  const args = {
    mangaCount: DEFAULT_MANGA_COUNT,
    loadTitles: 0,
    ...pageSizeArgs(),
    chunkSize: DEFAULT_CHUNK_SIZE,
    timings: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const [flag, inlineValue] = splitFlag(token);
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined) {
        throw new SeedRefusal('mode-invalid', `${flag} needs a value.`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--env': {
        const mode = value();
        if (mode !== 'dev' && mode !== 'test') {
          throw new SeedRefusal(
            'mode-invalid',
            `--env must be exactly "dev" or "test" (got "${mode}"). There is no ` +
              'production mode: seeding a production database is refused.',
          );
        }
        args.mode = mode;
        break;
      }
      case '--run-id':
        args.runId = value();
        break;
      case '--manga':
        // 0 is legal and useful: "only the 30-page and 500-page fixtures" is
        // how the marathon case is timed on its own.
        args.mangaCount = nonNegativeInteger(flag, value());
        break;
      case '--load-titles':
        args.loadTitles = nonNegativeInteger(flag, value());
        break;
      case '--page-size': {
        const [width, height] = parsePageSize(value());
        args.pageWidth = width;
        args.pageHeight = height;
        break;
      }
      case '--chunk-size':
        args.chunkSize = positiveInteger(flag, value());
        break;
      case '--timings':
        args.timings = true;
        break;
      default:
        throw new SeedRefusal('mode-invalid', `Unknown flag "${flag}". Run with --help.`);
    }
  }
  return args;
}

/**
 * Refuses anything that is not explicitly a dev or a test seed.
 *
 * Two independent doors, both closed for production: the flag itself
 * (`--env production` never parses), and the PROCESS environment behind a flag
 * (`--env dev` with `NODE_ENV=production`) — the direction a well-meaning
 * operator would actually take by accident. A dev/test NODE_ENV that does not
 * match the flag is tolerated (CI runs `NODE_ENV=test` with `--env dev` too) and
 * is reported, never silently reinterpreted.
 *
 * @param {{ requested?: string | undefined, nodeEnv: string }} input
 * @returns {{ mismatch: boolean }} whether the flag and the process env differ
 * @throws {SeedRefusal} when the run may not proceed
 */
export function assertSeedMode(input) {
  const requested = input.requested;
  if (requested === undefined) {
    throw new SeedRefusal(
      'mode-required',
      'The seed mode is not optional: pass --env dev or --env test. An implied ' +
        'mode is how a fixture ends up in a database nobody chose.',
    );
  }
  if (requested === 'production') {
    throw new SeedRefusal(
      'production-mode',
      'Refused: --env production is not a seed mode. Seeded credentials come ' +
        'from the environment, so this would write a known password into a real database.',
    );
  }
  if (requested !== 'dev' && requested !== 'test') {
    throw new SeedRefusal(
      'mode-invalid',
      `Refused: --env must be "dev" or "test" (got "${requested}").`,
    );
  }
  if (input.nodeEnv === 'production') {
    throw new SeedRefusal(
      'production-node-env',
      'Refused: NODE_ENV=production in this process. --env does not override it — a ' +
        'seed must never run against a production configuration, whatever the flag says.',
    );
  }
  return { mismatch: input.nodeEnv !== MODE_NODE_ENV[requested] };
}

/**
 * A blank value is an unset value, exactly as `loadEnv` treats one.
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function present(value) {
  if (typeof value !== 'string') return undefined;
  return value.trim() === '' ? undefined : value;
}

/**
 * Reads the seeded account credentials from the environment source that was
 * handed to `loadEnv`. There is no default, no generated value and no literal
 * anywhere: with nothing in the environment the run is refused.
 *
 * @param {Record<string, string|undefined>} source the same object given to `loadEnv`
 * @returns {SeedPasswords}
 * @throws {SeedRefusal} when no usable value is present
 */
export function readSeedPasswords(source) {
  const shared = present(source['SEED_PASSWORD']);
  const admin = present(source['SEED_ADMIN_PASSWORD']) ?? shared;
  const reader = present(source['SEED_READER_PASSWORD']) ?? shared;
  if (admin === undefined || reader === undefined) {
    throw new SeedRefusal(
      'password-missing',
      'Refused: the seeded account credential must come from the environment. Set ' +
        'SEED_ADMIN_PASSWORD and SEED_READER_PASSWORD (or one SEED_PASSWORD for ' +
        'both). This repository contains no default, by design.',
    );
  }
  return { admin, reader };
}

/**
 * A deterministic, v7-SHAPED uuid derived from a natural key. Shape only: the
 * timestamp field is a fixed constant, so ids are stable across runs and rows
 * stay comparable, at the cost of the insertion-time ordering the schema buys in
 * production (a fixture does not paginate by insertion time).
 *
 * @param {string} kind the table name, so two tables never share an id
 * @param {string} key the row's natural key (slug, email, name, `slug#number`)
 * @returns {string}
 */
export function deterministicUuid(kind, key) {
  const digest = createHash('sha256').update(`${SEED_SIGNATURE}/${kind}/${key}`).digest('hex');
  return [
    SEED_UUID_PREFIX,
    digest.slice(0, 4),
    // version 7 (UUIDv7 layout)
    `7${digest.slice(4, 7)}`,
    // variant 10xx, then three more hex digits
    `${'89ab'[Number.parseInt(digest[7] ?? '0', 16) % 4]}${digest.slice(8, 11)}`,
    digest.slice(11, 23),
  ].join('-');
}

/**
 * The opaque asset key for one page: an unguessable handle, never a path and
 * never derivable from the row ids.
 *
 * The delivery key grammar in `server/media/page-delivery.ts` is
 * `/^([A-Za-z0-9_-]{22,64})\.(avif|webp|jpeg)$/` — one path segment, no slashes — so
 * anything with a slash makes `parseDeliveryKey` return `null` and the request 404s
 * before touching storage. The 32 hex characters are valid on their own.
 *
 * The OBJECT is stored under the physical layout `pages/{chapterId}/{assetKey}.{ext}`
 * (see `pageObjectPathFor`). The URL carries only the opaque key; the chapter
 * directory is resolved server-side from the page row.
 *
 * @param {{ slug: string, chapterNumber: string, pageNumber: number }} input
 * @returns {string}
 */
export function pageAssetKey(input) {
  const digest = createHash('sha256')
    .update(`${input.slug}|${input.chapterNumber}|${input.pageNumber}`)
    .digest('hex');
  return digest.slice(0, 32);
}

/**
 * The row id a chapter will be written with. Pages are rendered before the chapter
 * rows exist, but the id is derived rather than generated, so the physical object path
 * is computable at render time and matches the row the write phase will create.
 *
 * Mirrors the derivation in the writer; the two are asserted equal by the seed's
 * verification step, so a change to one without the other fails the run.
 *
 * @param {{ slug: string, chapterNumber: string }} input
 * @returns {string}
 */
export function chapterIdFor(input) {
  return deterministicUuid('chapter', `${deterministicUuid('manga', input.slug)}#${input.chapterNumber}`);
}

/**
 * Where one page variant's OBJECT goes: `pages/{chapterId}/{assetKey}.{ext}`.
 *
 * This is the same layout `pageObjectKey` in src/server/storage builds, and it must stay
 * identical to it — the delivery route resolves the chapter directory from the page row, so
 * a seed that writes anywhere else produces an object no request will ever name. It is its
 * own function, and mirrored by a test, so that test checks the path the seed actually
 * wrote rather than rebuilding the path itself.
 *
 * @param {{ slug: string, chapterNumber: string, pageNumber: number, ext: string }} input
 * @returns {string}
 */
export function pageObjectPathFor(input) {
  const chapterId = chapterIdFor({ slug: input.slug, chapterNumber: input.chapterNumber });
  return `pages/${chapterId}/${pageAssetKey({
    slug: input.slug,
    chapterNumber: input.chapterNumber,
    pageNumber: input.pageNumber,
  })}.${input.ext}`;
}

/**
 * The opaque base key a manga's cover is stored under.
 *
 * A cover key is the same kind of thing as a page key (an opaque, unguessable,
 * layout-free handle), so it is derived the same way: 128 bits of digest, hex, one
 * URL segment. A slash or a missing extension makes `parseDeliveryKey` return null,
 * so the request 404s before storage is ever consulted. The manga directory is the
 * server's business (`covers/{mangaId}.{ext}`), not the key's — exactly the split
 * the page pipeline already uses.
 *
 * @param {{ slug: string }} input
 * @returns {string}
 */
export function coverAssetKey(input) {
  return createHash('sha256').update(`cover|${input.slug}`).digest('hex').slice(0, 32);
}

/**
 * Where one cover variant's OBJECT goes: `covers/{mangaId}.{ext}`.
 *
 * The same layout `coverObjectKey` in src/server/storage builds, and it must
 * stay identical to it — the delivery route resolves the cover from the manga
 * row, so a seed that writes anywhere else produces an object no request will
 * ever name. It is its own function, and mirrored by a test, for the same reason
 * `pageObjectPathFor` exists: a path inlined in the writer is a path the test
 * would otherwise rebuild rather than check.
 *
 * @param {{ slug: string, ext: string }} input
 * @returns {string}
 */
export function coverObjectPathFor(input) {
  const mangaId = deterministicUuid('manga', input.slug);
  return `covers/${mangaId}.${input.ext}`;
}

/**
 * `count` names starting at `from`, wrapping — deterministic, and it spreads
 * fixtures across the vocabulary so a filter has more than one member.
 * @param {readonly string[]} source
 * @param {number} from
 * @param {number} count
 * @returns {string[]}
 */
function pick(source, from, count) {
  const picked = [];
  for (let offset = 0; offset < count && offset < source.length; offset += 1) {
    const name = source[(from + offset) % source.length];
    if (name !== undefined) picked.push(name);
  }
  return picked;
}

/**
 * @param {number} number
 * @param {string} title
 * @param {boolean} published
 * @param {number} pageCount
 * @returns {SeedChapterSpec}
 */
function chapterSpec(number, title, published, pageCount) {
  return {
    // numeric(8,2) as a string: 1.00, never 1 (the column is exact numeric)
    number: number.toFixed(2),
    title,
    notes: 'Seeded by the harness. Synthetic pages, no product content.',
    published,
    pageCount,
    pages: [],
  };
}

/**
 * One ordinary fixture title: three chapters (two published, one draft) of
 * eight pages each.
 *
 * @param {{
 *   index: number, keyPrefix: string,
 *   genreNames: readonly string[], tagNames: readonly string[],
 *   creators: readonly SeedCreatorSpec[], pages: number,
 * }} input
 * @returns {SeedMangaSpec}
 */
function ordinaryManga(input) {
  const index = input.index;
  const padded = String(index).padStart(4, '0');
  // Cycle the enum-ish columns so every CHECK has a
  // fixture: a reader page that only ever sees one value cannot prove the rule.
  const status = MANGA_STATUSES[(index - 1) % 3] ?? 'ongoing';
  const readingDirection = index % 2 === 0 ? 'ltr' : 'rtl';
  const slug = `${input.keyPrefix}seed-manga-${padded}`;
  return {
    index,
    title: `Seed Manga ${padded}`,
    slug,
    synopsis:
      `Synthetic fixture synopsis for Seed Manga ${padded}. Generated by the ` +
      'Seed harness; not a real title and not product content.',
    status,
    readingDirection,
    aliases: [`${input.keyPrefix}Seed Manga ${padded} (Alt)`, `${input.keyPrefix}Serie ${padded}`],
    genreNames: pick(input.genreNames, index, 2),
    tagNames: pick(input.tagNames, index, 3),
    creators: input.creators,
    coverAssetKey: coverAssetKey({ slug }),
    chapters: [
      chapterSpec(1, `${padded} — opening`, true, input.pages),
      chapterSpec(2, `${padded} — middle`, true, input.pages),
      // A draft: unpublished, so the reader's visibility rule
      // and the admin publish path both have a fixture to work on.
      chapterSpec(3, `${padded} — draft`, false, input.pages),
    ],
  };
}

/**
 * The 30-page and 500-page performance fixtures: one published chapter each, so
 * a deep link lands on a readable chapter without a publish ceremony.
 *
 * @param {{
 *   keyPrefix: string,
 *   genreNames: readonly string[], tagNames: readonly string[],
 *   creators: readonly SeedCreatorSpec[], title: string, slug: string, pageCount: number,
 * }} input
 * @returns {SeedMangaSpec}
 */
function specialManga(input) {
  const slug = `${input.keyPrefix}${input.slug}`;
  return {
    index: 0,
    title: input.title,
    slug,
    synopsis:
      `Synthetic fixture: ${String(input.pageCount)} generated gradient pages. The ` +
      'reader performance case; no product content.',
    status: 'ongoing',
    readingDirection: 'rtl',
    aliases: [`${slug} (fixture)`],
    genreNames: pick(input.genreNames, input.pageCount, 2),
    tagNames: pick(input.tagNames, input.pageCount, 3),
    creators: input.creators,
    coverAssetKey: coverAssetKey({ slug }),
    chapters: [chapterSpec(1, 'the whole chapter', true, input.pageCount)],
  };
}

/**
 * Builds the whole seed as data. Pure: no clock, no randomness, no I/O, so two
 * calls with the same options are byte-identical and the plan
 * can be asserted without a database.
 *
 * @param {SeedPlanOptions} options
 * @returns {SeedPlan}
 */
export function buildSeedPlan(options) {
  const runId = options.runId ?? 'local';
  const keyPrefix = options.mode === 'test' ? `t${runId}-` : '';
  const mangaCount = options.mangaCount ?? DEFAULT_MANGA_COUNT;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

  const users = USER_SPECS.map((user) => ({
    email: `${keyPrefix}${user.email}`,
    displayName: user.displayName,
    role: user.role,
  }));
  /** @type {SeedCreatorSpec[]} */
  const creators = [
    { name: `${keyPrefix}Seed Author 01`, role: 'author' },
    { name: `${keyPrefix}Seed Artist 01`, role: 'artist' },
  ];
  const vocabulary = {
    genres: [...GENRE_VOCABULARY],
    tags: [...TAG_VOCABULARY],
    creators,
  };

  const manga = [];
  for (let index = 1; index <= mangaCount; index += 1) {
    manga.push(
      ordinaryManga({ index, keyPrefix, genreNames: vocabulary.genres, tagNames: vocabulary.tags, creators: vocabulary.creators, pages: ORDINARY_CHAPTER_PAGES }),
    );
  }
  const specialInput = {
    keyPrefix,
    genreNames: vocabulary.genres,
    tagNames: vocabulary.tags,
    creators: vocabulary.creators,
  };
  manga.push(specialManga({ ...specialInput, ...THIRTY_PAGE_MANGA }));
  manga.push(specialManga({ ...specialInput, ...MARATHON_MANGA }));

  const loadTitles = options.loadTitles ?? 0;
  const loadFixture = {
    count: loadTitles,
    from: LOAD_FIXTURE_FIRST,
    titles: Array.from(
      { length: loadTitles },
      (_, offset) => `Seed Manga ${String(LOAD_FIXTURE_FIRST + offset).padStart(5, '0')}`,
    ),
  };

  const totalPages = manga.reduce(
    (sum, entry) => sum + entry.chapters.reduce((n, chapter) => n + chapter.pageCount, 0),
    0,
  );

  return {
    mode: options.mode,
    runId,
    keyPrefix,
    pageSize,
    chunkSize,
    users,
    vocabulary,
    manga,
    loadFixture,
    totalPages,
  };
}

/**
 * sharp is loaded once, lazily, so importing this module stays cheap (a unit
 * test that never renders a page never pays for the native module).
 * The package's own types are ESM-shaped, so the callable is the module's
 * `default` export, typed `SharpConstructor`.
 * @type {import('sharp').SharpConstructor | undefined}
 */
let sharpModule;

/**
 * @returns {Promise<import('sharp').SharpConstructor>}
 */
async function loadSharp() {
  sharpModule ??= (await import('sharp')).default;
  return sharpModule;
}

/**
 * A vertical grayscale gradient as a single-channel raw buffer, tilted by the
 * page number so every page of a chapter is a DIFFERENT image (a reader cache
 * keyed on one repeated blob would hide page-order bugs). Pure arithmetic:
 * page N always produces the same bytes.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} pageNumber 1-based
 * @returns {Buffer}
 */
export function grayscaleGradient(width, height, pageNumber) {
  const raw = Buffer.allocUnsafe(width * height);
  const tilt = (pageNumber * 37) % height;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const base = (((y + tilt) * 255) / height) | 0;
    for (let x = 0; x < width; x += 1) {
      // the horizontal term keeps the ramp from banding into flat stripes
      raw[row + x] = (base + ((x * 255) / width) / 2) & 0xff;
    }
  }
  return raw;
}

/**
 * Renders ONE synthetic page and reports its real geometry and variant sizes.
 *
 * The image is a deterministic grayscale gradient computed in a raw buffer in
 * memory: no file is read, no file is written, no network call is made, and no
 * byte of it comes from anywhere but this function: a licensed-content reader
 * must never carry real artwork into a repository, a test fixture or a CI cache,
 * and a gradient cannot be mistaken for a scan.
 *
 * The three encoded variants exist so the recorded `byte_size_*` columns are
 * measurements of a real encode, not invented numbers.
 *
 * The encoded buffers are RETURNED so the caller can put them in object storage:
 * without them every seeded page row would point at an object that did not exist,
 * `/media/{assetKey}.jpeg` would answer 404 and the reader would render broken
 * images. They are never written to the repository or committed — they go to
 * whatever `ObjectStoragePort` the environment selects (a local directory, or
 * S3/R2), the same place a real upload puts them.
 *
 * The returned buffers are live and are not safe to retain: a 500-page chapter
 * held at once is hundreds of MB. `materialisePages` therefore uploads inside its
 * chunk loop and lets each buffer fall out of scope.
 *
 * @param {{ width: number, height: number, pageNumber: number, chapterNumber: string, slug: string }} spec
 * @returns {Promise<RenderedPage>}
 */
export async function renderSyntheticPage(spec) {
  const sharp = await loadSharp();
  const raw = grayscaleGradient(spec.width, spec.height, spec.pageNumber);
  /** @type {import('sharp').SharpOptions} */
  const input = { raw: { width: spec.width, height: spec.height, channels: 1 } };
  // AVIF effort 0 is deliberate: it is ~5x faster than the default for a fixture
  // whose only consumer is a byte-size column, and that is what keeps the 500-page
  // run inside its 60 s budget.
  const [avif, webp, jpeg] = await Promise.all([
    sharp(raw, input).avif({ effort: 0 }).toBuffer(),
    sharp(raw, input).webp().toBuffer(),
    sharp(raw, input).jpeg({ quality: 80 }).toBuffer(),
  ]);
  return {
    width: spec.width,
    height: spec.height,
    byteSizeAvif: avif.length,
    byteSizeWebp: webp.length,
    byteSizeJpeg: jpeg.length,
    digest: createHash('sha256').update(avif).digest('hex').slice(0, 16),
    avif,
    webp,
    jpeg,
  };
}

/**
 * Cover art dimensions: 2:3, the design's cover proportion (the hi-fi set;
 * `cover-image.tsx` reserves the box at 600×900). Under the 1200 px ceiling, so
 * no downscale step is needed.
 */
export const SYNTHETIC_COVER_WIDTH = 600;
export const SYNTHETIC_COVER_HEIGHT = 900;

/**
 * Renders ONE synthetic cover and reports its real geometry and variant sizes.
 *
 * Same synthetic-gradient technique as `renderSyntheticPage` (no file read, no
 * network, nothing but this function), but WebP + JPEG ONLY: covers are stored in
 * those two variants (`coverObjectKey`), so an AVIF encode would be a third of the
 * cover budget spent on bytes no request can name. The gradient tilt is derived
 * from the slug so covers differ from each other the way pages differ by page
 * number — deterministically.
 *
 * The encoded buffers are RETURNED for the caller to put in object storage
 * (the same arrangement as pages). They are live and not safe to retain; the
 * seed writes each cover inside its loop and lets the buffers fall out of
 * scope.
 *
 * @param {{ slug: string }} spec
 * @returns {Promise<{ width: number, height: number, byteSizeWebp: number, byteSizeJpeg: number, webp: Buffer, jpeg: Buffer }>}
 */
export async function renderSyntheticCover(spec) {
  const sharp = await loadSharp();
  const tiltSeed = Number.parseInt(createHash('sha256').update(spec.slug).digest('hex').slice(0, 8), 16);
  const raw = grayscaleGradient(SYNTHETIC_COVER_WIDTH, SYNTHETIC_COVER_HEIGHT, tiltSeed % 997);
  /** @type {import('sharp').SharpOptions} */
  const input = { raw: { width: SYNTHETIC_COVER_WIDTH, height: SYNTHETIC_COVER_HEIGHT, channels: 1 } };
  const [webp, jpeg] = await Promise.all([
    sharp(raw, input).webp().toBuffer(),
    sharp(raw, input).jpeg({ quality: 80 }).toBuffer(),
  ]);
  return {
    width: SYNTHETIC_COVER_WIDTH,
    height: SYNTHETIC_COVER_HEIGHT,
    byteSizeWebp: webp.length,
    byteSizeJpeg: jpeg.length,
    webp,
    jpeg,
  };
}

/**
 * Fills in every chapter's page records by rendering them, in chunks.
 *
 * Chunking is not decoration: it bounds peak memory (holding a 500-page render
 * at once would be hundreds of MB of transient buffers) and it is what makes the
 * budget observable — `onChunk` reports the running page count, which is how the
 * harness logs progress on a twenty-second run. It is also the only safe place to
 * upload: each page's three variants are written inside the loop and released
 * before the next render.
 *
 * @param {SeedPlan} plan
 * @param {{
 *   render?: PageRenderer,
 *   chunkSize?: number,
 *   onChunk?: (done: number, total: number) => void,
 *   putPage?: (page: { assetKey: string; chapterId: string; slug: string; chapterNumber: string; pageNumber: number; width: number; height: number }, variants: { avif: Buffer; webp: Buffer; jpeg: Buffer }) => Promise<void>,
 * }} [options]
 * @returns {Promise<SeedPlan>} the same plan with `pages` filled in
 */
export async function materialisePages(plan, options = {}) {
  const render = options.render ?? renderSyntheticPage;
  const chunkSize = options.chunkSize ?? plan.chunkSize;
  const onChunk = options.onChunk ?? (() => undefined);
  const putPage = options.putPage;
  /** Pages rendered so far, across every chapter (the progress counter). */
  let done = 0;
  const manga = [];
  for (const entry of plan.manga) {
    const chapters = [];
    for (const chapter of entry.chapters) {
      const pages = [];
      for (let start = 1; start <= chapter.pageCount; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, chapter.pageCount);
        for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
          const rendered = await render({
            width: plan.pageSize.width,
            height: plan.pageSize.height,
            pageNumber,
            chapterNumber: chapter.number,
            slug: entry.slug,
          });
          const assetKey = pageAssetKey({
            slug: entry.slug,
            chapterNumber: chapter.number,
            pageNumber,
          });
          if (putPage) {
            // A missing variant fails here, loudly. Writing an empty object would
            // look successful to the storage adapter and surface as a reader
            // seeing a zero-byte image instead of a missing page.
            if (!rendered.avif || !rendered.webp || !rendered.jpeg) {
              throw new Error(
                `seed: a putPage hook is wired but the renderer returned no bytes for ` +
                  `${assetKey}. A renderer must encode all three variants to be uploaded.`,
              );
            }
            // Inside the loop, not after it: the three buffers are live, and a
            // chapter of 500 pages would otherwise be retained in full.
            await putPage(
              {
                assetKey,
                chapterId: chapterIdFor({ slug: entry.slug, chapterNumber: chapter.number }),
                slug: entry.slug,
                chapterNumber: chapter.number,
                pageNumber,
                width: rendered.width,
                height: rendered.height,
              },
              { avif: rendered.avif, webp: rendered.webp, jpeg: rendered.jpeg },
            );
          }
          pages.push({
            pageNumber,
            assetKey,
            width: rendered.width,
            height: rendered.height,
            byteSizeAvif: rendered.byteSizeAvif,
            byteSizeWebp: rendered.byteSizeWebp,
            byteSizeJpeg: rendered.byteSizeJpeg,
          });
        }
        done += end - start + 1;
        onChunk(done, plan.totalPages);
      }
      chapters.push({ ...chapter, pages });
    }
    manga.push({ ...entry, chapters });
  }
  return { ...plan, manga };
}

/**
 * A vocabulary name must resolve to an id, or the plan is internally broken.
 * @param {Map<string, string>} ids
 * @param {string} name
 * @param {string} kind
 * @returns {string}
 */
function requiredId(ids, name, kind) {
  const id = ids.get(name);
  if (id === undefined) {
    throw new Error(`seed plan error: no ${kind} id for "${name}"`);
  }
  return id;
}

/**
 * The number of deterministic ids the plan will need. A property of the plan
 * (so it is identical on a re-run), reported so a reader of the report can see
 * the plan's row budget without counting rows.
 *
 * @param {SeedPlan} plan
 * @returns {number}
 */
export function reservedIdCount(plan) {
  const chapters = plan.manga.reduce((n, manga) => n + manga.chapters.length, 0);
  return (
    plan.vocabulary.genres.length +
    plan.vocabulary.tags.length +
    plan.vocabulary.creators.length +
    plan.users.length +
    plan.manga.length +
    chapters +
    plan.totalPages +
    plan.loadFixture.count
  );
}

/**
 * Writes a materialised plan through the repository bundle. Knows nothing about
 * SQL: the unit test proves idempotency against an in-memory bundle, the
 * integration test against the real Drizzle one.
 *
 * @param {SeedPlan} plan
 * @param {SeedRepositories} repositories
 * @param {WriteSeedPlanOptions} options
 * @returns {Promise<SeedWriteStats>}
 */
export async function writeSeedPlan(plan, repositories, options) {
  const batchSize = options.batchSize ?? 500;
  const stats = {
    vocabulary: { genresCreated: 0, tagsCreated: 0, creatorsCreated: 0 },
    users: { created: 0 },
    manga: { created: 0, links: 0, loadTitlesCreated: 0 },
    chapters: { created: 0 },
    pages: { written: 0 },
    ids: { reserved: reservedIdCount(plan) },
  };
  // A repository bundle counts its own lifetime, not one run: the same bundle
  // handed to a second `writeSeedPlan` still reports the first run's totals.
  // The report must be about THIS run, so every counter is a delta against a
  // snapshot taken before the first write. That delta is what makes a re-run's
  // report read "0 created".
  const baseline = repositories.stats();

  const [genreIds, tagIds, creatorIds] = await Promise.all([
    repositories.manga.ensureGenres(plan.vocabulary.genres),
    repositories.manga.ensureTags(plan.vocabulary.tags),
    repositories.manga.ensureCreators(plan.vocabulary.creators),
  ]);

  for (const user of plan.users) {
    await repositories.users.create({
      email: user.email,
      displayName: user.displayName,
      passwordHash: user.role === 'admin' ? options.passwordHashes.admin : options.passwordHashes.reader,
      role: user.role,
    });
  }

  for (const manga of plan.manga) {
    await repositories.manga.create({
      title: manga.title,
      slug: manga.slug,
      synopsis: manga.synopsis,
      status: manga.status,
      readingDirection: manga.readingDirection,
      published: true,
      coverAssetKey: manga.coverAssetKey,
      aliases: manga.aliases,
      genreIds: manga.genreNames.map((name) => requiredId(genreIds, name, 'genre')),
      tagIds: manga.tagNames.map((name) => requiredId(tagIds, name, 'tag')),
      creators: manga.creators.map((creator) => ({
        creatorId: requiredId(creatorIds, creator.name, 'creator'),
        role: creator.role,
      })),
    });
    for (const chapter of manga.chapters) {
      const outcome = await repositories.chapters.commitChapter({
        // The manga id is the deterministic function of its slug — the same one
        // `manga.create` used, so no read-back is needed to know it.
        mangaId: deterministicUuid('manga', manga.slug),
        number: chapter.number,
        title: chapter.title ?? '',
        notes: chapter.notes,
        published: chapter.published,
        pages: chapter.pages,
        replace: true,
      });
      void outcome;
    }
  }

  if (plan.loadFixture.count > 0) {
    const firstGenre = plan.vocabulary.genres[0] ?? '';
    const firstTag = plan.vocabulary.tags[0] ?? '';
    const genreId = requiredId(genreIds, firstGenre, 'genre');
    const tagId = requiredId(tagIds, firstTag, 'tag');
    const titles = plan.loadFixture.titles.map((title, offset) => ({
      title,
      slug: `${plan.keyPrefix}seed-manga-${String(plan.loadFixture.from + offset).padStart(5, '0')}`,
      genreId,
      tagId,
      alias: `Seed Manga ${String(plan.loadFixture.from + offset).padStart(5, '0')} (load)`,
    }));
    for (let start = 0; start < titles.length; start += batchSize) {
      await repositories.manga.createLoadTitles(titles.slice(start, start + batchSize));
    }
  }

  const after = repositories.stats();
  stats.vocabulary = {
    genresCreated: after.vocabulary.genresCreated - baseline.vocabulary.genresCreated,
    tagsCreated: after.vocabulary.tagsCreated - baseline.vocabulary.tagsCreated,
    creatorsCreated: after.vocabulary.creatorsCreated - baseline.vocabulary.creatorsCreated,
  };
  stats.users.created = after.users.created - baseline.users.created;
  stats.manga = {
    created: after.manga.created - baseline.manga.created,
    links: after.manga.links - baseline.manga.links,
    loadTitlesCreated: after.manga.loadTitlesCreated - baseline.manga.loadTitlesCreated,
  };
  stats.chapters.created = after.chapters.created - baseline.chapters.created;
  stats.pages.written = after.pages.written - baseline.pages.written;
  return stats;
}

/**
 * @param {string} chapterId
 * @param {SeedPageRecord} page
 * @returns {SeedPageRow}
 */
function pageRow(chapterId, page) {
  return {
    chapterId,
    pageNumber: page.pageNumber,
    assetKey: page.assetKey,
    width: page.width,
    height: page.height,
    byteSizeAvif: page.byteSizeAvif,
    byteSizeWebp: page.byteSizeWebp,
    byteSizeJpeg: page.byteSizeJpeg,
  };
}

/**
 * The default role for a creator name, taken from the specs that named it.
 * @param {readonly SeedCreatorSpec[]} specs
 * @param {string} name
 * @returns {string}
 */
function roleOf(specs, name) {
  return specs.find((spec) => spec.name === name)?.role ?? 'other';
}

/**
 * Builds the insert-only repositories over the application's `Db` handle.
 *
 * Import boundary: this function takes the handle `createDb(env)` returns and
 * the schema objects, and imports NO runtime symbol from `drizzle-orm` — every
 * statement goes through the handle's query builder, which binds every value as
 * a parameter. No `sql.unsafe`, no `sql.raw`, no string-built template, and no DDL
 * (the app role is DML-only).
 * `// @ts-check` still verifies every inserted object against the schema's
 * inferred column types, so a renamed column fails `tsc`, not production.
 *
 * @param {Db} db the application's database handle
 * @returns {SeedRepositories}
 */
export function createSeedRepositories(db) {
  const stats = {
    vocabulary: { genresCreated: 0, tagsCreated: 0, creatorsCreated: 0 },
    users: { created: 0 },
    manga: { created: 0, links: 0, loadTitlesCreated: 0 },
    chapters: { created: 0 },
    pages: { written: 0 },
    ids: { reserved: 0 },
  };

  return {
    users: {
      /**
       * @param {SeedUserInput} input
       * @returns {Promise<string>} the user id, which is a pure function of the email
       */
      async create(input) {
        const id = deterministicUuid('user', input.email);
        const inserted = await db
          .insert(dbSchema.users)
          .values({
            id,
            email: input.email,
            displayName: input.displayName,
            // the hash the plan carries; a re-run conflicts on the email and
            // therefore never re-hashes
            passwordHash: input.passwordHash,
            role: input.role,
          })
          .onConflictDoNothing({ target: dbSchema.users.email })
          .returning({ id: dbSchema.users.id });
        if (inserted.length > 0) stats.users.created += 1;
        return id;
      },
    },
    manga: {
      /**
       * @param {readonly string[]} names
       * @returns {Promise<Map<string, string>>}
       */
      async ensureGenres(names) {
        const ids = new Map();
        for (const name of names) ids.set(name, deterministicUuid('genre', name));
        const inserted = await db
          .insert(dbSchema.genre)
          .values([...ids].map(([name, id]) => ({ id, name })))
          .onConflictDoNothing({ target: dbSchema.genre.name })
          .returning({ id: dbSchema.genre.id });
        stats.vocabulary.genresCreated += inserted.length;
        return ids;
      },
      /**
       * @param {readonly string[]} names
       * @returns {Promise<Map<string, string>>}
       */
      async ensureTags(names) {
        const ids = new Map();
        for (const name of names) ids.set(name, deterministicUuid('tag', name));
        const inserted = await db
          .insert(dbSchema.tag)
          .values([...ids].map(([name, id]) => ({ id, name })))
          // The tag name is unique over `lower(name)`, i.e. an
          // EXPRESSION index. PostgreSQL cannot infer such an index from a column
          // conflict target — `ON CONFLICT (name)` would raise "no unique or
          // exclusion constraint matching". The bare form accepts any unique
          // violation, which for an insert-only writer is exactly "this tag is
          // already there".
          .onConflictDoNothing()
          .returning({ id: dbSchema.tag.id });
        stats.vocabulary.tagsCreated += inserted.length;
        return ids;
      },
      /**
       * @param {readonly SeedCreatorSpec[]} specs
       * @returns {Promise<Map<string, string>>}
       */
      async ensureCreators(specs) {
        const ids = new Map();
        for (const spec of specs) ids.set(spec.name, deterministicUuid('creator', spec.name));
        const inserted = await db
          .insert(dbSchema.creator)
          .values(
            [...ids].map(([name, id]) => ({ id, name, roleDefault: roleOf(specs, name) })),
          )
          .onConflictDoNothing({ target: dbSchema.creator.name })
          .returning({ id: dbSchema.creator.id });
        stats.vocabulary.creatorsCreated += inserted.length;
        return ids;
      },
      /**
       * @param {SeedMangaInput} input
       * @returns {Promise<string>}
       */
      async create(input) {
        const id = deterministicUuid('manga', input.slug);
        const inserted = await db
          .insert(dbSchema.manga)
          .values({
            id,
            slug: input.slug,
            title: input.title,
            synopsis: input.synopsis,
            status: input.status,
            readingDirection: input.readingDirection,
            published: input.published,
            coverAssetKey: input.coverAssetKey,
          })
          .onConflictDoNothing({ target: dbSchema.manga.slug })
          .returning({ id: dbSchema.manga.id });
        if (inserted.length === 0) return id;
        stats.manga.created += 1;
        // The links go in with the title, in one transaction: a title with no
        // genre/tag/creator/alias is not a state the app can produce, and a
        // half-linked fixture would be worse than a failed seed.
        await db.transaction(async (tx) => {
          await tx
            .insert(dbSchema.mangaAlias)
            .values(
              input.aliases.map((alias) => ({
                id: deterministicUuid('alias', `${input.slug}|${alias}`),
                mangaId: id,
                alias,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: dbSchema.mangaAlias.id });
          await tx
            .insert(dbSchema.mangaGenre)
            .values(input.genreIds.map((genreId) => ({ mangaId: id, genreId })))
            .onConflictDoNothing()
            .returning({ mangaId: dbSchema.mangaGenre.mangaId });
          await tx
            .insert(dbSchema.mangaTag)
            .values(input.tagIds.map((tagId) => ({ mangaId: id, tagId })))
            .onConflictDoNothing()
            .returning({ mangaId: dbSchema.mangaTag.mangaId });
          await tx
            .insert(dbSchema.mangaCreator)
            .values(
              input.creators.map((creator) => ({
                mangaId: id,
                creatorId: creator.creatorId,
                role: creator.role,
              })),
            )
            .onConflictDoNothing()
            .returning({ mangaId: dbSchema.mangaCreator.mangaId });
        });
        stats.manga.links +=
          input.aliases.length + input.genreIds.length + input.tagIds.length + input.creators.length;
        return id;
      },
      /**
       * The 10k-title load fixture: titles only, batched, one link each. What
       * the load fixture needs is 10k rows in `manga` to measure trigram search
       * against; pages would cost 8 000 encodes for nothing.
       *
       * @param {readonly { title: string, slug: string, genreId: string, tagId: string, alias: string }[]} titles
       * @returns {Promise<number>} how many rows were actually inserted
       */
      async createLoadTitles(titles) {
        let created = 0;
        const mangaRows = [];
        for (const entry of titles) {
          mangaRows.push({
            id: deterministicUuid('manga', entry.slug),
            slug: entry.slug,
            title: entry.title,
            synopsis: 'Synthetic load fixture title. No product content.',
            status: 'ongoing',
            readingDirection: 'rtl',
            published: true,
            coverAssetKey: null,
          });
        }
        const inserted = await db
          .insert(dbSchema.manga)
          .values(mangaRows)
          .onConflictDoNothing({ target: dbSchema.manga.slug })
          .returning({ id: dbSchema.manga.id });
        created += inserted.length;
        await db.transaction(async (tx) => {
          for (const entry of titles) {
            const mangaId = deterministicUuid('manga', entry.slug);
            await tx
              .insert(dbSchema.mangaAlias)
              .values({
                id: deterministicUuid('alias', `${entry.slug}|${entry.alias}`),
                mangaId,
                alias: entry.alias,
              })
              .onConflictDoNothing()
              .returning({ id: dbSchema.mangaAlias.id });
            await tx
              .insert(dbSchema.mangaGenre)
              .values({ mangaId, genreId: entry.genreId })
              .onConflictDoNothing()
              .returning({ mangaId: dbSchema.mangaGenre.mangaId });
            await tx
              .insert(dbSchema.mangaTag)
              .values({ mangaId, tagId: entry.tagId })
              .onConflictDoNothing()
              .returning({ mangaId: dbSchema.mangaTag.mangaId });
          }
        });
        stats.manga.loadTitlesCreated += created;
        return created;
      },
    },
    chapters: {
      /**
       * The chapter and its full 1..N page set become visible in ONE
       * transaction, so a published chapter never exists without its pages —
       * the property the port's `commitPages` exists to guarantee. The contiguity
       * is asserted before the write.
       *
       * @param {{ mangaId: string, number: string, title: string, notes: string, published: boolean, pages: readonly SeedPageRecord[], replace: boolean }} input
       * @returns {Promise<{ chapterId: string, created: boolean, pagesWritten: number }>}
       */
      async commitChapter(input) {
        assertContiguousPages(input.pages);
        const chapterId = deterministicUuid('chapter', `${input.mangaId}#${input.number}`);
        const created = await db.transaction(async (tx) => {
          const chapterRows = await tx
            .insert(dbSchema.chapter)
            .values({
              id: chapterId,
              mangaId: input.mangaId,
              // numeric(8,2) as a string: exact, and 10.5 is representable
              number: input.number,
              title: input.title,
              notes: input.notes,
              status: input.published ? 'published' : 'draft',
              publishedAt: input.published ? PUBLISHED_AT : null,
              // the denormalized counter, written WITH the rows it counts
              pageCount: input.pages.length,
              readingOrder: Number.parseInt(input.number, 10),
            })
            .onConflictDoNothing({
              target: [dbSchema.chapter.mangaId, dbSchema.chapter.number],
            })
            .returning({ id: dbSchema.chapter.id });
          const isNew = chapterRows.length > 0;
          if (input.pages.length > 0) {
            const pageRows = await tx
              .insert(dbSchema.chapterPage)
              .values(input.pages.map((page) => pageRow(chapterId, page)))
              .onConflictDoNothing()
              .returning({ pageNumber: dbSchema.chapterPage.pageNumber });
            if (isNew) stats.pages.written += pageRows.length;
          }
          return isNew;
        });
        if (created) stats.chapters.created += 1;
        return { chapterId, created, pagesWritten: created ? input.pages.length : 0 };
      },
    },
    stats: () => ({
      vocabulary: { ...stats.vocabulary },
      users: { ...stats.users },
      manga: { ...stats.manga },
      chapters: { ...stats.chapters },
      pages: { ...stats.pages },
      ids: { ...stats.ids },
    }),
  };
}

/**
 * Asserted before anything is written: pages
 * are exactly 1..N, ascending, with no duplicate asset key. A fixture that
 * violated it would be teaching the reader to tolerate a broken chapter.
 *
 * @param {readonly SeedPageRecord[]} pages
 * @returns {void}
 */
export function assertContiguousPages(pages) {
  for (let offset = 0; offset < pages.length; offset += 1) {
    const page = pages[offset];
    if (page === undefined || page.pageNumber !== offset + 1) {
      throw new Error(
        `seed plan error: pages must be 1..N ascending (broken at index ${String(offset)})`,
      );
    }
  }
  const keys = new Set(pages.map((page) => page.assetKey));
  if (keys.size !== pages.length) {
    throw new Error('seed plan error: duplicate page asset key');
  }
}

/**
 * Reads the seeded rows back and proves the plan landed. Read-only by
 * construction: a SELECT cannot damage anything, so this is safe to run against
 * a database the harness did not create.
 *
 * @param {Db} db
 * @param {SeedPlan} plan
 * @returns {Promise<SeedVerification>}
 */
export async function verifySeed(db, plan) {
  const [users, genres, tags, creators, mangaRows, chapterRows, pageRows, aliasRows] =
    await Promise.all([
      db.select({ id: dbSchema.users.id }).from(dbSchema.users),
      db.select({ id: dbSchema.genre.id }).from(dbSchema.genre),
      db.select({ id: dbSchema.tag.id }).from(dbSchema.tag),
      db.select({ id: dbSchema.creator.id }).from(dbSchema.creator),
      db
        .select({
          slug: dbSchema.manga.slug,
          published: dbSchema.manga.published,
          deletedAt: dbSchema.manga.deletedAt,
        })
        .from(dbSchema.manga),
      db
        .select({
          id: dbSchema.chapter.id,
          pageCount: dbSchema.chapter.pageCount,
        })
        .from(dbSchema.chapter),
      db
        .select({
          chapterId: dbSchema.chapterPage.chapterId,
          pageNumber: dbSchema.chapterPage.pageNumber,
          width: dbSchema.chapterPage.width,
          height: dbSchema.chapterPage.height,
        })
        .from(dbSchema.chapterPage),
      db.select({ alias: dbSchema.mangaAlias.alias }).from(dbSchema.mangaAlias),
    ]);

  const bySlug = new Map(mangaRows.map((row) => [row.slug, row]));
  const plannedSlugs = new Set(plan.manga.map((entry) => entry.slug));
  const unplannedTitles = mangaRows
    .map((row) => row.slug)
    .filter((slug) => slug.startsWith(plan.keyPrefix))
    .filter((slug) => !plannedSlugs.has(slug))
    .filter((slug) => !isLoadFixtureSlug(slug, plan))
    .sort();

  let mangaVerified = 0;
  for (const entry of plan.manga) {
    const row = bySlug.get(entry.slug);
    if (row !== undefined && row.published && row.deletedAt === null) mangaVerified += 1;
  }

  /** @type {Map<string, { chapterId: string, pageNumber: number, width: number, height: number }[]>} */
  const pagesByChapter = new Map();
  for (const row of pageRows) {
    const bucket = pagesByChapter.get(row.chapterId);
    if (bucket === undefined) pagesByChapter.set(row.chapterId, [row]);
    else bucket.push(row);
  }
  let chaptersVerified = 0;
  let pagesVerified = 0;
  const geometryMismatches = [];
  for (const entry of plan.manga) {
    const mangaId = deterministicUuid('manga', entry.slug);
    for (const chapter of entry.chapters) {
      const chapterId = deterministicUuid('chapter', `${mangaId}#${chapter.number}`);
      const row = chapterRows.find((candidate) => candidate.id === chapterId);
      const pages = (pagesByChapter.get(chapterId) ?? []).sort((a, b) => a.pageNumber - b.pageNumber);
      const contiguous = pages.every(
        (page, offset) =>
          page.pageNumber === offset + 1 &&
          page.width === plan.pageSize.width &&
          page.height === plan.pageSize.height,
      );
      if (
        row !== undefined &&
        row.pageCount === chapter.pageCount &&
        pages.length === chapter.pageCount &&
        contiguous
      ) {
        chaptersVerified += 1;
        pagesVerified += pages.length;
      } else {
        geometryMismatches.push(
          `${entry.slug}#${chapter.number}: pages=${String(pages.length)} expected=${String(chapter.pageCount)}`,
        );
      }
    }
  }

  return {
    tables: {
      users: users.length,
      genre: genres.length,
      tag: tags.length,
      creator: creators.length,
      manga: mangaRows.length,
      manga_alias: aliasRows.length,
      chapter: chapterRows.length,
      chapter_page: pageRows.length,
    },
    mangaVerified,
    chaptersVerified,
    pagesVerified,
    unplannedTitles,
    geometryMismatches,
  };
}

/**
 * True when a slug belongs to the optional 10k-title load fixture (whose
 * numbers start where the ordinary titles stop).
 *
 * @param {string} slug
 * @param {SeedPlan} plan
 * @returns {boolean}
 */
function isLoadFixtureSlug(slug, plan) {
  if (plan.loadFixture.count === 0) return false;
  const bare = slug.startsWith(plan.keyPrefix) ? slug.slice(plan.keyPrefix.length) : slug;
  const match = /^seed-manga-(\d{5})$/.exec(bare);
  if (match === null || match[1] === undefined) return false;
  const index = Number(match[1]);
  return index >= plan.loadFixture.from && index < plan.loadFixture.from + plan.loadFixture.count;
}

/**
 * Renders the report. Every line is a function of the plan, the write counters
 * and the read-back — never of a clock, a hostname, a path or a random value, so
 * `diff` between two fresh runs is empty.
 *
 * @param {SeedReport} report
 * @returns {string}
 */
export function formatReport(report) {
  const lines = [
    `# yomi seed harness — phase one (placeholder asset keys, no media pipeline yet)`,
    `mode=${report.mode} run-id=${report.runId} key-prefix=${report.keyPrefix === '' ? '(none)' : report.keyPrefix}`,
    `pages=${String(report.pageSize.width)}x${String(report.pageSize.height)} synthetic=gradient-grayscale chunk=${String(report.chunkSize)}`,
  ];
  for (const user of report.users) {
    lines.push(`user ${user.email} role=${user.role}`);
  }
  for (const manga of report.manga) {
    lines.push(
      `manga ${manga.slug} title="${manga.title}" status=${manga.status} direction=${manga.direction} ` +
        `chapters=${String(manga.chapters)} pages=${String(manga.pages)} genres=${String(manga.genres)} ` +
        `tags=${String(manga.tags)} creators=${String(manga.creators)} aliases=${String(manga.aliases)}`,
    );
  }
  lines.push(
    `load-fixture titles=${String(report.loadFixture.count)}` +
      (report.loadFixture.count === 0
        ? ' (off; pass --load-titles 10000)'
        : ` first="${report.loadFixture.first}" last="${report.loadFixture.last}"`),
  );
  const totals = report.totals;
  lines.push(
    `totals manga=${String(totals.manga)} chapters=${String(totals.chapters)} pages=${String(totals.pages)} ` +
      `users=${String(totals.users)} genres=${String(totals.genres)} tags=${String(totals.tags)} creators=${String(totals.creators)}`,
  );
  const writes = report.writes;
  lines.push(
    `writes manga_created=${String(writes.manga.created)} links=${String(writes.manga.links)} ` +
      `chapters_created=${String(writes.chapters.created)} pages_written=${String(writes.pages.written)} ` +
      `users_created=${String(writes.users.created)} genres_created=${String(writes.vocabulary.genresCreated)} ` +
      `tags_created=${String(writes.vocabulary.tagsCreated)} creators_created=${String(writes.vocabulary.creatorsCreated)} ` +
      `load_titles_created=${String(writes.manga.loadTitlesCreated)} ids_reserved=${String(writes.ids.reserved)}`,
  );
  const verification = report.verification;
  lines.push(
    `verified manga=${String(verification.mangaVerified)}/${String(totals.manga)} ` +
      `chapters=${String(verification.chaptersVerified)} pages=${String(verification.pagesVerified)} ` +
      `rows=${Object.entries(verification.tables)
        .map(([table, count]) => `${table}:${String(count)}`)
        .join(' ')}`,
  );
  lines.push(
    `anomalies unplanned_titles=${String(verification.unplannedTitles.length)} geometry_mismatches=${String(verification.geometryMismatches.length)}`,
  );
  if (report.timings !== undefined) {
    for (const [phase, ms] of Object.entries(report.timings)) {
      lines.push(`timing ${phase}ms=${String(ms)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {SeedPlan} plan
 * @param {SeedWriteStats} writes
 * @param {SeedVerification} verification
 * @param {Record<string, number>|undefined} timings
 * @returns {SeedReport}
 */
function buildReport(plan, writes, verification, timings) {
  return {
    mode: plan.mode,
    runId: plan.runId,
    keyPrefix: plan.keyPrefix,
    pageSize: plan.pageSize,
    chunkSize: plan.chunkSize,
    users: plan.users.map((user) => ({ email: user.email, role: user.role })),
    manga: plan.manga.map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      status: entry.status,
      direction: entry.readingDirection,
      chapters: entry.chapters.length,
      pages: entry.chapters.reduce((n, chapter) => n + chapter.pageCount, 0),
      genres: entry.genreNames.length,
      tags: entry.tagNames.length,
      creators: entry.creators.length,
      aliases: entry.aliases.length,
    })),
    loadFixture: {
      count: plan.loadFixture.count,
      first: plan.loadFixture.titles[0] ?? '',
      last: plan.loadFixture.titles.at(-1) ?? '',
    },
    totals: {
      manga: plan.manga.length,
      chapters: plan.manga.reduce((n, entry) => n + entry.chapters.length, 0),
      pages: plan.totalPages,
      users: plan.users.length,
      genres: plan.vocabulary.genres.length,
      tags: plan.vocabulary.tags.length,
      creators: plan.vocabulary.creators.length,
    },
    writes,
    verification,
    ...(timings === undefined ? {} : { timings }),
  };
}

/**
 * Refuses to write into a database that has not been migrated. The harness does
 * not simply run the migrations itself: the
 * app role is DML-only, and a fixture loader that migrates would be a second,
 * unreviewed DDL path.
 *
 * @param {Db} db
 * @returns {Promise<void>}
 * @throws {MissingSchemaError}
 */
async function requireSchema(db) {
  try {
    await db.select({ slug: dbSchema.manga.slug }).from(dbSchema.manga).limit(1);
  } catch {
    throw new MissingSchemaError(
      'the `manga` table is not readable, so the schema has not been migrated. Run the ' +
        'migrations (`npm run db:migrate`) and try again — this harness ' +
        'never issues DDL.',
    );
  }
}

/**
 * A one-line description of an unexpected failure. A DSN is scrubbed out: the
 * driver's own message can carry it, so only the class of failure is reported.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '<dsn>')}`;
  }
  return String(error);
}

/**
 * Argon2id with the parameters `features/auth/password.ts` pins for the product
 * (m = 64 MiB, t = 3, p = 4). The seed does not choose its own: a fixture must
 * exercise the same KDF the login path verifies against, or "log in as the
 * seeded reader" would test a different hash than production.
 *
 * @param {string} password
 * @returns {Promise<string>} the encoded Argon2id hash
 */
async function hashSeedPassword(password) {
  // `argon2id` is the package's type CONSTANT (Argon2id = 2); `hash` is the
  // function. Argon2id, m = 64 MiB, t = 3, p = 4 — the pinned parameters.
  const { argon2id, hash } = await import('argon2');
  return hash(password, { type: argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 4 });
}

/**
 * Runs the harness end to end: guard → environment → database → render → write
 * → verify → report. Never throws: every refusal becomes an exit code and a
 * message on stderr, because a shell script must be able to trust the code.
 *
 * @param {RunSeedOptions} options
 * @returns {Promise<SeedRunResult>}
 */
export async function runSeed(options) {
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  /** @type {Record<string, number>} */
  const timings = {};
  const startedAt = Date.now();
  let db;

  try {
    const args = parseSeedArgs(options.argv);
    if (args.help) {
      stdout(USAGE);
      return { code: EXIT_OK, timings };
    }

    // The environment is read through the app's own loader and nowhere else.
    // Warnings go to stderr so stdout stays byte-comparable.
    const env = loadEnv(options.source, { onWarn: (message) => stderr(`${message}\n`) });
    const mode = assertSeedMode({ requested: args.mode, nodeEnv: env.nodeEnv });
    const passwords = readSeedPasswords(options.source);

    // Operational logging goes to stderr; stdout is the report and nothing else —
    // a CLI needs a data stream.
    const log = createLogger(env, {
      level: 'info',
      destination: /** @type {import('pino').DestinationStream} */ (process.stderr),
    });
    if (mode.mismatch) {
      log.warn(
        { seedMode: args.mode, nodeEnv: env.nodeEnv },
        'The --env mode and NODE_ENV differ; the mode flag decides and NODE_ENV is reported.',
      );
    }

    const plan = buildSeedPlan({
      mode: /** @type {SeedMode} */ (args.mode),
      runId: args.runId,
      mangaCount: args.mangaCount,
      loadTitles: args.loadTitles,
      pageSize: { width: args.pageWidth, height: args.pageHeight },
      chunkSize: args.chunkSize,
    });
    log.info(
      {
        mode: plan.mode,
        keyPrefix: plan.keyPrefix,
        manga: plan.manga.length,
        pages: plan.totalPages,
        pageSize: `${String(plan.pageSize.width)}x${String(plan.pageSize.height)}`,
      },
      'Seed plan computed.',
    );

    db = await createDb(env);
    await requireSchema(db);

    // The same storage the app reads from. `createObjectStorage` picks the
    // filesystem driver or S3/R2 from `env` exactly as it does at request time, so
    // a page seeded here is served by the route the reader already calls.
    // The injected `options.source`, not the ambient environment: the seed's whole
    // point is that a test can point it at a throwaway database and a local directory.
    const storage = await createObjectStorageAsync(env, options.source);
    /**
     * `AssetKey` is a branded string (shared/types/ids.ts) and `putStream` demands it,
     * so the boundary is stated here rather than assumed. Checked instead of cast,
     * because a key that is not shaped like one should fail here, not at the storage adapter.
     *
     * @param {string} value
     * @returns {import('../src/shared/types/ids').AssetKey}
     */
    const asAssetKey = (value) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*\.[a-z0-9]+$/.test(value)) {
        throw new Error(`seed: refusing to store a malformed asset key: ${value}`);
      }
      return /** @type {import('../src/shared/types/ids').AssetKey} */ (value);
    };
    /**
     * `putStream` takes a stream, and a Node `Buffer` is not one as far as its types are
     * concerned. Wrapping is the same three lines the media-delivery test uses, so the seed
     * and the suite agree on how a buffer becomes a stream.
     * @param {Buffer} bytes
     * @returns {ReadableStream<Uint8Array>}
     */
    const bytesToStream = (bytes) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

    /**
     * @param {{ assetKey: string, chapterId: string, width: number; height: number; slug: string; chapterNumber: string; pageNumber: number }} page
     * @param {{ avif: Buffer, webp: Buffer, jpeg: Buffer }} variants
     */
    const putPage = async (page, variants) => {
      // Two different key shapes, and conflating them is what makes a seeded page
      // undeliverable. The URL carries the OPAQUE key alone — one path segment, no
      // slashes, per the delivery grammar. The OBJECT lives at the physical layout
      // `pages/{chapterId}/{assetKey}.{ext}` that `pageObjectKey` builds server-side.
      /** @param {string} ext */
      const objectKey = (ext) =>
        asAssetKey(
          pageObjectPathFor({
            slug: page.slug,
            chapterNumber: page.chapterNumber,
            pageNumber: page.pageNumber,
            ext,
          }),
        );
      await storage.putStream(objectKey('avif'), bytesToStream(variants.avif), 'image/avif');
      await storage.putStream(objectKey('webp'), bytesToStream(variants.webp), 'image/webp');
      await storage.putStream(objectKey('jpeg'), bytesToStream(variants.jpeg), 'image/jpeg');
    };

    const renderStartedAt = Date.now();
    let rendered = 0;
    const materialised = await materialisePages(plan, {
      chunkSize: plan.chunkSize,
      putPage,
      onChunk: (done) => {
        rendered = done;
        log.debug({ rendered: done, totalPages: plan.totalPages }, 'Rendered synthetic pages.');
      },
    });
    timings['render'] = Date.now() - renderStartedAt;
    log.info(
      { pages: rendered, totalPages: plan.totalPages, renderMs: timings['render'], budgetMs: PAGE_SEED_BUDGET_MS },
      'Synthetic pages rendered and written to object storage (avif/webp/jpeg per page).',
    );
    if (timings['render'] > PAGE_SEED_BUDGET_MS) {
      log.warn(
        { renderMs: timings['render'], budgetMs: PAGE_SEED_BUDGET_MS, chunkSize: plan.chunkSize },
        'Page rendering exceeded the budget; re-run with a smaller --chunk-size.',
      );
    }

    // Covers are rendered and written here — NOT in `materialisePages`, which
    // is the page pipeline's chunk loop. One cover per plan title (WebP +
    // JPEG), each written inside the loop and released before the next render,
    // so peak memory stays one cover. The object path is the seed's own
    // `coverObjectPathFor`, mirrored by a test against the product `coverObjectKey`.
    const coverStartedAt = Date.now();
    let coversWritten = 0;
    for (const entry of materialised.manga) {
      const rendered = await renderSyntheticCover({ slug: entry.slug });
      await storage.putStream(
        asAssetKey(coverObjectPathFor({ slug: entry.slug, ext: 'webp' })),
        bytesToStream(rendered.webp),
        'image/webp',
      );
      await storage.putStream(
        asAssetKey(coverObjectPathFor({ slug: entry.slug, ext: 'jpeg' })),
        bytesToStream(rendered.jpeg),
        'image/jpeg',
      );
      coversWritten += 1;
    }
    timings['covers'] = Date.now() - coverStartedAt;
    log.info(
      { covers: coversWritten, coverMs: timings['covers'] },
      'Synthetic covers rendered and written to object storage (webp/jpeg per title).',
    );

    const writeStartedAt = Date.now();
    const repositories = createSeedRepositories(db);
    const writes = await writeSeedPlan(materialised, repositories, {
      passwordHashes: {
        admin: await hashSeedPassword(passwords.admin),
        reader: await hashSeedPassword(passwords.reader),
      },
    });
    timings['write'] = Date.now() - writeStartedAt;

    const verification = await verifySeed(db, plan);
    timings['total'] = Date.now() - startedAt;
    const report = formatReport(
      buildReport(plan, writes, verification, args.timings ? timings : undefined),
    );
    log.info({ timings }, 'Seed complete.');
    stdout(report);
    if (verification.unplannedTitles.length > 0 || verification.geometryMismatches.length > 0) {
      stderr(
        `seed: the read-back found rows the plan does not account for; ` +
          'see the anomalies line of the report.\n',
      );
      return { code: EXIT_FAILED, report, stats: writes, verification, timings };
    }
    return { code: EXIT_OK, report, stats: writes, verification, timings };
  } catch (error) {
    if (error instanceof SeedRefusal) {
      stderr(`seed: refused — ${error.message}\n`);
      return { code: EXIT_REFUSED, refusal: error, timings };
    }
    if (error instanceof MissingSchemaError) {
      stderr(`seed: ${error.message}\n`);
      return { code: EXIT_NO_SCHEMA, timings };
    }
    stderr(`seed: failed — ${describe(error)}\n`);
    return { code: EXIT_FAILED, timings };
  } finally {
    if (db !== undefined) {
      try {
        await db.close();
      } catch {
        // closing a pool must never mask the result of the run
      }
    }
  }
}

/**
 * True when this module is the process entry point (`tsx scripts/seed.mjs`),
 * false when a test imports it.
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const result = await runSeed({ argv: process.argv.slice(2), source: process.env });
  process.exitCode = result.code;
}
