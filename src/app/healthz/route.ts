/**
 * Liveness endpoint (`GET /healthz`).
 *
 * 200 { ok: true }, unauthenticated, uncached, constant, and must stay 200 when
 * the DB is down — that is what readiness is for. The file imports nothing: no
 * database, storage, logger, clock or environment read, so nothing here can
 * throw or block. `force-dynamic` plus `Cache-Control: no-store` keep the answer
 * coming from the running process rather than a prerendered artifact.
 */

/** Never cached, never prerendered: the answer must come from the process. */
export const dynamic = 'force-dynamic';

/** The only two keys that may appear. `ok: false` is never returned here. */
const BODY = JSON.stringify({ ok: true });

export async function GET(): Promise<Response> {
  return new Response(BODY, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      // Liveness is a process signal, not a document: no sniffing, and
      // nothing to leak a route to.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}
