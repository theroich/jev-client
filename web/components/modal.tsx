"use client";

import {
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Button, Icon, IconButton } from "./ui";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Modal({
  title,
  children,
  footer,
  onClose,
  className = "",
  initialFocus,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose(): void;
  className?: string;
  initialFocus?: string;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const root = dialog.current;
    const first = initialFocus
      ? root?.querySelector<HTMLElement>(initialFocus)
      : root?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root)?.focus();

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const elements = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (elements.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const firstElement = elements[0] as HTMLElement;
      const lastElement = elements[elements.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [initialFocus]);

  const overlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div className="overlay" onMouseDown={overlayClick}>
      <div
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton label="Close" onClick={onClose}><Icon name="close" /></IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmModal({
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
  busy = false,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onClose(): void;
  busy?: boolean;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
          {busy ? "Applying…" : confirmLabel}
        </Button>
      </>}
    >
      <p className="modal-description">{description}</p>
    </Modal>
  );
}
