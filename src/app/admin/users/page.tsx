/**
 * Admin users (`/admin/users`) route shell.
 *
 * A user's email address is PII: rendered by the UI, but never in a URL, a log
 * line or an analytics event.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../../../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Users',
};

export default function AdminUsersPage() {
  return (
    <>
      <h1>Users</h1>
      <NotYetBuilt
        headingId="admin-users-not-built"
        intent="list reader accounts and manage their access"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      {/* TODO: user list + role/status controls (guarded) */}
    </>
  );
}
