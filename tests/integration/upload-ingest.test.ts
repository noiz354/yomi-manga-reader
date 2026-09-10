/**
 * Single-part chapter ingest, replacing the resumable multi-part pipeline:
 * validate → normalise → store objects → commit rows → publish, with no jobs
 * or staging area. The REAL chapter repositories run over a throwaway database;
 * storage and the image pipeline are fakes. Rows commit only after every page
 * normalises; objects left by a commit failure are purged. Needs DATABASE_URL;
 * skips without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createUploadPipeline } from '../../src/features/uploads/upload-pipeline';
import { createChapterRepository } from '../../src/server/db/repositories/chapter.repository';
import { createAdminChapterRepository } from '../../src/server/db/repositories/admin.repository';
import { openCatalogDatabase, mangaIdFor } from './support/pg-catalog-ports';
import { envSource } from './catalog.db-harness';
import { chapter, manga } from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { AuditSink } from '../../src/shared/contracts/ports';
import type { Caller } from '../../src/shared/contracts';
import type { ChapterId, UserId } from '../../src/shared/types';
import { AppError } from '../../src/shared/contracts/errors';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const DB_NAME = 'upload_ingest_it';
const MANGA_ID = mangaIdFor('upload_ingest_it');
const CHAPTER_ID = '0198c0f0-0000-7000-8000-000000001301';
const ADMIN: Caller = { userId: '0198c0f0-0000-7000-8000-000000001302' as UserId, role: 'admin' };
const READER: Caller = { userId: '0198c0f0-0000-7000-8000-000000001303' as UserId, role: 'reader' };
const UNKNOWN_CHAPTER = '0198c0f0-0000-7000-8000-000000001304' as ChapterId;

type AuditEvent = Parameters<AuditSink['append']>[0];

/** In-memory object storage: the fake an external service deserves. */
function makeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  // Fail the put with this 1-based sequence number (0 = never). Failing MIDWAY
  // is the case that matters: the earlier puts already succeeded, so the purge
  // has something to prove.
  let failAt = 0;
  let puts = 0;
  return {
    objects,
    failAt: (n: number) => {
      failAt = n;
      puts = 0;
    },
    port: {
      putStream: vi.fn(
        async (key: string, stream: AsyncIterable<Uint8Array>, contentType: string) => {
          puts += 1;
          if (failAt > 0 && puts >= failAt) throw new Error('storage 502');
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream) chunks.push(chunk);
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          objects.set(key, { bytes, contentType });
        },
      ),
      getStream: vi.fn(async () => {
        throw new AppError('INTERNAL_ERROR');
      }),
      exists: vi.fn(async (key: string) => objects.has(key)),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
      head: vi.fn(async () => null),
      presignPartUpload: vi.fn(async () => {
        throw new AppError('INTERNAL_ERROR');
      }),
    },
  };
}

/** The image pipeline the port contract describes (still an unimplemented throw). */
function makeMedia() {
  return {
    normalize: vi.fn(async (input: Uint8Array, sourceFormat: string) => {
      // `sourceFormat: 'bad'` is the test's way of saying "undecodable bytes".
      // Real undecodability is the implementation's job; the ingest's job is
      // what happens AFTER a failure, which is what this fake lets the suite
      // observe.
      if (sourceFormat === 'bad') throw new AppError('UPLOAD_IMAGE_DECODE');
      if (input.byteLength === 0) throw new AppError('UPLOAD_IMAGE_DECODE');
      return {
        avif: new Uint8Array([1, 2, 3]),
        webp: new Uint8Array([4, 5]),
        jpeg: new Uint8Array([6, 7, 8, 9]),
        width: 800,
        height: 1200,
      };
    }),
    makeCover: vi.fn(async () => {
      throw new AppError('INTERNAL_ERROR');
    }),
  };
}

