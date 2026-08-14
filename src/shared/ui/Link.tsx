/**
 * Link — the shared link primitive.
 *
 * A link has one job (navigate) and one obligation (be visibly focusable and
 * big enough to hit). Making that a primitive stops every feature from
 * re-deriving the class list. Server component: no hooks, so any page may use it.
 */
import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';

/** next/link's own props, so the wrapper can never narrow or widen them. */
type NextLinkProps = ComponentProps<typeof Link>;

export type UiLinkProps = Omit<NextLinkProps, 'href' | 'className'> & {
  /** A route in the planned route map, or a same-origin path. */
  href: string;
  children: ReactNode;
  /**
   * Extra class for the surface the link sits on (`.shell-nav` and
   * `.admin-nav` supply their own). Never used to carry a colour.
   */
  className?: string;
};

export function UiLink({ href, children, className, ...rest }: UiLinkProps) {
  return (
    <Link href={href} className={className} {...rest}>
      {children}
    </Link>
  );
}

export default UiLink;
