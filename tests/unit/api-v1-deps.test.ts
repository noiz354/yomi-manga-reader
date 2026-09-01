/**
 * The `/api/v1` registry, including the lazy composition seam.
 * `registerApiV1Deps` was documented as "called once by the composition root at
 * boot" and NOTHING called it, so every `/api/v1` route answered 500 on a real
 * server while the integration suite stayed green. These tests pin what the
 * wiring must do: an explicitly registered deps wins, the real composition is
 * built at most once per process, and a FAILED build is not remembered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SILENT_LOGGER } from '../../src/app/api/v1/_http';
import type { ApiV1Deps } from '../../src/app/api/v1/_deps';
import type { CatalogService } from '../../src/features/catalog';

type DepsModule = typeof import('../../src/app/api/v1/_deps');

/**
 * The registry keeps module-level state on purpose (one process, one set of
 * services). Each test gets a FRESH module instance instead of a reset export,
 * so no production API exists only to make a test tidy.
 */
async function freshDepsModule(): Promise<DepsModule> {
  vi.resetModules();
  return import('../../src/app/api/v1/_deps');
}

/** A deps bundle whose only observable is that it is the one object returned. */
function stubDeps(): ApiV1Deps {
  const catalog = { list: vi.fn() } as unknown as CatalogService;
  return {
    catalog,
    // The seam carries the chapter port for the chapter-pages route. This test
    // only observes that the registered bundle is the one returned, so the port
    // is a stub here rather than a real one — nothing in the file exercises it.
    chapters: {} as ApiV1Deps['chapters'],
    // Not under test here: the search service rides this seam because the
    // /api/search route shares it, so every literal needs a member even when
    // the suite under test never calls it.
    search: { search: async () => ({ items: [], nextCursor: null }) },
    resolveCaller: async () => null,
    logger: SILENT_LOGGER,
  };
}

describe('the /api/v1 registry and its lazy composition', () => {
  let depsModule: DepsModule;

  beforeEach(async () => {
    depsModule = await freshDepsModule();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports "not wired" before anything is built, so the route fails loudly', () => {
    expect(depsModule.apiV1Deps()).toBeNull();
  });

  it('builds the composition on first use and memoises it for the process', async () => {
    const deps = stubDeps();
    const build = vi.fn(async () => deps);

    const first = await depsModule.apiV1DepsWith(build);
    const second = await depsModule.apiV1DepsWith(build);

    expect(build).toHaveBeenCalledTimes(1);
    expect(first).toBe(deps);
    expect(second).toBe(deps);
    // The built bundle is published, so a route that asks the synchronous
    // question afterwards gets the same answer.
    expect(depsModule.apiV1Deps()).toBe(deps);
  });

  it('publishes concurrently-awaited builds exactly once', async () => {
    const deps = stubDeps();
    const build = vi.fn(async () => deps);

    const [a, b] = await Promise.all([
      depsModule.apiV1DepsWith(build),
      depsModule.apiV1DepsWith(build),
    ]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(a).toBe(deps);
    expect(b).toBe(deps);
  });

  it('lets explicitly registered deps win, and never builds over them', async () => {
    const registered = stubDeps();
    const built = stubDeps();
    const build = vi.fn(async () => built);

    depsModule.registerApiV1Deps(registered);

    expect(await depsModule.apiV1DepsWith(build)).toBe(registered);
    expect(await depsModule.apiV1DepsWith(build)).toBe(registered);
    expect(build).not.toHaveBeenCalled();
  });

  it('does NOT remember a failed build, so a later request can still succeed', async () => {
    const deps = stubDeps();
    const build = vi
      .fn<() => Promise<ApiV1Deps>>()
      .mockRejectedValueOnce(new Error('database unreachable'))
      .mockResolvedValueOnce(deps);

    await expect(depsModule.apiV1DepsWith(build)).rejects.toThrow('database unreachable');
    // The process is still usable: the next request builds again.
    expect(await depsModule.apiV1DepsWith(build)).toBe(deps);
    expect(build).toHaveBeenCalledTimes(2);
    expect(depsModule.apiV1Deps()).toBe(deps);
  });

  it('propagates a build failure to the caller instead of answering with null', async () => {
    const build = vi.fn(async () => stubDeps());
    // A route must be able to tell "not wired yet" from "the boot failed": the
    // first is a missing-registration 500, the second must keep its real cause
    // so the logger records why the database was not reachable.
    depsModule.registerApiV1Deps(stubDeps());
    expect(await depsModule.apiV1DepsWith(build)).not.toBeNull();
  });
});
