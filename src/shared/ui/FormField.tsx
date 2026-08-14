/**
 * FormField — label, control, hint and error, wired for assistive tech.
 *
 * Inputs get a VISIBLE label (no placeholder-as-label); hint and error are
 * linked with aria-describedby; an error is role="alert" and marks the control
 * aria-invalid, so failure is never carried by colour alone. `required` is
 * announced natively; browser validation is left on.
 */

// TODO: radio groups and checkboxes need a fieldset/legend variant, and the
// search field needs `type="search"` + Enter-forces-search behaviour.
// `id` is required rather than generated: forms own their id scheme (server
// errors arrive keyed by field name), and a generated id would be unstable
// across the SSR/hydration boundary for anything server-rendered.
import type { InputHTMLAttributes, ReactNode } from 'react';

export type FormFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'children'> & {
  /** The control's id, and the `for` target of the visible label. */
  id: string;
  /** Visible label text. Required: a placeholder is not a label. */
  label: ReactNode;
  /** Helper text, linked with aria-describedby. */
  hint?: ReactNode;
  /** Inline error, announced and linked; also sets aria-invalid. */
  error?: ReactNode;
};

export function FormField({ id, label, hint, error, className, ...rest }: FormFieldProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;

  // aria-describedby takes every id that applies, hint first: the helper
  // text explains the field, the error corrects it.
  const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(' ');

  const classes = ['field'];
  if (className) classes.push(className);

  return (
    <div className={classes.join(' ')}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        {...rest}
      />
      {hint === undefined ? null : (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default FormField;
