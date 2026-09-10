/**
 * Formatting for the manga detail surface.
 *
 * Next's App Router validates what a `page.tsx` may export, so the shared
 * formatters live here where the page, the chapter list and the cover can all
 * reach them.
 */

/**
 * The URL segment for a chapter. `number` is `numeric(8,2)`, so 10.5 is legal
 * and must survive the round trip; 10.0 must NOT become "10.0" in a URL that a
 * reader will see and copy.
 */
export function chapterSegment(number: number): string {
  return String(Math.round(number * 100) / 100);
}

/**
 * An absolute date for a `<time>` element: `YYYY-MM-DD`.
 *
 * A date on a reading list is compared vertically, so it is a fixed-width ISO
 * date rather than "2 days ago" — which would also be wrong the moment a page
 * sits in a cache, and the API's own cache window is 60 s.
 */
export function formatDate(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

/** The `datetime` attribute value, or undefined for an unparseable date. */
export function dateTime(iso: string | null): string | undefined {
  if (iso === null) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * A synopsis for the meta description, or undefined when there is none.
 *
 * The synopsis is plain text, and this is a plain-text excerpt — no markup is
 * ever derived from it.
 */
export function synopsisExcerpt(synopsis: string, limit = 200): string | undefined {
  const text = synopsis.trim().replace(/\s+/g, ' ');
  if (text === '') return undefined;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
