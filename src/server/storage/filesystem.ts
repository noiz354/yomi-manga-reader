/**
 * filesystem storage — local filesystem adapter for PGlite dev fallback.
 *
 * Implements ObjectStoragePort on the local filesystem under `storage/`.
 * The key layout is identical to the S3 adapter (ADR-004):
 *   pages/{chapterId}/{assetKey}.{ext}
 *   covers/{mangaId}.{ext}
 * No S3 SDK is used; no network is required.
 *
 * Requirements: ADR-004 (layout), FR-MEDIA-003 (opaque keys only).
 * Task: dev fallback for YOMI wave 2 when no S3/MinIO is available.
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../shared/contracts/errors';
import type { AssetKey } from '../../shared/types';
import type { ObjectStoragePort } from '../../shared/contracts/ports';
import { ObjectNotFoundError } from './object-storage';

/** Root directory for filesystem storage. Overridable via STORAGE_DIR. */
function storageRoot(): string {
  return process.env['STORAGE_DIR'] ?? join(process.cwd(), 'storage');
}

/** Map an S3 key like `pages/{uuid}/{key}.avif` to a filesystem path. */
function keyToPath(key: AssetKey): string {
  // keys are already validated opaque; just join under root
  return join(storageRoot(), key);
}

/** Infer content type from extension, matching FORMAT_CONTENT_TYPE. */
function contentTypeForKey(key: string): string {
  if (key.endsWith('.avif')) return 'image/avif';
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.jpeg') || key.endsWith('.jpg')) return 'image/jpeg';
  if (key.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

/**
 * Node's filesystem errors carry a `code` such as ENOENT. A `catch` binding is `unknown`,
 * so it is narrowed here before the code is read, instead of typing the binding as `any`.
 */
function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function storageFailure(op: string, cause: unknown): AppError {
  return new AppError('STORAGE_ERROR', { cause: new Error(`filesystem storage ${op} failed`, { cause }) });
}

export function createFilesystemStorage(): ObjectStoragePort & { client?: unknown; bucket?: string } {
  return {
    async putStream(key, stream, contentType) {
      const path = keyToPath(key);
      await mkdir(dirname(path), { recursive: true });
      // stream is AsyncIterable<Uint8Array> or ReadableStream
      try {
        if (isReadableStream(stream)) {
          const readable = Readable.fromWeb(stream as import('node:stream/web').ReadableStream);
          await pipeline(readable, createWriteStream(path));
        } else {
          // AsyncIterable
          const ws = createWriteStream(path);
          for await (const chunk of stream as AsyncIterable<Uint8Array>) {
            ws.write(chunk);
          }
          ws.end();
          await new Promise<void>((res, rej) => {
            ws.on('finish', res);
            ws.on('error', rej);
          });
        }
      } catch (cause) {
        throw storageFailure('put', cause);
      }
    },

    async getStream(key: AssetKey) {
      const path = keyToPath(key);
      try {
        const st = await stat(path);
        const rs = createReadStream(path);
        return {
          stream: Readable.toWeb(rs) as ReadableStream<Uint8Array>,
          contentType: contentTypeForKey(key),
          byteLength: st.size,
        };
      } catch (cause: unknown) {
        if (isErrnoException(cause) && cause.code === 'ENOENT') throw new ObjectNotFoundError('getStream', { cause });
        throw storageFailure('get', cause);
      }
    },

    async head(key) {
      const path = keyToPath(key);
      try {
        const st = await stat(path);
        return { contentType: contentTypeForKey(key), byteLength: st.size };
      } catch (cause: unknown) {
        if (isErrnoException(cause) && cause.code === 'ENOENT') return null;
        throw storageFailure('head', cause);
      }
    },

    async exists(key) {
      const path = keyToPath(key);
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },

    async delete(key) {
      const path = keyToPath(key);
      try {
        await rm(path, { force: true });
      } catch (cause) {
        throw storageFailure('delete', cause);
      }
    },

    async presignPartUpload() {
      throw new AppError('STORAGE_ERROR', { cause: new Error('presign not supported on filesystem adapter') });
    },
  };
}

function isReadableStream(s: unknown): boolean {
  return typeof (s as { getReader?: unknown })?.getReader === 'function';
}
