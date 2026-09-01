/**
 * Edge middleware — PRESENCE-ONLY session check.
 *
 * This file NEVER authenticates: it only inspects the cookie's presence to
 * decide redirect-to-signin UX. The authoritative (DB-verified) check lives in
 * the server/auth guards. No token parsing, crypto, or DB access.
 *
 * `matcher: []` is NOT inert in a production build: it runs on every path, so
 * the throw below would 500 the whole app (including `/healthz`), while
 * `next dev` wrongly honours it. The matcher below is an unreachable path
 * literal, inert in dev and in a build. Replace it with the authenticated
 * route prefixes (library, history, bookmarks, settings, admin).
 */
export function middleware(/* request: NextRequest */): Promise<Response> {
  throw new Error('Not implemented: edge presence check');
}

export const config = {
  // TODO: the authenticated route prefixes
  // (library, history, bookmarks, settings, admin). Until then this matches
  // nothing on purpose — `[]` will not do.
  matcher: ['/__t-auth-007-matcher-not-configured__'],
};
