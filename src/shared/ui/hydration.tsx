'use client';

/**
 * "Has this document finished its first hydration?" — one flag.
 * A HARD load (goto, pasted URL, refresh) must NOT move focus: the bypass link
 * should be the first Tab stop, and the state is announced via `role="status"`
 * instead. IN-APP navigation must move focus, because the reader triggered the
 * change. `<HydrationBoundary />` mounts once per document in the ROOT LAYOUT, so
 * child effects run before its effect and a hard-load FocusRegion sees `false`.
 */
import { useEffect } from 'react';

/** False during SSR and the first hydration; true for the rest of the document. */
let hydrated = false;

/** @returns whether this document has completed its first hydration. */
export function hasHydrated(): boolean {
  return hydrated;
}

/**
 * Marks the document as hydrated. Renders nothing.
 *
 * Must be mounted by the ROOT LAYOUT: the whole distinction rests on this
 * component not remounting when the route changes.
 */
export function HydrationBoundary(): null {
  useEffect(() => {
    hydrated = true;
  }, []);
  return null;
}

export default HydrationBoundary;
