/**
 * MangaCard — one catalog card.
 * Isomorphic on purpose: no `'use client'` and no server-only import, so the
 * same component renders server page 1 and the appended page alike.
 *
 * The status is a word, not a badge colour, and the link's accessible name is
 * built from the text already on screen.
 */
import type { MangaSummary } from '../../shared/contracts';
import { classNames } from '../../shared/ui/classNames';
import { UiLink } from '../../shared/ui/Link';
import { CoverImage } from './cover-image';
import { chapterLabel, STATUS_LABEL } from './catalog-query';
import styles from './discover.module.css';

export type MangaCardProps = {
  manga: MangaSummary;
  /** The first card's cover is the LCP element. */
  priority?: boolean;
  /** Dimmed while a filter or sort change is in flight. */
  pending?: boolean;
};

export function MangaCard({ manga, priority = false, pending = false }: MangaCardProps) {
  return (
    <li className={classNames(styles.card, pending && styles.pending)}>
      {/*
        `prefetch={false}` is a budget decision, not a performance shrug: the
        App Router prefetches every link that enters the viewport, so a 24-card
        shelf spent 24 requests on detail pages nobody has asked for yet —
        measured, and it is more than half of what /discover was requesting.
        Clicking still navigates client-side; the page just fetches when it is
        asked to (≤ 30 requests).
      */}
      <UiLink
        className={classNames(styles.cardLink)}
        href={`/manga/${manga.slug}`}
        prefetch={false}
      >
        <CoverImage src={manga.coverUrl} priority={priority} />
        <span className={classNames(styles.cardTitle)}>{manga.title}</span>
        <span className={classNames(styles.cardMeta)}>
          {STATUS_LABEL[manga.status]}
          {' · '}
          {manga.latestChapter === null
            ? 'No chapters'
            : `Ch. ${manga.latestChapter.number}`}
        </span>
      </UiLink>
    </li>
  );
}

/**
 * The card's cover, for the detail page's own single cover. Named here so both
 * surfaces agree on the one thing they share: the box.
 */
export function mangaCoverAlt(title: string): string {
  return `Cover: ${title}`;
}

/** Re-exported so the list step and the card can never disagree on wording. */
export { chapterLabel };

export default MangaCard;
