/**
 * ReaderPreferenceRepository over the existing `reader_preference` table.
 *
 * No migration: the table, its PK on `user_id`, its two CHECKs and its column
 * defaults already exist and already say what this file says. A migration that
 * re-states them would be motion, not work.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { readerPreference } from '../schema';
import type {
  PreferencePatch,
  ReaderPreferenceRepository,
} from '../../../features/reader-preferences/reader-preference.repository';
import type { ReaderPreference } from '../../../shared/contracts/reader';
import type { UserId } from '../../../shared/types';

/** The documented defaults — identical to the column defaults, deliberately. */
export const PREFERENCE_DEFAULTS: ReaderPreference = {
  defaultMode: 'vertical',
  directionOverride: 'none',
  zoomDefault: 1.0,
  autoNextChapter: true,
};

function toPreference(row: typeof readerPreference.$inferSelect): ReaderPreference {
  return {
    defaultMode: row.defaultMode as ReaderPreference['defaultMode'],
    directionOverride: row.directionOverride as ReaderPreference['directionOverride'],
    // `numeric(4,2)` arrives as a string; the contract promises a number, so
    // the conversion is here, once, where the string enters.
    zoomDefault: Number(row.zoomDefault),
    autoNextChapter: row.autoNextChapter,
  };
}

export function createReaderPreferenceRepository(db: Db): ReaderPreferenceRepository {
  return {
    async get(userId: UserId): Promise<ReaderPreference> {
      const rows = await db
        .select()
        .from(readerPreference)
        .where(eq(readerPreference.userId, userId))
        .limit(1);
      const row = rows[0];
      // No row is not an error and not a write: it is a reader who never
      // opened settings, and the answer is the defaults.
      if (row === undefined) return { ...PREFERENCE_DEFAULTS };
      return toPreference(row);
    },

    async put(userId: UserId, patch: PreferencePatch): Promise<ReaderPreference> {
      const values: Partial<typeof readerPreference.$inferInsert> = {};
      if (patch.defaultMode !== undefined) values.defaultMode = patch.defaultMode;
      if (patch.directionOverride !== undefined) values.directionOverride = patch.directionOverride;
      if (patch.zoomDefault !== undefined) values.zoomDefault = String(patch.zoomDefault);
      if (patch.autoNextChapter !== undefined) values.autoNextChapter = patch.autoNextChapter;
      // A patch that names nothing still ensures the row: PUT is how a row
      // comes into being, and "store my (empty) choices" is a legitimate first
      // write. An empty patch that no-op'd would make row creation depend on
      // naming a field, which is a rule nobody could guess.
      await db
        .insert(readerPreference)
        .values({ userId, ...values })
        .onConflictDoUpdate({
          target: readerPreference.userId,
          set: { ...values, updatedAt: new Date() },
        });
      const rows = await db
        .select()
        .from(readerPreference)
        .where(eq(readerPreference.userId, userId))
        .limit(1);
      const row = rows[0];
      // Just written by this call: absence here is an internal inconsistency,
      // not a 404.
      if (row === undefined) throw new Error('preference row missing after upsert');
      return toPreference(row);
    },
  };
}
