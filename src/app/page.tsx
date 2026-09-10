/**
 * Home (`/`) route shell.
 *
 * Anonymous → catalog preview; authenticated → "Continue reading" (≤ 20, most
 * recent first) above the preview.
 *
 * This route is the one that uses the root layout's `default` title ("Yomi");
 * Next applies `title.template` only to CHILD segments, so this page (in the root
 * segment, like the layout) is not suffixed and every other route is.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Yomi',
};

export default function HomePage() {
  return (
    <>
      <h1>Yomi</h1>
      <NotYetBuilt
        headingId="home-not-built"
        intent="show you what to read next and what changed"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      <p className="note">
        A reading room for the manga and comics you own or are licensed to read.
      </p>
      {/* TODO: continue-reading section (authenticated) */}
      {/* TODO: catalog preview grid (all users) */}
    </>
  );
}
