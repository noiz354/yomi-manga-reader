'use client';

/**
 * CoverImage — the reserved cover box, with a placeholder that costs no shift.
 *
 * A client island because a cover key can exist while its object is missing, a
 * fact the server cannot know without probing each cover. It loads on approach
 * rather than trusting `loading="lazy"`, whose reach is a connection-dependent
 * browser heuristic: the request budget must be a property of the layout. The
 * first card's cover is eager and carries its `src` in the server HTML.
 */
import { useEffect, useRef, useState } from 'react';
import { classNames } from '../../shared/ui/classNames';
import styles from './discover.module.css';

/** The reserved box's intrinsic size. 2:3 is the design's cover proportion, and
 *  the width/height attributes mean the box is reserved even before the
 *  stylesheet arrives — so a slow CSS request cannot shift it. */
const BOX_WIDTH = 600;
const BOX_HEIGHT = 900;

/**
 * How far ahead of the viewport a cover starts loading.
 *
 * This number IS the request budget, arithmetically. A cold load of /discover
 * at the reference 1440×900 viewport costs 1 document + 2 stylesheets + 9
 * scripts = 12 requests before a single cover is counted, and the budget allows
 * 30 — so at most 18 covers may be requested on load. The grid puts three rows
 * inside the fold (18 cards); the fourth row starts ~1113 px down.
 *
 *   600 px → 22 covers requested (measured) → 34 requests, over budget
 *   240 px → 22 covers requested (measured) → 34 requests, over budget
 *   100 px → 18 covers requested (measured) → 30 requests, at budget
 *
 * So the lead is 100 px: about half a card, enough to have the next row
 * decoding before a reader's scroll reaches it, and no more. The honest caveat
 * is that this is a property of the LAYOUT, not a constant: a window tall
 * enough to show a fourth row will request a fourth row of covers, because a
 * reader who can see them has to be able to see them. The budget holds at the
 * reference viewport.
 */
const LOAD_AHEAD_PX = 100;

export type CoverImageProps = {
  /** `/media/{assetKey}.jpeg`, or null when no cover asset exists at all. */
  src: string | null;
  /** `true` for the first card's cover (the LCP element) and the detail cover. */
  priority?: boolean;
  /** `alt` text when the image is NOT inside a link (the detail page). */
  alt?: string;
  className?: string;
};

export function CoverImage({ src, priority = false, alt = '', className }: CoverImageProps) {
  const [failed, setFailed] = useState(false);
  const [near, setNear] = useState(priority);
  const imageRef = useRef<HTMLImageElement>(null);
  const classes = classNames(styles.cover, className);

  /*
   * The race this closes: a cover 404s, the browser fires `error` on the <img>,
   * and it often happens BEFORE hydration (a local 404 is faster than a script
   * download). React has no handler yet, the event is gone, and the card shows a
   * broken image for the rest of the session. So the state is checked on mount as
   * well as caught on the event: an image already `complete` with no intrinsic
   * width is already broken. `onError` still handles everything that fails later.
   */
  useEffect(() => {
    const image = imageRef.current;
    if (image !== null && image.currentSrc !== '' && image.complete && image.naturalWidth === 0) {
      setFailed(true);
    }
  }, [src]);

  // The load-on-approach observer. One observer per cover is fine at this size
  // (24 on a page, 1 on the detail page) and it disconnects itself as soon as
  // the cover is in range, so nothing observes a loaded image.
  useEffect(() => {
    if (priority || src === null) return;
    const image = imageRef.current;
    if (image === null) return;
    if (typeof IntersectionObserver === 'undefined') {
      // A browser without the observer still gets its covers, just eagerly.
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: `${LOAD_AHEAD_PX}px` },
    );
    observer.observe(image);
    return () => observer.disconnect();
  }, [priority, src]);

  // No key, or a key whose bytes turned out to be missing: same box, same
  // geometry, a word instead of artwork.
  if (src === null || failed) {
    return (
      <span className={classes}>
        <span className={styles.coverEmpty} aria-hidden="true">
          No cover
        </span>
      </span>
    );
  }

  return (
    <span className={classes}>
      {/* A plain <img> on purpose, not next/image: the cover is already a
          bounded, immutable, app-relative variant served by /media/{assetKey}.
          An image optimizer would add a round trip and a request per cover —
          which the 30-request budget cannot afford for a 24-card page — and
          client-side layout JS for a box that aspect-ratio already reserves. */}
      <img
        ref={imageRef}
        src={near ? src : undefined}
        data-src={near ? undefined : src}
        alt={alt}
        width={BOX_WIDTH}
        height={BOX_HEIGHT}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding={priority ? 'sync' : 'async'}
        onError={() => setFailed(true)}
      />
    </span>
  );
}

export default CoverImage;
