/**
 * Page index validation & clamping: every page index entering the reader
 * (deep links, progress API input, internal navigation) passes these pure
 * functions, so negative, zero, out-of-range, non-numeric, or hostile inputs
 * can never reach state or storage.
 *
 * `clampPageIndex` is the READER policy (clamp into [1..M], report whether a
 * clamp happened); `validatePageIndex` is the API policy (reject, never clamp).
 */

export type PageIndexRejection =
  | { ok: false; reason: 'not-a-number' }
  | { ok: false; reason: 'below-range' }
  | { ok: false; reason: 'above-range' };

/**
 * TODO: implement.
 */
export function clampPageIndex(
  candidate: number | string,
  totalPages: number,
): { page: number; clamped: boolean } {
  throw new Error('Not implemented');
}

/**
 * TODO: implement.
 */
export function validatePageIndex(
  candidate: number | string,
  totalPages: number,
): { ok: true; page: number } | PageIndexRejection {
  throw new Error('Not implemented');
}
