/**
 * POST /api/auth/login — exchange credentials for a session cookie.
 *
 * An unknown email is verified against a DUMMY hash so response time does not
 * reveal whether an account exists, the failure message is uniform, and a disabled
 * account is a separate 403 that is safe because reaching it needs the password.
 *
 * Known debt: `argon2` is imported directly rather than through a `PasswordHasher`
 * port, so its parameters are not in one reviewable place.
 */
import * as argon2 from 'argon2';
import { acquireDb, releaseDb, type Db } from '../../../../server/db/client';
import { loadEnv } from '../../../../shared/validation/env';
import { readJsonBody } from '../../../../shared/http/request-body';
import {
  findUserByEmail,
  insertSession,
  touchLastLogin,
} from '../../../../server/db/repositories/session.repository';

/**
 * Request bodies are untrusted, so a field is only treated as a string when it really is one.
 * `String(value)` would accept anything and stringify objects into "[object Object]", which
 * then reads as a valid id.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const dynamic = 'force-dynamic';

const SESSION_LIFETIME_MS = 30 * 24 * 3600 * 1000;

export async function POST(request: Request): Promise<Response> {
  // Untrusted credentials input: typed by the fields read here, then coerced explicitly.
  const body = await readJsonBody<{ email?: unknown; password?: unknown }>(request).catch(
    () => undefined,
  );
  if (!body) {
    return Response.json(
      { error: { code: 'VALIDATION_BAD_QUERY', message: 'Invalid JSON' } },
      { status: 422 },
    );
  }
  const email = asString(body.email).trim();
  const password = asString(body.password);
  if (!email || !password) {
    return Response.json(
      { error: { code: 'AUTH_INVALID', message: 'Invalid credentials' } },
      { status: 401 },
    );
  }

  const db: Db = await acquireDb(loadEnv());
  try {
    const user = await findUserByEmail(db, email);

    // An unknown email still pays for one argon2 verification, so response time does not
    // reveal whether an account exists.
    if (!user) {
      try {
        await argon2.verify('$argon2id$v=19$m=65536,t=3,p=4$dummy$dummy', password);
      } catch {
        /* the dummy hash never verifies; the cost was the point */
      }
      return Response.json(
        { error: { code: 'AUTH_INVALID', message: 'Invalid credentials' } },
        { status: 401 },
      );
    }
    if (user.status === 'disabled') {
      return Response.json(
        { error: { code: 'AUTH_DISABLED', message: 'Account disabled' } },
        { status: 403 },
      );
    }

    let verified = false;
    try {
      verified = await argon2.verify(user.passwordHash, password);
    } catch {
      verified = false;
    }
    if (!verified) {
      return Response.json(
        { error: { code: 'AUTH_INVALID', message: 'Invalid credentials' } },
        { status: 401 },
      );
    }

    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await insertSession(db, {
      id: crypto.randomUUID(),
      userId: user.id,
      sessionToken: token,
      createdAt: now,
      expiresAt,
      absoluteExpiresAt: expiresAt,
      lastSeenAt: now,
    });
    await touchLastLogin(db, user.id, now);

    // `secure` is omitted on purpose: the PGlite dev fallback is served over plain http on
    // loopback, and a secure cookie there would never be stored by the browser.
    const cookie = `session_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`;
    return new Response(
      JSON.stringify({
        ok: true,
        user: { id: user.id, email: user.email, displayName: user.displayName },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': cookie } },
    );
  } finally {
    await releaseDb(db);
  }
}
