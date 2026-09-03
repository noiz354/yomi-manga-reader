/**
 * server/media — the caller ROLE, for exactly one rule.
 *
 * Answers "is this caller an admin?" for the `/media/{assetKey}` draft rule: draft
 * keys 404 for non-admins. Nothing else: no user id is returned, no private data is
 * read, and a failure to establish a role is always `false` (fail closed → 404).
 * The cookie is the ONLY identity source; expired sessions are anonymous.
 */
import type { Db } from '../db';

/** The cookie name is `yomi_session` (HttpOnly, Secure, Lax, Path=/). */
export const SESSION_COOKIE_NAME = 'yomi_session';

/**
 * A session token is 256-bit base64url. Bounding the shape before it reaches
 * the index is cheap and keeps a hostile 4 MB cookie out of the query planner.
 */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** Extracts the session token from a raw `Cookie` header, or `undefined`. */
export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined || cookieHeader === '') return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const raw = part.slice(separator + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // A cookie that is not valid percent-encoding is not a session.
      return undefined;
    }
    return SESSION_TOKEN_PATTERN.test(value) ? value : undefined;
  }
  return undefined;
}

/**
 * True only for a live admin session.
 *
 * @param db the application handle.
 * @param cookieHeader the request's raw `Cookie` header (absent ⇒ anonymous).
 */
export async function callerIsAdmin(db: Db, cookieHeader: string | undefined): Promise<boolean> {
  const token = readSessionToken(cookieHeader);
  if (token === undefined) return false;

  const session = await db.query.sessions.findFirst({
    where: (fields, { eq }) => eq(fields.sessionToken, token),
    columns: { userId: true, expiresAt: true, absoluteExpiresAt: true },
  });
  if (session === undefined) return false;

  // Both clocks are checked: idle expiry slides, absolute expiry does not.
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) return false;
  if (session.absoluteExpiresAt.getTime() <= now) return false;

  const user = await db.query.users.findFirst({
    where: (fields, { eq }) => eq(fields.id, session.userId),
    columns: { role: true, status: true },
  });
  return user !== undefined && user.role === 'admin' && user.status === 'active';
}
