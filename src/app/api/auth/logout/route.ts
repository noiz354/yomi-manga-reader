/**
 * POST /api/auth/logout — revoke the session and clear the cookie.
 *
 * The cookie is cleared with attributes MATCHING the one set at login: a
 * `Set-Cookie` differing in `path`, `secure` or `httpOnly` leaves the original
 * in place and the browser keeps sending it. Session storage uses the
 * process-wide handle, so this route opens no pool of its own. Revocation is by
 * token and immediate; there is no "sign out everywhere" path.
 */
import { acquireDb, releaseDb, type Db } from '../../../../server/db/client';
import { loadEnv } from '../../../../shared/validation/env';
import { deleteSessionByToken } from '../../../../server/db/repositories/session.repository';

export const dynamic = 'force-dynamic';

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join('='));
  }
  return out;
}

export async function POST(request: Request): Promise<Response> {
  const token = parseCookies(request.headers.get('cookie'))['session_token'];
  if (token) {
    const db: Db = await acquireDb(loadEnv());
    try {
      await deleteSessionByToken(db, token);
    } finally {
      await releaseDb(db);
    }
  }
  // The cookie is cleared whether or not a session row existed: logout is idempotent, and a
  // stale cookie in the browser is the thing that actually keeps a user signed in.
  const cleared = 'session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': cleared },
  });
}