describeDb('single-part chapter ingest', () => {
  let open: OpenDatabase;
  let storage: ReturnType<typeof makeStorage>;
  let media: ReturnType<typeof makeMedia>;
  let events: AuditEvent[];
  let service: ReturnType<typeof createUploadPipeline>;

  const page = (sourceFormat = 'jpeg'): { bytes: Uint8Array; sourceFormat: string } => ({
    bytes: new Uint8Array([10, 20, 30]),
    sourceFormat,
  });

  beforeAll(async () => {
    open = await openCatalogDatabase(DATABASE_URL as string, DB_NAME);
    const throwaway = new URL(DATABASE_URL as string);
    throwaway.pathname = `/${DB_NAME}`;
    for (const [key, value] of Object.entries(envSource(throwaway.toString()))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    storage = makeStorage();
    media = makeMedia();
    events = [];
    const audit: AuditSink = {
      append: vi.fn(async (event: AuditEvent) => {
        events.push(event);
      }),
    };
    service = createUploadPipeline({
      storage: storage.port,
      media,
      chapters: createChapterRepository(open.db),
      adminChapters: createAdminChapterRepository(open.db),
      audit,
    });

    await open.db.insert(manga).values({
      id: MANGA_ID,
      slug: 'upload_ingest_it',
      title: 'Upload Ingest',
      published: true,
      status: 'ongoing',
      readingDirection: 'ltr',
    });
    await open.db.insert(chapter).values({
      id: CHAPTER_ID,
      mangaId: MANGA_ID,
      number: '1',
      status: 'draft',
      publishedAt: null,
      pageCount: 0,
      readingOrder: 1,
    });
  });

  afterAll(async () => {
    await open?.close();
  });

  // The happy path, and what it leaves behind

  it('lands pages: objects stored, rows committed, audit appended', async () => {
    const result = await service.ingestChapterPages(ADMIN, {
      chapterId: CHAPTER_ID as ChapterId,
      pages: [page(), page(), page()],
      publish: false,
    });

    expect(result).toEqual({ pageCount: 3, published: false });
    // Three variants per page, nine objects, all under the chapter's prefix.
    expect(storage.objects.size).toBe(9);
    for (const key of storage.objects.keys()) {
      expect(key).toMatch(new RegExp(`^pages/${CHAPTER_ID}/[0-9a-f]{32}\\.(avif|webp|jpeg)$`));
    }
    // One asset key per page, shared across its three variants.
    const assetKeys = new Set(
      [...storage.objects.keys()].map((key) => key.split('/')[2]?.split('.')[0]),
    );
    expect(assetKeys.size).toBe(3);
    // The audit says what happened, not the content.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'chapter.ingest',
      targetKind: 'chapter',
      targetId: CHAPTER_ID,
    });
  });

  it('publishes after commit when asked, through the admin transition', async () => {
    const result = await service.ingestChapterPages(ADMIN, {
      chapterId: CHAPTER_ID as ChapterId,
      pages: [page()],
      publish: true,
    });

    expect(result).toEqual({ pageCount: 1, published: true });
    const rows = await open.db.select().from(chapter).where(eq(chapter.id, CHAPTER_ID));
    expect(rows[0]?.status).toBe('published');
    expect(rows[0]?.publishedAt).not.toBeNull();
    expect(rows[0]?.pageCount).toBe(1);
  });

  // Rejection leaves nothing behind

  it('refuses an unknown chapter before storing anything', async () => {
    const before = storage.objects.size;

    await expect(
      service.ingestChapterPages(ADMIN, {
        chapterId: UNKNOWN_CHAPTER,
        pages: [page()],
        publish: false,
      }),
    ).rejects.toMatchObject({ code: 'CHAPTER_NOT_FOUND' });

    expect(storage.objects.size).toBe(before);
  });

  it('refuses an empty page list and an oversized one', async () => {
    await expect(
      service.ingestChapterPages(ADMIN, {
        chapterId: CHAPTER_ID as ChapterId,
        pages: [],
        publish: false,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_NO_IMAGES' });

    await expect(
      service.ingestChapterPages(ADMIN, {
        chapterId: CHAPTER_ID as ChapterId,
        pages: Array.from({ length: 201 }, () => page()),
        publish: false,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_MANY_FILES' });
  });

  it('a decode failure on page 2 stores zero objects', async () => {
    const before = storage.objects.size;

    // The second page is undecodable. Because normalisation runs for ALL pages
    // before ANY store, the first page's bytes never reach storage either.
    await expect(
      service.ingestChapterPages(ADMIN, {
        chapterId: CHAPTER_ID as ChapterId,
        pages: [page(), page('bad'), page()],
        publish: false,
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_IMAGE_DECODE' });

    expect(storage.objects.size).toBe(before);
  });

  it('a storage failure midway purges what was already stored', async () => {
    // Fail on the 4th put: page 1 fully stored (3 variants), page 2 partially.
    // Without the purge those three objects would orphan — stored, referenced
    // nowhere, billed forever.
    storage.failAt(4);
    const before = storage.objects.size;

    await expect(
      service.ingestChapterPages(ADMIN, {
        chapterId: CHAPTER_ID as ChapterId,
        pages: [page(), page(), page()],
        publish: false,
      }),
    ).rejects.toThrow('storage 502');

    expect(storage.objects.size).toBe(before);
    storage.failAt(0);
  });

  it('a commit failure purges the stored objects', async () => {
    // The chapters port is faked ONLY for commitPages: byId stays real, so the
    // chapter check passes and the failure lands exactly on the commit — the
    // one place the purge exists to handle.
    const realChapters = createChapterRepository(open.db);
    const failingChapters = {
      ...realChapters,
      commitPages: vi.fn(async () => {
        throw new Error('commit exploded');
      }),
    };
    const failing = createUploadPipeline({
      storage: storage.port,
      media,
      chapters: failingChapters,
      adminChapters: createAdminChapterRepository(open.db),
      audit: { append: vi.fn(async () => undefined) },
    });
    const before = storage.objects.size;

    await expect(
      failing.ingestChapterPages(ADMIN, {
        chapterId: CHAPTER_ID as ChapterId,
        pages: [page(), page()],
        publish: false,
      }),
    ).rejects.toThrow('commit exploded');

    expect(storage.objects.size).toBe(before);
  });

  it('a non-admin caller fails before any read, let alone any write', async () => {
    const before = storage.objects.size;
    const normalises = media.normalize.mock.calls.length;

    await expect(
      service.ingestChapterPages(READER, {
        chapterId: CHAPTER_ID as ChapterId,
        pages: [page()],
        publish: false,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    expect(storage.objects.size).toBe(before);
    // Not even normalised: the role check is the first line, before the
    // chapter read, so a probe learns nothing, not even whether the chapter
    // exists.
    expect(media.normalize.mock.calls.length).toBe(normalises);
  });
});
