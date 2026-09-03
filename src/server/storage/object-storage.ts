/**
 * server/storage — ObjectStoragePort implementation (S3 protocol).
 *
 * Responsibility: the S3 adapter (R2 / AWS S3 / RustFS-in-dev behind one port
 * — ADR-004): streaming put/get (NEVER buffer whole objects), head/exists/
 * delete, multipart presign (server-internal, exact-key scoped, 15 min),
 * and the readyz canary (DEPLOYMENT.md §4).
 *
 * Requirements: ADR-004, FR-MEDIA-003 (private bucket, no layout leak),
 * NFR-SEC-009/010, THREAT T-11/T-13.
 * Tasks: T-UPLOAD-005 (variant writes), T-CATALOG-010 (delivery half of the
 * port: put/get/exists/delete/head/presign), T-UPLOAD-008 (presign use),
 * T-OBS-004 (readyz canary).
 *
 * ── SLICE EXCEPTION (T-CATALOG-010 executed inside VS-1) ──────────────────
 * TASKS.md declares `Depends on: T-UPLOAD-006 (storage writes)`, and
 * T-UPLOAD-006 sits in VS-7 — *after* VS-1 — while VS-1's own exit criteria
 * name "covers served with correct caching" and INT-MEDIA-001. This is the
 * same kind of pull-forward ROADMAP.md:51 already records for VS-4
 * ("documented exception, slice-scoped"): the DELIVERY half of the storage
 * port lands in VS-1. VS-7 still owns T-UPLOAD-005 (variant writes),
 * T-UPLOAD-006 (job orchestration), T-UPLOAD-008 (presign *use*),
 * T-UPLOAD-011 (cover-variant generation) and the whole intake. Nothing here
 * ingests a file or decodes an image: this file is the transport, and it is
 * the same transport VS-7 will call.
 *
 * Rules:
 * - ONLY module allowed to import @aws-sdk/* (rule D3).
 * - Physical keys are built HERE and nowhere else (ADR-004 layout:
 *   `pages/{chapterId}/{key}.{ext}`, `covers/{mangaId}.{ext}`,
 *   `staging/{jobId}/…` for T-UPLOAD-006). Callers outside the module pass
 *   the opaque key around; the HTTP client only ever sees that opaque key
 *   (FR-MEDIA-003), so the layout never crosses the trust boundary.
 * - Streaming: getStream hands back a ReadableStream straight from the SDK;
 *   no intermediate buffer (PERFORMANCE.md §4).
 * - Errors map to STORAGE_ERROR (502) — vendor XML never passes through
 *   (NFR-SEC-010; THREAT T-11 verification).
 * - Credentials from Env only (T-13); nothing in this file logs.
 *
 * ── Ambiguities found while implementing, and the choice made ──────────────
 * A1. `putStream(key, stream, contentType)` has no length parameter, but S3
 *     PutObject needs a `Content-Length` unless the origin accepts
 *     `aws-chunked`. Measured 2026-09-27 against `rustfs/rustfs:1.0.0` (the
 *     compose slot, T-FOUND-010's documented MinIO substitution): it does NOT
 *     — a length-less body fails with `MissingContentLength` /
 *     `x-amz-decoded-content-length` undefined. Choice: the adapter takes an
 *     OPTIONAL fourth argument `contentLength`, so a caller that knows the
 *     size (T-UPLOAD-005 has sharp's byte counts; page variants are ≤ 1 MB)
 *     uploads with zero copies. A caller that does not is spooled to a
 *     temporary FILE — never to memory — so "never buffer whole objects"
 *     (ADR-004) holds on both paths. `ObjectStoragePort` is unchanged: a
 *     function with extra OPTIONAL parameters is assignable to the
 *     3-parameter port type, so every caller holding the port type still
 *     passes three arguments. spec-question for `shared/contracts/ports.ts`:
 *     the port itself should carry `contentLength`.
 * A2. `presignPartUpload` needs `@aws-sdk/s3-request-presigner`, which is NOT
 *     in the dependency registry (docs/research/2026-stack-validation.md lists
 *     `@aws-sdk/client-s3` only) and `package.json` is outside this task's
 *     write scope, so importing it would be an unreviewed dependency
 *     (AGENTS.md §4.4). Choice: SigV4 query-string presigning with
 *     `node:crypto` — a fixed, vendor-neutral algorithm — verified against the
 *     real dev server by a PUT through the signed URL. Exact-key, PUT-only,
 *     15 minutes (FR-UPLOAD-008, T-13: server-internal, never a browser URL).
 * A3. The port has no `uploadId` parameter, but an S3 *part* URL is only
 *     meaningful with the upload it belongs to. Choice: an OPTIONAL fourth
 *     argument; without it the URL signs a single PUT of that exact key
 *     (still exact-key, PUT-only, short-lived), with it the URL is scoped to
 *     that part of that upload. T-UPLOAD-008 owns the multipart flow; the
 *     caller's `partSizeBytes` is recorded in the header comment rather than
 *     smuggled into a fabricated upload id.
 * A4. `getStream` cannot see the origin ETag (the port returns only
 *     contentType + byteLength), so `server/media` derives a weak ETag from
 *     the immutable key + stored length. See src/server/media/page-delivery.ts.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../shared/contracts/errors';
import type { ObjectStoragePort } from '../../shared/contracts/ports';
import type { AssetKey } from '../../shared/types';
import type { Env } from '../../shared/validation';

/* ── layout (ADR-004): re-exported, not duplicated ───────────────────────────
 *
 * The key builders lived here until F-017-S1, when the ingest service needed
 * the same rule and D1 forbids `features/*` from importing `server/*`. They
 * are pure string rules with no infrastructure in them, so they moved to
 * `shared/storage-keys.ts` — one implementation, two importers. This
 * re-export keeps every existing server import working with no second copy of
 * the rule anywhere; grep for a second `pages/` template before believing
 * otherwise.
 */
