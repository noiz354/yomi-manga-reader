/**
 * POST /api/uploads/prepare — API route shell.
 *
 * Auth: requireAdmin → 401/403. Body (chapterId, pageCount, totalBytes) → 400
 * VALIDATION (limits), 409 UPLOAD_NOT_ALLOWED (state), 201 { jobId, uploadUrl }.
 * The presigned PUT is the ONLY path from admin to storage.
 */
export async function POST(): Promise<Response> {
  throw new Error('Not implemented');
}
