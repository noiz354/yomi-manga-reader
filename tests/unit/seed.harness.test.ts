import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXIT_REFUSED,
  SeedRefusal,
  assertSeedMode,
  buildSeedPlan,
  coverAssetKey,
  coverObjectPathFor,
  deterministicUuid,
  materialisePages,
  pageAssetKey,
  chapterIdFor,
  parseSeedArgs,
  readSeedPasswords,
  writeSeedPlan,
} from '../../scripts/seed.mjs';
import type {
  SeedChapterSpec,
  SeedCreatorSpec,
  SeedMangaInput,
  SeedPageRecord,
  SeedRepositories,
  SeedUserInput,
} from '../../scripts/seed.mjs';

/* the explicit `--env dev|test` guard */

describe('the `--env dev|test` guard is explicit', () => {
  it('refuses when the flag is absent, naming the flag and the two modes', () => {
    const argv = parseSeedArgs([]);
    expect(argv.mode).toBeUndefined();
    expect(() => assertSeedMode({ requested: argv.mode, nodeEnv: 'development' })).toThrow(
      SeedRefusal,
    );
    try {
      assertSeedMode({ requested: undefined, nodeEnv: 'development' });
    } catch (error) {
      const refusal = error as SeedRefusal;
      expect(refusal.reason).toBe('mode-required');
      expect(refusal.message).toContain('--env');
      expect(refusal.message).toContain('dev');
      expect(refusal.message).toContain('test');
    }
  });

  it('accepts exactly `dev` and `test` and maps them onto NODE_ENV values', () => {
    expect(parseSeedArgs(['--env', 'dev']).mode).toBe('dev');
    expect(parseSeedArgs(['--env=dev']).mode).toBe('dev');
    expect(parseSeedArgs(['--env', 'test']).mode).toBe('test');
    expect(() => assertSeedMode({ requested: 'dev', nodeEnv: 'development' })).not.toThrow();
    expect(() => assertSeedMode({ requested: 'test', nodeEnv: 'test' })).not.toThrow();
  });

  it('refuses any other mode value instead of guessing one', () => {
    for (const bad of ['production', 'prod', 'qa', 'staging', 'DEVELOPMENT', '']) {
      expect(() => parseSeedArgs(['--env', bad]), bad).toThrow(SeedRefusal);
    }
  });

  it('uses a distinct non-zero exit code for a refusal', () => {
    // CI and the manual QA step key off the code, not the message text.
    expect(EXIT_REFUSED).toBe(2);
    expect(EXIT_REFUSED).not.toBe(0);
  });
});

/* the production refusal (the security control) */

