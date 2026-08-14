'use client';

/**
 * Dialog — a modal built on the native `<dialog>` element.
 *
 * `showModal()` gives the top layer, the focus trap, the inert background and
 * Escape-to-close from the platform, which are easy to get wrong by hand. State
 * contract: `open` is the single source of truth; opening calls showModal() and
 * closing calls close(), reporting the native `close` event through `onClose`.
 */

// TODO: destructive confirmations and the reader's chrome dialogs are the owning
// features. Two behaviours belong to the CALLER and are not done here: returning
// focus to the trigger on close, and a pending action that must not close the
// dialog until the server confirms.
import { useEffect, useRef, type ReactNode } from 'react';

export type DialogProps = {
  open: boolean;
  /** Called when the dialog closes, however it closed (Escape included). */
  onClose: () => void;
  /** Visible title; also the dialog's accessible name. */
  title: string;
  children: ReactNode;
  /** Actions (confirm/cancel). Focus order: first action is focused on open. */
  actions?: ReactNode;
  /** Caller-generated id prefix; defaults to `dialog`. */
  idPrefix?: string;
};

export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  idPrefix = 'dialog',
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = `${idPrefix}-title`;

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    if (open && !node.open) {
      // showModal() is what installs the focus trap; the `open` attribute
      // alone would render the dialog non-modally with no trap at all.
      if (typeof node.showModal === 'function') node.showModal();
      else node.setAttribute('open', '');
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const handleClose = () => onClose();
    node.addEventListener('close', handleClose);
    return () => node.removeEventListener('close', handleClose);
  }, [onClose]);

  return (
    <dialog className="dialog" ref={ref} aria-labelledby={titleId}>
      <div className="dialog__head">
        <h2 id={titleId}>{title}</h2>
      </div>
      <div className="dialog__body">{children}</div>
      {actions === undefined ? null : <div className="dialog__foot">{actions}</div>}
    </dialog>
  );
}

export default Dialog;
