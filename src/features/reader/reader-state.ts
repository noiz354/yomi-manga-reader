/**
 * ReaderState store + reducer contract (the reader's single source of truth).
 *
 * Responsibility: ALL reader transitions (page, mode, direction, zoom,
 * fullscreen, window recompute) pass through this reducer; invariants are
 * enforced centrally so no component can desync position/window/zoom.
 *
 * Invariants (property-tested):
 * - 1 <= state.currentPage <= state.totalPages after every transition
 * - state.loadedWindow === calculateReaderWindow(currentPage, totalPages, mode)
 * - 1.0 <= zoom <= 4.0
 * - transitions are pure (no I/O, deterministic; same input ⇒ same output)
 * - switch A→B→A is identity over position
 *
 * Edge cases the reducer must handle:
 * - 1-page chapter (mode forced single; next/prev no-ops)
 * - direction flip (displayIndex derivation)
 * - mode switch at the boundary pages (clamp after recompute)
 * - rapid inputs (queue depth 1; coalesce switches ≤ 300 ms)
 * - invalid deep-link input (clamped via validatePageIndex)
 *
 * The client store wraps this pure reducer; the reducer itself is isomorphic
 * and unit-tested without a DOM.
 */
import type { ReaderState } from '../../shared/contracts';

/** Events the reducer accepts (the complete list — exhaustive switch). */
export type ReaderEvent =
  | { type: 'goto-page'; page: number } // clamped by the reducer
  | { type: 'next-page' }
  | { type: 'prev-page' }
  | { type: 'first-page' }
  | { type: 'last-page' }
  | { type: 'set-scroll'; offset: number } // vertical: 0..1
  | { type: 'set-mode'; mode: ReaderState['readingMode'] }
  | { type: 'set-direction'; direction: ReaderState['readingDirection'] }
  | { type: 'set-zoom'; zoom: number } // clamped 1.0..4.0
  | { type: 'reset-zoom' }
  | { type: 'toggle-fullscreen' }
  | { type: 'toggle-chrome' }
  | { type: 'mark-completed' } // sticky
  | { type: 'window-recompute' }; // after any mode/page change (O(1))

/**
 * The pure reducer.
 *
 * TODO: implement against the reader transition table. No side effects:
 * window/eviction/progress subsystems OBSERVE resulting state (they never
 * mutate it directly).
 *
 * Invariants to assert internally (debug builds + unit fuzz):
 * - index bounds, window cap, zoom bounds.
 */
export function reduceReaderState(state: ReaderState, event: ReaderEvent): ReaderState {
  throw new Error('Not implemented: reader reducer');
}

/**
 * Initial state from a chapter-open context (SSR shell data + restore
 * result). The restore priority (deep link vs saved vs bookmark jump) is
 * resolved BEFORE this constructor runs.
 *
 * TODO: implement the constructor (pure).
 */
export function createReaderState(input: {
  chapterId: string;
  mangaSlug: string;
  totalPages: number;
  readingDirection: 'rtl' | 'ltr';
  defaultMode: ReaderState['readingMode'];
  zoomDefault: number;
  restored?: { pageNumber: number; scrollOffset: number } | null;
  prevChapter: ReaderState['prevChapter'];
  nextChapter: ReaderState['nextChapter'];
}): ReaderState {
  throw new Error('Not implemented: initial reader state');
}