export { coverObjectKey, pageObjectKey } from '../../shared/storage-keys';

/* ── typed storage errors ────────────────────────────────────────────────── */

/**
 * The origin does not have that key. Module-local on purpose: API_CONTRACT.md
 * §6 has no `STORAGE_NOT_FOUND` row, and adding a code requires the same-PR
 * table update (AGENTS.md §4.7) — so the delivery layer maps this to the 404
 * code that already exists for the asset class it resolved. Same pattern as
 * `DatabaseConfigurationError` in server/db/client.ts.
 *
 * Requirements: NFR-SEC-010. Tasks: T-CATALOG-010.
 */
export class ObjectNotFoundError extends Error {
  /** The storage operation that missed (`getStream` / `head`). */
  readonly op: string;

  constructor(op: string, options?: ErrorOptions) {
    super('storage object not found', options);
    this.name = 'ObjectNotFoundError';
    this.op = op;
  }
}

/** Narrow an unknown SDK error to its HTTP status, when it has one. */
function httpStatusOf(error: unknown): number | undefined {
  const metadata = (error as { $metadata?: { httpStatusCode?: number } } | null | undefined)
    ?.$metadata;
  return metadata?.httpStatusCode;
}

/** `NoSuchKey` (GET) / `NotFound` (HEAD) — an absent object, not an outage. */
function isAbsentObject(error: unknown): boolean {
  const name = (error as { name?: string } | null | undefined)?.name;
  return httpStatusOf(error) === 404 || name === 'NoSuchKey' || name === 'NotFound';
}

/** Every transport/origin failure becomes the §6 502 code (NFR-SEC-010). */
function storageFailure(op: string, cause: unknown): AppError {
  return new AppError('STORAGE_ERROR', { cause: new Error(`storage ${op} failed`, { cause }) });
}

/* ── the adapter ─────────────────────────────────────────────────────────── */

/**
 * Per-call injection seam. Delivery passes the request's `AbortSignal` so a
 * disconnected browser does not leave an origin socket (and an open stream)
 * behind; nothing else in the app needs it.
 *
 * Requirements: NFR-PERF-006 (bounded work per request). Task: T-CATALOG-010.
 */
export interface StorageCallOptions {
  readonly signal?: AbortSignal | undefined;
}

/** The metadata a HEAD returns; `null` when the origin has no such key. */
export interface ObjectMetadata {
  readonly contentType: string;
  readonly byteLength: number;
}

