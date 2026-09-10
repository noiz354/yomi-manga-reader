/**
 * Preferences repository + service.
 * Repository (real DB): a missing row reads as the documented defaults without
 * writing one; a PUT upserts partially; the `numeric(4,2)` zoom arrives as a
 * number, not a string; one user's row is unreachable from another's.
 * Service (fake repo): every field validates with the field named, and the
 * service passes the patch through after checking — "validated" and "stored"
 * cannot disagree. Needs DATABASE_URL for the repository half. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReaderPreferenceRepository } from '../../src/server/db/repositories/preference.repository';
import { createPreferenceService } from '../../src/features/reader-preferences/preference.service';
import { openCatalogDatabase } from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import { readerPreference, users } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { UserId } from '../../src/shared/types';
import type { PreferencePatch } from '../../src/features/reader-preferences/reader-preference.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const DB_NAME = 'preferences_it';
const A = '0198c0f0-0000-7000-8000-000000001401' as UserId;
const B = '0198c0f0-0000-7000-8000-000000001402' as UserId;

describeDb('the preference repository', () => {
  let open: OpenDatabase;
  let repo: ReturnType<typeof createReaderPreferenceRepository>;

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, DB_NAME);
    repo = createReaderPreferenceRepository(open.db);
    const throwaway = new URL(DATABASE_URL as string);
    throwaway.pathname = `/${DB_NAME}`;
    for (const [key, value] of Object.entries(envSource(throwaway.toString()))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    await open.db.insert(users).values([
      {
        id: A,
        email: 'pref-a@invalid',
        displayName: 'a',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'reader',
        status: 'active',
      },
      {
        id: B,
        email: 'pref-b@invalid',
        displayName: 'b',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'reader',
        status: 'active',
      },
    ]);
  });

  afterAll(async () => {
    await open?.close();
  });

  it('reads the documented defaults for a reader with no row, without writing one', async () => {
    const prefs = await repo.get(A);

    expect(prefs).toEqual({
      defaultMode: 'vertical',
      directionOverride: 'none',
      zoomDefault: 1.0,
      autoNextChapter: true,
    });
    // And still no row IN THE TABLE: comparing two reads only proves the
    // answers agree, not that nothing was written — a mutation that made `get`
    // insert would pass that comparison. The row appears on first PUT instead,
    // so a read that wrote would turn every lookup into a write.
    expect(await repo.get(A)).toEqual(prefs);
    const rows = await open.db
      .select({ userId: readerPreference.userId })
      .from(readerPreference)
      .where(eq(readerPreference.userId, A));
    expect(rows).toHaveLength(0);
  });

  it('upserts partially: named fields replace, unnamed fields stay', async () => {
    await repo.put(A, { autoNextChapter: false });
    expect(await repo.get(A)).toMatchObject({ autoNextChapter: false, defaultMode: 'vertical' });

    await repo.put(A, { defaultMode: 'single' });
    expect(await repo.get(A)).toMatchObject({ autoNextChapter: false, defaultMode: 'single' });
  });

  it('returns zoom as a number, not the numeric string', async () => {
    await repo.put(A, { zoomDefault: 2.5 });

    const prefs = await repo.get(A);
    expect(prefs.zoomDefault).toBe(2.5);
    expect(typeof prefs.zoomDefault).toBe('number');
  });

  it('keeps users apart: B cannot see or touch A\u2019s row', async () => {
    await repo.put(A, { autoNextChapter: false });

    // B has no row of their own: defaults, not A's values.
    expect(await repo.get(B)).toMatchObject({ autoNextChapter: true });
    await repo.put(B, { autoNextChapter: true });
    expect(await repo.get(A)).toMatchObject({ autoNextChapter: false });
  });
});

describe('the preference service', () => {
  const stored = {
    defaultMode: 'vertical',
    directionOverride: 'none',
    zoomDefault: 1.0,
    autoNextChapter: true,
  } as const;

  const makeService = () => {
    // No casts: the stub satisfies the port, and a cast would hide the wiring
    // this suite exists to check. `patch` arrives as the validated
    // `PreferencePatch`, so spreading it is type-safe without assertion.
    const put = vi.fn(async (_userId: UserId, patch: PreferencePatch) => ({
      ...stored,
      ...patch,
    }));
    const service = createPreferenceService({
      preferences: { get: async () => ({ ...stored }), put },
    });
    return { service, put };
  };

  it('passes a valid patch through untouched', async () => {
    const { service, put } = makeService();

    await service.put(
      { userId: A },
      { defaultMode: 'double', zoomDefault: 2, autoNextChapter: false },
    );

    expect(put).toHaveBeenCalledWith(A, {
      defaultMode: 'double',
      zoomDefault: 2,
      autoNextChapter: false,
    });
  });

  it('refuses each bad field with the field named', async () => {
    const { service, put } = makeService();

    for (const [field, value] of [
      ['defaultMode', 'sideways'],
      ['directionOverride', 'up'],
      ['zoomDefault', 0.5],
      ['zoomDefault', 99],
      ['zoomDefault', 'abc'],
      ['autoNextChapter', 'false'],
      ['autoNextChapter', 1],
    ] as const) {
      await expect(service.put({ userId: A }, { [field]: value })).rejects.toMatchObject({
        code: 'VALIDATION_BAD_QUERY',
      });
    }
    expect(put).not.toHaveBeenCalled();
  });

  it('accepts the zoom boundaries and numeric strings', async () => {
    // Forms send strings; "2" is a number wearing a costume, "abc" is not.
    const { service, put } = makeService();

    await service.put({ userId: A }, { zoomDefault: 1 });
    await service.put({ userId: A }, { zoomDefault: 4 });
    await service.put({ userId: A }, { zoomDefault: '2' });

    expect(put).toHaveBeenCalledTimes(3);
  });
});
