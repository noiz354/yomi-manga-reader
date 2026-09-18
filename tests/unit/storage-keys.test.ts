/**
 * Unit tests — the delivery-URL rule: one key, one place. The delivery grammar
 * accepts `/media/{key}.{variant}` only, but the repositories built `/media/{key}`
 * with no extension, and all three page variants shared that one extensionless
 * URL on the theory the route negotiates from `Accept`. The chosen rule is the
 * opposite: no runtime negotiation, the `<picture>` picks the variant, so every
 * reader `<img>` was a 404; `mediaUrlFor` in storage-keys.ts is the single rule.
 */
import { describe, expect, it } from 'vitest';
import { mediaUrlFor } from '../../src/shared/storage-keys';
import { parseDeliveryKey } from '../../src/server/media/page-delivery';

// A fixed 32-hex base key: the shape `pageAssetKey` mints, written out so the
// expectations below are literals, not recomputations of the code under test.
const KEY = '61701ccac2e4b37271156b8cfae93159';

describe('the delivery URL carries the variant', () => {
  it('builds one distinct URL per variant from the same base key', () => {
    expect(mediaUrlFor(KEY, 'jpeg')).toBe(`/media/${KEY}.jpeg`);
    expect(mediaUrlFor(KEY, 'webp')).toBe(`/media/${KEY}.webp`);
    expect(mediaUrlFor(KEY, 'avif')).toBe(`/media/${KEY}.avif`);
  });

  it('every URL it builds parses under the delivery grammar, with the right variant', () => {
    for (const format of ['avif', 'webp', 'jpeg'] as const) {
      const parsed = parseDeliveryKey(mediaUrlFor(KEY, format).replace('/media/', ''));
      expect(parsed).not.toBeNull();
      expect(parsed?.assetKey).toBe(KEY);
      expect(parsed?.format).toBe(format);
    }
  });

  it('keeps the URL app-relative: never a storage URL, never a path', () => {
    const url = mediaUrlFor(KEY, 'jpeg');
    expect(url.startsWith('/media/')).toBe(true);
    expect(url).not.toContain('pages/');
    expect(url).not.toContain('covers/');
    expect(url.slice('/media/'.length)).not.toContain('/');
  });
});
