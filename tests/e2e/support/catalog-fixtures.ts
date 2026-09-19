/**
 * Deterministic catalog fixtures for the catalog E2E specs. TEST
 * INFRASTRUCTURE — not product data and not a seed.
 * The API handlers these pages consume did not exist when these specs were
 * written, so the harness answers the contract at the network boundary and the
 * specs exercise the real server-rendered pages. Once the real handlers exist
 * this file can be deleted. No clock or randomness, so pagination cannot flake.
 */
import type {
  ChapterSummary,
  MangaDetail,
  MangaStatus,
  MangaSummary,
  ReadingDirection,
} from '../../../src/shared/contracts';
import type { ChapterId, MangaId, MangaSlug } from '../../../src/shared/types';

/**
 * The fixture ids are strings, and the DTOs carry branded ids
 * (shared/types/ids.ts). The brand is a compile-time-only symbol, so this cast
 * is sound by construction — the same reconciliation the app's own schema
 * performs at the wire boundary, done once here instead of 240 times.
 */
const asChapterId = (value: string): ChapterId => value as ChapterId;
const asMangaId = (value: string): MangaId => value as MangaId;
const asMangaSlug = (value: string): MangaSlug => value as MangaSlug;

/** What `GET /api/v1/catalog/facets` returns. */
export interface GenreFacet {
  slug: string;
  name: string;
}

/** A fixture title plus the chapter rows its detail page renders. */
export interface FixtureManga {
  summary: MangaSummary;
  detail: MangaDetail;
  chapters: ChapterSummary[];
  /** `assetKey` whose bytes the harness actually serves. */
  coverAssetKey: string | null;
}

const DAY = 86_400_000;
/** Fixed epoch so nothing in the dataset depends on the clock. */
const EPOCH = Date.parse('2026-01-05T09:00:00.000Z');

function iso(daysFromEpoch: number): string {
  return new Date(EPOCH + daysFromEpoch * DAY).toISOString();
}

/** URL-safe slug for a genre name — mirrors how the API derives it. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export const GENRE_NAMES: readonly string[] = [
  'Action',
  'Adventure',
  'Afterlife',
  'Angels & Demons',
  'Animals',
  'Award Winning',
  'Comedy',
  'Crime',
  'Cyberpunk',
  'Delinquents',
  'Drama',
  'Fantasy',
  'Food',
  'Gag Humor',
  'Historical',
  'Horror',
  'Isekai',
  'Josei',
  'Martial Arts',
  'Mecha',
  'Medical',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'School Life',
  'Seinen',
  'Shoujo',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Thriller',
];

export const GENRE_FACETS: readonly GenreFacet[] = GENRE_NAMES.map((name) => ({
  slug: slugify(name),
  name,
}));

interface Seed {
  slug: string;
  title: string;
  status: MangaStatus;
  direction?: ReadingDirection;
  chapterTotal: number;
  /** Cover bytes the harness serves; `null` → `coverUrl: null` (placeholder). */
  cover: boolean;
  /** A `coverUrl` the harness deliberately does NOT serve (404 → placeholder). */
  danglingCover?: boolean;
  synopsis?: string;
  aliases?: readonly string[];
  tags?: readonly string[];
  creators?: ReadonlyArray<{ name: string; role: 'author' | 'artist' | 'other' }>;
  genres?: readonly string[];
  /** Trailing draft chapter (publishedAt null) — the admin-only row. */
  draftChapter?: boolean;
  createdDaysAgo: number;
}

/**
 * The dataset. Order here is the dataset's own; the harness applies `sort`.
 * Titles 1–30 give the pagination boundary; the named rows after them carry the
 * edge cases.
 */
