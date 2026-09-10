/**
 * Admin layout (`/admin`) route shell.
 *
 * It nests inside the root layout, which already provides the page frame and the
 * single `<main>`, so this contributes only the admin sub-navigation as a
 * second, separately named `nav` landmark. The guard is NOT implemented:
 * requireAdmin needs a session, and a fake check would be worse than none.
 */
import type { ReactNode } from 'react';
import { UiLink } from '../../shared/ui/Link';

const ADMIN_NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/manga', label: 'Manga' },
  { href: '/admin/uploads', label: 'Uploads' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/audit', label: 'Audit' },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* TODO: requireAdmin guard + `no-store` for the segment.
          A non-admin must get the 403 permission page, not a redirect to
          sign-in. */}
      <nav className="admin-nav" aria-label="Admin">
        <ul>
          {ADMIN_NAV.map((item) => (
            <li key={item.href}>
              <UiLink href={item.href}>{item.label}</UiLink>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </>
  );
}
