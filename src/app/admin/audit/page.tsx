/**
 * Admin audit log (`/admin/audit`) route shell.
 *
 * Intended behavior: a filterable cursor list (target kind/id), events with
 * actor (email; `<deleted>` provenance retained), action, before/after pretty
 * JSON (summarized, 2 KB/field cap) and timestamps (UTC stored, displayed
 * local). This route is read-only, and reads are not audited.
 *
 * The audit trail is the security control, so before/after values must be
 * rendered as TEXT in a `<pre>`, never interpreted as markup, and the JSON view
 * is a disclosure the user opens deliberately — not something the list streams
 * into the page.
 */
import type { Metadata } from 'next';
import { NotYetBuilt } from '../../../shared/ui/StateRegion';

export const metadata: Metadata = {
  title: 'Audit',
};

export default function AdminAuditPage() {
  return (
    <>
      <h1>Audit</h1>
      <NotYetBuilt
        headingId="admin-audit-not-built"
        intent="list the audit trail and let an operator filter it"
        actions={[{ href: '/discover', label: 'Browse the catalog', primary: true }]}
      />
      {/* TODO: audit list + filters + before/after view */}
    </>
  );
}
