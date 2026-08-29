/**
 * The session guard: cookie in, verified user out, and the ONLY place a request's
 * identity is established. It takes the process-wide database handle through an
 * OPTIONAL parameter that falls back to the shared one, keeping the signature honest
 * for production while allowing injection.
 * `toCallerContext` is the one place a verified row is narrowed to authority; an
 * unrecognised role answers `null`, never a guess or a throw.
 */
import { acquireDb, releaseDb, type Db } from '../db/client';
import { loadEnv } from '../../shared/validation/env';
import type { CallerContext } from '../../shared/contracts';
import type { UserId } from '../../shared/types';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  status: string;
}

/**
 * Narrow a verified row to the authority this application will act on — the ONE
 * place that decision is made.
 *
 * This rule is written once for both API seams. Writing it twice is one copy too
 * many: fixing one and forgetting the other leaves a silent privilege difference
 * between `/api` and `/api/v1`. A drift that under-grants is a bug; the next one
 * might not.
 *
 * The narrowing is not a detail. It is the boundary between a role the
 * `users_role` CHECK column permits and a role the code is willing to use. A
 * database CHECK is a promise; this is the place that either honours it or
 * admits it was wrong.
 *
 * An UNRECOGNISED role answers `null` — anonymous — never a guess, never a throw.
 * Throwing would turn a data problem into a 500 on every request for that user;
 * guessing would widen authority on the way in. Anonymous is the only answer that
 * cannot be more powerful than the session actually is.
 *
 * Narrowed, not cast: the role arrives as a `string` from the row and the
 * services require the `UserRole` union.
 *
 * @param user the row the session verified, or `null` when there is no session
 * @returns the caller's authority, or `null` when there is none to grant
 */
export function toCallerContext(user: AuthenticatedUser | null): CallerContext {
  if (user === null) return null;
  if (user.role === 'reader' || user.role === 'admin') {
    return { userId: user.id as UserId, role: user.role };
  }
  return null;
}

/**
 * Resolve a request to the authority it may act with, in one call.
 *
 * This is the whole of a caller resolver: verify the session, then narrow it.
 * Both API seams use it, so neither can grant less than the other.
 *
 * @param request the incoming request
 * @param db an existing handle to use; omit to share the process-wide one
 * @returns the caller, or `null` for anonymous / unusable / unrecognised
 */
export async function resolveCallerContext(request: Request, db?: Db): Promise<CallerContext> {
  return toCallerContext(await getSessionUser(request, db));
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

/**
 * Resolve the session behind a request, or `null` when there is none or it is
 * unusable.
 *
 * `null` is deliberately overloaded across five different causes — no cookie, no
 * such session, idle expiry, absolute expiry, and a non-active user. That is not
 * laziness: distinguishing them would tell an attacker whether a session id ever
 * existed. All five answer the same way, and the *caller* decides whether that is
 * a 401 or an anonymous view.
 *
 * The two expiry checks are not redundant. `expiresAt` slides with activity;
 * `absoluteExpiresAt` does not, so a session cannot be kept alive forever by
 * continuing to use it.
 *
 * @param request the incoming request
 * @param db an existing handle to use; omit to share the process-wide one
 * @returns the verified user, or `null`
 */
export async function getSessionUser(request: Request, db?: Db): Promise<AuthenticatedUser | null> {
  const cookieHeader = request.headers.get('cookie');
  const cookies = parseCookies(cookieHeader);
  const token = cookies['session_token'] ?? request.headers.get('x-session-token');
  if (!token) return null;

  // Acquired only when a token is actually present, so an anonymous request — the
  // common case on /discover, /search and the reader — never touches the pool from
  // this path at all.
  const owned = db === undefined;
  const handle = owned ? await acquireDb(loadEnv()) : db;
  try {
    const sess = await handle.query.sessions.findFirst({
      where: (f, { eq }) => eq(f.sessionToken, token),
    });
    if (!sess) return null;
    if (new Date(sess.expiresAt) < new Date()) return null;
    if (new Date(sess.absoluteExpiresAt) < new Date()) return null;
    const user = await handle.query.users.findFirst({
      where: (f, { eq }) => eq(f.id, sess.userId),
    });
    if (!user) return null;
    if (user.status !== 'active') return null;
    return { id: user.id, email: String(user.email), role: user.role, status: user.status };
  } finally {
    if (owned) await releaseDb(handle);
  }
}

/**
 * As {@link getSessionUser}, but for callers that cannot proceed anonymously.
 *
 * Throws a bare `Error` with a `code` property, not an `AppError`: the three
 * call sites in `app/api/*` each translate this into their own 401, so changing
 * the thrown type changes their behaviour. Recorded rather than quietly fixed.
 *
 * @param request the incoming request
 * @param db an existing handle to use; omit to share the process-wide one
 * @returns the verified user
 * @throws when there is no usable session
 */
export async function requireUser(request: Request, db?: Db): Promise<AuthenticatedUser> {
  const u = await getSessionUser(request, db);
  if (!u) {
    throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED', status: 401 });
  }
  return u;
}
