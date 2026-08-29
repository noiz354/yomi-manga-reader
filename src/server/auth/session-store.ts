/**
 * server/auth — session store implementation + guard mechanics.
 * Cookie issuance/reading follows the flag contract: HttpOnly, Secure in prod,
 * SameSite=Lax, Path=/. Cookies are set and cleared with matching attributes.
 * The middleware does PRESENCE-ONLY checks for redirect UX; the guards here are
 * the security boundary, so disabled users fail at the guard (status re-read
 * per request). Token comparison is constant-time.
 */
export function createSessionStore(/* db: Db */): unknown {
  throw new Error('Not implemented: session store');
}

/**
 * Guard contract (consumed by route handlers):
 *   requireUser(ctx)   → Caller | throws AUTH_REQUIRED
 *   requireAdmin(ctx)  → Caller | throws AUTH_REQUIRED | AUTH_FORBIDDEN
 * The Caller is the ONLY identity source downstream.
 */
export interface Guard {
  requireUser(): Promise<import('../../shared/contracts').Caller>;
  requireAdmin(): Promise<import('../../shared/contracts').Caller>;
}
