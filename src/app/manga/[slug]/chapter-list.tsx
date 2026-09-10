/**
 * ChapterList — the reading order, as a real `<ol>`.
 *
 * A row states number · title · page count · published date, all as text, with
 * the count in tabular mono so the column lines up. The number appears twice (the
 * row's text and the `<ol>` marker) because the list is in reading order, so the
 * two agree. 200+ rows render in full with `content-visibility: auto` to keep
 * scroll honest; a row with no `publishedAt` is a draft labelled "Draft", and
 * non-admins never receive drafts. The read/unread indicator is absent until the
 * chapter payload carries read state.
 */
import type { ChapterSummary } from '../../../shared/contracts';
import { classNames } from '../../../shared/ui/classNames';
import { UiLink } from '../../../shared/ui/Link';
import { chapterLabel } from '../../discover/catalog-query';
import { chapterSegment, dateTime, formatDate } from './manga-format';
import styles from './manga-detail.module.css';

export type ChapterListProps = {
  /** The manga's slug — the reader route is `/manga/{slug}/chapter/{number}`. */
  slug: string;
  chapters: readonly ChapterSummary[];
  /** The count the detail header states. */
  totalCount: number;
  /** True when the chapter list itself could not be read. */
  unavailable: boolean;
};

export function ChapterList({ slug, chapters, totalCount, unavailable }: ChapterListProps) {
  const published = chapters.filter((chapter) => chapter.publishedAt !== null);
  const latestNumber =
    published.length === 0 ? null : (published[published.length - 1]?.number ?? null);

  if (unavailable) {
    return (
      <p className={styles.notice} role="status">
        The chapter list could not be loaded just now. The title, its synopsis and its first
        chapter are still here.
      </p>
    );
  }

  if (chapters.length === 0) {
    return (
      <div className={styles.state}>
        <h3>No chapters yet</h3>
        <p>
          Nothing is published for this title{totalCount > 0 ? ` yet (${totalCount} counted)` : ''}
          . An admin publishes chapters from the admin panel; the catalog never shows an
          unpublished one.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className={styles.chapterCount}>
        <span className="num">{chapters.length}</span>{' '}
        {chapters.length === 1 ? 'chapter' : 'chapters'} in reading order
        {totalCount > chapters.length ? ` · ${totalCount} in total` : ''}
      </p>
      <nav aria-label="Chapters">
        {/*
          The list is named by the section's own heading rather than given a
          second name, so the heading and the list cannot drift apart.
        */}
        <ol className={styles.chapters} aria-labelledby="detail-chapters-h">
          {chapters.map((chapter) => {
            const isDraft = chapter.publishedAt === null;
            return (
              <li key={chapter.id} className={styles.chapterRow}>
                <span className={classNames(styles.chapterNum, 'num')}>{chapter.number}</span>
                <span className={styles.chapterBody}>
                  {/*
                    No `aria-label` here, on purpose. The row's own text is
                    already a complete name — "Chapter 12 — The Long Repair, 26
                    pages, 2026-01-04" — and an author-supplied name that has
                    to be re-derived from the visible text is a place where the
                    two can drift apart (and where axe
                    `label-content-name-mismatch` fires). A draft row simply has
                    no date, and the word "Draft" sits beside it as a badge that
                    is part of the row.
                  */}
                  {/*
                    `prefetch={false}`: a 220-row list prefetching 220 reader
                    routes on scroll is the single largest request fan-out this
                    page could have.
                  */}
                  <UiLink
                    className={classNames(styles.chapterLink)}
                    href={`/manga/${slug}/chapter/${chapterSegment(chapter.number)}`}
                    prefetch={false}
                  >
                    {chapterLabel(chapter.number)}
                    {chapter.title === null || chapter.title === '' ? null : (
                      <span className={styles.chapterTitle}> — {chapter.title}</span>
                    )}
                  </UiLink>
                  <span className={styles.chapterMeta}>
                    <span className="num">{chapter.pageCount}</span>{' '}
                    {chapter.pageCount === 1 ? 'page' : 'pages'}
                    {isDraft ? null : (
                      <>
                        {' · '}
                        <time dateTime={dateTime(chapter.publishedAt)}>
                          {formatDate(chapter.publishedAt)}
                        </time>
                      </>
                    )}
                  </span>
                </span>
                <span className={styles.chapterFlags}>
                  {isDraft ? (
                    <span className={styles.badgeDraft}>Draft</span>
                  ) : chapter.number === latestNumber ? (
                    <span className={styles.badge}>Latest</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}

/**
 * What a row states, in one place, so the visible text and anything that ever
 * describes it are written from the same values: the chapter, its title, its
 * page count, and — for a published chapter — its date.
 */
export function chapterRowLabel(chapter: ChapterSummary): string {
  const title = chapter.title === null || chapter.title === '' ? '' : `, ${chapter.title}`;
  const pages = `${chapter.pageCount} ${chapter.pageCount === 1 ? 'page' : 'pages'}`;
  if (chapter.publishedAt === null) {
    return `${chapterLabel(chapter.number)}${title}, draft, ${pages}`;
  }
  return `${chapterLabel(chapter.number)}${title}, ${pages}, published ${formatDate(chapter.publishedAt)}`;
}

export default ChapterList;
