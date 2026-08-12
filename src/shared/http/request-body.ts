/**
 * Reading an untrusted JSON request body.
 *
 * `Request.json()` is typed `Promise<any>`, so assigning its result straight
 * into a declared shape is an `any` flowing into the rest of the handler — how
 * `body.chapterId` becomes an unchecked member access. The value is read as
 * `unknown` first and only then given the declared shape, so the declared fields
 * are the ones the handler can see and every one is still untrusted.
 *
 * `undefined` means "the body was not valid JSON"; the caller decides the status.
 */
export async function readJsonBody<T extends object>(request: Request): Promise<T | undefined> {
  const raw: unknown = await request.json();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return raw as T;
}