/**
 * The port plus the two seams the app needs on top of it: the SDK client (the
 * readyz canary, T-OBS-004) and the bucket name.
 *
 * Every method is re-declared with the OPTIONAL extra arguments the adapter
 * accepts. That is assignable to `ObjectStoragePort` (a function with extra
 * optional parameters *is* the shorter signature), so a caller holding the
 * port type still sees exactly the three-argument contract.
 */
export interface ObjectStorage extends ObjectStoragePort {
  /** Put an object from a stream; `contentLength` skips the spool (A1). */
  putStream(
    key: AssetKey,
    stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
    contentType: string,
    contentLength?: number,
  ): Promise<void>;
  /** Stream an object out; `options.signal` aborts the origin fetch. */
  getStream(
    key: AssetKey,
    options?: StorageCallOptions,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string; byteLength: number }>;
  /** Existence check (canary, reconciliation). */
  exists(key: AssetKey): Promise<boolean>;
  /** Delete (GC of replaced/deleted assets — T-UPLOAD-009). */
  delete(key: AssetKey): Promise<void>;
  /** Head metadata, or `null` for an absent key. */
  head(key: AssetKey): Promise<ObjectMetadata | null>;
  /** Exact-key, PUT-only, 15-minute presigned URL (A3: optional upload id). */
  presignPartUpload(
    key: AssetKey,
    partNumber: number,
    partSizeBytes: number,
    uploadId?: string,
  ): Promise<string>;
  /** The SDK client (readyz canary, T-OBS-004). */
  readonly client: S3Client;
  /** The bucket every operation is scoped to. Never logged (NFR-SEC-010). */
  readonly bucket: string;
}

/**
 * Builds the S3 adapter from the validated env.
 *
 * `forcePathStyle: true` is mandatory and must match
 * docker/init-s3-bucket.sh: a bare host has no `<bucket>.<host>` DNS, and it is
 * what makes S3 / R2 / RustFS interchangeable (ADR-004).
 *
 * Requirements: ADR-004, NFR-OPS-002, NFR-SEC-009. Task: T-CATALOG-010.
 */
/**
 * Which driver the environment selects. One decision, two module systems.
 *
 * This was inlined in `createObjectStorage` and the seed harness needed the same answer,
 * but could not reuse it: the sync factory reaches `filesystem` through `require`, which
 * exists in the Next bundle and does not exist in an ESM script. Copying the condition
 * into the seed would have been the same rule in two places, so it is named here instead
 * and both factories read it.
 *
 * The raw `source` is a parameter, not an implicit read of `process.env`. The seed harness
 * takes its environment as an injected object so a test can run against a throwaway
 * database and a local directory; a function that reached for the real process environment
 * would pick S3 while the caller had asked for the filesystem, and fail against a port
 * nothing is listening on. STORAGE_DIR is deliberately not in `Env` (see SQ-OPS-1), so the
 * raw source is the only place it can be read honestly.
 *
 * Requirements: ADR-004, NFR-OPS-002. Task: T-CATALOG-010.
 *
 * @param env the validated environment
 * @param source the raw variable map the env was validated from; defaults to `process.env`
 * @returns `'filesystem'` for the PGlite / local-directory fallbacks, else `'s3'`
 */
export function selectStorageDriver(
  env: Env,
  source: Record<string, string | undefined> = process.env,
): 'filesystem' | 's3' {
  // PGlite dev fallback: when DATABASE_URL is pglite/file, use filesystem storage
  const dbUrl = env.databaseUrl ?? source['DATABASE_URL'] ?? '';
  const isPglite =
    dbUrl.startsWith('pglite://') ||
    dbUrl.startsWith('file:') ||
    dbUrl.startsWith('memory:') ||
    dbUrl === ':memory:' ||
    dbUrl.startsWith('/tmp/') ||
    dbUrl.startsWith('./') ||
    dbUrl.endsWith('.db');
  const local =
    isPglite || source['STORAGE_DIR'] !== undefined || source['YOMI_STORAGE'] === 'filesystem';
  return local ? 'filesystem' : 's3';
}

/**
 * The async twin of {@link createObjectStorage}, for callers outside the Next bundle —
 * the seed harness among them. Same decision, reached with `import()` instead of
 * `require`, so an ESM script can use it.
 *
 * Requirements: ADR-004, NFR-OPS-002. Task: T-CATALOG-010.
 *
 * @param env the validated environment
 * @param source the raw variable map the env was validated from; defaults to `process.env`
 * @returns the filesystem or S3 adapter
 */
