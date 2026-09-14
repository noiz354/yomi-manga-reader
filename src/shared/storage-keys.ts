/**
 * Object-key rules: the ONLY place a physical object key is built. Pure string
 * rules with no infrastructure, so both the ingest path and the delivery layer
 * can share one implementation — `features/*` may not import `server/*`, so the
 * rule lives in `shared/`. The sibling module re-exports them so existing
 * server imports keep working.
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
 * invariant and INTERNAL_ERROR (500) says exactly that. No client-supplied
 * value ever reaches here: the delivery layer validates the URL key first, so
 * a crafted path can never become an object key.
 */
function requireKeyPart(value: string, pattern: RegExp, subject: string): string {
  if (!pattern.test(value)) {
    throw new AppError('INTERNAL_ERROR', {
      cause: new Error(`refusing to build an object key: ${subject} is not well formed`),
    });
  }
  return value;
}

/**
 * Physical key of one page variant: `pages/{chapterId}/{assetKey}.{ext}`.
 *
 * @param chapterId owning chapter row id (never a client value).
 * @param assetKey the opaque key stored in `chapter_page.asset_key`.
 * @param format the stored variant.
 */
export function pageObjectKey(
  chapterId: string,
  assetKey: string,
  format: DeliveryFormat,
): AssetKey {
  requireKeyPart(chapterId, UUID_PATTERN, 'chapterId');
  requireKeyPart(assetKey, ASSET_KEY_PATTERN, 'assetKey');
  return `pages/${chapterId}/${assetKey}.${FORMAT_EXTENSION[format]}` as AssetKey;
}

/**
 * Physical key of one cover variant: `covers/{mangaId}.{ext}`. Covers are
 * WebP + JPEG only.
 *
 * @param mangaId owning manga row id.
 * @param assetKey the opaque key stored in `manga.cover_asset_key`.
 * @param format the stored variant.
 */
export function coverObjectKey(
  mangaId: string,
  assetKey: string,
  format: DeliveryFormat,
): AssetKey {
  requireKeyPart(mangaId, UUID_PATTERN, 'mangaId');
  requireKeyPart(assetKey, ASSET_KEY_PATTERN, 'assetKey');
  return `covers/${mangaId}.${FORMAT_EXTENSION[format]}` as AssetKey;
}

/**
 * The delivery URL for one stored variant: `/media/{assetKey}.{ext}`.
 *
 * This is the ONLY place a delivery URL is built. The object-key builders above
 * answer "where is it stored"; this answers "what URL names it" — and the two
 * must agree, because the delivery layer parses the extension back out of the
 * URL to pick the variant. Three page variants therefore need three DISTINCT
 * URLs; the route performs no runtime negotiation from `Accept`.
 *
 * Pure by design: no `requireKeyPart` throw. A corrupt row must still produce
 * the URL the row claims — the delivery grammar gate answers 404 for keys that
 * match nothing, and turning a read into a 500 here would change the failure
 * contract.
 *
 * @param assetKey the opaque base key stored in the row (never a client value).
 * @param format the variant this URL names.
 */
export function mediaUrlFor(assetKey: string, format: DeliveryFormat): string {
  return `/media/${assetKey}.${FORMAT_EXTENSION[format]}`;
}

/**
 * What a delivery URL looks like to a client-side validator.
 *
 * App-relative, one segment, optional stored extension. The base is looser
 * than the delivery grammar on purpose (`{6,64}` vs `{22,64}`): the client
 * must accept fixture and legacy keys without fetching an origin the API did
 * not choose — the server re-validates strictly before any I/O. Anything
 * outside this shape becomes `null` upstream, rendering the placeholder
 * instead of a wrong image.
 */
export const MEDIA_URL_PATTERN = /^\/media\/[A-Za-z0-9_-]{6,64}(\.(avif|webp|jpeg))?$/;
