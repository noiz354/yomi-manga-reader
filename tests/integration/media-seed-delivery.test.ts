/**
 * The seed's page images are reachable by the route the reader actually calls.
 *
 * A seeded page row carried an `asset_key` and three recorded byte sizes, and
 * the object behind it did not exist — the seed encoded every variant and then
 * dropped the bytes, so `/media/{key}.jpeg` answered 404 and the reader
 * rendered a broken image. Every number in the seed report was true and the
 * product was still undeliverable, because no test followed a seeded key all
 * the way to a response.
 *
 * Two independent faults had to be fixed, and either one alone leaves a 404:
 *
 * 1. The key. `DELIVERY_KEY_PATTERN` in src/server/media/page-delivery.ts is
 *    `/^([A-Za-z0-9_-]{22,64})\.(avif|webp|jpeg)$/` — one URL segment, no
 *    slashes. A `seed/v1/<32 hex>` key made `parseDeliveryKey` return null and
 *    the route 404 before consulting storage at all.
 * 2. The path. The OBJECT lives at `pages/{chapterId}/{assetKey}.{ext}`, which
 *    `pageObjectKey` builds server-side. Writing the bare key produced an
 *    object in a directory no request would ever name.
 *
 * This suite runs the seed's own functions — not a reimplementation — and then
 * asks the delivery path for the key they produced.
 *
 * DSN: `DATABASE_URL`; SKIPS without it. Throwaway database, own port.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  coverObjectKey,
  createObjectStorageAsync,
  pageObjectKey,
} from '../../src/server/storage/object-storage';
import { loadEnv } from '../../src/shared/validation/env';
import { deliverPage } from '../../src/server/media';
import type { MediaDeliveryDeps } from '../../src/server/media';
import { chapter, chapterPage, manga, users } from '../../src/server/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  chapterIdFor,
  coverAssetKey,
  coverObjectPathFor,
  deterministicUuid,
  pageAssetKey,
  pageObjectPathFor,
} from '../../scripts/seed.mjs';
import { openCatalogDatabase } from './support/pg-catalog-ports';
import type { OpenDatabase } from './support/pg-catalog-ports';
import type { AssetKey } from '../../src/shared/types/ids';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeDb = DATABASE_URL ? describe : describe.skip;

const SLUG = 'seed-delivery-probe';
const CHAPTER_NUMBER = '1.00';
const NOW = new Date('2026-03-01T00:00:00.000Z');

describeDb('a seeded page image is reachable through /media', () => {
  let open: OpenDatabase;
  let storage: Awaited<ReturnType<typeof createObjectStorageAsync>>;
  let deps: MediaDeliveryDeps;

  // uuid-shaped literals: the suite never invents ids, it only writes rows.
  const adminId = '0198c0f0-0000-7000-8000-0000000000a1';
  const mangaId = '0198c0f0-0000-7000-8000-0000000000a2';
  // The id the seed's own derivation produces for this slug/chapter.
  const seededChapterId = chapterIdFor({ slug: SLUG, chapterNumber: CHAPTER_NUMBER });

  // The app-level literals the route's own `loadEnv()` needs, set only when
  // the runner did not provide them and restored in `afterAll` — the same
  // convention `media-delivery.test.ts` uses. Without these the suite fails
  // before any assertion (the composition root reads the real environment).
  // STORAGE_DIR is one of them, not just a `loadEnv` override: driver
  // selection (`selectStorageDriver`) and the filesystem root both read
  // `process.env`, so passing it only inside the `loadEnv` object selects
  // nothing — the suite would write to the shared S3 bucket (or fail with
  // ECONNREFUSED where there is no S3 at all).
  const APP_ENV_DEFAULTS: Record<string, string> = {
    APP_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: '0'.repeat(64),
    NEXT_TELEMETRY_DISABLED: '1',
    // A local root so the suite never writes to the shared S3 bucket.
    STORAGE_DIR: '/tmp/yomi-media-seed-it',
  };
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [name, value] of Object.entries(APP_ENV_DEFAULTS)) {
      if (process.env[name] === undefined) {
        savedEnv[name] = undefined;
        process.env[name] = value;
      }
    }
    open = await openCatalogDatabase(DATABASE_URL as string, 'media_seed_it');
    storage = await createObjectStorageAsync(loadEnv({ ...process.env }));
    deps = { storage, db: open.db };

    await open.db.delete(users).where(eq(users.id, adminId)).catch(() => undefined);
    await open.db.delete(manga).where(eq(manga.id, mangaId)).catch(() => undefined);

    await open.db.insert(users).values({
      id: adminId,
      email: 'seed-media-probe@probe.invalid',
      displayName: 'Probe',
      passwordHash: 'not-a-real-hash',
    });
    await open.db.insert(manga).values({
      id: mangaId,
      slug: SLUG,
      title: 'Seed Delivery Probe',
      status: 'ongoing',
      readingDirection: 'rtl',
      published: true,
    });
    await open.db.insert(chapter).values({
      id: seededChapterId,
      mangaId,
      number: CHAPTER_NUMBER,
      status: 'published',
      publishedAt: NOW,
      pageCount: 1,
      readingOrder: 1,
    });
  });

  afterAll(async () => {
    await open?.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('serves a page whose key the seed minted, from the path the seed wrote', async () => {
    // The two functions under test, called exactly as the seed calls them.
    const assetKey = pageAssetKey({ slug: SLUG, chapterNumber: CHAPTER_NUMBER, pageNumber: 1 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x11, 0x22, 0xff, 0xd9]);

    await open.db.insert(chapterPage).values({
      chapterId: seededChapterId,
      pageNumber: 1,
      assetKey,
      width: 480,
      height: 720,
      byteSizeAvif: jpeg.length,
      byteSizeWebp: jpeg.length,
      byteSizeJpeg: jpeg.length,
    });

    // Where the seed puts the object — the seed's OWN rule, not one this test rebuilds.
    // Rebuilding it here is what let the path regression through: the suite passed while
    // the seed wrote to the bare key. It also agrees with the product helper, which is
    // asserted separately so a change to either one is visible.
    const seedPath = pageObjectPathFor({ slug: SLUG, chapterNumber: CHAPTER_NUMBER, pageNumber: 1, ext: 'jpeg' });
    expect(seedPath).toBe(pageObjectKey(seededChapterId, assetKey, 'jpeg'));
    await storage.putStream(seedPath as AssetKey, streamOf(jpeg), 'image/jpeg');

    const response = await deliverPage(`${assetKey}.jpeg`, deps);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    // Real bytes back, not an error envelope: the JPEG SOI/EOI markers are present.
    expect(body.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(body.subarray(-2).toString('hex')).toBe('ffd9');
    expect(body.length).toBe(jpeg.length);
  });

  it('serves a cover whose key the seed minted, from the path the seed wrote', async () => {
    // The cover half of the same agreement the page test pins: the seed's
    // own derivation, the product object-key builder, and the delivery route
    // must all name the same bytes. The `seed/v1/cover/<digest>` key
    // shape 404s at parse time; this is the regression that stays fixed.
    const coverSlug = 'seed-delivery-probe-cover';
    // The id the seed's own derivation produces for this slug — the same one
    // `coverObjectPathFor` builds its object path from, so the agreement
    // assertion below is an end-to-end check of the derivation chain.
    const coverMangaId = deterministicUuid('manga', coverSlug);
    const key = coverAssetKey({ slug: coverSlug });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x11, 0x22, 0xff, 0xd9]);

    await open.db.delete(manga).where(eq(manga.id, coverMangaId)).catch(() => undefined);
    await open.db.insert(manga).values({
      id: coverMangaId,
      slug: coverSlug,
      title: 'Seed Delivery Probe Cover',
      status: 'ongoing',
      readingDirection: 'ltr',
      published: true,
      coverAssetKey: key,
    });

    // Where the seed puts the object — the seed's OWN rule, not one this test
    // rebuilds. Asserted equal to the product helper so a change to either
    // one is visible, exactly like the page leg above.
    const seedPath = coverObjectPathFor({ slug: coverSlug, ext: 'jpeg' });
    expect(seedPath).toBe(coverObjectKey(coverMangaId, key, 'jpeg'));
    await storage.putStream(seedPath as AssetKey, streamOf(jpeg), 'image/jpeg');

    const response = await deliverPage(`${key}.jpeg`, deps);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(body.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(body.subarray(-2).toString('hex')).toBe('ffd9');

    await open.db.delete(manga).where(eq(manga.id, coverMangaId));
  });

  it('404s a key the delivery grammar rejects, without touching storage', async () => {
    // The seed prefix, kept as the regression this file exists for. A slash in the
    // key is one path segment too many, so the request cannot name an object.
    const slashed = `${randomBytes(16).toString('hex')}/nope`;
    const response = await deliverPage(`${slashed}.jpeg`, deps);

    expect(response.status).toBe(404);
  });

  it('leaves a page with no object behind as a 404, which is what the reader reports', async () => {
    // A row with no object: the state the reader renders honestly instead of a
    // broken image. Asserted so the two stay in agreement.
    const missing = pageAssetKey({ slug: SLUG, chapterNumber: CHAPTER_NUMBER, pageNumber: 7 });
    await open.db.insert(chapterPage).values({
      chapterId: seededChapterId,
      pageNumber: 7,
      assetKey: missing,
      width: 480,
      height: 720,
      byteSizeAvif: 1,
      byteSizeWebp: 1,
      byteSizeJpeg: 1,
    });

    const response = await deliverPage(`${missing}.jpeg`, deps);
    expect(response.status).toBe(404);
  });

  it('deletes its own rows so a re-run cannot collide on the derived ids', async () => {
    await open.db
      .delete(chapterPage)
      .where(and(eq(chapterPage.chapterId, seededChapterId)));
    expect(
      await open.db.select().from(chapterPage).where(eq(chapterPage.chapterId, seededChapterId)),
    ).toHaveLength(0);
  });
});

/** A one-shot ReadableStream over `bytes`, matching how the seed wraps its buffers. */
function streamOf(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

// Type-only assertion kept adjacent to its use: the helper is here to satisfy the port,
// not to be part of the suite's surface.
export type { AssetKey };