export async function createObjectStorageAsync(
  env: Env,
  source?: Record<string, string | undefined>,
): Promise<ObjectStorage> {
  if (selectStorageDriver(env, source ?? process.env) === 'filesystem') {
    const { createFilesystemStorage } = await import('./filesystem');
    return createFilesystemStorage() as unknown as ObjectStorage;
  }
  return createObjectStorage(env);
}

export function createObjectStorage(env: Env): ObjectStorage {
  if (selectStorageDriver(env) === 'filesystem') {
    // Lazy import to avoid circular
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createFilesystemStorage } = require('./filesystem') as typeof import('./filesystem');
    return createFilesystemStorage() as unknown as ObjectStorage;
  }
  const { endpoint, region, bucket, accessKeyId, secretAccessKey } = env.storage;
  const client = new S3Client({
    endpoint: endpoint.toString(),
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    client,
    bucket,

    async putStream(key, stream, contentType, contentLength) {
      // Unknown length ⇒ measure by spooling to a file (A1). Never to memory.
      const spooled = contentLength === undefined ? await spoolToFile(stream) : undefined;
      const body = spooled === undefined ? toNodeStream(stream) : spooled.stream;
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ContentType: contentType,
            ContentLength: contentLength ?? spooled?.byteLength,
            Body: body,
          }),
        );
      } catch (cause) {
        throw storageFailure('put', cause);
      } finally {
        await disposeSpool(spooled);
      }
    },

    async getStream(key, options?: StorageCallOptions) {
      const signal = options?.signal;
      let result;
      try {
        result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          signal === undefined ? undefined : { abortSignal: signal },
        );
      } catch (cause) {
        if (isAbsentObject(cause)) throw new ObjectNotFoundError('getStream', { cause });
        throw storageFailure('get', cause);
      }
      const body = result.Body as Readable | undefined;
      if (body === undefined) {
        // A 200 with no body is not a representation we can deliver.
        throw storageFailure('get', new Error('origin returned no body'));
      }
      const byteLength = result.ContentLength;
      if (byteLength === undefined) {
        // Content-Length is part of the delivery contract (FR-MEDIA-001); an
        // origin that cannot state it cannot be delivered honestly.
        throw storageFailure('get', new Error('origin returned no content length'));
      }
      return {
        // `Readable.toWeb` keeps backpressure end-to-end and propagates
        // `cancel()` to the socket: nothing is accumulated here.
        stream: Readable.toWeb(body) as ReadableStream<Uint8Array>,
        contentType: result.ContentType ?? 'application/octet-stream',
        byteLength,
      };
    },

    head: (key) => headObject(client, bucket, key),

    // `exists` is `head !== null` on purpose: one request, one code path, and
    // the canary (T-OBS-004) cannot drift from delivery. Written as a closure
    // over `headObject`, not `this.head`, so a destructured port still works.
    exists: async (key) => (await headObject(client, bucket, key)) !== null,

    async delete(key) {
      try {
        // Idempotent by contract (ADR-004: GC of replaced assets) — S3 answers
        // 204 for a key it does not have — but a transport failure must still
        // surface as the §6 502.
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      } catch (cause) {
        throw storageFailure('delete', cause);
      }
    },

    async presignPartUpload(key, partNumber, partSizeBytes, uploadId?) {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        throw new AppError('STORAGE_ERROR', {
          cause: new Error('presign called with an out-of-range part number'),
        });
      }
      return presignUploadPart({
        endpoint,
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        key,
        partNumber,
        partSizeBytes,
        uploadId,
      });
    },
  };
}

/** HEAD one object; `null` when the origin has no such key (port contract). */
async function headObject(
  client: S3Client,
  bucket: string,
  key: AssetKey,
): Promise<ObjectMetadata | null> {
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const byteLength = result.ContentLength;
    if (byteLength === undefined) {
      throw storageFailure('head', new Error('origin returned no content length'));
    }
    return { contentType: result.ContentType ?? 'application/octet-stream', byteLength };
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    if (isAbsentObject(cause)) return null;
    throw storageFailure('head', cause);
  }
}

/* ── streaming helpers (A1) ──────────────────────────────────────────────── */

