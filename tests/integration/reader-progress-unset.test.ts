/**
 * `unsetCompleted` — clearing a chapter's completed flag, against the REAL
 * repository rather than a mock, because the defect lived in SQL a mock cannot
 * express: `saveProgress` is sticky-OR by contract, so writing `completed:
 * existing.completed` back through it was a structural no-op.
 *
 * What is NOT covered: the route — no `read=false` route exists until a guard
 * lands, so this is service-and-repository-only. Needs DATABASE_URL; skips
 * without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createReaderProgressRepository } from '../../src/server/db/repositories/progress.repository';
import { openCatalogDatabase, mangaIdFor } from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import { chapter, manga, readingProgress, users } from '../../src/server/db/schema';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { ChapterId, UserId } from '../../src/shared/types';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const DB_NAME = 'progress_unset_it';
const MANGA_ID = mangaIdFor('progress_unset_it');
const USER_A = '0198c0f0-0000-7000-8000-000000000e11';
const USER_B = '0198c0f0-0000-7000-8000-000000000e12';
const CHAPTER_1 = '0198c0f0-0000-7000-8000-000000000e13';
/** A second chapter of the same title, also completed — the scoping probe. */
const CHAPTER_2 = '0198c0f0-0000-7000-8000-000000000e14';
/** A chapter A has progress for but has NOT completed. */
const CHAPTER_OPEN = '0198c0f0-0000-7000-8000-000000000e15';
/** A chapter neither user has ever opened — the "no row" case. */
const CHAPTER_ABSENT = '0198c0f0-0000-7000-8000-000000000e16';

const A = USER_A as UserId;
const B = USER_B as UserId;
const C1 = CHAPTER_1 as ChapterId;
const C2 = CHAPTER_2 as ChapterId;
const C_OPEN = CHAPTER_OPEN as ChapterId;
const C_ABSENT = CHAPTER_ABSENT as ChapterId;

