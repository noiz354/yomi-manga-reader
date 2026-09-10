/**
 * Admin manga list (`/admin/manga`) route shell.
 *
 * Intended behavior: cursor list (title, status, chapter count, publish state,
 * deleted flag), a "New manga" action, and a status/deleted filter. Destructive
 * actions require confirm dialogs.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../../../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Manga',
};

export default function AdminMangaListPage() {
  return (
    <>
      <h1>Manga</h1>
      <NotYetBuilt
        headingId="admin-manga-not-built"
        intent="list every title and start a new one"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      {/* TODO: manga list + create form entry */}
    </>
  );
}
