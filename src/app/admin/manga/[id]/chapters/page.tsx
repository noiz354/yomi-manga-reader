/**
 * Admin chapters (`/admin/manga/[id]/chapters`) route shell.
 *
 * Chapter numbers are `numeric(8,2)` and may be decimal (10.5), so the column
 * is read with a mono, tabular figure, never a locale-formatted string.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../../../../../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Chapters',
};

export default function AdminChaptersPage(/* { params } */) {
  return (
    <>
      <h1>Chapters</h1>
      <NotYetBuilt
        headingId="admin-manga-chapters-not-built"
        intent="order a title’s chapters and manage their pages"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      {/* TODO: chapter table + create/edit + delete */}
      {/* TODO: upload/re-ingest entry points */}
    </>
  );
}
