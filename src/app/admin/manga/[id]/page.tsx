/**
 * Admin manga edit (`/admin/manga/[id]`) route shell.
 *
 * Behavior: metadata form (all fields incl. aliases/creators/genres/tags; slug
 * immutable after first publish), cover upload, publish/unpublish toggle,
 * soft-delete/restore (confirm dialog). Every mutation emits a server-side audit
 * event.
 *
 * The heading is the surface name: the manga title is data, and a fixture title in
 * a shell would be fake product data.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../../../../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Manga',
};

export default function AdminMangaEditPage(/* { params } */) {
  return (
    <>
      <h1>Manga</h1>
      <NotYetBuilt
        headingId="admin-manga-edit-not-built"
        intent="edit a title’s metadata, cover, publication state and chapters"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      {/* TODO: metadata form + cover + publish + delete */}
    </>
  );
}
