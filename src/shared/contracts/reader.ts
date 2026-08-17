/**
 * Reader contracts — state, window, progress.
 *
 * `currentPage` is a PHYSICAL 1-based page number; the UI display index for
 * RTL is derived in the reducer. The window bounds how many high-resolution
 * pages are active at once.
 */
import type { ChapterId } from '../types';
// ReadingDirection is canonical in './manga' (a property of the title);
// imported here so reader state types stay complete.
import type { ReadingDirection } from './manga';

export type ReadingMode = 'vertical' | 'single' | 'double';

/**
 * The conceptual window of chapter pages the reader keeps active around the
 * current position.
 *
 * This boundary exists to prevent hundreds of high-resolution images from
 * being fetched or decoded simultaneously.
 *
 * Invariants (enforced by `calculateReaderWindow`):
 * - 1 <= start <= end <= totalPages
 * - end - start + 1 <= 12 (hard cap, all modes)
 * - mode-aware sizes: vertical ±3 · single −1/+2 · double ±1 spread
 * - O(1); pure (no I/O, no allocation-heavy paths)
 *
 * Edge cases the implementation must handle:
 * - first page (no under-window)
 * - last page (no over-window)
 * - chapters smaller than the window (full range, no clamping errors)
 * - 500-page chapters (position-relative, identical memory behavior)
 * - rapid navigation (idempotent recompute)
 */
export interface ReaderWindow {
  start: number; // 1-based physical page number
  end: number; // inclusive, 1-based
}

/**
 * The reader's single source of truth.
 *
 * Invariants (reducer-enforced):
 * - 1 <= currentPage <= totalPages
 * - loadedWindow consistent with (currentPage, readingMode) via
 *   calculateReaderWindow (never free-form)
 * - zoom in [1.0, 4.0]
 * - state is fully serializable (debug/restore/test)
 *
 * `currentPage` is the PHYSICAL page number (1-based). The UI "display index"
 * for RTL is derived (M − currentPage + 1) — the reducer is the only place
 * that mapping exists.
 */
export interface ReaderState {
  chapterId: ChapterId;
  mangaSlug: string;
  totalPages: number;
  currentPage: number;
  /** Vertical mode only: 0..1 fraction of the current page scrolled past. 0 in paged modes. */
  scrollOffset: number;
  readingMode: ReadingMode;
  /** Effective direction (manga default ⊕ user override). */
  readingDirection: ReadingDirection;
  zoom: number; // 1.0..4.0
  fullscreen: boolean;
  chromeVisible: boolean;
  loadedWindow: ReaderWindow;
  /**
   * Progress persistence status:
   * - anonymous-local: only the device store is used
   * - synced: last write accepted by the server
   * - sync-pending: write in flight
   * - sync-failed: last write rejected (local copy retained; notice shown)
   */
  progressStatus: 'anonymous-local' | 'synced' | 'sync-pending' | 'sync-failed';
  /** Sticky completion (unset only via explicit unmark). */
  completed: boolean;
  /** Neighbor chapters (null when absent/hidden). */
  prevChapter: { slug: string; number: number; title: string | null } | null;
  nextChapter: { slug: string; number: number; title: string | null } | null;
}

/**
 * A persisted reading position. Server-stamped `updatedAt` is the LWW basis.
 */
export interface ReaderProgress {
  chapterId: ChapterId;
  pageNumber: number; // 1-based
  /** Vertical-mode offset within the page (0..1); 0 for paged sessions. */
  scrollPosition: number;
  completed: boolean;
  updatedAt: string; // ISO-8601 UTC, SERVER time
}

/**
 * Per-user reader preferences.
 * `directionOverride: 'none'` means "use the manga's direction".
 */
export interface ReaderPreference {
  defaultMode: ReadingMode;
  directionOverride: 'none' | 'rtl' | 'ltr';
  /** 1.0..4.0 */
  zoomDefault: number;
  autoNextChapter: boolean;
}
