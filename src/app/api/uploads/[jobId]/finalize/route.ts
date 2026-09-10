/**
 * POST /api/uploads/{jobId}/finalize — API route shell.
 *
 * Auth: requireAdmin. 200 { ok: true, chaptersAffected } | 409
 * UPLOAD_NOT_ALLOWED (state machine) | 422 UPLOAD_PARTIAL.
 * Finalize ⇒ atomic publish (pages become visible in one write).
 */
export async function POST(): Promise<Response> {
  throw new Error('Not implemented: finalize route');
}
