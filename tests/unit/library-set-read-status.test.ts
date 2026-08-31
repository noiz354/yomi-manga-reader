/**
 * `setReadStatus` — the branch that used to be a documented no-op. It read the
 * progress row and wrote `completed: existing.completed` back through
 * `saveProgress`, which is sticky-OR, so "mark unread" did nothing while
 * returning successfully. This proves the SERVICE calls `unsetCompleted` and does
 * NOT reach for `saveProgress` on that path. `saveProgress` is stubbed to RECORD
 * and throw, so a regression re-routing the unset through it fails loudly.
 */
import { describe, expect, it, vi } from 'vitest';
import { createLibraryService } from '../../src/features/library/library.service';
import type { Caller } from '../../src/shared/contracts';
import type { ChapterId, UserId } from '../../src/shared/types';

const CALLER: Caller = { userId: 'u-1' as UserId, role: 'reader' };
const OTHER_CALLER: Caller = { userId: 'u-2' as UserId, role: 'reader' };
const CHAPTER = 'c-1' as ChapterId;

/** What the progress port was asked to do, in order. */
type Call = { op: string; args: unknown[] };

function makeService(progressRow: { pageNumber: number; completed: boolean } | null) {
  const calls: Call[] = [];
  const readerProgress = {
    saveProgress: vi.fn(async (...args: unknown[]) => {
      calls.push({ op: 'saveProgress', args });
      // The fake enforces the rule rather than refusing every call: the save
      // path may SET `completed`, it may never CLEAR it. A first version threw on
      // any call, which also broke the legitimate `read=true` branch and turned a
      // real distinction into a blanket failure. Encoding the rule instead means
      // the stub fails on exactly the misuse and nothing else.
      const input = args[1] as { completed?: boolean } | undefined;
      if (input?.completed === false) {
        throw new Error('saveProgress must not be used to unset');
      }
    }),
    getProgress: vi.fn(async () => {
      calls.push({ op: 'getProgress', args: [] });
      return progressRow;
    }),
    unsetCompleted: vi.fn(async (...args: unknown[]) => {
      calls.push({ op: 'unsetCompleted', args });
    }),
    mergeProgress: vi.fn(),
    getCompletedSet: vi.fn(),
  };

  const service = createLibraryService({
    library: { add: vi.fn(), remove: vi.fn(), list: vi.fn(), latestForManga: vi.fn() } as never,
    bookmarks: { add: vi.fn(), remove: vi.fn(), list: vi.fn() } as never,
    // No cast: `ProgressReader` is exactly this shape, and the factory's own
    // comment says no method here calls it.
    progress: { latestForManga: vi.fn() },
    // `setReadStatus` checks visibility FIRST: a reader must not be able to mark
    // an unpublished chapter read and thereby probe for its existence, so a null
    // here is indistinguishable from "absent".
    chapters: {
      listByManga: vi.fn(),
      bySlug: vi.fn(),
      byId: vi.fn(async () => ({ id: CHAPTER })),
    } as never,
    readerProgress: readerProgress as never,
  });

  return { service, calls, readerProgress };
}

