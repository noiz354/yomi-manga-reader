/**
 * Root layout: AppShell (landmarks + skip link) around every page.
 * Owns `<html lang>`, title template, global CSS (imported only here), viewport.
 */
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import AppShell from '../shared/ui/AppShell';
import { HydrationBoundary } from '../shared/ui/hydration';
import '../shared/ui/tokens.css';
import '../shared/ui/base.css';

export const metadata: Metadata = {
  // Default for the bare `/` route; every other route uses the template.
  title: {
    default: 'Yomi',
    template: '%s · Yomi',
  },
  applicationName: 'Yomi',
  description: 'Self-hosted manga and comic reader for licensed content.',
  // TODO: the canonical origin comes from APP_ORIGIN once env loading
  // exists; a placeholder URL would be a lie in a social card, so no
  // openGraph image ships in this phase.
};

export const viewport: Viewport = {
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Mounted here, and only here: the whole focus/announce
            distinction rests on this NOT remounting on a client-side
            navigation. See shared/ui/hydration.tsx. */}
        <HydrationBoundary />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
