/**
 * Admin dashboard (`/admin`) route shell.
 *
 * Planned: stats (counts plus 24 h / 30 d upload health) and empty-catalog
 * onboarding for fresh instances. No feature code in this phase. The admin nav
 * landmark is rendered by `admin/layout.tsx`, not here.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Admin',
};

export default function AdminDashboardPage() {
  return (
    <>
      <h1>Admin</h1>
      <NotYetBuilt
        headingId="admin-not-built"
        intent="link together the admin sections that exist"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      {/* TODO: stats + onboarding empty state */}
    </>
  );
}