describe('the read-status branch', () => {
  describe('read=false — the unset', () => {
    it('calls unsetCompleted for the caller and the chapter', async () => {
      const { service, calls, readerProgress } = makeService({
        pageNumber: 12,
        completed: true,
      });

      await service.setReadStatus(CALLER, CHAPTER, false);

      expect(readerProgress.unsetCompleted).toHaveBeenCalledWith(CALLER.userId, CHAPTER);
      expect(calls).toEqual([{ op: 'unsetCompleted', args: [CALLER.userId, CHAPTER] }]);
    });

    it('does not touch saveProgress, which is sticky-OR and cannot unset', async () => {
      // The exact defect. `saveProgress` here is stubbed to THROW on call, so a
      // regression fails with "saveProgress must not be used to unset" instead of
      // quietly doing nothing.
      const { service, readerProgress } = makeService({ pageNumber: 12, completed: true });

      await service.setReadStatus(CALLER, CHAPTER, false);

      expect(readerProgress.saveProgress).not.toHaveBeenCalled();
    });

    it('does not read the row first', async () => {
      // The old code read it only to write the same value back. The unset is
      // safe on a chapter with no row, so the read was a round trip whose only
      // purpose was to avoid a write that was never a problem.
      const { service, readerProgress } = makeService(null);

      await service.setReadStatus(CALLER, CHAPTER, false);

      expect(readerProgress.getProgress).not.toHaveBeenCalled();
      expect(readerProgress.unsetCompleted).toHaveBeenCalledOnce();
    });

    it('still unsets a chapter with no progress row', async () => {
      // "Not started" and "marked unread" agree. A guard that returned early on a
      // missing row would make the action silently unavailable for exactly the
      // chapters a reader is most likely to want to re-read.
      const { service, readerProgress } = makeService(null);

      await expect(service.setReadStatus(CALLER, CHAPTER, false)).resolves.toBeUndefined();
      expect(readerProgress.unsetCompleted).toHaveBeenCalledOnce();
    });

    it('uses the CALLER, never a chapter or user named by the request', async () => {
      // The service takes the acting user from the session context and nowhere
      // else; there is no parameter through which a route could pass another id.
      const { service, readerProgress } = makeService({ pageNumber: 1, completed: true });

      await service.setReadStatus(OTHER_CALLER, CHAPTER, false);

      expect(readerProgress.unsetCompleted).toHaveBeenCalledWith(OTHER_CALLER.userId, CHAPTER);
    });

    it('refuses an anonymous caller rather than writing for nobody', async () => {
      // `setReadStatus` is typed `caller: Caller`, so an anonymous request cannot
      // reach it without a cast somewhere. Asserting the runtime guard means a
      // caller who casts anyway gets a 401 rather than a write for `null`.
      const { service, readerProgress } = makeService({ pageNumber: 1, completed: true });

      await expect(
        service.setReadStatus(null as unknown as Caller, CHAPTER, false),
      ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(readerProgress.unsetCompleted).not.toHaveBeenCalled();
    });
  });

  describe('read=true — still a progress write', () => {
    it('goes through saveProgress, because marking a chapter read IS a position write', async () => {
      // The two branches are deliberately not symmetrical. `read=true` moves a
      // position and a completion and touches the library shelf's ordering;
      // `read=false` undoes one flag and nothing else. Unifying them would either
      // weaken the sticky-OR for every page write or make "mark read" a flag flip
      // that loses the reader's place.
      const { service, calls } = makeService({ pageNumber: 12, completed: false });

      await service.setReadStatus(CALLER, CHAPTER, true);

      expect(calls.map((c) => c.op)).toEqual(['saveProgress']);
    });

    it('never clears the flag, whatever the stored row says', async () => {
      // Sticky thereafter: a repeated "mark read" is not an unset in disguise.
      const { service, readerProgress } = makeService({ pageNumber: 12, completed: true });

      await service.setReadStatus(CALLER, CHAPTER, true);

      expect(readerProgress.unsetCompleted).not.toHaveBeenCalled();
    });
  });

  describe('the port seam itself', () => {
    it('declares unsetCompleted, so a mock without it cannot typecheck', async () => {
      // The reason the old service could call a flag-flip and get away with it:
      // the operation did not exist on the port, so there was nothing correct to
      // call and the compiler had no opinion. Adding it to the interface is what
      // makes the honest route the only route.
      const { readerProgress } = makeService(null);
      expect(typeof readerProgress.unsetCompleted).toBe('function');
    });

    it('refuses a chapter the caller cannot see, before writing anything', async () => {
      // The existence probe. `byId` returns null for unpublished AND soft-deleted
      // alike, so this cannot be used to tell those apart either.
      const { readerProgress } = makeService({ pageNumber: 1, completed: true });
      const withHidden = createLibraryService({
        library: { add: vi.fn(), remove: vi.fn(), list: vi.fn(), latestForManga: vi.fn() } as never,
        bookmarks: { add: vi.fn(), remove: vi.fn(), list: vi.fn() } as never,
        // No cast: `ProgressReader` is exactly this shape, and the factory's own
        // comment says no method here calls it.
        progress: { latestForManga: vi.fn() },
        chapters: { byId: vi.fn(async () => null) } as never,
        readerProgress: { unsetCompleted: vi.fn(), saveProgress: vi.fn() } as never,
      });

      await expect(withHidden.setReadStatus(CALLER, CHAPTER, false)).rejects.toMatchObject({
        code: 'CHAPTER_NOT_FOUND',
      });
      expect(readerProgress.unsetCompleted).not.toHaveBeenCalled();
    });

    it('a MangaId never reaches the progress port', async () => {
      // `setReadStatus` takes a chapterId; a manga-level id is a different entity
      // and a mis-wired caller must be visible rather than silently harmless.
      const { service, readerProgress } = makeService(null);
      // `setReadStatus` takes a plain `string` for the chapter, so a manga-shaped
      // id is expressible; a mis-wired caller must be visible rather than silently
      // harmless. No cast, because none is needed.
      const mangaShaped = 'm-1';

      await service.setReadStatus(CALLER, mangaShaped, false);

      const passedChapter = (readerProgress.unsetCompleted as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[1] as unknown;
      expect(passedChapter).toBe(mangaShaped);
    });
  });
});
