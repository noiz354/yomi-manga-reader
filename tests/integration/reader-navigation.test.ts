/**
 * Chapter navigation in the reader.
 * The `/pages` route returns prev/next published neighbours, but the reader
 * declared its OWN local `ChapterPagesResponse` without those fields, so the
 * client silently dropped them. This test parses the client source rather than
 * mounting the component: what is at risk is a SHAPE MISMATCH between the
 * server contract and the client's parsed type, so it reads both and compares
 * them. No DSN required. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `resolve` rather than `new URL(..., import.meta.url)`: the reader's path
// contains `[slug]` and `[chapter]`, and square brackets are not valid URL
// characters — the URL parser rewrites them and the file is never found.
const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = resolve(here, '../../src/app/manga/[slug]/chapter/[chapter]/reader-client.tsx');
const CONTRACT = resolve(here, '../../src/shared/contracts/chapter.ts');

const client = readFileSync(CLIENT, 'utf8');
const contract = readFileSync(CONTRACT, 'utf8');

describe('the reader consumes the chapter neighbours', () => {
  it('parses the shared contract type rather than a local copy of it', () => {
    // The bug's shape: a locally-declared response interface drifted from the
    // contract, and the drift was invisible because nothing compared them. The
    // client now imports the contract's own type, so a field added to the
    // contract is visible in the client at compile time.
    expect(client).toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/shared\/contracts\/chapter'/);
    expect(client).toMatch(/import type \{[^}]*ChapterPagesResponse/);

    // And the two local redeclarations that made the drift possible are gone.
    expect(client).not.toMatch(/^interface ChapterPagesResponse \{/m);
    expect(client).not.toMatch(/^interface PageAsset \{/m);
  });

  it('reads BOTH neighbours off the response', () => {
    expect(client).toMatch(
      /readNeighbour\(\(parsed as \{ prevChapter\?: unknown \}\)\.prevChapter\)/,
    );
    expect(client).toMatch(
      /readNeighbour\(\(parsed as \{ nextChapter\?: unknown \}\)\.nextChapter\)/,
    );
    expect(client).toMatch(/setPrevChapter\(/);
    expect(client).toMatch(/setNextChapter\(/);
  });

  it('treats null, a missing field and a malformed neighbour as "no neighbour"', () => {
    // At the ends of a manga the contract says `null`, and a response that omits
    // the field must not crash the reader. All three collapse to the same answer,
    // so a broken neighbour becomes an absent control rather than a link that
    // goes nowhere.
    expect(client).toMatch(/function readNeighbour\(raw: unknown\): ChapterNeighbour \| null/);
    // The raw guard is the one that prevents a THROW, not merely a wrong value:
    // without it, `raw as Record<string, unknown>` is undefined and indexing it
    // raises. A response that omits `prevChapter` entirely hits exactly this —
    // the guard a mutation once removed without failing anything.
    expect(client).toMatch(/if \(typeof raw !== 'object' \|\| raw === null\) return null;/);
    expect(client).toMatch(/if \(typeof slug !== 'string' \|\| slug === ''\) return null/);
    expect(client).toMatch(/typeof number !== 'number' \|\| !Number\.isFinite\(number\)/);
  });

  it('builds the neighbour href from the slug and number the contract carries', () => {
    // `MangaSlug` and the chapter number are the whole of the neighbour's
    // identity; `mangaTitle` is not in the neighbour because the slug carries it.
    expect(contract).toMatch(
      /prevChapter: \{ slug: MangaSlug; number: number; title: string \| null \} \| null/,
    );
    expect(contract).toMatch(
      /nextChapter: \{ slug: MangaSlug; number: number; title: string \| null \} \| null/,
    );
    expect(client).toMatch(
      /hrefFor = \(n: ChapterNeighbour\) => `\/manga\/\$\{n\.slug\}\/chapter\/\$\{n\.number\}`/,
    );
  });

  it('navigates with a real link, not a scripted route change', () => {
    // A `<button>` with a router push would be keyboard-reachable but not
    // middle-clickable, not openable in a new tab, and not copy-linkable — all of
    // which a reader expects from "the next chapter". A plain `href` gets them for
    // free and costs nothing.
    expect(client).toMatch(/<a[\s\S]{0,200}href=\{hrefFor\(prevChapter\)\}/);
    expect(client).toMatch(/<a[\s\S]{0,200}href=\{hrefFor\(nextChapter\)\}/);
    // Each carries a name that says which chapter, not just "next".
    expect(client).toMatch(/aria-label=\{`Previous chapter: /);
    expect(client).toMatch(/aria-label=\{`Next chapter: /);
    // And they live in a landmark, so a screen reader can jump to them.
    expect(client).toMatch(/<nav\s+aria-label="Chapter navigation"/);
  });

  it('shows an honest absence rather than a dead control', () => {
    expect(client).toMatch(/No previous chapter/);
    expect(client).toMatch(/No next chapter/);
  });

  it('lets the deep link win over saved progress, and clamps it', () => {
    // The rule that makes a shared link meaningful: someone who followed a link to
    // page 12 asked for page 12. Substituting their last position would make the
    // link lie, and a link that lies cannot be shared.
    //
    // Neither half of this is observable without mounting the component — which is
    // why the arithmetic is unit-tested in `reader-deeplink.test.ts` and the
    // WIRING is asserted here. A mutation that disabled the branch must fail here.
    expect(client).toMatch(/if \(requestedPage !== null\) \{\s*setPage\(clampRequestedPage\(/);
    // The progress fetch is the ELSE branch, so a deep link also skips the round
    // trip it makes pointless.
    expect(client).toMatch(/\} else \{\s*const progRes = await fetch/);
    // The shell that hands the parsed value down is asserted in
    // `reader-deeplink.test.ts`, which owns the deep link; this file only reads
    // the client, and asserting a file it never loaded would be theatre.
  });
});