describeDb('unsetCompleted: the only unset path', () => {
  let open: OpenDatabase;
  let repo: ReturnType<typeof createReaderProgressRepository>;

  const row = async (userId: string, chapterId: string) =>
    open.db.query.readingProgress.findFirst({
      where: (f, { and, eq: e }) => and(e(f.userId, userId), e(f.chapterId, chapterId)),
    });

  const completed = async (userId: string, chapterId: string): Promise<boolean | null> =>
    (await row(userId, chapterId))?.completed ?? null;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, DB_NAME);
    repo = createReaderProgressRepository(open.db);
    // The repository opens no handle of its own, but the env must still be
    // complete for any module that calls `loadEnv()` on this path. Point it at the
    // THROWAWAY database by path, or a stray `loadEnv()` reads the base one.
    const throwaway = new URL(DATABASE_URL as string);
    throwaway.pathname = `/${DB_NAME}`;
    for (const [key, value] of Object.entries(envSource(throwaway.toString()))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }

    await open.db.insert(users).values([
      {
        id: USER_A,
        email: 'unset-a@invalid',
        displayName: 'a',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'reader',
        status: 'active',
      },
      {
        id: USER_B,
        email: 'unset-b@invalid',
        displayName: 'b',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'reader',
        status: 'active',
      },
    ]);
    await open.db.insert(manga).values({
      id: MANGA_ID,
      slug: 'progress_unset_it',
      title: 'Progress Unset',
      published: true,
      status: 'ongoing',
      readingDirection: 'ltr',
    });
    await open.db.insert(chapter).values(
      [CHAPTER_1, CHAPTER_2, CHAPTER_OPEN, CHAPTER_ABSENT].map((id, index) => ({
        id,
        mangaId: MANGA_ID,
        number: String(index + 1),
        status: 'published' as const,
        publishedAt: new Date('2026-04-01T00:00:00.000Z'),
        pageCount: 20,
        readingOrder: index + 1,
      })),
    );
  });

  afterAll(async () => {
    await open?.close();
  });

  beforeEach(async () => {
    // Reset to a known shape: A completed ch1 at page 12, started-but-open ch3 at
    // page 5, and A completed ch2 which only the cross-user tests touch. B has
    // its own completed ch1 so "another user's row" is a real row, not an absence.
    await open.db.delete(readingProgress);
    await open.db.insert(readingProgress).values([
      {
        userId: USER_A,
        chapterId: CHAPTER_1,
        pageNumber: 12,
        completed: true,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        userId: USER_A,
        chapterId: CHAPTER_2,
        pageNumber: 20,
        completed: true,
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
      {
        userId: USER_A,
        chapterId: CHAPTER_OPEN,
        pageNumber: 5,
        completed: false,
        updatedAt: new Date('2026-01-03T00:00:00.000Z'),
      },
      {
        userId: USER_B,
        chapterId: CHAPTER_1,
        pageNumber: 3,
        completed: true,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('clears `completed` for a finished chapter', async () => {
    expect(await completed(USER_A, CHAPTER_1)).toBe(true);

    await repo.unsetCompleted(A, C1);

    expect(await completed(USER_A, CHAPTER_1)).toBe(false);
  });

  it('would NOT have worked through saveProgress, which is why this is its own call', async () => {
    // The proof that the old no-op was structural and not a wiring mistake: the
    // sticky-OR save genuinely cannot clear the flag, and this test fails if the
    // operation is ever re-expressed as a `saveProgress({ completed: false })`.
    await repo.saveProgress(A, {
      chapterId: C1,
      pageNumber: 12,
      scrollPosition: 0,
      completed: false,
    });

    expect(await completed(USER_A, CHAPTER_1)).toBe(true);
  });

  it('leaves the reader position alone', async () => {
    // "Unread" means "not finished", not "start over". The resume rules will
    // still point at page 12; a reader who marks a chapter unread is asking to
    // re-read it, not to forget where they were, and silently rewinding would
    // destroy a position they may want.
    await repo.unsetCompleted(A, C1);

    expect((await row(USER_A, CHAPTER_1))?.pageNumber).toBe(12);
  });

  it('touches one chapter only, not a sibling on the same title', async () => {
    // Two chapters of one manga, both completed. A write that leaked to the title
    // rather than the chapter would un-finish both, and a reader marking one
    // chapter unread would lose the rest of the title's history.
    expect(await completed(USER_A, CHAPTER_1)).toBe(true);
    expect(await completed(USER_A, CHAPTER_2)).toBe(true);

    await repo.unsetCompleted(A, C1);

    expect(await completed(USER_A, CHAPTER_1)).toBe(false);
    expect(await completed(USER_A, CHAPTER_2)).toBe(true);
    // `C2` is the same row the assertions above read, named as a `ChapterId` so the
    // scoping check and the port call cannot drift onto different rows.
    expect(await completed(USER_A, C2)).toBe(true);
  });

  it('is a safe no-op on a chapter that was never opened', async () => {
    // "Not started" and "explicitly marked unread" agree, and there is no row to
    // clear. A throw here would make the read-status action depend on whether the
    // reader had happened to open the chapter first.
    await expect(repo.unsetCompleted(A, C_ABSENT)).resolves.toBeUndefined();
    expect(await row(USER_A, CHAPTER_ABSENT)).toBeUndefined();
  });

  it('is a no-op on a chapter that is already not completed', async () => {
    await repo.unsetCompleted(A, C_OPEN);

    expect(await completed(USER_A, CHAPTER_OPEN)).toBe(false);
  });

  it('does not disturb another user progress on the same chapter', async () => {
    // The write is keyed on `userId`, so there is nothing to get
    // wrong — but "the query looks right" is not the same as "the data is right".
    expect(await completed(USER_B, CHAPTER_1)).toBe(true);

    await repo.unsetCompleted(B, C1);

    expect(await completed(USER_B, CHAPTER_1)).toBe(false);
    // And the other direction, which is the one the bug's shape invites: unsetting
    // A's chapter must not reach across to B's row on the same chapter.
    await repo.unsetCompleted(A, C1);
    expect(await completed(USER_B, CHAPTER_1)).toBe(false);
    expect(await completed(USER_A, CHAPTER_1)).toBe(false);
  });

  it('leaves updated_at alone when nothing changed, so a repeat is idempotent', async () => {
    const before = (await row(USER_A, CHAPTER_OPEN))?.updatedAt;
    await repo.unsetCompleted(A, C_OPEN);
    const after = (await row(USER_A, CHAPTER_OPEN))?.updatedAt;

    // A write that moved the stamp would be indistinguishable from a real change
    // to anything comparing on it, and would churn a column the LWW basis uses.
    expect(after?.getTime()).toBe(before?.getTime());
  });

  it('does not un-finish a chapter that was completed after the unset was decided', async () => {
    // The LWW guard. A row stamped in the FUTURE is what a stale writer looks
    // like: the reader finished the chapter on another device and this unset was
    // decided from state older than that. Without the guard, replaying the unset
    // would un-finish a chapter they have finished.
    await open.db
      .update(readingProgress)
      .set({ updatedAt: new Date(Date.now() + 3_600_000) })
      .where(eq(readingProgress.userId, USER_A));

    await repo.unsetCompleted(A, C1);

    expect(await completed(USER_A, CHAPTER_1)).toBe(true);
  });

  it('still clears a chapter whose stamp is at or before the server clock', async () => {
    // The other side of the same guard, so the test above cannot pass by
    // `unsetCompleted` being a no-op in general.
    const before = await completed(USER_A, CHAPTER_1);
    expect(before).toBe(true);

    await repo.unsetCompleted(A, C1);

    expect(await completed(USER_A, CHAPTER_1)).toBe(false);
  });
});