/** A spooled body: its temp file, its length, and the read stream over it. */
interface Spool {
  readonly dir: string;
  readonly byteLength: number;
  readonly stream: Readable;
}

function toNodeStream(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): Readable {
  return source instanceof Readable ? source : Readable.from(source as AsyncIterable<Uint8Array>);
}

/**
 * Spools an unknown-length source to a temp file so the upload can declare a
 * `Content-Length` (A1). Memory stays bounded by the pipe's high-water mark;
 * the file is removed by {@link disposeSpool}. A crash mid-upload leaves a
 * file under the OS temp dir, which the OS reclaims — the staging lifecycle
 * rule (ADR-004) belongs to `staging/{jobId}/`, not to this transport.
 */
async function spoolToFile(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): Promise<Spool> {
  const dir = await mkdtemp(join(tmpdir(), 'yomi-put-'));
  const path = join(dir, 'body');
  try {
    await pipeline(toNodeStream(source), createWriteStream(path));
    const { size } = await stat(path);
    return { dir, byteLength: size, stream: createReadStream(path) };
  } catch (cause) {
    await rm(dir, { force: true, recursive: true });
    throw storageFailure('put', cause);
  }
}

/** Closes and removes a spooled temp file; a no-op when there is none. */
async function disposeSpool(spool: Spool | undefined): Promise<void> {
  if (spool === undefined) return;
  spool.stream.destroy();
  await rm(spool.dir, { force: true, recursive: true });
}

/* ── SigV4 query-string presigning (A2/A3) ───────────────────────────────── */

const PRESIGN_TTL_SECONDS = 15 * 60; // FR-UPLOAD-008: short-lived, server-internal
const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
const SIGV4_SERVICE = 's3';
const UNRESERVED = /[A-Za-z0-9\-_.~]/;

/** AWS "URI-encode": unreserved = A-Z a-z 0-9 - _ . ~ ; everything else %XX. */
function uriEncode(value: string, encodeSlash: boolean): string {
  let out = '';
  for (const char of value) {
    if (UNRESERVED.test(char)) {
      out += char;
    } else if (char === '/' && !encodeSlash) {
      out += char;
    } else {
      for (const byte of new TextEncoder().encode(char)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}
function hmacSha256(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface PresignInput {
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly key: AssetKey;
  readonly partNumber: number;
  /** Recorded for the caller's own bookkeeping; not part of the signature. */
  readonly partSizeBytes: number;
  readonly uploadId?: string | undefined;
}

/**
 * Builds a 15-minute, PUT-only, exact-key presigned URL.
 *
 * A leaked URL cannot reach another key, another part, or read anything
 * (T-13). With an `uploadId` the URL is a multipart part URL; without one it
 * is a single PUT of that exact key (A3).
 */
function presignUploadPart(input: PresignInput): string {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${input.region}/${SIGV4_SERVICE}/aws4_request`;

  const query = new Map<string, string>([
    ['X-Amz-Algorithm', SIGV4_ALGORITHM],
    ['X-Amz-Credential', `${input.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(PRESIGN_TTL_SECONDS)],
    ['X-Amz-SignedHeaders', 'host'],
    ['partNumber', String(input.partNumber)],
  ]);
  if (input.uploadId !== undefined) query.set('uploadId', input.uploadId);

  const canonicalQuery = [...query.entries()]
    .map(([name, value]) => `${uriEncode(name, true)}=${uriEncode(value, true)}`)
    .sort()
    .join('&');

  // The canonical path is the REQUEST path, URI-encoded per segment with `/`
  // kept as the separator — measured against rustfs/rustfs:1.0.0 on
  // 2026-09-27, encoding the slashes as %2F makes every URL 403
  // SignatureDoesNotMatch, and so does signing anything but `host`.
  const bucketSegment = uriEncode(input.bucket, false);
  const requestPath = `/${bucketSegment}/${input.key
    .split('/')
    .map((segment) => uriEncode(segment, false))
    .join('/')}`;
  const canonicalRequest = [
    'PUT',
    requestPath,
    canonicalQuery,
    `host:${input.endpoint.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    SIGV4_ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signingKey = hmacSha256(
    hmacSha256(
      hmacSha256(hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp), input.region),
      SIGV4_SERVICE,
    ),
    'aws4_request',
  );
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  return `${input.endpoint.origin}${requestPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