const SEEDS: readonly Seed[] = [
  ...Array.from({ length: 30 }, (_unused, index) => {
    const n = index + 1;
    return {
      slug: `title-${String(n).padStart(2, '0')}`,
      title: `Ledger Volume ${String(n).padStart(2, '0')} — The ${[
        'Binding',
        'Furniture',
        'Catalogue',
        'Marginalia',
        'Repair',
        'Transfer',
      ][index % 6]} of Stacks`,
      status: (['ongoing', 'completed', 'hiatus'] as const)[index % 3] ?? 'ongoing',
      chapterTotal: 4 + (index % 9),
      cover: true,
      synopsis: `A working note about volume ${n}, kept by whoever last shelved it.`,
      aliases: n === 1 ? ['Ledger 1', 'The Binding', 'Stacks I', 'Renamed 2024'] : [],
      tags: ['cataloguing', 'workplace'],
      creators: [
        { name: `Author ${n}`, role: 'author' as const },
        { name: `Artist ${n}`, role: 'artist' as const },
      ],
      genres: [GENRE_NAMES[index % GENRE_NAMES.length] ?? 'Drama', 'Drama'],
      createdDaysAgo: 200 - n,
    } satisfies Seed;
  }),
  {
    slug: 'no-cover-asset',
    title: 'A Title Whose Cover Was Never Uploaded',
    status: 'ongoing',
    chapterTotal: 3,
    cover: false,
    synopsis: 'The cover asset key is null, so the card must render the placeholder.',
    genres: ['Drama'],
    createdDaysAgo: 40,
  },
  {
    slug: 'cover-request-fails',
    title: 'A Title Whose Cover 404s',
    status: 'ongoing',
    chapterTotal: 2,
    cover: true,
    danglingCover: true,
    synopsis: 'The cover key exists in the database but the object is not in storage.',
    genres: ['Horror'],
    createdDaysAgo: 39,
  },
  {
    slug: 'empty-synopsis',
    title: 'A Title With Nothing Written Down',
    status: 'hiatus',
    chapterTotal: 2,
    cover: true,
    synopsis: '',
    genres: ['Slice of Life'],
    createdDaysAgo: 38,
  },
  {
    slug: 'no-chapters',
    title: 'A Title With No Chapters Yet',
    status: 'ongoing',
    chapterTotal: 0,
    cover: true,
    synopsis: 'Nothing is readable yet; the detail page must say so, not render an empty list.',
    genres: ['Drama'],
    createdDaysAgo: 37,
  },
  {
    slug: 'single-chapter',
    title: 'A Single-Chapter Story',
    status: 'completed',
    chapterTotal: 1,
    cover: true,
    synopsis: 'One chapter: the first chapter IS the latest chapter.',
    genres: ['Comedy'],
    createdDaysAgo: 36,
  },
  {
    slug: 'long-series',
    title: 'A Very Long Series',
    status: 'ongoing',
    chapterTotal: 220,
    cover: true,
    synopsis: 'Two hundred and twenty chapters, rendered in full with no virtualization.',
    genres: ['Fantasy', 'Action'],
    createdDaysAgo: 35,
  },
  {
    slug: 'series-with-draft',
    title: 'A Series An Admin Can See A Draft Of',
    status: 'ongoing',
    chapterTotal: 3,
    cover: true,
    draftChapter: true,
    synopsis: 'The last row has no publish date, which is how a draft is identified.',
    genres: ['Sports'],
    createdDaysAgo: 34,
  },
  {
    slug: 'left-to-right',
    title: 'A Left To Right Series',
    status: 'ongoing',
    direction: 'ltr',
    chapterTotal: 5,
    cover: true,
    synopsis: 'Reading direction is part of the catalogue and is not always RTL.',
    genres: ['Sports'],
    createdDaysAgo: 33,
  },
];

function buildChapters(seed: Seed): ChapterSummary[] {
  const rows: ChapterSummary[] = [];
  for (let n = 1; n <= seed.chapterTotal; n += 1) {
    rows.push({
      id: asChapterId(`${seed.slug}-chapter-${n}`),
      number: n,
      // Every fourth chapter is untitled (the contract's `title: null`), which
      // is the case the row has to render as a bare number. The titles are real
      // chapter titles, not "Chapter N — …": the row already prints the number,
      // and a title that repeats it is a fixture artefact, not a product one.
      title: n % 4 === 0 ? null : ['The Loan', 'Shelf Nine', 'A Repair', 'Notes'][n % 4] ?? 'The Loan',
      pageCount: 12 + ((n * 7) % 40),
      publishedAt: iso(-(seed.chapterTotal - n)),
    });
  }
  if (seed.draftChapter === true) {
    rows.push({
      id: asChapterId(`${seed.slug}-chapter-draft`),
      number: seed.chapterTotal + 1,
      title: 'An unpublished chapter',
      pageCount: 0,
      publishedAt: null,
    });
  }
  return rows;
}

