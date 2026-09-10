/**
 * Prepare chapter images for ingestion — the PURE security core.
 * Inspects staged upload metadata and returns the ordered image manifest, or a
 * typed rejection. Rejects Zip Slip, symlinks, MIME spoofing (magic bytes are
 * authoritative), decompression bombs, oversized counts/sizes/dimensions,
 * encrypted ZIPs and non-UTF8 names. Manifest order is archive order; fileNames
 * are display-only and NEVER used for storage keys.
 */
import type { ChapterUploadInput, PreparedChapterUpload } from '../../shared/contracts';

export async function prepareChapterUpload(
  input: ChapterUploadInput,
): Promise<PreparedChapterUpload> {
  throw new Error('Not implemented');
}
