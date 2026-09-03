/**
 * Integration tests — the `/media/{assetKey}` delivery contract, against a REAL
 * S3-compatible server and a REAL PostgreSQL. No mocks: the storage adapter,
 * the DB handle and the route under test are the product's own.
 *
 * The suite SKIPS (never silently passes) when DATABASE_URL is absent; it owns
 * its own rows and objects (a `media-int-` prefix), deleted in `afterAll`.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/server/db';
import { closeDb, createDb } from '../../src/server/db';
import { chapter, chapterPage, manga, sessions, users } from '../../src/server/db';
import { coverObjectKey, createObjectStorage, pageObjectKey } from '../../src/server/storage';
import { loadEnv } from '../../src/shared/validation';
import type { Env } from '../../src/shared/validation';
import { deliverPage } from '../../src/server/media';
import type { MediaDeliveryDeps } from '../../src/server/media';
import { GET, HEAD } from '../../src/app/media/[assetKey]/route';

const DATABASE_URL = process.env['DATABASE_URL'];
const S3_ENDPOINT = process.env['S3_ENDPOINT'];
const S3_BUCKET = process.env['S3_BUCKET'];
const S3_REGION = process.env['S3_REGION'];
const S3_ACCESS_KEY_ID = process.env['S3_ACCESS_KEY_ID'];
const S3_SECRET_ACCESS_KEY = process.env['S3_SECRET_ACCESS_KEY'];

const servicesUp =
  DATABASE_URL !== undefined && S3_ENDPOINT !== undefined && S3_BUCKET !== undefined;
const describeStorage = servicesUp ? describe : describe.skip;

/**
 * The env the product factories get, with the storage block overridable so a
 * test can point a second adapter at a dead endpoint or at bad credentials.
 * Throws if a required variable is missing (the suite skips instead).
 */
function testEnv(overrides: Partial<Env['storage']> = {}): Env {
  const storage: Env['storage'] = {
    endpoint: new URL(S3_ENDPOINT as string),
    region: S3_REGION ?? 'us-east-1',
    bucket: S3_BUCKET ?? 'yomi-media',
    accessKeyId: S3_ACCESS_KEY_ID ?? 'yomi-dev-access-key',
    secretAccessKey: S3_SECRET_ACCESS_KEY ?? 'yomi-dev-secret-key-0001',
    ...overrides,
  };
  return loadEnv({
    NODE_ENV: 'test',
    APP_ORIGIN: 'http://localhost:3000',
    SESSION_SECRET: '0'.repeat(64),
    DATABASE_URL: DATABASE_URL as string,
    NEXT_TELEMETRY_DISABLED: '1',
    S3_ENDPOINT: storage.endpoint.toString(),
    S3_REGION: storage.region,
    S3_BUCKET: storage.bucket,
    S3_ACCESS_KEY_ID: storage.accessKeyId,
    S3_SECRET_ACCESS_KEY: storage.secretAccessKey,
  });
}

