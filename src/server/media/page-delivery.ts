/**
 * server/media — page/cover DELIVERY (the /media/{assetKey} contract).
 * Resolves an asset key -> DB lookup -> storage stream, Content-Type per STORED
 * format, never the original filename. Unknown/draft/deleted keys are 404,
 * storage failures are 502 and never leak vendor XML, and content is streamed
 * (never buffered) then cached immutably per key for a year.
 */
import { AppError, toRouteError } from '../../shared/contracts/errors';
import type { ErrorCode } from '../../shared/contracts/errors';
import { isMangaVisible } from '../../features/manga';
import type { DeliveryFormat, ObjectStoragePort } from '../../shared/contracts/ports';
import type { AssetKey } from '../../shared/types';
import type { Db } from '../db';
import { coverObjectKey, ObjectNotFoundError, pageObjectKey } from '../storage';
import type { StorageCallOptions } from '../storage';
import { callerIsAdmin } from './session-role';
import type { Logger } from '../telemetry/logger';

/** A processed asset never changes again. */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * A 404 is cacheable for a few seconds only: a draft that is published seconds
 * later must stop 404-ing, and an unknown key must not be cached for a year.
 */
export const MEDIA_NOT_FOUND_CACHE_CONTROL = 'public, max-age=5, must-revalidate';

/** A 502 must never be cached by anything. */
export const MEDIA_ERROR_CACHE_CONTROL = 'no-store';

/** Retry hint for a 502: the origin is expected back within seconds. */
export const MEDIA_RETRY_AFTER_SECONDS = '5';

/** Content type per STORED format. */
const FORMAT_CONTENT_TYPE: Readonly<Record<DeliveryFormat, string>> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
};
/** The delivery key grammar: opaque key + stored extension. */
const DELIVERY_KEY_PATTERN = /^([A-Za-z0-9_-]{22,64})\.(avif|webp|jpeg)$/;

/** The parsed delivery key. */
export interface DeliveryKey {
  /** The opaque key, exactly as `chapter_page.asset_key` / `cover_asset_key`. */
  readonly assetKey: AssetKey;
  /** The stored variant, taken from the key, never from the request. */
  readonly format: DeliveryFormat;
}

/**
 * Parses the path key. `null` ⇒ the caller must 404 (never 422: an unguessable
 * key is a capability, and telling a prober "that is not even a key" is a
 * free oracle).
 */
export function parseDeliveryKey(raw: string): DeliveryKey | null {
  const match = DELIVERY_KEY_PATTERN.exec(raw);
  if (match === null) return null;
  return { assetKey: match[1] as AssetKey, format: match[2] as DeliveryFormat };
}

/**
 * The port plus the adapter's per-call abort seam. The declared
 * `ObjectStoragePort.getStream` takes one argument; the adapter accepts an
 * optional second one (see `StorageCallOptions`), and widening a method with
 * OPTIONAL parameters keeps the port type satisfied.
 */
export interface MediaStorage extends ObjectStoragePort {
  getStream(
    key: AssetKey,
    options?: StorageCallOptions,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string; byteLength: number }>;
}

/** Everything {@link deliverPage} needs; injected so the route stays thin. */
export interface MediaDeliveryDeps {
  /** The S3 adapter. */
  readonly storage: MediaStorage;
  /** The database handle — the asset index lives in PostgreSQL. */
  readonly db: Db;
  /**
   * The request's raw `Cookie` header. The draft rule needs the caller's ROLE;
   * the cookie is the only identity source. Absent ⇒ anonymous.
   */
  readonly cookieHeader?: string | undefined;
  /** Aborts the origin fetch when the client disconnects. */
  readonly signal?: AbortSignal | undefined;
  /** Correlates the failure line. */
  readonly requestId?: string | undefined;
  /** Optional: without it the module stays silent (tests, scripts). */
  readonly logger?: Logger | undefined;
}

/** What the index says about a key, before any storage call. */
type ResolvedAsset =
  | {
      readonly kind: 'page';
      readonly chapterId: string;
      readonly objectKey: AssetKey;
      /** Not visible to the public (draft chapter, or hidden manga). */
      readonly restricted: boolean;
      readonly notFoundCode: ErrorCode;
    }
  | {
      readonly kind: 'cover';
      readonly objectKey: AssetKey;
      readonly restricted: boolean;
      readonly notFoundCode: ErrorCode;
    };

/**
 * Resolves the opaque key to its physical object, or `null` when nothing in
 * the index claims it.
 *
 * Query shape: `chapter_page` by `asset_key` (unique index), then `chapter` and
 * `manga` by PK. The `manga.cover_asset_key` leg runs only when the page lookup
 * missed and is a sequential scan because no index exists on that column; it is
 * bounded to the cover path and the result is cached for a year, but an index is
 * the documented follow-up.
 *
 * The queries go through the Drizzle *relational* API with the operators handed
 * to the callback, so this module imports no SQL helper package and every value
 * stays a bind parameter.
 */
