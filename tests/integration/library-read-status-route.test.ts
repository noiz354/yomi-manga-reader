/**
 * `POST /api/library/chapters/{chapterId}/read-status`.
 *
 * The route is the thing that turns `unsetCompleted` from a correct operation
 * into a reachable one. `setReadStatus` had been complete, wired to two ports,
 * and called by nothing — so the only place its behaviour had ever been observed
 * was a no-op that a comment described.
 *
 * The tests here are about the EDGE, because the edge is where this route can
 * hurt someone:
 * - `read` must be a real boolean. `Boolean('false')` is `true` and
 *   `Boolean(0)` is `false`, so a coercing parse would let `{"read": 0}` mark a
 *   chapter READ — the opposite of what the caller meant, and irreversible
 *   without another call.
 * - a body of `{}` is "the caller sent nothing", which is not "mark it unread".
 * - the acting user is the session's, and a body cannot name another reader.
 * - an unpublished chapter is a 404, not a probe.
 *
 * The `/library` page's control is not covered: page-level guards are deferred,
 * and this route is the members' `/api` lane, which already enforces membership
 * per route.
 *
 * No DSN required: the service is a fake, so nothing connects anywhere.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSetReadStatusHandler } from '../../src/app/api/library/chapters/[chapterId]/read-status/route';
import { AppError } from '../../src/shared/contracts/errors';
import type { ApiDeps } from '../../src/app/api/_deps';
import type { Caller } from '../../src/shared/contracts';
import type { UserId } from '../../src/shared/types';

const CALLER: Caller = { userId: 'u-1' as UserId, role: 'reader' };
const OTHER: Caller = { userId: 'u-2' as UserId, role: 'reader' };
const CHAPTER = 'c-1';

function makeDeps(options: { caller?: Caller | null; chapterVisible?: boolean } = {}) {
  const { caller = CALLER, chapterVisible = true } = options;
  // The service is faked AT ITS OWN EDGE and its refusal is real: the route's job
  // is to translate a service failure into a status, and a fake that always
  // succeeded would test nothing about the 404 path. The visibility check itself
  // is the service's, and is covered in library-set-read-status.test.ts.
  const setReadStatus = vi.fn(async () => {
    if (!chapterVisible) throw new AppError('CHAPTER_NOT_FOUND');
  });
  const deps = {
    library: { setReadStatus } as never,
    resolveCaller: vi.fn(async () => caller),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  } as unknown as ApiDeps;
  return { deps, setReadStatus };
}

const post = (deps: ApiDeps, body: unknown, chapterId = CHAPTER): Promise<Response> =>
  createSetReadStatusHandler(deps)(
    new Request('http://yomi.test/api/library/chapters/c-1/read-status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ chapterId }) },
  );

describe('the read-status route', () => {
  describe('the two intents', () => {
    it('marks unread on `read: false`', async () => {
      const { deps, setReadStatus } = makeDeps();
      const response = await post(deps, { read: false });

      expect(response.status).toBe(204);
      expect(setReadStatus).toHaveBeenCalledWith(CALLER, CHAPTER, false);
    });

    it('marks read on `read: true`', async () => {
      const { deps, setReadStatus } = makeDeps();
      const response = await post(deps, { read: true });

      expect(response.status).toBe(204);
      expect(setReadStatus).toHaveBeenCalledWith(CALLER, CHAPTER, true);
    });

    it('answers 204 with no body and no-store', async () => {
      // A body would invite clients to read state this command does not report,
      // and `no-store` matters on a 204 too: a cache that stored "unread" would
      // hide a later re-mark behind a stale answer.
      const { deps } = makeDeps();
      const response = await post(deps, { read: false });

      expect(await response.text()).toBe('');
      expect(response.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('`read` is a boolean or it is refused', () => {
    it('refuses a missing `read` rather than treating it as false', async () => {
      // `{}` means the caller sent nothing. Reading that as "unread" would erase a
      // completion on a malformed request.
      const { deps, setReadStatus } = makeDeps();
      const response = await post(deps, {});

      expect(response.status).toBe(422);
      expect(setReadStatus).not.toHaveBeenCalled();
    });

    it('refuses the string "false", which a truthy check would mark READ', async () => {
      const { deps, setReadStatus } = makeDeps();
      const response = await post(deps, { read: 'false' });

      expect(response.status).toBe(422);
      expect(setReadStatus).not.toHaveBeenCalled();
    });

    it('refuses 0 and 1, which a Boolean() would coerce the wrong way', async () => {
      // `Boolean(0)` is `false` (accidentally right) and `Boolean(1)` is `true`
      // (accidentally right) — but `Boolean('false')` is `true`, which is the
      // dangerous one, and a lenient parse would accept all three.
      for (const value of [0, 1, null, {}]) {
        const { deps, setReadStatus } = makeDeps();
        const response = await post(deps, { read: value });

        expect(response.status, `read: ${JSON.stringify(value)}`).toBe(422);
        expect(setReadStatus).not.toHaveBeenCalled();
      }
    });

    it('names the offending field, so a client can fix the call', async () => {
      const { deps } = makeDeps();
      const body = (await (await post(deps, { read: 'nope' })).json()) as {
        error?: { details?: Array<{ path?: string }> };
      };

      expect(body.error?.details?.map((d) => d.path)).toContain('read');
    });

    it('refuses a body that is not JSON at all', async () => {
      const { deps, setReadStatus } = makeDeps();
      const response = await createSetReadStatusHandler(deps)(
        new Request('http://yomi.test/x', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'not json',
        }),
        { params: Promise.resolve({ chapterId: CHAPTER }) },
      );

      expect(response.status).toBe(422);
      expect(setReadStatus).not.toHaveBeenCalled();
    });
  });

  describe('identity comes from the session and nowhere else', () => {
    it('answers 401 without a session and writes nothing', async () => {
      const { deps, setReadStatus } = makeDeps({ caller: null });
      const response = await post(deps, { read: false });

      expect(response.status).toBe(401);
      expect(setReadStatus).not.toHaveBeenCalled();
    });

    it('cannot be talked into another reader by the body', async () => {
      // A body naming a user is ignored outright; there is no field for it to
      // land in.
      const { deps, setReadStatus } = makeDeps();
      const response = await post(deps, { read: false, userId: OTHER.userId, caller: OTHER });

      expect(response.status).toBe(204);
      expect(setReadStatus).toHaveBeenCalledWith(CALLER, CHAPTER, false);
    });

    it('passes the chapter from the path, not from the body', async () => {
      const { deps, setReadStatus } = makeDeps();
      await post(deps, { read: false, chapterId: 'c-999' }, CHAPTER);

      expect(setReadStatus).toHaveBeenCalledWith(CALLER, CHAPTER, false);
    });
  });

  describe('an invisible chapter is a 404, not a probe', () => {
    it('translates the service refusal into 404, not a 204', async () => {
      // The service checks visibility before writing, so an unpublished or
      // soft-deleted chapter cannot be used to test whether it exists. The service
      // IS called here — that is where the check lives — so the thing this asserts
      // is that the route surfaces the refusal instead of swallowing it into the
      // 204 a client would read as success. "Writes nothing" is the service's own
      // guarantee, pinned in library-set-read-status.test.ts.
      const { deps, setReadStatus } = makeDeps({ chapterVisible: false });
      const response = await post(deps, { read: false });

      expect(setReadStatus).toHaveBeenCalledOnce();
      expect(response.status).toBe(404);
    });

    it('says which code, so a client can tell 404 from 500', async () => {
      // A generic 500 would hide a probe attempt behind a fault, and a client
      // could not tell "not yours to see" from "something broke".
      const { deps } = makeDeps({ chapterVisible: false });
      const body = (await (await post(deps, { read: false })).json()) as {
        error?: { code?: string };
      };

      expect(body.error?.code).toBe('CHAPTER_NOT_FOUND');
    });
  });
});