/** A 128-bit base64url asset key. */
function randomAssetKey(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * The app-level environment the route's `loadEnv()` needs, with the same
 * throwaway dev literals the compose file ships. The two REAL services
 * (DATABASE_URL, S3_*) must come from the runner.
 */
const APP_ENV_DEFAULTS: Record<string, string> = {
  APP_ORIGIN: 'http://localhost:3000',
  SESSION_SECRET: '0'.repeat(64),
  NEXT_TELEMETRY_DISABLED: '1',
};

/** Variables this file set (restored verbatim in `afterAll`). */
const savedEnv: Record<string, string | undefined> = {};

/** Deterministic image-ish bytes; content is irrelevant to the delivery path. */
function variantBytes(seed: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (seed * 31 + i) % 251;
  return out;
}

const WEBP_TYPE = 'image/webp';
const AVIF_TYPE = 'image/avif';
const JPEG_TYPE = 'image/jpeg';

describeStorage('media delivery contract', () => {
  let env: Env;
  let db: Db;
  let storage: ReturnType<typeof createObjectStorage>;
  let deps: MediaDeliveryDeps;

  /** Per-run isolation prefix for the physical object keys. */
  let runPrefix: string;

  /* Seed ids (uuid-shaped literals: the app never invents them here). */
  const publishedMangaId = '0198c0f0-0000-7000-8000-000000000001';
  const unpublishedMangaId = '0198c0f0-0000-7000-8000-000000000002';
  const publishedChapterId = '0198c0f0-0000-7000-8000-000000000011';
  const draftChapterId = '0198c0f0-0000-7000-8000-000000000012';
  const draftOnPublishedMangaChapterId = '0198c0f0-0000-7000-8000-000000000013';

  const publishedPageKey = randomAssetKey();
  const draftPageKey = randomAssetKey();
  const draftOnPublishedMangaPageKey = randomAssetKey();
  const coverKey = randomAssetKey();

  const adminToken = randomBytes(32).toString('base64url');
  const readerToken = randomBytes(32).toString('base64url');
  const adminId = '0198c0f0-0000-7000-8000-0000000000a1';
  const readerId = '0198c0f0-0000-7000-8000-0000000000a2';

  beforeAll(async () => {
    // The route handler reads the real process environment (the composition
    // root is still a skeleton, so the route calls `loadEnv()` itself). These
    // three are the app-level literals from docker/docker-compose.dev.yml, set
    // only if the runner did not provide them, and restored in `afterAll`.
    for (const [name, value] of Object.entries(APP_ENV_DEFAULTS)) {
      if (process.env[name] === undefined) {
        savedEnv[name] = undefined;
        process.env[name] = value;
      }
    }

    env = testEnv();
    db = await createDb(env);
    storage = createObjectStorage(env);
    deps = { storage, db };
    runPrefix = `media-int-${randomBytes(6).toString('hex')}`;

    const now = new Date();
    const in90d = new Date(now.getTime() + 90 * 24 * 3600 * 1000);

    // Re-runnable: clear this file's own fixed-id rows first, so a run that was
    // killed before `afterAll` cannot make the next run fail on a duplicate
    // key. Scoped to the ids below — never a truncate (other suites share one
    // fork, and CI gives each job its own database).
    await db.delete(users).where(eq(users.id, adminId)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, readerId)).catch(() => undefined);
    await db.delete(manga).where(eq(manga.id, publishedMangaId)).catch(() => undefined);
    await db.delete(manga).where(eq(manga.id, unpublishedMangaId)).catch(() => undefined);

    await db.insert(users).values([
      {
        id: adminId,
        email: 'media-int-admin@example.invalid',
        displayName: 'admin',
        // Argon2id hash of a throwaway value; never used to authenticate here
        // (the session cookie is the identity).
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'admin',
        status: 'active',
      },
      {
        id: readerId,
        email: 'media-int-reader@example.invalid',
        displayName: 'reader',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$aaaa$bbbb',
        role: 'reader',
        status: 'active',
      },
    ]);

    await db.insert(sessions).values([
      {
        userId: adminId,
        sessionToken: adminToken,
        createdAt: now,
        expiresAt: in90d,
        absoluteExpiresAt: in90d,
      },
      {
        userId: readerId,
        sessionToken: readerToken,
        createdAt: now,
        expiresAt: in90d,
        absoluteExpiresAt: in90d,
      },
    ]);

    await db.insert(manga).values([
      {
        id: publishedMangaId,
        slug: `${runPrefix}-published`,
        title: 'Media integration — published',
        published: true,
        coverAssetKey: coverKey,
      },
      {
        id: unpublishedMangaId,
        slug: `${runPrefix}-unpublished`,
        title: 'Media integration — unpublished',
        published: false,
        coverAssetKey: null,
      },
    ]);

    await db.insert(chapter).values([
      {
        id: publishedChapterId,
        mangaId: publishedMangaId,
        number: '1',
        status: 'published',
        publishedAt: now,
        pageCount: 1,
        readingOrder: 1,
      },
      {
        // Draft chapter of a PUBLISHED manga — the draft-key 404 case.
        id: draftChapterId,
        mangaId: publishedMangaId,
        number: '2',
        status: 'draft',
        pageCount: 1,
        readingOrder: 2,
      },
      {
        // Published chapter of an UNPUBLISHED manga — also not public.
        id: draftOnPublishedMangaChapterId,
        mangaId: unpublishedMangaId,
        number: '1',
        status: 'published',
        publishedAt: now,
        pageCount: 1,
        readingOrder: 1,
      },
    ]);

    await db.insert(chapterPage).values([
      {
        chapterId: publishedChapterId,
        pageNumber: 1,
        assetKey: publishedPageKey,
        width: 800,
        height: 1200,
        byteSizeAvif: 40_000,
        byteSizeWebp: 50_000,
        byteSizeJpeg: 90_000,
      },
      {
        chapterId: draftChapterId,
        pageNumber: 1,
        assetKey: draftPageKey,
        width: 800,
        height: 1200,
        byteSizeAvif: 41_000,
        byteSizeWebp: 51_000,
        byteSizeJpeg: 91_000,
      },
      {
        chapterId: draftOnPublishedMangaChapterId,
        pageNumber: 1,
        assetKey: draftOnPublishedMangaPageKey,
        width: 800,
        height: 1200,
        byteSizeAvif: 42_000,
        byteSizeWebp: 52_000,
        byteSizeJpeg: 92_000,
      },
    ]);

    // Real objects, one per delivery format.
    for (const [format, contentType] of [
      ['avif', AVIF_TYPE],
      ['webp', WEBP_TYPE],
      ['jpeg', JPEG_TYPE],
    ] as const) {
      await storage.putStream(
        pageObjectKey(publishedChapterId, publishedPageKey, format),
        bytesToStream(variantBytes(format.length, 4096)),
        contentType,
        4096,
      );
    }
    for (const [format, contentType] of [
      ['webp', WEBP_TYPE],
      ['jpeg', JPEG_TYPE],
    ] as const) {
      await storage.putStream(
        coverObjectKey(publishedMangaId, coverKey, format),
        bytesToStream(variantBytes(format.length, 2048)),
        contentType,
        2048,
      );
    }
    await storage.putStream(
      pageObjectKey(draftChapterId, draftPageKey, 'avif'),
      bytesToStream(variantBytes(1, 1024)),
      AVIF_TYPE,
      1024,
    );
    await storage.putStream(
      pageObjectKey(draftOnPublishedMangaChapterId, draftOnPublishedMangaPageKey, 'avif'),
      bytesToStream(variantBytes(5, 1024)),
      AVIF_TYPE,
      1024,
    );
  });

  afterAll(async () => {
    for (const [name, previous] of Object.entries(savedEnv)) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    if (db === undefined) return;
    // Rows first (the chapter_page/chapter rows cascade from their parents),
    // then the objects this file created — never a truncate: other suites share
    // one fork (vitest.config.ts `singleFork`).
    await db.delete(users).where(eq(users.id, adminId)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, readerId)).catch(() => undefined);
    await db.delete(manga).where(eq(manga.id, publishedMangaId)).catch(() => undefined);
    await db.delete(manga).where(eq(manga.id, unpublishedMangaId)).catch(() => undefined);
    for (const key of [
      pageObjectKey(publishedChapterId, publishedPageKey, 'avif'),
      pageObjectKey(publishedChapterId, publishedPageKey, 'webp'),
      pageObjectKey(publishedChapterId, publishedPageKey, 'jpeg'),
      pageObjectKey(draftChapterId, draftPageKey, 'avif'),
      pageObjectKey(draftOnPublishedMangaChapterId, draftOnPublishedMangaPageKey, 'avif'),
      coverObjectKey(publishedMangaId, coverKey, 'webp'),
      coverObjectKey(publishedMangaId, coverKey, 'jpeg'),
    ]) {
      await storage.delete(key).catch(() => undefined);
    }
    await closeDb(db);
  });

  it('getStream returns the stored bytes, content type and length; unknown key is a typed not-found', async () => {
    const key = pageObjectKey(publishedChapterId, publishedPageKey, 'webp');
    const result = await storage.getStream(key);
    expect(result.contentType).toBe(WEBP_TYPE);
    expect(result.byteLength).toBe(4096);
    const body = await readAll(result.stream);
    expect(body.byteLength).toBe(4096);
    expect(body).toEqual(variantBytes('webp'.length, 4096));
    await expect(storage.getStream(pageObjectKey(publishedChapterId, randomAssetKey(), 'avif'))).rejects.toThrow(
      /not found/i,
    );
  });

  it('head/exists/delete round-trip on a real object', async () => {
    const key = pageObjectKey(publishedChapterId, publishedPageKey, 'jpeg');
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.head(key)).toEqual({ contentType: JPEG_TYPE, byteLength: 4096 });
    expect(await storage.head(pageObjectKey(publishedChapterId, randomAssetKey(), 'jpeg'))).toBeNull();
    expect(await storage.exists(pageObjectKey(publishedChapterId, randomAssetKey(), 'jpeg'))).toBe(false);

    const scratch = pageObjectKey(publishedChapterId, randomAssetKey(), 'jpeg');
    await storage.putStream(scratch, bytesToStream(variantBytes(9, 128)), JPEG_TYPE, 128);
    expect(await storage.exists(scratch)).toBe(true);
    await storage.delete(scratch);
    expect(await storage.exists(scratch)).toBe(false);
    // Delete of an absent key is a no-op success (idempotent).
    await expect(storage.delete(scratch)).resolves.toBeUndefined();
  });

  it('putStream with an UNKNOWN length spools through the filesystem and still streams', async () => {
    const key = pageObjectKey(publishedChapterId, randomAssetKey(), 'jpeg');
    // No contentLength: the adapter must discover the length without buffering
    // the object in memory ("streaming put").
    await storage.putStream(key, bytesToStream(variantBytes(3, 7777)), JPEG_TYPE);
    expect(await storage.head(key)).toEqual({ contentType: JPEG_TYPE, byteLength: 7777 });
    const read = await storage.getStream(key);
    expect((await readAll(read.stream)).byteLength).toBe(7777);
    await storage.delete(key);
  });

  it('presignPartUpload produces a URL the storage server accepts for a real PUT', async () => {
    const key = pageObjectKey(publishedChapterId, randomAssetKey(), 'jpeg');
    const body = variantBytes(21, 4096);
    // `Uint8Array<ArrayBuffer>` so it is a legal `BodyInit` for fetch.
    const payload: ArrayBuffer = new Uint8Array(body).buffer;
    const url = await storage.presignPartUpload(key, 1, 5 * 1024 * 1024);

    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=900');
    expect(url).toContain('partNumber=1');
    // A presigned URL is a bearer capability: it is scoped to this exact key
    // (the request path keeps its slashes; only the SIGNED form encodes them).
    expect(url).toContain(key);
    expect(url.startsWith(`${S3_ENDPOINT}/yomi-media/${key}?`)).toBe(true);

    // The signature is real, not just well shaped: a PUT through the signed
    // URL is accepted by the server and the object lands (a URL no S3-compatible
    // server accepts is a signing bug, not a formatting one).
    const put = await fetch(url, { method: 'PUT', body: payload });
    expect(put.status).toBe(200);
    // The signed URL wrote the exact bytes under the exact key.
    expect((await storage.head(key))?.byteLength).toBe(4096);

    // Tampering with the signed part number must break it.
    const tampered = url.replace('partNumber=1', 'partNumber=2');
    const bad = await fetch(tampered, { method: 'PUT', body: payload });
    expect(bad.status).toBe(403);

    await storage.delete(key);
  });

  it('serves a page variant with the STORED format content type, length, ETag and immutable headers', async () => {
    for (const [format, contentType] of [
      ['avif', AVIF_TYPE],
      ['webp', WEBP_TYPE],
      ['jpeg', JPEG_TYPE],
    ] as const) {
      const response = await deliverPage(`${publishedPageKey}.${format}`, deps);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(contentType);
      expect(response.headers.get('content-length')).toBe('4096');
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-disposition')).toBe('inline');
      const etag = response.headers.get('etag');
      expect(etag).toMatch(/^(W\/)?"[A-Za-z0-9_.-]{1,200}"$/);
      expect(etag).not.toBeNull();
      const body = await readAll(response.body as ReadableStream<Uint8Array>);
      expect(body.byteLength).toBe(4096);
    }
  });

  it('serves a cover variant from the manga cover key', async () => {
    const response = await deliverPage(`${coverKey}.webp`, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(WEBP_TYPE);
    expect((await readAll(response.body as ReadableStream<Uint8Array>)).byteLength).toBe(2048);
  });

  it('unknown key → 404 with no asset metadata and a short cache lifetime', async () => {
    const started = performance.now();
    const response = await deliverPage(`${randomAssetKey()}.avif`, deps);
    const elapsed = performance.now() - started;
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toMatch(/NOT_FOUND$/);
    expect(body.error.message).not.toContain(runPrefix);
    expect(response.headers.get('cache-control')).not.toContain('immutable');
    // "Cheap 404" is a contract clause: an indexed miss, not a storage
    // round trip. 250 ms is a wide ceiling for one btree miss.
    expect(elapsed).toBeLessThan(250);
  });

  it('malformed key → 404 (not 422) and the format gate runs BEFORE any storage I/O', async () => {
    const deadDeps: MediaDeliveryDeps = {
      ...deps,
      // Storage that cannot answer anything: a malformed key must still 404
      // from the format gate alone, which is what makes the 404 cheap.
      storage: createObjectStorage(testEnv({ endpoint: new URL('http://127.0.0.1:1') })),
    };
    for (const malformed of ['short.avif', `${publishedPageKey}.gif`, '../etc/passwd', '', 'a'.repeat(65) + '.avif']) {
      const response = await deliverPage(malformed, deadDeps);
      expect(response.status, `key ${JSON.stringify(malformed)}`).toBe(404);
    }
  });

  it('draft page key → 404 anonymous, 404 for a reader, 200 for an admin', async () => {
    const key = `${draftPageKey}.avif`;
    const anonymous = await deliverPage(key, deps);
    expect(anonymous.status).toBe(404);

    const asReader = await deliverPage(key, { ...deps, cookieHeader: `yomi_session=${readerToken}` });
    expect(asReader.status).toBe(404);

    const asAdmin = await deliverPage(key, { ...deps, cookieHeader: `yomi_session=${adminToken}` });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.headers.get('content-type')).toBe(AVIF_TYPE);
    expect((await readAll(asAdmin.body as ReadableStream<Uint8Array>)).byteLength).toBe(1024);
  });

  it('page of a published chapter in an UNPUBLISHED manga → 404 (non-admin), 200 (admin)', async () => {
    const key = `${draftOnPublishedMangaPageKey}.avif`;
    expect((await deliverPage(key, deps)).status).toBe(404);
    expect((await deliverPage(key, { ...deps, cookieHeader: `yomi_session=${adminToken}` })).status).toBe(200);
  });

  it('an unknown or expired session cookie is treated as anonymous (no 403, no leak)', async () => {
    const key = `${draftPageKey}.avif`;
    for (const cookieHeader of [
      'yomi_session=not-a-real-token',
      'yomi_session=',
      `other=${adminToken}`,
      '',
    ]) {
      const response = await deliverPage(key, { ...deps, cookieHeader });
      expect(response.status, cookieHeader).toBe(404);
    }
  });

  it('1000 random keys all 404 (enumeration fuzz)', async () => {
    const keys = Array.from({ length: 1000 }, () => `${randomAssetKey()}.webp`);
    const statuses = await Promise.all(keys.map((key) => deliverPage(key, deps).then((r) => r.status)));
    expect(statuses.filter((status) => status === 404)).toHaveLength(1000);
  });

  it('GET /media/[assetKey] serves bytes with the full header contract and echoes x-request-id', async () => {
    const requestId = 'int-media-001-request-id';
    const response = await routeGet(`${publishedPageKey}.avif`, { 'x-request-id': requestId });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(AVIF_TYPE);
    expect(response.headers.get('content-length')).toBe('4096');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('etag')).toBe(`W/"${publishedPageKey}.4096"`);
    expect(response.headers.get('x-request-id')).toBe(requestId);
    expect((await readAll(response.body as ReadableStream<Uint8Array>)).byteLength).toBe(4096);
  });

  it('GET /media/[assetKey]: draft key 404 anonymous, 200 for the admin cookie', async () => {
    const anonymous = await routeGet(`${draftPageKey}.avif`);
    expect(anonymous.status).toBe(404);
    expect(anonymous.headers.get('etag')).toBeNull();
    // The body of a 404 says nothing about the asset.
    expect(await anonymous.text()).not.toContain(draftPageKey);

    const asAdmin = await routeGet(`${draftPageKey}.avif`, { cookie: `yomi_session=${adminToken}` });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.headers.get('content-type')).toBe(AVIF_TYPE);
    expect((await readAll(asAdmin.body as ReadableStream<Uint8Array>)).byteLength).toBe(1024);
  });

  it('GET /media/[assetKey] 404s an unknown key and a malformed key alike', async () => {
    expect((await routeGet(`${randomAssetKey()}.jpeg`)).status).toBe(404);
    expect((await routeGet('nope.avif')).status).toBe(404);
    expect((await routeGet(`${publishedPageKey}.tiff`)).status).toBe(404);
  });

  it('HEAD mirrors the GET headers with no body', async () => {
    const head = await routeHead(`${publishedPageKey}.webp`);
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(WEBP_TYPE);
    expect(head.headers.get('content-length')).toBe('4096');
    expect(head.body).toBeNull();
  });

  it('storage unreachable → 502 STORAGE_ERROR with Retry-After and nothing leaked', async () => {
    const deadDeps: MediaDeliveryDeps = {
      ...deps,
      storage: createObjectStorage(testEnv({ endpoint: new URL('http://127.0.0.1:1') })),
    };
    const response = await deliverPage(`${publishedPageKey}.avif`, deadDeps);
    expect(response.status).toBe(502);
    expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const raw = await response.text();
    const body = JSON.parse(raw) as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe('STORAGE_ERROR');
    expect(body.error.message).toBe('Storage is temporarily unavailable.');
    // Nothing that identifies the origin may appear.
    for (const secretish of [
      S3_BUCKET as string,
      S3_ENDPOINT as string,
      'yomi-dev',
      'pages/',
      'covers/',
      publishedChapterId,
      publishedPageKey,
      'ECONNREFUSED',
      '127.0.0.1',
    ]) {
      expect(raw, `leaked ${secretish}`).not.toContain(secretish);
    }
  });

  it('storage rejecting the credentials → 502 STORAGE_ERROR, vendor XML never passes through', async () => {
    const wrongCredsDeps: MediaDeliveryDeps = {
      ...deps,
      storage: createObjectStorage(
        testEnv({ accessKeyId: 'wrong-access-key', secretAccessKey: 'wrong-secret-key' }),
      ),
    };
    const response = await deliverPage(`${publishedPageKey}.avif`, wrongCredsDeps);
    expect(response.status).toBe(502);
    const raw = await response.text();
    const body = JSON.parse(raw) as { error: { code: string } };
    expect(body.error.code).toBe('STORAGE_ERROR');
    for (const leak of ['<Error>', 'AccessDenied', 'SignatureDoesNotMatch', 'InvalidAccessKeyId', 'yomi-media']) {
      expect(raw, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it('getStream does not materialise the object: bounded bytes held at any moment', async () => {
    const totalBytes = 96 * 1024 * 1024;
    const chunkSize = 1024 * 1024;
    const key = pageObjectKey(publishedChapterId, randomAssetKey(), 'jpeg');
    await storage.putStream(
      key,
      repeatingStream(totalBytes, chunkSize),
      JPEG_TYPE,
      totalBytes,
    );

    const before = process.memoryUsage().heapUsed;
    const result = await storage.getStream(key);
    // getStream resolves on the response HEADERS, not on the body.
    const afterOpen = process.memoryUsage().heapUsed;
    expect(afterOpen - before).toBeLessThan(totalBytes / 4);

    const reader = result.stream.getReader();
    let received = 0;
    let chunks = 0;
    let held = 0;
    let peakHeld = 0;
    let peakHeap = afterOpen;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      received += value.byteLength;
      held += value.byteLength;
      peakHeld = Math.max(peakHeld, held);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      held = 0; // the chunk is dropped at the end of the loop body
    }
    expect(received).toBe(totalBytes);
    // Many chunks, each far smaller than the object: nothing was assembled.
    expect(chunks).toBeGreaterThan(16);
    // Bytes alive at once stay in the "chunk" scale, not the "object" scale.
    expect(peakHeld).toBeLessThanOrEqual(4 * 1024 * 1024);
    // And the heap never grew by anything like the object size.
    expect(peakHeap - before).toBeLessThan(totalBytes / 2);

    await storage.delete(key);
  });
});

/**
 * Calls the PRODUCT route handler with a real `Request`. The route builds its
 * own storage/db from `loadEnv()` (the composition root is still a skeleton),
 * so the variables the suite runs with are what it reads — no test-only
 * injection seam on the delivery path.
 */
async function routeGet(
  assetKey: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return GET(
    new Request(`http://localhost:3000/media/${assetKey}`, { headers }),
    { params: Promise.resolve({ assetKey }) },
  );
}

async function routeHead(assetKey: string, headers: Record<string, string> = {}): Promise<Response> {
  return HEAD(new Request(`http://localhost:3000/media/${assetKey}`, { headers }), {
    params: Promise.resolve({ assetKey }),
  });
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A generator-backed source of `total` bytes in `chunk` slices. */
function repeatingStream(total: number, chunk: number): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const buf = new Uint8Array(chunk).fill(0x5a);
      for (let sent = 0; sent < total; sent += chunk) {
        yield sent + chunk <= total ? buf : buf.subarray(0, total - sent);
      }
    },
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    length += value.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
