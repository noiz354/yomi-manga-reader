/**
 * The search repository: one composed query, four bands, a keyset cursor.
 * A single statement returns manga, creator and tag hits, each carrying its
 * best band (exact > prefix > contains > related), and never an unpublished,
 * soft-deleted or draft title. `q` is never built into SQL — only bound
 * parameters, with LIKE metacharacters escaped — and an empty `q` returns no
 * rows rather than the whole catalogue.
 */
import { sql } from 'drizzle-orm';
import { AppError } from '../../../shared/contracts/errors';
import type { Db } from '../client';
import type { SearchRepository } from '../../../features/search/search.repository';

/** Band ranks, best first. The score IS the rank weight, higher is better. */
const RANKS = { exact: 1, prefix: 2, contains: 3, related: 4 } as const;
const SCORES = { exact: 400, prefix: 300, contains: 200, related: 100 } as const;

/** What a `q` that must not touch contains looks like: 1–2 CJK code points. */
const CJK_RE =
  // CJK Unified Ideographs (incl. extensions A–F), Hiragana, Katakana, Hangul
  // (syllables, Jamo, compat), CJK symbols/punctuation, fullwidth forms.
  /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2EBEF}\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u3000-\u303F\uFF00-\uFFEF]{1,2}$/u;

/** Escape the three LIKE metacharacters so `q` is always data. */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Whether `q`, trimmed, is a short CJK query that takes the prefix path only. */
export function isShortCjkQuery(q: string): boolean {
  return CJK_RE.test(q.trim());
}

/** The cursor payload. `k` is `lower(sort_title)` — exactly the ORDER BY key. */
interface SearchCursor {
  v: 1;
  s: 'search';
  r: number;
  k: string;
  i: string;
}

