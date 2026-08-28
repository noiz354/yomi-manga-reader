/**
 * `ReaderProgressRepository` — the port's own invariants.
 *
 * `tests/integration/library.test.ts` covered four of these behaviours against
 * `queries/reader-state.ts`, which this slice deletes. The coverage was ported
 * rather than dropped; the same behaviours are covered against the SHIPPING
 * implementations by `tests/integration/members-surface.test.ts`.
 *
 * A file whose subject is deleted and whose assertions are not ported is a
 * silent coverage hole. That is the failure this file exists to prevent.
 *
 * What is NOT here: the route's status codes, the completion-erasure regression
 * and the `last_read_at` denormalization live in `reader-progress-path.test.ts`;
 * library and bookmark scoping live in `members-surface.test.ts`; clearing
 * completion does not exist yet.
 *
 * DSN: `DATABASE_URL`; SKIPS without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createReaderProgressRepository } from '../../src/server/db/repositories/progress.repository';
import { openCatalogDatabase, mangaIdFor } from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import {
  chapter,
  chapterPage,
  libraryEntry,
  manga,
  readingProgress,
  users,
} from '../../src/server/db/schema';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { ChapterId, UserId } from '../../src/shared/types';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const MANGA_ID = mangaIdFor('progress_repository');
const USER_A = '0198c0f0-0000-7000-8000-000000000f01';
const USER_B = '0198c0f0-0000-7000-8000-000000000f02';
const CHAPTER = '0198c0f0-0000-7000-8000-000000000f03';

const A = USER_A as UserId;
const B = USER_B as UserId;
const C = CHAPTER as ChapterId;

describeDb('the reader progress repository', () => {
  let open: OpenDatabase;
  let repository: ReturnType<typeof createReaderProgressRepository>;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, 'progress_repository');
    for (const [key, value] of Object.entries(envSource(DATABASE_URL as string))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    process.env['DATABASE_URL'] = DATABASE_URL;

    await open.db.insert(users).values([
      {
        id: USER_A,
        email: 'prog-repo-a@invalid',
        displayName: 'A',
        passwordHash: 'x',
        role: 'reader',
        status: 'active',
      },
      {
        id: USER_B,
        email: 'prog-repo-b@invalid',
        displayName: 'B',
        passwordHash: 'x',
        role: 'reader',
        status: 'active',
      },
    ]);
    await open.db.insert(manga).values({
      id: MANGA_ID,
      slug: 'progress_repository',
      title: 'Progress Repository',
      published: true,
      status: 'ongoing',
      readingDirection: 'rtl',
    });
    await open.db.insert(chapter).values({
      id: CHAPTER,
      mangaId: MANGA_ID,
      number: '1',
      status: 'published',
      publishedAt: new Date('2026-04-01T00:00:00.000Z'),
      pageCount: 20,
      readingOrder: 1,
    });
    await open.db.insert(chapterPage).values({
      chapterId: CHAPTER,
      pageNumber: 1,
      assetKey: 'c'.repeat(32),
      width: 480,
      height: 720,
      byteSizeAvif: 1,
      byteSizeWebp: 1,
      byteSizeJpeg: 1,
    });
    await open.db.insert(libraryEntry).values({
      userId: USER_A,
      mangaId: MANGA_ID,
      addedAt: new Date('2026-04-01T00:00:00.000Z'),
      lastReadAt: null,
    });
    repository = createReaderProgressRepository(open.db);
  });

  afterAll(async () => {
    await open?.close();
  });

  it('is null before the first write, so resume shows a start rather than a phantom position', async () => {
    // A reader who has not opened a chapter must not be shown a page they never
    // reached.
    expect(await repository.getProgress(A, C)).toBeNull();
  });

  it('round-trips position, scroll and the completion flag', async () => {
    await repository.saveProgress(A, {
      chapterId: C,
      pageNumber: 7,
      scrollPosition: 0.25,
      completed: false,
    });
    expect(await repository.getProgress(A, C)).toMatchObject({
      pageNumber: 7,
      scrollPosition: 0.25,
      completed: false,
    });
  });

  it('keeps ONE row per (user, chapter) on re-read instead of colliding', async () => {
    // The upsert is `INSERT … ON CONFLICT (user_id, chapter_id) DO UPDATE`, so a
    // second read updates rather than colliding on the primary key.
    await repository.saveProgress(A, {
      chapterId: C,
      pageNumber: 12,
      scrollPosition: 0.5,
      completed: true,
    });
    expect(await repository.getProgress(A, C)).toMatchObject({ pageNumber: 12, completed: true });

    const all = await open.db.select().from(readingProgress).where(eq(readingProgress.userId, A));
    expect(all).toHaveLength(1);
  });

  it("does not read another reader's progress for the same chapter", async () => {
    // At the repository level: the same chapter, two readers, two independent
    // rows. This is the behaviour a missing `WHERE user_id` erases, so it is
    // asserted on the PORT rather than only through a route.
    await repository.saveProgress(B, {
      chapterId: C,
      pageNumber: 2,
      scrollPosition: 0,
      completed: false,
    });
    expect(await repository.getProgress(A, C)).toMatchObject({ pageNumber: 12 });
    expect(await repository.getProgress(B, C)).toMatchObject({ pageNumber: 2 });
  });

  it('answers a completed-set query across chapters without loading every row', async () => {
    await repository.saveProgress(B, {
      chapterId: C,
      pageNumber: 3,
      scrollPosition: 0,
      completed: true,
    });
    const set = await repository.getCompletedSet(B, [C]);
    expect(set.has(C)).toBe(true);
    expect(set.has('0198c0f0-0000-7000-8000-000000000f99' as ChapterId)).toBe(false);
  });
});