function buildManga(seed: Seed): FixtureManga {
  const chapters = buildChapters(seed);
  const lastPublished = [...chapters].reverse().find((row) => row.publishedAt !== null);
  const first = chapters.find((row) => row.publishedAt !== null) ?? null;
  // Two different things, deliberately: the key the CARD asks for, and the key
  // the harness actually has bytes for. `cover-request-fails` has the first
  // without the second — a key in the database whose object is not in storage,
  // which is the reason the placeholder has to exist at all.
  const coverAssetKey = seed.cover === false ? null : `${seed.slug}-cover`;

  const summary: MangaSummary = {
    id: asMangaId(`${seed.slug}-id`),
    slug: asMangaSlug(seed.slug),
    title: seed.title,
    status: seed.status,
    coverUrl:
      seed.cover === false
        ? null
        : `/media/${seed.danglingCover === true ? `${seed.slug}-cover-dangling` : coverAssetKey}`,
    latestChapter:
      lastPublished === undefined
        ? null
        : {
            number: lastPublished.number,
            title: lastPublished.title,
            publishedAt: lastPublished.publishedAt ?? iso(0),
          },
  };

  const detail: MangaDetail = {
    ...summary,
    aliases: [...(seed.aliases ?? [])],
    synopsis: seed.synopsis ?? '',
    readingDirection: seed.direction ?? 'rtl',
    chapterCount: chapters.filter((row) => row.publishedAt !== null).length,
    firstChapter: first === null ? null : { id: first.id, number: first.number },
    creators: (seed.creators ?? [{ name: 'Anonymous', role: 'author' as const }]).map(
      (creator, position) => ({ id: `${seed.slug}-creator-${position}`, ...creator }),
    ),
    genres: (seed.genres ?? ['Drama']).map((name, position) => ({
      id: `${slugify(name)}-${position}`,
      name,
    })),
    tags: (seed.tags ?? []).map((name) => ({ id: slugify(name), name })),
    createdAt: iso(-seed.createdDaysAgo),
    // continue-reading has not landed: the field is ABSENT for every caller,
    // so no fixture sets it and the page must not fake one.
  };

  return { summary, detail, chapters, coverAssetKey };
}

/** Every fixture title, in insertion order. */
export const FIXTURE_MANGA: readonly FixtureManga[] = SEEDS.map((seed) => buildManga(seed));

/** Slugs the harness answers with 404 (unpublished / soft-deleted / unknown). */
export const UNREADABLE_SLUGS: ReadonlySet<string> = new Set([
  'unpublished-draft',
  'soft-deleted',
]);

/** The slug that makes the harness fail, to exercise the page's error state. */
export const FAILING_SLUG = 'upstream-unavailable';

/** The genre slug whose facets call fails, to exercise the filter's own state. */
export const FAILING_FACETS_MARKER = 'facets-unavailable';

export interface CatalogQueryInput {
  genre: readonly string[];
  status: string | null;
  sort: string;
  limit: number;
  cursor: string | null;
}

export interface CatalogQueryResult {
  items: MangaSummary[];
  nextCursor: string | null;
}

/** Encodes an offset into the opaque cursor the contract describes. */
export function encodeCursor(offset: number): string {
  return Buffer.from(`off:${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = raw.match(/^off:(\d+)$/);
    const offset = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    return Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

const STATUS_VALUES: readonly string[] = ['ongoing', 'completed', 'hiatus'];

/** The full filter/sort/cursor pipeline, so the E2E asserts real query wiring. */
export function queryCatalog(input: CatalogQueryInput): CatalogQueryResult {
  const byStatus = new Set(STATUS_VALUES);
  const wanted = new Set(input.genre);

  let rows = FIXTURE_MANGA.filter((manga) => {
    if (byStatus.has(input.status ?? '') && manga.summary.status !== input.status) return false;
    if (wanted.size > 0) {
      const names = manga.detail.genres.map((genre) => slugify(genre.name));
      for (const slug of wanted) if (!names.includes(slug)) return false;
    }
    return true;
  });

  const sorted = [...rows];
  if (input.sort === 'title_asc') {
    sorted.sort((a, b) => a.summary.title.localeCompare(b.summary.title));
  } else if (input.sort === 'added_desc') {
    sorted.sort((a, b) => b.detail.createdAt.localeCompare(a.detail.createdAt));
  } else {
    sorted.sort(
      (a, b) =>
        (b.summary.latestChapter?.publishedAt ?? '').localeCompare(
          a.summary.latestChapter?.publishedAt ?? '',
        ) || a.summary.title.localeCompare(b.summary.title),
    );
  }
  rows = sorted;

  const offset = decodeCursor(input.cursor);
  const page = rows.slice(offset, offset + input.limit);
  const nextOffset = offset + page.length;
  return {
    items: page.map((manga) => manga.summary),
    nextCursor: nextOffset < rows.length ? encodeCursor(nextOffset) : null,
  };
}

export function findBySlug(slug: string): FixtureManga | undefined {
  return FIXTURE_MANGA.find((manga) => manga.summary.slug === slug);
}
