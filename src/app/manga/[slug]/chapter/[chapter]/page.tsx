/**
 * The chapter reader's server shell.
 *
 * It renders almost nothing: `params` resolve the slug and chapter number and
 * hand them to `ReaderClient`, which owns every fetch — a reader's position is
 * client state that must survive hydration. It passes the raw `?page=N` value
 * through without clamping because the shell does not know `page_count` yet;
 * the client clamps once the page list arrives.
 */
import type { Metadata } from 'next';
import { ReaderClient } from './reader-client';
import { readRequestedPage } from '../../../../../features/reader/deep-link';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Reader' };

type Params = Promise<{ slug: string; chapter: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function ReaderPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { slug, chapter: chapterParam } = await params;
  const query = await searchParams;
  const chapterNumber = Number(chapterParam);
  if (!Number.isFinite(chapterNumber)) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Invalid chapter</h1>
      </div>
    );
  }
  // All data fetching is done client-side via /api to avoid PGlite in RSC (wasm fs
  // issue). The server renders the shell and resolves the deep link.
  return (
    <div style={{ padding: 16 }}>
      <nav aria-label="Breadcrumb" style={{ marginBottom: 12 }}>
        <a href="/discover">Catalog</a> / <a href={`/manga/${slug}`}>{slug}</a> / Chapter{' '}
        {chapterNumber}
      </nav>
      <h1>
        {slug} — Chapter {chapterNumber}
      </h1>
      <ReaderClient
        slug={slug}
        chapterNumber={chapterNumber}
        requestedPage={readRequestedPage(query['page'])}
      />
    </div>
  );
}