async function resolveAsset(db: Db, key: DeliveryKey): Promise<ResolvedAsset | null> {
  const page = await db.query.chapterPage.findFirst({
    where: (fields, { eq }) => eq(fields.assetKey, key.assetKey),
    columns: { chapterId: true },
  });

  if (page !== undefined) {
    const row = await db.query.chapter.findFirst({
      where: (fields, { eq }) => eq(fields.id, page.chapterId),
      columns: { id: true, mangaId: true, status: true, deletedAt: true },
    });
    // A page row whose chapter is gone cannot happen (FK CASCADE) but must not
    // become a 500 if it ever does.
    if (row === undefined) return null;
    const owner = await db.query.manga.findFirst({
      where: (fields, { eq }) => eq(fields.id, row.mangaId),
      columns: { id: true, published: true, deletedAt: true },
    });
    const restricted =
      row.status !== 'published' ||
      row.deletedAt !== null ||
      owner === undefined ||
      // The manga visibility rule is defined ONCE, in features/manga. This is a
      // call into it, not a second copy of the predicate.
      !isMangaVisible(owner);
    return {
      kind: 'page',
      chapterId: row.id,
      objectKey: pageObjectKey(row.id, key.assetKey, key.format),
      restricted,
      notFoundCode: 'CHAPTER_NOT_FOUND',
    };
  }

  // Cover leg: unindexed, bounded.
  const cover = await db.query.manga.findFirst({
    where: (fields, { eq }) => eq(fields.coverAssetKey, key.assetKey),
    columns: { id: true, published: true, deletedAt: true },
  });
  if (cover === undefined) return null;
  return {
    kind: 'cover',
    objectKey: coverObjectKey(cover.id, key.assetKey, key.format),
    restricted: !isMangaVisible(cover), // one definition, in features/manga
    notFoundCode: 'MANGA_NOT_FOUND',
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * The error envelope, built from the frozen mapping table only — never from a
 * cause, a vendor message, or a key.
 */
function errorResponse(error: AppError, requestId: string, headers: Record<string, string>): Response {
  const mapped = toRouteError(error, requestId);
  return jsonResponse(mapped.httpStatus, mapped.body, {
    'x-content-type-options': 'nosniff',
    'cache-control': MEDIA_ERROR_CACHE_CONTROL,
    ...headers,
  });
}

/** 404: no asset metadata, nothing that says whether a key once existed. */
function notFoundResponse(code: ErrorCode, requestId: string): Response {
  return errorResponse(new AppError(code), requestId, {
    'cache-control': MEDIA_NOT_FOUND_CACHE_CONTROL,
  });
}

/** 502: retry-friendly (Retry-After), never cached, never explained. */
function storageErrorResponse(requestId: string, logger: Logger | undefined): Response {
  logger?.error(
    { requestId, route: '/media/[assetKey]', code: 'STORAGE_ERROR' },
    'media delivery: storage unavailable',
  );
  return errorResponse(new AppError('STORAGE_ERROR'), requestId, {
    'retry-after': MEDIA_RETRY_AFTER_SECONDS,
  });
}

/**
 * Delivers one page/cover variant.
 *
 * @param assetKey the raw path segment (still URL-encoded by the framework).
 * @param deps the injected storage/db/caller context.
 * @returns a 200 byte stream, a 404, a 502, or a 500 — never an exception.
 */
export async function deliverPage(assetKey: string, deps: MediaDeliveryDeps): Promise<Response> {
  const requestId = deps.requestId ?? 'unknown';

  // 1. Grammar gate — no I/O, so a malformed key is a cheap 404 even while the
  //    origin is down.
  const key = parseDeliveryKey(assetKey);
  if (key === null) return notFoundResponse('MANGA_NOT_FOUND', requestId);

  // 2. Asset index — one indexed lookup for a page key, a bounded cover leg
  //    after that — and 3. the draft rule, which is a second indexed read of the
  //    session. Both are database work, so both share the same failure answer: a
  //    500. A database outage is not a storage outage and has no dedicated code,
  //    so INTERNAL_ERROR — the table's own "unhandled" row — is the mapping.
  let asset: ResolvedAsset | null;
  let visible: boolean;
  try {
    asset = await resolveAsset(deps.db, key);
    visible =
      asset === null ||
      !asset.restricted ||
      (await callerIsAdmin(deps.db, deps.cookieHeader));
  } catch (cause) {
    deps.logger?.error(
      { requestId, route: '/media/[assetKey]', code: 'INTERNAL_ERROR' },
      'media delivery: asset index lookup failed',
    );
    return errorResponse(new AppError('INTERNAL_ERROR', { cause }), requestId, {});
  }

  // 3. Unknown key ⇒ 404. Draft/restricted ⇒ 404 unless the caller is an admin.
  //    An unknown key and a restricted one are indistinguishable from outside:
  //    same status, same body shape, same short cache lifetime.
  if (asset === null) return notFoundResponse('MANGA_NOT_FOUND', requestId);
  if (!visible) return notFoundResponse(asset.notFoundCode, requestId);

  // 4. Stream. Nothing is buffered: the response body IS the origin stream.
  let opened: Awaited<ReturnType<MediaStorage['getStream']>>;
  try {
    opened = await deps.storage.getStream(asset.objectKey, { signal: deps.signal });
  } catch (cause) {
    if (cause instanceof ObjectNotFoundError) {
      // The index says it exists but the origin does not have it: a partial
      // ingest or a purged object. Same answer as an unknown key — 404.
      return notFoundResponse(asset.notFoundCode, requestId);
    }
    return storageErrorResponse(requestId, deps.logger);
  }

  const expectedType = FORMAT_CONTENT_TYPE[key.format];
  if (opened.contentType !== expectedType) {
    // The stored object disagrees with the format its key names. The response
    // is still typed from the KEY (never from the object's own header, which
    // a writer could have set to anything), and the disagreement is a data bug
    // worth a line — the object key itself is not logged.
    deps.logger?.warn(
      { requestId, route: '/media/[assetKey]', format: key.format, asset: asset.kind },
      'media delivery: stored content type does not match the stored format',
    );
  }

  return new Response(opened.stream, {
    status: 200,
    headers: {
      'content-type': expectedType,
      'content-length': String(opened.byteLength),
      // Weak on purpose: a key's bytes never change, but they were never hashed.
      etag: `W/"${key.assetKey}.${opened.byteLength}"`,
      'cache-control': MEDIA_CACHE_CONTROL,
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    },
  });
}
