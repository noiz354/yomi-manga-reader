/**
 * AppShell — the page frame (landmarks + skip link).
 *
 * The shell owns the single `main` landmark, so pages must not render their own.
 * `tabIndex={-1}` on the target lets the skip link move focus without making the
 * target a tab stop. The skip link is the first element the shell emits, and the
 * root layout renders nothing focusable above it, so it is the first focusable
 * element in the document on every route.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { UiLink } from './Link';

/**
 * The route map, in nav order. These are links to planned routes, not product
 * data: this phase makes the map clickable so the shells can be walked in a
 * browser.
 *
 * TODO: the library/history/bookmarks/settings group is authenticated — it is
 * rendered unconditionally here because a session does not exist yet.
 */
const PRIMARY_NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/discover', label: 'Catalog' },
  { href: '/search', label: 'Search' },
  { href: '/library', label: 'Library' },
  { href: '/history', label: 'History' },
  { href: '/bookmarks', label: 'Bookmarks' },
  { href: '/settings', label: 'Settings' },
];

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Skip link: FIRST focusable element in the document. Off-screen until
          focused, so it costs no layout. */}
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <header className="shell-header">
        <div className="shell-header__in">
          {/* The wordmark is a link home, not the page's h1: the h1 belongs
              to the page.

              `prefetch={false}` on both link sets is a budget decision, not a
              preference. With prefetch left on, the six nav links (plus the
              wordmark) were fetched TWICE during a cold page load, spending more
              than 40% of the request budget for a catalog page on routes the
              reader never asked for. Four of the six are authenticated surfaces
              that redirect an anonymous visitor to sign-in, so the payload is
              discarded as well as wasted.

              TODO: when the nav becomes session-aware, prefetch can be decided
              per link. */}
          <Link className="brand" href="/" prefetch={false}>
            Yomi
          </Link>
          <nav className="shell-nav" aria-label="Site">
            <ul>
              {PRIMARY_NAV.map((item) => (
                <li key={item.href}>
                  <UiLink href={item.href} prefetch={false}>
                    {item.label}
                  </UiLink>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>

      <main className="shell-main" id="main" tabIndex={-1}>
        {children}
      </main>

      <footer className="shell-footer">
        <div className="shell-footer__in">
          <p>Yomi — self-hosted manga &amp; comic reader.</p>
          {/* TODO: the admin link is admin-only and depends on the session; it
              is not rendered until roles exist. */}
        </div>
      </footer>
    </>
  );
}
