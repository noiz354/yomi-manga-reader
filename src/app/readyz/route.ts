/**
 * Readiness endpoint (`GET /readyz`).
 *
 * 200 { ok: true } only if a PG `SELECT 1` and a storage canary HEAD both
 * succeed; otherwise 503 { ok: false, missing: ["db"|"storage"] }. No detail
 * beyond `missing` — no versions, no error text. Unauthenticated and uncached.
 */
export async function GET(): Promise<Response> {
  // TODO: implement (PG ping + storage canary).
  throw new Error('Not implemented');
}
