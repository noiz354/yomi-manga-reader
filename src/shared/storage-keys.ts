/**
 * Object-key rules. The ONLY place a physical object key is built: pure string
 * rules with no infrastructure in them, so the one implementation serves both
 * ingest and delivery (features may not import server code). The sister server
 * module re-exports them, so no second copy of the rule exists anywhere.
 */
import { AppError } from './contracts/errors';
import type { DeliveryFormat } from './contracts/ports';
import type { AssetKey } from './types';

/** The opaque key shape: 128-bit random, base64url. */
const ASSET_KEY_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/** Row ids are uuids; anything else is a bug. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The stored extension per delivery format. */
const FORMAT_EXTENSION: Readonly<Record<DeliveryFormat, string>> = {
  avif: 'avif',
  webp: 'webp',
  jpeg: 'jpeg',
};

/**
 * Fail-fast invariant check — NOT input validation. Both arguments are
 * server-owned (a DB row id, a generated key), so a violation is a broken
 * invariant and INTERNAL_ERROR says exactly that. No client-supplied value
 * ever reaches here: the delivery layer validates the URL key first.
 */
function requireKeyPart(value: string, pattern: RegExp, subject: string): string {
  if (!pattern.test(value)) {
    throw new AppError('INTERNAL_ERROR', {
      cause: new Error(`refusing to build an object key: ${subject} is not well formed`),
    });
  }
  return value;
}

/** Physical key of one page variant: `pages/{chapterId}/{assetKey}.{ext}`. */
export function pageObjectKey(
  chapterId: string,
  assetKey: string,
  format: DeliveryFormat,
): AssetKey {
  requireKeyPart(chapterId, UUID_PATTERN, 'chapterId');
  requireKeyPart(assetKey, ASSET_KEY_PATTERN, 'assetKey');
  return `pages/${chapterId}/${assetKey}.${FORMAT_EXTENSION[format]}` as AssetKey;
}

/** Physical key of one cover variant: `covers/{mangaId}.{ext}`. Covers are WebP + JPEG only. */
export function coverObjectKey(
  mangaId: string,
  assetKey: string,
  format: DeliveryFormat,
): AssetKey {
  requireKeyPart(mangaId, UUID_PATTERN, 'mangaId');
  requireKeyPart(assetKey, ASSET_KEY_PATTERN, 'assetKey');
  return `covers/${mangaId}.${FORMAT_EXTENSION[format]}` as AssetKey;
}
