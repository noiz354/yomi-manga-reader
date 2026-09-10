/**
 * ReaderPreferenceRepository port — the `reader_preference` table's owner.
 *
 * Semantics:
 * - One row per user, keyed by `user_id`. No row yet is NOT an error: the answer
 *   is the documented defaults, which match the column defaults so the database
 *   and this port cannot disagree about what "unset" means.
 * - `get` never creates; the row appears on first `put`.
 * - `put` is a partial upsert: named fields replace, unnamed fields stay.
 */
import type { UserId } from '../../shared/types';
import type { ReaderPreference } from '../../shared/contracts/reader';

export interface PreferencePatch {
  defaultMode?: ReaderPreference['defaultMode'];
  directionOverride?: ReaderPreference['directionOverride'];
  zoomDefault?: number;
  autoNextChapter?: boolean;
}

export interface ReaderPreferenceRepository {
  /**
   * The caller's preferences, or the documented defaults when no row exists.
   * Never throws for a missing row; never creates one.
   */
  get(userId: UserId): Promise<ReaderPreference>;
  /**
   * Store the named fields, creating the row when absent. Values are assumed
   * validated — the SERVICE owns the CHECK mirrors, because a repository that
   * validates and a service that validates are two sources of truth for one
   * rule, and the database CHECKs are the last line, not the first.
   */
  put(userId: UserId, patch: PreferencePatch): Promise<ReaderPreference>;
}
