/**
 * GET /api/uploads/{jobId}/status — API route shell.
 *
 * Auth: requireAdmin. 200 { job } (typed state; failed jobs carry
 * failureReason + causeCode — never raw error text).
 * Polling UX: 3 s cadence while queued/validating/processing.
 */
export async function GET(): Promise<Response> {
  throw new Error('Not implemented');
}
