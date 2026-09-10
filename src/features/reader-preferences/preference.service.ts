/**
 * features/reader-preferences — PreferenceService: validation and defaults.
 *
 * Responsibility: the request half of preferences. The repository owns storage;
 * this layer owns every decision about what may be stored — the two table
 * CHECKs mirrored in code (so a 422 happens before a Postgres error), the zoom
 * range the contract promises (1.0–4.0), and the documented defaults for a
 * reader with no row.
 *
 * Why the CHECKs are mirrored here instead of trusted to the database: a CHECK
 * violation is a 500 with a driver message, and "not one of the three modes"
 * is a client bug worth a 422 with a field name. The database CHECKs stay as
 * the last line — two sources of truth would drift, but a validator in front
 * of a constraint is defence in depth, not duplication: one speaks HTTP, the
 * other speaks Postgres, and they say the same thing.
 */
import { AppError } from '../../shared/contracts/errors';
import type { ReaderPreference } from '../../shared/contracts/reader';
import type { UserId } from '../../shared/types';
import type { PreferencePatch, ReaderPreferenceRepository } from './reader-preference.repository';

export interface PreferenceService {
  get(caller: { userId: UserId }): Promise<ReaderPreference>;
  put(caller: { userId: UserId }, patch: Record<string, unknown>): Promise<ReaderPreference>;
}

const MODES = ['vertical', 'single', 'double'] as const;
const DIRECTIONS = ['none', 'rtl', 'ltr'] as const;

function validated(patch: Record<string, unknown>): PreferencePatch {
  const out: PreferencePatch = {};
  if (patch.defaultMode !== undefined) {
    const mode: unknown = patch.defaultMode;
    if (typeof mode !== 'string' || !(MODES as readonly string[]).includes(mode)) {
      throw new AppError('VALIDATION_BAD_QUERY', {
        details: [{ path: 'defaultMode', message: 'Must be vertical, single or double.' }],
      });
    }
    // Narrowed by the guard: a string in MODES is a ReadingMode.
    out.defaultMode = mode as (typeof MODES)[number];
  }
  if (patch.directionOverride !== undefined) {
    const direction: unknown = patch.directionOverride;
    if (typeof direction !== 'string' || !(DIRECTIONS as readonly string[]).includes(direction)) {
      throw new AppError('VALIDATION_BAD_QUERY', {
        details: [{ path: 'directionOverride', message: 'Must be none, rtl or ltr.' }],
      });
    }
    out.directionOverride = direction as (typeof DIRECTIONS)[number];
  }
  if (patch.zoomDefault !== undefined) {
    const zoom =
      typeof patch.zoomDefault === 'number' ? patch.zoomDefault : Number(patch.zoomDefault);
    // The contract promises 1.0–4.0; the column holds numeric(4,2). A string
    // "2" is accepted (forms send strings), but "abc" is not a number and a
    // 10x zoom is not a preference — both are client bugs worth naming.
    if (!Number.isFinite(zoom) || zoom < 1 || zoom > 4) {
      throw new AppError('VALIDATION_BAD_QUERY', {
        details: [{ path: 'zoomDefault', message: 'Must be a number from 1 to 4.' }],
      });
    }
    // Rounded to the column's scale here, not by the database: a stored 2.5
    // the curator never typed would be a lie about their input (the chapter
    // number rule, same reasoning).
    out.zoomDefault = Math.round(zoom * 100) / 100;
  }
  if (patch.autoNextChapter !== undefined) {
    // A real boolean, for the same reason the read-status route demands one:
    // `Boolean("false")` is `true`, and a coercing parse would switch a
    // behaviour on the string that means off.
    if (typeof patch.autoNextChapter !== 'boolean') {
      throw new AppError('VALIDATION_BAD_QUERY', {
        details: [{ path: 'autoNextChapter', message: 'Must be true or false.' }],
      });
    }
    out.autoNextChapter = patch.autoNextChapter;
  }
  return out;
}

export function createPreferenceService(deps: {
  preferences: ReaderPreferenceRepository;
}): PreferenceService {
  return {
    async get(caller) {
      return deps.preferences.get(caller.userId);
    },
    async put(caller, patch) {
      return deps.preferences.put(caller.userId, validated(patch));
    },
  };
}
