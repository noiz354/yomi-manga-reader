/** Upload domain contracts. */
import type { ChapterId, MangaId, UploadJobId, UserId } from '../types';

/** Job state machine — forward-only, failed terminal. */
export type UploadState = 'queued' | 'validating' | 'processing' | 'ready' | 'failed';

export type UploadInputKind = 'zip' | 'images';

export interface UploadJob {
  id: UploadJobId;
  mangaId: MangaId | null;
  chapterId: ChapterId | null;
  createdBy: UserId | null;
  state: UploadState;
  inputKind: UploadInputKind;
  fileCount: number | null;
  byteSize: number | null;
  /** Typed failure code (`UPLOAD_*`) when failed. */
  errorCode: string | null;
  /** Human-readable reason (shown to the curator — no paths). */
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * Intake input (validated at the boundary):
 * - kind 'zip': exactly one file, ≤ 100 MB, ≤ 500 MB total (same as file)
 * - kind 'images': ≤ 500 files, each ≤ 100 MB, ≤ 500 MB total
 * The server caps are authoritative (client pre-checks are advisory).
 */
export interface ChapterUploadInput {
  chapterId: ChapterId;
  kind: UploadInputKind;
  /** Display-only names — truncated, sanitized, NEVER used for storage keys. */
  fileNames: string[];
  totalBytes: number;
  /** Idempotency key (client uuid, 24 h TTL). */
  idempotencyKey: string;
}

/**
 * The validated plan produced by `prepareChapterUpload`.
 * Pure-input → pure-output: the security-critical inspection (container,
 * caps, entry safety, MIME allow-list, dimension pre-checks) happens here,
 * with ZERO I/O (unit-testable against attack fixtures).
 */
export interface PreparedChapterUpload {
  chapterId: ChapterId;
  /** Ordered image manifest (reading order = archive order, documented). */
  pages: Array<{
    entryName: string; // display only
    byteSize: number;
    /** Authoritative format from magic bytes (never the extension). */
    format: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'tiff' | 'bmp';
    /** Pre-decode dimension estimate when the header allows (else null). */
    widthHint: number | null;
    heightHint: number | null;
  }>;
  totalBytes: number;
}
