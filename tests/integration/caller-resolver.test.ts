/**
 * The `/api/v1` caller resolver, and the button it protects.
 *
 * Every catalog test injects `resolveCaller: async () => null`; because a
 * function that ignores its parameters satisfies the seam's type, those tests
 * never exercise the path a real request takes, and `continueReading` was
 * silently omitted. This file drives the real handler with the PRODUCTION
 * resolver instead.
 *
 * Needs DATABASE_URL. Skips cleanly without it, like every other DB test here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerApiV1Deps } from '../../src/app/api/v1/_deps';
import { resolveCaller } from '../../src/app/api/v1/_runtime';
import { createMangaDetailHandler } from '../../src/app/api/v1/manga/[slug]/route';
import { createCatalogService } from '../../src/features/catalog';
import { createResumeService } from '../../src/features/progress';
import { createProgressPositionReader } from '../../src/server/db/repositories/progress.repository';
import { createMangaRepository } from '../../src/server/db/repositories/manga.repository';
import { createChapterRepository } from '../../src/server/db/repositories/chapter.repository';
import { createGenreTagVocabularyPort } from '../../src/server/db/repositories/vocabulary.repository';
import { toCallerContext } from '../../src/server/auth/guard';
import { sessions, users, readingProgress, chapter, manga } from '../../src/server/db/schema';
import {
  openCatalogDatabase,
  mangaIdFor,
  createPgCatalogHarness,
  silentLogger,
} from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import type { ApiV1Deps } from '../../src/app/api/v1/_deps';
import type { OpenDatabase, PgCatalogHarness } from './support/pg-catalog-ports';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const DB_NAME = 'caller_resolver_it';
const SLUG = 'caller_resolver_it';
const MANGA_ID = mangaIdFor('caller_resolver_it');
const CHAPTER_ID = '0198c0f0-0000-7000-8000-000000000f01';
const USER_ID = '0198c0f0-0000-7000-8000-000000000f02';
const ADMIN_ID = '0198c0f0-0000-7000-8000-000000000f03';
const PLAIN_ID = '0198c0f0-0000-7000-8000-000000000f04';
const SUSPENDED_ID = '0198c0f0-0000-7000-8000-000000000f05';
const PAGE_COUNT = 20;

const token = (name: string): string => `caller-resolver-it-${name}-0000000000000000`;
const sessionId = (n: number): string => `0198c0f0-0000-7000-8000-000000000f1${n}`;

describeDb('the /api/v1 caller resolver', () => {
  let open: OpenDatabase;
  let harness: PgCatalogHarness;
  let service: ReturnType<typeof createCatalogService>;
  let savedDatabaseUrl: string | undefined;

  const cookie = (value: string): string => `session_token=${value}`;

  const request = (init: RequestInit = {}): Request =>
    new Request(`http://yomi.test/api/v1/manga/${SLUG}`, init);

  /**
   * Drive the real handler with the PRODUCTION resolver.
   *
   * `registerApiV1Deps` is the seam's own test hook, so the service graph is the
   * throwaway database's harness while the resolver is the shipping one. That
   * split is the point: varying the service but hard-coding the resolver is
   * exactly the axis on which the defect lives.
   */
  const call = async (init: RequestInit = {}): Promise<Response> => {
    const deps: ApiV1Deps = {
      catalog: service,
      chapters: harness.chapters as unknown as ApiV1Deps['chapters'],
      // Not under test here (see the same comment in the catalog suites): the
      // search service rides this seam, so the literal needs the member.
      search: { search: async () => ({ items: [], nextCursor: null }) },
      resolveCaller,
      logger: silentLogger(),
    };
    // Registered as well as passed, so the registry path a real request takes is
    // exercised too rather than only the factory argument.
    registerApiV1Deps(deps);
    return createMangaDetailHandler(deps)(request(init), {
      params: Promise.resolve({ slug: SLUG }),
    });
  };

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, DB_NAME);
    harness = await createPgCatalogHarness(open);

    // The service is built HERE, with the resume wiring, rather than taken from
    // `harness.service`. The shared harness injects
    // `progress: { latestForManga: async () => null }` — a stub with no
    // `resolveResume`, so `resumeRulesOf` returns null and the service omits
    // `continueReading` for everyone. That is a second, independent reason this
    // defect survived: even a test that supplied a perfect caller would have
    // found the field missing and blamed the wrong layer. The composition root
    // wires `createResumeService({ reads: createProgressPositionReader(db) })`;
    // this mirrors it exactly, so the service under test is the shipping one.
    service = createCatalogService({
      manga: createMangaRepository(open.db),
      chapters: createChapterRepository(open.db),
      progress: createResumeService({ reads: createProgressPositionReader(open.db) }),
      vocabulary: createGenreTagVocabularyPort(open.db),
    });
    // The production resolver reaches the session through `loadEnv()` — i.e.
    // `process.env` — and the guard shares the process-wide pool. So the
    // environment must name the THROWAWAY database, not the base one this test
    // started from.
    //
    // It must name it by PATH: `openCatalogDatabase` creates a database literally
    // called `caller_resolver_it`, at `/${name}`. A first version of this test
    // left `process.env.DATABASE_URL` pointing at the BASE url, and the effect was
    // a genuinely nasty class of quiet failure — the resolver read a database
    // with no sessions in it, so it answered `null` to everything. Every negative
    // test in this file then passed, and so did the parity test below, because
    // `null === null` is true. Only the positive assertion caught it, and it
    // looked like a defect in the service rather than in the test.
    const throwaway = new URL(DATABASE_URL as string);
    throwaway.pathname = `/${DB_NAME}`;
    for (const [key, value] of Object.entries(envSource(throwaway.toString()))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    savedDatabaseUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = throwaway.toString();

    const far = new Date('2099-01-01T00:00:00.000Z');
    const past = new Date('2020-01-01T00:00:00.000Z');

    await open.db.insert(users).values([
      {
        id: USER_ID,
        email: 'caller-resolver-reader@invalid',
        displayName: 'reader',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'reader',
        status: 'active',
      },
      {
        id: ADMIN_ID,
        email: 'caller-resolver-admin@invalid',
        displayName: 'admin',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'admin',
        status: 'active',
      },
      // A second reader with NO progress row. A valid session and nothing to
      // continue is a different answer from an anonymous request, and conflating
      // the two would mean inventing a position for someone who has none.
      {
        id: PLAIN_ID,
        email: 'caller-resolver-plain@invalid',
        displayName: 'plain',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'reader',
        status: 'active',
      },
      // Status is not the role, and a non-active account must not act. The
      // `users_status` CHECK permits only ('active', 'disabled') — the first
      // version of this fixture used 'suspended' and PostgreSQL refused the
      // INSERT, which is the CHECK doing its job one level above this code.
      {
        id: SUSPENDED_ID,
        email: 'caller-resolver-disabled@invalid',
        displayName: 'disabled',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'reader',
        status: 'disabled',
      },
    ]);

    await open.db.insert(sessions).values([
      {
        id: sessionId(1),
        userId: USER_ID,
        sessionToken: token('reader'),
        expiresAt: far,
        absoluteExpiresAt: far,
        lastSeenAt: null,
        userAgent: null,
        ip: null,
      },
      {
        id: sessionId(2),
        userId: ADMIN_ID,
        sessionToken: token('admin'),
        expiresAt: far,
        absoluteExpiresAt: far,
        lastSeenAt: null,
        userAgent: null,
        ip: null,
      },
      {
        id: sessionId(3),
        userId: PLAIN_ID,
        sessionToken: token('plain'),
        expiresAt: far,
        absoluteExpiresAt: far,
        lastSeenAt: null,
        userAgent: null,
        ip: null,
      },
      {
        id: sessionId(4),
        userId: SUSPENDED_ID,
        sessionToken: token('disabled'),
        expiresAt: far,
        absoluteExpiresAt: far,
        lastSeenAt: null,
        userAgent: null,
        ip: null,
      },
      // Idle expiry only: `expiresAt` in the past is enough, `absoluteExpiresAt`
      // is not, and the guard checks both independently.
      {
        id: sessionId(5),
        userId: USER_ID,
        sessionToken: token('idle'),
        expiresAt: past,
        absoluteExpiresAt: far,
        lastSeenAt: null,
        userAgent: null,
        ip: null,
      },
      // Absolute expiry only: `expiresAt` is fine, `absoluteExpiresAt` is not.
      {
        id: sessionId(6),
        userId: USER_ID,
        sessionToken: token('absolute'),
        expiresAt: far,
        absoluteExpiresAt: past,
        lastSeenAt: null,
        userAgent: null,
        ip: null,
      },
    ]);

    await open.db.insert(manga).values({
      id: MANGA_ID,
      slug: SLUG,
      title: 'Caller Resolver',
      published: true,
      status: 'ongoing',
      readingDirection: 'ltr',
    });
    await open.db.insert(chapter).values({
      id: CHAPTER_ID,
      mangaId: MANGA_ID,
      number: '7',
      status: 'published',
      publishedAt: new Date('2026-04-01T00:00:00.000Z'),
      pageCount: PAGE_COUNT,
      readingOrder: 1,
    });
    await open.db.insert(readingProgress).values({
      userId: USER_ID,
      chapterId: CHAPTER_ID,
      pageNumber: 12,
      completed: false,
    });
  });

  afterAll(async () => {
    if (savedDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = savedDatabaseUrl;
    await open?.close();
  });

  describe('continueReading, which was unreachable for every signed-in reader', () => {
    it('carries the position for a signed-in reader, and OMITS it for anonymous', async () => {
      const authed = (await (
        await call({ headers: { cookie: cookie(token('reader')) } })
      ).json()) as {
        continueReading?: unknown;
      };
      const anon = (await (await call()).json()) as { continueReading?: unknown };

      // Absent, not null — "you have not started" and "you are anonymous" are
      // the same wire answer, and the page renders one state for both.
      expect(authed['continueReading']).toEqual({
        chapterId: CHAPTER_ID,
        chapterNumber: 7,
        pageNumber: 12,
      });
      expect(Object.keys(anon)).not.toContain('continueReading');
    });

    it('omits it for a reader who has not started, and still answers 200', async () => {
      // A valid session and no progress row. The field is ABSENT, not null and
      // not a position: a 200 with the field present would be inventing a place
      // to send a reader who has not been anywhere.
      const response = await call({ headers: { cookie: cookie(token('plain')) } });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(Object.keys(body)).not.toContain('continueReading');
    });
  });

  describe('toCallerContext, the single narrowing rule', () => {
    const user = (role: string, status = 'active') => ({
      id: USER_ID,
      email: 'x@invalid',
      role,
      status,
    });

    it('grants the two roles the services accept', () => {
      expect(toCallerContext(user('reader'))).toEqual({ userId: USER_ID, role: 'reader' });
      expect(toCallerContext(user('admin'))).toEqual({ userId: USER_ID, role: 'admin' });
    });

    it('refuses a role it does not recognise instead of guessing', () => {
      // The `users_role` CHECK already refuses these at INSERT time — a first
      // version of this file tried to seed a `superuser` and PostgreSQL rejected
      // it. So the CHECK is the first line of defence and this is the second, and
      // the second is not redundant: a CHECK constrains writes through THIS
      // database, and a row restored from a dump, a migration or a replication
      // peer is not a write this database saw. Guessing a role here would widen
      // authority on the way in, so an unrecognised one is anonymous.
      expect(toCallerContext(user('superuser'))).toBeNull();
      expect(toCallerContext(user('ADMIN'))).toBeNull();
      expect(toCallerContext(user(''))).toBeNull();
    });

    it('refuses no session at all', () => {
      expect(toCallerContext(null)).toBeNull();
    });

    it('grants the same authority from the same cookie in both seams', async () => {
      const { resolveCaller: membersResolver } = await import('../../src/app/api/_runtime');
      const authed = new Request('http://yomi.test/x', {
        headers: { cookie: cookie(token('admin')) },
      });

      // Both asserted NON-NULL first, deliberately. A parity test that only
      // checked the two resolvers agreed would pass vacuously when both answer
      // `null` — and they both would, if the environment pointed at the wrong
      // database. A parity test that cannot fail on "both broken" is not a
      // parity test.
      expect(await resolveCaller(authed)).toEqual({
        userId: ADMIN_ID,
        role: 'admin',
      });
      // Both seams delegate to `resolveCallerContext`. If one grows its own
      // narrowing back, they would quietly grant different authority from the
      // same cookie.
      expect(await membersResolver(authed)).toEqual(await resolveCaller(authed));
    });
  });

  describe('sessions that must not produce a caller', () => {
    it('refuses an unknown token', async () => {
      const caller = await resolveCaller(
        new Request('http://yomi.test/x', { headers: { cookie: cookie('nope') } }),
      );
      expect(caller).toBeNull();
    });

    it('refuses a request with no cookie at all', async () => {
      expect(await resolveCaller(new Request('http://yomi.test/x'))).toBeNull();
    });

    it('refuses an idle-expired session even when the absolute expiry is fine', async () => {
      const caller = await resolveCaller(
        new Request('http://yomi.test/x', { headers: { cookie: cookie(token('idle')) } }),
      );
      expect(caller).toBeNull();
    });

    it('refuses an absolutely-expired session even when the idle expiry is fine', async () => {
      // The two checks are not redundant: `expiresAt` slides with activity, so a
      // session that never slides can still be kept alive by using it.
      const caller = await resolveCaller(
        new Request('http://yomi.test/x', { headers: { cookie: cookie(token('absolute')) } }),
      );
      expect(caller).toBeNull();
    });

    it('refuses a valid session whose user is disabled', async () => {
      const caller = await resolveCaller(
        new Request('http://yomi.test/x', { headers: { cookie: cookie(token('disabled')) } }),
      );
      expect(caller).toBeNull();
    });

    it('refuses a caller that tries to name itself in the query string', async () => {
      // The acting user is whatever the verified session says and NEVER anything
      // from the request's own text.
      const caller = await resolveCaller(
        new Request('http://yomi.test/x?role=admin&userId=' + ADMIN_ID),
      );
      expect(caller).toBeNull();
    });
  });
});
