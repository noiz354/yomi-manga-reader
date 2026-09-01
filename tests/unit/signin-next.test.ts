/**
 * Unit tests — the sign-in `?next=` sanitizer.
 *
 * After a successful sign-in the page navigates to `?next=`. An unsanitized
 * `next` is an open redirect: `https://evil.example` steals the fresh session
 * the moment the user lands. The rule (from the page's own header) is
 * "same-origin relative paths only" — and it is a pure string function, so it
 * is pinned here rather than behind a browser.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeNextParam } from '../../src/app/auth/signin/sanitize-next';

describe('?next= admits same-origin relative paths only', () => {
  it('keeps ordinary in-app destinations, query strings included', () => {
    expect(sanitizeNextParam('/library')).toBe('/library');
    expect(sanitizeNextParam('/manga/seed-manga-0001/chapter/1')).toBe(
      '/manga/seed-manga-0001/chapter/1',
    );
    expect(sanitizeNextParam('/search?q=naruto')).toBe('/search?q=naruto');
  });

  it('falls back to the member shelf when there is nothing usable', () => {
    expect(sanitizeNextParam(null)).toBe('/library');
    expect(sanitizeNextParam(undefined)).toBe('/library');
    expect(sanitizeNextParam('')).toBe('/library');
    expect(sanitizeNextParam(42)).toBe('/library');
  });

  it('rejects absolute URLs, protocol-relative URLs, and schemes', () => {
    expect(sanitizeNextParam('https://evil.example/')).toBe('/library');
    expect(sanitizeNextParam('http://evil.example/')).toBe('/library');
    expect(sanitizeNextParam('//evil.example/')).toBe('/library');
    expect(sanitizeNextParam('javascript:alert(1)')).toBe('/library');
    expect(sanitizeNextParam('data:text/html,hi')).toBe('/library');
  });

  it('rejects backslash and control-character smuggling', () => {
    expect(sanitizeNextParam('/\\evil.example/')).toBe('/library');
    expect(sanitizeNextParam('/\nevil')).toBe('/library');
    expect(sanitizeNextParam('/library\r\nSet-Cookie: x=1')).toBe('/library');
  });

  it('rejects paths that escape the origin root', () => {
    expect(sanitizeNextParam('library')).toBe('/library');
    expect(sanitizeNextParam('/..')).toBe('/library');
    expect(sanitizeNextParam('/../secret')).toBe('/library');
  });
});
