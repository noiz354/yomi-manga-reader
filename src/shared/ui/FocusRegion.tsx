'use client';

/**
 * FocusRegion — a boundary state that is focusable, and announced.
 *
 * Focus moves only when the document had already hydrated when the component
 * rendered — an in-app transition. On a hard load it deliberately does NOT move
 * focus: the region sits after the skip link, so focusing it would make the
 * bypass link unreachable by Tab. It is still announced via `role="status"`.
 */
import { useEffect, useRef, type ReactNode } from 'react';

import { hasHydrated } from './hydration';

export type FocusRegionProps = {
  children: ReactNode;
  /** Id of the heading that names this region. */
  labelledBy: string;
  /** Extra class for the wrapper (the boundary's own layout class). */
  className?: string;
  /** Set false for an inline notice; true for a whole-page state. */
  focusOnMount?: boolean;
};

export function FocusRegion({
  children,
  labelledBy,
  className,
  focusOnMount = true,
}: FocusRegionProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Read during RENDER, not in the effect: the wrapper's role has to match the
  // decision. On a hard load the layout's marker effect has not run yet at
  // either point, so this is `false` and stays `false`; on a soft navigation it
  // was set at the initial hydration, so it is `true` on the first render of
  // the new state. The flag only ever moves false → true once per document, so
  // a re-render cannot flip an already-painted region.
  const followsFocus = focusOnMount && hasHydrated();

  useEffect(() => {
    if (!followsFocus) return;
    ref.current?.focus();
  }, [followsFocus]);

  const classes = ['focus-region'];
  if (className) classes.push(className);

  // Both branches keep `tabIndex={-1}` and the label, so the region is
  // PROGRAMMATICALLY FOCUSABLE either way — "focusable" being a different claim
  // from "focused". Only the role and the focus move differ. A live region that
  // is also focusable is what lets a skip-to-content affordance, or a future
  // recovery action, send the reader here deliberately.
  if (!followsFocus) {
    // Announced, not focused. `role="status"` is implicitly
    // `aria-live="polite"`, so this never interrupts whatever the reader is on.
    return (
      <div
        role="status"
        tabIndex={-1}
        aria-labelledby={labelledBy}
        className={classes.join(' ')}
      >
        {children}
      </div>
    );
  }

  return (
    <div ref={ref} tabIndex={-1} aria-labelledby={labelledBy} className={classes.join(' ')}>
      {children}
    </div>
  );
}

export default FocusRegion;
