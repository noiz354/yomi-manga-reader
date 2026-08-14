'use client';

/**
 * Button — the shared action primitive.
 *
 * A native `<button>` on purpose: role and keyboard behaviour come free with
 * the element; a `div` with a click handler would have to re-implement Enter,
 * Space and the disabled semantics. Client component because it accepts an
 * action; the element, its variants and focus behaviour are the whole contract.
 */

// TODO: pending/loading state and the double-submit guard belong to the feature
// that owns the form, not to the primitive.
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'default' | 'primary';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** `primary` is the single vermilion action on a surface; one per view. */
  variant?: ButtonVariant;
  children: ReactNode;
};

export function Button({
  variant = 'default',
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = ['btn'];
  if (variant === 'primary') classes.push('btn--primary');
  if (className) classes.push(className);

  return (
    <button type={type} className={classes.join(' ')} {...rest}>
      {children}
    </button>
  );
}

export default Button;
