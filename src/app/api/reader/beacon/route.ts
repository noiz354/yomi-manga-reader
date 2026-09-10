/**
 * POST /api/reader/beacon — API route shell.
 *
 * Auth is optional (anonymous allowed; the payload carries a sessionId, never
 * account PII). Rate-limited. 202 accepted; NEVER fails the caller
 * (fire-and-forget from the client).
 */
export async function POST(): Promise<Response> {
  throw new Error('Not implemented');
}
