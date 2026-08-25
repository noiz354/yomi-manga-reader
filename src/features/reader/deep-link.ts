/**
 * The reader's `?page=N` deep link. It lives in `features/reader/` rather than
 * beside the route because it is pure domain logic and a route directory's
 * `[slug]`/`[chapter]` segments are not valid module-specifier characters for
 * TypeScript, so a test cannot import it from there.
 *
 * The value returned is RAW: clamping to `[1, page_count]` happens in
 * `ReaderClient` once the count is known, not here or in the repository.
 */

/**
 * Reads `?page=N` as a positive integer, or `null` when there is no usable one.
 *
 * A deep link is a request, not a suggestion, so a well-formed `N` is returned as
 * asked. A malformed one is NOT repaired: `?page=0`, `?page=-1`, `?page=abc`,
 * `?page=`, `?page=1.5`, `?page=NaN` and a repeated `?page=1&page=2` all read as
 * "no deep link", and the reader opens on its saved progress or page 1. Guessing a
 * page the link did not name would be worse than ignoring a broken one — and a
 * corrected-by-silently URL is a link that cannot be trusted when shared.
 *
 * Coercion follows `Number()`, so `' 5 '` is 5 and `'1e3'` is 1000. That is
 * deliberate: a stray space almost certainly means page 5, and 1000 is pulled
 * back to the chapter's last page by `clampRequestedPage`. A strict `^\\d+$` would
 * be tidier on paper and worse in use, sending a reader to page 1 over
 * whitespace.
 *
 * @param raw the `page` search param: absent, a string, or a repeated array
 * @returns the requested page, or `null`
 */
export function readRequestedPage(raw: string | string[] | undefined): number | null {
  // A repeated param arrives as an array. There is no correct "first" or "last"
  // answer, so it is treated as no request at all.
  if (typeof raw !== 'string') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Clamps a requested page into a chapter of `pageCount` pages.
 *
 * Clamps rather than refuses, on purpose. A link to page 999 in a 12-page chapter
 * is a stale bookmark, not an attack, and refusing it would leave the reader on a
 * dead end with no way forward. Landing on the last page is a useful answer.
 *
 * @param requested the raw requested page, already a positive integer or `null`
 * @param pageCount the chapter's real page count
 * @returns a page inside `[1, pageCount]`
 */
export function clampRequestedPage(requested: number | null, pageCount: number): number {
  if (pageCount < 1) return 1;
  if (requested === null) return 1;
  return Math.min(requested, pageCount);
}
