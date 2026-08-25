/**
 * The reader's `?page=N` deep link.
 * The server shell read `params` and nothing else, so page state always
 * initialised to 1; the `/bookmarks` page builds the correct `?page=N` href and
 * it landed on page 1 — a link built correctly that goes to the wrong place.
 * The parse/clamp helpers live in their own module so this file can import them
 * without React; that the shell calls them is a source check. No DSN required.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRequestedPage, clampRequestedPage } from '../../src/features/reader/deep-link';

const here = dirname(fileURLToPath(import.meta.url));
const SHELL = resolve(here, '../../src/app/manga/[slug]/chapter/[chapter]/page.tsx');
const shell = readFileSync(SHELL, 'utf8');

describe('the reader deep link', () => {
  describe('readRequestedPage', () => {
    it('reads a well-formed page', () => {
      expect(readRequestedPage('1')).toBe(1);
      expect(readRequestedPage('7')).toBe(7);
      expect(readRequestedPage('42')).toBe(42);
      // Zero-padded, because a link built by hand may well be `?page=07`.
      expect(readRequestedPage('07')).toBe(7);
    });

    it('treats a missing param as no request', () => {
      expect(readRequestedPage(undefined)).toBeNull();
    });

    it('refuses a page number that is not a positive integer', () => {
      // Each of these is a link that does not name a page a reader can open.
      // "No deep link" lets the reader start from their saved position, which is
      // useful; a repaired value would be a page nobody asked for.
      expect(readRequestedPage('0')).toBeNull();
      expect(readRequestedPage('-1')).toBeNull();
      expect(readRequestedPage('-99')).toBeNull();
      expect(readRequestedPage('abc')).toBeNull();
      expect(readRequestedPage('')).toBeNull();
      expect(readRequestedPage('1.5')).toBeNull();
      expect(readRequestedPage('NaN')).toBeNull();
      expect(readRequestedPage('Infinity')).toBeNull();
    });

    it('follows JavaScript number coercion for the harmless oddities', () => {
      // `' 5 '` → 5 and `'1e3'` → 1000, because `Number()` trims and reads
      // scientific notation. Accepting them is the right call, not a gap:
      // `?page= 5 ` almost certainly means page 5, and `?page=1e3` lands on 1000
      // which `clampRequestedPage` then pulls back to the last real page.
      // Refusing either would drop a reader on page 1 for a formatting difference
      // nobody would consider meaningful. A stricter `^\\d+$` would be more
      // predictable on paper and worse in use.
      expect(readRequestedPage(' 5 ')).toBe(5);
      expect(readRequestedPage('1e3')).toBe(1000);
      expect(readRequestedPage('+5')).toBe(5);
    });

    it('refuses a repeated param rather than guessing which one was meant', () => {
      // Next returns an array for `?page=1&page=2`. There is no defensible
      // "first" or "last", so it is no request.
      expect(readRequestedPage(['1', '2'])).toBeNull();
    });
  });

  describe('clampRequestedPage', () => {
    it('keeps a page inside the chapter', () => {
      expect(clampRequestedPage(5, 12)).toBe(5);
      expect(clampRequestedPage(1, 12)).toBe(1);
      expect(clampRequestedPage(12, 12)).toBe(12);
    });

    it('clamps a page past the end rather than refusing it', () => {
      // A stale bookmark pointing at page 999 of a 12-page chapter. Landing on the
      // last page is a useful answer; a 422 would be a dead end with no way on.
      expect(clampRequestedPage(999, 12)).toBe(12);
    });

    it('opens on page 1 when there is no request', () => {
      expect(clampRequestedPage(null, 12)).toBe(1);
      // Even with a request: the caller checks `null` first, but the function must
      // not be able to produce page 0 or NaN.
      expect(clampRequestedPage(null, 1)).toBe(1);
    });

    it('never produces a page outside [1, pageCount], even for a degenerate chapter', () => {
      // A chapter with zero pages is a broken catalogue entry, not a reader error.
      // The function must still return something a page control can use.
      expect(clampRequestedPage(3, 0)).toBe(1);
      expect(clampRequestedPage(null, 0)).toBe(1);
      expect(clampRequestedPage(1, -1)).toBe(1);
    });
  });

  describe('the server shell wiring', () => {
    // The arithmetic above is pure and is tested directly. Whether the shell
    // actually calls it cannot be — importing a page component pulls in React and
    // the client island — so the one wiring claim is a source assertion, and it is
    // labelled as such rather than dressed up as behaviour.
    it('reads searchParams and hands the parsed page to the client', () => {
      expect(shell).toMatch(/searchParams[\s\S]{0,200}await searchParams/);
      expect(shell).toMatch(/readRequestedPage\(query\['page'\]\)/);
      expect(shell).toMatch(/requestedPage=\{readRequestedPage\(/);
    });

    it('does not clamp in the shell, because it cannot know page_count', () => {
      // A clamp here would need `page_count`, which arrives with the page list.
      // Clamping against a guess is how a chapter gets opened on the wrong page.
      const handler = shell.slice(shell.indexOf('export default async function ReaderPage'));
      expect(handler).not.toMatch(/Math\.(min|max)\(/);
    });
  });

  describe('the two together', () => {
    it('covers every input the reader can actually produce', () => {
      // The pipeline a real link goes through: parse, then clamp against a count
      // that is only known after the chapter loads.
      const cases: Array<[string | undefined, number, number]> = [
        ['1', 12, 1],
        ['6', 12, 6],
        ['999', 12, 12],
        ['abc', 12, 1],
        ['0', 12, 1],
        [undefined, 12, 1],
        ['3', 1, 1],
      ];
      for (const [raw, count, expected] of cases) {
        expect(clampRequestedPage(readRequestedPage(raw), count)).toBe(expected);
      }
    });
  });
});
