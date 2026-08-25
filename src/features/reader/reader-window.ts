/**
 * Bounded preload window — the reader memory boundary.
 *
 * Computes which pages should be kept near the active page so hundreds of
 * high-resolution images are never active simultaneously.
 *
 * Contract:
 * - mode-aware sizes: vertical ±3 (≤ 7 slots) · single −1/+2 ·
 *   double ±1 spread (≤ 6 pages)
 * - clamped to [1..totalPages]
 * - HARD CAP: the window never exceeds 12 pages in any mode (defensive
 *   invariant; guards 500-page chapters and future mode additions)
 * - O(1), pure, no allocation-heavy paths
 * - recompute is idempotent (same inputs ⇒ same window); rapid navigation
 *   sequences must never violate invariants
 *
 * Edge cases (all must pass):
 * - first page (start clamps to 1)
 * - last page (end clamps to M)
 * - chapters smaller than the window (full range, no error)
 * - M = 1 (window {1,1})
 * - 500-page chapter at page 1 / 250 / 500 (identical slot counts)
 */
import type { ReaderWindow, ReadingMode } from '../../shared/contracts';

/**
 * TODO: implement per the contract in the header.
 */
export function calculateReaderWindow(
  currentPage: number,
  totalPages: number,
  mode: ReadingMode,
): ReaderWindow {
  throw new Error('Not implemented');
}