describe('production is refused from both directions', () => {
  it('refuses `--env dev` when NODE_ENV=production (the flag cannot override it)', () => {
    // The security control: a seeded password comes from the environment, so
    // running this against a production DSN would write a KNOWN credential row
    // into a real database. `--env dev` must not buy a way past that.
    expect(() => assertSeedMode({ requested: 'dev', nodeEnv: 'production' })).toThrow(SeedRefusal);
    try {
      assertSeedMode({ requested: 'dev', nodeEnv: 'production' });
    } catch (error) {
      const refusal = error as SeedRefusal;
      expect(refusal.reason).toBe('production-node-env');
      expect(refusal.message).toContain('production');
      // redaction contract (NFR-OBS-006): the refusal names the VARIABLE and
      // the reason, never a value.
      expect(refusal.message).not.toMatch(/postgres:\/\//);
    }
  });

  it('refuses `--env test` when NODE_ENV=production as well', () => {
    try {
      assertSeedMode({ requested: 'test', nodeEnv: 'production' });
      expect.unreachable('a production NODE_ENV must never be seedable');
    } catch (error) {
      expect((error as SeedRefusal).reason).toBe('production-node-env');
    }
  });

  it('refuses an explicit `production` mode even when NODE_ENV says otherwise', () => {
    // Belt and braces: parseSeedArgs already refuses the literal, and the
    // assertion below re-proves the guard rather than trusting the parser.
    expect(() => parseSeedArgs(['--env', 'production'])).toThrow(SeedRefusal);
    try {
      assertSeedMode({ requested: 'production', nodeEnv: 'test' });
      expect.unreachable('mode=production must never be accepted');
    } catch (error) {
      expect((error as SeedRefusal).reason).toBe('production-mode');
    }
  });

  it('tolerates a dev/test NODE_ENV mismatch but reports it (no silent guess)', () => {
    expect(() => assertSeedMode({ requested: 'test', nodeEnv: 'development' })).not.toThrow();
    expect(() => assertSeedMode({ requested: 'dev', nodeEnv: 'test' })).not.toThrow();
  });
});

describe('seeded passwords are env-injected only', () => {
  const SENTINEL = 'unit-only-sentinel-4f2a';

  it('refuses to run when no seed password is present in the environment', () => {
    expect(() => readSeedPasswords({})).toThrow(SeedRefusal);
    // no fallback, no generated value: there is nothing to fall back TO.
    try {
      readSeedPasswords({ SEED_ADMIN_PASSWORD: '   ' });
      expect.unreachable('a blank value is not a value');
    } catch (error) {
      expect((error as SeedRefusal).reason).toBe('password-missing');
    }
  });

  it('takes the two account passwords verbatim from the environment', () => {
    const passwords = readSeedPasswords({
      SEED_ADMIN_PASSWORD: SENTINEL,
      SEED_READER_PASSWORD: `${SENTINEL}-reader`,
    });
    expect(passwords.admin).toBe(SENTINEL);
    expect(passwords.reader).toBe(`${SENTINEL}-reader`);
  });

  it('accepts one shared SEED_PASSWORD for both accounts', () => {
    const passwords = readSeedPasswords({ SEED_PASSWORD: SENTINEL });
    expect(passwords.admin).toBe(SENTINEL);
    expect(passwords.reader).toBe(SENTINEL);
  });

  it('contains no hardcoded password literal anywhere in the harness', () => {
    // The security-critical assertion of this file.
    // Three independent shapes of the same property, because one heuristic is
    // never enough for "there is no credential in this repository":
    //  1. no pass-shaped identifier is ever assigned a quoted literal;
    //  2. no literal is one of the common weak passwords a seed is most likely
    //     to grow into;
    //  3. `process.env` is touched exactly once — the CLI handoff into
    //     `runSeed({ source })`. Everywhere else the environment is read through
    //     `loadEnv`, which is what makes the credential path
    //     auditable at all.
    const source = readFileSync(
      fileURLToPath(new URL('../../scripts/seed.mjs', import.meta.url)),
      'utf8',
    );
    // 1.
    expect(source).not.toMatch(
      /\b[A-Za-z_$][\w$]*(?:pass|passwd|password|secret|token)\w*\s*[:=]\s*['"`]/i,
    );
    // 2.
    for (const weak of COMMON_WEAK_PASSWORDS) {
      expect(source.toLowerCase(), `weak password literal: ${weak}`).not.toContain(weak);
    }
    // 3.
    const envReads = [...source.matchAll(/process\.env/g)];
    expect(envReads.length, 'the harness reads process.env exactly once, for the CLI handoff').toBe(1);
    // …and the environment path is actually wired, not merely absent.
    expect(source).toContain('SEED_ADMIN_PASSWORD');
    expect(source).toContain('SEED_READER_PASSWORD');
    expect(source).toContain("source['SEED_ADMIN_PASSWORD']");
  });
});

describe('the seeded plan is deterministic', () => {
  it('is byte-identical across two calls with the same options', () => {
    const a = buildSeedPlan({ mode: 'dev', runId: 'local', mangaCount: 3 });
    const b = buildSeedPlan({ mode: 'dev', runId: 'local', mangaCount: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('numbers titles deterministically ("Seed Manga 0001"…)', () => {
    const plan = buildSeedPlan({ mode: 'dev', runId: 'local', mangaCount: 2 });
    expect(plan.manga.map((m) => m.title)).toEqual([
      'Seed Manga 0001',
      'Seed Manga 0002',
      'Seed Manga 0030-Pages',
      'Seed Manga 0500-Pages',
    ]);
    expect(plan.manga.slice(0, 2).map((m) => m.slug)).toEqual(['seed-manga-0001', 'seed-manga-0002']);
  });

  it('carries genres, creators, tags and aliases on every title', () => {
    const plan = buildSeedPlan({ mode: 'dev', runId: 'local', mangaCount: 2 });
    for (const manga of plan.manga) {
      expect(manga.genreNames.length).toBeGreaterThan(0);
      expect(manga.tagNames.length).toBeGreaterThan(0);
      expect(manga.creators.length).toBeGreaterThan(0);
      expect(manga.aliases.length).toBeGreaterThan(0);
      expect(manga.chapters.length).toBeGreaterThan(0);
    }
    // creator roles are the two the model allows (DATA_MODEL §8)
    const roles = new Set(plan.manga.flatMap((m) => m.creators.map((c) => c.role)));
    expect([...roles].sort()).toEqual(['artist', 'author']);
  });

  it('always contains the 30-page and the 500-page performance fixtures', () => {
    // The 500-page chapter is the product's defining performance case; the
    // reader e2e needs a 30-page one.
    const plan = buildSeedPlan({ mode: 'dev', runId: 'local' });
    const pages = plan.manga.flatMap((m) => m.chapters.map((c) => c.pageCount));
    expect(pages).toContain(30);
    expect(pages).toContain(500);
    const marathon = plan.manga.find((m) => m.slug === 'seed-manga-0500-pages');
    expect(marathon?.chapters[0]?.pageCount).toBe(500);
    expect(marathon?.chapters[0]?.published).toBe(true);
    expect(plan.manga.find((m) => m.slug === 'seed-manga-0030-pages')?.chapters[0]?.pageCount).toBe(30);
  });

  it('leaves an unpublished chapter in the plan (FR-CHAPTER-002 draft visibility)', () => {
    const plan = buildSeedPlan({ mode: 'dev', runId: 'local', mangaCount: 2 });
    const drafts = plan.manga
      .flatMap((m) => m.chapters)
      .filter((c) => !c.published);
    expect(drafts.length).toBeGreaterThan(0);
  });

  it('key-prefixes every public identity in test mode and not in dev', () => {
    const dev = buildSeedPlan({ mode: 'dev', runId: 'local' });
    const test = buildSeedPlan({ mode: 'test', runId: 'ci-7' });
    expect(dev.keyPrefix).toBe('');
    expect(test.keyPrefix).toBe('tci-7-');
    expect(test.manga.every((m) => m.slug.startsWith('tci-7-'))).toBe(true);
    expect(test.users.every((u) => u.email.startsWith('tci-7-'))).toBe(true);
  });

  it('mints the 10k-title load fixture only behind the flag', () => {
    expect(buildSeedPlan({ mode: 'test', runId: 'ci-7' }).loadFixture.count).toBe(0);
    const loaded = buildSeedPlan({ mode: 'test', runId: 'ci-7', loadTitles: 10_000 });
    expect(loaded.loadFixture.count).toBe(10_000);
    expect(loaded.loadFixture.titles[0]).toBe('Seed Manga 10001');
    expect(loaded.loadFixture.titles.at(-1)).toBe('Seed Manga 20000');
  });

  it('derives page asset keys that are deterministic and unguessable (FR-MEDIA-003)', () => {
    const a = pageAssetKey({ slug: 'seed-manga-0001', chapterNumber: '1.00', pageNumber: 1 });
    const b = pageAssetKey({ slug: 'seed-manga-0001', chapterNumber: '1.00', pageNumber: 1 });
    const c = pageAssetKey({ slug: 'seed-manga-0001', chapterNumber: '1.00', pageNumber: 2 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // a key is an opaque handle, never a path and never guessable from the ids
    expect(a).not.toContain('seed-manga-0001');
  });

  it('mints page asset keys the delivery grammar actually accepts', () => {
    // The grammar the media route applies to the URL path, copied from
    // DELIVERY_KEY_PATTERN in src/server/media/page-delivery.ts. A seed key that fails
    // it 404s at parse time, before storage is ever consulted — which is exactly what
    // the old `seed/v1/<digest>` keys did.
    const DELIVERY_KEY_PATTERN = /^([A-Za-z0-9_-]{22,64})\.(avif|webp|jpeg)$/;

    for (const pageNumber of [1, 2, 500]) {
      const key = pageAssetKey({ slug: 'seed-manga-0001', chapterNumber: '1.00', pageNumber });
      expect(`${key}.jpeg`).toMatch(DELIVERY_KEY_PATTERN);
      // The slug is not recoverable from the key.
      expect(key).not.toContain('seed-manga');
      // No path separators: the key is one URL segment, the chapter directory is the
      // server's business (`pages/{chapterId}/{assetKey}.{ext}`), not the key's.
      expect(key).not.toContain('/');
    }
  });

  it('derives the chapter row id the same way the writer will', () => {
    // Pages are rendered before the chapter rows exist, so the physical object path
    // depends on this derivation agreeing with the writer's. If the two drift, objects
    // land under a directory no reader will ever ask for.
    const slug = 'seed-manga-0001';
    expect(chapterIdFor({ slug, chapterNumber: '1.00' })).toBe(
      deterministicUuid('chapter', `${deterministicUuid('manga', slug)}#1.00`),
    );
  });

  it('derives primary keys that are stable, v7-shaped and accepted by PostgreSQL', () => {
    const a = deterministicUuid('manga', 'seed-manga-0001');
    expect(deterministicUuid('manga', 'seed-manga-0001')).toBe(a);
    // two tables never share an id for the same key
    expect(deterministicUuid('chapter', 'seed-manga-0001')).not.toBe(a);
    // 8-4-4-4-12 hex, version 7, variant 10xx: the shape DATA_MODEL line 6 and
    // the schema's `uuid` column both require (an int-DB test caught a short id)
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(a).toHaveLength(36);
  });
});

describe('writing the same plan twice is a no-op', () => {
  /** A deterministic stand-in for the in-memory synthetic page renderer. */
  const fakeRender = (spec: { width: number; height: number; pageNumber: number }) => ({
    width: spec.width,
    height: spec.height,
    byteSizeAvif: 1_000 + spec.pageNumber,
    byteSizeWebp: 2_000 + spec.pageNumber,
    byteSizeJpeg: 3_000 + spec.pageNumber,
    digest: `d${spec.pageNumber}`,
  });

  it('materialises contiguous 1..N pages per chapter, in chunks', async () => {
    const plan = buildSeedPlan({ mode: 'dev', runId: 'local', mangaCount: 1 });
    const progress: number[] = [];
    const materialised = await materialisePages(plan, {
      render: fakeRender,
      chunkSize: 4,
      onChunk: (done) => progress.push(done),
    });
    for (const manga of materialised.manga) {
      for (const chapter of manga.chapters) {
        assertContiguous(chapter);
        expect(chapter.pages).toHaveLength(chapter.pageCount);
      }
    }
    const total = plan.manga.flatMap((m) => m.chapters).reduce((n, c) => n + c.pageCount, 0);
    expect(progress.at(-1)).toBe(total);
    expect(progress.length).toBeGreaterThan(1);
    // monotonically increasing: the chunking is observable, not decorative
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('leaves the state identical and writes nothing the second time', async () => {
    const plan = await materialisePages(
      buildSeedPlan({ mode: 'dev', runId: 'local', mangaCount: 2 }),
      { render: fakeRender, chunkSize: 16 },
    );
    const repositories = memoryRepositories();

    const first = await writeSeedPlan(plan, repositories, {
      passwordHashes: { admin: 'hash-a', reader: 'hash-b' },
    });
    const snapshot = JSON.stringify(repositories.dump());
    const second = await writeSeedPlan(plan, repositories, {
      passwordHashes: { admin: 'hash-a', reader: 'hash-b' },
    });

    expect(JSON.stringify(repositories.dump())).toBe(snapshot);
    expect(first.manga.created).toBeGreaterThan(0);
    expect(first.chapters.created).toBeGreaterThan(0);
    expect(first.pages.written).toBeGreaterThan(0);
    expect(second).toEqual(zeroedWrites(first));
  });

  it('never rotates an existing password hash (a salted hash is not reproducible)', async () => {
    const repositories = memoryRepositories();
    const plan = buildSeedPlan({ mode: 'dev', runId: 'local', mangaCount: 1 });
    await writeSeedPlan(plan, repositories, { passwordHashes: { admin: 'hash-a', reader: 'hash-b' } });
    const after = repositories.dump();
    // A second run with a DIFFERENT value must not rewrite the stored hash:
    // Argon2 salts are random, so a re-hash would make the fixture
    // non-deterministic and would silently invalidate a running session.
    await writeSeedPlan(plan, repositories, {
      passwordHashes: { admin: 'hash-rotated', reader: 'hash-rotated' },
    });
    expect(repositories.dump().users).toEqual(after.users);
  });

  it('seeds exactly one admin and one reader through the port create', async () => {
    const repositories = memoryRepositories();
    const plan = buildSeedPlan({ mode: 'dev', runId: 'local', mangaCount: 1 });
    await writeSeedPlan(plan, repositories, { passwordHashes: { admin: 'hash-a', reader: 'hash-b' } });
    const roles = repositories.dump().users.map((user) => `${user.email}:${user.role}`);
    expect(roles).toEqual(['seed-admin@seed.invalid:admin', 'seed-reader@seed.invalid:reader']);
    // the credential the plan supplied is the credential that is stored
    expect(repositories.dump().users.map((user) => user.passwordHash)).toEqual([
      'hash-a',
      'hash-b',
    ]);
  });

  it('keeps the plan free of product content', () => {
    const plan = buildSeedPlan({ mode: 'dev', runId: 'local', loadTitles: 100 });
    const serialised = JSON.stringify(plan);
    // every title is the numbered fixture name; nothing is a real title
    for (const manga of plan.manga) expect(manga.title).toMatch(/^Seed Manga \d{4}(-\w+)?$/);
    for (const title of plan.loadFixture.titles) expect(title).toMatch(/^Seed Manga \d{5}$/);
    expect(serialised).toMatch(/synthetic/i);
    expect(serialised).not.toMatch(/\.jpe?g|\.png|\.webp|\.zip|\.cbz/i);
  });
});

/** Asserts the DATA_MODEL §21.2 invariant: pages are exactly 1..N ascending. */
function assertContiguous(chapter: SeedChapterSpec): void {
  const numbers = chapter.pages.map((page) => page.pageNumber);
  expect(numbers).toEqual(Array.from({ length: chapter.pageCount }, (_, i) => i + 1));
  expect(new Set(chapter.pages.map((page) => page.assetKey)).size).toBe(chapter.pageCount);
}

/** Every write counter of `stats`, set to zero (what a re-run must report). */
function zeroedWrites(stats: Awaited<ReturnType<typeof writeSeedPlan>>): Awaited<
  ReturnType<typeof writeSeedPlan>
> {
  return {
    vocabulary: { genresCreated: 0, tagsCreated: 0, creatorsCreated: 0 },
    users: { created: 0 },
    manga: { created: 0, links: 0, loadTitlesCreated: 0 },
    chapters: { created: 0 },
    pages: { written: 0 },
    ids: { reserved: stats.ids.reserved },
  };
}

/** The state the in-memory double keeps, as one serialisable snapshot. */
interface MemoryState {
  readonly users: ReadonlyArray<{
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    role: string;
  }>;
  readonly manga: ReadonlyArray<Record<string, unknown>>;
  readonly chapters: ReadonlyArray<Record<string, unknown>>;
  readonly pages: ReadonlyArray<readonly [string, SeedPageRecord[]]>;
}

/** An in-memory stand-in for the Drizzle repositories (no database in §1 unit). */
function memoryRepositories(): SeedRepositories & { dump(): MemoryState } {
  const state = {
    users: [] as Array<{
      id: string;
      email: string;
      displayName: string;
      passwordHash: string;
      role: string;
    }>,
    genres: new Map<string, string>(),
    tags: new Map<string, string>(),
    creators: new Map<string, string>(),
    manga: new Map<string, Record<string, unknown>>(),
    chapters: new Map<string, Record<string, unknown>>(),
    pages: new Map<string, SeedPageRecord[]>(),
  };
  let next = 0;
  const id = (): string => `id-${(next += 1)}`;
  const stats = {
    vocabulary: { genresCreated: 0, tagsCreated: 0, creatorsCreated: 0 },
    users: { created: 0 },
    manga: { created: 0, links: 0, loadTitlesCreated: 0 },
    chapters: { created: 0 },
    pages: { written: 0 },
    ids: { reserved: 0 },
  };
  const ensure = (
    table: Map<string, string>,
    name: string,
    counter: 'genresCreated' | 'tagsCreated' | 'creatorsCreated',
  ): string => {
    const existing = table.get(name);
    if (existing !== undefined) return existing;
    table.set(name, id());
    stats.vocabulary[counter] += 1;
    return table.get(name) as string;
  };
  return {
    users: {
      async create(input: SeedUserInput): Promise<string> {
        const found = state.users.find((user) => user.email === input.email);
        if (found !== undefined) return found.id;
        const created = { id: id(), ...input };
        state.users.push(created);
        stats.users.created += 1;
        return created.id;
      },
    },
    manga: {
      ensureGenres: async (names: readonly string[]) =>
        new Map(names.map((name) => [name, ensure(state.genres, name, 'genresCreated')])),
      ensureTags: async (names: readonly string[]) =>
        new Map(names.map((name) => [name, ensure(state.tags, name, 'tagsCreated')])),
      ensureCreators: async (specs: readonly SeedCreatorSpec[]) =>
        new Map(specs.map((spec) => [spec.name, ensure(state.creators, spec.name, 'creatorsCreated')])),
      async create(input: SeedMangaInput): Promise<string> {
        const found = state.manga.get(input.slug);
        if (found !== undefined) return String(found['id']);
        const created = { id: id(), ...input };
        state.manga.set(input.slug, created);
        stats.manga.created += 1;
        stats.manga.links +=
          input.aliases.length + input.genreIds.length + input.tagIds.length + input.creators.length;
        return String(created['id']);
      },
      async createLoadTitles(
        titles: readonly { title: string; slug: string; genreId: string; tagId: string; alias: string }[],
      ): Promise<number> {
        let created = 0;
        for (const { title, slug } of titles) {
          if (state.manga.has(slug)) continue;
          state.manga.set(slug, { id: id(), title, slug, load: true });
          created += 1;
        }
        stats.manga.loadTitlesCreated += created;
        return created;
      },
    },
    chapters: {
      async commitChapter(input: {
        mangaId: string;
        number: string;
        pages: readonly SeedPageRecord[];
      }): Promise<{ chapterId: string; created: boolean; pagesWritten: number }> {
        const key = `${input.mangaId}#${input.number}`;
        const found = [...state.chapters.values()].find((chapter) => chapter['key'] === key);
        const chapterId = found === undefined ? id() : String(found['id']);
        if (found !== undefined) {
          // the chapter exists, so its pages do: re-inserting the identical set
          // conflicts on the primary key and writes nothing
          return { chapterId, created: false, pagesWritten: 0 };
        }
        state.chapters.set(chapterId, { id: chapterId, key, pageCount: input.pages.length });
        state.pages.set(chapterId, [...input.pages]);
        stats.chapters.created += 1;
        stats.pages.written += input.pages.length;
        return { chapterId, created: true, pagesWritten: input.pages.length };
      },
    },
    stats: () => structuredClone(stats),
    dump: (): MemoryState => ({
      users: state.users,
      manga: [...state.manga.values()],
      chapters: [...state.chapters.values()],
      pages: [...state.pages.entries()],
    }),
  };
}

/**
 * The weak passwords a fixture harness is most likely to grow into. Probed as
 * plain substrings (lower-cased) because the assertion is about the repository
 * carrying no credential at all, not about where it would sit.
 */
const COMMON_WEAK_PASSWORDS = [
  'letmein',
  'changeme',
  'qwerty',
  'password1',
  'admin123',
  'hunter2',
  'iloveyou',
  'secret123',
  '12345678',
  'yomi-seed',
  'seed-password',
  'dev-password',
] as const;

describe('cover asset keys are grammar-valid base keys', () => {
  // The grammar the media route applies to the URL path, copied from
  // DELIVERY_KEY_PATTERN in src/server/media/page-delivery.ts — the same
  // independent source the page-key suite (above) pins itself to.
  const DELIVERY_KEY_PATTERN = /^([A-Za-z0-9_-]{22,64})\.(avif|webp|jpeg)$/;

  it('derives cover asset keys that are deterministic and unguessable (FR-MEDIA-003)', () => {
    const a = coverAssetKey({ slug: 'seed-manga-0001' });
    const b = coverAssetKey({ slug: 'seed-manga-0001' });
    const c = coverAssetKey({ slug: 'seed-manga-0002' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('seed-manga-0001');
  });

  it('mints cover asset keys the delivery grammar actually accepts', () => {
    // The old `seed/v1/cover/<digest>` shape carried slashes and no
    // extension, so `parseDeliveryKey` returned null and every cover 404'd
    // before storage was ever consulted. A cover key must be one URL
    // segment; the manga directory is the server's business
    // (`covers/{mangaId}.{ext}`), not the key's.
    const key = coverAssetKey({ slug: 'seed-manga-0001' });
    expect(`${key}.jpeg`).toMatch(DELIVERY_KEY_PATTERN);
    expect(`${key}.webp`).toMatch(DELIVERY_KEY_PATTERN);
    expect(key).not.toContain('/');
  });

  it('derives the cover object path the delivery layer resolves', () => {
    // Mirrors the product helper rather than rebuilding it: importing
    // `coverObjectKey` here would make this suite assert the product code
    // against itself, so the agreement is asserted in
    // tests/integration/media-seed-delivery.test.ts, which runs the seed's
    // own function and then asks the delivery path for the key it produced.
    const mangaId = deterministicUuid('manga', 'seed-manga-0001');
    expect(coverObjectPathFor({ slug: 'seed-manga-0001', ext: 'jpeg' })).toBe(
      `covers/${mangaId}.jpeg`,
    );
    expect(coverObjectPathFor({ slug: 'seed-manga-0001', ext: 'webp' })).toBe(
      `covers/${mangaId}.webp`,
    );
  });
});