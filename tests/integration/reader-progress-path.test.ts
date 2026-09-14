/**
 * The reader's progress write path.
 * The regression it pins: POST /api/chapters/{id}/progress plain-overwrote
 * `completed` and passed `completed: Boolean(body.completed)` while the client
 * sends only `{ pageNumber }`, so every page change erased a finished chapter;
 * the same path never maintained `library_entry.last_read_at`. Tests go through
 * the ROUTE, not the repository — the repository was never the problem.
 * DSN: DATABASE_URL; SKIPS without it. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST } from '../../src/app/api/chapters/[chapterId]/progress/route';
import { createReaderProgressRepository } from '../../src/server/db/repositories/progress.repository';
import { openCatalogDatabase, mangaIdFor } from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import {
  chapter,
  chapterPage,
  libraryEntry,
  manga,
  readingProgress,
  sessions,
  users,
} from '../../src/server/db/schema';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { ChapterId, UserId } from '../../src/shared/types';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const MANGA_ID = mangaIdFor('reader_progress_path');
const USER_ID = '0198c0f0-0000-7000-8000-000000000e01';
const SESSION_TOKEN = 'reader-progress-path-token-000000000000';
const CHAPTER_ID = '0198c0f0-0000-7000-8000-000000000e02';
const CHAPTER_2 = '0198c0f0-0000-7000-8000-000000000e03';
const PAGE_COUNT = 12;

const authedRequest = (body: unknown): Request =>
  new Request('http://localhost:3000/api/chapters/x/progress', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `session_token=${SESSION_TOKEN}` },
    body: JSON.stringify(body),
  });

const context = (chapterId: string) => ({ params: Promise.resolve({ chapterId }) });

describeDb('the reader progress write path', () => {
  let open: OpenDatabase;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, 'reader_progress_path');
    // The route calls `loadEnv()` itself, so it needs a COMPLETE source — the same
    // record the shared harness provides for composition roots.
    for (const [key, value] of Object.entries(envSource(DATABASE_URL as string))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    // The route builds its OWN handle from `process.env`, which is the bypass this
    // slice removes. Until it goes through the composition root, the test has to
    // point the environment at the throwaway database or the route reads the base
    // one and finds no session — a 401 that looks like a broken fixture rather than
    // the defect. After this slice the route takes an injected handle and this
    // becomes unnecessary; it is kept explicit rather than relying on the caller's
    // DATABASE_URL.
    const throwaway = new URL(DATABASE_URL as string);
    throwaway.pathname = '/reader_progress_path';
    previousDatabaseUrl = process.env['DATABASE_URL'];
    process.env['DATABASE_URL'] = throwaway.toString();

    await open.db.insert(users).values({
      id: USER_ID,
      email: 'reader-progress-path@invalid',
      displayName: 'reader',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
      role: 'reader',
      status: 'active',
    });
    // `ip` is an `inet` and `id` is a uuidV7 primary key; a null is allowed on
    // both `lastSeenAt` and `userAgent`, so the row needs no more than the token
    // and the two expiries the guard actually checks.
    await open.db.insert(sessions).values({
      id: '0198c0f0-0000-7000-8000-000000000e04',
      userId: USER_ID,
      sessionToken: SESSION_TOKEN,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      absoluteExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      lastSeenAt: null,
      userAgent: null,
      ip: null,
    });
    await open.db.insert(manga).values({
      id: MANGA_ID,
      slug: 'reader_progress_path',
      title: 'Reader Progress Path',
      published: true,
      status: 'ongoing',
      readingDirection: 'rtl',
    });
    await open.db.insert(chapter).values([
      {
        id: CHAPTER_ID,
        mangaId: MANGA_ID,
        number: '1',
        status: 'published',
        publishedAt: new Date('2026-04-01T00:00:00.000Z'),
        pageCount: PAGE_COUNT,
        readingOrder: 1,
      },
      {
        id: CHAPTER_2,
        mangaId: MANGA_ID,
        number: '2',
        status: 'published',
        publishedAt: new Date('2026-04-01T00:00:00.000Z'),
        pageCount: 8,
        readingOrder: 2,
      },
    ]);
    await open.db.insert(chapterPage).values({
      chapterId: CHAPTER_ID,
      pageNumber: 1,
      assetKey: 'b'.repeat(32),
      width: 480,
      height: 720,
      byteSizeAvif: 1,
      byteSizeWebp: 1,
      byteSizeJpeg: 1,
    });
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousDatabaseUrl;
    await open?.close();
  });

  it('does NOT erase completion when the reader moves to another page', async () => {
    // The defect, stated as a test. The reader client sends ONLY `{ pageNumber }`,
    // which is the whole reason the bug existed: there was no `completed` to read.
    const repository = createReaderProgressRepository(open.db);
    await open.db.insert(readingProgress).values({
      userId: USER_ID,
      chapterId: CHAPTER_ID,
      pageNumber: PAGE_COUNT,
      scrollPosition: 1,
      completed: true,
      updatedAt: new Date('2026-04-01T01:00:00.000Z'),
    });

    const res = await POST(authedRequest({ pageNumber: 3 }), context(CHAPTER_ID));
    expect(res.status).toBe(200);

    const after = await open.db
      .select()
      .from(readingProgress)
      .where(eq(readingProgress.chapterId, CHAPTER_ID));
    expect(after[0]?.completed).toBe(true);
    expect(after[0]?.pageNumber).toBe(3);

    // And the repository agrees, read through the shipping port.
    const viaPort = await repository.getProgress(USER_ID as UserId, CHAPTER_ID as ChapterId);
    expect(viaPort?.completed).toBe(true);
  });

  it('maintains library_entry.last_read_at, which the old path never wrote', async () => {
    // The second half of the P0. `last_read_desc` is the shelf's DEFAULT sort, so
    // a column that is never written means the default order is arbitrary.
    await open.db.insert(libraryEntry).values({
      userId: USER_ID,
      mangaId: MANGA_ID,
      addedAt: new Date('2026-04-01T00:00:00.000Z'),
      lastReadAt: null,
    });

    const res = await POST(authedRequest({ pageNumber: 5 }), context(CHAPTER_ID));
    expect(res.status).toBe(200);

    const [row] = await open.db
      .select()
      .from(libraryEntry)
      .where(eq(libraryEntry.mangaId, MANGA_ID));
    expect(row?.lastReadAt).not.toBeNull();
  });

  it('still refuses an anonymous caller, an unknown chapter, and an out-of-range page', async () => {
    // The negative paths must survive the rewire. Rewiring a route is exactly when
    // a check that falls out of a row already being read can disappear.
    const anonymous = await POST(
      new Request('http://localhost:3000/api/chapters/x/progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pageNumber: 2 }),
      }),
      context(CHAPTER_ID),
    );
    expect(anonymous.status).toBe(401);

    const unknownChapter = await POST(
      authedRequest({ pageNumber: 2 }),
      context('0198c0f0-0000-7000-8000-000000000e99'),
    );
    expect(unknownChapter.status).toBe(404);

    const outOfRange = await POST(
      authedRequest({ pageNumber: PAGE_COUNT + 5 }),
      context(CHAPTER_ID),
    );
    expect(outOfRange.status).toBe(422);

    const notANumber = await POST(authedRequest({ pageNumber: 'abc' }), context(CHAPTER_ID));
    expect(notANumber.status).toBe(422);
  });

  it('records the page the reader actually asked for, inside that chapter', async () => {
    // Chapter 2 has 8 pages, so page 6 is in range and must be stored as 6 — the
    // response echoes what was persisted, not what was asked for. The route
    // REFUSES a page past the end with a 422 (covered by the negative test above);
    // it does not clamp.
    const res = await POST(authedRequest({ pageNumber: 6 }), context(CHAPTER_2));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pageNumber: number };
    expect(body.pageNumber).toBe(6);

    const stored = await open.db
      .select()
      .from(readingProgress)
      .where(eq(readingProgress.chapterId, CHAPTER_2));
    expect(stored[0]?.pageNumber).toBe(6);
  });

  it('uses a repository, not a direct write — proven by the two behaviours above', async () => {
    // If someone re-points this route at `upsertProgress` again, the first two
    // tests fail. That is the whole regression guard, and it is behavioural.
    const repository = createReaderProgressRepository(open.db);
    const completedSet = await repository.getCompletedSet(USER_ID as UserId, [
      CHAPTER_ID as ChapterId,
    ]);
    expect(completedSet.has(CHAPTER_ID as ChapterId)).toBe(true);
  });
});
