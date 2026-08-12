/**
 * Branded identifier types.
 *
 * Purpose: make ID confusion a compile-time error (a `MangaId` is not a
 * `ChapterId`), and document that IDs are UUIDv7 strings end-to-end.
 *
 * Asset keys are a separate type — they are NOT ids of rows; see `AssetKey`.
 */

/**
 * Compile-time brand symbol (no runtime cost). `declare` = ambient: it
 * exists only in the type system, so brands add zero runtime bytes.
 */
declare const BRAND: unique symbol;

type Brand<T, Name extends string> = T & { readonly [BRAND]: { readonly name: Name } };

/** A manga row id (uuid v7). */
export type MangaId = Brand<string, 'MangaId'>;
/** A chapter row id (uuid v7). */
export type ChapterId = Brand<string, 'ChapterId'>;
/** A chapter page row id (uuid v7). */
export type PageId = Brand<string, 'PageId'>;
/** A user row id (uuid v7). */
export type UserId = Brand<string, 'UserId'>;
/** A session row id (uuid v7). The cookie carries the token, not this. */
export type SessionId = Brand<string, 'SessionId'>;
/** An upload job row id (uuid v7). */
export type UploadJobId = Brand<string, 'UploadJobId'>;
/** A bookmark row id (uuid v7). */
export type BookmarkId = Brand<string, 'BookmarkId'>;

/**
 * Storage-backed object identifier for a media variant.
 *
 * Security invariants:
 * - 128-bit random (base64url, ~22 chars); NEVER derived from filenames,
 *   chapter ids, or paths.
 * - NEVER encodes bucket/path layout; the app maps key → object internally.
 * - NEVER appears in logs or error bodies (redaction).
 */
export type AssetKey = Brand<string, 'AssetKey'>;

/** A URL-safe slug identifying a manga in routes (unique). */
export type MangaSlug = Brand<string, 'MangaSlug'>;
