/**
 * Single-part chapter ingest: validate → normalise → store objects →
 * write `chapter_page` rows → optionally publish. Synchronous: no jobs, no
 * staging area, no worker.
 *
 * Validate and normalise fully before storing anything, so a failure leaves
 * zero objects behind. Asset keys are random per ingest (not content-addressed),
 * and stored objects are purged best-effort if the commit fails.
 */
import { randomBytes } from 'node:crypto';
import { AppError } from '../../shared/contracts/errors';
import type { Caller } from '../../shared/contracts';
import type { ImageProcessorPort, ObjectStoragePort } from '../../shared/contracts/ports';
import type { AssetKey } from '../../shared/types';
import { pageObjectKey } from '../../shared/storage-keys';
import type { AdminChapterRepository } from '../admin/admin-ports';
import type { ChapterRepository } from '../chapters/chapters.repository';
import type { AuditSink } from '../../shared/contracts/ports';
import type { ChapterId } from '../../shared/types';

/** A 200-page job is the reference wall-clock budget. */
export const INGEST_MAX_PAGES = 200;

export interface IngestInput {
  chapterId: ChapterId;
  /** Page images IN ORDER, one entry per page. */
  pages: Array<{ bytes: Uint8Array; sourceFormat: string }>;
  /** Publish after commit (the admin transition, not a flag). */
  publish: boolean;
}

export interface IngestService {
  ingestChapterPages(
    caller: Caller,
    input: IngestInput,
  ): Promise<{ pageCount: number; published: boolean }>;
}

/**
 * One chunk as an async stream. `putStream` takes an async iterable, and a
 * bare array is not one — `for await` would accept it, but the TYPE is the
 * contract, and the contract says async.
 */
async function* one(chunk: Uint8Array): AsyncGenerator<Uint8Array> {
  yield chunk;
}

/**
 * The factory for the single-part ingest service.
 */
export function createUploadPipeline(deps: {
  storage: ObjectStoragePort;
  media: ImageProcessorPort;
  chapters: ChapterRepository;
  adminChapters: AdminChapterRepository;
  audit: AuditSink;
}): IngestService {
  const { storage, media, chapters, adminChapters, audit } = deps;

  return {
    async ingestChapterPages(caller, input) {
      if (caller.role !== 'admin') throw new AppError('AUTH_FORBIDDEN');
      const chapterId = input.chapterId;

      // Phase 1: validate everything before touching anything.
      const existing = await chapters.byId(chapterId, caller);
      if (existing === null) throw new AppError('CHAPTER_NOT_FOUND');
      if (input.pages.length === 0) throw new AppError('UPLOAD_NO_IMAGES');
      if (input.pages.length > INGEST_MAX_PAGES) throw new AppError('UPLOAD_TOO_MANY_FILES');

      // Phase 2: normalise every page before storing any. A decode failure
      // here (`UPLOAD_IMAGE_DECODE`, from the port contract) leaves zero
      // objects behind — the pure phase IS the rollback strategy.
      const normalised = [];
      for (let index = 0; index < input.pages.length; index += 1) {
        const page = input.pages[index] as IngestInput['pages'][number];
        const out = await media.normalize(page.bytes, page.sourceFormat);
        normalised.push({ ...out, assetKey: randomBytes(16).toString('hex') });
      }

      // Phase 3: store all variants. Keys collected for the purge below.
      const stored: AssetKey[] = [];
      const purge = async (): Promise<void> => {
        // Best-effort and SWALLOWED: the original failure is what the caller
        // must see, and a delete that fails here is a storage problem the
        // ingest cannot fix by reporting it twice. Orphans are observable
        // (the keys are returned in no success path, so anything stored by a
        // failed ingest is, by definition, unreferenced) and reclaimed by the
        // storage lifecycle, not by failing louder.
        for (const key of stored) {
          try {
            await storage.delete(key);
          } catch {
            // Deliberately nothing. See above.
          }
        }
      };
      try {
        for (const page of normalised) {
          for (const format of ['avif', 'webp', 'jpeg'] as const) {
            const key = pageObjectKey(chapterId, page.assetKey, format);
            const bytes = page[format];
            await storage.putStream(key, one(bytes), `image/${format}`);
            stored.push(key);
          }
        }
      } catch (cause) {
        await purge();
        throw cause;
      }

      // Phase 4: commit the rows in ONE transaction. On failure the objects go
      // with it — "no partial rows" and "no orphaned objects" are the same
      // acceptance at two layers.
      try {
        await chapters.commitPages({
          chapterId,
          pages: normalised.map((page, index) => ({
            pageNumber: index + 1,
            assetKey: page.assetKey,
            width: page.width,
            height: page.height,
            byteSizeAvif: page.avif.byteLength,
            byteSizeWebp: page.webp.byteLength,
            byteSizeJpeg: page.jpeg.byteLength,
          })),
          replace: true,
        });
      } catch (cause) {
        await purge();
        throw cause;
      }

      let published = false;
      if (input.publish) {
        // The chapter has pages now, so the readiness gate passes by
        // construction — and `setPublishState` stamps first publish itself.
        const now = new Date().toISOString();
        await adminChapters.setPublishState(chapterId, 'published', now);
        published = true;
      }

      await audit.append({
        actorId: caller.userId,
        actorEmail: null,
        action: 'chapter.ingest',
        targetKind: 'chapter',
        targetId: chapterId,
        before: null,
        // No bytes, no keys, no dimensions per page: the audit says WHAT
        // happened (how many pages, published or not), not the content.
        after: { pageCount: normalised.length, published },
      });
      return { pageCount: normalised.length, published };
    },
  };
}
