/**
 * Admin uploads (`/admin/uploads`) route shell.
 *
 * Planned: a job list whose states are rendered exactly (queued / validating /
 * processing / ready / failed, polled every 3 s while active), typed failure
 * reasons, links to results, and queue health. No feature code in this phase.
 * State is never carried by colour alone: each state carries its label and a
 * failure carries its typed reason.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../../../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Uploads',
};

export default function AdminUploadsPage() {
  return (
    <>
      <h1>Uploads</h1>
      <NotYetBuilt
        headingId="admin-uploads-not-built"
        intent="list uploaded assets and manage them"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      {/* TODO: job list (live states) + failure reasons */}
    </>
  );
}