function encodeCursor(rank: number, lowerTitle: string, id: string): string {
  const payload: SearchCursor = { v: 1, s: 'search', r: rank, k: lowerTitle, i: id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or throw `CATALOG_PAGE_INVALID` (422) — the same code the
 * catalog repositories use for a hostile cursor, because the failure is the
 * same shape: data that cannot be trusted as a position.
 */
function decodeCursor(cursor: string): SearchCursor {
  const invalid = (): never => {
    throw new AppError('CATALOG_PAGE_INVALID');
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) return invalid();
  const candidate = parsed as Partial<SearchCursor>;
  if (candidate.v !== 1 || candidate.s !== 'search') return invalid();
  if (typeof candidate.r !== 'number' || !Number.isInteger(candidate.r)) return invalid();
  if (typeof candidate.k !== 'string' || typeof candidate.i !== 'string') return invalid();
  if (candidate.k === '' || candidate.i === '') return invalid();
  return { v: 1, s: 'search', r: candidate.r, k: candidate.k, i: candidate.i };
}

type RawHit = {
  kind: string;
  id: string;
  slug: string | null;
  title: string;
  match_field: string;
  rank: number;
  score: number;
  sort_title: string;
};

/**
 * One composed query per search: no N+1 fan-out.
 *
 * The visibility filter is per BRANCH rather than once at the end: a filter in
 * the outer query would change which rows survive after the cursor was minted
 * against positions that had already counted the excluded ones.
 */
function searchQuery(
  q: string,
  allowContains: boolean,
  limitPlusOne: number,
  cursor: SearchCursor | null,
): ReturnType<typeof sql<RawHit>> {
  const escaped = escapeLike(q);

  const visibility = sql`m.published AND m.deleted_at IS NULL`;

  const containsGate = allowContains
    ? sql``
    : sql`AND FALSE /* 1–2 CJK code points: prefix path only, trigram contains is noise at this length */`;

  // The cursor is a position on the ORDER BY keys. A row comparison is the only
  // predicate that restarts exactly where the last page stopped.
  const cursorGate =
    cursor === null
      ? sql``
      : sql`AND (b.rank, lower(b.sort_title), b.id) > (${cursor.r}, ${cursor.k}, ${cursor.i})`;

  return sql<RawHit>`
    WITH ranked AS (
      -- exact: the whole title, case-insensitive
      SELECT m.id, m.slug, m.title, 'manga' AS kind,
             'title' AS match_field, m.title AS sort_title,
             ${RANKS.exact}::integer AS rank, ${SCORES.exact}::integer AS score
        FROM manga m
       WHERE ${visibility} AND lower(m.title) = lower(${q})
      UNION ALL
      -- prefix: title
      SELECT m.id, m.slug, m.title, 'manga',
             'title', m.title,
             ${RANKS.prefix}::integer, ${SCORES.prefix}::integer
        FROM manga m
       WHERE ${visibility} AND lower(m.title) LIKE lower(${escaped}) || '%' ESCAPE '\\'
      UNION ALL
      -- prefix: alias
      SELECT m.id, m.slug, m.title, 'manga',
             'alias', m.title,
             ${RANKS.prefix}::integer, ${SCORES.prefix}::integer
        FROM manga m
        JOIN manga_alias a ON a.manga_id = m.id
       WHERE ${visibility} AND lower(a.alias) LIKE lower(${escaped}) || '%' ESCAPE '\\'
      UNION ALL
      -- contains: title (trigram similarity OR substring — see the file header
      -- for why one without the other is the band's name lying)
      SELECT m.id, m.slug, m.title, 'manga',
             'title', m.title,
             ${RANKS.contains}::integer, ${SCORES.contains}::integer
        FROM manga m
       WHERE ${visibility}
         ${containsGate}
         AND (m.title % ${q}
              OR lower(m.title) LIKE '%' || lower(${escaped}) || '%' ESCAPE '\\')
      UNION ALL
      -- contains: alias
      SELECT m.id, m.slug, m.title, 'manga',
             'alias', m.title,
             ${RANKS.contains}::integer, ${SCORES.contains}::integer
        FROM manga m
        JOIN manga_alias a ON a.manga_id = m.id
       WHERE ${visibility}
         ${containsGate}
         AND (a.alias % ${q}
              OR lower(a.alias) LIKE '%' || lower(${escaped}) || '%' ESCAPE '\\')
      UNION ALL
      -- related: the creator row itself
      SELECT c.id, NULL AS slug, c.name, 'creator',
             'creator', c.name,
             ${RANKS.related}::integer, ${SCORES.related}::integer
        FROM creator c
       WHERE lower(c.name) LIKE lower(${escaped}) || '%' ESCAPE '\\'
          OR lower(c.name) LIKE '%' || lower(${escaped}) || '%' ESCAPE '\\'
          OR c.name % ${q}
      UNION ALL
      -- related: titles that carry a matching creator
      SELECT m.id, m.slug, m.title, 'manga',
             'creator', m.title,
             ${RANKS.related}::integer, ${SCORES.related}::integer
        FROM manga m
        JOIN manga_creator mc ON mc.manga_id = m.id
        JOIN creator c ON c.id = mc.creator_id
       WHERE ${visibility}
         AND (lower(c.name) LIKE lower(${escaped}) || '%' ESCAPE '\\'
              OR lower(c.name) LIKE '%' || lower(${escaped}) || '%' ESCAPE '\\'
              OR c.name % ${q})
      UNION ALL
      -- related: the tag row itself
      SELECT t.id, NULL AS slug, t.name, 'tag',
             'tag', t.name,
             ${RANKS.related}::integer, ${SCORES.related}::integer
        FROM tag t
       WHERE lower(t.name) LIKE lower(${escaped}) || '%' ESCAPE '\\'
          OR lower(t.name) LIKE '%' || lower(${escaped}) || '%' ESCAPE '\\'
          OR t.name % ${q}
      UNION ALL
      -- related: titles that carry a matching tag
      SELECT m.id, m.slug, m.title, 'manga',
             'tag', m.title,
             ${RANKS.related}::integer, ${SCORES.related}::integer
        FROM manga m
        JOIN manga_tag mt ON mt.manga_id = m.id
        JOIN tag t ON t.id = mt.tag_id
       WHERE ${visibility}
         AND (lower(t.name) LIKE lower(${escaped}) || '%' ESCAPE '\\'
              OR lower(t.name) LIKE '%' || lower(${escaped}) || '%' ESCAPE '\\'
              OR t.name % ${q})
    ),
    -- A title matched in two bands answers once, with its best one. The ORDER
    -- BY inside DISTINCT ON is what "best" means, and it is the band rank —
    -- nothing else in this query is allowed to decide precedence.
    best AS (
      SELECT DISTINCT ON (kind, id)
             kind, id, slug, title, match_field, sort_title, rank, score
        FROM ranked
       ORDER BY kind, id, rank ASC
    )
    SELECT b.kind, b.id, b.slug, b.title,
           b.match_field, b.rank, b.score, b.sort_title
      FROM best b
     WHERE TRUE
       ${cursorGate}
     ORDER BY b.rank ASC, lower(b.sort_title) ASC, b.id ASC
     LIMIT ${limitPlusOne}
  `;
}

export function createSearchRepository(db: Db): SearchRepository {
  return {
    async searchRaw(input: { q: string; limit: number; cursor: string | null }) {
      const q = input.q.trim();
      // An empty q after trim would answer `LIKE '%%'` — the whole catalogue.
      // The service rejects it as a 422; this level answers "nothing" rather than
      // "everything", because the port cannot be called into listing all titles.
      if (q === '') return { rows: [], nextCursor: null };

      const limit = Math.min(Math.max(Math.floor(input.limit), 1), 48);
      const decoded: SearchCursor | null =
        input.cursor === null ? null : decodeCursor(input.cursor);
      const rows = await db.execute(searchQuery(q, !isShortCjkQuery(q), limit + 1, decoded));

      const hasMore = rows.length > limit;
      const kept = (hasMore ? rows.slice(0, limit) : rows) as RawHit[];
      const last = kept[kept.length - 1];
      const nextCursor =
        hasMore && last !== undefined
          ? encodeCursor(last.rank, last.sort_title.toLowerCase(), last.id)
          : null;

      return {
        rows: kept.map((row) => ({
          kind: row.kind as 'manga' | 'creator' | 'tag',
          id: row.id,
          slug: row.slug,
          title: row.title,
          matchField: row.match_field as 'title' | 'alias' | 'creator' | 'tag',
          band:
            row.rank === RANKS.exact
              ? 'exact'
              : row.rank === RANKS.prefix
                ? 'prefix'
                : row.rank === RANKS.contains
                  ? 'contains'
                  : 'related',
          score: row.score,
        })),
        nextCursor,
      };
    },
  };
}
